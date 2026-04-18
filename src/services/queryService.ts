import OpenAI from "openai";
import { config } from "../config/env";
import logger from "../utils/logger";

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export type QueryClass =
	| "pricing"
	| "contact"
	| "case_study"
	| "service"
	| "blog"
	| "people"
	| "general";

export type CtaIntent =
	| "contact"
	| "case_study"
	| "blog";

export type CtaQueryMode =
	| "general"
	| "specific";

const CTA_STOP_WORDS = new Set([
	"a",
	"all",
	"an",
	"and",
	"any",
	"are",
	"about",
	"browse",
	"can",
	"do",
	"for",
	"have",
	"i",
	"know",
	"let",
	"list",
	"me",
	"of",
	"old",
	"older",
	"on",
	"our",
	"please",
	"previous",
	"past",
	"recent",
	"related",
	"see",
	"show",
	"specific",
	"tell",
	"the",
	"their",
	"to",
	"us",
	"view",
	"want",
	"wanted",
	"with",
	"work",
	"your",
	"latest",
	"new",
	"newer",
]);

const CASE_STUDY_GENERIC_TERMS = new Set([
	"case",
	"cases",
	"client",
	"clients",
	"example",
	"examples",
	"portfolio",
	"project",
	"projects",
	"sample",
	"samples",
	"stories",
	"story",
	"study",
	"studies",
	"success",
	"work",
]);

const BLOG_GENERIC_TERMS = new Set([
	"article",
	"articles",
	"blog",
	"blogs",
	"guide",
	"guides",
	"insight",
	"insights",
	"news",
	"post",
	"posts",
	"resource",
	"resources",
]);

const CASE_STUDY_SIGNAL =
	/\b(case stud(?:y|ies)|portfolio|our work|client work|projects?|previous work|past work|success stor(?:y|ies)|work samples?|examples?)\b/;
const BLOG_SIGNAL =
	/\b(blog(?:s| posts?)?|articles?|guides?|insights?|resources?|news)\b/;
const CONTACT_SIGNAL =
	/\b(contact|reach(?: out)?|get in touch|talk to|speak to|connect with|sales|quote|proposal|consultation|custom solution|custom project|discuss(?: my)? project|email|phone|call)\b/;
const GENERIC_BROWSE_SIGNAL =
	/\b(list|show|browse|explore|view|see|share|any|all|overview)\b/;
const GENERAL_QUANTITY_SIGNAL =
	/\b(all|many|multiple|several|some|few|more)\b/;

export function normalizeWidgetQuery(q: string): string {
	return q.toLowerCase().trim().replace(/\s+/g, " ");
}

function tokenizeQuery(q: string): string[] {
	return normalizeWidgetQuery(q)
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/[\s-]+/)
		.map((token) => token.trim())
		.filter(Boolean);
}

function uniqueTerms(terms: string[]): string[] {
	return Array.from(new Set(terms));
}

function hasSpecificSubjectTerms(
	query: string,
	intent: Exclude<CtaIntent, "contact">,
): boolean {
	return getCtaTopicTerms(query, intent).length > 0;
}

function hasPluralBrowseSignal(
	query: string,
	intent: Exclude<CtaIntent, "contact">,
): boolean {
	const q = normalizeWidgetQuery(query);
	if (GENERAL_QUANTITY_SIGNAL.test(q)) {
		return true;
	}

	if (intent === "case_study") {
		return /\b(case studies|projects|examples|success stories|work samples|clients)\b/.test(
			q,
		);
	}

	return /\b(blogs|blog posts|articles|guides|insights|resources|posts)\b/.test(
		q,
	);
}

export function getCtaTopicTerms(
	query: string,
	intent: Exclude<CtaIntent, "contact">,
): string[] {
	const genericTerms =
		intent === "case_study"
			? CASE_STUDY_GENERIC_TERMS
			: BLOG_GENERIC_TERMS;

	return uniqueTerms(
		tokenizeQuery(query).filter(
			(token) =>
				token.length > 1 &&
				!CTA_STOP_WORDS.has(token) &&
				!genericTerms.has(token),
		),
	);
}

export function getCtaQueryMode(
	query: string,
	intent: Exclude<CtaIntent, "contact">,
): CtaQueryMode {
	const q = normalizeWidgetQuery(query);
	if (hasPluralBrowseSignal(query, intent)) {
		return "general";
	}

	if (hasSpecificSubjectTerms(query, intent)) {
		return "specific";
	}

	if (GENERIC_BROWSE_SIGNAL.test(q)) {
		return "general";
	}

	return "general";
}

export function classifyCtaIntent(
	query: string,
): CtaIntent | null {
	const q = normalizeWidgetQuery(query);
	if (!q) {
		return null;
	}

	if (BLOG_SIGNAL.test(q)) {
		return "blog";
	}

	if (CASE_STUDY_SIGNAL.test(q)) {
		return "case_study";
	}

	if (CONTACT_SIGNAL.test(q)) {
		return "contact";
	}

	return null;
}

export function buildCtaTargetedQuery(
	query: string,
	intent: CtaIntent,
): string {
	const trimmed = query.trim();
	switch (intent) {
		case "contact":
			return trimmed.length > 0
				? `${trimmed} contact get in touch talk to our team`
				: "contact get in touch talk to our team";
		case "case_study":
			return getCtaQueryMode(query, "case_study") ===
				"general"
				? "case studies portfolio our work projects client work"
				: `${trimmed} case study portfolio project client work`;
		case "blog":
			return getCtaQueryMode(query, "blog") ===
				"general"
				? "blog articles guides resources insights"
				: `${trimmed} blog article guide insight resource`;
	}
}

export function isAppointmentBookingIntent(
	q: string,
): boolean {
	return (
		/\b(book|schedule|arrange|set up|setup|plan|organize)\b[\s\w-]{0,30}\b(appointment|meeting|demo|consultation|call|callback)\b/.test(q) ||
		/\b(appointment|meeting|demo|consultation|call|callback)\b[\s\w-]{0,20}\b(book|schedule|arrange|set up|setup)\b/.test(q) ||
		/\b(talk to sales|speak to sales|connect with sales|connect with your team|speak with your team|sales call|book time with|schedule time with|book a slot|schedule a slot)\b/.test(q)
	);
}

export function classifyQuery(query: string): QueryClass {
	const q = normalizeWidgetQuery(query);
	if (/\b(price|pricing|cost|plan|package|subscription|charge|fee|fees)\b/.test(q)) {
		return "pricing";
	}
	if (/\b(contact|email|phone|call|address|location|reach|support)\b/.test(q)) {
		return "contact";
	}
	if (/\b(case study|portfolio|client|project|work|success story|testimonial)\b/.test(q)) {
		return "case_study";
	}
	if (/\b(service|services|offer|provide|solution|solutions|development|design|marketing|seo)\b/.test(q)) {
		return "service";
	}
	if (/\b(blog|article|news|insight|guide)\b/.test(q)) {
		return "blog";
	}
	if (/\b(founder|ceo|director|owner|leadership|team|who is|about person)\b/.test(q)) {
	return "people";
	}
	return "general";
}

export function getTopKForQuery(query: string): number {
	switch (classifyQuery(query)) {
		case "pricing":
		case "contact":
			return 8;
		case "case_study":
		case "service":
			return 18;
		case "blog":
			return 12;
		case "general":
			return 15;
		case "people":
			return 15;
	}
}

export function buildPageTypeFilters(query: string): string[] {
	switch (classifyQuery(query)) {
		case "people":
			return ["service","services","case_study","contact","pricing","blog"];
		case "pricing":
			return ["pricing"];
		case "contact":
			return ["contact"];
		case "case_study":
			return ["case_study", "portfolio"];
		case "service":
			return ["service", "services", "home"];
		case "blog":
			return ["blog"];
		case "general":
			return [];
	}
}

export function generateQueryVariations(query: string): string[] {
	const q = query.trim();
	if (!q) return [];
	const normalized = normalizeWidgetQuery(q);
	const variations = new Set<string>();

	if (/\b(price|pricing|cost)\b/.test(normalized)) {
		variations.add(`${q} pricing plans cost`);
	}
	if (/\b(service|services|offer|provide)\b/.test(normalized)) {
		variations.add(`${q} services solutions`);
	}
	if (/\b(project|portfolio|case study|client)\b/.test(normalized)) {
		variations.add(`${q} portfolio case studies clients`);
	}
	if (/\b(contact|email|phone|address)\b/.test(normalized)) {
		variations.add(`${q} contact details`);
	}
	if (/\b(founder|ceo|director|owner|leadership|team)\b/.test(normalized)) {
	variations.add(`${q} company leadership founder ceo director about team`);
	}

	return Array.from(variations)
		.filter((item) => normalizeWidgetQuery(item) !== normalized)
		.slice(0, 3);
}

export type TurnType = "new_question" | "continuation";

/**
 * Asks the LLM to classify the current turn using conversation history.
 * "continuation" = user is asking for more detail / confirming / drilling into
 *   what was just discussed (e.g. "yes", "tell me more", "what about the first one?",
 *   "and the pricing for that?", "go ahead").
 * "new_question" = a standalone new topic.
 * Falls back to "new_question" on any error so the main flow is never blocked.
 */
export async function classifyTurnType(
	query: string,
	history: Array<{ role: string; content: string }>,
): Promise<TurnType> {
	if (!config.OPENAI_API_KEY?.trim() || history.length < 2) {
		return "new_question";
	}

	logger.info("[TURN-CLASSIFY] classifying turn", { query, historyLength: history.length });

	try {
		const recentHistory = history
			.slice(-4)
			.map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
			.join("\n");

		const completion = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [
				{
					role: "system",
					content:
						'Classify the user\'s latest message as either "continuation" or "new_question".\n\n' +
						'"continuation" ONLY means the user is affirming, drilling deeper, or asking for more detail on the EXACT SAME topic that was just explained or listed — e.g. "yes", "tell me more", "ok go ahead", "what about the first one?", "expand on that", "and the pricing for that?".\n\n' +
						'"new_question" means the user is introducing a specific topic or task — even if it follows a clarification prompt. A message that contains a clear subject or action ("tell me about your services", "what do you offer", "show me pricing", "how do I contact you") is ALWAYS a new_question, regardless of what was said before.\n\n' +
						"Reply with exactly one word: continuation or new_question.",
				},
				{
					role: "user",
					content: `Conversation so far:\n${recentHistory}\n\nLatest message: "${query}"`,
				},
			],
			temperature: 0,
			max_tokens: 5,
		});

		const result =
			completion.choices[0]?.message?.content?.trim().toLowerCase() ?? "";
		const turnType: TurnType = result === "continuation" ? "continuation" : "new_question";
		logger.info("[TURN-CLASSIFY] result", { query, turnType, rawLlmResult: result });
		return turnType;
	} catch (err) {
		logger.warn("[TURN-CLASSIFY] LLM call failed, defaulting to new_question", {
			query,
			error: err instanceof Error ? err.message : String(err),
		});
		return "new_question";
	}
}

export async function stepBackRewrite(
	query: string,
	history?: Array<{ role: string; content: string }>,
): Promise<string> {
	const trimmed = query.trim();
	if (!trimmed) return trimmed;

	const words = trimmed.split(/\s+/);
	const contextDependent =
		/\b(it|this|that|they|them|those|there|same|above|previous)\b/i.test(trimmed);
	if (words.length > 12 && !contextDependent) {
		return trimmed;
	}
	if (!config.OPENAI_API_KEY?.trim()) {
		return trimmed;
	}

	logger.info("[STEP-BACK] rewriting query", { original: trimmed, historyLength: (history ?? []).length });

	try {
		const recentHistory = (history ?? [])
			.slice(-6)
			.map((message) => `${message.role}: ${message.content.slice(0, 400)}`)
			.join("\n");

		const completion = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [
				{
					role: "system",
					content:
						"Given the conversation history, rewrite the user's latest message into a single detailed standalone search query that captures exactly what they want to know. " +
						"If the message is vague or short (e.g. 'yes', 'tell me more', 'what about that?'), resolve what specific topic they are referring to from the conversation. " +
						"Return only the rewritten query — never return the original word 'yes' or a similar non-specific reply.",
				},
				{
					role: "user",
					content: recentHistory
						? `Conversation:\n${recentHistory}\n\nLatest message: ${trimmed}`
						: `Query: ${trimmed}`,
				},
			],
			temperature: 0,
			max_tokens: 80,
		});
		const rewritten =
			completion.choices[0]?.message?.content?.trim() || trimmed;
		const finalQuery = rewritten.length > 0 && rewritten.length < 300
			? rewritten.replace(/^["']|["']$/g, "")
			: trimmed;
		logger.info("[STEP-BACK] rewrite result", { original: trimmed, rewritten: finalQuery });
		return finalQuery;
	} catch (error) {
		logger.warn("[STEP-BACK] rewrite failed, using original query", {
			original: trimmed,
			error: error instanceof Error ? error.message : String(error),
		});
		return trimmed;
	}
}
