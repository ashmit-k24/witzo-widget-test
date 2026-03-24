import { Request, Response } from "express";
import {
	coercePlanType,
} from "../config/planConfig";
import { chatService } from "../services/chatService";
import { pineconeService } from "../services/pineconeService";
import { scraperStatusService } from "../services/scraperStatusService";
import { domainPolicyService } from "../services/domainPolicyService";
import { runScrapeJob } from "../services/scrapeJobService";
import { ScrapeRequest } from "../types";
import logger from "../utils/logger";

const SCRAPER_MAX_DEPTH = 10;
const SCRAPER_MAX_PAGES = 300;

const normalizeRequestedMaxPages = (
	value: unknown,
): number | undefined => {
	const normalized = Number(value);
	if (
		!Number.isFinite(normalized) ||
		normalized <= 0
	) {
		return undefined;
	}

	return Math.min(
		SCRAPER_MAX_PAGES,
		Math.trunc(normalized),
	);
};

const resolveEffectiveMaxPages = (
	requestedMaxPages: number | undefined,
	pagesRemaining: number | null,
): number | undefined => {
	if (pagesRemaining === null) {
		return requestedMaxPages;
	}
	if (requestedMaxPages === undefined) {
		return pagesRemaining;
	}
	return Math.min(
		requestedMaxPages,
		pagesRemaining,
	);
};

const getScraperUpgradeMessage = (
	planType: "free" | "basic" | "standard" | "enterprise",
): string => {
	if (planType === "free") {
		return "Upgrade to Basic plan for 30 website pages";
	}
	if (planType === "basic") {
		return "Upgrade to Standard plan for 100 website pages";
	}
	if (planType === "standard") {
		return "Upgrade to Enterprise plan for unlimited website pages";
	}
	return "Your enterprise limits are managed through your custom plan.";
};

const getScraperLimitPayload = (
	planType: "free" | "basic" | "standard" | "enterprise",
	scraperUsage: Awaited<
		ReturnType<typeof pineconeService.getScraperUsageStats>
	>,
) => ({
		planType: scraperUsage.planType,
		pagesUsed: scraperUsage.pagesUsed,
		pagesLimit: scraperUsage.pagesLimit,
		pagesRemaining: scraperUsage.pagesRemaining,
		upgradeMessage:
			scraperUsage.pagesLimit === null
				? undefined
				: getScraperUpgradeMessage(planType),
	});

export const scrapeWebsite = async (
	req: Request,
	res: Response,
): Promise<void> => {
	let jobId: string | null = null;
	try {
		const {
			url,
			maxDepth = 3,
			maxPages,
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

		const policyCheck =
			await domainPolicyService.isDomainDisallowed(url);
		if (policyCheck.blocked) {
			res.status(403).json({
				success: false,
				message: `${policyCheck.matchedDomain} is not allowed for scraping.`,
			});
			return;
		}

		// Reuse usage stats already fetched by checkScraperLimit middleware;
		// fall back to a fresh Pinecone call only if the middleware was bypassed.
		const scraperUsage =
			(res.locals as any).scraperUsage ??
			(await pineconeService.getScraperUsageStats(userId, planType));

		if (
			scraperUsage.pagesRemaining !== null &&
			scraperUsage.pagesRemaining <= 0
		) {
			res.status(403).json({
				success: false,
				message: `You've reached your website scraping limit. ${planType} plan allows ${scraperUsage.pagesLimit ?? "unlimited"} pages.`,
				data: {
					...getScraperLimitPayload(
						planType,
						scraperUsage,
					),
				},
			});
			return;
		}

		const normalizedMaxDepth = Math.max(
			0,
			Math.min(
				SCRAPER_MAX_DEPTH,
				Number(maxDepth) || 3,
			),
		);
		const normalizedMaxPages =
			normalizeRequestedMaxPages(maxPages);
		const effectiveMaxPages =
			resolveEffectiveMaxPages(
				normalizedMaxPages,
				scraperUsage.pagesRemaining,
			);

		if (
			effectiveMaxPages !== undefined &&
			effectiveMaxPages <= 0
		) {
			res.status(403).json({
				success: false,
				message: `You've reached your website scraping limit. ${planType} plan allows ${scraperUsage.pagesLimit ?? "unlimited"} pages.`,
				data: {
					...getScraperLimitPayload(
						planType,
						scraperUsage,
					),
				},
			});
			return;
		}

		logger.info(
			`Starting scrape for URL: ${url}`,
			{
				maxDepth: normalizedMaxDepth,
				maxPages:
					normalizedMaxPages ?? null,
				effectiveMaxPages,
				userId,
				planType,
			},
		);

		const job =
			await scraperStatusService.startJob({
				userId,
				url,
				mode: "scrape",
				maxDepth: normalizedMaxDepth,
				maxPages: effectiveMaxPages,
			});
		jobId = job.jobId;

		const jobPayload = {
			jobId: job.jobId,
			userId,
			url,
			maxDepth: normalizedMaxDepth,
			maxPages: effectiveMaxPages,
			mode: "scrape",
		} as const;

		res.status(202).json({
			success: true,
			message:
				"Website training started. Progress is available through the scrape status endpoint.",
			data: {
				job,
			},
		});

		void runScrapeJob(jobPayload, {
			source: "direct",
		}).catch((error) => {
			logger.error(
				"Direct scrape execution failed after request acceptance",
				{
					jobId: jobPayload.jobId,
					url: jobPayload.url,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
		});
	} catch (error) {
		if (jobId) {
			const message =
				error instanceof Error
					? error.message
					: "Scrape failed";
			await scraperStatusService.failJob(
				jobId,
				message,
			);
		}
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
		const { query, language } = req.body;
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
			{ userId, language },
		);

		const result =
			await chatService.answerKnowledgeQuery(
				userId,
				query,
				language,
			);

		res.status(200).json({
			success: true,
			message: "Query executed successfully",
			data: {
				answer: result.answer,
				language: result.language,
				sources: result.sources,
				matches: result.matches.map((match) => ({
					score: match.score,
					cohereScore: match.cohereScore,
					metadata: match.metadata,
				})),
				totalResults: result.matches.length,
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

		const policyCheck =
			await domainPolicyService.isDomainDisallowed(url);
		if (policyCheck.blocked) {
			res.status(403).json({
				success: false,
				message: `${policyCheck.matchedDomain} is not allowed for scraping.`,
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
		const latestJob =
			await scraperStatusService.getLatestJobForUser(
				userId,
			);
		const scraperUsage =
			await pineconeService.getScraperUsageStats(
				userId,
				planType,
			);
		const documentUsage =
			await pineconeService.getDocumentUsageStats(
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
				documentUsage: {
					planType,
					documentsUsed:
						documentUsage.documentsUsed,
					documentsLimit:
						documentUsage.documentsLimit,
					documentsRemaining:
						documentUsage.documentsRemaining,
					isAtLimit:
						documentUsage.isAtLimit,
				},
				scrapeJob: latestJob,
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
		const documentUsage =
			userId
				? await pineconeService.getDocumentUsageStats(
						userId,
						planType,
				  )
				: {
						documentsUsed: 0,
						documentsLimit: 0,
						documentsRemaining: 0,
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
					documentUsage: {
						planType,
						documentsUsed:
							documentUsage.documentsUsed,
						documentsLimit:
							documentUsage.documentsLimit,
						documentsRemaining:
							documentUsage.documentsRemaining,
						isAtLimit:
							documentUsage.isAtLimit,
					},
					scrapeJob:
						userId
							? await scraperStatusService.getLatestJobForUser(
									userId,
							  )
							: null,
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

export const getLatestScrapeStatus = async (
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

		const job =
			await scraperStatusService.getLatestJobForUser(
				userId,
			);
		res.status(200).json({
			success: true,
			data: job,
		});
	} catch (error) {
		logger.error(
			"Error in getLatestScrapeStatus controller",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while fetching scrape status",
		});
	}
};

export const getScrapeStatusByJobId = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = (req as any).user?.id;
		const { jobId } = req.params;

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "User not authenticated",
			});
			return;
		}

		const job =
			await scraperStatusService.getJob(jobId);
		if (!job || job.userId !== userId) {
			res.status(404).json({
				success: false,
				message: "Scrape job not found",
			});
			return;
		}

		res.status(200).json({
			success: true,
			data: job,
		});
	} catch (error) {
		logger.error(
			"Error in getScrapeStatusByJobId controller",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while fetching scrape job",
		});
	}
};

export const retrainWebsite = async (
	req: Request,
	res: Response,
): Promise<void> => {
	let jobId: string | null = null;
	try {
		const {
			url,
			maxDepth = 3,
			maxPages,
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
						...getScraperLimitPayload(
							planType,
							scraperUsage,
						),
					},
				});
				return;
			}

			const normalizedMaxDepth = Math.max(
				0,
				Math.min(
					SCRAPER_MAX_DEPTH,
					Number(maxDepth) || 3,
				),
			);
			const normalizedMaxPages =
				normalizeRequestedMaxPages(maxPages);
			const effectiveMaxPages =
				resolveEffectiveMaxPages(
					normalizedMaxPages,
					scraperUsage.pagesRemaining,
				);
			if (
				effectiveMaxPages !== undefined &&
				effectiveMaxPages <= 0
			) {
				res.status(403).json({
					success: false,
					message: `You've reached your website scraping limit. ${planType} plan allows ${scraperUsage.pagesLimit ?? "unlimited"} pages.`,
					data: {
						...getScraperLimitPayload(
							planType,
							scraperUsage,
						),
					},
				});
				return;
			}
			const job =
				await scraperStatusService.startJob({
					userId,
					url,
					mode: "retrain",
					maxDepth: normalizedMaxDepth,
					maxPages: effectiveMaxPages,
				});
			jobId = job.jobId;

			const jobPayload = {
				jobId: job.jobId,
				userId,
				url,
				maxDepth: normalizedMaxDepth,
				maxPages: effectiveMaxPages,
				mode: "retrain",
			} as const;

		res.status(202).json({
			success: true,
			message:
				"Website retraining started. Progress is available through the scrape status endpoint.",
			data: {
				job,
			},
		});

			void runScrapeJob(jobPayload, {
				source: "direct",
			}).catch((error) => {
				logger.error(
					"Direct retrain execution failed after request acceptance",
					{
						jobId: jobPayload.jobId,
						url: jobPayload.url,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			});
	} catch (error) {
		if (jobId) {
			const message =
				error instanceof Error
					? error.message
					: "Retrain failed";
			await scraperStatusService.failJob(
				jobId,
				message,
			);
		}
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
