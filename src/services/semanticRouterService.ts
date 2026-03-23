/**
 * Semantic Router — embedding-based intent classification.
 *
 * Replaces the fragile regex `inferIntentLocally()` as the fallback when
 * the LLM planner fails. Uses cosine similarity between the incoming query
 * and a set of pre-embedded example queries per intent.
 *
 * Example embeddings are computed once (lazy init on first use) and cached
 * in memory for the lifetime of the process.
 */
import OpenAI from "openai";
import { config } from "../config/env";
import { memCache } from "../utils/memCache";
import { openAICircuitBreaker } from "../utils/circuitBreaker";
import logger from "../utils/logger";

// Intentionally not imported from ragPipelineService to avoid circular deps.
// Must stay in sync with GenericRetrievalIntent in ragPipelineService.ts.
export type RouterIntent =
	| "overview"
	| "services_or_products"
	| "contact_or_location"
	| "pricing_or_sales"
	| "case_studies_or_portfolio"
	| "support_or_policy"
	| "comparison"
	| "general";

export interface RouteResult {
	intent: RouterIntent;
	confidence: number;
}

// 5–10 diverse example queries per intent. Broader coverage = more robust routing.
const INTENT_EXAMPLES: Record<RouterIntent, string[]> = {
	contact_or_location: [
		"where is your office located?",
		"what is your address?",
		"how can I contact you?",
		"what is your phone number?",
		"what are your office locations?",
		"where are you based?",
		"how to reach you?",
		"what is your email address?",
		"do you have an office in bangalore?",
		"what is your headquarters address?",
	],
	services_or_products: [
		"what services do you offer?",
		"what do you do?",
		"what are your products?",
		"what can you help me with?",
		"tell me about your offerings",
		"what are your capabilities?",
		"do you offer web development?",
		"what kind of work do you do?",
		"list all your services",
		"what solutions do you provide?",
	],
	pricing_or_sales: [
		"how much does it cost?",
		"what are your pricing plans?",
		"what is the price?",
		"do you have any packages?",
		"how much do you charge?",
		"can I get a quote?",
		"what are your rates?",
		"do you have a free trial?",
		"what is the monthly fee?",
	],
	case_studies_or_portfolio: [
		"show me your work",
		"do you have any case studies?",
		"what projects have you done?",
		"can I see your portfolio?",
		"what clients have you worked with?",
		"tell me about a project you completed",
		"what are some examples of your work?",
		"show me client success stories",
		"what are your past projects?",
	],
	overview: [
		"tell me about your company",
		"who are you?",
		"what is your company about?",
		"give me an overview of your business",
		"what is your mission?",
		"how long have you been in business?",
		"who founded the company?",
		"what does your company do?",
	],
	support_or_policy: [
		"what is your refund policy?",
		"do you have a privacy policy?",
		"what are your terms of service?",
		"how do I get support?",
		"what are your support hours?",
		"do you have a help center?",
		"how do I cancel my subscription?",
	],
	comparison: [
		"how do you compare to competitors?",
		"what makes you different from others?",
		"why should I choose you over others?",
		"what is the difference between your plans?",
		"compare your services to the competition",
		"what is your competitive advantage?",
	],
	general: [
		"tell me more",
		"what else can you help with?",
		"I have a general question",
		"can you help me with something?",
	],
};

const ROUTER_CACHE_TTL_SECONDS = 300; // 5 minutes
const CONFIDENCE_THRESHOLD = 0.72;
// Number of top example scores to average per intent (reduces noise from edge examples)
const TOP_SCORES_TO_AVERAGE = 3;

class SemanticRouterService {
	private openai: OpenAI;
	private exampleEmbeddings: Map<RouterIntent, number[][]> | null = null;
	private initPromise: Promise<void> | null = null;

	constructor() {
		this.openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
	}

	private cosineSimilarity(a: number[], b: number[]): number {
		let dot = 0;
		let normA = 0;
		let normB = 0;
		for (let i = 0; i < a.length; i++) {
			dot += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}
		const denom = Math.sqrt(normA) * Math.sqrt(normB);
		return denom === 0 ? 0 : dot / denom;
	}

	private async embedBatch(texts: string[]): Promise<number[][]> {
		const response = await openAICircuitBreaker.execute(async () =>
			this.openai.embeddings.create({
				model: config.OPENAI_MODEL,
				input: texts,
				dimensions: config.OPENAI_EMBEDDING_DIMENSIONS,
			}),
		);
		return response.data.map((d) => d.embedding);
	}

	/**
	 * Lazy-initialize: embed all example queries in a single API call.
	 * Called automatically on the first `route()` invocation.
	 */
	private async initialize(): Promise<void> {
		const intents = Object.keys(INTENT_EXAMPLES) as RouterIntent[];
		const allExamples = intents.flatMap((intent) => INTENT_EXAMPLES[intent]);

		const embeddings = await this.embedBatch(allExamples);

		const result = new Map<RouterIntent, number[][]>();
		let offset = 0;
		for (const intent of intents) {
			const count = INTENT_EXAMPLES[intent].length;
			result.set(intent, embeddings.slice(offset, offset + count));
			offset += count;
		}
		this.exampleEmbeddings = result;
		logger.info("[SemanticRouter] Initialized", {
			intents: intents.length,
			totalExamples: allExamples.length,
		});
	}

	/**
	 * Route a query to the closest intent using cosine similarity.
	 *
	 * @param query - Raw user query string
	 * @param queryEmbedding - Optional pre-computed embedding to avoid a redundant API call
	 */
	async route(query: string, queryEmbedding?: number[]): Promise<RouteResult> {
		// Cache routing results to avoid re-embedding identical queries
		const cacheKey = `semantic_route:${Buffer.from(query.toLowerCase().trim()).toString("base64").slice(0, 48)}`;
		const cached = memCache.get(cacheKey);
		if (cached) {
			try {
				return JSON.parse(cached) as RouteResult;
			} catch {
				// ignore corrupt entry
			}
		}

		// Ensure example embeddings are ready
		if (!this.exampleEmbeddings) {
			if (!this.initPromise) {
				this.initPromise = this.initialize().catch((err) => {
					logger.warn("[SemanticRouter] Initialization failed", {
						error: err instanceof Error ? err.message : String(err),
					});
					this.initPromise = null;
				});
			}
			await this.initPromise;
		}

		if (!this.exampleEmbeddings) {
			return { intent: "general", confidence: 0 };
		}

		try {
			const embedding =
				queryEmbedding ?? (await this.embedBatch([query]))[0];
			if (!embedding) {
				return { intent: "general", confidence: 0 };
			}

			let bestIntent: RouterIntent = "general";
			let bestScore = -1;

			for (const [intent, examples] of this.exampleEmbeddings.entries()) {
				const scores = examples
					.map((ex) => this.cosineSimilarity(embedding, ex))
					.sort((a, b) => b - a)
					.slice(0, TOP_SCORES_TO_AVERAGE);
				const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
				if (avg > bestScore) {
					bestScore = avg;
					bestIntent = intent;
				}
			}

			const result: RouteResult = { intent: bestIntent, confidence: bestScore };
			memCache.setex(cacheKey, ROUTER_CACHE_TTL_SECONDS, JSON.stringify(result));
			return result;
		} catch (error) {
			logger.warn("[SemanticRouter] Routing failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { intent: "general", confidence: 0 };
		}
	}

	get confidenceThreshold(): number {
		return CONFIDENCE_THRESHOLD;
	}
}

export const semanticRouterService = new SemanticRouterService();
