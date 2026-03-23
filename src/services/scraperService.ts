import axios from "axios";
import * as cheerio from "cheerio";
import pool from "../config/database";
import { config } from "../config/env";
import {
	ScrapedPage,
	ScrapedPageBlockType,
	ScrapedPageContentBlock,
	ScrapedPageType,
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
import {
	detectScrapedPageType,
	enrichScrapedPage,
	hasContactSignals,
	normalizeScrapedText,
	scorePagePriority,
} from "../utils/scrapeAnalysis";

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
	failedUrls?: string[];
}

type RobotsRules = {
	disallowPaths: string[];
	sitemapUrls: string[];
};

type DiscoveredPage = {
	url: string;
	pageType: ScrapedPageType;
	priority: number;
};

type SiteDiscoveryResult = {
	pages: DiscoveredPage[];
	discoveredCount: number;
	usedSitemap: boolean;
};

class ScraperService {
	private async assertUserExists(
		userId: string,
	): Promise<void> {
		const result = await pool.query(
			`SELECT 1 FROM users WHERE id = $1 LIMIT 1`,
			[userId],
		);
		if (result.rows.length === 0) {
			throw new Error(
				`Cannot scrape website: user ${userId} does not exist in users table.`,
			);
		}
	}

	private normalizeText(text: string): string {
		return normalizeScrapedText(text);
	}

	private hasContactSignals(text: string): boolean {
		return hasContactSignals(text);
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

		// Also capture <a> tags containing contact signals (addresses, phones, emails)
		// that are not in standard block elements (p, li, etc.) and not in boilerplate.
		root.find("a").each((_, element) => {
			const $el = $(element);
			if (
				$el.closest("nav, header, form, aside").length > 0
			) {
				return;
			}
			// Skip if this <a> is a child of already-processed block elements
			if (
				$el.closest("p, li, dt, dd, blockquote").length > 0
			) {
				return;
			}
			const anchorText = this.normalizeText($el.text());
			if (
				anchorText &&
				this.hasContactSignals(anchorText)
			) {
				pushBlock(anchorText, "a");
			}
		});

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

		return enrichScrapedPage({
			url,
			title,
			content,
			links: [...new Set(links)],
			metadata,
		});
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

	private classifyDiscoveredUrl(
		url: string,
	): DiscoveredPage {
		const pageType = detectScrapedPageType(
			url,
			"",
		);
		return {
			url,
			pageType,
			priority: scorePagePriority(pageType, url),
		};
	}

	private async discoverHtmlInventory(
		sourceRoot: string,
	): Promise<DiscoveredPage[]> {
		try {
			const { html, contentType } =
				await this.fetchTextResponse(sourceRoot);
			if (
				!contentType.includes("text/html") ||
				!html.trim()
			) {
				return [];
			}

			const $ = cheerio.load(html);
			const discovered = new Map<
				string,
				DiscoveredPage
			>();
			discovered.set(
				sourceRoot,
				this.classifyDiscoveredUrl(sourceRoot),
			);

			$("a[href]").each((_, element) => {
				const href = $(element).attr("href");
				if (!href) {
					return;
				}
				const normalized =
					normalizeDiscoveredUrl(
						href,
						sourceRoot,
					);
				if (
					!normalized ||
					!isUrlUnderSourceRoot(
						normalized,
						sourceRoot,
					) ||
					shouldSkipScrapeUrl(normalized)
				) {
					return;
				}
				if (!discovered.has(normalized)) {
					discovered.set(
						normalized,
						this.classifyDiscoveredUrl(
							normalized,
						),
					);
				}
			});

			return Array.from(discovered.values());
		} catch {
			return [
				this.classifyDiscoveredUrl(sourceRoot),
			];
		}
	}

	private prioritizeDiscoveredPages(
		pages: DiscoveredPage[],
	): DiscoveredPage[] {
		return [...pages].sort((left, right) => {
			if (right.priority !== left.priority) {
				return right.priority - left.priority;
			}
			return left.url.localeCompare(right.url);
		});
	}

	private async discoverSiteInventory(
		sourceRoot: string,
	): Promise<SiteDiscoveryResult> {
		const sitemapPages =
			await this.discoverSitemapUrls(sourceRoot);
		const htmlInventory =
			await this.discoverHtmlInventory(sourceRoot);
		const discovered = new Map<
			string,
			DiscoveredPage
		>();

		discovered.set(
			sourceRoot,
			this.classifyDiscoveredUrl(sourceRoot),
		);
		for (const url of sitemapPages) {
			discovered.set(
				url,
				this.classifyDiscoveredUrl(url),
			);
		}
		for (const page of htmlInventory) {
			if (!discovered.has(page.url)) {
				discovered.set(page.url, page);
			}
		}

		const discoveredPages =
			this.prioritizeDiscoveredPages(
				Array.from(discovered.values()),
			);
		return {
			pages: discoveredPages,
			discoveredCount:
				discoveredPages.length,
			usedSitemap: sitemapPages.length > 0,
		};
	}

	private async builtInCrawl(
		startURL: string,
		maxPages: number,
		maxDepth: number,
		discovery: SiteDiscoveryResult,
		onProgress?: (
			scraped: number,
			total: number,
		) => Promise<void> | void,
	): Promise<ScrapedPage[]> {
		const visited = new Set<string>();
		const enqueued = new Set<string>();
		const queue: Array<{
			url: string;
			depth: number;
			priority: number;
		}> = [];
		const pages: ScrapedPage[] = [];
		const robotsRules =
			await this.readRobotsRules(startURL);
		const seedPages =
			discovery.pages.length > 0
				? discovery.pages
				: [this.classifyDiscoveredUrl(startURL)];

		for (const page of seedPages) {
			if (enqueued.has(page.url)) {
				continue;
			}
			queue.push({
				url: page.url,
				depth: 0,
				priority: page.priority,
			});
			enqueued.add(page.url);
		}

		while (
			queue.length > 0 &&
			pages.length < maxPages
		) {
			queue.sort((left, right) => {
				if (right.priority !== left.priority) {
					return right.priority - left.priority;
				}
				if (left.depth !== right.depth) {
					return left.depth - right.depth;
				}
				return left.url.localeCompare(right.url);
			});
			const batch: Array<{
				url: string;
				depth: number;
				priority: number;
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
				batch.map(async ({ url, depth, priority }) => {
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
						priority,
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
					Math.max(
						1,
						Math.min(
							maxPages,
							discovery.discoveredCount ||
								maxPages,
						),
					),
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
					const discovered =
						this.classifyDiscoveredUrl(link);
					queue.push({
						url: link,
						depth: result.value.depth + 1,
						priority: discovered.priority,
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
	): Promise<{
		storedPages: number;
		failedUrls: string[];
	}> {
		const prioritizedPages = [...pages].sort(
			(left, right) => {
				const rightPriority =
					typeof right.metadata?.pagePriority ===
					"number"
						? right.metadata.pagePriority
						: scorePagePriority(
								detectScrapedPageType(
									right.url,
									right.title,
									String(
										right.metadata
											?.description ?? "",
									),
									right.content,
									Array.isArray(
										right.metadata
											?.contentBlocks,
									)
										? right.metadata
												.contentBlocks
										: [],
								),
								right.url,
						  );
				const leftPriority =
					typeof left.metadata?.pagePriority ===
					"number"
						? left.metadata.pagePriority
						: scorePagePriority(
								detectScrapedPageType(
									left.url,
									left.title,
									String(
										left.metadata
											?.description ?? "",
									),
									left.content,
									Array.isArray(
										left.metadata
											?.contentBlocks,
									)
										? left.metadata
												.contentBlocks
										: [],
								),
								left.url,
						  );
				if (rightPriority !== leftPriority) {
					return rightPriority - leftPriority;
				}
				return left.url.localeCompare(right.url);
			},
		);
		const rootPage =
			prioritizedPages.find(
				(page) => page.url === sourceRoot,
			) ?? prioritizedPages[0];
		const sourceRootTitle =
			rootPage?.title || sourceRoot;
		let indexedPages = 0;
		const failedUrls: string[] = [];
		const batchSize = Math.max(
			1,
			config.SCRAPER_BATCH_PAGE_SIZE,
		);

		for (
			let i = 0;
			i < prioritizedPages.length;
			i += batchSize
		) {
			const batch = prioritizedPages.slice(
				i,
				i + batchSize,
			);
			const results = await Promise.allSettled(
				batch.map(async (page) => {
					await pineconeService.upsertDocument(
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
					);
					return page.url;
				}),
			);

			for (let batchIndex = 0; batchIndex < results.length; batchIndex += 1) {
				const result = results[batchIndex];
				if (result.status === "fulfilled") {
					indexedPages += 1;
					continue;
				}

				const failedUrl =
					batch[batchIndex]?.url ?? sourceRoot;
				failedUrls.push(failedUrl);
				logger.error(
					"[Scraper] Failed to index page",
					{
						userId,
						sourceRoot,
						url: failedUrl,
						error:
							result.reason instanceof Error
								? result.reason.message
								: String(
										result.reason,
								  ),
					},
				);
			}

			await reportProgress?.({
				totalPages: prioritizedPages.length,
				scrapedPages: prioritizedPages.length,
				storedPages: indexedPages,
				currentUrl:
					batch[batch.length - 1]?.url ??
					sourceRoot,
			});
		}

		return {
			storedPages: indexedPages,
			failedUrls,
		};
	}

	async scrapeWebsite(
		userId: string,
		url: string,
		options: CrawlOptions = {},
	): Promise<ScrapeResult> {
		await this.assertUserExists(userId);
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
		const discovery =
			await this.discoverSiteInventory(sourceRoot);
		const plannedPages = Math.max(
			1,
			Math.min(
				maxPages,
				discovery.discoveredCount || maxPages,
			),
		);

		logger.info(
			"[Scraper] Starting source pipeline",
			{
				sourceRoot,
				userId,
				maxPages,
				discoveredCount:
					discovery.discoveredCount,
				usedSitemap: discovery.usedSitemap,
				preferredCrawler: firecrawlService.isAvailable
					? "firecrawl"
					: "builtin",
			},
		);

		await pineconeService.ensureIndexExists();
		await pineconeService.deleteDocumentsByUrl(
			userId,
			sourceRoot,
		);

		await reportProgress?.({
			totalPages: plannedPages,
			scrapedPages: 0,
			storedPages: 0,
			currentUrl: sourceRoot,
		});

		let pages: ScrapedPage[] = [];
		let usedFirecrawl = false;

		// Always try Firecrawl first (handles JS-rendered pages, cleaner markdown)
		if (firecrawlService.isAvailable) {
			try {
				pages = await firecrawlService.crawlWebsite(
					sourceRoot,
					maxPages,
					maxDepth,
					async (done, total) => {
						await reportProgress?.({
							totalPages: Math.max(
								plannedPages,
								total,
								done,
								1,
							),
							scrapedPages: done,
							storedPages: 0,
							currentUrl: sourceRoot,
						});
					},
					discovery.pages.map((page) => page.url),
				);
				usedFirecrawl = pages.length > 0;
			} catch (error) {
				firstFailureReason =
					error instanceof Error
						? error.message
						: String(error);
				logger.warn(
					"[Scraper] Firecrawl crawl failed; falling back to built-in crawler",
					{
						sourceRoot,
						error: firstFailureReason,
					},
				);
			}
		}

		// Fall back to built-in crawler only if Firecrawl is unavailable or failed
		if (!usedFirecrawl) {
			try {
				pages = await this.builtInCrawl(
					sourceRoot,
					maxPages,
					maxDepth,
					discovery,
					async (scraped, total) => {
						await reportProgress?.({
							totalPages: Math.max(
								plannedPages,
								total,
								scraped,
								1,
							),
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
				pages.map((page) => [
					page.url,
					enrichScrapedPage({
						...page,
						metadata: {
							...(page.metadata ?? {}),
							discoveredPageCount:
								discovery.discoveredCount,
						},
					}),
				]),
			).values(),
		)
			.sort((left, right) => {
				const rightPriority =
					typeof right.metadata?.pagePriority ===
					"number"
						? right.metadata.pagePriority
						: 0;
				const leftPriority =
					typeof left.metadata?.pagePriority ===
					"number"
						? left.metadata.pagePriority
						: 0;
				if (rightPriority !== leftPriority) {
					return rightPriority - leftPriority;
				}
				return left.url.localeCompare(right.url);
			})
			.slice(0, maxPages);

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

		const indexingResult =
			await this.indexPagesInBatches(
			userId,
			sourceRoot,
			pages,
			reportProgress,
		);
		const storedPages =
			indexingResult.storedPages;
		const failedUrls =
			indexingResult.failedUrls;
		if (storedPages === 0) {
			return {
				success: false,
				message:
					"Scraping completed, but no pages could be indexed successfully",
				pagesScraped: pages.length,
				visitedPages: pages.length,
				storedPages: 0,
				pages,
				failureReason:
					failedUrls.length > 0
						? `Indexing failed for ${failedUrls.length} page(s)`
						: "No pages were indexed",
				failedUrls,
			};
		}

		const summary =
			failedUrls.length > 0
				? usedFirecrawl
					? `Scraped ${pages.length} page(s) via Firecrawl and indexed ${storedPages}; ${failedUrls.length} page(s) failed during indexing`
					: `Scraped ${pages.length} page(s) via built-in crawler and indexed ${storedPages}; ${failedUrls.length} page(s) failed during indexing`
				: usedFirecrawl
					? `Successfully scraped and indexed ${storedPages} page(s) via Firecrawl`
					: `Successfully scraped and indexed ${storedPages} page(s) via built-in crawler`;

		logger.info("[Scraper] Source pipeline completed", {
			sourceRoot,
			userId,
			pages: pages.length,
			storedPages,
			failedPages: failedUrls.length,
			usedFirecrawl,
			discoveredCount:
				discovery.discoveredCount,
		});

		return {
			success: true,
			message: summary,
			pagesScraped: pages.length,
			visitedPages: pages.length,
			storedPages,
			pages,
			failedUrls:
				failedUrls.length > 0
					? failedUrls
					: undefined,
		};
	}
}

export const scraperService =
	new ScraperService();
