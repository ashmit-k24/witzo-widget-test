import Redis from "ioredis";
import logger from "../utils/logger";
import { config } from "./env";

/**
 * Separate Redis instances for better scalability and isolation
 * - Cache Redis: Widget keys, user sessions, general caching
 * - Queue Redis: BullMQ job queue (requires maxRetriesPerRequest: null)
 * - Analytics Redis: Event buffering and analytics data
 */

// Cache Redis configuration
const redisCacheConfig = {
     host: config.REDIS_CACHE_HOST,
     port: config.REDIS_CACHE_PORT,
     password: config.REDIS_CACHE_PASSWORD,
     retryStrategy(times: number) {
          const delay = Math.min(times * 50, 2000);
          return delay;
     },
     enableReadyCheck: true,
     maxRetriesPerRequest: 3,
};

// Queue Redis configuration (for BullMQ)
const redisQueueConfig = {
     host: config.REDIS_QUEUE_HOST,
     port: config.REDIS_QUEUE_PORT,
     password: config.REDIS_QUEUE_PASSWORD,
     maxRetriesPerRequest: null,
     retryStrategy(times: number) {
          const delay = Math.min(times * 50, 2000);
          return delay;
     },
};

// Analytics Redis configuration
const redisAnalyticsConfig = {
     host: config.REDIS_ANALYTICS_HOST,
     port: config.REDIS_ANALYTICS_PORT,
     password: config.REDIS_ANALYTICS_PASSWORD,
     retryStrategy(times: number) {
          const delay = Math.min(times * 50, 2000);
          return delay;
     },
     maxRetriesPerRequest: 3,
};

// Main Redis client for backward compatibility (uses cache config)
export const redis = new Redis(redisCacheConfig);

// Separate Redis instances for better isolation
export const redisCache = new Redis(redisCacheConfig);
export const redisQueue = new Redis(redisQueueConfig);
export const redisAnalytics = new Redis(redisAnalyticsConfig);

// Event handlers for Cache Redis
redisCache.on("connect", () => {
     logger.info("Redis Cache connected", {
          host: config.REDIS_CACHE_HOST,
          port: config.REDIS_CACHE_PORT,
     });
});

redisCache.on("error", (err) => {
     logger.error("Redis Cache connection error", { error: err.message });
});

redisCache.on("ready", () => {
     logger.info("Redis Cache ready");
});

// Event handlers for Queue Redis
redisQueue.on("connect", () => {
     logger.info("Redis Queue connected", {
          host: config.REDIS_QUEUE_HOST,
          port: config.REDIS_QUEUE_PORT,
     });
});

redisQueue.on("error", (err) => {
     logger.error("Redis Queue connection error", { error: err.message });
});

// Event handlers for Analytics Redis
redisAnalytics.on("connect", () => {
     logger.info("Redis Analytics connected", {
          host: config.REDIS_ANALYTICS_HOST,
          port: config.REDIS_ANALYTICS_PORT,
     });
});

redisAnalytics.on("error", (err) => {
     logger.error("Redis Analytics connection error", { error: err.message });
});

// Backward compatibility - main redis client
redis.on("connect", () => {
     logger.info("Redis (main) connected");
});

redis.on("error", (err) => {
     logger.error("Redis (main) connection error", { error: err.message });
});

// Create a duplicate connection for subscribers (Pub/Sub)
// Redis requires dedicated connections for subscribers
export const createRedisConnection = () => new Redis(redisCacheConfig);

// Graceful shutdown
const gracefulShutdown = async () => {
     logger.info("Closing Redis connections...");
     await Promise.all([redis.quit(), redisCache.quit(), redisQueue.quit(), redisAnalytics.quit()]);
     logger.info("All Redis connections closed");
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
