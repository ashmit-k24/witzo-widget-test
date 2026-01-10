import { scraperQueue } from "../config/queue";
import { ScrapedPage } from "../types";
import logger from "../utils/logger";

interface CrawlOptions {
     maxDepth?: number;
     maxPages?: number;
}

class ScraperService {
     // Kept for interface compatibility, though normalizeUrl/isValidUrl are now in worker
     // If other services use these, they should be moved to a shared util

     async scrapeWebsite(
          userId: string,
          url: string,
          options: CrawlOptions = {}
     ): Promise<{
          success: boolean;
          message: string;
          jobId?: string;
          totalPages: number; // For compatibility
          pages: ScrapedPage[]; // For compatibility (empty now)
     }> {
          try {
               const job = await scraperQueue.add("scrape-website", {
                    userId,
                    url,
                    maxDepth: options.maxDepth || 3,
                    maxPages: options.maxPages || 100,
               });

               logger.info(`Scrape job added to queue`, { jobId: job.id, userId, url });

               return {
                    success: true,
                    message: "Scraping started in background. You can check progress via the progress endpoint.",
                    jobId: job.id,
                    totalPages: 0, // Async, so we don't know yet
                    pages: [], // Async, so we don't return pages in response
               };
          } catch (error) {
               logger.error("Error adding scrape job to queue", { error, userId });
               throw error;
          }
     }

     async getScrapingProgress(userId: string): Promise<{ isScraping: boolean; jobs: any[] }> {
          try {
               // Get all jobs in active, waiting, or delayed states
               const jobs = await scraperQueue.getJobs(["active", "waiting", "delayed"]);

               logger.info(`[getScrapingProgress] Found ${jobs.length} total jobs in queue`, {
                    userId,
                    jobIds: jobs.map(j => j.id),
                    jobData: jobs.map(j => ({ id: j.id, userId: j.data?.userId, url: j.data?.url, state: j.name }))
               });

               // Filter jobs for the specific user
               const userJobs = jobs.filter((job) => job.data.userId === userId);

               logger.info(`[getScrapingProgress] Found ${userJobs.length} jobs for user ${userId}`, {
                    userJobs: userJobs.map(j => j.id)
               });

               return {
                    isScraping: userJobs.length > 0,
                    jobs: userJobs.map((job) => ({
                         id: job.id,
                         url: job.data.url,
                         progress: job.progress,
                         state: job.name, // or await job.getState() if needed, but name is usually the job name key
                    })),
               };
          } catch (error) {
               logger.error("Error getting scraping progress", { error, userId });
               return {
                    isScraping: false,
                    jobs: [],
               };
          }
     }
}

export const scraperService = new ScraperService();
