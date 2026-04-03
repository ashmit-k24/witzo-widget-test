import crypto from "crypto";
import pool from "../config/database";
import { redisCache } from "../config/redis";
import { config } from "../config/env";
import {
	HYPE_REPAIR_LOCK_TTL_MS,
} from "../constants";
import logger from "../utils/logger";
import { enqueueRepairAsync } from "./hypeService";
import { pineconeService } from "./pineconeService";
import { scraperStatusService } from "./scraperStatusService";

class HypeRepairService {
	private getSourceRepairLockKey(
		userId: string,
		sourceRoot: string,
	): string {
		const digest = crypto
			.createHash("sha1")
			.update(`${userId}|${sourceRoot}`)
			.digest("hex");
		return `hype:repair-lock:${userId}:${digest}`;
	}

	private async acquireSourceRepairLock(
		userId: string,
		sourceRoot: string,
	): Promise<string | null> {
		const key = this.getSourceRepairLockKey(
			userId,
			sourceRoot,
		);
		const result = await redisCache.set(
			key,
			new Date().toISOString(),
			"PX",
			HYPE_REPAIR_LOCK_TTL_MS,
			"NX",
		);
		return result === "OK" ? key : null;
	}

	private async releaseSourceRepairLock(
		lockKey: string | null,
	): Promise<void> {
		if (!lockKey) return;
		await redisCache.del(lockKey);
	}

	private async hasActiveScrapeJob(
		userId: string,
	): Promise<boolean> {
		const latestJob =
			await scraperStatusService.getLatestJobForUser(
				userId,
			);
		if (!latestJob) return false;
		return (
			["pending", "in_progress"].includes(
				latestJob.status,
			) &&
			(latestJob.mode === "scrape" ||
				latestJob.mode === "retrain")
		);
	}

	async repairMissingHypeForUser(userId: string): Promise<{
		sourcesScanned: number;
		sourcesQueued: number;
		sourcesSkipped: number;
		staleVectorsDeleted: number;
	}> {
		const expectedQuestionsPerChunk =
			config.HYPE_QUESTIONS_PER_CHUNK ?? 0;
		if (expectedQuestionsPerChunk <= 0) {
			return {
				sourcesScanned: 0,
				sourcesQueued: 0,
				sourcesSkipped: 0,
				staleVectorsDeleted: 0,
			};
		}

		if (await this.hasActiveScrapeJob(userId)) {
			logger.info(
				"Skipping HyPE repair because a scrape job is active",
				{ userId },
			);
			return {
				sourcesScanned: 0,
				sourcesQueued: 0,
				sourcesSkipped: 1,
				staleVectorsDeleted: 0,
			};
		}

		const coverages =
			await pineconeService.getWebsiteHypeCoverage(
				userId,
				expectedQuestionsPerChunk,
			);

		let sourcesQueued = 0;
		let sourcesSkipped = 0;
		let staleVectorsDeleted = 0;

		for (const coverage of coverages) {
			if (coverage.staleHypeVectorIds.length > 0) {
				await pineconeService.deleteVectorsByIds(
					userId,
					coverage.staleHypeVectorIds,
				);
				staleVectorsDeleted +=
					coverage.staleHypeVectorIds.length;
			}

			if (
				coverage.primaryChunkCount === 0 ||
				coverage.repairablePrimaryChunkCount === 0
			) {
				sourcesSkipped += 1;
				continue;
			}

			if (coverage.missingPrimaryChunks.length === 0) {
				continue;
			}

			const lockKey =
				await this.acquireSourceRepairLock(
					userId,
					coverage.sourceRoot,
				);
			if (!lockKey) {
				sourcesSkipped += 1;
				continue;
			}

			try {
				await enqueueRepairAsync(
					userId,
					coverage.missingPrimaryChunks,
					coverage.sourceRootTitle,
					lockKey,
				);
				sourcesQueued += 1;
				logger.info(
					"Queued HyPE repair for source",
					{
						userId,
						sourceRoot:
							coverage.sourceRoot,
						missingPrimaryChunks:
							coverage.missingPrimaryChunks
								.length,
						expectedHypeCount:
							coverage.expectedHypeCount,
						existingHypeCount:
							coverage.hypeChunkCount,
					},
				);
			} catch (error) {
				await this.releaseSourceRepairLock(lockKey);
				logger.error(
					"Failed to enqueue HyPE repair",
					{
						userId,
						sourceRoot:
							coverage.sourceRoot,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}
		}

		return {
			sourcesScanned: coverages.length,
			sourcesQueued,
			sourcesSkipped,
			staleVectorsDeleted,
		};
	}

	async processPendingRepairs(): Promise<void> {
		const expectedQuestionsPerChunk =
			config.HYPE_QUESTIONS_PER_CHUNK ?? 0;
		if (expectedQuestionsPerChunk <= 0) {
			return;
		}

		const result = await pool.query<{
			user_id: string;
		}>(
			`SELECT DISTINCT user_id
			 FROM rag_source_pages
			 WHERE source_type = 'website'`,
		);

		for (const row of result.rows) {
			try {
				const summary =
					await this.repairMissingHypeForUser(
						row.user_id,
					);
				if (
					summary.sourcesQueued > 0 ||
					summary.staleVectorsDeleted > 0
				) {
					logger.info(
						"HyPE repair pass completed for user",
						{
							userId: row.user_id,
							...summary,
						},
					);
				}
			} catch (error) {
				logger.error(
					"HyPE repair pass failed for user",
					{
						userId: row.user_id,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}
		}
	}
}

export const hypeRepairService =
	new HypeRepairService();
