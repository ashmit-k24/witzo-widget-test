import { Job, Worker } from "bullmq";
import { config } from "../config/env";
import { SCRAPER_QUEUE_NAME } from "../config/queue";
import {
	runScrapeJob,
	ScrapeJobPayload,
} from "../services/scrapeJobService";
import logger from "../utils/logger";

export interface ScrapeJobData
	extends ScrapeJobPayload {}

const processScrapeJob = async (
	job: Job<ScrapeJobData>,
) => {
	const started = await runScrapeJob(job.data, {
		source: "queue",
		updateExternalProgress: async (
			progress,
		) => {
			await job.updateProgress(progress);
		},
	});

	return {
		started,
		jobId: job.data.jobId,
		mode: job.data.mode,
	};
};

export const createScraperWorker = () => {
	const worker = new Worker(
		SCRAPER_QUEUE_NAME,
		processScrapeJob,
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
			concurrency: config.SCRAPER_CONCURRENCY,
		},
	);

	worker.on("completed", (job) => {
		logger.info(`Job ${job.id} completed`, {
			returnvalue: job.returnvalue,
		});
	});

	worker.on("failed", (job, err) => {
		logger.error(`Job ${job?.id} failed`, {
			error: err.message,
		});
	});

	worker.on("error", (err) => {
		logger.error("Scraper worker error", { error: err.message });
	});

	return worker;
};

// Self-execute when run as a standalone script (e.g. via PM2 ecosystem.config.js)
if (require.main === module) {
	const worker = createScraperWorker();
	logger.info("Scraper worker started as standalone process", {
		concurrency: config.SCRAPER_CONCURRENCY,
		redisHost: config.REDIS_HOST,
		redisPort: config.REDIS_PORT,
	});

	const shutdown = async () => {
		logger.info("Scraper worker shutting down...");
		await worker.close();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
