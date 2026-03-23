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

	private buildRerankDocument(match: any): string {
		const metadata = match?.metadata ?? {};
		const parts: string[] = [];
		const title = String(metadata.title ?? "").trim();
		const pageType = String(
			metadata.pageType ?? "",
		).trim();
		const blockType = String(
			metadata.blockType ?? "",
		).trim();
		const sectionTitle = String(
			metadata.sectionTitle ?? "",
		).trim();
		const url = String(metadata.url ?? "").trim();
		const content = String(
			metadata.content ?? "",
		).trim();

		if (title) {
			parts.push(`Title: ${title}`);
		}
		if (pageType) {
			parts.push(`Page Type: ${pageType}`);
		}
		if (sectionTitle) {
			parts.push(`Section: ${sectionTitle}`);
		}
		if (blockType) {
			parts.push(`Block Type: ${blockType}`);
		}
		if (url) {
			parts.push(`URL: ${url}`);
		}
		if (content) {
			parts.push(`Content: ${content}`);
		}

		return parts.join("\n");
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
		const documents = matches.map((match) =>
			this.buildRerankDocument(match),
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
				model: "rerank-v3.5",
				query,
				documents: nonEmpty.map((e) => e.doc),
				topN: Math.min(topN, nonEmpty.length),
				returnDocuments: false,
			});

			const reranked = (response.results ?? []).map((result) => {
				const original = nonEmpty[result.index];
				// Keep Pinecone score intact for thresholding/filtering; Cohere is ordering only.
				return {
					...original.match,
					cohereScore: result.relevanceScore,
					_originalPineconeScore: original.match.score,
				};
			});

			logger.info("[RerankService] Reranked results", {
				query: query.slice(0, 80),
				inputCount: nonEmpty.length,
				outputCount: reranked.length,
				cohereScores: reranked.map((m) => (m.cohereScore ?? 0).toFixed(4)),
				pineconeScores: reranked.map((m) => (m._originalPineconeScore ?? 0).toFixed(3)),
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
