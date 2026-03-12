import { Job, Worker } from "bullmq";
import { config } from "../config/env";
import { SCRAPER_QUEUE_NAME } from "../config/queue";
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

const processScrapeJob = async (
	job: Job<ScrapeJobData>,
) => {
	const {
		jobId,
		userId,
		url,
		maxDepth,
		maxPages,
		mode,
	} = job.data;

	logger.info(
		`Starting queued ${mode} job ${job.id} for user ${userId} on ${url}`,
		{ jobId, maxDepth, maxPages },
	);

	try {
		const result =
			await scraperService.scrapeWebsite(
				userId,
				url,
				{
					maxDepth,
					maxPages,
					onProgress: async (
						progress,
					) => {
						await scraperStatusService.updateProgress(
							jobId,
							progress,
						);
						await job.updateProgress(
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
			await scraperStatusService.completeJob(
				jobId,
				finalProgress,
			);
		} else {
			await scraperStatusService.failJob(
				jobId,
				result.message,
				finalProgress,
			);
		}

		return {
			success: result.success,
			message: result.message,
			pagesScraped: result.pagesScraped,
			visitedPages: result.visitedPages,
			storedPages: result.storedPages,
			jobId,
			mode,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error
				? error.message
				: "Scrape job failed";

		await scraperStatusService.failJob(
			jobId,
			errorMessage,
		);

		logger.error(
			`Queued ${mode} job ${job.id} failed`,
			{
				error: errorMessage,
				jobId,
				userId,
				url,
			},
		);

		throw error;
	}
};

export const createScraperWorker = () => {
	const worker = new Worker(
		SCRAPER_QUEUE_NAME,
		processScrapeJob,
		{
			connection: {
				host: config.REDIS_HOST,
				port: config.REDIS_PORT,
				password: config.REDIS_PASSWORD,
			},
			concurrency: config.SCRAPER_CONCURRENCY,
		},
	);

	worker.on("completed", (job) => {
		logger.info(`Job ${job.id} completed`, {
			returnvalue: job.returnvalue,
		});
	});

	worker.on("failed", (job, err) => {
		logger.error(`Job ${job?.id} failed`, {
			error: err.message,
		});
	});

	return worker;
};
