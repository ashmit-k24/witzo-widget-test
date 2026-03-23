import { PgBoss } from "pg-boss";
import { config } from "./env";
import logger from "../utils/logger";

export const SCRAPER_QUEUE_NAME = "scraper-queue";

export const boss = new PgBoss({
	host: config.DB_HOST,
	port: config.DB_PORT,
	database: config.DB_NAME,
	user: config.DB_USER,
	password: config.DB_PASSWORD,
	ssl: config.DB_SSL_MODE ? { rejectUnauthorized: false } : false,

	// Connection pool — keep small; shared with the main pool
	max: 3,

	// Maintenance
	maintenanceIntervalSeconds: 120,
	monitorIntervalSeconds: 60,
});

boss.on("error", (error: Error) => {
	logger.error("[pg-boss] Error", { error: error.message });
});

/**
 * Start pg-boss and ensure all known queues exist.
 * pg-boss v12 requires explicit queue creation before workers can subscribe.
 */
export const startQueue = async (): Promise<void> => {
	await boss.start();

	// Create queues — idempotent; safe to call on every startup
	await boss.createQueue(SCRAPER_QUEUE_NAME, {
		// Jobs expire after 1 hour if not completed
		expireInSeconds: 60 * 60,
		// No retries — failed jobs stay failed
		retryLimit: 0,
		// Keep completed jobs for 1 hour, failed for 24 hours
		deleteAfterSeconds: 3600,
	});

	logger.info("[pg-boss] Queue started and queues ensured", {
		host: config.DB_HOST,
		database: config.DB_NAME,
	});
};

/**
 * Gracefully stop pg-boss. Call on SIGTERM/SIGINT.
 */
export const stopQueue = async (): Promise<void> => {
	await boss.stop();
	logger.info("[pg-boss] Queue stopped");
};
