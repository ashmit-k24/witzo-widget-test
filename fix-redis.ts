import { redis } from "./src/config/redis";
import logger from "./src/utils/logger";

async function fixRedisPolicy() {
        try {
                logger.info("Current Policy:", await redis.config("GET", "maxmemory-policy"));

                logger.info("Setting maxmemory-policy to noeviction...");
                await redis.config("SET", "maxmemory-policy", "noeviction");

                logger.info("New Policy:", await redis.config("GET", "maxmemory-policy"));
                logger.info("Successfully updated Redis eviction policy!");
                process.exit(0);
        } catch (error) {
                logger.error("Failed to configure Redis:", error);
                process.exit(1);
        }
}

fixRedisPolicy();
