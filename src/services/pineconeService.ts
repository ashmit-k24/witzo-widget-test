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
import { memCache } from "../utils/memCache";
import {
	DocumentUsageStats,
	DOCUMENT_LIMITS,
	PineconeMetadata,
	ScrapedPageContentBlock,
	ScraperUsageStats,
	StructuredBlockSearchResult,
	StructuredQueryPlan,
} from "../types";
import {
	CHUNK_MAX_WORDS,
	CHUNK_OVERLAP_WORDS,
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
import { buildSparseVector } from "../utils/bm25";
import {
	isUrlUnderSourceRoot,
	normalizeScrapeUrl,
} from "../utils/scrapeUrl";
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
	topic?: StructuredQueryPlan["topic"];
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

type PersistedStructuredChunk = {
	id: number;
	text: string;
	chunkKey: string;
	metadata: Record<string, any>;
};

const EMBEDDING_BATCH_SIZE = 16;
const EMBEDDING_BATCH_CONCURRENCY = 2;
const STRUCTURED_PARAGRAPH_MIN_CHARS = 80;
const STRUCTURED_NONPARAGRAPH_MIN_CHARS = 40;
const STRUCTURED_MERGE_TARGET_CHARS = Math.max(
	config.SCRAPER_CHUNK_WORDS * 8,
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
	private hybridEnabled: boolean;
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
		this.hybridEnabled = config.PINECONE_HYBRID;
		this.indexHost = config.PINECONE_HOST
			? config.PINECONE_HOST.replace(
					/^https?:\/\//i,
					"",
			  ).replace(/\/+$/, "")
			: undefined;
		if (
			this.indexHost &&
			!this.indexHost
				.toLowerCase()
				.startsWith(
					`${this.indexName.toLowerCase()}-`,
				)
		) {
			logger.warn(
				`Ignoring stale PINECONE_HOST for index "${this.indexName}" because it points to a different host: ${this.indexHost}`,
			);
			this.indexHost = undefined;
		}
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
			const expectedMetric = this.hybridEnabled
				? "dotproduct"
				: "cosine";

			if (!existingIndex) {
				logger.info(
					`Creating Pinecone index: ${this.indexName}`,
				);
				await this.pinecone.createIndex({
					name: this.indexName,
					dimension:
						config.OPENAI_EMBEDDING_DIMENSIONS,
					metric: expectedMetric,
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
			} else if (
				existingIndex.metric &&
				existingIndex.metric !== expectedMetric
			) {
				throw new Error(
					`Pinecone index "${this.indexName}" uses metric ${existingIndex.metric}, but the current configuration requires ${expectedMetric}. Hybrid BM25 requires dotproduct; dense-only search requires cosine.`,
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
				Promise.resolve(memCache.get(entry.cacheKey)),
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
					memCache.setex(item.cacheKey, 300, JSON.stringify(item.embedding));
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
		maxChunkSize: number = CHUNK_MAX_WORDS,
		overlapWords: number = CHUNK_OVERLAP_WORDS,
	): string[] {
		const normalizedText = text
			.replace(/\s+/g, " ")
			.trim();
		if (!normalizedText) {
			return [];
		}

		const words = normalizedText.split(/\s+/);
		if (words.length === 0) {
			return [];
		}

		const step = Math.max(
			1,
			maxChunkSize - overlapWords,
		);
		const chunks: string[] = [];

		for (let start = 0; start < words.length; start += step) {
			const end = Math.min(
				start + maxChunkSize,
				words.length,
			);
			chunks.push(words.slice(start, end).join(" "));
			if (end === words.length) {
				break;
			}
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
				const chunkPosition =
					structuredChunks.length;
				structuredChunks.push({
					text: blockChunks[subChunkIndex],
					chunkKey: `${block.position ?? blockIndex}_${subChunkIndex}`,
					metadata: {
						blockType: block.blockType,
						sectionTitle,
						sectionPath: block.sectionPath,
						position: chunkPosition,
						blockPosition:
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

	private mapStructuredBlockRows(
		rows: StructuredBlockRow[],
	): StructuredBlockSearchResult[] {
		return rows.map(
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

	private parseMetadataInteger(
		value: unknown,
	): number | undefined {
		if (
			typeof value === "number" &&
			Number.isInteger(value) &&
			value > 0
		) {
			return value;
		}

		if (typeof value === "string") {
			const normalized = value.trim();
			if (!normalized) {
				return undefined;
			}
			const parsed = Number(normalized);
			if (
				Number.isInteger(parsed) &&
				parsed > 0
			) {
				return parsed;
			}
		}

		return undefined;
	}

	private sanitizePineconeMetadata(
		metadata: Record<string, any>,
	): Record<string, string | number | boolean | string[]> {
		const sanitized: Record<
			string,
			string | number | boolean | string[]
		> = {};

		for (const [key, value] of Object.entries(metadata)) {
			if (
				value === undefined ||
				value === null
			) {
				continue;
			}

			if (
				typeof value === "string" ||
				typeof value === "number" ||
				typeof value === "boolean"
			) {
				sanitized[key] = value;
				continue;
			}

			if (Array.isArray(value)) {
				const normalized = value
					.map((item) => {
						if (
							item === undefined ||
							item === null
						) {
							return "";
						}
						if (
							typeof item === "string" ||
							typeof item === "number" ||
							typeof item === "boolean"
						) {
							return String(item).trim();
						}
						return "";
					})
					.filter(Boolean);
				if (normalized.length > 0) {
					sanitized[key] = normalized;
				}
			}
		}

		return sanitized;
	}

	private async upsertVectorsInBatches(
		index: any,
		vectors: PineconeRecord[],
	): Promise<void> {
		const batches = this.chunkArray(
			vectors,
			Math.max(1, config.PINECONE_UPSERT_BATCH_SIZE),
		);

		for (const batch of batches) {
			await pineconeCircuitBreaker.execute(
				async () => {
					return await retryWithBackoff(
						async () => {
							return await index.upsert(batch);
						},
						{
							name: "PineconeUpsert",
							maxRetries: 3,
						},
					);
				},
			);
		}
	}

	private urlMatchesSourceRoot(
		candidateUrl: string | undefined,
		sourceRoot: string,
	): boolean {
		if (!candidateUrl) {
			return false;
		}
		return isUrlUnderSourceRoot(
			candidateUrl,
			sourceRoot,
		);
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

	private buildContextualEmbeddingText(
		title: string,
		pageType: string,
		sectionTitle: string | undefined | null,
		chunkText: string,
		url?: string,
		description?: string,
	): string {
		// Derive a human-readable slug from the URL path for extra context
		// e.g. "our-work-healthcare" from ".../our-work-healthcare.html"
		const urlSlug = url
			? (url.split("/").pop() ?? "")
					.replace(/\.[^.]+$/, "")
					.replace(/[-_]/g, " ")
					.trim()
			: "";

		const parts: string[] = [];
		parts.push(`Page: ${title}`);
		if (pageType) parts.push(`Type: ${pageType}`);
		if (urlSlug && urlSlug !== title.toLowerCase()) parts.push(`Topic: ${urlSlug}`);
		if (description) parts.push(`Summary: ${description}`);
		if (sectionTitle) parts.push(`Section: ${sectionTitle}`);

		return `[${parts.join(" | ")}]\n\n${chunkText}`;
	}

	private async upsertRagSourcePage(
		userId: string,
		url: string,
		title: string,
		pageContent: string,
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
				(user_id, source_type, source_root, source_url, title, page_content, chunks, scraped_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 ON CONFLICT (user_id, source_url)
			 DO UPDATE SET
				source_type = EXCLUDED.source_type,
				source_root = EXCLUDED.source_root,
				title = EXCLUDED.title,
				page_content = EXCLUDED.page_content,
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
				pageContent,
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
		pageType: string,
		chunks: Array<{
			text: string;
			chunkKey: string;
			metadata: Record<string, any>;
		}>,
		metadata?: Record<string, any>,
	): Promise<PersistedStructuredChunk[]> {
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

		await pool.query(
			`DELETE FROM rag_source_blocks
			 WHERE user_id = $1 AND source_url = $2`,
			[userId, url],
		);

		if (chunks.length === 0) {
			return [];
		}

		const persistedChunks: PersistedStructuredChunk[] =
			[];

		for (const batch of this.chunkArray(chunks, 100)) {
			const valueClauses: string[] = [];
			const values: Array<
				string | number | Date | string[] | null
			> = [];
			let parameterIndex = 1;

			for (const chunk of batch) {
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
					chunk.metadata.blockType ?? "paragraph",
					chunk.metadata.sectionTitle ?? null,
					chunk.metadata.sectionPath ?? null,
					typeof chunk.metadata.position === "number"
						? chunk.metadata.position
						: 0,
					chunk.text,
					scrapedAt,
				);
				parameterIndex += 13;
			}

			const insertResult =
				await pool.query<{
					id: number;
					position: number;
				}>(
				`INSERT INTO rag_source_blocks
					(source_page_id, user_id, source_type, source_root, source_url, title, page_type, block_type, section_title, section_path, position, content, scraped_at)
				 VALUES ${valueClauses.join(", ")}
				 RETURNING id, position`,
				values,
			);
			const idByPosition = new Map(
				insertResult.rows.map((row) => [
					row.position,
					row.id,
				]),
			);
			for (const chunk of batch) {
				const position =
					typeof chunk.metadata.position ===
					"number"
						? chunk.metadata.position
						: 0;
				const blockId =
					idByPosition.get(position);
				if (!blockId) {
					throw new Error(
						`Failed to persist structured block id for ${url} at position ${position}`,
					);
				}
				persistedChunks.push({
					id: blockId,
					text: chunk.text,
					chunkKey: chunk.chunkKey,
					metadata: chunk.metadata,
				});
			}
		}

		return persistedChunks;
	}

	private async getStructuredBlockRowsByIds(
		userId: string,
		blockIds: number[],
	): Promise<StructuredBlockRow[]> {
		if (blockIds.length === 0) {
			return [];
		}

		const result =
			await pool.query<StructuredBlockRow>(
				`SELECT
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
					0::numeric AS relevance_score
				 FROM rag_source_blocks
				 WHERE user_id = $1
				   AND id = ANY($2::int[])`,
				[userId, blockIds],
			);

		return result.rows;
	}

	private async fetchSectionNeighbors(
		userId: string,
		sourcePageId: number,
		sectionTitle: string | null,
		position: number,
	): Promise<string> {
		try {
			const result = await pool.query<{
				position: number;
				content: string;
			}>(
				`SELECT position, content
				 FROM rag_source_blocks
				 WHERE user_id = $1
				   AND source_page_id = $2
				   AND ($3::text IS NULL AND section_title IS NULL OR section_title = $3::text)
				   AND position BETWEEN $4 AND $5
				 ORDER BY position ASC`,
				[userId, sourcePageId, sectionTitle, position - 1, position + 1],
			);
			if (result.rows.length <= 1) {
				// No neighbors found — return empty so caller uses block.content directly
				return "";
			}
			return result.rows.map((r) => r.content).join("\n\n");
		} catch {
			return "";
		}
	}

	async hydrateMatches(
		userId: string,
		matches: any[],
	): Promise<any[]> {
		if (matches.length === 0) {
			return matches;
		}

		const blockIds = Array.from(
			new Set(
				matches
					.flatMap((match) => {
						const metadata =
							match?.metadata ?? {};
						const ids: number[] = [];
						const blockId =
							this.parseMetadataInteger(
								metadata.blockId,
							);
						if (blockId) {
							ids.push(blockId);
						}
						const sourceBlockId =
							this.parseMetadataInteger(
								metadata.sourceBlockId,
							);
						if (sourceBlockId) {
							ids.push(sourceBlockId);
						}
						return ids;
					})
					.filter((value) =>
						Number.isInteger(value) &&
						value > 0,
					),
			),
		);

		if (blockIds.length === 0) {
			return matches;
		}

		const rows =
			await this.getStructuredBlockRowsByIds(
				userId,
				blockIds,
			);
		const rowMap = new Map(
			this.mapStructuredBlockRows(rows).map(
				(row) => [row.id, row],
			),
		);

		return Promise.all(
			matches.map(async (match) => {
				const metadata =
					match?.metadata ?? {};
				const contentBlockId =
					this.parseMetadataInteger(
						metadata.blockId,
					);
				const sourceBlockId =
					this.parseMetadataInteger(
						metadata.sourceBlockId,
					);
				const block =
					(contentBlockId &&
						rowMap.get(contentBlockId)) ||
					(sourceBlockId &&
						rowMap.get(sourceBlockId));
				if (!block) {
					return match;
				}

				const hydratedMetadata = {
					...metadata,
					url:
						metadata.url ??
						block.sourceUrl,
					title:
						metadata.title ??
						block.title,
					pageType:
						metadata.pageType ??
						block.pageType ??
						undefined,
					blockType:
						metadata.blockType ??
						block.blockType ??
						undefined,
					sectionTitle:
						metadata.sectionTitle ??
						block.sectionTitle ??
						undefined,
					sectionPath:
						metadata.sectionPath ??
						block.sectionPath ??
						undefined,
					position:
						metadata.position ??
						block.position,
					sourcePageId:
						metadata.sourcePageId ??
						block.sourcePageId ??
						undefined,
				} as Record<string, any>;

				// Parent-document retrieval: expand content with adjacent blocks from same section
				let expandedContent = "";
				if (
					block.sourcePageId != null &&
					typeof block.position === "number"
				) {
					expandedContent = await this.fetchSectionNeighbors(
						userId,
						block.sourcePageId,
						block.sectionTitle ?? null,
						block.position,
					);
				}
				hydratedMetadata.content =
					expandedContent || block.content;
				if (metadata.isHype === true) {
					hydratedMetadata.sourceContent =
						block.content;
				}

				return {
					...match,
					metadata: hydratedMetadata,
				};
			}),
		);
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
			const topic = options?.topic ?? "general";
			const maxPerUrl =
				topic === "contact"
					? 8
					: topic === "services"
						? 6
						: 3;
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
									WHEN $9 = 'contact' AND lower(coalesce(source_url, '')) LIKE '%contact%' THEN 6
									WHEN $9 = 'contact' AND lower(coalesce(source_url, '')) LIKE '%about%' THEN 2.5
									ELSE 0
								END +
								CASE
									WHEN $9 = 'contact' AND lower(coalesce(title, '')) LIKE '%contact%' THEN 6
									WHEN $9 = 'contact' AND lower(coalesce(title, '')) LIKE '%about%' THEN 2.5
									ELSE 0
								END +
								CASE
									WHEN $9 = 'contact' AND block_type = 'contact' THEN 3.5
									ELSE 0
								END +
								CASE
									WHEN $9 = 'contact' AND lower(coalesce(section_title, '')) LIKE '%address%' THEN 5
									WHEN $9 = 'contact' AND lower(coalesce(section_title, '')) LIKE '%office%' THEN 3.5
									WHEN $9 = 'contact' AND lower(coalesce(section_title, '')) LIKE '%location%' THEN 3.5
									WHEN $9 = 'contact' AND lower(coalesce(section_title, '')) LIKE '%contact%' THEN 2
									ELSE 0
								END +
								CASE
									WHEN $9 = 'contact' AND lower(coalesce(content, '')) LIKE '%address:%' THEN 5
									WHEN $9 = 'contact' AND lower(coalesce(content, '')) LIKE '%office%' THEN 3
									WHEN $9 = 'contact' AND lower(coalesce(content, '')) LIKE '%business bay%' THEN 3
									WHEN $9 = 'contact' AND lower(coalesce(content, '')) LIKE '%koramangala%' THEN 3
									WHEN $9 = 'contact' AND lower(coalesce(content, '')) LIKE '%toronto%' THEN 3
									ELSE 0
								END +
								CASE
									WHEN $9 = 'services' AND page_type = 'services' THEN 5
									WHEN $9 = 'services' AND page_type = 'about' THEN 2
									ELSE 0
								END +
								CASE
									WHEN $9 = 'services' AND lower(coalesce(source_url, '')) LIKE '%service%' THEN 4
									WHEN $9 = 'services' AND lower(coalesce(source_url, '')) LIKE '%solution%' THEN 3
									WHEN $9 = 'services' AND lower(coalesce(source_url, '')) LIKE '%product%' THEN 3
									ELSE 0
								END +
								CASE
									WHEN $9 = 'services' AND block_type = 'summary' THEN 3.5
									WHEN $9 = 'services' AND block_type = 'list' THEN 3
									WHEN $9 = 'services' AND block_type = 'paragraph' THEN 1
									ELSE 0
								END +
								CASE
									WHEN $9 = 'services' AND lower(coalesce(section_title, '')) LIKE '%service%' THEN 4
									WHEN $9 = 'services' AND lower(coalesce(section_title, '')) LIKE '%solution%' THEN 3
									WHEN $9 = 'services' AND lower(coalesce(section_title, '')) LIKE '%offering%' THEN 3
									WHEN $9 = 'services' AND lower(coalesce(section_title, '')) LIKE '%capabilit%' THEN 3
									ELSE 0
								END +
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
						topic,
					],
				);

			const rows = this.mapStructuredBlockRows(
				result.rows,
			);

			return this.limitStructuredResultsPerUrl(
				rows,
				maxPerUrl,
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

	/**
	 * HyPE (Hypothetical Prompt Embeddings) — generate synthetic questions per chunk,
	 * embed them, and upsert as separate vectors so that question-like queries
	 * match content chunks more reliably.
	 *
	 * Runs fire-and-forget (non-blocking) so it never delays the main upsert.
	 * Failures are swallowed with a warning log — HyPE is purely additive.
	 */
	private async generateAndUpsertHypeChunks(
		index: any,
		userId: string,
		url: string,
		chunks: Array<{
			text: string;
			vectorId: string;
			blockId?: number;
			sourcePageId?: number;
			title?: string;
			pageType?: string;
			blockType?: string;
			sectionTitle?: string;
			sectionPath?: string[];
		}>,
	): Promise<void> {
		const hypeQuestionsPerChunk =
			config.HYPE_QUESTIONS_PER_CHUNK;
		const hypeMaxChunks = config.HYPE_MAX_CHUNKS;
		if (
			hypeQuestionsPerChunk <= 0 ||
			hypeMaxChunks <= 0
		) {
			return;
		}

		try {
			const limited = chunks.slice(0, hypeMaxChunks);
			const hypeVectors: PineconeRecord[] = [];

			for (const chunk of limited) {
				let questions: string[] = [];
				try {
					const resp =
						await openAICircuitBreaker.execute(
							async () =>
								await this.openai.chat.completions.create({
									model: config.OPENAI_CHAT_MODEL,
									temperature: 0,
									max_tokens: 200,
									messages: [
										{
											role: "system",
											content:
												"Generate exactly " +
												hypeQuestionsPerChunk +
												" distinct questions that are directly answered by the provided text. Output only the questions, one per line, no numbering or extra text.",
										},
										{
											role: "user",
											content: `Text:\n${chunk.text.slice(0, 6000)}`,
										},
									],
								}),
						);
					const raw =
						resp.choices[0]?.message?.content ?? "";
					questions = raw
						.split("\n")
						.map((q) => q.trim())
						.filter((q) => q.length > 10)
						.slice(0, hypeQuestionsPerChunk);
				} catch (qErr) {
					logger.debug(
						"[HyPE] Question generation failed for chunk, skipping",
						{
							url,
							chunkId: chunk.vectorId,
							error:
								qErr instanceof Error
									? qErr.message
									: String(qErr),
						},
					);
					continue;
				}

				if (questions.length === 0) continue;

				const embeddings =
					await this.generateEmbeddings(
						questions,
					);

				for (
					let qi = 0;
					qi < questions.length;
					qi++
				) {
					const q = questions[qi];
					const emb = embeddings[qi];
					if (!emb) continue;
					const sparseVector =
						this.hybridEnabled
							? buildSparseVector(q)
							: { indices: [], values: [] };

					const hypeMetadata: PineconeMetadata &
						Record<string, any> = {
						url,
						title: chunk.title ?? "",
						scrapedAt: new Date().toISOString(),
						chunkIndex: qi,
						totalChunks: questions.length,
						userId,
						sourceChunkId: chunk.vectorId,
						sourceBlockId: chunk.blockId,
						sourcePageId: chunk.sourcePageId,
						pageType: chunk.pageType,
						blockType: chunk.blockType,
						sectionTitle: chunk.sectionTitle,
						sectionPath: chunk.sectionPath,
						chunkType: "hype",
						isHype: true,
					};

					const hypeId = `${chunk.vectorId}__hype_${qi}`;
					hypeVectors.push({
						id: hypeId,
						values: emb,
						...(this.hybridEnabled &&
						sparseVector.values.length > 0
							? {
									sparseValues:
										sparseVector,
							  }
							: {}),
						metadata: hypeMetadata,
					});
				}
			}

			if (hypeVectors.length === 0) return;

			await this.upsertVectorsInBatches(
				index,
				hypeVectors,
			);
			logger.info(
				`[HyPE] Upserted ${hypeVectors.length} hypothetical question vectors for ${url}`,
			);
		} catch (err) {
			logger.warn("[HyPE] Background generation failed (non-fatal)", {
				url,
				userId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
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
			const structuredFacts = Array.isArray(
				sharedMetadata.structuredFacts,
			)
				? sharedMetadata.structuredFacts
				: [];
			delete sharedMetadata.structuredFacts;
			if (structuredFacts.length > 0) {
				sharedMetadata.structuredFactTypes = Array.from(
					new Set(
						structuredFacts
							.map((fact) =>
								typeof fact?.type === "string"
									? fact.type.trim()
									: "",
							)
							.filter(Boolean),
					),
				).slice(0, 12);
				sharedMetadata.structuredFactValues =
					structuredFacts
						.map((fact) =>
							typeof fact?.value === "string"
								? fact.value
										.trim()
										.slice(0, 160)
								: "",
						)
						.filter(Boolean)
						.slice(0, 12);
			}
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
			const sourcePageId =
				await this.upsertRagSourcePage(
					userId,
					url,
					title,
					content,
					chunks.length,
					metadata,
				);
			const persistedChunks =
				await this.upsertRagSourceBlocks(
					userId,
					sourcePageId,
					url,
					title,
					pageType,
					chunks,
					metadata,
				);
			const embeddings =
				await this.generateEmbeddings(
					persistedChunks.map((chunk) =>
						this.buildContextualEmbeddingText(
							title,
							pageType,
							typeof chunk.metadata.sectionTitle === "string"
								? chunk.metadata.sectionTitle
								: undefined,
							chunk.text,
							url,
							typeof sharedMetadata.description === "string"
								? sharedMetadata.description
								: undefined,
						),
					),
				);

			for (let i = 0; i < persistedChunks.length; i++) {
				const chunk = persistedChunks[i];
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
					totalChunks: persistedChunks.length,
					userId,
					blockId: chunk.id,
					sourcePageId,
					pageType,
					// Store chunk text so hydrateMatches falls back to this
					// if the DB block is missing (stale blockId after re-scrape).
					content: chunk.text.slice(0, 8000),
					...sharedMetadata,
					...chunk.metadata,
				};
				const sanitizedMetadata =
					this.sanitizePineconeMetadata(
						pineconeMetadata,
					);

				const vectorId = this.buildVectorId(
					userId,
					url,
					chunk.chunkKey,
				);
				const sparseVector =
					this.hybridEnabled
						? buildSparseVector(chunk.text)
						: { indices: [], values: [] };

				vectors.push({
					id: vectorId,
					values: embedding,
					...(this.hybridEnabled &&
					sparseVector.values.length > 0
						? {
								sparseValues:
									sparseVector,
						  }
						: {}),
					metadata: sanitizedMetadata,
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

			await this.upsertVectorsInBatches(
				index,
				vectors,
			);

			// HyPE: generate hypothetical questions in the background (non-blocking)
			void this.generateAndUpsertHypeChunks(
				index,
				userId,
				url,
				persistedChunks.map((c, i) => ({
					text: c.text,
					vectorId: vectors[i].id,
					blockId: c.id,
					sourcePageId,
					title,
					pageType,
					blockType:
						typeof c.metadata.blockType ===
						"string"
							? c.metadata.blockType
							: undefined,
					sectionTitle:
						typeof c.metadata.sectionTitle ===
						"string"
							? c.metadata.sectionTitle
							: undefined,
					sectionPath: Array.isArray(
						c.metadata.sectionPath,
					)
						? c.metadata.sectionPath
						: undefined,
				})),
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
			const [queryEmbedding, querySparse] =
				await Promise.all([
					this.generateEmbedding(query),
					Promise.resolve(
						this.hybridEnabled
							? buildSparseVector(query)
							: { indices: [], values: [] },
					),
				]);
			const filter =
				this.buildQueryFilter(options);

			// Use circuit breaker for Pinecone query
			const queryResponse =
				await pineconeCircuitBreaker.execute(
					async () => {
						return await index.query({
							vector: queryEmbedding,
							...(this.hybridEnabled &&
							querySparse.values.length > 0
								? {
										sparseVector: querySparse,
								  }
								: {}),
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
			return await this.hydrateMatches(
				userId,
				passing,
			);
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
				sourceRoot?: string,
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
				const sourceRoot =
					await normalizeScrapeUrl(url);
				logLabel = sourceRoot;
				matchFn = (
					recordUrl?: string,
					recordSourceRoot?: string,
				) =>
					recordSourceRoot === sourceRoot ||
					this.urlMatchesSourceRoot(
						recordUrl,
						sourceRoot,
					);
				logger.info(
					`Deleting website source: ${logLabel} (user: ${userId})`,
				);
				await pool.query(
					`DELETE FROM rag_source_pages
					 WHERE user_id = $1
					   AND source_type = 'website'
					   AND (source_root = $2 OR source_url = $2 OR source_url LIKE $3)`,
					[userId, sourceRoot, `${sourceRoot}%`],
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
						const recordSourceRoot =
							(record.metadata?.sourceRoot as
								| string
								| undefined) ?? undefined;
						if (
							matchFn(
								recordUrl,
								recordSourceRoot,
							)
						) {
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
