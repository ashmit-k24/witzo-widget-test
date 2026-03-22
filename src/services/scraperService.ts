import axios from "axios";
import * as cheerio from "cheerio";
import { config } from "../config/env";
import {
	ScrapedPage,
	ScrapedPageBlockType,
	ScrapedPageContentBlock,
} from "../types";
import logger from "../utils/logger";
import { firecrawlService } from "./firecrawlService";
import { pineconeService } from "./pineconeService";
import {
	isUrlUnderSourceRoot,
	normalizeDiscoveredUrl,
	normalizeScrapeUrl,
	shouldSkipScrapeUrl,
} from "../utils/scrapeUrl";

const BUILT_IN_CRAWLER_CONCURRENCY = Math.max(
	1,
	Math.min(config.SCRAPER_CONCURRENCY, 10),
);
const BUILT_IN_FETCH_TIMEOUT_MS = 15000;

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

type RobotsRules = {
	disallowPaths: string[];
	sitemapUrls: string[];
};

class ScraperService {
	private normalizeText(text: string): string {
		return text
			.replace(/\u00a0/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	private hasContactSignals(text: string): boolean {
		return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d\s().-]{6,}|\b(address|phone|email|office|contact|call|reach us|get in touch|pin code|pincode|zip code|zip|postal code|floor|building|suite|unit|branch office|regional office|corporate office|head office|registered office)\b/i.test(
			text,
		);
	}

	private detectBlockType(
		text: string,
		tagName: string,
		sectionTitle?: string,
	): ScrapedPageBlockType {
		const normalized = `${sectionTitle ?? ""} ${text}`.toLowerCase();
		if (
			tagName === "tr" ||
			/\b(price|pricing|plan|package|fee|cost)\b/.test(normalized)
		) {
			return "table";
		}
		if (
			tagName === "li" ||
			tagName === "dt" ||
			tagName === "dd"
		) {
			return "list";
		}
		if (
			tagName === "details" ||
			/\?$/.test(text) ||
			/\b(faq|frequently asked|question|answer)\b/.test(normalized)
		) {
			return "faq";
		}
		if (this.hasContactSignals(normalized)) {
			return "contact";
		}
		return "paragraph";
	}

	private extractContentBlocks(
		$: ReturnType<typeof cheerio.load>,
		title: string,
		description: string,
	): ScrapedPageContentBlock[] {
		const root = $(
			"main, [role='main'], article, body",
		).first();
		const candidates = root
			.find(
				"h1, h2, h3, h4, h5, h6, p, li, dt, dd, blockquote, tr, details",
			)
			.toArray();
		const sectionStack: Array<{
			level: number;
			title: string;
		}> = [];
		const blocks: ScrapedPageContentBlock[] = [];
		const seenText = new Set<string>();

		const pushBlock = (
			text: string,
			tagName: string,
		): void => {
			const normalizedText =
				this.normalizeText(text);
			if (!normalizedText) {
				return;
			}

			const normalizedKey =
				normalizedText.toLowerCase();
			if (seenText.has(normalizedKey)) {
				return;
			}

			const sectionPath = sectionStack.map(
				(entry) => entry.title,
			);
			const sectionTitle =
				sectionPath[sectionPath.length - 1];
			const isContactBlock =
				this.hasContactSignals(normalizedText);
			const isMeaningfulText =
				normalizedText.length >= 30 ||
				isContactBlock;

			if (!isMeaningfulText) {
				return;
			}

			seenText.add(normalizedKey);
			blocks.push({
				text: normalizedText,
				blockType: this.detectBlockType(
					normalizedText,
					tagName,
					sectionTitle,
				),
				position: blocks.length,
				sectionTitle,
				sectionPath:
					sectionPath.length > 0
						? sectionPath
						: undefined,
			});
		};

		for (const element of candidates) {
			const tagName =
				(
					element as {
						tagName?: string;
					}
				).tagName?.toLowerCase() ?? "";
			if (!tagName) {
				continue;
			}

			const $element = $(element);
			const withinBoilerplate =
				$element.closest(
					"nav, header, form, aside",
				).length > 0;
			const withinFooter =
				$element.closest("footer").length > 0;

			if (/^h[1-6]$/.test(tagName)) {
				const heading =
					this.normalizeText(
						$element.text(),
					);
				if (!heading) {
					continue;
				}

				const level = Number(tagName.slice(1));
				while (
					sectionStack.length > 0 &&
					sectionStack[sectionStack.length - 1].level >=
						level
				) {
					sectionStack.pop();
				}
				sectionStack.push({
					level,
					title: heading,
				});
				continue;
			}

			if (withinBoilerplate) {
				continue;
			}

			let text = "";
			if (tagName === "tr") {
				text = $element
					.find("th, td")
					.toArray()
					.map((cell) =>
						this.normalizeText(
							$(cell).text(),
						),
					)
					.filter(Boolean)
					.join(" | ");
			} else if (tagName === "details") {
				const summary = this.normalizeText(
					$element.find("summary").first().text(),
				);
				const body = this.normalizeText(
					$element
						.clone()
						.find("summary")
						.remove()
						.end()
						.text(),
				);
				text = [summary, body]
					.filter(Boolean)
					.join(" ");
			} else {
				text = this.normalizeText(
					$element.text(),
				);
			}

			if (
				withinFooter &&
				!this.hasContactSignals(text)
			) {
				continue;
			}

			pushBlock(text, tagName);
		}

		if (description) {
			blocks.unshift({
				text: [title, description]
					.filter(Boolean)
					.join(". "),
				blockType: "summary",
				position: 0,
				sectionTitle: title || undefined,
				sectionPath: title ? [title] : undefined,
			});
		}

		return blocks.map((block, index) => ({
			...block,
			position: index,
		}));
	}

	private extractPageData(
		html: string,
		url: string,
		sourceRoot: string,
	): ScrapedPage {
		const $ = cheerio.load(html);
		$(
			"script, style, noscript, iframe, svg",
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
		const canonicalUrl =
			$("link[rel='canonical']")
				.attr("href")
				?.trim() || undefined;
		const contentBlocks =
			this.extractContentBlocks(
				$,
				title,
				description,
			);
		const primaryText = $("main, article, body")
			.first()
			.text()
			.replace(/\s+/g, " ")
			.trim();
		const content = (
			contentBlocks
				.map((block) =>
					block.sectionTitle &&
					!block.text
						.toLowerCase()
						.startsWith(
							block.sectionTitle.toLowerCase(),
						)
						? `${block.sectionTitle}: ${block.text}`
						: block.text,
				)
				.join("\n\n") ||
			primaryText ||
			[title, description].filter(Boolean).join(". ")
		).trim();

		const links: string[] = [];
		$("a[href]").each((_, element) => {
			const href = $(element).attr("href");
			if (
				!href ||
				href.startsWith("#") ||
				href.startsWith("javascript:") ||
				href.startsWith("mailto:")
			) {
				return;
			}

			const normalized = normalizeDiscoveredUrl(
				href,
				url,
			);
			if (
				normalized &&
				isUrlUnderSourceRoot(normalized, sourceRoot) &&
				!shouldSkipScrapeUrl(normalized)
			) {
				links.push(normalized);
			}
		});

		const metadata: Record<string, unknown> = {};
		if (description) metadata.description = description;
		if (canonicalUrl)
			metadata.canonicalUrl = canonicalUrl;
		if (contentBlocks.length > 0) {
			metadata.contentBlocks = contentBlocks;
		}
		metadata.scrapedVia = "builtin";

		return {
			url,
			title,
			content,
			links: [...new Set(links)],
			metadata,
		};
	}

	private async fetchTextResponse(
		url: string,
	): Promise<{ html: string; contentType: string }> {
		const response = await axios.get(url, {
			timeout: BUILT_IN_FETCH_TIMEOUT_MS,
			headers: {
				"User-Agent": "WitzoCrawler/2.0",
			},
			maxRedirects: 5,
			validateStatus: (status) =>
				status >= 200 && status < 400,
		});

		const contentType =
			String(response.headers["content-type"] ?? "");
		return {
			html:
				typeof response.data === "string"
					? response.data
					: "",
			contentType,
		};
	}

	private parseSitemapXml(
		xml: string,
		sourceRoot: string,
		seen = new Set<string>(),
	): string[] {
		const discovered: string[] = [];
		const normalizedXml = xml.trim();

		if (/<sitemapindex/i.test(normalizedXml)) {
			const nestedSitemaps = [
				...normalizedXml.matchAll(
					/<loc>(.*?)<\/loc>/gi,
				),
			]
				.map((match) =>
					normalizeDiscoveredUrl(match[1] ?? ""),
				)
				.filter((url): url is string => {
					return typeof url === "string" && !seen.has(url);
				});
			for (const sitemapUrl of nestedSitemaps) {
				seen.add(sitemapUrl);
			}
			return nestedSitemaps;
		}

		for (const match of normalizedXml.matchAll(
			/<loc>(.*?)<\/loc>/gi,
		)) {
			const normalized = normalizeDiscoveredUrl(
				match[1] ?? "",
			);
			if (
				normalized &&
				isUrlUnderSourceRoot(normalized, sourceRoot) &&
				!shouldSkipScrapeUrl(normalized)
			) {
				discovered.push(normalized);
			}
		}

		return discovered;
	}

	private async readRobotsRules(
		sourceRoot: string,
	): Promise<RobotsRules> {
		if (config.SCRAPER_IGNORE_ROBOTS) {
			return {
				disallowPaths: [],
				sitemapUrls: [],
			};
		}

		try {
			const base = new URL(sourceRoot);
			const robotsUrl = `${base.origin}/robots.txt`;
			const response = await axios.get(robotsUrl, {
				timeout: 8000,
				headers: {
					"User-Agent": "WitzoCrawler/2.0",
				},
				validateStatus: (status) =>
					status >= 200 && status < 300,
			});
			const text =
				typeof response.data === "string"
					? response.data
					: "";
			const lines = text
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);

			const disallowPaths: string[] = [];
			const sitemapUrls: string[] = [];
			let appliesToWildcard = false;

			for (const line of lines) {
				const commentStripped = line
					.split("#")[0]
					.trim();
				if (!commentStripped) {
					continue;
				}

				const separatorIndex =
					commentStripped.indexOf(":");
				if (separatorIndex <= 0) {
					continue;
				}

				const key = commentStripped
					.slice(0, separatorIndex)
					.trim()
					.toLowerCase();
				const value = commentStripped
					.slice(separatorIndex + 1)
					.trim();

				if (key === "user-agent") {
					appliesToWildcard =
						value === "*" ||
						value.toLowerCase() ===
							"witzocrawler";
					continue;
				}

				if (key === "sitemap" && value) {
					const normalized =
						normalizeDiscoveredUrl(value);
					if (normalized) {
						sitemapUrls.push(normalized);
					}
					continue;
				}

				if (
					appliesToWildcard &&
					key === "disallow" &&
					value &&
					value !== "/"
				) {
					disallowPaths.push(value);
				}
			}

			return {
				disallowPaths,
				sitemapUrls,
			};
		} catch {
			return {
				disallowPaths: [],
				sitemapUrls: [],
			};
		}
	}

	private isBlockedByRobots(
		url: string,
		rules: RobotsRules,
	): boolean {
		if (config.SCRAPER_IGNORE_ROBOTS) {
			return false;
		}

		try {
			const pathname = new URL(url).pathname;
			return rules.disallowPaths.some((path) => {
				if (!path || path === "/") {
					return false;
				}
				return pathname.startsWith(path);
			});
		} catch {
			return false;
		}
	}

	private async discoverSitemapUrls(
		sourceRoot: string,
	): Promise<string[]> {
		const rules =
			await this.readRobotsRules(sourceRoot);
		const sitemapCandidates = new Set<string>(
			rules.sitemapUrls,
		);

		try {
			const root = new URL(sourceRoot);
			sitemapCandidates.add(
				`${root.origin}/sitemap.xml`,
			);
		} catch {
			// sourceRoot has already been normalized earlier
		}

		const discovered = new Set<string>();
		const pending = [...sitemapCandidates];
		const seenSitemaps = new Set<string>();

		while (pending.length > 0) {
			const sitemapUrl = pending.shift()!;
			if (seenSitemaps.has(sitemapUrl)) {
				continue;
			}
			seenSitemaps.add(sitemapUrl);

			try {
				const response = await axios.get(sitemapUrl, {
					timeout: 10000,
					headers: {
						"User-Agent": "WitzoCrawler/2.0",
					},
					validateStatus: (status) =>
						status >= 200 && status < 300,
				});
				const xml =
					typeof response.data === "string"
						? response.data
						: "";
				const parsed = this.parseSitemapXml(
					xml,
					sourceRoot,
					seenSitemaps,
				);

				for (const item of parsed) {
					if (/\.xml(\?|$)/i.test(item)) {
						if (!seenSitemaps.has(item)) {
							pending.push(item);
						}
						continue;
					}
					discovered.add(item);
				}
			} catch {
				// Ignore sitemap failures; HTML crawl is the fallback.
			}
		}

		return [...discovered];
	}

	private async builtInCrawl(
		startURL: string,
		maxPages: number,
		maxDepth: number,
		onProgress?: (
			scraped: number,
			total: number,
		) => Promise<void> | void,
	): Promise<ScrapedPage[]> {
		const visited = new Set<string>();
		const enqueued = new Set<string>([startURL]);
		const queue: Array<{
			url: string;
			depth: number;
		}> = [{ url: startURL, depth: 0 }];
		const pages: ScrapedPage[] = [];
		const robotsRules =
			await this.readRobotsRules(startURL);
		const sitemapUrls =
			await this.discoverSitemapUrls(startURL);

		for (const url of sitemapUrls) {
			if (!enqueued.has(url)) {
				queue.push({ url, depth: 0 });
				enqueued.add(url);
			}
		}

		while (
			queue.length > 0 &&
			pages.length < maxPages
		) {
			const batch: Array<{
				url: string;
				depth: number;
			}> = [];
			while (
				queue.length > 0 &&
				batch.length <
					BUILT_IN_CRAWLER_CONCURRENCY &&
				visited.size + batch.length < maxPages
			) {
				const nextItem = queue.shift()!;
				const nextUrl = nextItem.url;
				if (visited.has(nextUrl)) {
					continue;
				}
				visited.add(nextUrl);
				batch.push(nextItem);
			}

			const results = await Promise.allSettled(
				batch.map(async ({ url, depth }) => {
					if (
						depth > maxDepth ||
						shouldSkipScrapeUrl(url) ||
						!isUrlUnderSourceRoot(
							url,
							startURL,
						) ||
						this.isBlockedByRobots(
							url,
							robotsRules,
						)
					) {
						return null;
					}

					const { html, contentType } =
						await this.fetchTextResponse(url);
					if (
						!contentType.includes("text/html") ||
						!html.trim()
					) {
						return null;
					}

					const page = this.extractPageData(
						html,
						url,
						startURL,
					);
					if (!page.content.trim()) {
						return null;
					}

					return {
						page,
						depth,
					};
				}),
			);

			for (const result of results) {
				if (
					result.status !== "fulfilled" ||
					!result.value
				) {
					continue;
				}

				if (pages.length >= maxPages) {
					break;
				}

				pages.push(result.value.page);
				await onProgress?.(
					pages.length,
					Math.max(maxPages, queue.length),
				);

				if (result.value.depth >= maxDepth) {
					continue;
				}

				for (const link of result.value.page.links) {
					if (
						pages.length + queue.length >= maxPages &&
						maxPages !== Number.POSITIVE_INFINITY
					) {
						break;
					}
					if (
						visited.has(link) ||
						enqueued.has(link) ||
						shouldSkipScrapeUrl(link) ||
						!isUrlUnderSourceRoot(
							link,
							startURL,
						) ||
						this.isBlockedByRobots(
							link,
							robotsRules,
						)
					) {
						continue;
					}
					queue.push({
						url: link,
						depth: result.value.depth + 1,
					});
					enqueued.add(link);
				}
			}
		}

		return pages;
	}

	private async indexPagesInBatches(
		userId: string,
		sourceRoot: string,
		pages: ScrapedPage[],
		reportProgress?: CrawlOptions["onProgress"],
	): Promise<void> {
		const rootPage =
			pages.find((page) => page.url === sourceRoot) ??
			pages[0];
		const sourceRootTitle =
			rootPage?.title || sourceRoot;
		let indexedPages = 0;
		const batchSize = Math.max(
			1,
			config.SCRAPER_BATCH_PAGE_SIZE,
		);

		for (let i = 0; i < pages.length; i += batchSize) {
			const batch = pages.slice(i, i + batchSize);
			await Promise.all(
				batch.map((page) =>
					pineconeService.upsertDocument(
						userId,
						page.url,
						page.title,
						page.content,
						{
							...(page.metadata ?? {}),
							sourceRoot,
							sourceRootTitle,
							sourceKey: sourceRoot,
							sourceType: "website",
						},
					),
				),
			);

			indexedPages += batch.length;
			await reportProgress?.({
				totalPages: pages.length,
				scrapedPages: pages.length,
				storedPages: indexedPages,
				currentUrl:
					batch[batch.length - 1]?.url ??
					sourceRoot,
			});
		}
	}

	async scrapeWebsite(
		userId: string,
		url: string,
		options: CrawlOptions = {},
	): Promise<ScrapeResult> {
		const sourceRoot = await normalizeScrapeUrl(url);
		const maxDepth = Math.max(
			0,
			options.maxDepth ?? 30,
		);
		const maxPages = Math.max(
			1,
			options.maxPages ?? 1200,
		);
		const reportProgress = options.onProgress;
		let firstFailureReason: string | null = null;

		logger.info(
			"[Scraper] Starting source pipeline",
			{
				sourceRoot,
				userId,
				maxPages,
			},
		);

		await pineconeService.ensureIndexExists();
		await pineconeService.deleteDocumentsByUrl(
			userId,
			sourceRoot,
		);

		await reportProgress?.({
			totalPages: maxPages,
			scrapedPages: 0,
			storedPages: 0,
			currentUrl: sourceRoot,
		});

		let pages: ScrapedPage[] = [];
		let usedFirecrawl = false;

		if (firecrawlService.isAvailable) {
			try {
				pages = await firecrawlService.crawlWebsite(
					sourceRoot,
					maxPages,
					maxDepth,
					async (done, total) => {
						await reportProgress?.({
							totalPages: Math.max(total, done, 1),
							scrapedPages: done,
							storedPages: 0,
							currentUrl: sourceRoot,
						});
					},
				);
				usedFirecrawl = pages.length > 0;
			} catch (error) {
				firstFailureReason =
					error instanceof Error
						? error.message
						: String(error);
				logger.warn(
					"[Scraper] Firecrawl crawl failed; using built-in crawler",
					{
						sourceRoot,
						error: firstFailureReason,
					},
				);
			}
		}

		if (!usedFirecrawl) {
			try {
				pages = await this.builtInCrawl(
					sourceRoot,
					maxPages,
					maxDepth,
					async (scraped, total) => {
						await reportProgress?.({
							totalPages: Math.max(total, scraped, 1),
							scrapedPages: scraped,
							storedPages: 0,
							currentUrl: sourceRoot,
						});
					},
				);
			} catch (error) {
				firstFailureReason =
					error instanceof Error
						? error.message
						: String(error);
				logger.error(
					"[Scraper] Built-in crawler failed",
					{
						sourceRoot,
						error: firstFailureReason,
					},
				);
			}
		}

		pages = Array.from(
			new Map(
				pages.map((page) => [page.url, page]),
			).values(),
		).slice(0, maxPages);

		if (pages.length === 0) {
			return {
				success: false,
				message: firstFailureReason
					? `Failed to scrape any pages from the provided website: ${firstFailureReason}`
					: "Failed to scrape any pages from the provided website",
				pagesScraped: 0,
				visitedPages: 0,
				storedPages: 0,
				pages: [],
				failureReason:
					firstFailureReason ?? undefined,
			};
		}

		await this.indexPagesInBatches(
			userId,
			sourceRoot,
			pages,
			reportProgress,
		);

		const summary = usedFirecrawl
			? `Successfully scraped ${pages.length} page(s) via Firecrawl`
			: `Successfully scraped ${pages.length} page(s) via built-in crawler`;

		logger.info("[Scraper] Source pipeline completed", {
			sourceRoot,
			userId,
			pages: pages.length,
			usedFirecrawl,
		});

		return {
			success: true,
			message: summary,
			pagesScraped: pages.length,
			visitedPages: pages.length,
			storedPages: pages.length,
			pages,
		};
	}
}

export const scraperService =
	new ScraperService();
