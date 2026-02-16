import axios from "axios";
import * as cheerio from "cheerio";
import { pineconeService } from "./pineconeService";
import { ScrapedPage } from "../types";
import logger from "../utils/logger";

interface CrawlOptions {
	maxDepth?: number;
	maxPages?: number;
}

interface ScrapeResult {
	success: boolean;
	message: string;
	pagesScraped: number;
	pages: ScrapedPage[];
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
		const response = await axios.get(url, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
			},
			timeout: 10000,
		});
		return response.data;
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
				} catch {
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
	}

	async scrapeWebsite(
		userId: string,
		url: string,
		options: CrawlOptions = {},
	): Promise<ScrapeResult> {
		const maxDepth = options.maxDepth || 3;
		const maxPages = options.maxPages || 100;
		const visitedUrls = new Set<string>();
		const urlQueue: Array<{
			url: string;
			depth: number;
		}> = [{ url, depth: 0 }];
		const scrapedPages: ScrapedPage[] = [];

		logger.info(
			`Starting synchronous scrape for user ${userId} on ${url}`,
			{ maxDepth, maxPages },
		);

		await pineconeService.ensureIndexExists();

		while (
			urlQueue.length > 0 &&
			visitedUrls.size < maxPages
		) {
			const { url: currentUrl, depth } =
				urlQueue.shift()!;
			const normalizedUrl =
				this.normalizeUrl(currentUrl);

			if (visitedUrls.has(normalizedUrl))
				continue;
			if (depth > maxDepth) continue;

			visitedUrls.add(normalizedUrl);

			try {
				const html =
					await this.fetchPageContent(
						normalizedUrl,
					);
				const pageData =
					this.extractPageData(
						html,
						normalizedUrl,
					);

				// Store in Pinecone
				await pineconeService.upsertDocument(
					userId,
					pageData.url,
					pageData.title,
					pageData.content,
					pageData.metadata,
				);

				scrapedPages.push(pageData);

				if (depth < maxDepth) {
					for (const link of pageData.links) {
						const normalizedLink =
							this.normalizeUrl(link);
						if (
							!visitedUrls.has(
								normalizedLink,
							) &&
							this.isValidInternalUrl(
								normalizedLink,
								url,
							)
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
			}
		}

		logger.info(
			`Scrape completed for user ${userId}`,
			{
				pagesScraped: scrapedPages.length,
				url,
			},
		);

		return {
			success: true,
			message: `Successfully scraped ${scrapedPages.length} page(s)`,
			pagesScraped: scrapedPages.length,
			pages: scrapedPages,
		};
	}
}

export const scraperService =
	new ScraperService();
