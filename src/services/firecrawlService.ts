import axios from "axios";
import { config } from "../config/env";
import { ScrapedPage } from "../types";
import logger from "../utils/logger";

interface FirecrawlScrapeOptions {
	formats: string[];
	onlyMainContent: boolean;
	waitFor?: number;
	timeout?: number;
	removeBase64Images?: boolean;
	blockAds?: boolean;
	parsePDF?: boolean;
	excludeTags?: string[];
}

interface FirecrawlCrawlRequest {
	url: string;
	limit?: number;
	maxDepth?: number;
	allowBackwardLinks?: boolean;
	allowExternalLinks?: boolean;
	ignoreSitemap?: boolean;
	scrapeOptions: FirecrawlScrapeOptions;
}

interface FirecrawlStartResponse {
	success: boolean;
	id: string;
}

interface FirecrawlPage {
	markdown?: string;
	html?: string;
	rawHtml?: string;
	content?: string;
	text?: string;
	metadata: {
		title?: string;
		description?: string;
		sourceURL?: string;
		url?: string;
		statusCode?: number;
		error?: string;
		pageStatusCode?: number;
		pageError?: string;
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

async function firecrawlGet(endpoint: string): Promise<FirecrawlStatusResponse> {
	const response = await axios.get<FirecrawlStatusResponse>(
		firecrawlBaseURL() + endpoint,
		{
			headers: { Authorization: `Bearer ${config.FIRECRAWL_API_KEY}` },
			timeout: 60000,
		},
	);
	return response.data;
}

async function firecrawlGetUrl(url: string): Promise<FirecrawlStatusResponse> {
	try {
		const response = await axios.get<FirecrawlStatusResponse>(
			url,
			{
				headers: { Authorization: `Bearer ${config.FIRECRAWL_API_KEY}` },
				timeout: 60000,
			},
		);
		return response.data;
	} catch (error) {
		if (
			url.startsWith("https://") &&
			isWrongProtocolError(error)
		) {
			const httpUrl = "http://" + url.slice("https://".length);
			logger.warn("firecrawl: retrying next page over http after TLS protocol error", {
				url,
				httpUrl,
			});
			const response = await axios.get<FirecrawlStatusResponse>(
				httpUrl,
				{
					headers: { Authorization: `Bearer ${config.FIRECRAWL_API_KEY}` },
					timeout: 60000,
				},
			);
			return response.data;
		}
		throw error;
	}
}

function isWrongProtocolError(error: unknown): boolean {
	const candidate = error as {
		code?: unknown;
		message?: unknown;
	};
	return (
		candidate?.code === "EPROTO" ||
		(typeof candidate?.message === "string" &&
			candidate.message.toLowerCase().includes("wrong version number"))
	);
}

function rewriteFirecrawlNextUrl(nextUrl: string): string {
	if (!nextUrl.startsWith("http://") && !nextUrl.startsWith("https://")) {
		return firecrawlBaseURL() + nextUrl;
	}

	try {
		const configuredBase = new URL(firecrawlBaseURL());
		const next = new URL(nextUrl);
		next.host = configuredBase.host;
		return next.toString();
	} catch {
		return nextUrl;
	}
}

// Minimal HTML → plain-text fallback for the case where Firecrawl (esp. the
// self-hosted build) returns `html` / `rawHtml` but no `markdown`. We don't
// need a perfect converter here — the downstream chunker and embeddings just
// need readable text. This intentionally preserves block boundaries and
// headings on newlines so markdown chunking still has structure to split on.
function htmlToText(html: string): string {
	if (!html) return "";
	let text = html;
	// Drop script/style/noscript/iframe blocks entirely.
	text = text.replace(
		/<(script|style|noscript|iframe)[\s\S]*?<\/\1>/gi,
		" ",
	);
	// Turn headings into markdown-ish lines so chunkMarkdown can segment them.
	text = text.replace(
		/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
		(_m, level: string, inner: string) =>
			"\n\n" + "#".repeat(Number(level)) + " " + inner.trim() + "\n\n",
	);
	// Preserve list items.
	text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
	// Paragraphs / breaks / divs become newlines.
	text = text.replace(/<(br|\/p|\/div|\/section|\/article)[^>]*>/gi, "\n");
	text = text.replace(/<p[^>]*>/gi, "\n");
	// Strip everything else.
	text = text.replace(/<[^>]+>/g, " ");
	// Decode the handful of entities we actually see in real pages.
	text = text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'");
	// Collapse whitespace while keeping paragraph breaks.
	text = text
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return text;
}

interface EmptyPageSample {
	url: string;
	statusCode?: number;
	error?: string;
	hadHtml: boolean;
	hadRawHtml: boolean;
}

function collectFirecrawlPages(
	data: FirecrawlPage[],
	startURL: string,
): {
	pages: ScrapedPage[];
	emptyMarkdownDropped: number;
	htmlFallbackUsed: number;
	emptySamples: EmptyPageSample[];
} {
	const pages: ScrapedPage[] = [];
	let emptyMarkdownDropped = 0;
	let htmlFallbackUsed = 0;
	const emptySamples: EmptyPageSample[] = [];

	for (const p of data) {
		const src =
			(p.metadata?.sourceURL ?? "").trim() ||
			(p.metadata?.url ?? "").trim() ||
			startURL;
		const title = (p.metadata?.title ?? "").trim();

		// Primary: markdown. Fallbacks cover self-hosted/older Firecrawl
		// builds that populate html/rawHtml/content/text even when their
		// markdown conversion step produces an empty string.
		let text = (p.markdown ?? "").trim();

		if (!text && typeof p.html === "string" && p.html.trim()) {
			text = htmlToText(p.html).trim();
			if (text) htmlFallbackUsed += 1;
		}
		if (!text && typeof p.rawHtml === "string" && p.rawHtml.trim()) {
			text = htmlToText(p.rawHtml).trim();
			if (text) htmlFallbackUsed += 1;
		}
		if (!text && typeof p.content === "string" && p.content.trim()) {
			text = p.content.trim();
		}
		if (!text && typeof p.text === "string" && p.text.trim()) {
			text = p.text.trim();
		}

		if (!text) {
			emptyMarkdownDropped += 1;
			if (emptySamples.length < 5) {
				emptySamples.push({
					url: src,
					statusCode:
						p.metadata?.statusCode ??
						p.metadata?.pageStatusCode,
					error:
						p.metadata?.error ??
						p.metadata?.pageError,
					hadHtml: Boolean(p.html),
					hadRawHtml: Boolean(p.rawHtml),
				});
			}
			continue;
		}

		pages.push({
			url: src,
			title,
			content: text,
			links: [],
			metadata: {},
		});
	}

	return {
		pages,
		emptyMarkdownDropped,
		htmlFallbackUsed,
		emptySamples,
	};
}

// Match ai-backend's collection flow: use the completed poll response data,
// then follow Firecrawl's `next` pagination URL.
async function fetchAllCrawlResultsFromStatus(
	crawlId: string,
	startURL: string,
	finalStatus: FirecrawlStatusResponse,
): Promise<ScrapedPage[]> {
	const pages: ScrapedPage[] = [];
	let pageRequests = 0;
	let emptyMarkdownDropped = 0;
	let htmlFallbackUsed = 0;
	const emptySamples: EmptyPageSample[] = [];
	let batch: FirecrawlStatusResponse | null = finalStatus;
	let nextUrl = finalStatus.next;

	while (batch) {
		pageRequests += 1;
		const data = batch.data ?? [];
		const collected = collectFirecrawlPages(
			data,
			startURL,
		);
		pages.push(...collected.pages);
		emptyMarkdownDropped +=
			collected.emptyMarkdownDropped;
		htmlFallbackUsed += collected.htmlFallbackUsed;
		for (const sample of collected.emptySamples) {
			if (emptySamples.length >= 10) break;
			emptySamples.push(sample);
		}

		logger.info("firecrawl: fetched results page", {
			crawlId,
			received: data.length,
			next: nextUrl || null,
			emptyMarkdownDropped:
				collected.emptyMarkdownDropped,
			htmlFallbackUsed:
				collected.htmlFallbackUsed,
		});

		if (!nextUrl) {
			break;
		}

		const rewrittenNextUrl =
			rewriteFirecrawlNextUrl(nextUrl);
		try {
			batch = await firecrawlGetUrl(rewrittenNextUrl);
			nextUrl = batch.next;
		} catch (err) {
			logger.warn("firecrawl: failed to fetch next crawl results page", {
				crawlId,
				nextUrl: rewrittenNextUrl,
				err,
			});
			break;
		}
	}

	logger.info("firecrawl: collected all crawl results", {
		crawlId,
		pageRequests,
		reportedTotal: finalStatus.total ?? 0,
		pagesCollected: pages.length,
		emptyMarkdownDropped,
		htmlFallbackUsed,
	});

	if (emptyMarkdownDropped > 0) {
		// Surface *why* pages were dropped. Without this we have no way to
		// tell whether the self-hosted Firecrawl is returning 4xx/5xx, timing
		// out, or just silently producing empty markdown for valid HTML.
		logger.warn("firecrawl: pages dropped with no usable content", {
			crawlId,
			emptyMarkdownDropped,
			reportedTotal: finalStatus.total ?? 0,
			pagesCollected: pages.length,
			samples: emptySamples,
		});
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
	// IMPORTANT: onlyMainContent defaults to true in Firecrawl, which strips
	// navigation, sidebars, headers, footers, and anything outside the "main"
	// article region. That caused us to lose large portions of real page
	// content (pricing tables in footers, feature grids in sidebars, FAQs
	// hidden in accordions, etc.). We explicitly disable it so we keep the
	// entire page. We also give JS-rendered sites a short wait window and a
	// longer per-page timeout, and block ads to reduce junk markdown.
	const requestBody: FirecrawlCrawlRequest = {
		url: startURL,
		allowBackwardLinks: true,
		ignoreSitemap: false,
		scrapeOptions: {
			// Request both formats. On the self-hosted Firecrawl build the
			// markdown converter sometimes returns an empty string even when
			// the HTML scrape succeeded; we use `html` as a fallback inside
			// collectFirecrawlPages so those pages don't get dropped.
			formats: ["markdown", "html"],
			onlyMainContent: false,
			waitFor: 2000,
			timeout: 45000,
			removeBase64Images: true,
			blockAds: true,
			parsePDF: true,
			excludeTags: [
				"script",
				"style",
				"noscript",
				"iframe",
			],
		},
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
			const pages = await fetchAllCrawlResultsFromStatus(
				crawlId,
				startURL,
				status,
			);
			logger.info("firecrawl: crawl complete", {
				crawlId,
				reportedTotal: status.total,
				pagesCollected: pages.length,
			});
			return pages;
		}

		if (status.status === "failed" || status.status === "cancelled") {
			throw new Error(`firecrawl: crawl ended with status "${status.status}"`);
		}
	}

	throw new Error("firecrawl: crawl did not complete within 15 minutes");
}
