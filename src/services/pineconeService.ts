import {
	Pinecone,
	PineconeRecord,
} from "@pinecone-database/pinecone";
import crypto from "crypto";
import OpenAI from "openai";
import {
	coercePlanType,
	PLAN_CAPABILITIES,
	PlanType,
} from "../config/planConfig";
import { config } from "../config/env";
import pool from "../config/database";
import { redisCache } from "../config/redis";
import {
	DocumentUsageStats,
	DOCUMENT_LIMITS,
	PineconeMetadata,
	ScrapedPageContentBlock,
	ScraperUsageStats,
	StructuredBlockSearchResult,
} from "../types";
import {
	CHUNK_MAX_CHARS,
	CHUNK_OVERLAP_CHARS,
	CHAT_RETRIEVAL_SCORE_THRESHOLD,
} from "../constants";
import {
	openAICircuitBreaker,
	pineconeCircuitBreaker,
} from "../utils/circuitBreaker";
import logger from "../utils/logger";
import {
	retryOnRateLimit,
	retryWithBackoff,
} from "../utils/retry";
import { subscriptionService } from "./subscriptionService";

interface PineconeQueryOptions {
	pageTypes?: string[];
	blockTypes?: string[];
	sourceRoot?: string;
	sourceUrl?: string;
}

interface StructuredQueryOptions
	extends PineconeQueryOptions {
	focusTerms?: string[];
}

type RagSourcePageRow = {
	id: number;
};

type StructuredBlockRow = {
	id: number;
	source_page_id: number | null;
	source_type: "document" | "website";
	source_root: string | null;
	source_url: string;
	title: string | null;
	page_type: string | null;
	block_type: string | null;
	section_title: string | null;
	section_path: string[] | null;
	position: number;
	content: string;
	scraped_at: Date | null;
	relevance_score: number;
};

const EMBEDDING_BATCH_SIZE = 16;
const EMBEDDING_BATCH_CONCURRENCY = 2;
const STRUCTURED_PARAGRAPH_MIN_CHARS = 80;
const STRUCTURED_NONPARAGRAPH_MIN_CHARS = 40;
const STRUCTURED_MERGE_TARGET_CHARS = Math.max(
	CHUNK_MAX_CHARS,
	1200,
);
const STRUCTURED_SEARCH_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"any",
	"are",
	"at",
	"by",
	"for",
	"from",
	"give",
	"how",
	"i",
	"in",
	"is",
	"it",
	"me",
	"of",
	"on",
	"or",
	"please",
	"related",
	"show",
	"some",
	"tell",
	"that",
	"the",
	"their",
	"them",
	"these",
	"this",
	"those",
	"to",
	"us",
	"what",
	"with",
	"you",
	"your",
]);

class PineconeService {
	private pinecone: Pinecone;
	private openai: OpenAI;
	private indexName: string;
	private indexHost?: string;
	private namespaceIndexCache: Map<
		string,
		any
	> = new Map();

	constructor() {
		this.pinecone = new Pinecone({
			apiKey: config.PINECONE_API_KEY,
		});
		this.openai = new OpenAI({
			apiKey: config.OPENAI_API_KEY,
		});
		this.indexName = config.PINECONE_INDEX_NAME;
		this.indexHost = config.PINECONE_HOST
			? config.PINECONE_HOST.replace(
					/^https?:\/\//i,
					"",
			  ).replace(/\/+$/, "")
			: undefined;
	}

	private getBaseIndex(): any {
		return this.indexHost
			? this.pinecone.index(
					this.indexName,
					this.indexHost,
			  )
			: this.pinecone.index(this.indexName);
	}

	async ensureIndexExists(): Promise<void> {
		try {
			const indexes =
				await this.pinecone.listIndexes();
			const existingIndex = indexes.indexes?.find(
				(index) => index.name === this.indexName,
			);

			if (!existingIndex) {
				logger.info(
					`Creating Pinecone index: ${this.indexName}`,
				);
				await this.pinecone.createIndex({
					name: this.indexName,
					dimension:
						config.OPENAI_EMBEDDING_DIMENSIONS,
					metric: "cosine",
					spec: {
						serverless: {
							cloud: "aws",
							region: config.PINECONE_ENVIRONMENT,
						},
					},
				});
				logger.info(
					`Pinecone index created: ${this.indexName}`,
				);

				// Wait for index to be ready
				await new Promise((resolve) =>
					setTimeout(resolve, 10000),
				);
			} else if (
				typeof existingIndex.dimension === "number" &&
				existingIndex.dimension !==
					config.OPENAI_EMBEDDING_DIMENSIONS
			) {
				throw new Error(
					`Pinecone index "${this.indexName}" uses dimension ${existingIndex.dimension}, but the configured embedding dimension is ${config.OPENAI_EMBEDDING_DIMENSIONS}. Point PINECONE_INDEX_NAME to a new index or recreate the existing index.`,
				);
			}
		} catch (error) {
			logger.error(
				"Error ensuring Pinecone index exists",
				{ error },
			);
			throw error;
		}
	}

	private getUserNamespace(
		userId: string,
	): string {
		return `user_${userId}`;
	}

	private getNamespaceIndex(userId: string): any {
		const namespace =
			this.getUserNamespace(userId);
		if (
			this.namespaceIndexCache.has(namespace)
		) {
			return this.namespaceIndexCache.get(
				namespace,
			);
		}
		const index = this.getBaseIndex().namespace(
			namespace,
		);
		this.namespaceIndexCache.set(
			namespace,
			index,
		);
		return index;
	}

	private sanitizeId(text: string): string {
		// Replace special characters with underscores and remove consecutive underscores
		return text
			.replace(/[^a-zA-Z0-9-_]/g, "_")
			.replace(/_+/g, "_")
			.replace(/^_|_$/g, "");
	}

	private buildEmbeddingCacheEntry(text: string): {
		cacheKey: string;
		normalized: string;
	} {
		const normalized = text
			.trim()
			.toLowerCase()
			.replace(/\s+/g, " ");
		const digest = crypto
			.createHash("sha1")
			.update(normalized)
			.digest("hex");
		return {
			cacheKey: `emb:${digest}`,
			normalized,
		};
	}

	private async mapWithConcurrency<T, U>(
		items: T[],
		concurrency: number,
		worker: (
			item: T,
			index: number,
		) => Promise<U>,
	): Promise<U[]> {
		if (items.length === 0) {
			return [];
		}

		const results = new Array<U>(items.length);
		let cursor = 0;
		const limit = Math.max(1, concurrency);
		const runners = Array.from(
			{
				length: Math.min(limit, items.length),
			},
			async () => {
				while (cursor < items.length) {
					const currentIndex = cursor;
					cursor += 1;
					results[currentIndex] =
						await worker(
							items[currentIndex],
							currentIndex,
						);
				}
			},
		);
		await Promise.all(runners);
		return results;
	}

	private async generateEmbeddings(
		texts: string[],
	): Promise<number[][]> {
		if (texts.length === 0) {
			return [];
		}

		const cacheEntries = texts.map((text) => ({
			text,
			...this.buildEmbeddingCacheEntry(text),
		}));
		const cachedValues = await Promise.all(
			cacheEntries.map((entry) =>
				redisCache.get(entry.cacheKey).catch(() => null),
			),
		);
		const results = new Array<number[] | undefined>(
			texts.length,
		);
		const missing: Array<{
			index: number;
			text: string;
			cacheKey: string;
		}> = [];

		for (let i = 0; i < cacheEntries.length; i += 1) {
			const cached = cachedValues[i];
			if (cached) {
				results[i] = JSON.parse(cached) as number[];
				continue;
			}
			missing.push({
				index: i,
				text: cacheEntries[i].text,
				cacheKey: cacheEntries[i].cacheKey,
			});
		}

		const batches = this.chunkArray(
			missing,
			EMBEDDING_BATCH_SIZE,
		);
		const generatedBatches =
			await this.mapWithConcurrency(
				batches,
				EMBEDDING_BATCH_CONCURRENCY,
				async (batch) => {
					const response =
						await openAICircuitBreaker.execute(
							async () => {
								return await retryOnRateLimit(
									async () => {
										return await this.openai.embeddings.create(
											{
												model: config.OPENAI_MODEL,
												input: batch.map(
													(item) =>
														item.text,
												),
												dimensions:
													config.OPENAI_EMBEDDING_DIMENSIONS,
											},
										);
									},
								);
							},
						);

					return batch.map((item, index) => {
						const embedding =
							response.data[index]
								?.embedding;
						if (!embedding) {
							throw new Error(
								`Missing embedding for batch item ${index}`,
							);
						}
						return {
							index: item.index,
							cacheKey: item.cacheKey,
							embedding,
						};
					});
				},
			);

		for (const batch of generatedBatches) {
			await Promise.all(
				batch.map(async (item) => {
					results[item.index] =
						item.embedding;
					redisCache.setex(
						item.cacheKey,
						300,
						JSON.stringify(
							item.embedding,
						),
					).catch(() => {});
				}),
			);
		}

		if (results.some((embedding) => !embedding)) {
			throw new Error(
				"Failed to generate one or more embeddings",
			);
		}

		return results as number[][];
	}

	async generateEmbedding(
		text: string,
	): Promise<number[]> {
		try {
			const [embedding] =
				await this.generateEmbeddings([
					text,
				]);
			return embedding;
		} catch (error) {
			logger.error("Error generating embedding", {
				error,
			});
			throw error;
		}
	}

	chunkText(
		text: string,
		maxChunkSize: number = CHUNK_MAX_CHARS,
		overlapChars: number = CHUNK_OVERLAP_CHARS,
	): string[] {
		const normalizedText = text
			.replace(/\s+/g, " ")
			.trim();
		if (!normalizedText) {
			return [];
		}

		// Split into sentences
		const sentenceMatches = normalizedText.match(
			/[^.!?]+[.!?]+/g,
		);
		const sentences =
			sentenceMatches && sentenceMatches.length > 0
				? sentenceMatches
				: [normalizedText];

		const chunks: string[] = [];
		let currentChunk = "";

		for (const sentence of sentences) {
			if (
				currentChunk.length > 0 &&
				(currentChunk + sentence).length > maxChunkSize
			) {
				chunks.push(currentChunk.trim());
				// Start next chunk with overlap from end of current
				const overlap = currentChunk.length > overlapChars
					? currentChunk.slice(-overlapChars)
					: currentChunk;
				currentChunk = overlap + sentence;
			} else {
				currentChunk += sentence;
			}
		}

		if (currentChunk.trim()) {
			chunks.push(currentChunk.trim());
		}

		return chunks.filter(Boolean);
	}

	private compactStructuredBlocks(
		content: string,
		metadata?: Record<string, any>,
	): ScrapedPageContentBlock[] {
		const rawBlocks = Array.isArray(
			metadata?.contentBlocks,
		)
			? (metadata?.contentBlocks as ScrapedPageContentBlock[])
			: [];
		const compactedBlocks: ScrapedPageContentBlock[] = [];

		for (let blockIndex = 0; blockIndex < rawBlocks.length; blockIndex += 1) {
			const block = {
				...rawBlocks[blockIndex],
			};
			const blockText = String(block?.text ?? "")
				.replace(/\s+/g, " ")
				.trim();
			if (!blockText) {
				continue;
			}

			const minLength =
				block.blockType === "paragraph"
					? STRUCTURED_PARAGRAPH_MIN_CHARS
					: STRUCTURED_NONPARAGRAPH_MIN_CHARS;
			const isPriorityBlock =
				block.blockType === "contact" ||
				block.blockType === "faq" ||
				block.blockType === "summary";
			if (
				!isPriorityBlock &&
				blockText.length < minLength
			) {
				continue;
			}

			block.text = blockText;
			const previousBlock =
				compactedBlocks[
					compactedBlocks.length - 1
				];
			const canMerge =
				Boolean(previousBlock) &&
				previousBlock.blockType !==
					"contact" &&
				previousBlock.blockType !==
					"faq" &&
				previousBlock.blockType !==
					"summary" &&
				block.blockType !== "contact" &&
				block.blockType !== "faq" &&
				block.blockType !== "summary" &&
				previousBlock.sectionTitle ===
					block.sectionTitle &&
				(previousBlock.text.length +
					2 +
					block.text.length <=
					STRUCTURED_MERGE_TARGET_CHARS);

			if (canMerge) {
				previousBlock.text = `${previousBlock.text}\n\n${block.text}`;
				if (
					previousBlock.blockType !==
					block.blockType
				) {
					previousBlock.blockType =
						"paragraph";
				}
				continue;
			}

			compactedBlocks.push(block);
		}

		if (compactedBlocks.length > 0) {
			return compactedBlocks.map((block, index) => ({
				...block,
				position: block.position ?? index,
			}));
		}

		return this.chunkText(content).map(
			(chunk, index) => ({
				text: chunk,
				blockType: "paragraph",
				position: index,
			}),
		);
	}

	private buildStructuredChunks(
		content: string,
		metadata?: Record<string, any>,
	): Array<{
		text: string;
		chunkKey: string;
		metadata: Record<string, any>;
	}> {
		const compactedBlocks =
			this.compactStructuredBlocks(
				content,
				metadata,
			);
		const structuredChunks: Array<{
			text: string;
			chunkKey: string;
			metadata: Record<string, any>;
		}> = [];

		for (let blockIndex = 0; blockIndex < compactedBlocks.length; blockIndex += 1) {
			const block = compactedBlocks[blockIndex];
			const blockText = block.text;
			const sectionTitle =
				block.sectionTitle?.trim() || undefined;
			const enrichedBlockText =
				sectionTitle &&
				!blockText
					.toLowerCase()
					.startsWith(sectionTitle.toLowerCase())
					? `${sectionTitle}: ${blockText}`
					: blockText;
			const blockChunks =
				this.chunkText(enrichedBlockText);

			for (let subChunkIndex = 0; subChunkIndex < blockChunks.length; subChunkIndex += 1) {
				structuredChunks.push({
					text: blockChunks[subChunkIndex],
					chunkKey: `${block.position ?? blockIndex}_${subChunkIndex}`,
					metadata: {
						blockType: block.blockType,
						sectionTitle,
						sectionPath: block.sectionPath,
						position:
							block.position ?? blockIndex,
					},
				});
			}
		}

		if (structuredChunks.length > 0) {
			return structuredChunks;
		}

		return [];
	}

	private normalizeStructuredSearchTerms(
		query: string,
		focusTerms: string[] = [],
	): string[] {
		const normalizedFocusTerms = focusTerms
			.map((term) =>
				term
					.toLowerCase()
					.trim()
					.replace(/\s+/g, " "),
			)
			.filter(
				(term) =>
					term.length >= 3 &&
					!STRUCTURED_SEARCH_STOP_WORDS.has(term),
			);
		const normalizedQueryTerms = query
			.toLowerCase()
			.replace(/[^a-z0-9\s-]+/g, " ")
			.split(/\s+/)
			.map((term) => term.trim())
			.filter(
				(term) =>
					term.length >= 3 &&
					!STRUCTURED_SEARCH_STOP_WORDS.has(term),
			);
		return Array.from(
			new Set([
				...normalizedFocusTerms,
				...normalizedQueryTerms,
			]),
		).slice(0, 12);
	}

	private limitStructuredResultsPerUrl(
		results: StructuredBlockSearchResult[],
		maxPerUrl: number,
		limit: number,
	): StructuredBlockSearchResult[] {
		const counts = new Map<string, number>();
		const selected: StructuredBlockSearchResult[] =
			[];

		for (const result of results) {
			if (selected.length >= limit) {
				break;
			}
			const nextCount =
				(counts.get(result.sourceUrl) ?? 0) + 1;
			if (nextCount > maxPerUrl) {
				continue;
			}
			counts.set(result.sourceUrl, nextCount);
			selected.push(result);
		}

		return selected;
	}

	private async forEachUserRecord(
		userId: string,
		handler: (
			records: Record<
				string,
				PineconeRecord<any>
			>,
		) => Promise<void> | void,
	): Promise<void> {
		const index =
			this.getNamespaceIndex(userId);
		let paginationToken: string | undefined;

		do {
			const listResponse =
				await index.listPaginated({
					paginationToken,
					limit: 100,
				});
			const ids =
				listResponse.vectors
					?.map(
						(vector: any) => vector.id,
					)
					.filter((id: any): id is string =>
						Boolean(id),
					) ?? [];

			if (ids.length > 0) {
				const fetchResponse =
					await index.fetch(ids);
				const records =
					fetchResponse.records ?? {};
				await handler(records);
			}

			paginationToken =
				listResponse.pagination?.next ||
				undefined;
		} while (paginationToken);
	}

	private chunkArray<T>(
		items: T[],
		size: number,
	): T[][] {
		if (size <= 0) {
			return [items];
		}

		const chunks: T[][] = [];
		for (let i = 0; i < items.length; i += size) {
			chunks.push(items.slice(i, i + size));
		}
		return chunks;
	}

	private buildVectorId(
		userId: string,
		url: string,
		chunkIndex: string | number,
	): string {
		const sanitizedUrl = this.sanitizeId(url);
		return `${this.sanitizeId(userId)}_${sanitizedUrl}_chunk_${chunkIndex}`;
	}

	private buildQueryFilter(
		options?: PineconeQueryOptions,
	): Record<string, unknown> | undefined {
		if (!options) {
			return undefined;
		}

		const filters: Array<Record<string, unknown>> = [];
		const pageTypes = Array.from(
			new Set(
				(options.pageTypes ?? [])
					.map((value) => value.trim())
					.filter(Boolean),
			),
		).sort();
		const blockTypes = Array.from(
			new Set(
				(options.blockTypes ?? [])
					.map((value) => value.trim())
					.filter(Boolean),
			),
		).sort();

		if (
			pageTypes.length > 0 ||
			blockTypes.length > 0
		) {
			const semanticFilters: Array<
				Record<string, unknown>
			> = [];
			if (pageTypes.length > 0) {
				semanticFilters.push({
					pageType: { $in: pageTypes },
				});
			}
			if (blockTypes.length > 0) {
				semanticFilters.push({
					blockType: { $in: blockTypes },
				});
			}
			if (semanticFilters.length === 1) {
				filters.push(semanticFilters[0]);
			} else {
				filters.push({
					$or: semanticFilters,
				});
			}
		}
		if (options.sourceRoot?.trim()) {
			filters.push({
				sourceRoot: options.sourceRoot.trim(),
			});
		}
		if (options.sourceUrl?.trim()) {
			filters.push({
				url: options.sourceUrl.trim(),
			});
		}

		if (filters.length === 0) {
			return undefined;
		}
		if (filters.length === 1) {
			return filters[0];
		}

		return { $and: filters };
	}

	/**
	 * Infers the page type from the URL path so chunks can be filtered
	 * at retrieval time (e.g. contact queries → only 'contact' chunks).
	 */
	private detectPageType(url: string): string {
		try {
			const pathname = new URL(url).pathname.toLowerCase();
			if (/\/(contact|reach|get-in-touch|location|office|map)/.test(pathname)) return "contact";
			if (/\/(service|solution|product|offering|what-we-do)/.test(pathname)) return "services";
			if (/\/(price|pricing|plan|cost|rate|package)/.test(pathname)) return "pricing";
			if (/\/(about|team|history|who-we-are|company|our-story|founder)/.test(pathname)) return "about";
			if (/\/(faq|help|support|question|answer|kb|knowledge)/.test(pathname)) return "faq";
			if (/\/(blog|article|news|post|insight|update|resource)/.test(pathname)) return "blog";
			if (/\/(portfolio|case-stud|work|project|client)/.test(pathname)) return "portfolio";
			if (/\/(career|job|hiring|join|vacanc)/.test(pathname)) return "careers";
		} catch {
			// invalid URL — fall through to general
		}
		return "general";
	}

	private async upsertRagSourcePage(
		userId: string,
		url: string,
		title: string,
		chunks: number,
		metadata?: Record<string, any>,
	): Promise<number> {
		const sourceType = url.startsWith("document://")
			? "document"
			: "website";
		const sourceRoot =
			sourceType === "website"
				? (metadata?.sourceRoot as string | undefined) ??
				  url
				: null;
		const scrapedAtRaw =
			(metadata?.scrapedAt as string | undefined) ??
			(metadata?.uploadedAt as string | undefined);
		const scrapedAt =
			scrapedAtRaw && !Number.isNaN(Date.parse(scrapedAtRaw))
				? new Date(scrapedAtRaw)
				: new Date();

		const result = await pool.query<RagSourcePageRow>(
			`INSERT INTO rag_source_pages
				(user_id, source_type, source_root, source_url, title, chunks, scraped_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT (user_id, source_url)
			 DO UPDATE SET
				source_type = EXCLUDED.source_type,
				source_root = EXCLUDED.source_root,
				title = EXCLUDED.title,
				chunks = EXCLUDED.chunks,
				scraped_at = EXCLUDED.scraped_at,
				updated_at = CURRENT_TIMESTAMP
			 RETURNING id`,
			[
				userId,
				sourceType,
				sourceRoot,
				url,
				title,
				Math.max(0, Math.trunc(chunks)),
				scrapedAt,
			],
		);
		return result.rows[0].id;
	}

	private async upsertRagSourceBlocks(
		userId: string,
		sourcePageId: number,
		url: string,
		title: string,
		content: string,
		pageType: string,
		metadata?: Record<string, any>,
	): Promise<void> {
		const sourceType = url.startsWith("document://")
			? "document"
			: "website";
		const sourceRoot =
			sourceType === "website"
				? (metadata?.sourceRoot as string | undefined) ??
				  url
				: null;
		const scrapedAtRaw =
			(metadata?.scrapedAt as string | undefined) ??
			(metadata?.uploadedAt as string | undefined);
		const scrapedAt =
			scrapedAtRaw && !Number.isNaN(Date.parse(scrapedAtRaw))
				? new Date(scrapedAtRaw)
				: new Date();
		const blocks =
			this.compactStructuredBlocks(
				content,
				metadata,
			);

		await pool.query(
			`DELETE FROM rag_source_blocks
			 WHERE user_id = $1 AND source_url = $2`,
			[userId, url],
		);

		if (blocks.length === 0) {
			return;
		}

		for (const batch of this.chunkArray(blocks, 100)) {
			const valueClauses: string[] = [];
			const values: Array<
				string | number | Date | string[] | null
			> = [];
			let parameterIndex = 1;

			for (const block of batch) {
				valueClauses.push(
					`($${parameterIndex}, $${parameterIndex + 1}, $${parameterIndex + 2}, $${parameterIndex + 3}, $${parameterIndex + 4}, $${parameterIndex + 5}, $${parameterIndex + 6}, $${parameterIndex + 7}, $${parameterIndex + 8}, $${parameterIndex + 9}, $${parameterIndex + 10}, $${parameterIndex + 11}, $${parameterIndex + 12})`,
				);
				values.push(
					sourcePageId,
					userId,
					sourceType,
					sourceRoot,
					url,
					title,
					pageType,
					block.blockType,
					block.sectionTitle ?? null,
					block.sectionPath ?? null,
					block.position,
					block.text,
					scrapedAt,
				);
				parameterIndex += 13;
			}

			await pool.query(
				`INSERT INTO rag_source_blocks
					(source_page_id, user_id, source_type, source_root, source_url, title, page_type, block_type, section_title, section_path, position, content, scraped_at)
				 VALUES ${valueClauses.join(", ")}`,
				values,
			);
		}
	}

	async queryStructuredBlocks(
		userId: string,
		query: string,
		limit: number = 12,
		options?: StructuredQueryOptions,
	): Promise<StructuredBlockSearchResult[]> {
		try {
			const normalizedQuery = query
				.toLowerCase()
				.trim()
				.replace(/\s+/g, " ");
			const searchTerms =
				this.normalizeStructuredSearchTerms(
					query,
					options?.focusTerms,
				);
			const pageTypes =
				options?.pageTypes &&
				options.pageTypes.length > 0
					? Array.from(
							new Set(
								options.pageTypes.map((value) =>
									value.trim(),
								),
							),
					  )
					: null;
			const blockTypes =
				options?.blockTypes &&
				options.blockTypes.length > 0
					? Array.from(
							new Set(
								options.blockTypes.map((value) =>
									value.trim(),
								),
							),
					  )
					: null;
			if (
				!normalizedQuery &&
				searchTerms.length === 0 &&
				!options?.sourceRoot &&
				!options?.sourceUrl
			) {
				return [];
			}

			const candidateLimit = Math.max(limit * 4, 24);
			const result =
				await pool.query<StructuredBlockRow>(
					`WITH ranked AS (
						SELECT
							id,
							source_page_id,
							source_type,
							source_root,
							source_url,
							title,
							page_type,
							block_type,
							section_title,
							section_path,
							position,
							content,
							scraped_at,
							(
								CASE
									WHEN $2 <> '' AND lower(coalesce(title, '')) LIKE '%' || $2 || '%' THEN 8
									ELSE 0
								END +
								CASE
									WHEN $2 <> '' AND lower(coalesce(section_title, '')) LIKE '%' || $2 || '%' THEN 5
									ELSE 0
								END +
								CASE
									WHEN $2 <> '' AND lower(coalesce(source_url, '')) LIKE '%' || $2 || '%' THEN 4
									ELSE 0
								END +
								COALESCE((
									SELECT COUNT(*)
									FROM unnest($3::text[]) AS term
									WHERE lower(coalesce(title, '')) LIKE '%' || term || '%'
								), 0) * 2.5 +
								COALESCE((
									SELECT COUNT(*)
									FROM unnest($3::text[]) AS term
									WHERE lower(coalesce(section_title, '')) LIKE '%' || term || '%'
								), 0) * 1.8 +
								COALESCE((
									SELECT COUNT(*)
									FROM unnest($3::text[]) AS term
									WHERE lower(coalesce(source_url, '')) LIKE '%' || term || '%'
								), 0) * 1.5 +
								COALESCE((
									SELECT COUNT(*)
									FROM unnest($3::text[]) AS term
									WHERE lower(coalesce(content, '')) LIKE '%' || term || '%'
								), 0) * 1.0 +
								CASE
									WHEN $4::text[] IS NOT NULL AND page_type = ANY($4) THEN 1.5
									ELSE 0
								END +
								CASE
									WHEN $5::text[] IS NOT NULL AND block_type = ANY($5) THEN 1.0
									ELSE 0
								END
							) AS relevance_score
						FROM rag_source_blocks
						WHERE user_id = $1
						  AND ($4::text[] IS NULL OR page_type = ANY($4))
						  AND ($5::text[] IS NULL OR block_type = ANY($5))
						  AND ($6::text IS NULL OR source_root = $6)
						  AND ($7::text IS NULL OR source_url = $7)
						  AND (
								COALESCE(array_length($3::text[], 1), 0) = 0 OR
								lower(coalesce(title, '')) LIKE '%' || $2 || '%' OR
								lower(coalesce(section_title, '')) LIKE '%' || $2 || '%' OR
								lower(coalesce(source_url, '')) LIKE '%' || $2 || '%' OR
								EXISTS (
									SELECT 1
									FROM unnest($3::text[]) AS term
									WHERE lower(coalesce(title, '')) LIKE '%' || term || '%'
									   OR lower(coalesce(section_title, '')) LIKE '%' || term || '%'
									   OR lower(coalesce(source_url, '')) LIKE '%' || term || '%'
									   OR lower(coalesce(content, '')) LIKE '%' || term || '%'
								)
						  )
					)
					SELECT *
					FROM ranked
					WHERE relevance_score > 0
					ORDER BY relevance_score DESC, position ASC, source_url ASC
					LIMIT $8`,
					[
						userId,
						normalizedQuery,
						searchTerms,
						pageTypes,
						blockTypes,
						options?.sourceRoot?.trim() || null,
						options?.sourceUrl?.trim() || null,
						candidateLimit,
					],
				);

			const rows = result.rows.map(
				(row): StructuredBlockSearchResult => ({
					id: row.id,
					sourcePageId:
						row.source_page_id ?? undefined,
					sourceType: row.source_type,
					sourceRoot: row.source_root,
					sourceUrl: row.source_url,
					title:
						row.title ||
						row.source_url,
					pageType: row.page_type,
					blockType: row.block_type,
					sectionTitle: row.section_title,
					sectionPath:
						row.section_path ?? undefined,
					position: row.position,
					content: row.content,
					scrapedAt: row.scraped_at
						? row.scraped_at.toISOString()
						: undefined,
					relevanceScore:
						Number(row.relevance_score) || 0,
				}),
			);

			return this.limitStructuredResultsPerUrl(
				rows,
				3,
				limit,
			);
		} catch (error) {
			logger.error(
				"Error querying structured RAG blocks",
				{
					error,
					userId,
					query,
				},
			);
			return [];
		}
	}

	private async deleteVectorIds(
		index: any,
		ids: string[],
	): Promise<void> {
		if (ids.length === 0) {
			return;
		}

		for (const batch of this.chunkArray(ids, 1000)) {
			await pineconeCircuitBreaker.execute(
				async () => {
					await index.deleteMany(batch);
				},
			);
		}
	}

	private async deleteStaleChunksForUrl(
		userId: string,
		url: string,
		validIds: Set<string>,
	): Promise<void> {
		const index = this.getNamespaceIndex(userId);
		const prefix = `${this.sanitizeId(userId)}_${this.sanitizeId(url)}_chunk_`;
		const staleIds: string[] = [];
		let paginationToken: string | undefined;

		do {
			const listResponse = await index.listPaginated({
				prefix,
				paginationToken,
				limit: 100,
			});

			const ids =
				listResponse.vectors
					?.map((vector: any) => vector.id)
					.filter((id: any): id is string =>
						Boolean(id),
					) ?? [];

			for (const id of ids) {
				if (!validIds.has(id)) {
					staleIds.push(id);
				}
			}

			paginationToken =
				listResponse.pagination?.next ||
				undefined;
		} while (paginationToken);

		if (staleIds.length === 0) {
			return;
		}

		await this.deleteVectorIds(index, staleIds);
		logger.info("Deleted stale Pinecone chunks", {
			userId,
			url,
			staleChunks: staleIds.length,
		});
	}

	async upsertDocument(
		userId: string,
		url: string,
		title: string,
		content: string,
		metadata?: Record<string, any>,
	): Promise<void> {
		let chunks: Array<{
			text: string;
			chunkKey: string;
			metadata: Record<string, any>;
		}> = [];
		try {
			const index =
				this.getNamespaceIndex(userId);
			chunks = this.buildStructuredChunks(
				content,
				metadata,
			);
			if (chunks.length === 0) {
				throw new Error(
					"No usable text content found for this page",
				);
			}

			const vectors: PineconeRecord[] = [];
			const sharedMetadata = {
				...(metadata ?? {}),
			};
			delete sharedMetadata.contentBlocks;
			const providedPageType =
				typeof sharedMetadata.pageType === "string"
					? sharedMetadata.pageType
					: undefined;
			delete sharedMetadata.pageType;
			const pageType =
				typeof providedPageType === "string" &&
				providedPageType.trim()
					? providedPageType.trim()
					: this.detectPageType(url);
			const embeddings =
				await this.generateEmbeddings(
					chunks.map(
						(chunk) => chunk.text,
					),
				);

			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				const embedding =
					embeddings[i];

				const pineconeMetadata: PineconeMetadata &
					Record<string, any> = {
					url,
					title,
					description:
						sharedMetadata.description || "",
					scrapedAt: new Date().toISOString(),
					chunkIndex: i,
					totalChunks: chunks.length,
					content: chunk.text,
					userId,
					pageType,
					...sharedMetadata,
					...chunk.metadata,
				};

				const vectorId = this.buildVectorId(
					userId,
					url,
					chunk.chunkKey,
				);

				vectors.push({
					id: vectorId,
					values: embedding,
					metadata: pineconeMetadata,
				});
			}

			// Best-effort stale chunk cleanup — non-fatal so it never blocks the upsert
			try {
				await this.deleteStaleChunksForUrl(
					userId,
					url,
					new Set(vectors.map((vector) => vector.id)),
				);
			} catch (cleanupErr) {
				logger.warn("Failed to delete stale Pinecone chunks (non-fatal)", {
					url,
					userId,
					error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
				});
			}

			// Use circuit breaker and retry for Pinecone upsert
			await pineconeCircuitBreaker.execute(
				async () => {
					return await retryWithBackoff(
						async () => {
							return await index.upsert(vectors);
						},
						{
							name: "PineconeUpsert",
							maxRetries: 3,
						},
					);
				},
			);
			const sourcePageId =
				await this.upsertRagSourcePage(
				userId,
				url,
				title,
				chunks.length,
				metadata,
			);
			await this.upsertRagSourceBlocks(
				userId,
				sourcePageId,
				url,
				title,
				content,
				pageType,
				metadata,
			);
			logger.info(
				`Upserted ${chunks.length} chunks for URL: ${url} (user: ${userId})`,
			);
		} catch (error) {
			logger.error(
				"Error upserting document to Pinecone",
				{
					error:
						error instanceof Error
							? error.message
							: String(error),
					errorDetails: error,
					url,
					userId,
					chunksCount: chunks.length,
				},
			);
			throw error;
		}
	}

	async queryDocuments(
		userId: string,
		query: string,
		topK: number = 10,
		scoreThreshold: number = CHAT_RETRIEVAL_SCORE_THRESHOLD,
		options?: PineconeQueryOptions,
	): Promise<any[]> {
		try {
			const index =
				this.getNamespaceIndex(userId);
			const queryEmbedding =
				await this.generateEmbedding(query);
			const filter =
				this.buildQueryFilter(options);

			// Use circuit breaker for Pinecone query
			const queryResponse =
				await pineconeCircuitBreaker.execute(
					async () => {
						return await index.query({
							vector: queryEmbedding,
							topK,
							includeMetadata: true,
							...(filter
								? { filter }
								: {}),
						});
					},
				);

			const matches = queryResponse.matches || [];
			const passing = matches.filter(
				(m: any) => (m.score ?? 0) >= scoreThreshold,
			);
			logger.info("[RAG 3/6] Pinecone query", {
				userId,
				total: matches.length,
				passedThreshold: passing.length,
				belowThreshold: matches.length - passing.length,
				scoreThreshold,
				scores: matches.slice(0, 8).map((m: any) => (m.score ?? 0).toFixed(3)),
			});
			return passing;
		} catch (error) {
			const errMessage = error instanceof Error ? error.message : String(error);
			const errStatus = (error as any)?.status ?? (error as any)?.statusCode ?? "unknown";
			const errBody = (error as any)?.body ?? (error as any)?.data ?? (error as any)?.cause ?? null;
			logger.error("[RAG] Pinecone queryDocuments failed", {
				userId,
				message: errMessage,
				status: errStatus,
				body: errBody,
				hint: errStatus === 400
					? "HTTP 400 with sparseVector usually means the index metric is cosine, not dotproduct. Hybrid BM25 requires dotproduct metric."
					: undefined,
			});
			throw error;
		}
	}

	async deleteDocumentsByUrl(
		userId: string,
		url: string,
	): Promise<void> {
		try {
			const index =
				this.getNamespaceIndex(userId);

			let matchFn: (
				recordUrl?: string,
			) => boolean;
			let logLabel: string;

			if (url.startsWith("document://")) {
				logLabel = url;
				matchFn = (recordUrl?: string) =>
					recordUrl === url;
				logger.info(
					`Deleting document: ${logLabel} (user: ${userId})`,
				);
				await pool.query(
					`DELETE FROM rag_source_pages
					 WHERE user_id = $1 AND source_url = $2`,
					[userId, url],
				);
			} else {
				let baseUrl: string;
				try {
					const urlObj = new URL(url);
					baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
				} catch (error) {
					throw new Error(
						"Invalid URL provided for deletion",
					);
				}
				logLabel = baseUrl;
				matchFn = (recordUrl?: string) =>
					Boolean(
						recordUrl &&
						recordUrl.startsWith(baseUrl),
					);
				logger.info(
					`Deleting all documents from domain: ${logLabel} (user: ${userId})`,
				);
				await pool.query(
					`DELETE FROM rag_source_pages
					 WHERE user_id = $1
					   AND source_type = 'website'
					   AND (source_root = $2 OR source_url LIKE $3)`,
					[userId, baseUrl, `${baseUrl}%`],
				);
			}

			const matchingIds: string[] = [];
			await this.forEachUserRecord(
				userId,
				async (records) => {
					for (const [
						id,
						record,
					] of Object.entries(records)) {
						const recordUrl =
							(record.metadata?.url as
								| string
								| undefined) ?? undefined;
						if (matchFn(recordUrl)) {
							matchingIds.push(id);
						}
					}
				},
			);

			if (matchingIds.length === 0) {
				logger.info(
					`No documents found matching ${logLabel} (user: ${userId})`,
				);
				return;
			}

			await this.deleteVectorIds(
				index,
				matchingIds,
			);

			logger.info(
				`Deleted ${matchingIds.length} chunks from ${logLabel} (user: ${userId})`,
			);
		} catch (error) {
			logger.error(
				"Error deleting documents from Pinecone",
				{
					error,
					url,
					userId,
				},
			);
			throw error;
		}
	}

	async deletePageByExactUrl(
		userId: string,
		exactUrl: string,
	): Promise<void> {
		try {
			const namespace =
				this.getUserNamespace(userId);
			const index = this.getBaseIndex().namespace(
				namespace,
			);

			logger.info(
				`Deleting exact page: ${exactUrl} (user: ${userId})`,
			);

			await pool.query(
				`DELETE FROM rag_source_pages
				 WHERE user_id = $1 AND source_url = $2`,
				[userId, exactUrl],
			);

			const matchingIds: string[] = [];
			await this.forEachUserRecord(
				userId,
				async (records) => {
					for (const [
						id,
						record,
					] of Object.entries(records)) {
						const recordUrl =
							(record.metadata?.url as
								| string
								| undefined) ?? undefined;
						if (recordUrl === exactUrl) {
							matchingIds.push(id);
						}
					}
				},
			);

			if (matchingIds.length === 0) {
				logger.info(
					`No chunks found for exact page: ${exactUrl} (user: ${userId})`,
				);
				return;
			}

			await this.deleteVectorIds(
				index,
				matchingIds,
			);

			logger.info(
				`Deleted ${matchingIds.length} chunks for exact page: ${exactUrl} (user: ${userId})`,
			);
		} catch (error) {
			logger.error(
				"Error deleting page by exact URL from Pinecone",
				{
					error,
					exactUrl,
					userId,
				},
			);
			throw error;
		}
	}

	async deleteAllUserDocuments(
		userId: string,
	): Promise<void> {
		try {
			const namespace =
				this.getUserNamespace(userId);
			const index = this.getBaseIndex().namespace(
				namespace,
			);

			await index.deleteAll();
			await pool.query(
				`DELETE FROM rag_source_pages WHERE user_id = $1`,
				[userId],
			);

			logger.info(
				`Deleted all documents for user: ${userId}`,
			);
		} catch (error) {
			logger.error(
				"Error deleting all user documents from Pinecone",
				{
					error,
					userId,
				},
			);
			throw error;
		}
	}

	async getStats(userId?: string): Promise<any> {
		try {
			const index = this.getBaseIndex();

			if (userId) {
				const namespace =
					this.getUserNamespace(userId);
				const stats = await index
					.namespace(namespace)
					.describeIndexStats();
				return stats;
			}

			const stats =
				await index.describeIndexStats();
			return stats;
		} catch (error) {
			logger.error(
				"Error getting Pinecone stats",
				{ error, userId },
			);
			throw error;
		}
	}

	async checkSourceExists(
		userId: string,
		sourceUrl: string,
	): Promise<{
		exists: boolean;
		chunks: number;
		scrapedAt?: string;
	}> {
		try {
			const namespace =
				this.getUserNamespace(userId);
			const index = this.getBaseIndex().namespace(
				namespace,
			);

			// For websites, normalize to base domain for checking
			let urlToCheck = sourceUrl;
			if (!sourceUrl.startsWith("document://")) {
				try {
					const urlObj = new URL(sourceUrl);
					urlToCheck = `${urlObj.protocol}//${urlObj.hostname}`;
				} catch {
					// Keep original URL if parsing fails
				}
			}

			// Use the sanitized URL as prefix to list matching vectors
			const sanitizedUserId =
				this.sanitizeId(userId);
			const sanitizedUrl =
				this.sanitizeId(urlToCheck);
			const prefix = `${sanitizedUserId}_${sanitizedUrl}`;

			let matchingChunks = 0;
			let scrapedAt: string | undefined;
			let paginationToken: string | undefined;

			do {
				const listResponse =
					await index.listPaginated({
						prefix,
						paginationToken,
						limit: 100,
					});

				const ids =
					listResponse.vectors
						?.map((vector: any) => vector.id)
						.filter((id: any): id is string =>
							Boolean(id),
						) ?? [];

				if (ids.length > 0) {
					matchingChunks += ids.length;

					// Fetch first batch to get scrapedAt if we don't have it yet
					if (!scrapedAt) {
						const fetchResponse =
							await index.fetch([ids[0]]);
						const firstRecord = Object.values(
							fetchResponse.records ?? {},
						)[0] as
							| { metadata?: PineconeMetadata }
							| undefined;
						if (firstRecord?.metadata) {
							const metadata =
								firstRecord.metadata;
							scrapedAt = metadata.scrapedAt;
						}
					}
				}

				paginationToken =
					listResponse.pagination?.next ||
					undefined;
			} while (paginationToken);

			return {
				exists: matchingChunks > 0,
				chunks: matchingChunks,
				scrapedAt,
			};
		} catch (error) {
			logger.error(
				"Error checking if source exists",
				{
					error,
					userId,
					sourceUrl,
				},
			);
			throw error;
		}
	}

	async getAllUserSources(
		userId: string,
	): Promise<{
		documents: Array<{
			filename: string;
			url: string;
			fileType: string;
			uploadedAt: string;
			chunks: number;
		}>;
		websites: Array<{
			rootUrl: string;
			title: string;
			totalChunks: number;
			scrapedAt: string;
			pages: Array<{
				url: string;
				title: string;
				chunks: number;
				scrapedAt: string;
			}>;
		}>;
		totalChunks: number;
	}> {
		try {
			logger.info(
				`Fetching all sources for user: ${userId}`,
			);

			// Query postgres directly — far faster than paginating Pinecone
			const result = await pool.query(
				`SELECT source_type, source_root, source_url, title, chunks, scraped_at
				 FROM rag_source_pages
				 WHERE user_id = $1
				 ORDER BY scraped_at DESC NULLS LAST`,
				[userId],
			);

			const rows: Array<{
				source_type: string;
				source_root: string | null;
				source_url: string;
				title: string | null;
				chunks: number;
				scraped_at: Date | null;
			}> = result.rows;

			if (rows.length === 0) {
				return { documents: [], websites: [], totalChunks: 0 };
			}

			const documentMap = new Map<
				string,
				{
					url: string;
					title: string;
					uploadedAt: string;
					chunks: number;
				}
			>();

			const websiteMap = new Map<
				string,
				{
					rootUrl: string;
					title: string;
					scrapedAt: string;
					pagesMap: Map<
						string,
						{
							url: string;
							title: string;
							chunks: number;
							scrapedAt: string;
						}
					>;
				}
			>();

			for (const row of rows) {
				const scrapedAt = row.scraped_at
					? row.scraped_at.toISOString()
					: new Date().toISOString();

				if (row.source_type === "document") {
					documentMap.set(row.source_url, {
						url: row.source_url,
						title: row.title || row.source_url,
						uploadedAt: scrapedAt,
						chunks: row.chunks,
					});
				} else {
					const rootUrl = row.source_root || row.source_url;
					if (!websiteMap.has(rootUrl)) {
						websiteMap.set(rootUrl, {
							rootUrl,
							title: row.title || rootUrl,
							scrapedAt,
							pagesMap: new Map(),
						});
					}
					const website = websiteMap.get(rootUrl)!;
					website.pagesMap.set(row.source_url, {
						url: row.source_url,
						title: row.title || row.source_url,
						chunks: row.chunks,
						scrapedAt,
					});
				}
			}

			const documents: Array<{
				filename: string;
				url: string;
				fileType: string;
				uploadedAt: string;
				chunks: number;
			}> = [];

			let totalChunks = 0;

			for (const doc of documentMap.values()) {
				totalChunks += doc.chunks;
				documents.push({
					filename: doc.url.replace("document://", ""),
					url: doc.url,
					fileType: "unknown",
					uploadedAt: doc.uploadedAt,
					chunks: doc.chunks,
				});
			}

			const websites: Array<{
				rootUrl: string;
				title: string;
				totalChunks: number;
				scrapedAt: string;
				pages: Array<{
					url: string;
					title: string;
					chunks: number;
					scrapedAt: string;
				}>;
			}> = [];

			for (const website of websiteMap.values()) {
				const pages = Array.from(website.pagesMap.values()).sort(
					(a, b) =>
						new Date(a.scrapedAt).getTime() -
						new Date(b.scrapedAt).getTime(),
				);
				const websiteChunks = pages.reduce(
					(sum, p) => sum + p.chunks,
					0,
				);
				totalChunks += websiteChunks;
				websites.push({
					rootUrl: website.rootUrl,
					title: website.title,
					totalChunks: websiteChunks,
					scrapedAt: website.scrapedAt,
					pages,
				});
			}

			logger.info(
				`Found ${documents.length} documents and ${websites.length} websites (${websites.reduce((s, w) => s + w.pages.length, 0)} pages) for user: ${userId}`,
			);

			return {
				documents: documents.sort(
					(a, b) =>
						new Date(b.uploadedAt).getTime() -
						new Date(a.uploadedAt).getTime(),
				),
				websites: websites.sort(
					(a, b) =>
						new Date(b.scrapedAt).getTime() -
						new Date(a.scrapedAt).getTime(),
				),
				totalChunks,
			};
		} catch (error) {
			logger.error(
				"Error fetching user sources from Pinecone",
				{
					error,
					userId,
				},
			);
			throw error;
		}
	}

	async getScrapedWebsiteCount(
		userId: string,
	): Promise<number> {
		try {
			const sources =
				await this.getAllUserSources(userId);
			// Count total individual pages across all websites
			return sources.websites.reduce(
				(sum, w) => sum + w.pages.length,
				0,
			);
		} catch (error) {
			logger.error(
				"Error counting scraped websites",
				{ error, userId },
			);
			throw error;
		}
	}

	async getUploadedDocumentCount(
		userId: string,
	): Promise<number> {
		try {
			const sources =
				await this.getAllUserSources(userId);
			return sources.documents.length;
		} catch (error) {
			logger.error(
				"Error counting uploaded documents",
				{ error, userId },
			);
			throw error;
		}
	}

	async getScraperUsageStats(
		userId: string,
		planType: PlanType,
	): Promise<ScraperUsageStats> {
		const resolvedPlan =
			coercePlanType(planType);
		const pagesUsed =
			await this.getScrapedWebsiteCount(userId);
		const pagesLimit =
			await subscriptionService.getWebsitePagesLimitForPlan(
				resolvedPlan,
				PLAN_CAPABILITIES[resolvedPlan]
					.websitePagesLimit,
			);
		const pagesRemaining =
			pagesLimit === null
				? null
				: Math.max(0, pagesLimit - pagesUsed);

		return {
			planType: resolvedPlan,
			pagesUsed,
			pagesLimit,
			pagesRemaining,
			isAtLimit:
				pagesLimit === null
					? false
					: pagesUsed >= pagesLimit,
		};
	}

	async canUserScrape(
		userId: string,
		planType: PlanType,
	): Promise<boolean> {
		const usage = await this.getScraperUsageStats(
			userId,
			planType,
		);
		return !usage.isAtLimit;
	}

	async getDocumentUsageStats(
		userId: string,
		planType: PlanType,
	): Promise<DocumentUsageStats> {
		const resolvedPlan =
			coercePlanType(planType);
		const documentsUsed =
			await this.getUploadedDocumentCount(userId);
		const documentsLimit =
			DOCUMENT_LIMITS[resolvedPlan];
		const documentsRemaining =
			documentsLimit === null
				? null
				: Math.max(
						0,
						documentsLimit - documentsUsed,
				  );

		return {
			planType: resolvedPlan,
			documentsUsed,
			documentsLimit,
			documentsRemaining,
			isAtLimit:
				documentsLimit === null
					? false
					: documentsUsed >= documentsLimit,
		};
	}

	async canUserUploadDocuments(
		userId: string,
		planType: PlanType,
		newDocumentsCount: number = 1,
	): Promise<boolean> {
		const usage =
			await this.getDocumentUsageStats(
				userId,
				planType,
			);
		if (usage.documentsLimit === null) {
			return true;
		}
		return (
			usage.documentsUsed + newDocumentsCount <=
			usage.documentsLimit
		);
	}
}

export const pineconeService =
	new PineconeService();
