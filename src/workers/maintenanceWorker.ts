import fs from "fs/promises";
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

async function cleanupUploadedFiles(): Promise<void> {
	const uploadDir = path.join(__dirname, "../../uploads");

	try {
		await fs.access(uploadDir);
	} catch {
		return;
	}

	const maxAgeMs = UPLOAD_MAX_AGE_HOURS * 60 * 60 * 1000;
	const cutoff = Date.now() - maxAgeMs;
	let deleted = 0;
	let errors = 0;

	try {
		const entries = await fs.readdir(uploadDir);
		await Promise.allSettled(
			entries.map(async (entry) => {
				const filePath = path.join(uploadDir, entry);
				try {
					const stat = await fs.stat(filePath);
					if (stat.isFile() && stat.mtimeMs < cutoff) {
						await fs.unlink(filePath);
						deleted++;
					}
				} catch (err) {
					errors++;
					logger.warn("Upload cleanup: failed to delete file", {
						file: entry,
						error: (err as Error).message,
					});
				}
			}),
		);

		logger.info("Upload cleanup: stale files removed", {
			deleted,
			errors,
			maxAgeHours: UPLOAD_MAX_AGE_HOURS,
		});
	} catch (error) {
		const err = error as Error;
		logger.error("Upload cleanup: failed to read uploads directory", {
			error: err.message,
		});
	}
}

// ─── CRM dead-event alerting ────────────────────────────────────────────────
// Issue 11: alert on stuck/dead CRM sync events so ops can investigate

async function alertDeadCrmEvents(): Promise<void> {
	const tables = [
		"hubspot_sync_events",
		"zoho_sync_events",
		"salesforce_sync_events",
		"lead_webhook_events",
	];

	for (const table of tables) {
		try {
			const result = await pool.query<{ count: string }>(
				`SELECT COUNT(*) AS count FROM ${table} WHERE status = 'dead'`,
			);
			const count = parseInt(result.rows[0]?.count ?? "0", 10);
			if (count > 0) {
				logger.warn(
					`CRM dead-event alert: ${count} dead events in ${table} — manual intervention required`,
					{ table, deadCount: count },
				);
			}
		} catch (error) {
			// Table may not exist if integration is not set up — silently skip
		}
	}
}

// ─── Worker entry point ─────────────────────────────────────────────────────

export interface MaintenanceWorkerHandle {
	close: () => Promise<void>;
}

export function createMaintenanceWorker(): MaintenanceWorkerHandle {
	// Run immediately on startup
	ensureUpcomingPartitions();
	cleanupOldAnalytics();
	cleanupUploadedFiles();
	alertDeadCrmEvents();

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

	// Check for dead CRM events every 6 hours
	const crmAlertInterval = setInterval(() => {
		alertDeadCrmEvents().catch((error: Error) => {
			logger.error("CRM dead-event alert failed", { error: error.message });
		});
	}, 6 * 60 * 60 * 1000);

	logger.info("Maintenance worker started", {
		partitionCheckIntervalHours: PARTITION_CHECK_INTERVAL_MS / 3_600_000,
		analyticsCleanupIntervalDays: ANALYTICS_CLEANUP_INTERVAL_MS / 86_400_000,
		analyticsRetentionDays: ANALYTICS_RETENTION_DAYS,
		uploadMaxAgeHours: UPLOAD_MAX_AGE_HOURS,
	});

	return {
		close: async () => {
			clearInterval(partitionInterval);
			clearInterval(analyticsInterval);
			clearInterval(uploadCleanupInterval);
			clearInterval(crmAlertInterval);
			logger.info("Maintenance worker stopped");
		},
	};
}

// Self-execute when run as a standalone process
if (require.main === module) {
	const worker = createMaintenanceWorker();
	logger.info("Maintenance worker started as standalone process");

	const shutdown = async () => {
		logger.info("Maintenance worker shutting down...");
		await worker.close();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
