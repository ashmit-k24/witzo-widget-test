import axios from "axios";
import { config } from "../config/env";
import { ScrapedPage } from "../types";
import logger from "../utils/logger";

interface FirecrawlCrawlRequest {
	url: string;
	limit?: number;
	scrapeOptions: {
		formats: string[];
	};
}

interface FirecrawlStartResponse {
	success: boolean;
	id: string;
}

interface FirecrawlPage {
	markdown: string;
	metadata: {
		title?: string;
		sourceURL?: string;
	};
}

interface FirecrawlStatusResponse {
	status: string;
	total: number;
	completed: number;
	data: FirecrawlPage[];
	next?: string;
}

export function firecrawlEnabled(): boolean {
	return Boolean(config.FIRECRAWL_API_KEY?.trim());
}

function firecrawlBaseURL(): string {
	return (config.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev").replace(/\/$/, "");
}

function resolveFirecrawlPaginationURL(nextURL: string): string {
	const trimmedNextURL = nextURL.trim();
	if (!trimmedNextURL) {
		return "";
	}

	const baseURL = firecrawlBaseURL();

	try {
		const parsedNextURL = new URL(trimmedNextURL);
		const parsedBaseURL = new URL(baseURL);

		// Some self-hosted Firecrawl deployments return pagination links with
		// localhost or another internal host. Keep the path/query, but force the
		// request back through the configured Firecrawl base URL.
		return `${parsedBaseURL.origin}${parsedNextURL.pathname}${parsedNextURL.search}`;
	} catch {
		if (trimmedNextURL.startsWith("/")) {
			return baseURL + trimmedNextURL;
		}

		return `${baseURL}/${trimmedNextURL.replace(/^\/+/, "")}`;
	}
}

async function firecrawlGet(endpoint: string): Promise<FirecrawlStatusResponse> {
	const response = await axios.get<FirecrawlStatusResponse>(
		firecrawlBaseURL() + endpoint,
		{
			headers: { Authorization: `Bearer ${config.FIRECRAWL_API_KEY}` },
			timeout: 30000,
		},
	);
	return response.data;
}

async function collectPages(
	initial: FirecrawlStatusResponse,
	startURL: string,
): Promise<ScrapedPage[]> {
	const pages: ScrapedPage[] = [];

	let batch = initial.data;
	let nextURL = initial.next ?? "";

	for (;;) {
		for (const p of batch) {
			const text = (p.markdown ?? "").trim();
			if (!text) continue;
			const src = (p.metadata?.sourceURL ?? "").trim() || startURL;
			pages.push({
				url: src,
				title: (p.metadata?.title ?? "").trim(),
				content: text,
				links: [],
				metadata: {},
			});
		}

		if (!nextURL) break;

		try {
			const paginationURL = resolveFirecrawlPaginationURL(nextURL);
			const more = await axios.get<FirecrawlStatusResponse>(paginationURL, {
				headers: { Authorization: `Bearer ${config.FIRECRAWL_API_KEY}` },
				timeout: 30000,
			});
			batch = more.data.data ?? [];
			nextURL = more.data.next ?? "";
		} catch (err) {
			logger.warn("firecrawl: failed to fetch next pagination page", {
				nextURL,
				resolvedNextURL: resolveFirecrawlPaginationURL(nextURL),
				err,
			});
			break;
		}
	}

	return pages;
}

// crawlWebsite uses the Firecrawl API to scrape a website and return clean markdown pages.
// Throws on error so the caller can fall back to the built-in scraper.
export async function firecrawlCrawlWebsite(
	startURL: string,
	maxPages?: number,
	onProgress?: (completed: number, total: number) => void,
): Promise<ScrapedPage[]> {
	const requestBody: FirecrawlCrawlRequest = {
		url: startURL,
		scrapeOptions: { formats: ["markdown"] },
	};
	if (
		typeof maxPages === "number" &&
		Number.isFinite(maxPages) &&
		maxPages > 0
	) {
		requestBody.limit = Math.trunc(maxPages);
	}

	// 1. Start crawl job
	const startResp = await axios.post<FirecrawlStartResponse>(
		firecrawlBaseURL() + "/v1/crawl",
		requestBody,
		{
			headers: {
				Authorization: `Bearer ${config.FIRECRAWL_API_KEY}`,
				"Content-Type": "application/json",
			},
			timeout: 30000,
		},
	);

	if (!startResp.data?.id) {
		throw new Error("firecrawl: empty crawl ID in response");
	}

	const crawlId = startResp.data.id;
	logger.info("firecrawl: crawl started", {
		crawlId,
		url: startURL,
		limit: requestBody.limit ?? null,
	});

	// 2. Poll until completed (max 15 min)
	const deadline = Date.now() + 15 * 60 * 1000;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 3000));

		let status: FirecrawlStatusResponse;
		try {
			status = await firecrawlGet("/v1/crawl/" + crawlId);
		} catch (err) {
			logger.warn("firecrawl: poll error, retrying", { crawlId, err });
			continue;
		}

		if (onProgress) {
			onProgress(status.completed, status.total);
		}
		logger.info("firecrawl: crawl progress", {
			status: status.status,
			completed: status.completed,
			total: status.total,
		});

		if (status.status === "completed") {
			const pages = await collectPages(status, startURL);
			logger.info("firecrawl: crawl complete", { crawlId, pagesCollected: pages.length });
			return pages;
		}

		if (status.status === "failed" || status.status === "cancelled") {
			throw new Error(`firecrawl: crawl ended with status "${status.status}"`);
		}
	}

	throw new Error("firecrawl: crawl did not complete within 15 minutes");
}
