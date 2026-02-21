import pool from "../config/database";
import {
	ANALYTICS_CLEANUP_INTERVAL_MS,
	ANALYTICS_RETENTION_DAYS,
	PARTITION_CHECK_INTERVAL_MS,
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

// ─── Worker entry point ─────────────────────────────────────────────────────

export function createMaintenanceWorker(): void {
	// Run immediately on startup so partitions exist from the first request
	ensureUpcomingPartitions();
	cleanupOldAnalytics();

	// Then run on recurring intervals
	setInterval(() => {
		ensureUpcomingPartitions().catch((error: Error) => {
			logger.error("Partition maintenance interval failed", {
				error: error.message,
			});
		});
	}, PARTITION_CHECK_INTERVAL_MS);

	setInterval(() => {
		cleanupOldAnalytics().catch((error: Error) => {
			logger.error("Analytics cleanup interval failed", {
				error: error.message,
			});
		});
	}, ANALYTICS_CLEANUP_INTERVAL_MS);

	logger.info("Maintenance worker started", {
		partitionCheckIntervalHours: PARTITION_CHECK_INTERVAL_MS / 3_600_000,
		analyticsCleanupIntervalDays:
			ANALYTICS_CLEANUP_INTERVAL_MS / 86_400_000,
		analyticsRetentionDays: ANALYTICS_RETENTION_DAYS,
	});
}
