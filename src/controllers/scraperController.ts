import { Request, Response } from "express";
import {
	coercePlanType,
} from "../config/planConfig";
import { pineconeService } from "../services/pineconeService";
import { scraperService } from "../services/scraperService";
import { ScrapeRequest } from "../types";
import logger from "../utils/logger";

export const scrapeWebsite = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const {
			url,
			maxDepth = 3,
			maxPages = 100,
		} = req.body as ScrapeRequest;
		const userId = (req as any).user?.id;
		const planType = coercePlanType(
			(req as any).user?.plan_type,
		);

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

		// Check if URL has already been scraped for this user
		const existingSource =
			await pineconeService.checkSourceExists(
				userId,
				url,
			);
		if (existingSource.exists) {
			logger.info(
				`URL already scraped for user; allowing incremental re-scrape: ${userId}`,
				{
					url,
					chunks: existingSource.chunks,
				},
			);
		}

		// Get current scraper usage stats
			const scraperUsage =
				await pineconeService.getScraperUsageStats(
					userId,
					planType,
				);
			if (
				scraperUsage.pagesRemaining !== null &&
				scraperUsage.pagesRemaining <= 0
			) {
				res.status(403).json({
					success: false,
				message: `You've reached your website scraping limit. ${planType} plan allows ${scraperUsage.pagesLimit ?? "unlimited"} pages.`,
					data: {
						planType:
							scraperUsage.planType,
						pagesUsed:
							scraperUsage.pagesUsed,
						pagesLimit:
							scraperUsage.pagesLimit,
						pagesRemaining:
							scraperUsage.pagesRemaining,
						upgradeUrl:
							planType === "free"
								? "/api/auth/upgrade"
								: undefined,
						upgradeMessage:
							planType === "free"
								? "Upgrade to Basic plan for 30 website pages"
								: "You have reached the maximum limit for Basic plan",
					},
				});
				return;
			}

			const normalizedMaxDepth = Math.max(
				0,
				Number(maxDepth) || 3,
			);
			const normalizedMaxPages = Math.max(
				1,
				Number(maxPages) || 100,
			);
			const effectiveMaxPages = Math.min(
				normalizedMaxPages,
				scraperUsage.pagesRemaining ??
					normalizedMaxPages,
			);

			logger.info(
				`Starting scrape for URL: ${url}`,
				{
					maxDepth: normalizedMaxDepth,
					maxPages: normalizedMaxPages,
					effectiveMaxPages,
					userId,
					planType,
				},
			);

		// Scrape synchronously — waits until all pages are scraped
				const result =
					await scraperService.scrapeWebsite(
						userId,
						url,
						{
							maxDepth:
								normalizedMaxDepth,
							maxPages:
								effectiveMaxPages,
						},
					);
		res.status(result.success ? 200 : 500).json({
			success: result.success,
			message: result.message,
		});
	} catch (error) {
		logger.error(
			"Error in scrapeWebsite controller",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while scraping website",
		});
	}
};

export const queryDocuments = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const { query, topK = 10 } = req.body;
		const userId = (req as any).user?.id;

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

		logger.info(
			`Querying documents with: ${query}`,
			{
				topK,
				userId,
			},
		);

		const results =
			await pineconeService.queryDocuments(
				userId,
				query,
				topK,
			);

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
		logger.error(
			"Error in queryDocuments controller",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while querying documents",
		});
	}
};

export const deleteDocuments = async (
	req: Request,
	res: Response,
): Promise<void> => {
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

		logger.info(
			`Deleting all documents for website: ${url}`,
			{
				userId,
			},
		);

		await pineconeService.deleteDocumentsByUrl(
			userId,
			url,
		);

		res.status(200).json({
			success: true,
			message: `All documents for website ${url} have been deleted`,
		});
	} catch (error) {
		logger.error(
			"Error in deleteDocuments controller",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while deleting documents",
		});
	}
};

export const deletePage = async (
	req: Request,
	res: Response,
): Promise<void> => {
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

		logger.info(
			`Deleting individual page: ${url}`,
			{ userId },
		);

		await pineconeService.deletePageByExactUrl(
			userId,
			url,
		);

		res.status(200).json({
			success: true,
			message: `Page ${url} has been deleted`,
		});
	} catch (error) {
		logger.error(
			"Error in deletePage controller",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while deleting page",
		});
	}
};

export const deleteAllDocuments = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = (req as any).user?.id;

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "User not authenticated",
			});
			return;
		}

		logger.info(
			`Deleting all documents for user: ${userId}`,
		);

		await pineconeService.deleteAllUserDocuments(
			userId,
		);

		res.status(200).json({
			success: true,
			message: `All your documents have been deleted`,
		});
	} catch (error) {
		logger.error(
			"Error in deleteAllDocuments controller",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while deleting all documents",
		});
	}
};

export const getStats = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = (req as any).user?.id;

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

		const stats =
			await pineconeService.getStats(userId);

		res.status(200).json({
			success: true,
			message: "Stats retrieved successfully",
			data: stats,
		});
	} catch (error) {
		logger.error("Error in getStats controller", {
			error,
		});
		res.status(500).json({
			success: false,
			message:
				"Internal server error while getting stats",
		});
	}
};

export const getAllSources = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
			const userId = (req as any).user?.id;
			const planType = coercePlanType(
				(req as any).user?.plan_type,
			);

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "User not authenticated",
			});
			return;
		}

		logger.info(
			`Fetching all sources for user: ${userId}`,
		);

		const sources =
			await pineconeService.getAllUserSources(
				userId,
			);
		const scraperUsage =
			await pineconeService.getScraperUsageStats(
				userId,
				planType,
			);

		// Total individual pages across all websites
		const pagesUsed = sources.websites.reduce(
			(sum, w) => sum + w.pages.length,
			0,
		);

		res.status(200).json({
			success: true,
			data: {
				documents: sources.documents,
				websites: sources.websites,
				summary: {
					totalDocuments:
						sources.documents.length,
					totalWebsites: sources.websites.length,
					totalPages: pagesUsed,
					totalChunks: sources.totalChunks,
				},
				scraperUsage: {
					planType,
					pagesUsed,
					pagesLimit:
						scraperUsage.pagesLimit,
					pagesRemaining:
						scraperUsage.pagesRemaining,
					isAtLimit:
						scraperUsage.isAtLimit,
				},
			},
		});
	} catch (error) {
		const userId = (req as any).user?.id;
		const planType = coercePlanType(
			(req as any).user?.plan_type,
		);
		const scraperUsage =
			userId
				? await pineconeService.getScraperUsageStats(
						userId,
						planType,
				  )
				: {
						pagesLimit: 0,
						pagesRemaining: 0,
						isAtLimit: false,
				  };
		const isPineconeConnectionError =
			error &&
			typeof error === "object" &&
			"name" in error &&
			(error as { name?: string }).name ===
				"PineconeConnectionError";

		if (isPineconeConnectionError) {
			logger.warn(
				"Pinecone unavailable in getAllSources; returning empty source list",
				{ userId, error },
			);
			res.status(200).json({
				success: true,
				data: {
					documents: [],
					websites: [],
					summary: {
						totalDocuments: 0,
						totalWebsites: 0,
						totalPages: 0,
						totalChunks: 0,
					},
					scraperUsage: {
						planType,
						pagesUsed: 0,
						pagesLimit:
							scraperUsage.pagesLimit,
						pagesRemaining:
							scraperUsage.pagesRemaining,
						isAtLimit:
							scraperUsage.isAtLimit,
					},
				},
			});
			return;
		}

		logger.error(
			"Error in getAllSources controller",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while fetching sources",
		});
	}
};

export const retrainWebsite = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const {
			url,
			maxDepth = 3,
			maxPages = 100,
		} = req.body as ScrapeRequest;
		const userId = (req as any).user?.id;
		const planType = coercePlanType(
			(req as any).user?.plan_type,
		);

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

		logger.info(
			`Retraining website: ${url}`,
			{ userId },
		);

			// Delete all existing data for this website domain first
			await pineconeService.deleteDocumentsByUrl(
				userId,
				url,
			);

			const scraperUsage =
				await pineconeService.getScraperUsageStats(
					userId,
					planType,
				);
			if (
				scraperUsage.pagesRemaining !== null &&
				scraperUsage.pagesRemaining <= 0
			) {
				res.status(403).json({
					success: false,
					message: `You've reached your website scraping limit. ${planType} plan allows ${scraperUsage.pagesLimit ?? "unlimited"} pages.`,
					data: {
						planType:
							scraperUsage.planType,
						pagesUsed:
							scraperUsage.pagesUsed,
						pagesLimit:
							scraperUsage.pagesLimit,
						pagesRemaining:
							scraperUsage.pagesRemaining,
						upgradeUrl:
							planType === "free"
								? "/api/auth/upgrade"
								: undefined,
						upgradeMessage:
							planType === "free"
								? "Upgrade to Basic plan for 30 website pages"
								: "You have reached the maximum limit for Basic plan",
					},
				});
				return;
			}

			const normalizedMaxDepth = Math.max(
				0,
				Number(maxDepth) || 3,
			);
			const normalizedMaxPages = Math.max(
				1,
				Number(maxPages) || 100,
			);
			const effectiveMaxPages = Math.min(
				normalizedMaxPages,
				scraperUsage.pagesRemaining ??
					normalizedMaxPages,
			);

			// Re-scrape the website
			const result =
				await scraperService.scrapeWebsite(
					userId,
					url,
					{
						maxDepth:
							normalizedMaxDepth,
						maxPages:
							effectiveMaxPages,
					},
				);

		res.status(result.success ? 200 : 500).json({
			success: result.success,
			message: `Website retrained successfully: ${result.message}`,
		});
	} catch (error) {
		logger.error(
			"Error in retrainWebsite controller",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while retraining website",
		});
	}
};
