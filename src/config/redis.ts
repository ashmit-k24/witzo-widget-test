import Redis from "ioredis";
import logger from "../utils/logger";
import { config } from "./env";

/**
 * All Redis roles share one Redis host/port/password.
 * We keep separate client instances only for connection behavior isolation.
 */
const sharedRedisConfig = {
	host: config.REDIS_HOST,
	port: config.REDIS_PORT,
	username: config.REDIS_USERNAME,
	password: config.REDIS_PASSWORD,
	retryStrategy(times: number) {
		const delay = Math.min(times * 50, 2000);
		return delay;
	},
	enableReadyCheck: true,
	...(config.REDIS_TLS_ENABLED
		? {
				tls: {},
			}
		: {}),
};

// Cache Redis configuration
const redisCacheConfig = {
	...sharedRedisConfig,
	maxRetriesPerRequest: 3,
};

// Queue Redis configuration (for BullMQ)
const redisQueueConfig = {
	...sharedRedisConfig,
	maxRetriesPerRequest: null,
};

// Analytics Redis configuration
const redisAnalyticsConfig = {
	...sharedRedisConfig,
	maxRetriesPerRequest: 3,
};

// Main Redis client for backward compatibility (uses cache config)
export const redis = new Redis(redisCacheConfig);

// Separate Redis instances for better isolation
export const redisCache = new Redis(
	redisCacheConfig,
);
export const redisQueue = new Redis(
	redisQueueConfig,
);
export const redisAnalytics = new Redis(
	redisAnalyticsConfig,
);

// Event handlers for Cache Redis
redisCache.on("connect", () => {
	logger.info("Redis Cache connected", {
		host: config.REDIS_HOST,
		port: config.REDIS_PORT,
	});
});

redisCache.on("error", (err) => {
	logger.error("Redis Cache connection error", {
		error: err.message,
	});
});

redisCache.on("ready", () => {
	logger.info("Redis Cache ready");
});

// Event handlers for Queue Redis
redisQueue.on("connect", () => {
	logger.info("Redis Queue connected", {
		host: config.REDIS_HOST,
		port: config.REDIS_PORT,
	});
});

redisQueue.on("error", (err) => {
	logger.error("Redis Queue connection error", {
		error: err.message,
	});
});

// Event handlers for Analytics Redis
redisAnalytics.on("connect", () => {
	logger.info("Redis Analytics connected", {
		host: config.REDIS_HOST,
		port: config.REDIS_PORT,
	});
});

redisAnalytics.on("error", (err) => {
	logger.error(
		"Redis Analytics connection error",
		{ error: err.message },
	);
});

// Backward compatibility - main redis client
redis.on("connect", () => {
	logger.info("Redis (main) connected");
});

redis.on("error", (err) => {
	logger.error("Redis (main) connection error", {
		error: err.message,
	});
});

// Create a duplicate connection for subscribers (Pub/Sub)
// Redis requires dedicated connections for subscribers
export const createRedisConnection = () =>
	new Redis(redisCacheConfig);

// Graceful shutdown
const gracefulShutdown = async () => {
	logger.info("Closing Redis connections...");
	await Promise.all([
		redis.quit(),
		redisCache.quit(),
		redisQueue.quit(),
		redisAnalytics.quit(),
	]);
	logger.info("All Redis connections closed");
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
