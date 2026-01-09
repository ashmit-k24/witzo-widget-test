import Redis from "ioredis";
import logger from "../utils/logger";
import { config } from "./env";

const redisConfig = {
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
        password: config.REDIS_PASSWORD,
        maxRetriesPerRequest: null, // Required for BullMQ
};

// Main Redis client for caching and sessions
export const redis = new Redis(redisConfig);

redis.on("connect", () => {
        logger.info("Redis connected");
});

redis.on("error", (err) => {
        logger.error("Redis connection error", { error: err.message });
});

// Create a duplicate connection for subscribers (Pub/Sub)
// Redis requires dedicated connections for subscribers
export const createRedisConnection = () => new Redis(redisConfig);
