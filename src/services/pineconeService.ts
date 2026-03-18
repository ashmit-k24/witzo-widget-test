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
	ScraperUsageStats,
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

class PineconeService {
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
		chunkIndex: number,
	): string {
		const sanitizedUrl = this.sanitizeId(url);
		return `${this.sanitizeId(userId)}_${sanitizedUrl}_chunk_${chunkIndex}`;
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
		let chunks: string[] = [];
		try {
			const index =
				this.getNamespaceIndex(userId);
			chunks = this.chunkText(content);
			if (chunks.length === 0) {
				throw new Error(
					"No usable text content found for this page",
				);
			}

			const vectors: PineconeRecord[] = [];

			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				const embedding =
					await this.generateEmbedding(chunk);

				const pineconeMetadata: PineconeMetadata &
					Record<string, any> = {
					url,
					title,
					description:
						metadata?.description || "",
					scrapedAt: new Date().toISOString(),
					chunkIndex: i,
					totalChunks: chunks.length,
					content: chunk,
					userId,
					pageType: this.detectPageType(url),
					...metadata,
				};

				const vectorId = this.buildVectorId(
					userId,
					url,
					i,
				);

				vectors.push({
					id: vectorId,
					values: embedding,
					metadata: pineconeMetadata,
				});
			}

			await this.deleteStaleChunksForUrl(
				userId,
				url,
				new Set(vectors.map((vector) => vector.id)),
			);

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
			await this.upsertRagSourcePage(
				userId,
				url,
				title,
				chunks.length,
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
	): Promise<any[]> {
		try {
			const index =
				this.getNamespaceIndex(userId);
			const queryEmbedding =
				await this.generateEmbedding(query);

			// Use circuit breaker for Pinecone query
			const queryResponse =
				await pineconeCircuitBreaker.execute(
					async () => {
						return await index.query({
							vector: queryEmbedding,
							topK,
							includeMetadata: true,
						});
					},
				);

			const matches = queryResponse.matches || [];
			// Filter out low-relevance chunks
			return matches.filter(
				(m: any) => (m.score ?? 0) >= scoreThreshold,
			);
		} catch (error) {
			logger.error("Error querying Pinecone", {
				error,
				userId,
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
