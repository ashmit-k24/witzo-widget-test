import OpenAI from "openai";
import { Pinecone } from "@pinecone-database/pinecone";
import { config } from "../config/env";
import {
	CHAT_CONTACT_SCORE_THRESHOLD,
	CHAT_RETRIEVAL_SCORE_THRESHOLD,
} from "../constants";
import {
	StructuredBlockSearchResult,
	StructuredQueryPlan,
} from "../types";
import { buildSparseVector } from "../utils/bm25";
import logger from "../utils/logger";
import { pineconeService } from "./pineconeService";
import { rerankService } from "./rerankService";
import { semanticRouterService } from "./semanticRouterService";

const PINECONE_TOP_K = 30;
const PINECONE_CONTACT_TOP_K = 60;
const RERANK_TOP_N = 15;
const MMR_K = 12;
const MMR_K_CONTACT = 12;

const STRUCTURED_RESULT_LIMIT = 12;
const QUERY_REWRITE_MODEL = "gpt-4o-mini";
const PLANNER_MODEL = "gpt-4o-mini";
const SUFFICIENCY_MODEL = "gpt-4o-mini";
const HISTORY_SNIPPET_CHAR_LIMIT = 700;

export type WorkspaceBoundary =
	| "workspace_only"
	| "general_allowed";

export type GenericRetrievalIntent =
	| "overview"
	| "services_or_products"
	| "contact_or_location"
	| "pricing_or_sales"
	| "case_studies_or_portfolio"
	| "support_or_policy"
	| "comparison"
	| "general";

export type AnswerMode =
	| "direct_fact"
	| "concise_summary"
	| "highlight_list"
	| "guided_explanation"
	| "comparison"
	| "fallback_only";

export interface RagConversationContext {
	recentUserQuestions: string[];
	recentAssistantReplies: string[];
	conversationSummary?: string;
}

interface RetrievalPlan {
	standaloneQuery: string;
	intent: GenericRetrievalIntent;
	entities: string[];
	mustHaveConcepts: string[];
	niceToHaveConcepts: string[];
	answerMode: AnswerMode;
	preferredPageTypes: string[];
	preferredBlockTypes: string[];
	isExhaustiveQuery: boolean;
}

interface SufficiencyDecision {
	sufficient: boolean;
	reason: string;
	followupQuery?: string;
	missingConcepts: string[];
	answerMode?: AnswerMode;
}

export interface RagChunk {
	id: string;
	score: number;
	cohereScore?: number;
	relevanceScore: number;
	content: string;
	url: string;
	title: string;
	isHype?: boolean;
}

export interface RagPreparationResult {
	rewrittenQuery: string;
	prompt: string;
	sources: Array<{
		url: string;
		title: string;
		relevanceScore: number;
	}>;
	chunks: RagChunk[];
	noContextResponse?: string;
	intent: GenericRetrievalIntent;
	answerMode: AnswerMode;
}

class RagPipelineService {
	private openai: OpenAI;
	private pinecone: Pinecone;
	private nsCache = new Map<string, any>();

	constructor() {
		this.openai = new OpenAI({
			apiKey: config.OPENAI_API_KEY,
		});
		this.pinecone = new Pinecone({
			apiKey: config.PINECONE_API_KEY,
		});
	}

	private getBaseIndex(): any {
		return config.PINECONE_HOST
			? this.pinecone.index(
					config.PINECONE_INDEX_NAME,
					config.PINECONE_HOST.replace(
						/^https?:\/\//i,
						"",
					).replace(/\/+$/, ""),
			  )
			: this.pinecone.index(
					config.PINECONE_INDEX_NAME,
			  );
	}

	private getNsIndex(userId: string): any {
		const namespace = `user_${userId}`;
		if (!this.nsCache.has(namespace)) {
			this.nsCache.set(
				namespace,
				this.getBaseIndex().namespace(namespace),
			);
		}
		return this.nsCache.get(namespace);
	}

	private normalizeList(
		values: unknown,
		limit: number,
	): string[] {
		if (!Array.isArray(values)) {
			return [];
		}
		return Array.from(
			new Set(
				values
					.map((value) =>
						typeof value === "string"
							? value.trim()
							: "",
					)
					.filter(Boolean),
			),
		).slice(0, limit);
	}

	private mapIntentToAnswerMode(
		intent: GenericRetrievalIntent,
	): AnswerMode {
		switch (intent) {
			case "contact_or_location":
			case "pricing_or_sales":
				return "direct_fact";
			case "case_studies_or_portfolio":
				return "highlight_list";
			case "comparison":
				return "comparison";
			case "services_or_products":
			case "overview":
				return "concise_summary";
			case "support_or_policy":
			case "general":
			default:
				return "guided_explanation";
		}
	}

	private inferIntentLocally(
		query: string,
	): GenericRetrievalIntent {
		const normalized = query.toLowerCase();
		if (/\b(contact|address|phone|email|location|office|branch|reach|get in touch|hq)\b/.test(normalized)) {
			return "contact_or_location";
		}
		if (/\b(price|pricing|plan|package|quote|cost|subscription|demo|trial|sales)\b/.test(normalized)) {
			return "pricing_or_sales";
		}
		if (/\b(case study|case studies|portfolio|project|projects|work samples|success stories|examples|client work)\b/.test(normalized)) {
			return "case_studies_or_portfolio";
		}
		if (/\b(service|services|product|products|solution|solutions|offering|offerings|feature|features|capabilities)\b/.test(normalized)) {
			return "services_or_products";
		}
		if (/\b(help|support|policy|refund|shipping|privacy|terms|faq|knowledge base)\b/.test(normalized)) {
			return "support_or_policy";
		}
		if (/\b(compare|comparison|difference|vs|versus)\b/.test(normalized)) {
			return "comparison";
		}
		if (/\b(about|company|who are you|overview|background|mission|vision|team)\b/.test(normalized)) {
			return "overview";
		}
		return "general";
	}

	private getPreferredPageTypes(
		intent: GenericRetrievalIntent,
	): string[] {
		switch (intent) {
			case "contact_or_location":
				return ["contact", "about"];
			case "pricing_or_sales":
				return ["pricing", "services"];
			case "case_studies_or_portfolio":
				return ["portfolio", "blog"];
			case "services_or_products":
				return ["services", "about"];
			case "support_or_policy":
				return ["faq", "blog"];
			case "overview":
				return ["about", "general"];
			default:
				return [];
		}
	}

	private getPreferredBlockTypes(
		intent: GenericRetrievalIntent,
	): string[] {
		switch (intent) {
			case "contact_or_location":
				return ["contact", "list", "paragraph"];
			case "pricing_or_sales":
				return ["table", "list", "paragraph"];
			case "case_studies_or_portfolio":
				return ["summary", "list", "paragraph"];
			case "services_or_products":
				return ["summary", "list", "paragraph"];
			case "support_or_policy":
				return ["faq", "list", "paragraph"];
			default:
				return [];
		}
	}

	private detectExhaustiveQuery(query: string): boolean {
		return (
			/\b(all|every|both|list|multiple)\b/i.test(query) ||
			/\b(offices|locations|branches|addresses|contacts)\b/i.test(query)
		);
	}

	private buildFallbackPlan(
		query: string,
		context?: RagConversationContext,
	): RetrievalPlan {
		const intent = this.inferIntentLocally(query);
		const latestUserQuestion =
			context?.recentUserQuestions?.slice(-1)[0];
		const trimmedQuery = query.trim();
		const standaloneQuery =
			trimmedQuery.length <= 24 &&
			latestUserQuestion &&
			!latestUserQuestion
				.toLowerCase()
				.includes(trimmedQuery.toLowerCase())
				? `${latestUserQuestion.trim()} ${trimmedQuery}`
				: trimmedQuery || query;

		return {
			standaloneQuery,
			intent,
			entities: [],
			mustHaveConcepts: [],
			niceToHaveConcepts: [],
			answerMode:
				this.mapIntentToAnswerMode(intent),
			preferredPageTypes:
				this.getPreferredPageTypes(intent),
			preferredBlockTypes:
				this.getPreferredBlockTypes(intent),
			isExhaustiveQuery:
				this.detectExhaustiveQuery(query),
		};
	}

	private async planRetrieval(
		query: string,
		context?: RagConversationContext,
	): Promise<RetrievalPlan> {
		const fallback = this.buildFallbackPlan(
			query,
			context,
		);

		// Run semantic router in parallel with LLM planner — zero extra latency.
		// Result is used only if the LLM planner fails (enhanced fallback).
		const semanticRoutePromise = semanticRouterService
			.route(query)
			.catch(() => null);

		try {
			const response =
				await this.openai.chat.completions.create({
					model: PLANNER_MODEL,
					response_format: {
						type: "json_object",
					},
					temperature: 0,
					max_tokens: 450,
					messages: [
						{
							role: "system",
							content:
								"You are a multi-tenant retrieval planner for a RAG system. Stay generic across any business domain and never assume company-specific facts. Return JSON with keys: standaloneQuery, intent, entities, mustHaveConcepts, niceToHaveConcepts, answerMode, preferredPageTypes, preferredBlockTypes. intent must be one of [overview, services_or_products, contact_or_location, pricing_or_sales, case_studies_or_portfolio, support_or_policy, comparison, general]. answerMode must be one of [direct_fact, concise_summary, highlight_list, guided_explanation, comparison, fallback_only]. Use history only to resolve follow-up questions. Return valid JSON only.",
						},
						{
							role: "user",
							content: JSON.stringify({
								latestQuestion: query,
								recentUserQuestions:
									context?.recentUserQuestions ??
									[],
								recentAssistantReplies:
									context?.recentAssistantReplies ??
									[],
								conversationSummary:
									context?.conversationSummary ??
									"",
							}),
						},
					],
				});

			const raw =
				response.choices[0]?.message?.content ??
				"{}";
			const parsed = JSON.parse(raw);
			const intentValues: GenericRetrievalIntent[] = [
				"overview",
				"services_or_products",
				"contact_or_location",
				"pricing_or_sales",
				"case_studies_or_portfolio",
				"support_or_policy",
				"comparison",
				"general",
			];
			const answerModes: AnswerMode[] = [
				"direct_fact",
				"concise_summary",
				"highlight_list",
				"guided_explanation",
				"comparison",
				"fallback_only",
			];
			const intent = intentValues.includes(
				parsed.intent,
			)
				? parsed.intent
				: fallback.intent;
			const answerMode =
				answerModes.includes(parsed.answerMode)
					? parsed.answerMode
					: this.mapIntentToAnswerMode(intent);
			const parsedPreferredPageTypes =
				this.normalizeList(
					parsed.preferredPageTypes,
					5,
				);
			const parsedPreferredBlockTypes =
				this.normalizeList(
					parsed.preferredBlockTypes,
					5,
				);
			const preferredPageTypes =
				intent === "contact_or_location"
					? this.getPreferredPageTypes(intent)
					: parsedPreferredPageTypes.length > 0
						? parsedPreferredPageTypes
						: this.getPreferredPageTypes(intent);
			const preferredBlockTypes =
				intent === "contact_or_location"
					? this.getPreferredBlockTypes(intent)
					: parsedPreferredBlockTypes.length > 0
						? parsedPreferredBlockTypes
						: this.getPreferredBlockTypes(intent);

			return {
				standaloneQuery:
					typeof parsed.standaloneQuery ===
						"string" &&
					parsed.standaloneQuery.trim()
						? parsed.standaloneQuery.trim()
						: fallback.standaloneQuery,
				intent,
				entities: this.normalizeList(
					parsed.entities,
					8,
				),
				mustHaveConcepts: this.normalizeList(
					parsed.mustHaveConcepts,
					10,
				),
				niceToHaveConcepts: this.normalizeList(
					parsed.niceToHaveConcepts,
					10,
				),
				answerMode,
				preferredPageTypes,
				preferredBlockTypes,
				isExhaustiveQuery:
					this.detectExhaustiveQuery(query),
			};
		} catch (error) {
			logger.warn(
				"[RAG] Retrieval planner failed, using fallback plan",
				{
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
			// LLM failed — try semantic router result before falling back to regex
			const routed = await semanticRoutePromise;
			if (
				routed &&
				routed.confidence >= semanticRouterService.confidenceThreshold
			) {
				const intent = routed.intent as GenericRetrievalIntent;
				logger.info("[RAG] Semantic router used as fallback", {
					intent,
					confidence: routed.confidence,
				});
				return {
					...fallback,
					intent,
					answerMode: this.mapIntentToAnswerMode(intent),
					preferredPageTypes: this.getPreferredPageTypes(intent),
					preferredBlockTypes: this.getPreferredBlockTypes(intent),
				};
			}
			return fallback;
		}
	}

	private async stepBackRewrite(
		query: string,
		intent?: GenericRetrievalIntent,
	): Promise<string> {
		if (
			intent === "services_or_products" ||
			intent === "pricing_or_sales" ||
			intent === "case_studies_or_portfolio"
		) {
			return query;
		}
		try {
			const response =
				await this.openai.chat.completions.create({
					model: QUERY_REWRITE_MODEL,
					temperature: 0,
					max_tokens: 100,
					messages: [
						{
							role: "system",
							content:
								"You are a search query optimizer. Rewrite the user's question into a broader, more general search query that will retrieve the most relevant documents from a vector database. Return only the rewritten query, nothing else.",
						},
						{
							role: "user",
							content: query,
						},
					],
				});

			const rewritten =
				response.choices[0]?.message?.content?.trim();
			return rewritten || query;
		} catch (error) {
			logger.warn(
				"[RAG] Step-back rewrite failed, using original query",
				{
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
			return query;
		}
	}

	private buildIntentKeywords(
		intent: GenericRetrievalIntent,
	): string[] {
		switch (intent) {
			case "contact_or_location":
				return [
					"contact",
					"address",
					"phone",
					"email",
					"office",
					"location",
					"headquarters",
					"branches",
				];
			case "pricing_or_sales":
				return [
					"pricing",
					"plan",
					"package",
					"cost",
					"quote",
					"sales",
					"consultation",
				];
			case "case_studies_or_portfolio":
				return [
					"case studies",
					"portfolio",
					"projects",
					"clients",
					"results",
					"outcomes",
				];
			case "services_or_products":
				return [
					"services",
					"products",
					"solutions",
					"offerings",
					"capabilities",
				];
			case "support_or_policy":
				return [
					"support",
					"faq",
					"help",
					"policy",
					"knowledge base",
				];
			case "overview":
				return [
					"about",
					"company",
					"overview",
					"business",
					"team",
				];
			case "comparison":
				return ["compare", "difference"];
			default:
				return [];
		}
	}

	private buildRetrievalQuery(
		baseQuery: string,
		plan: RetrievalPlan,
		extraQuery?: string,
		structuredPlan?: StructuredQueryPlan,
	): string {
		const parts = [
			extraQuery?.trim(),
			baseQuery.trim(),
			...plan.entities,
			...plan.mustHaveConcepts,
			...plan.niceToHaveConcepts.slice(0, 4),
			...(structuredPlan?.focusTerms ?? []),
			...this.buildIntentKeywords(plan.intent),
		].filter(Boolean) as string[];

		return Array.from(new Set(parts)).join(" ");
	}

	private async embedQuery(
		query: string,
	): Promise<number[]> {
		const response =
			await this.openai.embeddings.create({
				model: config.OPENAI_MODEL,
				dimensions:
					config.OPENAI_EMBEDDING_DIMENSIONS,
				input: query,
			});

		return response.data[0]?.embedding ?? [];
	}

	/**
	 * Directly fetches all non-hype chunks tagged pageType="contact" for a user.
	 * Used to guarantee contact page content is in context regardless of ranking.
	 */
	private async fetchAllContactChunks(
		userId: string,
		embedding: number[],
	): Promise<any[]> {
		const index = this.getNsIndex(userId);
		const filter: Record<string, unknown> = {
			$and: [
				{ userId },
				{ pageType: { $in: ["contact", "location"] } },
				{ isHype: { $ne: true } },
			],
		};
		const queryRequest: Record<string, unknown> = {
			vector: embedding,
			topK: 50,
			includeMetadata: true,
			filter,
		};
		if (config.PINECONE_HYBRID) {
			// sparse vector not needed here — metadata filter is the primary discriminant
		}
		const response = await index.query(queryRequest);
		return response.matches ?? [];
	}

	private prioritizeIntentMatches(
		matches: any[],
		intent: GenericRetrievalIntent,
	): any[] {
		if (matches.length === 0) {
			return matches;
		}

		if (intent === "services_or_products") {
			const scoreMatch = (match: any): number => {
				const pageType = String(
					match?.metadata?.pageType ?? "",
				).toLowerCase();
				const url = String(
					match?.metadata?.url ?? "",
				).toLowerCase();
				const retrievalSource = String(
					match?.metadata?.retrievalSource ?? "",
				).toLowerCase();
				let bonus = 0;

				if (
					pageType === "services" ||
					pageType === "about" ||
					pageType === "home"
				) {
					bonus += 8;
				}
				if (retrievalSource === "structured") {
					bonus += 4;
				}
				if (
					url.includes("/blog/") ||
					url.includes("/insights/") ||
					pageType === "blog"
				) {
					bonus -= 6;
				}

				return Number(match?.score ?? 0) + bonus;
			};

			return [...matches].sort(
				(left, right) =>
					scoreMatch(right) -
					scoreMatch(left),
			);
		}

		return matches;
	}

	private shouldUseStructuredRetrieval(
		intent: GenericRetrievalIntent,
	): boolean {
		return (
			intent === "contact_or_location" ||
			intent === "pricing_or_sales" ||
			intent === "case_studies_or_portfolio" ||
			intent === "services_or_products" ||
			intent === "support_or_policy" ||
			intent === "overview"
		);
	}

	private async structuredSearch(
		userId: string,
		query: string,
		plan: RetrievalPlan,
		structuredPlan?: StructuredQueryPlan,
	): Promise<any[]> {
		if (!this.shouldUseStructuredRetrieval(plan.intent)) {
			return [];
		}

		const results =
			await pineconeService.queryStructuredBlocks(
				userId,
				query,
				STRUCTURED_RESULT_LIMIT,
				{
					topic: structuredPlan?.topic,
					pageTypes:
						(structuredPlan?.pageTypes?.length ?? 0) > 0
							? structuredPlan?.pageTypes
							: plan.preferredPageTypes.length > 0
								? plan.preferredPageTypes
							: undefined,
					blockTypes:
						(structuredPlan?.blockTypes?.length ?? 0) > 0
							? structuredPlan?.blockTypes
							: plan.preferredBlockTypes.length > 0
								? plan.preferredBlockTypes
							: undefined,
					focusTerms: [
						...(structuredPlan?.focusTerms ?? []),
						...plan.entities,
						...plan.mustHaveConcepts,
						...plan.niceToHaveConcepts,
					],
				},
			);

		return results.map((result) =>
			this.mapStructuredResultToMatch(result),
		);
	}

	private mapStructuredResultToMatch(
		result: StructuredBlockSearchResult,
	): any {
		const normalizedScore = Math.max(
			0.45,
			Math.min(0.95, 0.55 + result.relevanceScore / 12),
		);

		return {
			id: `structured:${result.id}`,
			score: normalizedScore,
			metadata: {
				url: result.sourceUrl,
				title: result.title,
				content: result.content,
				pageType: result.pageType ?? undefined,
				blockType: result.blockType ?? undefined,
				sectionTitle:
					result.sectionTitle ?? undefined,
				sectionPath:
					result.sectionPath ?? undefined,
				isHype: false,
				retrievalSource: "structured",
			},
		};
	}

	private async hydrateMatches(
		userId: string,
		matches: any[],
	): Promise<any[]> {
		return pineconeService.hydrateMatches(
			userId,
			matches,
		);
	}

	private buildMetadataFilter(
		userId: string,
		pageTypes?: string[],
		blockTypes?: string[],
	): Record<string, unknown> {
		const clauses: Array<Record<string, unknown>> = [
			{ userId },
		];

		if (pageTypes && pageTypes.length > 0) {
			clauses.push({
				pageType: { $in: pageTypes },
			});
		}
		if (blockTypes && blockTypes.length > 0) {
			clauses.push({
				blockType: { $in: blockTypes },
			});
		}

		if (clauses.length === 1) {
			return clauses[0];
		}

		return { $and: clauses };
	}

	private async hybridSearch(
		userId: string,
		embedding: number[],
		retrievalQuery: string,
		options?: {
			pageTypes?: string[];
			blockTypes?: string[];
			topK?: number;
		},
	): Promise<any[]> {
		const index = this.getNsIndex(userId);
		const queryRequest: Record<string, unknown> = {
			vector: embedding,
			topK: options?.topK ?? PINECONE_TOP_K,
			includeMetadata: true,
			filter: this.buildMetadataFilter(
				userId,
				options?.pageTypes,
				options?.blockTypes,
			),
		};

		if (config.PINECONE_HYBRID) {
			const sparseVector =
				buildSparseVector(retrievalQuery);
			if (sparseVector.values.length > 0) {
				queryRequest.sparseVector =
					sparseVector;
			}
		}

		const response = await index.query(queryRequest);
		return response.matches ?? [];
	}

	private mergeMatches(
		primaryMatches: any[],
		secondaryMatches: any[],
	): any[] {
		const merged = new Map<string, any>();

		for (const match of [
			...primaryMatches,
			...secondaryMatches,
		]) {
			const key = String(
				match.id ??
					`${match.metadata?.url ?? ""}#${match.metadata?.chunkIndex ?? ""}`,
			);
			const existing = merged.get(key);
			if (!existing) {
				merged.set(key, match);
				continue;
			}

			const existingContent = String(
				existing.metadata?.content ?? "",
			).trim();
			const nextContent = String(
				match.metadata?.content ?? "",
			).trim();

			if (!existingContent && nextContent) {
				merged.set(key, {
					...existing,
					metadata: {
						...(existing.metadata ?? {}),
						...(match.metadata ?? {}),
						content: nextContent,
					},
				});
				continue;
			}

			if ((match.score ?? 0) > (existing.score ?? 0)) {
				merged.set(key, {
					...existing,
					...match,
				});
				continue;
			}
		}

		return Array.from(merged.values()).sort(
			(left, right) =>
				(right.score ?? 0) - (left.score ?? 0),
		);
	}

	private trimSnippet(
		text: string,
		maxChars: number,
	): string {
		const normalized = text.trim();
		if (normalized.length <= maxChars) {
			return normalized;
		}
		return `${normalized.slice(0, maxChars).trim()}...`;
	}

	private buildSufficiencyFallback(
		question: string,
		plan: RetrievalPlan,
		matches: any[],
	): SufficiencyDecision {
		if (matches.length === 0) {
			return {
				sufficient: false,
				reason: "No retrieved evidence",
				followupQuery: this.buildRetrievalQuery(
					question,
					plan,
				),
				missingConcepts: plan.mustHaveConcepts,
				answerMode: plan.answerMode,
			};
		}

		if (plan.intent === "contact_or_location") {
			const contactChunks = matches.filter((match) =>
				/\b(address|phone|email|office|location|contact)\b/i.test(
					String(match.metadata?.content ?? ""),
				),
			);
			// For exhaustive queries (asking for "all" offices/locations), require
			// at least 2 contact-bearing chunks before declaring sufficient
			const minRequired = plan.isExhaustiveQuery ? 2 : 1;
			const sufficient = contactChunks.length >= minRequired;
			return {
				sufficient,
				reason: sufficient
					? `Retrieved ${contactChunks.length} contact/location evidence chunks`
					: `Need more contact evidence — only ${contactChunks.length}/${minRequired} found`,
				followupQuery: sufficient
					? undefined
					: this.buildRetrievalQuery(
							question,
							plan,
							"all office locations addresses phone email contact details headquarters",
					  ),
				missingConcepts: sufficient ? [] : ["all contact locations"],
				answerMode: "direct_fact",
			};
		}

		return {
			sufficient: matches.length >= 3,
			reason:
				matches.length >= 3
					? "Sufficient breadth of evidence"
					: "Limited evidence retrieved",
			followupQuery:
				matches.length >= 3
					? undefined
					: this.buildRetrievalQuery(
							question,
							plan,
					  ),
			missingConcepts:
				matches.length >= 3
					? []
					: plan.mustHaveConcepts,
			answerMode: plan.answerMode,
		};
	}

	private async assessEvidence(
		userQuery: string,
		plan: RetrievalPlan,
		matches: any[],
	): Promise<SufficiencyDecision> {
		const fallback = this.buildSufficiencyFallback(
			userQuery,
			plan,
			matches,
		);

		try {
			const evidence = matches
				.slice(0, 8)
				.map((match, index) => ({
					index: index + 1,
					url: String(match.metadata?.url ?? ""),
					title: String(match.metadata?.title ?? ""),
					pageType: String(
						match.metadata?.pageType ?? "",
					),
					score: Number(match.score ?? 0),
					content: this.trimSnippet(
						String(match.metadata?.content ?? ""),
						HISTORY_SNIPPET_CHAR_LIMIT,
					),
				}));

			const response =
				await this.openai.chat.completions.create({
					model: SUFFICIENCY_MODEL,
					response_format: {
						type: "json_object",
					},
					temperature: 0,
					max_tokens: 300,
					messages: [
						{
							role: "system",
							content:
								"You are an evidence sufficiency checker for a multi-tenant RAG system. Decide whether the retrieved evidence is enough to answer the user's question without guessing. Return JSON with keys: sufficient, reason, followupQuery, missingConcepts, answerMode. answerMode must be one of [direct_fact, concise_summary, highlight_list, guided_explanation, comparison, fallback_only]. If evidence is weak, suggest one improved retrieval query. Stay generic across any business domain.",
						},
						{
							role: "user",
							content: JSON.stringify({
								userQuestion: userQuery,
								intent: plan.intent,
								currentAnswerMode:
									plan.answerMode,
								mustHaveConcepts:
									plan.mustHaveConcepts,
								entities: plan.entities,
								evidence,
							}),
						},
					],
				});

			const raw =
				response.choices[0]?.message?.content ??
				"{}";
			const parsed = JSON.parse(raw);
			const answerModes: AnswerMode[] = [
				"direct_fact",
				"concise_summary",
				"highlight_list",
				"guided_explanation",
				"comparison",
				"fallback_only",
			];

			const decision: SufficiencyDecision = {
				sufficient:
					typeof parsed.sufficient ===
					"boolean"
						? parsed.sufficient
						: fallback.sufficient,
				reason:
					typeof parsed.reason === "string" &&
					parsed.reason.trim()
						? parsed.reason.trim()
						: fallback.reason,
				followupQuery:
					typeof parsed.followupQuery ===
						"string" &&
					parsed.followupQuery.trim()
						? parsed.followupQuery.trim()
						: fallback.followupQuery,
				missingConcepts: this.normalizeList(
					parsed.missingConcepts,
					8,
				),
				answerMode:
					answerModes.includes(
						parsed.answerMode,
					)
						? parsed.answerMode
						: fallback.answerMode,
			};

			// Override: if this is an exhaustive contact query and the LLM
			// declared "sufficient" but we actually have fewer than 2 contact
			// chunks, force a second retrieval round to find missing locations.
			if (
				decision.sufficient &&
				plan.intent === "contact_or_location" &&
				plan.isExhaustiveQuery
			) {
				const contactChunks = matches.filter((m) =>
					/\b(address|phone|email|office|location|contact)\b/i.test(
						String(m.metadata?.content ?? ""),
					),
				);
				if (contactChunks.length < 2) {
					decision.sufficient = false;
					decision.reason =
						`Exhaustive location query — only ${contactChunks.length} contact chunk(s) found, need more`;
					decision.followupQuery =
						decision.followupQuery ??
						this.buildRetrievalQuery(
							userQuery,
							plan,
							"all office locations addresses phone email contact details",
						);
				}
			}

			return decision;
		} catch (error) {
			logger.warn(
				"[RAG] Evidence sufficiency check failed, using fallback decision",
				{
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
			return fallback;
		}
	}

	private thresholdFilter(
		matches: any[],
		isContactQuery: boolean = false,
	): RagChunk[] {
		const threshold = isContactQuery
			? CHAT_CONTACT_SCORE_THRESHOLD
			: CHAT_RETRIEVAL_SCORE_THRESHOLD;
		return matches
			.filter((match) => {
				const content = String(
					match.metadata?.content ??
						match.metadata?.sourceContent ??
						"",
				).trim();
				const pineconeScore =
					typeof match._originalPineconeScore ===
					"number"
						? match._originalPineconeScore
						: (match.score ?? 0);
				return (
					pineconeScore >= threshold &&
					match.metadata?.isHype !== true &&
					content.length > 0
				);
			})
			.map((match) => ({
				id: String(match.id ?? ""),
				score: Number(match.score ?? 0),
				cohereScore:
					typeof match.cohereScore === "number"
						? match.cohereScore
						: undefined,
				relevanceScore:
					typeof match.cohereScore === "number"
						? match.cohereScore
						: Number(match.score ?? 0),
				content: String(
					match.metadata?.content ??
						match.metadata?.sourceContent ??
						"",
				),
				url: String(match.metadata?.url ?? ""),
				title: String(
					match.metadata?.title ??
						match.metadata?.url ??
						"",
				),
				isHype:
					match.metadata?.isHype === true,
			}));
	}

	private trimAtSentenceBoundary(
		text: string,
		maxChars: number,
	): string {
		const normalized = text.trim();
		if (normalized.length <= maxChars) {
			return normalized;
		}

		const truncated = normalized.slice(0, maxChars);
		const lastBoundary = Math.max(
			truncated.lastIndexOf(". "),
			truncated.lastIndexOf("! "),
			truncated.lastIndexOf("? "),
		);

		if (lastBoundary >= Math.floor(maxChars * 0.5)) {
			return truncated
				.slice(0, lastBoundary + 1)
				.trim();
		}

		return truncated.trim();
	}

	private buildAnswerModeInstruction(
		answerMode: AnswerMode,
		intent: GenericRetrievalIntent,
	): string {
		switch (answerMode) {
			case "direct_fact":
				return "Answer directly in the first sentence. If there are multiple factual entries, use short bullet points. Do not drift into unrelated service descriptions.";
			case "concise_summary":
				return intent === "services_or_products"
					? "Start with a one-sentence summary of the main offerings, then give a plain bullet list (no bold, no sub-headings) of the most relevant services or products. Keep it concise unless the user explicitly asks for a full list."
					: "Start with a short summary, then add concise bullets only if they improve clarity.";
			case "highlight_list":
				return "Give a short introductory sentence, then a compact highlight list. For each example or case study, include the exact name and one specific detail or outcome when available. Keep the list selective and scannable.";
			case "comparison":
				return "Use a clear comparison structure with short bullets or mini-sections. Focus on the most important differences relevant to the question.";
			case "guided_explanation":
				return "Answer clearly using short sections or bullets when helpful. Lead with the direct answer, then add only the most relevant supporting detail.";
			case "fallback_only":
			default:
				return "If the context is weak, be honest and concise instead of guessing.";
		}
	}

	private buildPrompt(
		query: string,
		chunks: RagChunk[],
		boundary: WorkspaceBoundary,
		answerMode: AnswerMode,
		intent: GenericRetrievalIntent,
	): string {
		const formatDirective =
			"FORMATTING (mandatory): Use bullet points (-) for lists. Do NOT use bold (**) inside a sentence or to emphasize individual words — the ONLY acceptable use of bold is when the entire bullet text is a label, e.g. '- **Web Development**'. Writing '- We offer **web development** and **SEO**' is wrong. Writing '- **Web Development** — brief description' is also wrong. Use numbered lists (1.) only for steps. No ## headings. Plain, scannable text.";
		const answerModeInstruction =
			this.buildAnswerModeInstruction(
				answerMode,
				intent,
			);
		const contextBlock = chunks
			.map(
				(chunk) =>
					`Source: ${chunk.url}\n${this.trimAtSentenceBoundary(chunk.content, 2000)}`,
			)
			.join("\n\n---\n\n");

		const urlInstruction = "URL REFERENCES (mandatory): Each context section starts with a Source URL. When answering, identify which source URL(s) are most directly relevant to what the user asked. Include those URLs as plain links in your answer. End with an invitation like 'Visit [URL] for full details.' Only include URLs that genuinely match what the user asked.";

		if (boundary === "workspace_only") {
			return (
				"Answer using ONLY the information provided in the context below. You may combine and compile information from multiple context sections to form a complete answer. If the context contains no relevant information at all for the question, say \"I don't have information about that in my knowledge base.\"\n\n" +
				`Answer mode: ${answerModeInstruction}\n\n` +
				`Context:\n${contextBlock}\n\n` +
				`Question: ${query}\n\n` +
				`${urlInstruction}\n\n` +
				formatDirective
			);
		}

		return (
			"Answer the user's question using the context below as your primary source.\nIf the context does not fully cover the question, use your general knowledge to fill in - but never fabricate specific facts, prices, features, policies, or company details that are not in the context.\n\n" +
			"If the user is asking about this specific business, its services, case studies, pricing, locations, contacts, policies, or projects, and the context is weak or partial, do NOT answer with generic industry examples. Instead, state only what is supported by the context and clearly say when the business-specific information is not available.\n\n" +
			`Answer mode: ${answerModeInstruction}\n\n` +
			`Context:\n${contextBlock}\n\n` +
			`Question: ${query}\n\n` +
			`${urlInstruction}\n\n` +
			formatDirective
		);
	}
	private isCasualNoContextQuery(
		query: string,
	): boolean {
		return /^(hi|hello|hey|thanks|thank you|bye|goodbye|good morning|good afternoon|good evening|how are you|ok|okay|cool|great)\b/i.test(
			query.trim(),
		);
	}

	private buildNoContextFallback(
		query: string,
	): string {
		if (this.isCasualNoContextQuery(query)) {
			return "Hello! I can help with questions about this business and its knowledge base.";
		}

		return "I can only help with topics covered in this business's knowledge base. Please ask something related to the website content or support information.";
	}

	async prepare(
		userId: string,
		query: string,
		boundary: WorkspaceBoundary,
		context?: RagConversationContext,
		options?: {
			retrievalQuery?: string;
			isContactQuery?: boolean;
			structuredPlan?: StructuredQueryPlan;
		},
	): Promise<RagPreparationResult> {
		console.log("\n========== [RAG Pipeline] START ==========");
		console.log("[RAG 0] Input query:", JSON.stringify(query));
		console.log("[RAG 0] retrievalQuery override:", options?.retrievalQuery ?? "(none)");
		console.log("[RAG 0] isContactQuery hint:", options?.isContactQuery ?? false);
		console.log("[RAG 0] Boundary:", boundary);
		console.log("[RAG 0] Context — recent user Qs:", context?.recentUserQuestions ?? []);

		const retrievalPlan = await this.planRetrieval(
			query,
			context,
		);
		logger.info("[RAG 1/10] Retrieval plan", {
			intent: retrievalPlan.intent,
			answerMode: retrievalPlan.answerMode,
			standaloneQuery:
				retrievalPlan.standaloneQuery.slice(0, 120),
			recentUserQuestions:
				context?.recentUserQuestions?.length ?? 0,
		});
		console.log("[RAG 1/10] Retrieval plan:", {
			intent: retrievalPlan.intent,
			answerMode: retrievalPlan.answerMode,
			standaloneQuery: retrievalPlan.standaloneQuery,
			entities: retrievalPlan.entities,
			mustHaveConcepts: retrievalPlan.mustHaveConcepts,
			preferredPageTypes: retrievalPlan.preferredPageTypes,
			preferredBlockTypes: retrievalPlan.preferredBlockTypes,
		});

		// Use the HyDE-enhanced query from queryTransformService if provided,
		// otherwise fall back to the planner's standalone query.
		const baseForRetrieval =
			options?.retrievalQuery?.trim() ||
			retrievalPlan.standaloneQuery;
		const rewrittenQuery =
			await this.stepBackRewrite(
				baseForRetrieval,
				retrievalPlan.intent,
			);
		logger.info("[RAG 2/10] Step-back rewrite", {
			original: baseForRetrieval.slice(0, 120),
			rewritten: rewrittenQuery.slice(0, 120),
		});
		console.log("[RAG 2/10] Step-back rewrite:", {
			original: baseForRetrieval,
			rewritten: rewrittenQuery,
		});

		const roundOneQuery = this.buildRetrievalQuery(
			rewrittenQuery,
			retrievalPlan,
			undefined,
			options?.structuredPlan,
		);
		const roundOneEmbedding =
			await this.embedQuery(roundOneQuery);
		const roundOneStructuredMatches =
			await this.structuredSearch(
				userId,
				roundOneQuery,
				retrievalPlan,
				options?.structuredPlan,
			);
		logger.info("[RAG 3/10] Query embedded", {
			model: config.OPENAI_MODEL,
			dims: roundOneEmbedding.length,
			structuredMatches:
				roundOneStructuredMatches.length,
		});

		// For contact/location intent, apply pageType filter in round-1 so the
		// contact page surfaces before irrelevant blog/service pages.
		// If the filtered search returns fewer than 5 results, merge with an
		// unfiltered pass to avoid empty context.
		const isContactIntent =
			retrievalPlan.intent === "contact_or_location";
		const isContactQuery =
			options?.isContactQuery ?? isContactIntent;

		let roundOneMatches: any[];
		if (isContactIntent && retrievalPlan.preferredPageTypes.length > 0) {
			// Always merge filtered + unfiltered for contact queries so that
			// address chunks with unexpected blockType metadata are not excluded.
			const [filteredMatches, unfilteredMatches] = await Promise.all([
				this.hybridSearch(userId, roundOneEmbedding, roundOneQuery, {
					pageTypes: retrievalPlan.preferredPageTypes,
					blockTypes: retrievalPlan.preferredBlockTypes,
					topK: PINECONE_CONTACT_TOP_K,
				}),
				this.hybridSearch(userId, roundOneEmbedding, roundOneQuery, {
					topK: PINECONE_CONTACT_TOP_K,
				}),
			]);
			roundOneMatches = this.mergeMatches(
				this.mergeMatches(
					filteredMatches,
					unfilteredMatches,
				),
				roundOneStructuredMatches,
			);
		} else {
			const semanticMatches =
				await this.hybridSearch(
					userId,
					roundOneEmbedding,
					roundOneQuery,
				);
			roundOneMatches = this.mergeMatches(
				semanticMatches,
				roundOneStructuredMatches,
			);
		}
		roundOneMatches = await this.hydrateMatches(
			userId,
			roundOneMatches,
		);

		logger.info("[RAG 4/10] Retrieval round 1", {
			hybrid: config.PINECONE_HYBRID,
			count: roundOneMatches.length,
			contactFiltered: isContactIntent,
		});
		console.log("[RAG 3/10] Round-1 retrieval query:", roundOneQuery);
		console.log("[RAG 3/10] Contact-filtered round-1:", isContactIntent);
		console.log("[RAG 4/10] Round-1 matches count:", roundOneMatches.length);
		console.log("[RAG 4/10] Top-5 round-1 matches:");
		roundOneMatches.slice(0, 5).forEach((m, i) => {
			console.log(`  [${i+1}] score=${m.score?.toFixed(4)} url=${m.metadata?.url} content="${String(m.metadata?.content ?? "").slice(0, 120)}"`);
		});

		const roundOneReranked =
			await rerankService.rerank(
				query,
				roundOneMatches,
				RERANK_TOP_N,
			);
		let roundOneRanked =
			this.prioritizeIntentMatches(
				roundOneReranked,
				retrievalPlan.intent,
			);
		logger.info("[RAG 5/10] Rerank round 1", {
			count: roundOneRanked.length,
		});
		console.log("[RAG 5/10] After rerank — top-5:");
		roundOneRanked.slice(0, 5).forEach((m, i) => {
			console.log(`  [${i+1}] score=${m.score?.toFixed(4)} url=${m.metadata?.url} content="${String(m.metadata?.content ?? "").slice(0, 120)}"`);
		});

		const sufficiency =
			await this.assessEvidence(
				query,
				retrievalPlan,
				roundOneRanked,
			);
		logger.info("[RAG 6/10] Evidence sufficiency", {
			sufficient: sufficiency.sufficient,
			reason: sufficiency.reason,
			followupQuery:
				sufficiency.followupQuery?.slice(0, 120),
		});
		console.log("[RAG 6/10] Evidence sufficiency:", {
			sufficient: sufficiency.sufficient,
			reason: sufficiency.reason,
			followupQuery: sufficiency.followupQuery,
			missingConcepts: sufficiency.missingConcepts,
			answerMode: sufficiency.answerMode,
		});

		let finalMatches = roundOneRanked;
		let finalAnswerMode =
			sufficiency.answerMode ||
			retrievalPlan.answerMode;

		if (
			!sufficiency.sufficient &&
			sufficiency.followupQuery
		) {
			const roundTwoQuery =
				this.buildRetrievalQuery(
					rewrittenQuery,
					retrievalPlan,
					sufficiency.followupQuery,
					options?.structuredPlan,
				);
			const roundTwoEmbedding =
				await this.embedQuery(roundTwoQuery);

			let roundTwoMatches =
				await this.hybridSearch(
					userId,
					roundTwoEmbedding,
					roundTwoQuery,
					{
						pageTypes:
							retrievalPlan.preferredPageTypes,
						blockTypes:
							retrievalPlan.preferredBlockTypes,
						topK: isContactQuery ? PINECONE_CONTACT_TOP_K : PINECONE_TOP_K,
					},
				);
			const roundTwoStructuredMatches =
				await this.structuredSearch(
					userId,
					roundTwoQuery,
					retrievalPlan,
					options?.structuredPlan,
				);
			roundTwoMatches = this.mergeMatches(
				roundTwoMatches,
				roundTwoStructuredMatches,
			);
			roundTwoMatches = await this.hydrateMatches(
				userId,
				roundTwoMatches,
			);

			if (
				roundTwoMatches.length === 0 &&
				(retrievalPlan.preferredPageTypes.length > 0 ||
					retrievalPlan.preferredBlockTypes.length > 0)
			) {
				roundTwoMatches =
					await this.hybridSearch(
						userId,
						roundTwoEmbedding,
						roundTwoQuery,
						{ topK: isContactQuery ? PINECONE_CONTACT_TOP_K : PINECONE_TOP_K },
					);
			}

			const mergedMatches = this.mergeMatches(
				roundOneMatches,
				roundTwoMatches,
			);
			finalMatches =
				this.prioritizeIntentMatches(
					await rerankService.rerank(
					query,
					mergedMatches,
					RERANK_TOP_N,
					),
					retrievalPlan.intent,
				);
			logger.info("[RAG 7/10] Retrieval round 2", {
				count: roundTwoMatches.length,
				merged: mergedMatches.length,
				final: finalMatches.length,
			});
		}

		// For contact/location queries, inject all contact-tagged chunks directly
		// so they appear in context regardless of reranker score.
		if (isContactIntent) {
			const contactChunks = await this.fetchAllContactChunks(
				userId,
				roundOneEmbedding,
			);
			const hydratedContactChunks =
				await this.hydrateMatches(
					userId,
					contactChunks,
				);
			finalMatches = this.mergeMatches(
				finalMatches,
				hydratedContactChunks,
			);
		}
		// Safety net: ensure structured matches with real DB content are always in
		// the final pool. Without this, stale Pinecone blockIds cause all Pinecone
		// matches to have empty content after hydrateMatches, and if Cohere ranked
		// those stale matches above structural ones (based on title/URL alone)
		// every match fails the content.length > 0 check → passed: 0.
		const structuralWithContent =
			roundOneStructuredMatches.filter(
				(m) =>
					String(
						m.metadata?.content ?? "",
					).trim().length > 0,
			);
		if (structuralWithContent.length > 0) {
			finalMatches = this.mergeMatches(
				finalMatches,
				structuralWithContent,
			);
		}

		finalMatches = await this.hydrateMatches(
			userId,
			finalMatches,
		);

		logger.info("[RAG 7.5/10] Pre-filter state", {
			total: finalMatches.length,
			withContent: finalMatches.filter(
				(m) =>
					String(
						m.metadata?.content ?? "",
					).trim().length > 0,
			).length,
			structural: finalMatches.filter(
				(m) =>
					String(m.id ?? "").startsWith(
						"structured:",
					),
			).length,
		});

		const filtered =
			this.thresholdFilter(finalMatches, isContactQuery);
		logger.info("[RAG 8/10] Threshold filter", {
			isContactQuery,
			passed: filtered.length,
		});
		console.log("[RAG 8/10] Threshold filter:", {
			isContactQuery,
			passed: filtered.length,
			urls: filtered.map(c => c.url),
		});

		if (filtered.length === 0) {
			return {
				rewrittenQuery,
				prompt: "",
				sources: [],
				chunks: [],
				noContextResponse:
					this.buildNoContextFallback(query),
				intent: retrievalPlan.intent,
				answerMode: finalAnswerMode,
			};
		}

		// Replace MMR with Cohere-score-ranked top-K.
		// MMR drops relevant pages because all case-study pages look similar in
		// embedding space (high diversity penalty). Cohere reranking is query-aware
		// and already handles relevance — we just need the top K by that score.
		const topK = isContactQuery ? MMR_K_CONTACT : MMR_K;

		// Deduplicate by URL, keeping the highest-relevance chunk per URL.
		const byUrl = new Map<string, RagChunk>();
		for (const chunk of filtered) {
			const existing = byUrl.get(chunk.url);
			if (!existing || chunk.relevanceScore > existing.relevanceScore) {
				byUrl.set(chunk.url, chunk);
			}
		}

		// Sort by relevanceScore (Cohere score when available, raw score otherwise)
		// and take topK. This is fully query-aware — no embedding-space diversity penalty.
		let diversified = Array.from(byUrl.values())
			.sort((a, b) => b.relevanceScore - a.relevanceScore)
			.slice(0, topK);

		// Entity injection: after top-K selection, ensure at least one chunk whose
		// URL contains a query entity keyword is included even if it scored lower.
		const entityKeywords = [
			...(retrievalPlan.entities ?? []),
			...(retrievalPlan.mustHaveConcepts ?? []),
		]
			.map((e) => e.toLowerCase().trim())
			.filter(Boolean);
		if (entityKeywords.length > 0) {
			const selectedUrls = new Set(diversified.map((c) => c.url));
			const injected = Array.from(byUrl.values())
				.filter(
					(c) =>
						!selectedUrls.has(c.url) &&
						entityKeywords.some((kw) =>
							c.url.toLowerCase().includes(kw),
						),
				)
				.slice(0, 2);
			if (injected.length > 0) {
				diversified = [...diversified, ...injected];
				logger.info("[RAG 9/10] Entity injection", {
					injected: injected.map((c) => c.url),
					entities: entityKeywords,
				});
			}
		}

		logger.info("[RAG 9/10] Relevance-ranked selection", {
			topK,
			isContactQuery,
			selected: diversified.length,
		});
		console.log("[RAG 9/10] Final chunks after relevance ranking:");
		diversified.forEach((c, i) => {
			console.log(`  [${i+1}] relevance=${c.relevanceScore.toFixed(4)} url=${c.url}`);
			console.log(`       content: "${c.content.slice(0, 150)}"`);
		});

		const prompt = this.buildPrompt(
			query,
			diversified,
			boundary,
			finalAnswerMode,
			retrievalPlan.intent,
		);
		logger.info("[RAG 10/10] Prompt built", {
			intent: retrievalPlan.intent,
			answerMode: finalAnswerMode,
			chunks: diversified.length,
		});
		console.log("[RAG 10/10] Final prompt (first 800 chars):\n", prompt.slice(0, 800));
		console.log("========== [RAG Pipeline] END ==========\n");

		const sources: Array<{
			url: string;
			title: string;
			relevanceScore: number;
		}> = [];
		const seenUrls = new Set<string>();

		for (const chunk of diversified) {
			if (seenUrls.has(chunk.url)) {
				continue;
			}
			seenUrls.add(chunk.url);
			sources.push({
				url: chunk.url,
				title: chunk.title || chunk.url,
				relevanceScore:
					chunk.relevanceScore,
			});
		}

		return {
			rewrittenQuery,
			prompt,
			sources,
			chunks: diversified,
			intent: retrievalPlan.intent,
			answerMode: finalAnswerMode,
		};
	}
}

export const ragPipelineService =
	new RagPipelineService();
