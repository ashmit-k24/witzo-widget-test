import { Request, Response } from "express";
import { coercePlanType } from "../config/planConfig";
import { chatService } from "../services/chatService";
import { pineconeService } from "../services/pineconeService";
import { scraperSourceService } from "../services/scraperSourceService";
import { scraperStatusService } from "../services/scraperStatusService";
import { domainPolicyService } from "../services/domainPolicyService";
import { enqueueScrapeJob } from "../services/scrapeJobService";
import { ScrapeRequest } from "../types";
import logger from "../utils/logger";

const SCRAPER_MAX_DEPTH = 10;
type DeleteJobMode =
	| "delete_source"
	| "delete_page"
	| "delete_all";

const startDeleteJob = async (
	userId: string,
	url: string,
	mode: DeleteJobMode,
) =>
	scraperStatusService.startJob({
		userId,
		url,
		mode,
	});

const runDeleteJobInBackground = (
	jobId: string,
	userId: string,
	url: string,
	mode: DeleteJobMode,
	task: (reportProgress: (progress: {
		percent: number;
		label: string;
	}) => Promise<void>) => Promise<void>,
	onFailure?: () => Promise<void>,
): void => {
	void (async () => {
		try {
			const reportProgress = async (progress: {
				percent: number;
				label: string;
			}) => {
				await scraperStatusService.updateProgress(
					jobId,
					{
						totalPages: 1,
						scrapedPages:
							progress.percent >= 100 ? 1 : 0,
						storedPages:
							progress.percent >= 100 ? 1 : 0,
						currentUrl: url,
						stage: "scraping_pages",
						percent: progress.percent,
						stageLabel: progress.label,
					},
				);
			};

			await reportProgress({
				percent: 5,
				label: "Delete job picked up by worker",
			});

			await task(reportProgress);

			await scraperStatusService.completeJob(
				jobId,
				{
					totalPages: 1,
					scrapedPages: 1,
					storedPages: 1,
					currentUrl: url,
					stage: "completed",
					percent: 100,
					stageLabel: "Deletion completed",
				},
			);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Delete failed";
			logger.error("Background delete job failed", {
				jobId,
				userId,
				url,
				mode,
				error: message,
			});
			await scraperStatusService.failJob(
				jobId,
				message,
				{
					totalPages: 1,
					currentUrl: url,
				},
			);
			if (onFailure) {
				try {
					await onFailure();
				} catch (callbackError) {
					logger.warn("Delete job onFailure callback failed", {
						jobId,
						error: callbackError instanceof Error
							? callbackError.message
							: String(callbackError),
					});
				}
			}
		}
	})();
};

const isActiveDeleteAllJob = (
	job: Awaited<ReturnType<typeof scraperStatusService.getLatestJobForUser>>,
): job is NonNullable<Awaited<ReturnType<typeof scraperStatusService.getLatestJobForUser>>> =>
	Boolean(
		job &&
			job.mode === "delete_all" &&
			["pending", "in_progress"].includes(job.status),
	);

const waitForJobTerminalState = async (
	jobId: string,
	timeoutMs = 15 * 60 * 1000,
) => {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const job = await scraperStatusService.getJob(jobId);
		if (job && ["completed", "failed"].includes(job.status)) {
			return job;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	return null;
};

const queueScrapeAfterDeleteAll = (
	deleteJobId: string,
	jobPayload: {
		jobId: string;
		userId: string;
		url: string;
		maxDepth: number;
		maxPages?: number;
		mode: "scrape" | "retrain";
	},
) => {
	void (async () => {
		try {
			logger.info("Queueing scrape until delete-all finishes", {
				jobId: jobPayload.jobId,
				deleteJobId,
				url: jobPayload.url,
				mode: jobPayload.mode,
			});

			const deleteJob = await waitForJobTerminalState(deleteJobId);
			if (!deleteJob) {
				await scraperStatusService.failJob(
					jobPayload.jobId,
					"Timed out waiting for existing delete-all job to finish.",
				);
				return;
			}

			if (deleteJob.status === "failed") {
				await scraperStatusService.failJob(
					jobPayload.jobId,
					deleteJob.error || "Delete-all job failed before scrape could start.",
				);
				return;
			}

			await enqueueScrapeJob(jobPayload);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			logger.error("Queued scrape failed after delete-all", {
				jobId: jobPayload.jobId,
				deleteJobId,
				url: jobPayload.url,
				mode: jobPayload.mode,
				error: message,
			});
			await scraperStatusService.failJob(jobPayload.jobId, message);
		}
	})();
};

const normalizeRequestedMaxPages = (
	value: unknown,
	maxAllowed: number | null,
): number | undefined => {
	const normalized = Number(value);
	if (
		!Number.isFinite(normalized) ||
		normalized <= 0
	) {
		return undefined;
	}

	const truncated = Math.trunc(normalized);
	return maxAllowed === null
		? truncated
		: Math.min(maxAllowed, truncated);
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

const getScraperLimitPayload = (
	planType: "free" | "basic" | "standard" | "enterprise",
	scraperUsage: Awaited<
		ReturnType<typeof pineconeService.getScraperUsageStats>
	>,
) => {
	void planType;
	return {
		planType: scraperUsage.planType,
		pagesUsed: scraperUsage.pagesUsed,
		pagesLimit: scraperUsage.pagesLimit,
		pagesRemaining: scraperUsage.pagesRemaining,
	};
};

const buildScrapeProgressPayload = async (
	jobId: string,
) => {
	const progress =
		await scraperStatusService.getProgress(jobId);
	if (!progress) {
		return null;
	}

	return {
		jobId: progress.jobId,
		mode: progress.mode,
		url: progress.url,
		currentUrl: progress.currentUrl,
		status: progress.status,
		percent: progress.percent,
		stage: progress.stage,
		stageLabel: progress.stageLabel,
		pageProgress: progress.pageProgress,
		milestones: progress.milestones,
		startedAt: progress.startedAt,
		completedAt: progress.completedAt,
		error: progress.error,
	};
};

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
				message: `You've reached your website scraping limit. You can scrape up to ${scraperUsage.pagesLimit} pages in total.`,
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
			normalizeRequestedMaxPages(maxPages, scraperUsage.pagesLimit);
		const effectiveMaxPages =
			resolveEffectiveMaxPages(
				normalizedMaxPages,
				scraperUsage.pagesRemaining,
			);
		const blockingDeleteAllJob =
			await scraperStatusService.getLatestJobForUser(userId);

		if (
			effectiveMaxPages !== undefined &&
			effectiveMaxPages <= 0
		) {
			res.status(403).json({
				success: false,
				message: `You've reached your website scraping limit. You can scrape up to ${scraperUsage.pagesLimit} pages in total.`,
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

		// If this URL was pending deletion, abort the background delete job
		// by clearing the flag now. The delete job checks this flag before
		// and after its Pinecone scan and will abort when it sees FALSE.
		await scraperSourceService.clearPendingDelete(userId, url);

		if (isActiveDeleteAllJob(blockingDeleteAllJob)) {
			queueScrapeAfterDeleteAll(
				blockingDeleteAllJob.jobId,
				jobPayload,
			);
		} else {
			await enqueueScrapeJob(jobPayload);
		}

		res.status(202).json({
			success: true,
			message:
				"Website training started. Progress is available through the scrape status endpoint.",
			data: {
				job,
			},
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

		const job = await startDeleteJob(
			userId,
			url,
			"delete_source",
		);

		// Mark the source as pending-delete immediately so the sources
		// list hides it right away — even if the user refreshes the page
		// before the background deletion finishes.
		await scraperSourceService.markPendingDelete(userId, url);

		res.status(202).json({
			success: true,
			message: `Deletion started for website ${url}`,
			data: {
				job,
			},
		});

		runDeleteJobInBackground(
			job.jobId,
			userId,
			url,
			"delete_source",
			(reportProgress) =>
				pineconeService.deleteDocumentsByUrl(
					userId,
					url,
					reportProgress,
				),
			async () => {
				// On failure, clear the pending flag so the source
				// reappears in the list rather than staying hidden.
				await scraperSourceService.clearPendingDelete(
					userId,
					url,
				);
			},
		);
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

		const job = await startDeleteJob(
			userId,
			url,
			"delete_page",
		);

		res.status(202).json({
			success: true,
			message: `Deletion started for page ${url}`,
			data: {
				job,
			},
		});

		runDeleteJobInBackground(
			job.jobId,
			userId,
			url,
			"delete_page",
			(reportProgress) =>
				pineconeService.deletePageByExactUrl(
					userId,
					url,
					reportProgress,
				),
		);
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

		const deleteUrl = `delete-all://${userId}`;
		const job = await startDeleteJob(
			userId,
			deleteUrl,
			"delete_all",
		);

		res.status(202).json({
			success: true,
			message: "Deletion started for all data sources",
			data: {
				job,
			},
		});

		runDeleteJobInBackground(
			job.jobId,
			userId,
			deleteUrl,
			"delete_all",
			(reportProgress) =>
				pineconeService.deleteAllUserDocuments(
					userId,
					reportProgress,
				),
		);
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
			await pineconeService.getAllUserSourcesFromDB(
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
		const indexedPages = sources.websites.reduce(
			(sum, w) =>
				sum +
				("indexedPages" in w &&
				typeof w.indexedPages === "number"
					? w.indexedPages
					: w.pages.filter((page) => page.chunks > 0)
							.length),
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
					totalIndexedPages: indexedPages,
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

export const getLatestScrapeProgress = async (
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

		const latestJob =
			await scraperStatusService.getLatestJobForUser(
				userId,
			);
		if (!latestJob) {
			res.status(200).json({
				success: true,
				data: null,
			});
			return;
		}

		const progress =
			await buildScrapeProgressPayload(
				latestJob.jobId,
			);
		res.status(200).json({
			success: true,
			data: progress,
		});
	} catch (error) {
		logger.error(
			"Error in getLatestScrapeProgress controller",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while fetching scrape progress",
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

export const getScrapeProgressByJobId = async (
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

		const progress =
			await buildScrapeProgressPayload(jobId);
		res.status(200).json({
			success: true,
			data: progress,
		});
	} catch (error) {
		logger.error(
			"Error in getScrapeProgressByJobId controller",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while fetching scrape progress",
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
					message: `You've reached your website scraping limit. You can scrape up to ${scraperUsage.pagesLimit} pages in total.`,
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
				normalizeRequestedMaxPages(maxPages, scraperUsage.pagesLimit);
			const effectiveMaxPages =
				resolveEffectiveMaxPages(
					normalizedMaxPages,
					scraperUsage.pagesRemaining,
				);
			const blockingDeleteAllJob =
				await scraperStatusService.getLatestJobForUser(
					userId,
				);
			if (
				effectiveMaxPages !== undefined &&
				effectiveMaxPages <= 0
			) {
				res.status(403).json({
					success: false,
					message: `You've reached your website scraping limit. You can scrape up to ${scraperUsage.pagesLimit} pages in total.`,
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

			if (isActiveDeleteAllJob(blockingDeleteAllJob)) {
				queueScrapeAfterDeleteAll(
					blockingDeleteAllJob.jobId,
					jobPayload,
				);
			} else {
				await enqueueScrapeJob(jobPayload);
			}

		res.status(202).json({
			success: true,
			message:
				"Website retraining started. Progress is available through the scrape status endpoint.",
			data: {
				job,
			},
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
