import axios from "axios";
import * as cheerio from "cheerio";
import { scraperQueue } from "../config/queue";
import { ScrapedPage } from "../types";
import logger from "../utils/logger";

interface CrawlOptions {
	maxDepth?: number;
	maxPages?: number;
}

interface PageCountResult {
	totalPages: number;
	discoveredUrls: string[];
	baseUrl: string;
	estimatedTime: string;
}

class ScraperService {
	// Kept for interface compatibility, though normalizeUrl/isValidUrl are now in worker
	// If other services use these, they should be moved to a shared util

	async scrapeWebsite(
		userId: string,
		url: string,
		options: CrawlOptions = {},
	): Promise<{
		success: boolean;
		message: string;
		jobId?: string;
		totalPages: number; // For compatibility
		pages: ScrapedPage[]; // For compatibility (empty now)
	}> {
		try {
			const job = await scraperQueue.add(
				"scrape-website",
				{
					userId,
					url,
					maxDepth: options.maxDepth || 3,
					maxPages: options.maxPages || 100,
				},
			);

			logger.info(`Scrape job added to queue`, {
				jobId: job.id,
				userId,
				url,
			});

			return {
				success: true,
				message:
					"Scraping started in background. You can check progress via the progress endpoint.",
				jobId: job.id,
				totalPages: 0, // Async, so we don't know yet
				pages: [], // Async, so we don't return pages in response
			};
		} catch (error) {
			logger.error(
				"Error adding scrape job to queue",
				{ error, userId },
			);
			throw error;
		}
	}

	async getScrapingProgress(
		userId: string,
	): Promise<{
		isScraping: boolean;
		jobs: any[];
	}> {
		try {
			// Get all jobs in active, waiting, or delayed states
			const jobs = await scraperQueue.getJobs([
				"active",
				"waiting",
				"delayed",
			]);

			logger.info(
				`[getScrapingProgress] Found ${jobs.length} total jobs in queue`,
				{
					userId,
					jobIds: jobs.map((j) => j.id),
					jobData: jobs.map((j) => ({
						id: j.id,
						userId: j.data?.userId,
						url: j.data?.url,
						state: j.name,
					})),
				},
			);

			// Filter jobs for the specific user
			const userJobs = jobs.filter(
				(job) => job.data.userId === userId,
			);

			logger.info(
				`[getScrapingProgress] Found ${userJobs.length} jobs for user ${userId}`,
				{
					userJobs: userJobs.map((j) => j.id),
				},
			);

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
			logger.error(
				"Error getting scraping progress",
				{ error, userId },
			);
			return {
				isScraping: false,
				jobs: [],
			};
		}
	}

	private normalizeUrl(
		url: string,
		baseUrl: string,
	): string | null {
		try {
			const urlObj = new URL(url, baseUrl);
			// Remove hash and trailing slash
			urlObj.hash = "";
			let normalized = urlObj.href;
			if (normalized.endsWith("/")) {
				normalized = normalized.slice(0, -1);
			}
			return normalized;
		} catch {
			return null;
		}
	}

	private isValidInternalUrl(
		url: string,
		baseHostname: string,
	): boolean {
		try {
			const urlObj = new URL(url);
			return urlObj.hostname === baseHostname;
		} catch {
			return false;
		}
	}

	async countAvailablePages(
		url: string,
		maxDepth: number = 3,
		maxPages: number = 100,
	): Promise<PageCountResult> {
		const startTime = Date.now();
		const baseUrlObj = new URL(url);
		const baseHostname = baseUrlObj.hostname;
		const baseUrl = `${baseUrlObj.protocol}//${baseHostname}`;

		const discoveredUrls = new Set<string>();
		const visitedUrls = new Set<string>();
		const queue: {
			url: string;
			depth: number;
		}[] = [{ url, depth: 0 }];

		discoveredUrls.add(url);

		logger.info(
			`Starting page count for ${url}`,
			{ maxDepth, maxPages },
		);

		while (
			queue.length > 0 &&
			discoveredUrls.size < maxPages
		) {
			const current = queue.shift();
			if (
				!current ||
				visitedUrls.has(current.url)
			)
				continue;
			if (current.depth > maxDepth) continue;

			visitedUrls.add(current.url);

			try {
				// Quick HEAD request first to check if page exists
				const response = await axios.get(
					current.url,
					{
						timeout: 5000,
						maxRedirects: 3,
						headers: {
							"User-Agent":
								"Mozilla/5.0 (compatible; WitzoBot/1.0; +https://witzo.ai)",
						},
					},
				);

				if (response.status !== 200) continue;

				const contentType =
					response.headers["content-type"] || "";
				if (!contentType.includes("text/html"))
					continue;

				const $ = cheerio.load(response.data);

				// Extract all links
				$("a[href]").each((_, element) => {
					if (discoveredUrls.size >= maxPages)
						return false;

					const href = $(element).attr("href");
					if (!href) return true;

					const normalizedUrl = this.normalizeUrl(
						href,
						current.url,
					);
					if (!normalizedUrl) return true;

					if (
						!discoveredUrls.has(normalizedUrl) &&
						this.isValidInternalUrl(
							normalizedUrl,
							baseHostname,
						)
					) {
						discoveredUrls.add(normalizedUrl);
						if (current.depth < maxDepth) {
							queue.push({
								url: normalizedUrl,
								depth: current.depth + 1,
							});
						}
					}
					return true;
				});
			} catch (error) {
				// Skip failed URLs silently during counting
				logger.debug(
					`Failed to fetch ${current.url} during page count`,
					{
						error,
					},
				);
			}
		}

		const elapsedTime = Date.now() - startTime;
		const estimatedScrapingTime = Math.ceil(
			(discoveredUrls.size * 2) / 60,
		); // ~2 seconds per page

		logger.info(
			`Page count completed for ${url}`,
			{
				totalPages: discoveredUrls.size,
				timeElapsed: `${elapsedTime}ms`,
			},
		);

		return {
			totalPages: discoveredUrls.size,
			discoveredUrls: Array.from(
				discoveredUrls,
			).slice(0, 50), // Return first 50 URLs as sample
			baseUrl,
			estimatedTime: `${estimatedScrapingTime} minute${estimatedScrapingTime !== 1 ? "s" : ""}`,
		};
	}
}

export const scraperService =
	new ScraperService();
