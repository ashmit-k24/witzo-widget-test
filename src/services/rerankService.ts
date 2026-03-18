import { CohereClient } from "cohere-ai";
import { config } from "../config/env";
import { CHAT_RERANK_TOP_N } from "../constants";
import logger from "../utils/logger";

class RerankService {
	private cohere: CohereClient | null = null;
	private enabled: boolean;

	constructor() {
		this.enabled = Boolean(config.COHERE_API_KEY);
		if (this.enabled) {
			this.cohere = new CohereClient({
				token: config.COHERE_API_KEY!,
			});
		} else {
			logger.warn(
				"[RerankService] COHERE_API_KEY not set — reranking disabled, falling back to cosine order",
			);
		}
	}

	/**
	 * Rerank Pinecone matches using Cohere's cross-encoder.
	 * Falls back to original cosine order if Cohere is not configured or fails.
	 */
	async rerank(
		query: string,
		matches: any[],
		topN: number = CHAT_RERANK_TOP_N,
	): Promise<any[]> {
		if (!this.enabled || !this.cohere || matches.length === 0) {
			return matches.slice(0, topN);
		}

		// Extract text content for each match
		const documents = matches.map((m) =>
			String(m.metadata?.content || ""),
		);

		// Filter out empty docs (keep track of originals)
		const nonEmpty: { doc: string; match: any; idx: number }[] = [];
		documents.forEach((doc, idx) => {
			if (doc.trim()) {
				nonEmpty.push({ doc, match: matches[idx], idx });
			}
		});

		if (nonEmpty.length === 0) {
			return matches.slice(0, topN);
		}

		try {
			const response = await this.cohere.rerank({
				model: "rerank-english-v3.0",
				query,
				documents: nonEmpty.map((e) => e.doc),
				topN: Math.min(topN, nonEmpty.length),
				returnDocuments: false,
			});

			const reranked = (response.results ?? []).map((result) => {
				const original = nonEmpty[result.index];
				return {
					...original.match,
					score: result.relevanceScore,
					_rerankScore: result.relevanceScore,
					_originalCosineScore: original.match.score,
				};
			});

			logger.info("[RerankService] Reranked results", {
				query: query.slice(0, 80),
				inputCount: nonEmpty.length,
				outputCount: reranked.length,
			});

			return reranked;
		} catch (error) {
			logger.error("[RerankService] Cohere rerank failed, using cosine order", {
				error: error instanceof Error ? error.message : String(error),
			});
			// Graceful fallback
			return matches.slice(0, topN);
		}
	}
}

export const rerankService = new RerankService();
