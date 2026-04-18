import { Job, Worker } from "bullmq";
import { config } from "../config/env";
import { HYPE_QUEUE_NAME } from "../config/queue";
import { RagChunk } from "../types";
import logger from "../utils/logger";
import { upsertHypeAsync } from "../services/hypeService";

export interface HypeJobData {
	userId: string;
	sourceUrl: string;
	chunks: RagChunk[];
}

const processHypeJob = async (job: Job<HypeJobData>): Promise<void> => {
	const { userId, sourceUrl, chunks } = job.data;
	logger.info("hypeWorker: processing job", {
		jobId: job.id,
		userId,
		sourceUrl,
		chunks: chunks.length,
	});
	await upsertHypeAsync(userId, sourceUrl, chunks);
};

export const createHypeWorker = () => {
	const worker = new Worker<HypeJobData>(
		HYPE_QUEUE_NAME,
		processHypeJob,
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
			concurrency: 2,
		// HyPE jobs on large sites can take 10-20 minutes (batched OpenAI calls).
		// BullMQ default lock is 30s — without a longer lockDuration the job
		// is considered stalled and re-queued while still running, causing duplicate
		// vector upserts. 2 hours covers the largest realistic site.
		lockDuration: 7_200_000,
		lockRenewTime: 60_000,
		},
	);

	worker.on("completed", (job) => {
		logger.info("hypeWorker: job completed", { jobId: job.id });
	});

	worker.on("failed", (job, err) => {
		logger.error("hypeWorker: job failed", {
			jobId: job?.id,
			error: err.message,
			attempt: job?.attemptsMade,
		});
	});

	worker.on("error", (err) => {
		logger.error("hypeWorker: worker error", { error: err.message });
	});

	return worker;
};

if (require.main === module) {
	const worker = createHypeWorker();
	logger.info("HyPE worker started as standalone process", {
		redisHost: config.REDIS_HOST,
		redisPort: config.REDIS_PORT,
	});

	const shutdown = async () => {
		logger.info("HyPE worker shutting down...");
		await worker.close();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
