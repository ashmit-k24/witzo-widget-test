import { Pinecone } from "@pinecone-database/pinecone";
import OpenAI from "openai";
import { config } from "../config/env";
import { PineconeMetadata } from "../types";
import logger from "../utils/logger";

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
               const indexes = await this.pinecone.listIndexes();
               const indexExists = indexes.indexes?.some((index) => index.name === this.indexName);

               if (!indexExists) {
                    logger.info(`Creating Pinecone index: ${this.indexName}`);
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
                    logger.info(`Pinecone index created: ${this.indexName}`);

                    // Wait for index to be ready
                    await new Promise((resolve) => setTimeout(resolve, 10000));
               }
          } catch (error) {
               logger.error("Error ensuring Pinecone index exists", { error });
               throw error;
          }
     }

     private getUserNamespace(userId: string): string {
          return `user_${userId}`;
     }

     private sanitizeId(text: string): string {
          // Replace special characters with underscores and remove consecutive underscores
          return text
               .replace(/[^a-zA-Z0-9-_]/g, '_')
               .replace(/_+/g, '_')
               .replace(/^_|_$/g, '');
     }

     async generateEmbedding(text: string): Promise<number[]> {
          try {
               const response = await this.openai.embeddings.create({
                    model: config.OPENAI_MODEL,
                    input: text,
                    dimensions: 1024, // Specify 1024 dimensions to match Pinecone index
               });
               return response.data[0].embedding;
          } catch (error) {
               logger.error("Error generating embedding", { error });
               throw error;
          }
     }

     chunkText(text: string, maxChunkSize: number = 8000): string[] {
          const chunks: string[] = [];
          const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

          let currentChunk = "";

          for (const sentence of sentences) {
               if ((currentChunk + sentence).length > maxChunkSize) {
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

     async upsertDocument(userId: string, url: string, title: string, content: string, metadata?: Record<string, any>): Promise<void> {
          let chunks: string[] = [];
          try {
               const namespace = this.getUserNamespace(userId);
               const index = this.pinecone.index(this.indexName).namespace(namespace);
               chunks = this.chunkText(content);

               const vectors = [];

               for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    const embedding = await this.generateEmbedding(chunk);

                    const pineconeMetadata: PineconeMetadata & Record<string, any> = {
                         url,
                         title,
                         description: metadata?.description || "",
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

               await index.upsert(vectors);
               logger.info(`Upserted ${chunks.length} chunks for URL: ${url} (user: ${userId})`);
          } catch (error) {
               logger.error("Error upserting document to Pinecone", {
                    error: error instanceof Error ? error.message : String(error),
                    errorDetails: error,
                    url,
                    userId,
                    chunksCount: chunks.length,
               });
               throw error;
          }
     }

     async queryDocuments(userId: string, query: string, topK: number = 10): Promise<any[]> {
          try {
               const namespace = this.getUserNamespace(userId);
               const index = this.pinecone.index(this.indexName).namespace(namespace);
               const queryEmbedding = await this.generateEmbedding(query);

               const queryResponse = await index.query({
                    vector: queryEmbedding,
                    topK,
                    includeMetadata: true,
               });

               return queryResponse.matches || [];
          } catch (error) {
               logger.error("Error querying Pinecone", { error, userId });
               throw error;
          }
     }

     async deleteDocumentsByUrl(userId: string, url: string): Promise<void> {
          try {
               const namespace = this.getUserNamespace(userId);
               const index = this.pinecone.index(this.indexName).namespace(namespace);

               // Extract base domain from URL (e.g., https://www.webomindapps.com)
               const urlObj = new URL(url);
               const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;

               logger.info(`Deleting all documents from domain: ${baseUrl} (user: ${userId})`);

               // Use a dummy vector to list all vectors (Pinecone requires a vector for query)
               const dummyEmbedding = await this.generateEmbedding("delete query");

               // Fetch ALL vectors from the namespace (we'll filter by URL)
               const queryResponse = await index.query({
                    vector: dummyEmbedding,
                    topK: 10000, // Maximum limit
                    includeMetadata: true,
               });

               if (!queryResponse.matches || queryResponse.matches.length === 0) {
                    logger.info(`No documents found in namespace for user: ${userId}`);
                    return;
               }

               // Filter vectors that match the base URL (all pages from same domain)
               const matchingIds: string[] = [];
               for (const match of queryResponse.matches) {
                    if (match.metadata && match.metadata.url) {
                         const vectorUrl = match.metadata.url as string;
                         // Check if the vector's URL starts with the base URL
                         if (vectorUrl.startsWith(baseUrl)) {
                              matchingIds.push(match.id);
                         }
                    }
               }

               if (matchingIds.length === 0) {
                    logger.info(`No documents found matching base URL: ${baseUrl} (user: ${userId})`);
                    return;
               }

               // Delete by IDs in batches of 1000 (Pinecone limit)
               const batchSize = 1000;
               for (let i = 0; i < matchingIds.length; i += batchSize) {
                    const batch = matchingIds.slice(i, i + batchSize);
                    await index.deleteMany(batch);
               }

               logger.info(`Deleted ${matchingIds.length} chunks from domain ${baseUrl} (user: ${userId})`);
          } catch (error) {
               logger.error("Error deleting documents from Pinecone", { error, url, userId });
               throw error;
          }
     }

     async deleteAllUserDocuments(userId: string): Promise<void> {
          try {
               const namespace = this.getUserNamespace(userId);
               const index = this.pinecone.index(this.indexName).namespace(namespace);

               await index.deleteAll();

               logger.info(`Deleted all documents for user: ${userId}`);
          } catch (error) {
               logger.error("Error deleting all user documents from Pinecone", { error, userId });
               throw error;
          }
     }

     async getStats(userId?: string): Promise<any> {
          try {
               const index = this.pinecone.index(this.indexName);

               if (userId) {
                    const namespace = this.getUserNamespace(userId);
                    const stats = await index.namespace(namespace).describeIndexStats();
                    return stats;
               }

               const stats = await index.describeIndexStats();
               return stats;
          } catch (error) {
               logger.error("Error getting Pinecone stats", { error, userId });
               throw error;
          }
     }
}

export const pineconeService = new PineconeService();
