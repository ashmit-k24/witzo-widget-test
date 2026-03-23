import crypto from "crypto";
import { redisCache } from "../config/redis";
import { ScrapeJobStatus } from "../types";
import logger from "../utils/logger";

type ScrapeMode = "scrape" | "retrain";

type StoredScrapeJobStatus = Omit<
	ScrapeJobStatus,
	"startedAt" | "completedAt"
> & {
	userId: string;
	url: string;
	mode: ScrapeMode;
	maxDepth: number;
	maxPages?: number;
	startedAt: string;
	completedAt?: string;
};

interface StartJobParams {
	userId: string;
	url: string;
	mode: ScrapeMode;
	maxDepth: number;
	maxPages?: number;
}

interface ProgressUpdate {
	totalPages: number;
	scrapedPages: number;
	storedPages: number;
	currentUrl?: string;
}

const SCRAPER_STATUS_TTL_SECONDS = 24 * 60 * 60;

class ScraperStatusService {
	private getJobKey(jobId: string): string {
		return `scraper:job:${jobId}`;
	}

	private getLatestJobKey(userId: string): string {
		return `scraper:user:${userId}:latest`;
	}

	private normalize(status: StoredScrapeJobStatus): ScrapeJobStatus {
		return {
			...status,
			startedAt: new Date(status.startedAt),
			completedAt: status.completedAt
				? new Date(status.completedAt)
				: undefined,
		};
	}

	private async persist(status: StoredScrapeJobStatus): Promise<void> {
		const payload = JSON.stringify(status);
		await redisCache.setex(
			this.getJobKey(status.jobId),
			SCRAPER_STATUS_TTL_SECONDS,
			payload,
		);
		await redisCache.setex(
			this.getLatestJobKey(status.userId),
			SCRAPER_STATUS_TTL_SECONDS,
			payload,
		);
	}

	async startJob(params: StartJobParams): Promise<ScrapeJobStatus> {
		const job: StoredScrapeJobStatus = {
			jobId: crypto.randomUUID(),
			userId: params.userId,
			url: params.url,
			mode: params.mode,
			currentUrl: params.url,
			maxDepth: params.maxDepth,
			maxPages: params.maxPages,
			status: "pending",
			progress: {
				totalPages: 0,
				scrapedPages: 0,
				storedPages: 0,
			},
			startedAt: new Date().toISOString(),
		};

		await this.persist(job);
		return this.normalize(job);
	}

	async updateProgress(
		jobId: string,
		progress: ProgressUpdate,
	): Promise<ScrapeJobStatus | null> {
		const existing = await this.getStoredJob(jobId);
		if (!existing) {
			return null;
		}

		const nextStatus: StoredScrapeJobStatus = {
			...existing,
			status: "in_progress",
			currentUrl:
				progress.currentUrl || existing.currentUrl,
			progress: {
				totalPages: Math.max(
					progress.totalPages,
					progress.scrapedPages,
					progress.storedPages,
				),
				scrapedPages: progress.scrapedPages,
				storedPages: progress.storedPages,
			},
		};

		await this.persist(nextStatus);
		return this.normalize(nextStatus);
	}

	async completeJob(
		jobId: string,
		progress: ProgressUpdate,
	): Promise<ScrapeJobStatus | null> {
		const existing = await this.getStoredJob(jobId);
		if (!existing) {
			return null;
		}

		const completed: StoredScrapeJobStatus = {
			...existing,
			status: "completed",
			currentUrl:
				progress.currentUrl || existing.currentUrl,
			progress: {
				totalPages: Math.max(
					progress.totalPages,
					progress.scrapedPages,
					progress.storedPages,
				),
				scrapedPages: progress.scrapedPages,
				storedPages: progress.storedPages,
			},
			completedAt: new Date().toISOString(),
		};

		await this.persist(completed);
		return this.normalize(completed);
	}

	async failJob(
		jobId: string,
		errorMessage: string,
		progress?: Partial<ProgressUpdate>,
	): Promise<ScrapeJobStatus | null> {
		const existing = await this.getStoredJob(jobId);
		if (!existing) {
			return null;
		}

		const failed: StoredScrapeJobStatus = {
			...existing,
			status: "failed",
			error: errorMessage,
			currentUrl:
				progress?.currentUrl || existing.currentUrl,
			progress: {
				totalPages:
					progress?.totalPages ??
					existing.progress.totalPages,
				scrapedPages:
					progress?.scrapedPages ??
					existing.progress.scrapedPages,
				storedPages:
					progress?.storedPages ??
					existing.progress.storedPages,
			},
			completedAt: new Date().toISOString(),
		};

		await this.persist(failed);
		return this.normalize(failed);
	}

	async getJob(jobId: string): Promise<ScrapeJobStatus | null> {
		const stored = await this.getStoredJob(jobId);
		return stored ? this.normalize(stored) : null;
	}

	async getLatestJobForUser(
		userId: string,
	): Promise<ScrapeJobStatus | null> {
		try {
			const raw = await redisCache.get(
				this.getLatestJobKey(userId),
			);
			if (!raw) {
				return null;
			}

			return this.normalize(
				JSON.parse(raw) as StoredScrapeJobStatus,
			);
		} catch (error) {
			logger.error(
				"Error fetching latest scraper job",
				{
					error,
					userId,
				},
			);
			return null;
		}
	}

	private async getStoredJob(
		jobId: string,
	): Promise<StoredScrapeJobStatus | null> {
		try {
			const raw = await redisCache.get(
				this.getJobKey(jobId),
			);
			if (!raw) {
				return null;
			}

			return JSON.parse(raw) as StoredScrapeJobStatus;
		} catch (error) {
			logger.error("Error fetching scraper job", {
				error,
				jobId,
			});
			return null;
		}
	}
}

export const scraperStatusService =
	new ScraperStatusService();
