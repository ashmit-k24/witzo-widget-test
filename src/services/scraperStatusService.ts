import crypto from "crypto";
import pool from "../config/database";
import { ScrapeJobStatus } from "../types";
import logger from "../utils/logger";

type ScrapeMode = "scrape" | "retrain";

interface StartJobParams {
	userId: string;
	url: string;
	mode: ScrapeMode;
	maxDepth: number;
	maxPages: number;
}

interface ProgressUpdate {
	totalPages: number;
	scrapedPages: number;
	storedPages: number;
	currentUrl?: string;
}

class ScraperStatusService {
	private async assertUserExists(
		userId: string,
	): Promise<void> {
		const result = await pool.query(
			`SELECT 1 FROM users WHERE id = $1 LIMIT 1`,
			[userId],
		);
		if (result.rows.length === 0) {
			throw new Error(
				`Cannot start scrape job: user ${userId} does not exist in users table.`,
			);
		}
	}

	private rowToStatus(row: any): ScrapeJobStatus {
		return {
			jobId: row.job_id,
			userId: row.user_id,
			url: row.url,
			mode: row.mode as ScrapeMode,
			currentUrl: row.current_url ?? row.url,
			maxDepth: row.max_depth,
			maxPages: row.max_pages,
			status: row.status,
			progress: {
				totalPages: row.total_pages,
				scrapedPages: row.scraped_pages,
				storedPages: row.stored_pages,
			},
			startedAt: new Date(row.started_at),
			completedAt: row.completed_at
				? new Date(row.completed_at)
				: undefined,
			error: row.error ?? undefined,
		};
	}

	async startJob(params: StartJobParams): Promise<ScrapeJobStatus> {
		await this.assertUserExists(params.userId);
		const jobId = crypto.randomUUID();
		const result = await pool.query(
			`INSERT INTO scraper_jobs
				(job_id, user_id, url, mode, current_url, max_depth, max_pages, status,
				 total_pages, scraped_pages, stored_pages, started_at, updated_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',0,0,0,NOW(),NOW())
			 RETURNING *`,
			[
				jobId,
				params.userId,
				params.url,
				params.mode,
				params.url,
				params.maxDepth,
				params.maxPages,
			],
		);
		return this.rowToStatus(result.rows[0]);
	}

	async updateProgress(
		jobId: string,
		progress: ProgressUpdate,
	): Promise<ScrapeJobStatus | null> {
		const totalPages = Math.max(
			progress.totalPages,
			progress.scrapedPages,
			progress.storedPages,
		);
		const result = await pool.query(
			`UPDATE scraper_jobs SET
				status        = 'in_progress',
				current_url   = COALESCE($2, current_url),
				total_pages   = $3,
				scraped_pages = $4,
				stored_pages  = $5,
				updated_at    = NOW()
			 WHERE job_id = $1
			 RETURNING *`,
			[
				jobId,
				progress.currentUrl ?? null,
				totalPages,
				progress.scrapedPages,
				progress.storedPages,
			],
		);
		if (result.rows.length === 0) return null;
		return this.rowToStatus(result.rows[0]);
	}

	async completeJob(
		jobId: string,
		progress: ProgressUpdate,
	): Promise<ScrapeJobStatus | null> {
		const totalPages = Math.max(
			progress.totalPages,
			progress.scrapedPages,
			progress.storedPages,
		);
		const result = await pool.query(
			`UPDATE scraper_jobs SET
				status        = 'completed',
				current_url   = COALESCE($2, current_url),
				total_pages   = $3,
				scraped_pages = $4,
				stored_pages  = $5,
				completed_at  = NOW(),
				updated_at    = NOW()
			 WHERE job_id = $1
			 RETURNING *`,
			[
				jobId,
				progress.currentUrl ?? null,
				totalPages,
				progress.scrapedPages,
				progress.storedPages,
			],
		);
		if (result.rows.length === 0) return null;
		return this.rowToStatus(result.rows[0]);
	}

	async failJob(
		jobId: string,
		errorMessage: string,
		progress?: Partial<ProgressUpdate>,
	): Promise<ScrapeJobStatus | null> {
		const result = await pool.query(
			`UPDATE scraper_jobs SET
				status        = 'failed',
				error         = $2,
				current_url   = COALESCE($3, current_url),
				total_pages   = COALESCE($4, total_pages),
				scraped_pages = COALESCE($5, scraped_pages),
				stored_pages  = COALESCE($6, stored_pages),
				completed_at  = NOW(),
				updated_at    = NOW()
			 WHERE job_id = $1
			 RETURNING *`,
			[
				jobId,
				errorMessage,
				progress?.currentUrl ?? null,
				progress?.totalPages ?? null,
				progress?.scrapedPages ?? null,
				progress?.storedPages ?? null,
			],
		);
		if (result.rows.length === 0) return null;
		return this.rowToStatus(result.rows[0]);
	}

	async getJob(jobId: string): Promise<ScrapeJobStatus | null> {
		try {
			const result = await pool.query(
				`SELECT * FROM scraper_jobs WHERE job_id = $1`,
				[jobId],
			);
			if (result.rows.length === 0) return null;
			return this.rowToStatus(result.rows[0]);
		} catch (error) {
			logger.error("Error fetching scraper job", { error, jobId });
			return null;
		}
	}

	async getLatestJobForUser(
		userId: string,
	): Promise<ScrapeJobStatus | null> {
		try {
			const result = await pool.query(
				`SELECT * FROM scraper_jobs
				 WHERE user_id = $1
				 ORDER BY updated_at DESC
				 LIMIT 1`,
				[userId],
			);
			if (result.rows.length === 0) return null;
			return this.rowToStatus(result.rows[0]);
		} catch (error) {
			logger.error("Error fetching latest scraper job", {
				error,
				userId,
			});
			return null;
		}
	}
}

export const scraperStatusService = new ScraperStatusService();
