import OpenAI from "openai";
import { Pinecone } from "@pinecone-database/pinecone";
import { config } from "../config/env";
import { buildSparseVector } from "../utils/bm25";
import logger from "../utils/logger";
import { rerankService } from "./rerankService";

const PINECONE_TOP_K = 50;
const RERANK_TOP_N = 15;
const SCORE_THRESHOLD = 0.4;
const MMR_K = 8;
const MMR_LAMBDA = 0.7;
const QUERY_REWRITE_MODEL = "gpt-4o-mini";
const QUERY_REWRITE_SYSTEM_PROMPT =
	"You are a search query optimizer. Rewrite the user's question into a broader, more general search query that will retrieve the most relevant documents from a vector database. Return only the rewritten query, nothing else.";

export type WorkspaceBoundary =
	| "workspace_only"
	| "general_allowed";

export interface RagChunk {
	id: string;
	score: number;
	cohereScore?: number;
	content: string;
	url: string;
	title: string;
	values?: number[];
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

	private async stepBackRewrite(
		query: string,
	): Promise<string> {
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
								QUERY_REWRITE_SYSTEM_PROMPT,
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

	private async hybridSearch(
		userId: string,
		embedding: number[],
		rewrittenQuery: string,
	): Promise<any[]> {
		const index = this.getNsIndex(userId);
		const queryRequest: Record<string, unknown> = {
			vector: embedding,
			topK: PINECONE_TOP_K,
			includeMetadata: true,
			includeValues: true,
			filter: { userId },
		};

		if (config.PINECONE_HYBRID) {
			queryRequest.sparseVector =
				buildSparseVector(rewrittenQuery);
		}

		const response = await index.query(queryRequest);
		return response.matches ?? [];
	}

	private thresholdFilter(
		matches: any[],
	): RagChunk[] {
		return matches
			.filter((match) => {
				return (
					(match.score ?? 0) >= SCORE_THRESHOLD &&
					match.metadata?.isHype !== true
				);
			})
			.map((match) => ({
				id: String(match.id ?? ""),
				score: Number(match.score ?? 0),
				cohereScore:
					typeof match.cohereScore === "number"
						? match.cohereScore
						: undefined,
				content: String(
					match.metadata?.content ?? "",
				),
				url: String(match.metadata?.url ?? ""),
				title: String(
					match.metadata?.title ??
						match.metadata?.url ??
						"",
				),
				values: Array.isArray(match.values)
					? match.values
					: undefined,
				isHype:
					match.metadata?.isHype === true,
			}));
	}

	private cosineSimilarity(
		left?: number[],
		right?: number[],
	): number {
		if (
			!left ||
			!right ||
			left.length === 0 ||
			right.length === 0 ||
			left.length !== right.length
		) {
			return 0;
		}

		let dot = 0;
		let leftNorm = 0;
		let rightNorm = 0;

		for (let index = 0; index < left.length; index += 1) {
			const leftValue = left[index];
			const rightValue = right[index];
			dot += leftValue * rightValue;
			leftNorm += leftValue * leftValue;
			rightNorm += rightValue * rightValue;
		}

		if (leftNorm === 0 || rightNorm === 0) {
			return 0;
		}

		return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
	}

	private mmrFilter(
		chunks: RagChunk[],
	): RagChunk[] {
		if (chunks.length <= MMR_K) {
			return chunks;
		}

		const candidates = [...chunks].sort(
			(left, right) => right.score - left.score,
		);
		const selected: RagChunk[] = [];

		while (
			selected.length < MMR_K &&
			candidates.length > 0
		) {
			if (selected.length === 0) {
				selected.push(candidates.shift()!);
				continue;
			}

			let bestIndex = 0;
			let bestMmrScore = -Infinity;

			for (
				let candidateIndex = 0;
				candidateIndex < candidates.length;
				candidateIndex += 1
			) {
				const candidate =
					candidates[candidateIndex];
				const maxSimilarity = Math.max(
					...selected.map((selectedChunk) =>
						this.cosineSimilarity(
							candidate.values,
							selectedChunk.values,
						),
					),
				);
				const mmrScore =
					MMR_LAMBDA * candidate.score -
					(1 - MMR_LAMBDA) * maxSimilarity;

				if (mmrScore > bestMmrScore) {
					bestMmrScore = mmrScore;
					bestIndex = candidateIndex;
				}
			}

			selected.push(
				candidates.splice(bestIndex, 1)[0],
			);
		}

		return selected;
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

	private buildPrompt(
		query: string,
		chunks: RagChunk[],
		boundary: WorkspaceBoundary,
	): string {
		const formatDirective =
			'IMPORTANT: Format your response using markdown. Use **bold** for key terms, bullet points (-) for lists, numbered lists (1.) for steps, and ## headings for major sections. When listing multiple items (services, features, examples), list ALL of them - give each item its own heading with specific details. Include all numbers, percentages, and names from the context. Do not truncate or say "and more" when you have the actual data.';

		const contextBlock = chunks
			.map(
				(chunk) =>
					`Source: ${chunk.url}\n${this.trimAtSentenceBoundary(chunk.content, 2000)}`,
			)
			.join("\n\n---\n\n");

		if (boundary === "workspace_only") {
			return (
				"Answer using ONLY the information provided in the context below. You may combine and compile information from multiple context sections to form a complete answer. If the context contains no relevant information at all for the question, say \"I don't have information about that in my knowledge base.\"\n\n" +
				`Context:\n${contextBlock}\n\n` +
				`Question: ${query}\n\n` +
				formatDirective
			);
		}

		return (
			"Answer the user's question using the context below as your primary source.\nIf the context does not fully cover the question, use your general knowledge to fill in - but never fabricate specific facts, prices, features, or policies about this company that are not in the context.\n\n" +
			`Context:\n${contextBlock}\n\n` +
			`Question: ${query}\n\n` +
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
	): Promise<RagPreparationResult> {
		const rewrittenQuery =
			await this.stepBackRewrite(query);
		logger.info("[RAG 1/8] Step-back rewrite", {
			original: query.slice(0, 120),
			rewritten: rewrittenQuery.slice(0, 120),
		});

		const embedding = await this.embedQuery(
			rewrittenQuery,
		);
		logger.info("[RAG 2/8] Query embedded", {
			model: config.OPENAI_MODEL,
			dims: embedding.length,
		});

		const pineconeMatches =
			await this.hybridSearch(
				userId,
				embedding,
				rewrittenQuery,
			);
		logger.info("[RAG 3/8] Pinecone search", {
			hybrid: config.PINECONE_HYBRID,
			count: pineconeMatches.length,
		});

		const reranked =
			await rerankService.rerank(
				query,
				pineconeMatches,
				RERANK_TOP_N,
			);
		logger.info("[RAG 4/8] Cohere rerank", {
			count: reranked.length,
		});

		const filtered =
			this.thresholdFilter(reranked);
		logger.info("[RAG 5/8] Threshold filter", {
			threshold: SCORE_THRESHOLD,
			passed: filtered.length,
		});

		if (filtered.length === 0) {
			return {
				rewrittenQuery,
				prompt: "",
				sources: [],
				chunks: [],
				noContextResponse:
					this.buildNoContextFallback(query),
			};
		}

		const diversified =
			this.mmrFilter(filtered).slice(0, MMR_K);
		logger.info("[RAG 6/8] MMR filter", {
			lambda: MMR_LAMBDA,
			selected: diversified.length,
		});

		const prompt = this.buildPrompt(
			query,
			diversified,
			boundary,
		);
		logger.info("[RAG 7/8] Prompt built", {
			boundary,
			chunks: diversified.length,
		});

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
				relevanceScore: chunk.score,
			});
		}

		return {
			rewrittenQuery,
			prompt,
			sources,
			chunks: diversified,
		};
	}
}

export const ragPipelineService =
	new RagPipelineService();
