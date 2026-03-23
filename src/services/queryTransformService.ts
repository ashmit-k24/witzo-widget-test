import OpenAI from "openai";
import { config } from "../config/env";
import {
	ChatMessage,
	StructuredQueryPlan,
} from "../types";
import logger from "../utils/logger";

export type QueryIntent =
	| "small_talk" // greetings, thanks, bye — skip retrieval
	| "factual_short" // quick fact: phone, email, address, single value
	| "list_request" // "list all services", "what products do you offer"
	| "explanation" // "how does X work", "what is X"
	| "comparison" // "compare plan A and B", "difference between X and Y"
	| "complex" // multi-part or requires multiple retrievals
	| "lead_capture" // user sharing contact info
	| "general"; // fallback

export type TransformResult = {
	intent: QueryIntent;
	retrievalQuery: string; // query to use for vector search (may differ from raw message)
	subQueries: string[]; // for complex intent: decomposed sub-queries
	formatHint: string; // added to system prompt for response formatting
	isContactQuery: boolean; // true when user is asking for contact/location info → lower retrieval threshold
	standaloneQuery: string;
	relatedToPrevious: boolean;
	topicHint?: string;
	structuredPlan: StructuredQueryPlan;
};

type ConversationResolution = {
	standaloneQuery: string;
	relatedToPrevious: boolean;
	topicHint?: string;
};

const INTENT_FORMAT_HINTS: Record<
	QueryIntent,
	string
> = {
	small_talk:
		"Reply warmly and briefly in 1-2 sentences.",
	factual_short:
		"Answer directly with the exact fact first. If there are multiple exact values, use short bullet points instead of a paragraph. Avoid filler.",
	list_request:
		"Use a short introductory line ending with a colon, then list each item on its own bullet using '- Item'. Keep names exact when possible and add only short supporting details grounded in the context.",
	explanation:
		"Explain clearly in short paragraphs. Use plain language and add light structure when it improves readability.",
	comparison:
		"Use a structured comparison with short bullets or mini-sections. Make the differences easy to scan.",
	complex:
		"Answer thoroughly using short sections, bullets, or short paragraphs for each part of the question.",
	lead_capture:
		"Acknowledge the contact info warmly and ask for the missing detail.",
	general:
		"Answer clearly with short paragraphs. Use bullets when they make the answer easier to scan.",
};

const STRUCTURED_FILTER_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"any",
	"are",
	"for",
	"from",
	"give",
	"industry",
	"in",
	"me",
	"of",
	"related",
	"show",
	"some",
	"studies",
	"the",
	"to",
	"what",
	"with",
]);

class QueryTransformService {
	private openai: OpenAI;

	constructor() {
		this.openai = new OpenAI({
			apiKey: config.OPENAI_API_KEY,
		});
	}

	private shouldUseHypotheticalAnswer(
		query: string,
		intent: QueryIntent,
		options?: {
			isContactQuery?: boolean;
			isCaseStudyQuery?: boolean;
		},
	): boolean {
		const normalized = query.trim();
		if (!normalized) return false;
		if (normalized.length <= 40) return false;
		if (options?.isContactQuery) return false;
		if (options?.isCaseStudyQuery) return false;
		if (
			intent === "factual_short" ||
			intent === "list_request"
		) {
			return false;
		}
		return (
			intent === "explanation" ||
			intent === "comparison" ||
			intent === "complex" ||
			intent === "general"
		);
	}

	private getRecentConversationSnippet(
		recentMessages: ChatMessage[],
	): string {
		return recentMessages
			.slice(-8)
			.map(
				(message) =>
					`${message.role === "user" ? "User" : "Bot"}: ${message.content
						.replace(/\s+/g, " ")
						.slice(0, 240)}`,
			)
			.join("\n");
	}

	/**
	 * Main entry: classify intent, rewrite query for retrieval, decompose if complex.
	 */
	async transform(
		message: string,
		recentMessages: ChatMessage[],
	): Promise<TransformResult> {
		console.log(
			"\n========== [QueryTransform] START ==========",
		);
		console.log(
			"[QueryTransform] Raw message:",
			JSON.stringify(message),
		);
		console.log(
			"[QueryTransform] Recent messages count:",
			recentMessages.length,
		);

		// Fast local checks first (avoid LLM call for obvious cases)
		const localIntent =
			this.detectLocalIntent(message);
		console.log(
			"[QueryTransform] detectLocalIntent result:",
			localIntent,
		);

		if (
			localIntent === "small_talk" ||
			localIntent === "lead_capture"
		) {
			console.log(
				"[QueryTransform] Fast path: small_talk or lead_capture → skipping retrieval",
			);
			console.log(
				"========== [QueryTransform] END ==========\n",
			);
			return this.buildResult(
				localIntent,
				message,
				[],
				message,
				false,
				recentMessages,
			);
		}
		// Local contact detection → skip LLM, go straight to retrieval
		if (localIntent === "factual_short") {
			const isContact =
				this.isContactQuery(message);
			const boosted = isContact
				? `${message} contact address phone email location office`
				: message;
			console.log(
				"[QueryTransform] Fast path: factual_short | isContact:",
				isContact,
			);
			console.log(
				"[QueryTransform] retrievalQuery:",
				JSON.stringify(boosted),
			);
			console.log(
				"========== [QueryTransform] END ==========\n",
			);
			return this.buildResult(
				"factual_short",
				boosted,
				[],
				message,
				isContact,
				recentMessages,
			);
		}

		const conversationResolution =
			await this.resolveConversationQuery(
				message,
				recentMessages,
			);
		const standaloneQuery =
			conversationResolution.standaloneQuery;
		console.log(
			"[QueryTransform] standaloneQuery after rewrite:",
			JSON.stringify(standaloneQuery),
		);

		// Classify intent + generate HyDE + decompose sub-queries in one LLM call
		const {
			intent,
			hypotheticalAnswer,
			subQueries,
		} = await this.classifyAndExpand(
			standaloneQuery,
			message,
		);
		console.log(
			"[QueryTransform] classifyAndExpand result → intent:",
			intent,
		);
		console.log(
			"[QueryTransform] HyDE (first 150 chars):",
			hypotheticalAnswer.slice(0, 150) ||
				"(none)",
		);
		console.log(
			"[QueryTransform] subQueries:",
			subQueries,
		);

		// Use HyDE for retrieval: embed the hypothetical answer instead of the raw question
		const contactQuery = this.isContactQuery(
			standaloneQuery,
		);
		const caseStudyQuery = this.isCaseStudyQuery(
			standaloneQuery,
		);
		let retrievalQuery =
			this.shouldUseHypotheticalAnswer(
				standaloneQuery,
				intent,
				{
					isContactQuery: contactQuery,
					isCaseStudyQuery: caseStudyQuery,
				},
			) && hypotheticalAnswer.trim()
				? `${standaloneQuery} ${hypotheticalAnswer}`
				: standaloneQuery;

		// Boost contact/location queries with explicit keywords so retrieval
		// finds the contact page even when the question is vague ("give me contact details")
		console.log(
			"[QueryTransform] isContactQuery:",
			contactQuery,
		);
		if (contactQuery) {
			retrievalQuery = `${retrievalQuery} contact address phone email location office`;
		}
		if (caseStudyQuery) {
			retrievalQuery = `${retrievalQuery} case study portfolio project client result outcome industry vertical`;
		}
		if (
			conversationResolution.relatedToPrevious &&
			conversationResolution.topicHint
		) {
			retrievalQuery = `${retrievalQuery} ${conversationResolution.topicHint}`;
		}

		console.log(
			"[QueryTransform] Final retrievalQuery (first 200 chars):",
			retrievalQuery.slice(0, 200),
		);
		console.log(
			"[QueryTransform] Final intent:",
			intent,
		);
		console.log(
			"========== [QueryTransform] END ==========\n",
		);

		return this.buildResult(
			intent,
			retrievalQuery,
			subQueries,
			standaloneQuery,
			contactQuery,
			recentMessages,
			conversationResolution.relatedToPrevious,
			conversationResolution.topicHint,
		);
	}

	/**
	 * Detects contact-info related queries that are often vague but need specific retrieval.
	 */
	private isContactQuery(query: string): boolean {
		return /\b(contact|address(es)?|phone|email|location(s)?|office(s)?|branch(es)?|reach|get in touch|headquarter(s)?|hq|number|call us|mail us|where are you|how to reach|all location|list location|consult(ation)?|get in contact|schedule|appointment|book a call|talk to|speak to|meet with)\b/i.test(
			query,
		);
	}

	private isCaseStudyQuery(
		query: string,
	): boolean {
		return /\b(case stud(?:y|ies)|portfolio|project(?:s)?|example(?:s)?|sample(?:s)?|client work|success stor(?:y|ies)|work sample(?:s)?)\b/i.test(
			query,
		);
	}

	private buildResult(
		intent: QueryIntent,
		retrievalQuery: string,
		subQueries: string[],
		standaloneQuery: string,
		isContactQuery: boolean = false,
		recentMessages: ChatMessage[] = [],
		relatedToPrevious: boolean = false,
		topicHint?: string,
	): TransformResult {
		const isCaseStudyQuery =
			this.isCaseStudyQuery(standaloneQuery);
		const structuredPlan =
			this.buildStructuredPlan(
				standaloneQuery,
				recentMessages,
				isContactQuery,
				topicHint,
			);
		// Contact queries need much more space than factual_short defaults
		const formatHint = isContactQuery
			? "List ALL contact details found in the context. For EACH office or location, include the complete address, ALL phone numbers, and the email. Present each office as its own labelled section. Do NOT truncate, omit, or summarise any office. Do NOT invent any phone number, email, or address — only use what is explicitly in the context. This response may be longer than usual."
			: isCaseStudyQuery
				? "For case studies, projects, portfolio items, or examples: use a consistent structure for each item. For each case study include: (1) the exact name in bold, (2) a brief Overview, (3) key Results with specific numbers or metrics if available, and (4) the full case study link. If the visitor asked about a specific industry, only show matching case studies — do NOT say no case studies exist if there are any related ones; instead show the closest match. Do NOT invent case study names or results. Always end with a brief personalized follow-up question asking about the visitor's specific business, industry, or goals."
				: structuredPlan.topic === "services"
					? "For services: use a short introductory line ending with a colon, then list each service on its own bullet. Use the exact service name when possible and add one grounded value sentence only. Do not merge multiple services into one bullet."
					: INTENT_FORMAT_HINTS[intent];

		return {
			intent,
			retrievalQuery,
			subQueries,
			formatHint,
			isContactQuery,
			standaloneQuery,
			relatedToPrevious,
			topicHint,
			structuredPlan,
		};
	}

	private extractFocusTerms(
		query: string,
		extraTerms: string[],
	): string[] {
		const normalizedTerms = query
			.toLowerCase()
			.replace(/[^a-z0-9\s-]+/g, " ")
			.split(/\s+/)
			.map((term) => term.trim())
			.filter(
				(term) =>
					term.length >= 3 &&
					!STRUCTURED_FILTER_STOP_WORDS.has(term),
			);
		return Array.from(
			new Set([
				...extraTerms.map((term) =>
					term.toLowerCase(),
				),
				...normalizedTerms,
			]),
		).slice(0, 12);
	}

	private buildStructuredPlan(
		standaloneQuery: string,
		_recentMessages: ChatMessage[],
		isContactQuery: boolean,
		topicHint?: string,
	): StructuredQueryPlan {
		const normalized =
			standaloneQuery.toLowerCase();

		let topic: StructuredQueryPlan["topic"] =
			"general";
		const pageTypes = new Set<string>();
		const blockTypes = new Set<string>();

		if (isContactQuery) {
			topic = "contact";
			// No pageType/blockType filter — contact info can live anywhere on a website
			// (footer, home page, about page, general paragraph). Let score threshold
			// and reranking surface the right content instead of hardcoded restrictions.
		} else if (
			/\b(price|pricing|plan|plans|package|packages|cost|costs|quote)\b/.test(
				normalized,
			)
		) {
			topic = "pricing";
			pageTypes.add("pricing");
			blockTypes.add("table");
			blockTypes.add("list");
		} else if (
			this.isCaseStudyQuery(standaloneQuery)
		) {
			topic = "case_studies";
			pageTypes.add("portfolio");
			blockTypes.add("summary");
			blockTypes.add("list");
			blockTypes.add("paragraph");
		} else if (
			/\b(faq|faqs|question|questions|answer|answers|support|help)\b/.test(
				normalized,
			)
		) {
			topic = "faq";
			pageTypes.add("faq");
			blockTypes.add("faq");
		} else if (
			/\b(service|services|solution|solutions|product|products|offering|offerings|capabilities)\b/.test(
				normalized,
			)
		) {
			topic = "services";
			pageTypes.add("services");
			blockTypes.add("list");
			blockTypes.add("summary");
		} else if (
			/\b(about|team|company|founder|history|mission|vision|who are you|who we are)\b/.test(
				normalized,
			)
		) {
			topic = "about";
			pageTypes.add("about");
			blockTypes.add("summary");
		}

		const focusTerms = this.extractFocusTerms(
			standaloneQuery,
			isContactQuery
				? [
						...(topicHint ? [topicHint] : []),
						"address",
						"office",
						"location",
						"contact",
					]
				: topicHint
					? [topicHint]
					: [],
		);

		return {
			topic,
			pageTypes:
				pageTypes.size > 0
					? Array.from(pageTypes)
					: undefined,
			blockTypes:
				blockTypes.size > 0
					? Array.from(blockTypes)
					: undefined,
			focusTerms,
		};
	}

	/**
	 * Local heuristics — no LLM needed.
	 */
	private detectLocalIntent(
		message: string,
	): QueryIntent | null {
		const lower = message.toLowerCase().trim();

		// Small talk
		if (
			/^(hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|bye|goodbye|ok|okay|sure|great|awesome|cool)\b/.test(
				lower,
			) &&
			lower.length < 40
		) {
			return "small_talk";
		}

		// User ASKING for contact/location info → factual_short (not lead_capture)
		// Must be checked before lead_capture so "give me contact details" doesn't get misclassified
		if (
			/\b(give me|show me|what (is|are|('s))|tell me|provide|share|find|get)\b.*\b(contact|address(es)?|phone|email|location(s)?|office(s)?|branch(es)?|number)\b/i.test(
				lower,
			) ||
			/\b(contact (details|info|information|number|us|me)|how (to|do i) (reach|contact|call|email)|where (is|are) (you|your|the) (office|location|headquarter))/i.test(
				lower,
			) ||
			/\b(how many|all|list|what are (the|your)) (location(s)?|office(s)?|branch(es)?)/i.test(
				lower,
			)
		) {
			return "factual_short";
		}

		// Lead capture — ONLY when user is SHARING their own contact info (email or phone visible)
		const hasEmail =
			/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(
				lower,
			);
		const phoneDigits = lower.replace(/\D/g, "");
		if (hasEmail || phoneDigits.length >= 7) {
			return "lead_capture";
		}

		return null;
	}

	/**
	 * Resolves whether the latest message is a follow-up and rewrites it into a
	 * standalone query when needed.
	 */
	private async resolveConversationQuery(
		message: string,
		recentMessages: ChatMessage[],
	): Promise<ConversationResolution> {
		const fallback: ConversationResolution = {
			standaloneQuery: message,
			relatedToPrevious: false,
		};
		const isLikelyFollowUp =
			recentMessages.length >= 2 &&
			(message.trim().length <= 30 ||
				/\b(that|this|it|those|them|the first|the second|above|previous|more about|tell me more|elaborate|expand|what about|more|anything else|what else|and\b)\b/i.test(
					message,
				));

		if (!isLikelyFollowUp) return fallback;

		const historySnippet =
			this.getRecentConversationSnippet(
				recentMessages,
			);

		try {
			const completion =
				await this.openai.chat.completions.create(
					{
						model: "gpt-4o-mini",
						response_format: {
							type: "json_object",
						},
						messages: [
							{
								role: "system",
								content:
									"You resolve whether the latest user message is related to the recent conversation and rewrite it into a standalone retrieval query when needed. Return JSON only with keys: relatedToPrevious (boolean), standaloneQuery (string), topicHint (string). Preserve company-specific topic, industry, location, entity, and filter context from the previous messages. Do not broaden into generic examples.",
							},
							{
								role: "user",
								content: `Conversation history:\n${historySnippet}\n\nLatest user message: "${message}"\n\nDecide whether this latest message is a follow-up to the conversation. If it is, rewrite it as a complete standalone search query and provide a short topicHint. If it is not related, keep standaloneQuery close to the original message.`,
							},
						],
						max_tokens: 160,
						temperature: 0,
					},
				);

			const raw =
				completion.choices[0]?.message?.content ??
				"{}";
			const parsed = JSON.parse(raw);
			const standaloneQuery =
				typeof parsed.standaloneQuery ===
					"string" &&
				parsed.standaloneQuery.trim()
					? parsed.standaloneQuery.trim()
					: message;
			const relatedToPrevious =
				typeof parsed.relatedToPrevious ===
				"boolean"
					? parsed.relatedToPrevious
					: true;
			const topicHint =
				typeof parsed.topicHint === "string" &&
				parsed.topicHint.trim()
					? parsed.topicHint.trim()
					: undefined;
			logger.info(
				"[QueryTransform] Resolved conversation query",
				{
					original: message.slice(0, 80),
					standaloneQuery: standaloneQuery.slice(
						0,
						80,
					),
					relatedToPrevious,
					topicHint: topicHint?.slice(0, 80),
				},
			);
			return {
				standaloneQuery,
				relatedToPrevious,
				topicHint,
			};
		} catch (error) {
			logger.error(
				"[QueryTransform] Query rewrite failed, using original",
				{
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
			return {
				standaloneQuery: message,
				relatedToPrevious: true,
			};
		}
	}

	/**
	 * Single LLM call that:
	 * 1. Classifies intent
	 * 2. Generates a HyDE (hypothetical answer) for better embedding
	 * 3. Decomposes complex queries into sub-queries
	 */
	private async classifyAndExpand(
		query: string,
		_originalMessage: string,
	): Promise<{
		intent: QueryIntent;
		hypotheticalAnswer: string;
		subQueries: string[];
	}> {
		const fallback = {
			intent: "general" as QueryIntent,
			hypotheticalAnswer: "",
			subQueries: [],
		};

		try {
			const completion =
				await this.openai.chat.completions.create(
					{
						model: "gpt-4o-mini",
						response_format: {
							type: "json_object",
						},
						messages: [
							{
								role: "system",
								content: `You are a query analysis assistant. Analyze the user query and return a JSON object with:
- "intent": one of [small_talk, factual_short, list_request, explanation, comparison, complex, lead_capture, general]
- "hypotheticalAnswer": A 1-2 sentence hypothetical answer that would typically answer this question (empty string for small_talk/lead_capture). This helps with semantic retrieval.
- "subQueries": Array of 2-3 simpler sub-questions if intent is "complex", otherwise empty array.

Intent definitions:
- small_talk: greetings, chitchat
- factual_short: wants a single fact (phone, email, price, date, name)
- list_request: wants a list of items (services, products, features, team members)
- explanation: wants to understand how something works or what something is
- comparison: wants to compare two or more things
- complex: multi-part question requiring multiple pieces of information
- lead_capture: user is SHARING their OWN contact information (their email/phone is visible in the message). NEVER use this when the user is ASKING for the company's contact details.
- general: anything else`,
							},
							{
								role: "user",
								content: `Query: "${query}"`,
							},
						],
						max_tokens: 200,
						temperature: 0.1,
					},
				);

			const raw =
				completion.choices[0]?.message?.content ||
				"{}";
			const parsed = JSON.parse(raw);

			const intent: QueryIntent = [
				"small_talk",
				"factual_short",
				"list_request",
				"explanation",
				"comparison",
				"complex",
				"lead_capture",
				"general",
			].includes(parsed.intent)
				? parsed.intent
				: "general";

			const hypotheticalAnswer =
				typeof parsed.hypotheticalAnswer ===
				"string"
					? parsed.hypotheticalAnswer.slice(
							0,
							300,
						)
					: "";

			const subQueries: string[] = Array.isArray(
				parsed.subQueries,
			)
				? parsed.subQueries
						.filter(
							(q: any) =>
								typeof q === "string" && q.trim(),
						)
						.slice(0, 3)
				: [];

			logger.info(
				"[QueryTransform] Classified query",
				{
					query: query.slice(0, 80),
					intent,
					hasHyDE: Boolean(hypotheticalAnswer),
					subQueryCount: subQueries.length,
				},
			);

			return {
				intent,
				hypotheticalAnswer,
				subQueries,
			};
		} catch (error) {
			logger.error(
				"[QueryTransform] Classification failed, using fallback",
				{
					error:
						error instanceof Error
							? error.message
							: String(error),
					query: query.slice(0, 80),
				},
			);
			return fallback;
		}
	}
}

export const queryTransformService =
	new QueryTransformService();
