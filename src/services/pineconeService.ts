import {
	Pinecone,
	PineconeRecord,
} from "@pinecone-database/pinecone";
import OpenAI from "openai";
import { config } from "../config/env";
import {
	PineconeMetadata,
	ScraperUsageStats,
	SCRAPER_PAGE_LIMITS,
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

class PineconeService {
	private pinecone: Pinecone;
	private openai: OpenAI;
	private indexName: string;

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
			return response.data[0].embedding;
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
		const chunks: string[] = [];
		const sentences = text.match(
			/[^.!?]+[.!?]+/g,
		) || [text];

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

		return chunks;
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
		const namespace =
			this.getUserNamespace(userId);
		const index = this.pinecone
			.index(this.indexName)
			.namespace(namespace);
		let paginationToken: string | undefined;

		do {
			const listResponse =
				await index.listPaginated({
					paginationToken,
					limit: 1000,
				});
			const ids =
				listResponse.vectors
					?.map((vector) => vector.id)
					.filter((id): id is string =>
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

	async upsertDocument(
		userId: string,
		url: string,
		title: string,
		content: string,
		metadata?: Record<string, any>,
	): Promise<void> {
		let chunks: string[] = [];
		try {
			const namespace =
				this.getUserNamespace(userId);
			const index = this.pinecone
				.index(this.indexName)
				.namespace(namespace);
			chunks = this.chunkText(content);

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
					...metadata,
				};

				const sanitizedUrl = this.sanitizeId(url);
				const vectorId = `${this.sanitizeId(userId)}_${sanitizedUrl}_chunk_${i}`;

				vectors.push({
					id: vectorId,
					values: embedding,
					metadata: pineconeMetadata,
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
	): Promise<any[]> {
		try {
			const namespace =
				this.getUserNamespace(userId);
			const index = this.pinecone
				.index(this.indexName)
				.namespace(namespace);
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

			return queryResponse.matches || [];
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
			const namespace =
				this.getUserNamespace(userId);
			const index = this.pinecone
				.index(this.indexName)
				.namespace(namespace);

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

			for (const batch of this.chunkArray(
				matchingIds,
				1000,
			)) {
				await pineconeCircuitBreaker.execute(
					async () => {
						await index.deleteMany(batch);
					},
				);
			}

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
			url: string;
			title: string;
			scrapedAt: string;
			chunks: number;
		}>;
		totalChunks: number;
	}> {
		try {
			logger.info(
				`Fetching all sources for user: ${userId}`,
			);

			const sourceMap = new Map<
				string,
				{
					url: string;
					title: string;
					uploadedAt: string;
					fileType?: string;
					chunks: number;
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
							  })
							| undefined;

						const sourceUrl = metadata?.url;
						if (!sourceUrl) {
							continue;
						}

						if (!sourceMap.has(sourceUrl)) {
							sourceMap.set(sourceUrl, {
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

						const source =
							sourceMap.get(sourceUrl);
						if (source) {
							source.chunks += 1;
						}
					}
				},
			);

			if (sourceMap.size === 0) {
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
			const websites: Array<{
				url: string;
				title: string;
				scrapedAt: string;
				chunks: number;
			}> = [];
			let totalChunks = 0;

			for (const source of sourceMap.values()) {
				totalChunks += source.chunks;
				if (
					source.url.startsWith("document://")
				) {
					documents.push({
						filename: source.url.replace(
							"document://",
							"",
						),
						url: source.url,
						fileType:
							source.fileType || "unknown",
						uploadedAt: source.uploadedAt,
						chunks: source.chunks,
					});
				} else {
					websites.push({
						url: source.url,
						title: source.title,
						scrapedAt: source.uploadedAt,
						chunks: source.chunks,
					});
				}
			}

			logger.info(
				`Found ${documents.length} documents and ${websites.length} websites for user: ${userId}`,
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
			// Count unique website URLs (not documents)
			return sources.websites.length;
		} catch (error) {
			logger.error(
				"Error counting scraped websites",
				{ error, userId },
			);
			throw error;
		}
	}

	async getScraperUsageStats(
		userId: string,
		planType: "free" | "basic",
	): Promise<ScraperUsageStats> {
		const pagesUsed =
			await this.getScrapedWebsiteCount(userId);
		const pagesLimit =
			SCRAPER_PAGE_LIMITS[planType];
		const pagesRemaining = Math.max(
			0,
			pagesLimit - pagesUsed,
		);

		return {
			planType,
			pagesUsed,
			pagesLimit,
			pagesRemaining,
			isAtLimit: pagesUsed >= pagesLimit,
		};
	}

	async canUserScrape(
		userId: string,
		planType: "free" | "basic",
	): Promise<boolean> {
		const usage = await this.getScraperUsageStats(
			userId,
			planType,
		);
		return !usage.isAtLimit;
	}
}

export const pineconeService =
	new PineconeService();
