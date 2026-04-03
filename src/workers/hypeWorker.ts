import { Job, Worker } from "bullmq";
import { config } from "../config/env";
import { HYPE_QUEUE_NAME } from "../config/hypeQueue";
import { HypeJobPayload, processHypeChunks } from "../services/hypeService";
import { pineconeService } from "../services/pineconeService";
import { redisCache } from "../config/redis";
import logger from "../utils/logger";

const processHypeJob = async (job: Job<HypeJobPayload>) => {
	const { userId, rawChunks, websiteName, repairLockKey } = job.data;
	try {
		await processHypeChunks(
			userId,
			rawChunks,
			async (ownerId, hypeChunks) =>
				pineconeService.upsertChunks(ownerId, hypeChunks),
			websiteName,
		);
		return { userId, chunksProcessed: rawChunks.length };
	} finally {
		if (repairLockKey) {
			await redisCache.del(repairLockKey);
		}
	}
};

export const createHypeWorker = () => {
	const worker = new Worker(HYPE_QUEUE_NAME, processHypeJob, {
		prefix: "{bull}",
		connection: {
			host: config.REDIS_HOST,
			port: config.REDIS_PORT,
			username: config.REDIS_USERNAME,
			password: config.REDIS_PASSWORD,
			tls: config.REDIS_TLS_ENABLED ? {} : undefined,
			keepAlive: 30000,
			maxRetriesPerRequest: null,
			retryStrategy: (times: number) => Math.min(times * 50, 2000),
		},
		concurrency: 1,
		lockDuration: 7200000,
		lockRenewTime: 3600000,
	});

	worker.on("completed", (job) => {
		logger.info(`HyPE job ${job.id} completed`, { returnvalue: job.returnvalue });
	});

	worker.on("failed", (job, err) => {
		logger.error(`HyPE job ${job?.id} failed`, { error: err.message });
	});

	worker.on("error", (err) => {
		logger.error("HyPE worker error", { error: err.message });
	});

	return worker;
};
