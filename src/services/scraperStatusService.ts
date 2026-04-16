import crypto from "crypto";
import { redisCache } from "../config/redis";
import { ScrapeJobStatus } from "../types";
import logger from "../utils/logger";

type ScrapeMode =
	| "scrape"
	| "retrain"
	| "delete_source"
	| "delete_page"
	| "delete_all";

type StoredScrapeJobStatus = Omit<
	ScrapeJobStatus,
	"startedAt" | "completedAt" | "pipeline"
> & {
	userId: string;
	url: string;
	mode: ScrapeMode;
	maxDepth: number;
	maxPages?: number;
	startedAt: string;
	completedAt?: string;
	pipeline?: {
		stage: PipelineStage;
		label: string;
		percent: number;
		updatedAt: string;
		milestones: Array<{
			key: PipelineMilestoneKey;
			label: string;
			percent: number;
			completed: boolean;
			completedAt?: string;
		}>;
	};
};

interface StartJobParams {
	userId: string;
	url: string;
	mode: ScrapeMode;
	maxDepth?: number;
	maxPages?: number;
}

type PipelineMilestoneKey =
	| "queued"
	| "scraping_pages"
	| "pinecone_upsert_started"
	| "pinecone_embeddings_prepared"
	| "pinecone_stale_chunk_cleanup_completed"
	| "pinecone_upsert_completed"
	| "scraper_primary_pinecone_upsert_completed";

export type PipelineStage =
	| PipelineMilestoneKey
	| "completed"
	| "failed";

type ProgressUpdate = {
	totalPages: number;
	scrapedPages: number;
	storedPages: number;
	currentUrl?: string;
	stage?: PipelineStage;
	stageLabel?: string;
	percent?: number;
};

const SCRAPER_STATUS_TTL_SECONDS = 24 * 60 * 60;
const SCRAPE_PIPELINE_MILESTONES: Array<{
	key: PipelineMilestoneKey;
	label: string;
	percent: number;
}> = [
	{
		key: "queued",
		label: "Getting ready to train",
		percent: 0,
	},
	{
		key: "scraping_pages",
		label: "Scraping pages",
		percent: 45,
	},
	{
		key: "pinecone_upsert_started",
		label: "Starting to learn from your data",
		percent: 55,
	},
	{
		key: "pinecone_embeddings_prepared",
		label: "Understanding your content",
		percent: 70,
	},
	{
		key: "pinecone_stale_chunk_cleanup_completed",
		label: "Organizing what was learned",
		percent: 80,
	},
	{
		key: "pinecone_upsert_completed",
		label: "Saving what was learned",
		percent: 90,
	},
	{
		key: "scraper_primary_pinecone_upsert_completed",
		label: "Training completed",
		percent: 100,
	},
];

const PIPELINE_STAGE_RANK: Record<
	PipelineStage,
	number
> = {
	queued: 0,
	scraping_pages: 1,
	pinecone_upsert_started: 2,
	pinecone_embeddings_prepared: 3,
	pinecone_stale_chunk_cleanup_completed: 4,
	pinecone_upsert_completed: 5,
	scraper_primary_pinecone_upsert_completed: 6,
	completed: 7,
	failed: 7,
};

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
			pipeline: status.pipeline
				? {
						...status.pipeline,
						updatedAt: new Date(
							status.pipeline.updatedAt,
						),
						milestones:
							status.pipeline.milestones.map(
								(milestone) => ({
									...milestone,
									completedAt:
										milestone.completedAt
											? new Date(
													milestone.completedAt,
											  )
											: undefined,
								}),
							),
				  }
				: undefined,
			startedAt: new Date(status.startedAt),
			completedAt: status.completedAt
				? new Date(status.completedAt)
				: undefined,
		};
	}

	private getMilestoneMeta(
		stage: PipelineMilestoneKey,
	): {
		label: string;
		percent: number;
	} {
		const milestone =
			SCRAPE_PIPELINE_MILESTONES.find(
				(item) => item.key === stage,
			);
		return {
			label: milestone?.label || stage,
			percent: milestone?.percent || 0,
		};
	}

	private buildPipelineState(
		existing: StoredScrapeJobStatus | null,
		update: {
			stage: PipelineStage;
			percent: number;
			label?: string;
		},
	): StoredScrapeJobStatus["pipeline"] {
		const updatedAt = new Date().toISOString();
		const resolvedLabel =
			update.label ||
			(update.stage !== "completed" &&
			update.stage !== "failed"
				? this.getMilestoneMeta(update.stage)
						.label
				: update.stage === "completed"
					? "Scrape completed"
					: "Scrape failed");

		return {
			stage: update.stage,
			label: resolvedLabel,
			percent: Math.max(
				0,
				Math.min(100, Math.round(update.percent)),
			),
			updatedAt,
			milestones:
				SCRAPE_PIPELINE_MILESTONES.map(
					(milestone) => {
						const previous =
							existing?.pipeline?.milestones.find(
								(item) =>
									item.key === milestone.key,
							);
						const currentRank =
							PIPELINE_STAGE_RANK[
								update.stage
							];
						const milestoneRank =
							PIPELINE_STAGE_RANK[
								milestone.key
							];
						const completed =
							previous?.completed ||
							currentRank > milestoneRank ||
							(currentRank ===
								milestoneRank &&
								update.percent >=
									milestone.percent);

						return {
							key: milestone.key,
							label: milestone.label,
							percent: milestone.percent,
							completed,
							completedAt: completed
								? previous?.completedAt ||
									updatedAt
								: undefined,
						};
					},
				),
		};
	}

	private deriveScrapingPercent(
		progress: ProgressUpdate,
		existing: StoredScrapeJobStatus,
	): number {
		const totalPages = Math.max(
			progress.totalPages,
			progress.scrapedPages,
			1,
		);
		const ratio = Math.min(
			1,
			progress.scrapedPages / totalPages,
		);
		return Math.max(
			existing.pipeline?.percent ?? 0,
			5 + Math.round(ratio * 40),
		);
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
			maxDepth: params.maxDepth ?? 0,
			maxPages: params.maxPages,
			status: "pending",
			progress: {
				totalPages: 0,
				scrapedPages: 0,
				storedPages: 0,
			},
			pipeline: this.buildPipelineState(null, {
				stage: "queued",
				percent: 0,
			}),
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
			pipeline:
				progress.stage && progress.percent !== undefined
					? this.buildPipelineState(existing, {
							stage: progress.stage,
							percent: progress.percent,
							label: progress.stageLabel,
					  })
					: PIPELINE_STAGE_RANK[
								existing.pipeline?.stage || "queued"
					  ] <=
					  PIPELINE_STAGE_RANK.scraping_pages
						? this.buildPipelineState(existing, {
								stage: "scraping_pages",
								percent:
									this.deriveScrapingPercent(
										progress,
										existing,
									),
						  })
						: existing.pipeline,
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
			pipeline: this.buildPipelineState(existing, {
				stage:
					progress.stage ?? "completed",
				percent:
					progress.percent ?? 100,
				label: progress.stageLabel,
			}),
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
			pipeline: this.buildPipelineState(existing, {
				stage: "failed",
				percent:
					existing.pipeline?.percent ??
					0,
				label:
					progress?.stageLabel ||
					"Scrape failed",
			}),
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

	async getProgress(jobId: string): Promise<{
		jobId: string;
		mode?: ScrapeJobStatus["mode"];
		url: string;
		currentUrl?: string;
		status: ScrapeJobStatus["status"];
		percent: number;
		stage: PipelineStage;
		stageLabel: string;
		pageProgress: ScrapeJobStatus["progress"];
		milestones: NonNullable<ScrapeJobStatus["pipeline"]>["milestones"];
		startedAt: Date;
		completedAt?: Date;
		error?: string;
	} | null> {
		const job = await this.getJob(jobId);
		if (!job) {
			return null;
		}

		return {
			jobId: job.jobId,
			mode: job.mode,
			url: job.url || "",
			currentUrl: job.currentUrl,
			status: job.status,
			percent: job.pipeline?.percent ?? 0,
			stage: job.pipeline?.stage ?? "queued",
			stageLabel:
				job.pipeline?.label || "Scrape queued",
			pageProgress: job.progress,
			milestones:
				job.pipeline?.milestones || [],
			startedAt: job.startedAt,
			completedAt: job.completedAt,
			error: job.error,
		};
	}
}

export const scraperStatusService =
	new ScraperStatusService();
