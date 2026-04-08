import {
	Pinecone,
	PineconeRecord,
} from "@pinecone-database/pinecone";
import crypto from "crypto";
import OpenAI from "openai";
import {
	coercePlanType,
	PlanType,
} from "../config/planConfig";
import { config } from "../config/env";
import pool from "../config/database";
import { redisCache } from "../config/redis";
import {
	DocumentUsageStats,
	DOCUMENT_LIMITS,
	PineconeMetadata,
	RagChunk,
	ScraperUsageStats,
} from "../types";
import {
	openAICircuitBreaker,
	pineconeCircuitBreaker,
} from "../utils/circuitBreaker";
import logger from "../utils/logger";
import {
	retryOnRateLimit,
	retryWithBackoff,
} from "../utils/retry";
import { chunkMarkdown, bm25SparseVector } from "./chunkingService";
import { cohereRerank } from "./rerankService";
import { scraperSourceService } from "./scraperSourceService";
import { subscriptionService } from "./subscriptionService";
import {
	buildPageTypeFilters,
	generateQueryVariations,
	stepBackRewrite,
} from "./queryService";

class PineconeService {
	private static readonly EMBEDDING_CONCURRENCY = 8;

	private static readonly RAG_SOURCE_UPSERT_CONCURRENCY = 12;

	private static readonly METADATA_TEXT_MAX_CHARS = 4000;

	private static readonly METADATA_PARENT_TEXT_MAX_CHARS = 8000;

	private static readonly METADATA_TITLE_MAX_CHARS = 300;

	private static readonly METADATA_DESCRIPTION_MAX_CHARS = 500;

	private static readonly METADATA_LABEL_MAX_CHARS = 200;

	private static guessPageType(url: string, title: string): string {
		let path = "";
		try {
			path = new URL(url).pathname.toLowerCase();
		} catch {
			path = url.toLowerCase();
		}
		const t = title.toLowerCase();
		if (path === "/" || path === "" || /\/(index|home)(\.html?)?$/.test(path)) return "home";
		if (/\/(contact|reach|get-in-touch)/.test(path) || /contact/.test(t)) return "contact";
		if (/\/(about|who-we-are|our-story|team|company)/.test(path)) return "about";
		if (/\/(case-stud|portfolio|work|project|client|success-stor|showcase)/.test(path)) return "case_study";
		if (/\/(service|solution|offering|what-we-do|capabilities)/.test(path)) return "service";
		if (/\/(blog|news|article|insight|post|update)/.test(path)) return "blog";
		if (/\/(pricing|price|plan|package|cost)/.test(path)) return "pricing";
		return "";
	}

	private sanitizeMetadataUpdate(
		metadata: Record<string, unknown>,
	): Record<string, string | number | boolean | string[]> {
		const sanitized: Record<
			string,
			string | number | boolean | string[]
		> = {};

		for (const [key, value] of Object.entries(metadata)) {
			if (value === undefined || value === null) {
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
			if (
				Array.isArray(value) &&
				value.every(
					(item) => typeof item === "string",
				)
			) {
				sanitized[key] = value;
			}
		}

		return sanitized;
	}

	private truncateMetadataString(
		value: unknown,
		maxChars: number,
	): string {
		if (typeof value !== "string") {
			return "";
		}

		const normalized = value.trim();
		if (normalized.length <= maxChars) {
			return normalized;
		}

		return normalized.slice(0, maxChars);
	}

	private pinecone: Pinecone;
	private openai: OpenAI;
	private indexName: string;
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
	}

	async ensureIndexExists(): Promise<void> {
		try {
			const indexes =
				await this.pinecone.listIndexes();
			const indexExists = indexes.indexes?.some(
				(index) => index.name === this.indexName,
			);

			if (!indexExists) {
				logger.info(
					`Creating Pinecone index: ${this.indexName}`,
				);
				await this.pinecone.createIndex({
					name: this.indexName,
					dimension: 1024, // Using 1024 dimensions for compatibility
					metric: config.PINECONE_HYBRID
						? "dotproduct"
						: "cosine",
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
		const index = this.pinecone
			.index(this.indexName)
			.namespace(namespace);
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

	async generateEmbedding(
		text: string,
	): Promise<number[]> {
		try {
			const normalized = text
				.trim()
				.toLowerCase()
				.replace(/\s+/g, " ");
			const digest = crypto
				.createHash("sha1")
				.update(normalized)
				.digest("hex");
			const cacheKey = `emb:${digest}`;
			const cached =
				await redisCache.get(cacheKey);
			if (cached) {
				return JSON.parse(cached) as number[];
			}

			// Use circuit breaker and retry logic for OpenAI embeddings API
			const response =
				await openAICircuitBreaker.execute(
					async () => {
						return await retryOnRateLimit(
							async () => {
								return await this.openai.embeddings.create(
									{
										model: config.OPENAI_MODEL,
										input: text,
										dimensions: 1024, // Specify 1024 dimensions to match Pinecone index
									},
								);
							},
						);
					},
				);
			const embedding =
				response.data[0].embedding;
			await redisCache.setex(
				cacheKey,
				300,
				JSON.stringify(embedding),
			);
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
		maxChunkSize: number = 8000,
	): string[] {
		const normalizedText = text
			.replace(/\s+/g, " ")
			.trim();
		if (!normalizedText) {
			return [];
		}

		const chunks: string[] = [];
		const sentenceMatches = normalizedText.match(
			/[^.!?]+[.!?]+/g,
		);
		const sentences =
			sentenceMatches && sentenceMatches.length > 0
				? sentenceMatches
				: [normalizedText];

		let currentChunk = "";

		for (const sentence of sentences) {
			if (
				(currentChunk + sentence).length >
				maxChunkSize
			) {
				if (currentChunk) {
					chunks.push(currentChunk.trim());
					currentChunk = sentence;
				} else {
					chunks.push(sentence.trim());
				}
			} else {
				currentChunk += sentence;
			}
		}

		if (currentChunk) {
			chunks.push(currentChunk.trim());
		}

		return chunks.filter(Boolean);
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

	private async mapWithConcurrency<T, R>(
		items: T[],
		concurrency: number,
		worker: (
			item: T,
			index: number,
		) => Promise<R>,
	): Promise<R[]> {
		if (items.length === 0) {
			return [];
		}

		const safeConcurrency = Math.max(
			1,
			Math.min(concurrency, items.length),
		);
		const results = new Array<R>(items.length);
		let nextIndex = 0;

		const runWorker = async (): Promise<void> => {
			for (;;) {
				const currentIndex = nextIndex;
				nextIndex += 1;
				if (currentIndex >= items.length) {
					return;
				}
				results[currentIndex] = await worker(
					items[currentIndex],
					currentIndex,
				);
			}
		};

		await Promise.all(
			Array.from(
				{ length: safeConcurrency },
				() => runWorker(),
			),
		);

		return results;
	}

	private buildVectorId(
		userId: string,
		url: string,
		chunkIndex: number,
		sourceType: "website" | "document" = "website",
		sourceKey: string = "",
	): string {
		const digest = crypto
			.createHash("sha256")
			.update(
				`${userId}|${sourceType}|${sourceKey || url}|${url}|${chunkIndex}`,
			)
			.digest("hex")
			.slice(0, 32);
		return `pc_${this.sanitizeId(userId)}_${digest}_${chunkIndex}`;
	}

	private async upsertRagSourcePage(
		userId: string,
		url: string,
		title: string,
		chunks: number,
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

		await pool.query(
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
				updated_at = CURRENT_TIMESTAMP`,
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
	}

	private async deleteVectorIds(
		index: any,
		ids: string[],
	): Promise<void> {
		if (ids.length === 0) {
			return;
		}

		for (const batch of this.chunkArray(ids, 1000)) {
			try {
				// Delete calls are idempotent for our use case; treat "not found"
				// as already-deleted instead of failing the whole background job.
				await index.deleteMany(batch);
			} catch (error) {
				if (this.isIgnorableDeleteError(error)) {
					logger.info(
						"Pinecone deleteMany skipped because vectors were already gone",
						{
							batchSize: batch.length,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
					continue;
				}

				throw error;
			}
		}
	}

	async deleteVectorsByIds(
		userId: string,
		ids: string[],
	): Promise<void> {
		if (ids.length === 0) {
			return;
		}
		const index = this.getNamespaceIndex(userId);
		await this.deleteVectorIds(index, ids);
	}

	async deleteHypeVectorsForSource(
		userId: string,
		sourceKey: string,
	): Promise<void> {
		const index = this.getNamespaceIndex(userId);
		const matchingIds: string[] = [];
		await this.forEachUserRecord(
			userId,
			async (records) => {
				for (const [id, record] of Object.entries(records)) {
					const metadata = record.metadata as
						| Record<string, unknown>
						| undefined;
					if (
						metadata?.isHype === true &&
						metadata?.sourceKey === sourceKey
					) {
						matchingIds.push(id);
					}
				}
			},
		);
		await this.deleteVectorIds(index, matchingIds);
		if (matchingIds.length > 0) {
			logger.info("Deleted old HyPE vectors", {
				userId,
				sourceKey,
				vectors: matchingIds.length,
			});
		}
	}

	private isIgnorableDeleteError(error: unknown): boolean {
		if (!error || typeof error !== "object") {
			return false;
		}

		const maybeError = error as {
			name?: unknown;
			message?: unknown;
			status?: unknown;
			statusCode?: unknown;
		};
		const name = typeof maybeError.name === "string" ? maybeError.name : "";
		const message =
			typeof maybeError.message === "string"
				? maybeError.message
				: "";
		const status =
			typeof maybeError.status === "number"
				? maybeError.status
				: typeof maybeError.statusCode === "number"
					? maybeError.statusCode
					: null;

		return (
			name === "PineconeNotFoundError" ||
			status === 404 ||
			message.includes("HTTP status 404")
		);
	}

	private async deleteStaleChunksForUrls(
		userId: string,
		validIdsByUrl: Map<string, Set<string>>,
	): Promise<void> {
		if (validIdsByUrl.size === 0) {
			return;
		}

		const index = this.getNamespaceIndex(userId);
		const targetUrls = new Set(validIdsByUrl.keys());
		const staleIds: string[] = [];
		const staleCountByUrl = new Map<
			string,
			number
		>();

		await this.forEachUserRecord(
			userId,
			async (records) => {
				for (const [id, record] of Object.entries(records)) {
					const recordUrl =
						(record.metadata?.url as string | undefined) ?? "";
					if (
						!targetUrls.has(recordUrl)
					) {
						continue;
					}

					const validIds =
						validIdsByUrl.get(recordUrl);
					if (validIds?.has(id)) {
						continue;
					}

					staleIds.push(id);
					staleCountByUrl.set(
						recordUrl,
						(staleCountByUrl.get(recordUrl) ?? 0) + 1,
					);
				}
			},
		);

		if (staleIds.length === 0) {
			return;
		}

		await this.deleteVectorIds(index, staleIds);
		logger.info("Deleted stale Pinecone chunks", {
			userId,
			targetUrls: targetUrls.size,
			staleChunks: staleIds.length,
			stalePages: staleCountByUrl.size,
		});
	}

	async upsertDocument(
		userId: string,
		url: string,
		title: string,
		content: string,
		metadata?: Record<string, any>,
	): Promise<void> {
		try {
			const pairs = await chunkMarkdown(content, title);
			if (pairs.length === 0) {
				throw new Error(
					"No usable text content found for this page",
				);
			}

			const sourceType = url.startsWith("document://")
				? "document"
				: "website";
			const sourceKey =
				sourceType === "document"
					? url
					: String(metadata?.sourceRoot || url);
			const ragChunks: RagChunk[] = pairs.map(
				(pair, index) => ({
					userId,
					url,
					pageTitle: title,
					childText: pair.childText,
					parentText: pair.parentText,
					chunkIndex: index,
					sourceType,
					sourceKey,
				}),
			);

			await this.upsertChunks(userId, ragChunks, {
				description:
					metadata?.description || "",
				sourceRoot:
					metadata?.sourceRoot || url,
				sourceRootTitle:
					metadata?.sourceRootTitle ||
					title ||
					url,
				scrapedAt:
					metadata?.scrapedAt ||
					metadata?.uploadedAt ||
					new Date().toISOString(),
				uploadedAt: metadata?.uploadedAt,
				fileType: metadata?.fileType,
			});
			logger.info(
				`Upserted ${pairs.length} chunks for URL: ${url} (user: ${userId})`,
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
				},
			);
			throw error;
		}
	}

	async upsertChunks(
		userId: string,
		chunks: RagChunk[],
		extraMetadata: Record<string, any> = {},
		onStageProgress?: (progress: {
			stage:
				| "pinecone_upsert_started"
				| "pinecone_embeddings_prepared"
				| "pinecone_stale_chunk_cleanup_completed"
				| "pinecone_upsert_completed";
			percent: number;
			label: string;
		}) => Promise<void> | void,
	): Promise<void> {
		if (chunks.length === 0) {
			return;
		}

		const startedAt = Date.now();
		const index = this.getNamespaceIndex(userId);
		const uniquePages = new Set(
			chunks.map((chunk) => chunk.url),
		).size;
		logger.info("pinecone: upsert pipeline started", {
			userId,
			chunks: chunks.length,
			uniquePages,
		});
		await onStageProgress?.({
			stage: "pinecone_upsert_started",
			percent: 55,
			label: "Pinecone upsert started",
		});
		const pageCounts = new Map<
			string,
			{ title: string; chunks: number }
		>();
		const validIdsByUrl = new Map<
			string,
			Set<string>
		>();
		const embeddingStartedAt = Date.now();
		const preparedVectors =
			await this.mapWithConcurrency(
				chunks,
				PineconeService.EMBEDDING_CONCURRENCY,
				async (chunk) => {
					const text =
						chunk.childText.trim();
					if (!text) {
						return null;
					}

					const embedding =
						await this.generateEmbedding(text);
					const vectorId =
						this.buildVectorId(
							userId,
							chunk.url,
							chunk.chunkIndex,
							chunk.sourceType,
							chunk.sourceKey,
						);
					chunk.vectorId = vectorId;

					const metadata: PineconeMetadata &
						Record<string, any> = {
						url: chunk.url,
						title: this.truncateMetadataString(
							chunk.pageTitle,
							PineconeService.METADATA_TITLE_MAX_CHARS,
						),
						description:
							this.truncateMetadataString(
								extraMetadata.description || "",
								PineconeService.METADATA_DESCRIPTION_MAX_CHARS,
							),
						scrapedAt:
							extraMetadata.scrapedAt ||
							new Date().toISOString(),
						chunkIndex: chunk.chunkIndex,
						totalChunks: 0,
						userId,
						text: this.truncateMetadataString(
							text,
							PineconeService.METADATA_TEXT_MAX_CHARS,
						),
						parentText:
							this.truncateMetadataString(
								chunk.parentText,
								PineconeService.METADATA_PARENT_TEXT_MAX_CHARS,
							),
						sourceType: chunk.sourceType,
						sourceKey: chunk.sourceKey,
						sourceRoot:
							extraMetadata.sourceRoot ||
							chunk.sourceKey,
						sourceRootTitle:
							this.truncateMetadataString(
								extraMetadata.sourceRootTitle ||
									chunk.pageTitle,
								PineconeService.METADATA_TITLE_MAX_CHARS,
							),
						pageType:
							this.truncateMetadataString(
								chunk.pageType ||
									PineconeService.guessPageType(chunk.url, chunk.pageTitle),
								PineconeService.METADATA_LABEL_MAX_CHARS,
							),
						clientName:
							this.truncateMetadataString(
								chunk.clientName,
								PineconeService.METADATA_LABEL_MAX_CHARS,
							),
						industry:
							this.truncateMetadataString(
								chunk.industry,
								PineconeService.METADATA_LABEL_MAX_CHARS,
							),
						services:
							this.truncateMetadataString(
								chunk.services,
								500,
							),
						isHype: chunk.isHype || undefined,
						hypeParent:
							this.truncateMetadataString(
								chunk.hypeParent,
								PineconeService.METADATA_PARENT_TEXT_MAX_CHARS,
							),
						fileType:
							this.truncateMetadataString(
								extraMetadata.fileType,
								120,
							),
						uploadedAt: this.truncateMetadataString(
							extraMetadata.uploadedAt,
							64,
						),
					};

					const metadataBytes = Buffer.byteLength(
						JSON.stringify(metadata),
						"utf8",
					);
					if (metadataBytes > 35000) {
						logger.warn(
							"Pinecone metadata payload is near the size limit",
							{
								userId,
								url: chunk.url,
								vectorId,
								metadataBytes,
							},
						);
					}

					const sparse =
						config.PINECONE_HYBRID
							? bm25SparseVector(text)
							: null;

					const vector: PineconeRecord = {
						id: vectorId,
						values: embedding,
						metadata,
					};
					if (
						sparse &&
						sparse.indices.length > 0
					) {
						(vector as any).sparseValues =
							sparse;
					}

					return {
						chunk,
						vector,
					};
				},
			);
		logger.info("pinecone: embeddings prepared", {
			userId,
			chunks: chunks.length,
			durationMs: Date.now() - embeddingStartedAt,
		});
		await onStageProgress?.({
			stage: "pinecone_embeddings_prepared",
			percent: 70,
			label: "Pinecone embeddings prepared",
		});

		const vectors: PineconeRecord[] = [];
		for (const prepared of preparedVectors) {
			if (!prepared) {
				continue;
			}

			vectors.push(prepared.vector);

			const pageEntry =
				pageCounts.get(
					prepared.chunk.url,
				) ?? {
					title: prepared.chunk.pageTitle,
					chunks: 0,
				};
			pageEntry.chunks += 1;
			pageCounts.set(
				prepared.chunk.url,
				pageEntry,
			);

			const validIds =
				validIdsByUrl.get(
					prepared.chunk.url,
				) ?? new Set<string>();
			validIds.add(prepared.vector.id);
			validIdsByUrl.set(
				prepared.chunk.url,
				validIds,
			);
		}

		if (vectors.length === 0) {
			return;
		}

		for (const vector of vectors) {
			const count =
				pageCounts.get(
					String(vector.metadata?.url || ""),
				)?.chunks ?? vectors.length;
			(vector.metadata as Record<string, unknown>).totalChunks =
				count;
		}

		if (!extraMetadata.skipStaleCleanup) {
			const staleCleanupStartedAt = Date.now();
			await this.deleteStaleChunksForUrls(
				userId,
				validIdsByUrl,
			);
			logger.info("pinecone: stale chunk cleanup completed", {
				userId,
				uniquePages: validIdsByUrl.size,
				durationMs: Date.now() - staleCleanupStartedAt,
			});
			await onStageProgress?.({
				stage: "pinecone_stale_chunk_cleanup_completed",
				percent: 80,
				label: "Pinecone stale chunk cleanup completed",
			});
		}

		const vectorBatches = this.chunkArray(
			vectors,
			100,
		);
		const upsertStartedAt = Date.now();
		for (const batch of vectorBatches) {
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
		logger.info("pinecone: vector batches upserted", {
			userId,
			vectors: vectors.length,
			batches: vectorBatches.length,
			durationMs: Date.now() - upsertStartedAt,
		});

		if (!extraMetadata.skipSourcePageSync) {
			const sourcePageStartedAt = Date.now();
			await this.mapWithConcurrency(
				Array.from(pageCounts.entries()),
				PineconeService.RAG_SOURCE_UPSERT_CONCURRENCY,
				async ([url, pageInfo]) =>
					this.upsertRagSourcePage(
						userId,
						url,
						pageInfo.title,
						pageInfo.chunks,
						extraMetadata,
					),
			);
			logger.info("pinecone: rag_source_pages synced", {
				userId,
				sourcePages: pageCounts.size,
				durationMs: Date.now() - sourcePageStartedAt,
			});
		}
		logger.info("pinecone: upsert pipeline completed", {
			userId,
			chunks: chunks.length,
			vectors: vectors.length,
			uniquePages,
			durationMs: Date.now() - startedAt,
		});
		await onStageProgress?.({
			stage: "pinecone_upsert_completed",
			percent: 90,
			label: "Pinecone upsert pipeline completed",
		});
	}

	async updateVectorMetadata(
		userId: string,
		vectorId: string,
		metadata: Record<string, unknown>,
	): Promise<void> {
		if (!vectorId) {
			return;
		}
		const sanitized =
			this.sanitizeMetadataUpdate(metadata);
		if (Object.keys(sanitized).length === 0) {
			return;
		}

		const index = this.getNamespaceIndex(userId);
		await pineconeCircuitBreaker.execute(
			async () => {
				await (index as any).update({
					id: vectorId,
					metadata: sanitized,
				});
			},
		);
	}

	async queryDocuments(
		userId: string,
		query: string,
		topK: number = 10,
		options?: {
			history?: Array<{
				role: string;
				content: string;
			}>;
		},
	): Promise<any[]> {
		try {
			const index = this.getNamespaceIndex(userId);
			const effectiveTopK = topK > 0 ? topK : 10;
			const rewrittenQuery = await stepBackRewrite(
				query,
				options?.history,
			);
			const pageTypes =
				(await scraperSourceService.isMetadataReady(
					userId,
				))
					? buildPageTypeFilters(query)
					: [];
			const inputs = [
				rewrittenQuery,
				...(rewrittenQuery !== query ? [query] : []),
				...generateQueryVariations(query),
			];
			const embeddings =
				await this.mapWithConcurrency(
					inputs,
					PineconeService.EMBEDDING_CONCURRENCY,
					async (input) =>
						this.generateEmbedding(input),
				);

			const queryOnce = async (
				queryText: string,
				embedding: number[],
				withFilter: boolean,
				withSparse: boolean,
			): Promise<any[]> => {
				const payload: Record<string, unknown> = {
					vector: embedding,
					topK: Math.max(effectiveTopK * 3, effectiveTopK),
					includeMetadata: true,
				};
				if (withFilter && pageTypes.length > 0) {
					payload.filter = {
						pageType: { $in: pageTypes },
					};
				}
				if (withSparse && config.PINECONE_HYBRID) {
					const sparse = bm25SparseVector(queryText);
					if (sparse.indices.length > 0) {
						(payload as any).sparseVector =
							sparse;
					}
				}
				try {
					const response =
						await pineconeCircuitBreaker.execute(
							async () =>
								await (index as any).query(
									payload,
								),
						);
					return response.matches || [];
				} catch (error) {
					if (!(payload as any).sparseVector) {
						throw error;
					}
					logger.warn(
						"Pinecone hybrid query failed, retrying dense-only",
						{ error, userId },
					);
					delete (payload as any).sparseVector;
					const response =
						await pineconeCircuitBreaker.execute(
							async () =>
								await (index as any).query(
									payload,
								),
						);
					return response.matches || [];
				}
			};

			const resultLists: any[][] = [];
			for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
				const matches = await queryOnce(
					inputs[inputIndex],
					embeddings[inputIndex],
					true,
					inputIndex === 0,
				);
				if (matches.length > 0) {
					resultLists.push(matches);
				}
			}

			let matches = this.rrfMerge(resultLists);
			if (matches.length === 0 && pageTypes.length > 0) {
				matches = await queryOnce(
					rewrittenQuery,
					embeddings[0],
					false,
					false,
				);
			}

			logger.info("pinecone: retrieval query completed", {
				userId,
				query,
				rewrittenQuery,
				pageTypes,
				lists: resultLists.length,
				matches: matches.length,
			});

			return await cohereRerank(
				query,
				matches,
				effectiveTopK,
			);
		} catch (error) {
			logger.error("Error querying Pinecone", {
				error,
				userId,
			});
			throw error;
		}
	}

	private rrfMerge(resultLists: any[][]): any[] {
		const rankConstant = 60;
		const merged = new Map<
			string,
			{ match: any; score: number }
		>();

		for (const list of resultLists) {
			for (let rank = 0; rank < list.length; rank += 1) {
				const match = list[rank];
				const id =
					String(match?.id || "") ||
					`${match?.metadata?.url || ""}:${match?.metadata?.chunkIndex ?? rank}`;
				if (!id) continue;
				const current =
					merged.get(id) ?? {
						match,
						score: 0,
					};
				current.score +=
					1 / (rankConstant + rank + 1);
				if (
					typeof match.score === "number" &&
					match.score >
						(Number(current.match?.score) || 0)
				) {
					current.match = match;
				}
				merged.set(id, current);
			}
		}

		return Array.from(merged.values())
			.sort((a, b) => b.score - a.score)
			.map(({ match, score }) => ({
				...match,
				rrfScore: score,
			}));
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
				await scraperSourceService.deleteSource(
					userId,
					baseUrl,
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
			const index = this.pinecone
				.index(this.indexName)
				.namespace(namespace);

			logger.info(
				`Deleting exact page: ${exactUrl} (user: ${userId})`,
			);

			await pool.query(
				`DELETE FROM rag_source_pages
				 WHERE user_id = $1 AND source_url = $2`,
				[userId, exactUrl],
			);
			await scraperSourceService.deletePage(
				userId,
				exactUrl,
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
			const index = this.pinecone
				.index(this.indexName)
				.namespace(namespace);

			try {
				await index.deleteAll();
			} catch (error) {
				if (!this.isIgnorableDeleteError(error)) {
					throw error;
				}

				logger.info(
					"Pinecone deleteAll skipped because the namespace was already empty",
					{
						userId,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}
			await pool.query(
				`DELETE FROM rag_source_pages WHERE user_id = $1`,
				[userId],
			);
			await scraperSourceService.deleteAll(userId);

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
			const index = this.pinecone.index(
				this.indexName,
			);

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
			const index = this.pinecone
				.index(this.indexName)
				.namespace(namespace);

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
						?.map((vector) => vector.id)
						.filter((id): id is string =>
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
						)[0];
						if (firstRecord?.metadata) {
							const metadata =
								firstRecord.metadata as unknown as PineconeMetadata;
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
			scrapedPages?: number;
			indexedPages?: number;
			pages: Array<{
				url: string;
				title: string;
				chunks: number;
				scrapedAt: string;
				indexed?: boolean;
			}>;
		}>;
		totalChunks: number;
	}> {
		try {
			logger.info(
				`Fetching all sources for user: ${userId}`,
			);

			const documentMap = new Map<
				string,
				{
					url: string;
					title: string;
					uploadedAt: string;
					fileType?: string;
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

			await this.forEachUserRecord(
				userId,
				async (records) => {
					for (const record of Object.values(
						records,
					)) {
						const metadata = record.metadata as
							| (PineconeMetadata & {
									fileType?: string;
									uploadedAt?: string;
									sourceRoot?: string;
									sourceRootTitle?: string;
							  })
							| undefined;

						const sourceUrl = metadata?.url;
						if (!sourceUrl) {
							continue;
						}

						const isDocument =
							sourceUrl.startsWith("document://");

						if (isDocument) {
							if (!documentMap.has(sourceUrl)) {
								documentMap.set(sourceUrl, {
									url: sourceUrl,
									title:
										metadata?.title || sourceUrl,
									uploadedAt:
										metadata?.scrapedAt ||
										metadata?.uploadedAt ||
										new Date().toISOString(),
									fileType: metadata?.fileType,
									chunks: 0,
								});
							}
							const doc =
								documentMap.get(sourceUrl);
							if (doc) {
								doc.chunks += 1;
							}
						} else {
							// Group website pages by sourceRoot
							const rootUrl =
								metadata?.sourceRoot || sourceUrl;
							const rootTitle =
								metadata?.sourceRootTitle ||
								metadata?.title ||
								rootUrl;

							if (!websiteMap.has(rootUrl)) {
								websiteMap.set(rootUrl, {
									rootUrl,
									title: rootTitle,
									scrapedAt:
										metadata?.scrapedAt ||
										new Date().toISOString(),
									pagesMap: new Map(),
								});
							}

							const website =
								websiteMap.get(rootUrl)!;

							// Track individual page entry
							if (
								!website.pagesMap.has(sourceUrl)
							) {
								website.pagesMap.set(sourceUrl, {
									url: sourceUrl,
									title:
										metadata?.title || sourceUrl,
									chunks: 0,
									scrapedAt:
										metadata?.scrapedAt ||
										new Date().toISOString(),
								});
							}

							const page =
								website.pagesMap.get(sourceUrl);
							if (page) {
								page.chunks += 1;
							}
						}
					}
				},
			);

			if (
				documentMap.size === 0 &&
				websiteMap.size === 0
			) {
				return {
					documents: [],
					websites: [],
					totalChunks: 0,
				};
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
					filename: doc.url.replace(
						"document://",
						"",
					),
					url: doc.url,
					fileType: doc.fileType || "unknown",
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
				const pages = Array.from(
					website.pagesMap.values(),
				).sort(
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

	async getAllUserSourcesFromDB(
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
			const result = await pool.query<{
				source_type: string;
				source_root: string | null;
				source_url: string;
				title: string | null;
				chunks: number;
				scraped_at: Date;
			}>(
				`SELECT source_type, source_root, source_url, title, chunks, scraped_at
				 FROM rag_source_pages
				 WHERE user_id = $1
				 ORDER BY scraped_at DESC`,
				[userId],
			);

			const documentMap = new Map<
				string,
				{
					filename: string;
					url: string;
					fileType: string;
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

			for (const row of result.rows) {
				const scrapedAt =
					row.scraped_at instanceof Date
						? row.scraped_at.toISOString()
						: new Date().toISOString();

				if (row.source_type === "document") {
					if (!documentMap.has(row.source_url)) {
						documentMap.set(row.source_url, {
							filename: row.source_url.replace(
								"document://",
								"",
							),
							url: row.source_url,
							fileType: "unknown",
							uploadedAt: scrapedAt,
							chunks: row.chunks,
						});
					}
				} else {
					const rootUrl =
						row.source_root || row.source_url;

					if (!websiteMap.has(rootUrl)) {
						websiteMap.set(rootUrl, {
							rootUrl,
							title: row.title || rootUrl,
							scrapedAt,
							pagesMap: new Map(),
						});
					}

					const website =
						websiteMap.get(rootUrl)!;
					if (
						!website.pagesMap.has(row.source_url)
					) {
						website.pagesMap.set(row.source_url, {
							url: row.source_url,
							title:
								row.title || row.source_url,
							chunks: row.chunks,
							scrapedAt,
						});
					}
				}
			}

			const documents = Array.from(
				documentMap.values(),
			).sort(
				(a, b) =>
					new Date(b.uploadedAt).getTime() -
					new Date(a.uploadedAt).getTime(),
			);

			const websites = Array.from(
				websiteMap.values(),
			)
				.map((website) => {
					const pages = Array.from(
						website.pagesMap.values(),
					).sort(
						(a, b) =>
							new Date(a.scrapedAt).getTime() -
							new Date(b.scrapedAt).getTime(),
					);
					const websiteChunks = pages.reduce(
						(sum, p) => sum + p.chunks,
						0,
					);
					return {
						rootUrl: website.rootUrl,
						title: website.title,
						totalChunks: websiteChunks,
						scrapedAt: website.scrapedAt,
						scrapedPages: pages.length,
						indexedPages: pages.length,
						pages,
					};
				})
				.sort(
					(a, b) =>
						new Date(b.scrapedAt).getTime() -
						new Date(a.scrapedAt).getTime(),
				);

			const trackedWebsites =
				await scraperSourceService.getWebsiteSources(
					userId,
				);
			const trackedRoots = new Set(
				trackedWebsites.map(
					(website) => website.rootUrl,
				),
			);
			const mergedWebsites = [
				...trackedWebsites,
				...websites.filter(
					(website) =>
						!trackedRoots.has(website.rootUrl),
				),
			].sort(
				(a, b) =>
					new Date(b.scrapedAt).getTime() -
					new Date(a.scrapedAt).getTime(),
			);

			const mergedWebsiteChunks =
				mergedWebsites.reduce(
					(sum, website) =>
						sum + website.totalChunks,
					0,
				);

			return {
				documents,
				websites: mergedWebsites,
				totalChunks:
					documents.reduce(
						(sum, doc) => sum + doc.chunks,
						0,
					) + mergedWebsiteChunks,
			};
		} catch (error) {
			logger.error(
				"Error fetching user sources from DB",
				{ error, userId },
			);
			throw error;
		}
	}

	async getScrapedWebsiteCount(
		userId: string,
	): Promise<number> {
		try {
			const trackedPages =
				await scraperSourceService.getScrapedPageCount(
					userId,
				);
			if (trackedPages > 0) {
				return trackedPages;
			}
			const sources =
				await this.getAllUserSourcesFromDB(userId);
			return sources.websites.reduce(
				(sum, website) =>
					sum + website.pages.length,
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
				await this.getAllUserSourcesFromDB(userId);
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
