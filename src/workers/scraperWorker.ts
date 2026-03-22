import type { Job } from "pg-boss";
import {
	boss,
	SCRAPER_QUEUE_NAME,
	startQueue,
	stopQueue,
} from "../config/queue";
import { config } from "../config/env";
import { scraperService } from "../services/scraperService";
import { scraperStatusService } from "../services/scraperStatusService";
import logger from "../utils/logger";

type ScrapeJobMode = "scrape" | "retrain";

export interface ScrapeJobData {
	jobId: string;
	userId: string;
	url: string;
	maxDepth: number;
	maxPages: number;
	mode: ScrapeJobMode;
}

/** Process a single scrape job entry. */
const processSingleJob = async (
	job: Job<ScrapeJobData>,
): Promise<void> => {
	const { jobId, userId, url, maxDepth, maxPages, mode } = job.data;

	logger.info(
		`Starting queued ${mode} job ${job.id} for user ${userId} on ${url}`,
		{ jobId, maxDepth, maxPages },
	);

	try {
		const result = await scraperService.scrapeWebsite(
			userId,
			url,
			{
				maxDepth,
				maxPages,
				onProgress: async (progress) => {
					await scraperStatusService.updateProgress(
						jobId,
						progress,
					);
				},
			},
		);

		const finalProgress = {
			totalPages: result.visitedPages,
			scrapedPages: result.visitedPages,
			storedPages: result.storedPages,
			currentUrl: url,
		};

		if (result.success) {
			await scraperStatusService.completeJob(jobId, finalProgress);
		} else {
			await scraperStatusService.failJob(
				jobId,
				result.message,
				finalProgress,
			);
		}

		logger.info(`Queued ${mode} job ${job.id} completed`, {
			success: result.success,
			pagesScraped: result.pagesScraped,
			visitedPages: result.visitedPages,
			storedPages: result.storedPages,
			jobId,
			mode,
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Scrape job failed";

		await scraperStatusService.failJob(jobId, errorMessage);

		logger.error(`Queued ${mode} job ${job.id} failed`, {
			error: errorMessage,
			jobId,
			userId,
			url,
		});

		// Re-throw so pg-boss marks the job as failed and retries if configured
		throw error;
	}
};

/**
 * pg-boss WorkHandler receives a batch (array) of jobs.
 * We process them sequentially within each batch.
 */
const processScrapeJobs = async (
	jobs: Job<ScrapeJobData>[],
): Promise<void> => {
	for (const job of jobs) {
		await processSingleJob(job);
	}
};

export const createScraperWorker = async (): Promise<void> => {
	await boss.work<ScrapeJobData>(
		SCRAPER_QUEUE_NAME,
		{
			localConcurrency: config.SCRAPER_CONCURRENCY,
			batchSize: 1, // fetch one job at a time per poll
		},
		processScrapeJobs,
	);

	logger.info("[ScraperWorker] Worker registered", {
		queue: SCRAPER_QUEUE_NAME,
		concurrency: config.SCRAPER_CONCURRENCY,
	});
};

// Self-execute when run as a standalone script (e.g. via PM2 ecosystem.config.js)
if (require.main === module) {
	(async () => {
		await startQueue();
		await createScraperWorker();

		logger.info("Scraper worker started as standalone process", {
			concurrency: config.SCRAPER_CONCURRENCY,
			dbHost: config.DB_HOST,
			dbName: config.DB_NAME,
		});

		const shutdown = async () => {
			logger.info("Scraper worker shutting down...");
			await stopQueue();
			process.exit(0);
		};

		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);
	})();
}
