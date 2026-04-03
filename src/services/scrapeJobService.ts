import { scraperQueue } from "../config/queue";
import { scraperService } from "./scraperService";
import { scraperStatusService } from "./scraperStatusService";
import logger from "../utils/logger";

type ScrapeJobMode = "scrape" | "retrain";

export interface ScrapeJobPayload {
	jobId: string;
	userId: string;
	url: string;
	maxDepth: number;
	maxPages?: number;
	mode: ScrapeJobMode;
}

interface RunScrapeJobOptions {
	source: "queue" | "fallback" | "direct";
	updateExternalProgress?: (
		progress: {
			totalPages: number;
			scrapedPages: number;
			storedPages: number;
			currentUrl?: string;
			stage?:
				| "scraping_pages"
				| "pinecone_upsert_started"
				| "pinecone_embeddings_prepared"
				| "pinecone_stale_chunk_cleanup_completed"
				| "pinecone_upsert_completed"
				| "scraper_primary_pinecone_upsert_completed"
				| "hype_generation_started";
			percent?: number;
			stageLabel?: string;
		},
	) => Promise<void>;
}

export const enqueueScrapeJob = async (
	job: ScrapeJobPayload,
): Promise<void> => {
	await scraperQueue.add("scrape", job, {
		jobId: job.jobId,
	});
	logger.info("Scrape job enqueued", {
		jobId: job.jobId,
		mode: job.mode,
		url: job.url,
		userId: job.userId,
	});
};

export const runScrapeJob = async (
	job: ScrapeJobPayload,
	options: RunScrapeJobOptions,
): Promise<boolean> => {
	logger.info(`Starting ${options.source} ${job.mode} job for user ${job.userId} on ${job.url}`, {
		jobId: job.jobId,
		maxDepth: job.maxDepth,
		maxPages: job.maxPages ?? null,
	});

	try {
		const startedProgress = {
			totalPages: 0,
			scrapedPages: 0,
			storedPages: 0,
			currentUrl: job.url,
			stage: "scraping_pages" as const,
			percent: 1,
			stageLabel: "Scrape job picked up by worker",
		};
		await scraperStatusService.updateProgress(
			job.jobId,
			startedProgress,
		);
		if (options.updateExternalProgress) {
			await options.updateExternalProgress(
				startedProgress,
			);
		}

		const result = await scraperService.scrapeWebsite(
			job.userId,
			job.url,
			{
				maxDepth: job.maxDepth,
				maxPages: job.maxPages,
				onProgress: async (progress) => {
					await scraperStatusService.updateProgress(
						job.jobId,
						progress,
					);
					if (options.updateExternalProgress) {
						await options.updateExternalProgress(
							progress,
						);
					}
				},
			},
		);

		const finalProgress = {
			totalPages: result.visitedPages,
			scrapedPages: result.visitedPages,
			storedPages: result.storedPages,
			currentUrl: job.url,
		};

		if (result.success) {
			await scraperStatusService.completeJob(
				job.jobId,
				finalProgress,
			);
		} else {
			await scraperStatusService.failJob(
				job.jobId,
				result.message,
				finalProgress,
			);
		}

		return true;
	} catch (error) {
		const errorMessage =
			error instanceof Error
				? error.message
				: "Scrape job failed";
		await scraperStatusService.failJob(
			job.jobId,
			errorMessage,
		);
		logger.error(`${options.source} ${job.mode} job failed`, {
			error: errorMessage,
			jobId: job.jobId,
			userId: job.userId,
			url: job.url,
		});
		throw error;
	}
};
