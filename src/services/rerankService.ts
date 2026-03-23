// rerankService.ts
// Cohere reranking integration. Gracefully degrades if COHERE_API_KEY not set.
// Ported from konvoqai-backend Go: controller/integrations.go cohereRerank()

import axios from "axios";
import { config } from "../config/env";
import logger from "../utils/logger";

function extractMatchText(match: any): string {
	return (
		String(match.metadata?.parentText || "") ||
		String(match.metadata?.content || "") ||
		String(match.metadata?.text || "") ||
		""
	);
}

// cohereRerank reranks matches using Cohere's Rerank API.
// Returns original matches unchanged if COHERE_API_KEY not set or on any error.
export async function cohereRerank(
	query: string,
	matches: any[],
	topN: number,
): Promise<any[]> {
	if (!config.COHERE_API_KEY?.trim() || matches.length === 0) {
		logger.info("[RAG 4/5] cohere rerank: skipped", {
			reason: !config.COHERE_API_KEY?.trim() ? "no COHERE_API_KEY" : "no matches",
		});
		return matches;
	}

	logger.info("[RAG 4/5] cohere rerank: starting", { matchesIn: matches.length, topN });

	const documents = matches.map((m) => extractMatchText(m));
	const effectiveTopN = topN > 0 && topN <= matches.length ? topN : matches.length;

	try {
		const response = await axios.post(
			"https://api.cohere.com/v1/rerank",
			{
				model: "rerank-english-v3.0",
				query,
				documents,
				top_n: effectiveTopN,
				return_documents: false,
			},
			{
				headers: {
					Authorization: `Bearer ${config.COHERE_API_KEY}`,
					"Content-Type": "application/json",
				},
				timeout: 10000,
			},
		);

		const results = response.data?.results ?? [];
		if (results.length === 0) return matches;

		const reranked = results.map((r: { index: number; relevance_score: number }) => ({
			...matches[r.index],
			cohereScore: r.relevance_score,
			metadata: {
				...(matches[r.index]?.metadata ?? {}),
				cohereScore: r.relevance_score,
			},
		}));

		logger.info("[RAG 4/5] cohere rerank: done", { matchesOut: reranked.length });
		return reranked;
	} catch (err) {
		logger.warn("[RAG 4/5] cohere rerank: failed, using original order", { err });
		return matches;
	}
}
