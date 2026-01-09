import { Queue } from "bullmq";
import { config } from "./env";

export const SCRAPER_QUEUE_NAME = "scraper-queue";

export const scraperQueue = new Queue(SCRAPER_QUEUE_NAME, {
        connection: {
                host: config.REDIS_HOST,
                port: config.REDIS_PORT,
                password: config.REDIS_PASSWORD,
        },
});
