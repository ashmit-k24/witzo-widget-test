import { Request, Response } from "express";
import { pineconeService } from "../services/pineconeService";
import { scraperService } from "../services/scraperService";
import { ScrapeRequest } from "../types";
import logger from "../utils/logger";

export const scrapeWebsite = async (req: Request, res: Response): Promise<void> => {
     try {
          const { url, maxDepth = 3, maxPages = 100 } = req.body as ScrapeRequest;
          const userId = (req as any).user?.id;

          if (!userId) {
               res.status(401).json({
                    success: false,
                    message: "User not authenticated",
               });
               return;
          }

          if (!url) {
               res.status(400).json({
                    success: false,
                    message: "URL is required",
               });
               return;
          }

          logger.info(`Starting scrape for URL: ${url}`, {
               maxDepth,
               maxPages,
               userId,
          });

          const result = await scraperService.scrapeWebsite(userId, url, {
               maxDepth,
               maxPages,
          });

          res.status(result.success ? 200 : 500).json({
               success: result.success,
               message: result.message,
               data: {
                    totalPages: result.totalPages,
                    scrapedPages: result.pages.map((page) => ({
                         url: page.url,
                         title: page.title,
                         contentLength: page.content.length,
                    })),
               },
          });
     } catch (error) {
          logger.error("Error in scrapeWebsite controller", { error });
          res.status(500).json({
               success: false,
               message: "Internal server error while scraping website",
               error: error instanceof Error ? error.message : "Unknown error",
          });
     }
};

export const queryDocuments = async (req: Request, res: Response): Promise<void> => {
     try {
          const { query, topK = 10 } = req.body;
          const userId = (req as any).user?.userId;

          if (!userId) {
               res.status(401).json({
                    success: false,
                    message: "User not authenticated",
               });
               return;
          }

          if (!query) {
               res.status(400).json({
                    success: false,
                    message: "Query is required",
               });
               return;
          }

          logger.info(`Querying documents with: ${query}`, {
               topK,
               userId,
          });

          const results = await pineconeService.queryDocuments(userId, query, topK);

          res.status(200).json({
               success: true,
               message: "Query executed successfully",
               data: {
                    results: results.map((match) => ({
                         score: match.score,
                         metadata: match.metadata,
                    })),
                    totalResults: results.length,
               },
          });
     } catch (error) {
          logger.error("Error in queryDocuments controller", { error });
          res.status(500).json({
               success: false,
               message: "Internal server error while querying documents",
               error: error instanceof Error ? error.message : "Unknown error",
          });
     }
};

export const deleteDocuments = async (req: Request, res: Response): Promise<void> => {
     try {
          const { url } = req.body;
          const userId = (req as any).user?.id;

          if (!userId) {
               res.status(401).json({
                    success: false,
                    message: "User not authenticated",
               });
               return;
          }

          if (!url) {
               res.status(400).json({
                    success: false,
                    message: "URL is required",
               });
               return;
          }

          logger.info(`Deleting documents for URL: ${url}`, {
               userId,
          });

          await pineconeService.deleteDocumentsByUrl(userId, url);

          res.status(200).json({
               success: true,
               message: `All documents for URL ${url} have been deleted`,
          });
     } catch (error) {
          logger.error("Error in deleteDocuments controller", { error });
          res.status(500).json({
               success: false,
               message: "Internal server error while deleting documents",
               error: error instanceof Error ? error.message : "Unknown error",
          });
     }
};

export const deleteAllDocuments = async (req: Request, res: Response): Promise<void> => {
     try {
          const userId = (req as any).user?.id;

          if (!userId) {
               res.status(401).json({
                    success: false,
                    message: "User not authenticated",
               });
               return;
          }

          logger.info(`Deleting all documents for user: ${userId}`);

          await pineconeService.deleteAllUserDocuments(userId);

          res.status(200).json({
               success: true,
               message: `All your documents have been deleted`,
          });
     } catch (error) {
          logger.error("Error in deleteAllDocuments controller", { error });
          res.status(500).json({
               success: false,
               message: "Internal server error while deleting all documents",
               error: error instanceof Error ? error.message : "Unknown error",
          });
     }
};

export const getStats = async (req: Request, res: Response): Promise<void> => {
     try {
          const userId = (req as any).user?.userId;

          if (!userId) {
               res.status(401).json({
                    success: false,
                    message: "User not authenticated",
               });
               return;
          }

          logger.info("Getting Pinecone stats", {
               userId,
          });

          const stats = await pineconeService.getStats(userId);

          res.status(200).json({
               success: true,
               message: "Stats retrieved successfully",
               data: stats,
          });
     } catch (error) {
          logger.error("Error in getStats controller", { error });
          res.status(500).json({
               success: false,
               message: "Internal server error while getting stats",
               error: error instanceof Error ? error.message : "Unknown error",
          });
     }
};

export const getProgress = async (req: Request, res: Response): Promise<void> => {
     try {
          const userId = (req as any).user?.id || req.body.userId; // Try both (body for testing sometimes)
          // We can't really get progress without userId now as queues are likely user-specific eventually
          // For now, pass what we have or a placeholder if public/testing? 
          // Assuming authed route:

          const progress = await scraperService.getScrapingProgress(userId || "unknown");

          res.status(200).json({
               success: true,
               message: "Progress retrieved successfully",
               data: progress,
          });
     } catch (error) {
          logger.error("Error in getProgress controller", { error });
          res.status(500).json({
               success: false,
               message: "Internal server error while getting progress",
               error: error instanceof Error ? error.message : "Unknown error",
          });
     }
};

export const getAllSources = async (req: Request, res: Response): Promise<void> => {
     try {
          const userId = (req as any).user?.id;

          if (!userId) {
               res.status(401).json({
                    success: false,
                    message: "User not authenticated",
               });
               return;
          }

          logger.info(`Fetching all sources for user: ${userId}`);

          const sources = await pineconeService.getAllUserSources(userId);

          res.status(200).json({
               success: true,
               message: "Sources retrieved successfully",
               data: {
                    documents: sources.documents,
                    websites: sources.websites,
                    summary: {
                         totalDocuments: sources.documents.length,
                         totalWebsites: sources.websites.length,
                         totalChunks: sources.totalChunks,
                    },
               },
          });
     } catch (error) {
          logger.error("Error in getAllSources controller", { error });
          res.status(500).json({
               success: false,
               message: "Internal server error while fetching sources",
               error: error instanceof Error ? error.message : "Unknown error",
          });
     }
};
