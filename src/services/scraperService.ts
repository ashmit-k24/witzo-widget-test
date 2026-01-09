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

     async getScrapingProgress(_userId: string): Promise<any> {
          // This method needs to be updated to check job status from Queue if we want real progress
          // For now, simple implementation or we can query BullMQ API
          // Ideally we store job ID in DB associated with user, or query active jobs for user

          return {
               message: "Check job status using job ID (implementation pending)",
               queuedPages: await scraperQueue.count(),
          };
     }
}

export const scraperService = new ScraperService();
