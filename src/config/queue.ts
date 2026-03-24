import { Queue } from "bullmq";
import { config } from "./env";

export const SCRAPER_QUEUE_NAME = "scraper-queue";

export const scraperQueue = new Queue(
	SCRAPER_QUEUE_NAME,
	{
		prefix: "{bull}",
		connection: {
			host: config.REDIS_HOST,
			port: config.REDIS_PORT,
			username: config.REDIS_USERNAME,
			password: config.REDIS_PASSWORD,
			tls: config.REDIS_TLS_ENABLED ? {} : undefined,
			keepAlive: 30000,
			maxRetriesPerRequest: null,
			retryStrategy: (times: number) =>
				Math.min(times * 50, 2000),
		},
		defaultJobOptions: {
			attempts: 3,
			backoff: {
				type: "exponential",
				delay: 2000,
			},
			removeOnComplete: {
				age: 3600, // Keep completed jobs for 1 hour
				count: 100, // Keep last 100 completed jobs
			},
			removeOnFail: {
				age: 86400, // Keep failed jobs for 24 hours
			},
		},
	},
);
