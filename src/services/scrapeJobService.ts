import crypto from "crypto";
import { redisCache } from "../config/redis";
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
		},
	) => Promise<void>;
}

const locallyRunningJobs = new Set<string>();
const SCRAPE_JOB_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

const getJobLockKey = (jobId: string): string =>
	`scraper:job-lock:${jobId}`;

const acquireJobLock = async (
	jobId: string,
): Promise<string | null> => {
	const token = crypto.randomUUID();
	const result = await redisCache.set(
		getJobLockKey(jobId),
		token,
		"PX",
		SCRAPE_JOB_LOCK_TTL_MS,
		"NX",
	);
	return result === "OK" ? token : null;
};

const releaseJobLock = async (
	jobId: string,
	token: string | null,
): Promise<void> => {
	if (!token) {
		return;
	}

	const lockKey = getJobLockKey(jobId);
	const currentToken = await redisCache.get(lockKey);
	if (currentToken === token) {
		await redisCache.del(lockKey);
	}
};

export const runScrapeJob = async (
	job: ScrapeJobPayload,
	options: RunScrapeJobOptions,
): Promise<boolean> => {
	if (locallyRunningJobs.has(job.jobId)) {
		logger.info("Skipping duplicate scrape job execution", {
			jobId: job.jobId,
			mode: job.mode,
			url: job.url,
			source: options.source,
		});
		return false;
	}

	const lockToken = await acquireJobLock(job.jobId);
	if (!lockToken) {
		logger.info("Skipping scrape job because another runner already claimed it", {
			jobId: job.jobId,
			mode: job.mode,
			url: job.url,
			source: options.source,
		});
		return false;
	}

	locallyRunningJobs.add(job.jobId);
	logger.info(`Starting ${options.source} ${job.mode} job for user ${job.userId} on ${job.url}`, {
		jobId: job.jobId,
		maxDepth: job.maxDepth,
		maxPages: job.maxPages ?? null,
	});

	try {
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
	} finally {
		locallyRunningJobs.delete(job.jobId);
		await releaseJobLock(job.jobId, lockToken);
	}
};

export const scheduleScrapeJobFallback = (
	job: ScrapeJobPayload,
	delayMs: number = 2500,
): void => {
	const timer = setTimeout(() => {
		void (async () => {
			const currentJob =
				await scraperStatusService.getJob(
					job.jobId,
				);
			if (
				!currentJob ||
				currentJob.status !== "pending"
			) {
				return;
			}

			logger.warn(
				"Scrape job remained pending in queue; starting in-process fallback",
				{
					jobId: job.jobId,
					mode: job.mode,
					url: job.url,
				},
			);
			await runScrapeJob(job, {
				source: "fallback",
			});
		})().catch((error) => {
			logger.error(
				"Scrape job fallback execution failed",
				{
					jobId: job.jobId,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
		});
	}, delayMs);

	timer.unref?.();
};
