import axios from "axios";
import { config } from "../config/env";

function extractMatchText(match: any): string {
	const title = String(
		match.metadata?.title || "",
	).trim();
	const pageType = String(
		match.metadata?.pageType || "",
	).trim();
	const url = String(
		match.metadata?.url || "",
	).trim();
	const body =
		String(match.metadata?.parentText || "") ||
		String(match.metadata?.content || "") ||
		String(match.metadata?.text || "") ||
		"";

	return [title, pageType, url, body]
		.filter(Boolean)
		.join("\n");
}

// cohereRerank reranks matches using Cohere's Rerank API.
// Returns original matches unchanged if COHERE_API_KEY not set or on any error.
export async function cohereRerank(
	query: string,
	matches: any[],
	topN: number,
): Promise<any[]> {
	if (
		!config.COHERE_API_KEY?.trim() ||
		matches.length === 0
	) {
		return matches;
	}

	const documents = matches.map((m) =>
		extractMatchText(m),
	);
	const effectiveTopN =
		topN > 0 && topN <= matches.length
			? topN
			: matches.length;

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

		const reranked = results.map(
			(r: {
				index: number;
				relevance_score: number;
			}) => ({
				...matches[r.index],
				cohereScore: r.relevance_score,
				metadata: {
					...(matches[r.index]?.metadata ?? {}),
					cohereScore: r.relevance_score,
				},
			}),
		);

		return reranked;
	} catch (err) {
		return matches;
	}
}
