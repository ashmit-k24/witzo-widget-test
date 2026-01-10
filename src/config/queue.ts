import { Queue } from "bullmq";
import { config } from "./env";

export const SCRAPER_QUEUE_NAME = "scraper-queue";

export const scraperQueue = new Queue(SCRAPER_QUEUE_NAME, {
        connection: {
                host: config.REDIS_QUEUE_HOST,
                port: config.REDIS_QUEUE_PORT,
                password: config.REDIS_QUEUE_PASSWORD,
        },
        defaultJobOptions: {
                attempts: 3,
                backoff: {
                        type: 'exponential',
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
});
