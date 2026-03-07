import fs from "fs";
import path from "path";
import pool from "../config/database";
import {
	ANALYTICS_CLEANUP_INTERVAL_MS,
	ANALYTICS_RETENTION_DAYS,
	PARTITION_CHECK_INTERVAL_MS,
	UPLOAD_CLEANUP_INTERVAL_MS,
	UPLOAD_MAX_AGE_HOURS,
} from "../constants";
import logger from "../utils/logger";

// ─── Partition automation ───────────────────────────────────────────────────
//
// The migration that created chat_messages only creates partitions for the
// current and next calendar month at the time it runs.  After that, any new
// messages fall into the DEFAULT catch-all partition, which is an unpartitioned
// heap — defeating the entire point of time-range partitioning.
//
// This worker runs the partition-creation check once on startup and then every
// 24 hours.  The SQL is fully idempotent (CREATE TABLE IF NOT EXISTS), so
// multiple runs are safe.  Running daily means we always have at least the
// next two months' partitions created before they are needed.

async function ensureUpcomingPartitions(): Promise<void> {
	try {
		await pool.query(`
			DO $$
			DECLARE
				i INTEGER;
				target_start DATE;
				target_end   DATE;
				table_name   TEXT;
			BEGIN
				-- Ensure we always have partitions for the next 3 calendar months
				FOR i IN 0..2 LOOP
					target_start := date_trunc('month', CURRENT_DATE + (i || ' month')::INTERVAL)::date;
					target_end   := date_trunc('month', CURRENT_DATE + ((i + 1) || ' month')::INTERVAL)::date;
					table_name   := 'chat_messages_' || to_char(target_start, 'YYYYMM');

					EXECUTE format(
						'CREATE TABLE IF NOT EXISTS %I PARTITION OF chat_messages FOR VALUES FROM (%L) TO (%L)',
						table_name,
						target_start::text,
						target_end::text
					);
				END LOOP;
			END $$;
		`);

		logger.info("Partition maintenance: upcoming partitions verified");
	} catch (error) {
		const err = error as Error;
		logger.error("Partition maintenance: failed to create partitions", {
			error: err.message,
		});
	}
}

// ─── widget_analytics cleanup ───────────────────────────────────────────────
//
// widget_analytics is not partitioned and has no retention policy, so it grows
// unboundedly.  Records older than 90 days are no longer useful for live
// dashboards; they are deleted weekly.

async function cleanupOldAnalytics(): Promise<void> {
	try {
		const result = await pool.query(
			`DELETE FROM widget_analytics
			 WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
			[ANALYTICS_RETENTION_DAYS],
		);

		logger.info("Analytics cleanup: old records deleted", {
			rowsDeleted: result.rowCount,
			retentionDays: ANALYTICS_RETENTION_DAYS,
		});
	} catch (error) {
		const err = error as Error;
		logger.error("Analytics cleanup: failed", {
			error: err.message,
		});
	}
}

// ─── Upload directory cleanup ────────────────────────────────────────────────
//
// Uploaded files (PDFs, docs, etc.) are processed and stored in Pinecone.
// The local copies are no longer needed after processing.  Files older than
// UPLOAD_MAX_AGE_HOURS are deleted daily to prevent unbounded disk growth.

async function cleanupUploadedFiles(): Promise<void> {
	const uploadDir = path.join(
		__dirname,
		"../../uploads",
	);

	if (!fs.existsSync(uploadDir)) {
		return;
	}

	const maxAgeMs =
		UPLOAD_MAX_AGE_HOURS * 60 * 60 * 1000;
	const cutoff = Date.now() - maxAgeMs;
	let deleted = 0;
	let errors = 0;

	try {
		const entries = fs.readdirSync(uploadDir);
		for (const entry of entries) {
			const filePath = path.join(
				uploadDir,
				entry,
			);
			try {
				const stat = fs.statSync(filePath);
				if (
					stat.isFile() &&
					stat.mtimeMs < cutoff
				) {
					fs.unlinkSync(filePath);
					deleted++;
				}
			} catch (err) {
				errors++;
				logger.warn(
					"Upload cleanup: failed to delete file",
					{
						file: entry,
						error: (err as Error).message,
					},
				);
			}
		}

		logger.info(
			"Upload cleanup: stale files removed",
			{
				deleted,
				errors,
				maxAgeHours: UPLOAD_MAX_AGE_HOURS,
			},
		);
	} catch (error) {
		const err = error as Error;
		logger.error(
			"Upload cleanup: failed to read uploads directory",
			{ error: err.message },
		);
	}
}

// ─── Worker entry point ─────────────────────────────────────────────────────

export interface MaintenanceWorkerHandle {
	close: () => Promise<void>;
}

export function createMaintenanceWorker(): MaintenanceWorkerHandle {
	// Run immediately on startup so partitions exist from the first request
	ensureUpcomingPartitions();
	cleanupOldAnalytics();
	cleanupUploadedFiles();

	// Then run on recurring intervals
	const partitionInterval = setInterval(() => {
		ensureUpcomingPartitions().catch((error: Error) => {
			logger.error("Partition maintenance interval failed", {
				error: error.message,
			});
		});
	}, PARTITION_CHECK_INTERVAL_MS);

	const analyticsInterval = setInterval(() => {
		cleanupOldAnalytics().catch((error: Error) => {
			logger.error("Analytics cleanup interval failed", {
				error: error.message,
			});
		});
	}, ANALYTICS_CLEANUP_INTERVAL_MS);

	const uploadCleanupInterval = setInterval(() => {
		cleanupUploadedFiles().catch((error: Error) => {
			logger.error("Upload cleanup interval failed", {
				error: error.message,
			});
		});
	}, UPLOAD_CLEANUP_INTERVAL_MS);

	logger.info("Maintenance worker started", {
		partitionCheckIntervalHours: PARTITION_CHECK_INTERVAL_MS / 3_600_000,
		analyticsCleanupIntervalDays:
			ANALYTICS_CLEANUP_INTERVAL_MS / 86_400_000,
		analyticsRetentionDays: ANALYTICS_RETENTION_DAYS,
		uploadMaxAgeHours: UPLOAD_MAX_AGE_HOURS,
	});

	return {
		close: async () => {
			clearInterval(partitionInterval);
			clearInterval(analyticsInterval);
			clearInterval(uploadCleanupInterval);
			logger.info("Maintenance worker stopped");
		},
	};
}
