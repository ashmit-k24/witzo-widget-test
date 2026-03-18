import axios from "axios";
import * as cheerio from "cheerio";
import { pineconeService } from "./pineconeService";
import { ScrapedPage } from "../types";
import logger from "../utils/logger";
import {
	assertSafeOutgoingUrl,
} from "../utils/networkSafety";

const SCRAPER_CONCURRENCY = 5; // pages processed in parallel

interface CrawlOptions {
	maxDepth?: number;
	maxPages?: number;
	onProgress?: (progress: {
		totalPages: number;
		scrapedPages: number;
		storedPages: number;
		currentUrl?: string;
	}) => Promise<void> | void;
}

interface ScrapeResult {
	success: boolean;
	message: string;
	pagesScraped: number;
	visitedPages: number;
	storedPages: number;
	pages: ScrapedPage[];
	failureReason?: string;
}

class ScraperService {
	private normalizeUrl(url: string): string {
		try {
			const urlObj = new URL(url);
			urlObj.hash = "";
			return urlObj.href.replace(/\/$/, "");
		} catch {
			return url;
		}
	}

	private isValidInternalUrl(
		url: string,
		baseUrl: string,
	): boolean {
		try {
			const urlObj = new URL(url);
			const baseUrlObj = new URL(baseUrl);

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
		} catch {
			return false;
		}
	}

	private async fetchPageContent(
		url: string,
	): Promise<string> {
		let currentUrl = url;
		const visitedRedirectStates = new Set<string>();
		const maxRedirects = 10;
		const cookieJar = new Map<string, string>();

		for (
			let redirectCount = 0;
			redirectCount < maxRedirects;
			redirectCount += 1
		) {
			const safeUrl =
				await assertSafeOutgoingUrl(currentUrl, {
					allowHttp: true,
				});
			const cookieHeader = Array.from(
				cookieJar.entries(),
			)
				.map(([name, value]) => `${name}=${value}`)
				.join("; ");
			const requestStateKey = `${safeUrl.toString()}|${cookieHeader}`;
			if (visitedRedirectStates.has(requestStateKey)) {
				throw new Error(
					"Redirect loop detected while scraping",
				);
			}
			visitedRedirectStates.add(requestStateKey);
			const response = await axios.get(safeUrl.toString(), {
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
					...(cookieHeader
						? {
								Cookie: cookieHeader,
						  }
						: {}),
				},
				timeout: 10000,
				maxRedirects: 0,
				validateStatus: (status) =>
					(status >= 200 && status < 300) ||
					(status >= 300 && status < 400),
			});
			const setCookieHeaders = response.headers["set-cookie"];
			const cookies = Array.isArray(setCookieHeaders)
				? setCookieHeaders
				: typeof setCookieHeaders === "string"
					? [setCookieHeaders]
					: [];
			for (const setCookie of cookies) {
				const [cookiePair] = setCookie.split(";");
				const separatorIndex = cookiePair.indexOf("=");
				if (separatorIndex <= 0) {
					continue;
				}
				const name = cookiePair.slice(0, separatorIndex).trim();
				const value = cookiePair.slice(separatorIndex + 1).trim();
				if (!name) {
					continue;
				}
				cookieJar.set(name, value);
			}

			if (response.status >= 300 && response.status < 400) {
				const location =
					response.headers.location;
				if (!location) {
					throw new Error(
						"Redirect response missing location header",
					);
				}
				currentUrl = new URL(
					location,
					safeUrl,
				).toString();
				continue;
			}

			return response.data;
		}

		throw new Error(
			`Too many redirects while scraping (>${maxRedirects})`,
		);
	}

	private extractPageData(
		html: string,
		url: string,
	): ScrapedPage {
		const $ = cheerio.load(html);
		$(
			"script, style, noscript, iframe",
		).remove();

		const title =
			$("title").text().trim() ||
			$("h1").first().text().trim() ||
			"No Title";
		const description =
			$('meta[name="description"]').attr("content")?.trim() ||
			$('meta[property="og:description"]').attr("content")?.trim() ||
			$('meta[name="twitter:description"]').attr("content")?.trim() ||
			"";
		const primaryText = $("main, article, body")
			.first()
			.text()
			.replace(/\s+/g, " ")
			.trim();
		const content = (
			primaryText ||
			[title, description].filter(Boolean).join(". ")
		).trim();

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
				} catch {
					// ignore invalid urls
				}
			}
		});

		const metadata: any = {};
		if (description)
			metadata.description = description;

		return {
			url,
			title,
			content,
			links: [...new Set(links)],
			metadata,
		};
	}

	async scrapeWebsite(
		userId: string,
		url: string,
		options: CrawlOptions = {},
	): Promise<ScrapeResult> {
		const safeRootUrl =
			await assertSafeOutgoingUrl(url, {
				allowHttp: true,
			});
		const rootUrl = this.normalizeUrl(
			safeRootUrl.toString(),
		);
		let rootTitle = "";
		const maxDepth = options.maxDepth || 3;
		const maxPages = options.maxPages || 300;
		const reportProgress = options.onProgress;
		const visitedUrls = new Set<string>();
		const urlQueue: Array<{
			url: string;
			depth: number;
		}> = [{ url: rootUrl, depth: 0 }];
		const scrapedPages: ScrapedPage[] = [];
		let firstFailureReason: string | null = null;

		logger.info(
			`Starting synchronous scrape for user ${userId} on ${url}`,
			{ maxDepth, maxPages },
		);

		await pineconeService.ensureIndexExists();
		await reportProgress?.({
			totalPages: Math.min(maxPages, urlQueue.length),
			scrapedPages: 0,
			storedPages: 0,
			currentUrl: rootUrl,
		});

		while (
			urlQueue.length > 0 &&
			visitedUrls.size < maxPages
		) {
			// Collect a batch of unique, valid URLs to process concurrently
			const batch: Array<{ url: string; depth: number }> = [];
			while (
				urlQueue.length > 0 &&
				batch.length < SCRAPER_CONCURRENCY &&
				visitedUrls.size + batch.length < maxPages
			) {
				const item = urlQueue.shift()!;
				const normalizedUrl = this.normalizeUrl(item.url);
				if (visitedUrls.has(normalizedUrl)) continue;
				if (item.depth > maxDepth) continue;
				visitedUrls.add(normalizedUrl);
				batch.push({ url: normalizedUrl, depth: item.depth });
			}

			if (batch.length === 0) break;

			// Process the batch in parallel
			await Promise.allSettled(
				batch.map(async ({ url: currentUrl, depth }) => {
					try {
						const html = await this.fetchPageContent(currentUrl);
						const pageData = this.extractPageData(html, currentUrl);

						if (depth === 0 && pageData.title) {
							rootTitle = pageData.title;
						}

						// Store in Pinecone
						await pineconeService.upsertDocument(
							userId,
							pageData.url,
							pageData.title,
							pageData.content,
							{
								...pageData.metadata,
								sourceRoot: rootUrl,
								sourceRootTitle:
									rootTitle || pageData.title || rootUrl,
							},
						);

						scrapedPages.push(pageData);

						if (depth < maxDepth) {
							for (const link of pageData.links) {
								const normalizedLink = this.normalizeUrl(link);
								if (
									!visitedUrls.has(normalizedLink) &&
									this.isValidInternalUrl(normalizedLink, url)
								) {
									urlQueue.push({
										url: normalizedLink,
										depth: depth + 1,
									});
								}
							}
						}
					} catch (error) {
						const errorMessage =
							error instanceof Error
								? error.message
								: String(error);
						if (!firstFailureReason) {
							firstFailureReason = errorMessage;
						}
						logger.error(`Error scraping ${currentUrl}`, {
							error,
							errorMessage,
						});
					} finally {
						await reportProgress?.({
							totalPages: Math.min(
								maxPages,
								Math.max(
									visitedUrls.size + urlQueue.length,
									visitedUrls.size,
								),
							),
							scrapedPages: visitedUrls.size,
							storedPages: scrapedPages.length,
							currentUrl,
						});
					}
				}),
			);
		}

		logger.info(
			`Scrape completed for user ${userId}`,
			{
				pagesScraped: scrapedPages.length,
				url,
			},
		);

		const wasSuccessful =
			scrapedPages.length > 0;

		return {
			success: wasSuccessful,
			message: wasSuccessful
				? `Successfully scraped ${scrapedPages.length} page(s)`
				: firstFailureReason
					? `Failed to scrape any pages from the provided website: ${firstFailureReason}`
					: "Failed to scrape any pages from the provided website",
			pagesScraped: scrapedPages.length,
			visitedPages: visitedUrls.size,
			storedPages: scrapedPages.length,
			pages: scrapedPages,
			failureReason:
				wasSuccessful ? undefined : firstFailureReason ?? undefined,
		};
	}
}

export const scraperService =
	new ScraperService();
