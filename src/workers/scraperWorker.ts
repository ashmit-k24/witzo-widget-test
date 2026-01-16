import axios from "axios";
import { Job, Worker } from "bullmq";
import * as cheerio from "cheerio";
import { URL } from "url";
import { config } from "../config/env";
import { SCRAPER_QUEUE_NAME } from "../config/queue";
import { pineconeService } from "../services/pineconeService";
import { ScrapedPage } from "../types";
import logger from "../utils/logger";

export interface ScrapeJobData {
	userId: string;
	url: string;
	maxDepth: number;
	maxPages: number;
}

// Reusing helper functions from original service, adapted for standalone worker
const normalizeUrl = (url: string): string => {
	try {
		const urlObj = new URL(url);
		urlObj.hash = "";
		return urlObj.href.replace(/\/$/, "");
	} catch (error) {
		return url;
	}
};

const isValidUrl = (
	url: string,
	baseUrl: string,
): boolean => {
	try {
		const urlObj = new URL(url);
		const baseUrlObj = new URL(baseUrl);

		// Normalize hostnames
		const normalizeHostname = (
			hostname: string,
		) => hostname.replace(/^www\./, "");
		const urlHostname = normalizeHostname(
			urlObj.hostname,
		);
		const baseHostname = normalizeHostname(
			baseUrlObj.hostname,
		);

		if (urlHostname !== baseHostname)
			return false;

		const excludeExtensions = [
			".pdf",
			".jpg",
			".jpeg",
			".png",
			".gif",
			".svg",
			".webp",
			".zip",
			".rar",
			".exe",
			".dmg",
			".doc",
			".docx",
			".xls",
			".xlsx",
			".ppt",
			".pptx",
			".mp4",
			".mp3",
			".avi",
			".mov",
			".wav",
			".css",
			".js",
			".json",
			".xml",
		];

		if (
			excludeExtensions.some((ext) =>
				urlObj.pathname
					.toLowerCase()
					.endsWith(ext),
			)
		)
			return false;
		if (!urlObj.protocol.startsWith("http"))
			return false;

		return true;
	} catch (error) {
		return false;
	}
};

const fetchPageContent = async (
	url: string,
): Promise<string> => {
	const response = await axios.get(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
		},
		timeout: 10000,
	});
	return response.data;
};

const extractPageData = (
	html: string,
	url: string,
): ScrapedPage => {
	const $ = cheerio.load(html);
	$("script, style, noscript, iframe").remove();

	const title =
		$("title").text().trim() ||
		$("h1").first().text().trim() ||
		"No Title";
	const content = $("body")
		.text()
		.replace(/\s+/g, " ")
		.trim();

	const links: string[] = [];
	$("a[href]").each((_, element) => {
		const href = $(element).attr("href");
		if (
			href &&
			href.trim() &&
			!href.startsWith("#") &&
			!href.startsWith("javascript:") &&
			!href.startsWith("mailto:")
		) {
			try {
				links.push(new URL(href, url).href);
			} catch (e) {
				// ignore invalid urls
			}
		}
	});

	const metadata: any = {};
	const description = $(
		'meta[name="description"]',
	).attr("content");
	if (description)
		metadata.description = description;

	return {
		url,
		title,
		content,
		links: [...new Set(links)],
		metadata,
	};
};

const processScrapeJob = async (
	job: Job<ScrapeJobData>,
) => {
	const { userId, url, maxDepth, maxPages } =
		job.data;
	const visitedUrls = new Set<string>();
	const urlQueue: Array<{
		url: string;
		depth: number;
	}> = [{ url, depth: 0 }];
	let pagesScraped = 0;

	logger.info(
		`Starting scrape job ${job.id} for user ${userId} on ${url}`,
	);

	await pineconeService.ensureIndexExists();

	while (
		urlQueue.length > 0 &&
		visitedUrls.size < maxPages
	) {
		const { url: currentUrl, depth } =
			urlQueue.shift()!;
		const normalizedUrl =
			normalizeUrl(currentUrl);

		if (visitedUrls.has(normalizedUrl)) continue;
		if (depth > maxDepth) continue;

		visitedUrls.add(normalizedUrl);
		pagesScraped++;

		// Report progress
		await job.updateProgress(
			Math.round(
				(visitedUrls.size / maxPages) * 100,
			),
		);
		job.log(`Crawling: ${normalizedUrl}`);

		try {
			const html = await fetchPageContent(
				normalizedUrl,
			);
			const pageData = extractPageData(
				html,
				normalizedUrl,
			);

			// Store in Pinecone
			// Note: metadata handling might need adjustment if pineconeService expects specific fields
			await pineconeService.upsertDocument(
				userId,
				pageData.url,
				pageData.title,
				pageData.content,
				pageData.metadata,
			);

			if (depth < maxDepth) {
				for (const link of pageData.links) {
					const normalizedLink =
						normalizeUrl(link);
					if (
						!visitedUrls.has(normalizedLink) &&
						isValidUrl(normalizedLink, url)
					) {
						urlQueue.push({
							url: normalizedLink,
							depth: depth + 1,
						});
					}
				}
			}
		} catch (error) {
			logger.error(
				`Error scraping ${normalizedUrl}`,
				{ error },
			);
			job.log(
				`Failed to scrape ${normalizedUrl}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return {
		pagesScraped,
		visitedUrls: Array.from(visitedUrls),
	};
};

export const createScraperWorker = () => {
	const worker = new Worker(
		SCRAPER_QUEUE_NAME,
		processScrapeJob,
		{
			connection: {
				host: config.REDIS_QUEUE_HOST,
				port: config.REDIS_QUEUE_PORT,
				password: config.REDIS_QUEUE_PASSWORD,
			},
			concurrency: config.SCRAPER_CONCURRENCY, // Configurable concurrency (default: 10)
		},
	);

	worker.on("completed", (job) => {
		logger.info(
			`Job ${job.id} completed! Scraped ${job.returnvalue.pagesScraped} pages.`,
		);
	});

	worker.on("failed", (job, err) => {
		logger.error(`Job ${job?.id} failed`, {
			error: err.message,
		});
	});

	return worker;
};
