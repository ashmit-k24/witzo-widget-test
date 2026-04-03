import { Queue } from "bullmq";
import { config } from "./env";

export const HYPE_QUEUE_NAME = "hype-queue";

export const hypeQueue = new Queue(HYPE_QUEUE_NAME, {
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
	defaultJobOptions: {
		attempts: 3,
		backoff: {
			type: "exponential",
			delay: 3000,
		},
		removeOnComplete: { age: 3600, count: 100 },
		removeOnFail: { age: 86400 },
	},
});
