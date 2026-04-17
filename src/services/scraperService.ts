import axios from "axios";
import * as cheerio from "cheerio";
import { config } from "../config/env";
import { RagChunk, ScrapedPage } from "../types";
import logger from "../utils/logger";
import { assertSafeOutgoingUrl } from "../utils/networkSafety";
import { chunkMarkdown } from "./chunkingService";
import { enrichChunksWithContext } from "./contextualRetrievalService";
import {
	firecrawlCrawlWebsite,
	firecrawlEnabled,
} from "./firecrawlService";
import { upsertHypeAsync } from "./hypeService";
import { extractAsync as extractPageMetadataAsync } from "./pageMetadataService";
import { pineconeService } from "./pineconeService";
import { scraperSourceService } from "./scraperSourceService";
import personaService from "./personaService";

interface CrawlOptions {
	maxDepth?: number;
	maxPages?: number;
	onProgress?: (progress: {
		totalPages: number;
		scrapedPages: number;
		storedPages: number;
		currentUrl?: string;
		stage?:
			| "scraping_pages"
			| "pinecone_upsert_started"
			| "pinecone_embeddings_prepared"
			| "pinecone_stale_chunk_cleanup_completed"
			| "pinecone_upsert_completed"
			| "scraper_primary_pinecone_upsert_completed";
		percent?: number;
		stageLabel?: string;
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

interface PersistScrapedPagesResult {
	chunks: number;
	indexedPages: number;
	skippedEmbedding: boolean;
}

interface RobotsPolicy {
	allow: string[];
	disallow: string[];
	sitemaps: string[];
}

interface FetchPageResult {
	html: string;
	status: number;
	finalUrl: string;
	contentType: string;
}

const SCRAPER_PAGE_FETCH_TIMEOUT_MS = 20000;
const SCRAPER_PAGE_FETCH_MAX_ATTEMPTS = 2;
const SCRAPER_PAGE_FETCH_RETRY_DELAY_MS = 1200;

const TRACKING_QUERY_KEYS = new Set([
	"gclid",
	"fbclid",
	"msclkid",
	"mc_cid",
	"mc_eid",
	"ref",
	"ref_src",
	"source",
]);

class ScraperService {
	private async wait(ms: number): Promise<void> {
		await new Promise((resolve) =>
			setTimeout(resolve, ms),
		);
	}

	private isRetryableFetchError(error: unknown): boolean {
		if (!axios.isAxiosError(error)) {
			return false;
		}

		const status = error.response?.status;
		return (
			error.code === "ECONNABORTED" ||
			error.code === "ECONNRESET" ||
			error.code === "ETIMEDOUT" ||
			error.code === "EAI_AGAIN" ||
			(status !== undefined && status >= 500)
		);
	}

	private normalizeUrl(url: string): string {
		try {
			const urlObj = new URL(url.trim());
			if (
				urlObj.protocol !== "http:" &&
				urlObj.protocol !== "https:"
			) {
				throw new Error("invalid protocol");
			}
			urlObj.protocol =
				urlObj.protocol.toLowerCase();
			urlObj.hash = "";
			urlObj.username = "";
			urlObj.password = "";
			urlObj.hostname =
				urlObj.hostname.toLowerCase();
			if (
				(urlObj.protocol === "http:" &&
					urlObj.port === "80") ||
				(urlObj.protocol === "https:" &&
					urlObj.port === "443")
			) {
				urlObj.port = "";
			}
			urlObj.pathname =
				urlObj.pathname === ""
					? "/"
					: urlObj.pathname;
			if (urlObj.pathname.length > 1) {
				urlObj.pathname =
					urlObj.pathname.replace(/\/+$/, "") ||
					"/";
			}
			const cleanedParams = new URLSearchParams();
			for (const [
				key,
				value,
			] of urlObj.searchParams.entries()) {
				const normalizedKey = key
					.trim()
					.toLowerCase();
				if (
					normalizedKey.startsWith("utm_") ||
					TRACKING_QUERY_KEYS.has(normalizedKey)
				) {
					continue;
				}
				cleanedParams.append(key, value);
			}
			urlObj.search = cleanedParams.toString();
			return urlObj.toString();
		} catch {
			return url;
		}
	}

	private hostNameFromUrl(url: string): string {
		try {
			return new URL(url).hostname
				.toLowerCase()
				.trim();
		} catch {
			return "";
		}
	}

	private sameSiteHost(
		left: string,
		right: string,
	): boolean {
		const normalize = (value: string) =>
			value
				.toLowerCase()
				.trim()
				.replace(/^www\./, "");
		return (
			Boolean(left) &&
			Boolean(right) &&
			normalize(left) === normalize(right)
		);
	}

	private shouldSkipCrawlPath(
		url: string,
	): boolean {
		try {
			const parsed = new URL(url.trim());
			const rawPath = parsed.pathname
				.toLowerCase()
				.trim();
			for (const fragment of [
				"/wp-admin",
				"/admin",
				"/signin",
				"/sign-in",
				"/signup",
				"/sign-up",
				"/login",
				"/logout",
				"/register",
				"/cart",
				"/checkout",
				"/account",
				"/auth",
				"/api/",
				"/cdn-cgi/",
			]) {
				if (rawPath.includes(fragment)) {
					return true;
				}
			}

			const ext =
				rawPath.match(/\.[a-z0-9]+$/i)?.[0] || "";
			return new Set([
				".png",
				".jpg",
				".jpeg",
				".gif",
				".webp",
				".svg",
				".ico",
				".bmp",
				".tiff",
				".css",
				".js",
				".map",
				".woff",
				".woff2",
				".ttf",
				".otf",
				".pdf",
				".zip",
				".tar",
				".gz",
				".rar",
				".7z",
				".mp3",
				".wav",
				".ogg",
				".mp4",
				".mov",
				".avi",
				".webm",
				".json",
				".xml",
			]).has(ext);
		} catch {
			return true;
		}
	}

	private isValidInternalUrl(
		url: string,
		baseUrl: string,
	): boolean {
		try {
			const urlObj = new URL(url);
			const baseUrlObj = new URL(baseUrl);
			if (
				!this.sameSiteHost(
					urlObj.hostname,
					baseUrlObj.hostname,
				)
			) {
				return false;
			}
			if (
				this.shouldSkipCrawlPath(
					urlObj.toString(),
				)
			) {
				return false;
			}
			if (!urlObj.protocol.startsWith("http"))
				return false;
			return true;
		} catch {
			return false;
		}
	}

	private async fetchPageContent(
		url: string,
	): Promise<FetchPageResult> {
		let currentUrl = url;
		const visitedRedirectStates =
			new Set<string>();
		const maxRedirects = 10;
		const cookieJar = new Map<string, string>();

		for (
			let redirectCount = 0;
			redirectCount < maxRedirects;
			redirectCount += 1
		) {
			const safeUrl = await assertSafeOutgoingUrl(
				currentUrl,
				{
					allowHttp: true,
				},
			);
			const cookieHeader = Array.from(
				cookieJar.entries(),
			)
				.map(
					([name, value]) => `${name}=${value}`,
				)
				.join("; ");
			const requestStateKey = `${safeUrl.toString()}|${cookieHeader}`;
			if (
				visitedRedirectStates.has(requestStateKey)
			) {
				throw new Error(
					"Redirect loop detected while scraping",
				);
			}
			visitedRedirectStates.add(requestStateKey);
			let response;
			let lastError: unknown = null;
			for (
				let attempt = 1;
				attempt <=
				SCRAPER_PAGE_FETCH_MAX_ATTEMPTS;
				attempt += 1
			) {
				try {
					response = await axios.get(
						safeUrl.toString(),
						{
							headers: {
								"User-Agent":
									"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
								...(cookieHeader
									? {
											Cookie: cookieHeader,
									  }
									: {}),
							},
							timeout:
								SCRAPER_PAGE_FETCH_TIMEOUT_MS,
							maxRedirects: 0,
							validateStatus: (
								status,
							) =>
								status >= 200 &&
								status < 600,
						},
					);
					lastError = null;
					break;
				} catch (error) {
					lastError = error;
					if (
						attempt >=
							SCRAPER_PAGE_FETCH_MAX_ATTEMPTS ||
						!this.isRetryableFetchError(
							error,
						)
					) {
						break;
					}

					logger.warn(
						"Retrying scraper page fetch after transient failure",
						{
							url: safeUrl.toString(),
							attempt,
							maxAttempts:
								SCRAPER_PAGE_FETCH_MAX_ATTEMPTS,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
					await this.wait(
						SCRAPER_PAGE_FETCH_RETRY_DELAY_MS,
					);
				}
			}

			if (!response) {
				throw lastError instanceof Error
					? lastError
					: new Error(
							"Failed to fetch page content",
					  );
			}
			const setCookieHeaders =
				response.headers["set-cookie"];
			const cookies = Array.isArray(
				setCookieHeaders,
			)
				? setCookieHeaders
				: typeof setCookieHeaders === "string"
					? [setCookieHeaders]
					: [];
			for (const setCookie of cookies) {
				const [cookiePair] = setCookie.split(";");
				const separatorIndex =
					cookiePair.indexOf("=");
				if (separatorIndex <= 0) {
					continue;
				}
				const name = cookiePair
					.slice(0, separatorIndex)
					.trim();
				const value = cookiePair
					.slice(separatorIndex + 1)
					.trim();
				if (!name) {
					continue;
				}
				cookieJar.set(name, value);
			}

			if (
				response.status >= 300 &&
				response.status < 400
			) {
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

			return {
				html:
					typeof response.data === "string"
						? response.data
						: String(response.data ?? ""),
				status: response.status,
				finalUrl: safeUrl.toString(),
				contentType: String(
					response.headers["content-type"] || "",
				).toLowerCase(),
			};
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
		$("script, style, noscript, iframe").remove();

		const title =
			$("title").text().trim() ||
			$("h1").first().text().trim() ||
			"No Title";
		const description =
			$('meta[name="description"]')
				.attr("content")
				?.trim() ||
			$('meta[property="og:description"]')
				.attr("content")
				?.trim() ||
			$('meta[name="twitter:description"]')
				.attr("content")
				?.trim() ||
			"";
		const primaryText = $("main, article, body")
			.first()
			.text()
			.replace(/\s+/g, " ")
			.trim();
		const content = (
			primaryText ||
			[title, description]
				.filter(Boolean)
				.join(". ")
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
		const canonical =
			$('link[rel="canonical"]')
				.attr("href")
				?.trim() || "";
		if (canonical) {
			try {
				metadata.canonical = new URL(
					canonical,
					url,
				).toString();
			} catch {
				metadata.canonical = canonical;
			}
		}

		return {
			url,
			title,
			content,
			links: [...new Set(links)],
			metadata,
		};
	}

	private isLikelyBotChallenge(
		status: number,
		html: string,
	): boolean {
		if (
			status === 403 ||
			status === 429 ||
			status === 503
		) {
			return true;
		}
		return /(captcha|cf-browser-verification|attention required|cloudflare|bot challenge)/i.test(
			html,
		);
	}

	private buildPrioritySeedUrls(
		rootUrl: string,
	): string[] {
		const paths = [
			"/",
			"/about",
			"/pricing",
			"/contact",
			"/faq",
			"/docs",
			"/support",
		];
		const seeds: string[] = [];
		for (const path of paths) {
			try {
				seeds.push(
					this.normalizeUrl(
						new URL(path, rootUrl).toString(),
					),
				);
			} catch {
				// ignore invalid seed
			}
		}
		return [...new Set(seeds)];
	}

	private async fetchRobotsPolicy(
		rootUrl: string,
	): Promise<RobotsPolicy> {
		try {
			const base = new URL(rootUrl);
			const robotsUrl = `${base.protocol}//${base.host}/robots.txt`;
			const response = await axios.get(
				robotsUrl,
				{
					timeout: 10000,
					validateStatus: (status) =>
						status >= 200 && status < 500,
				},
			);
			if (response.status >= 400) {
				return {
					allow: [],
					disallow: [],
					sitemaps: [],
				};
			}

			const policy: RobotsPolicy = {
				allow: [],
				disallow: [],
				sitemaps: [],
			};
			const lines = String(
				response.data || "",
			).split(/\r?\n/);
			let sectionApplies = false;
			for (const rawLine of lines) {
				const line = rawLine
					.replace(/\s+#.*$/, "")
					.trim();
				if (!line) continue;
				const lower = line.toLowerCase();
				if (lower.startsWith("user-agent:")) {
					const agent = line
						.split(":")
						.slice(1)
						.join(":")
						.trim()
						.toLowerCase();
					sectionApplies =
						agent === "*" ||
						agent.includes("witzocrawler");
					continue;
				}
				if (lower.startsWith("sitemap:")) {
					const value = line
						.split(":")
						.slice(1)
						.join(":")
						.trim();
					if (value) {
						policy.sitemaps.push(
							this.normalizeUrl(value),
						);
					}
					continue;
				}
				if (!sectionApplies) continue;
				if (lower.startsWith("allow:")) {
					const value = line
						.split(":")
						.slice(1)
						.join(":")
						.trim();
					if (value) {
						policy.allow.push(value);
					}
					continue;
				}
				if (lower.startsWith("disallow:")) {
					const value = line
						.split(":")
						.slice(1)
						.join(":")
						.trim();
					if (value) {
						policy.disallow.push(value);
					}
				}
			}
			return policy;
		} catch {
			return {
				allow: [],
				disallow: [],
				sitemaps: [],
			};
		}
	}

	private isRobotsAllowed(
		policy: RobotsPolicy,
		targetUrl: string,
	): boolean {
		if (
			policy.allow.length === 0 &&
			policy.disallow.length === 0
		) {
			return true;
		}
		try {
			const parsed = new URL(targetUrl);
			const targetPath = parsed.pathname || "/";
			let matchedLength = -1;
			let allowed = true;
			for (const rule of policy.disallow) {
				if (
					rule &&
					targetPath.startsWith(rule) &&
					rule.length > matchedLength
				) {
					matchedLength = rule.length;
					allowed = false;
				}
			}
			for (const rule of policy.allow) {
				if (
					rule &&
					targetPath.startsWith(rule) &&
					rule.length > matchedLength
				) {
					matchedLength = rule.length;
					allowed = true;
				}
			}
			return allowed;
		} catch {
			return false;
		}
	}

	private async parseSitemapUrls(
		sitemapUrl: string,
		depth: number = 0,
	): Promise<string[]> {
		if (depth > 2) {
			return [];
		}
		try {
			const response = await axios.get(
				sitemapUrl,
				{
					timeout: 12000,
					validateStatus: (status) =>
						status >= 200 && status < 500,
				},
			);
			if (response.status >= 400) {
				return [];
			}
			const xml = String(response.data || "");
			const locMatches = [
				...xml.matchAll(/<loc>(.*?)<\/loc>/gi),
			].map((match) => match[1]?.trim() || "");
			const nested: string[] = [];
			for (const loc of locMatches) {
				if (!loc) continue;
				if (
					/sitemap/i.test(loc) &&
					/\.xml(\?.*)?$/i.test(loc)
				) {
					nested.push(
						...(await this.parseSitemapUrls(
							loc,
							depth + 1,
						)),
					);
					continue;
				}
				nested.push(loc);
			}
			return nested;
		} catch {
			return [];
		}
	}

	private async discoverSitemapUrls(
		rootUrl: string,
		maxCount: number,
	): Promise<string[]> {
		if (maxCount <= 0) {
			return [];
		}
		try {
			const base = new URL(rootUrl);
			const policy =
				await this.fetchRobotsPolicy(rootUrl);
			const candidates = [
				...policy.sitemaps,
				`${base.protocol}//${base.host}/sitemap.xml`,
				`${base.protocol}//${base.host}/sitemap_index.xml`,
			];
			const seen = new Set<string>();
			const urls: string[] = [];
			for (const candidate of candidates) {
				const normalizedCandidate =
					this.normalizeUrl(candidate);
				if (seen.has(normalizedCandidate)) {
					continue;
				}
				seen.add(normalizedCandidate);
				for (const rawUrl of await this.parseSitemapUrls(
					normalizedCandidate,
				)) {
					const normalizedUrl =
						this.normalizeUrl(rawUrl);
					if (
						!this.sameSiteHost(
							base.hostname,
							this.hostNameFromUrl(normalizedUrl),
						) ||
						this.shouldSkipCrawlPath(
							normalizedUrl,
						) ||
						seen.has(normalizedUrl)
					) {
						continue;
					}
					seen.add(normalizedUrl);
					urls.push(normalizedUrl);
					if (urls.length >= maxCount) {
						return urls;
					}
				}
			}
			return urls;
		} catch {
			return [];
		}
	}

	private looksLikeClientRendered(
		html: string,
		content: string,
	): boolean {
		const textWordCount = content
			.trim()
			.split(/\s+/)
			.filter(Boolean).length;
		const scriptCount = (
			html.match(/<script/gi) || []
		).length;
		return (
			(textWordCount <= 40 && scriptCount >= 8) ||
			(textWordCount <= 60 &&
				/(data-reactroot|__NEXT_DATA__|id="root"|id="__next"|window\.__INITIAL_STATE__)/i.test(
					html,
				))
		);
	}

	private canUseRenderFallback(): boolean {
		return Boolean(
			config.SCRAPER_RENDER_SERVICE_URL?.trim(),
		);
	}

	private async fetchRenderedHTML(
		targetUrl: string,
		timeoutMs: number = 25000,
	): Promise<{
		html: string;
		finalUrl?: string;
	}> {
		const renderServiceUrl =
			config.SCRAPER_RENDER_SERVICE_URL?.trim();
		if (!renderServiceUrl) {
			throw new Error(
				"Render service is not configured",
			);
		}

		const mode = (
			config.SCRAPER_RENDER_SERVICE_MODE || "json"
		)
			.trim()
			.toLowerCase();
		const payload =
			mode === "browserless"
				? {
						url: targetUrl,
						waitUntil: "networkidle0",
						timeout: timeoutMs,
						bestAttempt: true,
					}
				: {
						url: targetUrl,
						waitUntil: "networkidle",
						timeoutMs,
					};
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (
			config.SCRAPER_RENDER_SERVICE_TOKEN &&
			mode !== "browserless"
		) {
			headers.Authorization = `Bearer ${config.SCRAPER_RENDER_SERVICE_TOKEN}`;
		}

		let requestUrl = renderServiceUrl;
		if (
			mode === "browserless" &&
			config.SCRAPER_RENDER_SERVICE_TOKEN
		) {
			const parsed = new URL(renderServiceUrl);
			parsed.searchParams.set(
				"token",
				config.SCRAPER_RENDER_SERVICE_TOKEN,
			);
			requestUrl = parsed.toString();
		}

		const response = await axios.post(
			requestUrl,
			payload,
			{
				headers,
				timeout: timeoutMs + 5000,
			},
		);
		const data = response.data ?? {};
		return {
			html:
				typeof data.html === "string"
					? data.html
					: typeof data.content === "string"
						? data.content
						: "",
			finalUrl:
				typeof data.url === "string"
					? data.url
					: undefined,
		};
	}

	private async buildRagChunks(
		userId: string,
		sourceUrl: string,
		pages: ScrapedPage[],
	): Promise<RagChunk[]> {
		const chunks: RagChunk[] = [];
		for (const page of pages) {
			const pairs = await chunkMarkdown(
				page.content,
				page.title,
			);
			for (
				let index = 0;
				index < pairs.length;
				index += 1
			) {
				chunks.push({
					userId,
					url: page.url,
					pageTitle: page.title,
					childText: pairs[index].childText,
					parentText: pairs[index].parentText,
					chunkIndex: index,
					sourceType: "website",
					sourceKey: sourceUrl,
				});
			}
		}
		return chunks;
	}

	private async persistScrapedPages(
		userId: string,
		sourceUrl: string,
		sourceTitle: string,
		pages: ScrapedPage[],
		reportProgress?: (progress: {
			totalPages: number;
			scrapedPages: number;
			storedPages: number;
			currentUrl?: string;
			stage?:
				| "scraping_pages"
				| "pinecone_upsert_started"
				| "pinecone_embeddings_prepared"
				| "pinecone_stale_chunk_cleanup_completed"
				| "pinecone_upsert_completed"
				| "scraper_primary_pinecone_upsert_completed";
			percent?: number;
			stageLabel?: string;
		}) => Promise<void> | void,
	): Promise<PersistScrapedPagesResult> {
		const startedAt = Date.now();
		const rawContent =
			scraperSourceService.buildRawContent(pages);
		const contentHash =
			scraperSourceService.computeContentHash(
				rawContent,
			);
		const existingHash =
			await scraperSourceService.getContentHash(
				userId,
				sourceUrl,
			);

		if (existingHash && existingHash === contentHash) {
			const sourceExists =
				await pineconeService.checkSourceExists(
					userId,
					sourceUrl,
				);
			if (sourceExists.exists) {
				logger.info(
					"scrape dedup: content unchanged, skipping re-index",
					{
						userId,
						sourceUrl,
						pages: pages.length,
						chunks: sourceExists.chunks,
					},
				);
				await reportProgress?.({
					totalPages: pages.length,
					scrapedPages: pages.length,
					storedPages: pages.length,
					currentUrl: sourceUrl,
					stage:
						"scraper_primary_pinecone_upsert_completed",
					percent: 100,
					stageLabel:
						"Content unchanged; existing vectors reused",
				});
				try {
					await personaService.autoDetectAndApplyPersona(
						userId,
						pages,
					);
				} catch (error) {
					logger.warn(
						"scraper: persona auto-detection failed",
						{
							userId,
							sourceUrl,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
				}
				return {
					chunks: sourceExists.chunks,
					indexedPages: pages.length,
					skippedEmbedding: true,
				};
			}
			logger.info(
				"scrape dedup: content unchanged but no vectors found; forcing re-index",
				{ userId, sourceUrl },
			);
		}

		const chunks = await this.buildRagChunks(
			userId,
			sourceUrl,
			pages,
		);
		if (chunks.length === 0) {
			throw new Error(
				"No chunks generated from scraped pages",
			);
		}

		// Enrich chunks with contextual summaries (Anthropic's Contextual Retrieval)
		const pageContentByUrl = new Map(
			pages.map((p) => [
				p.url,
				{ content: p.content, title: p.title },
			]),
		);
		await enrichChunksWithContext(
			chunks,
			pageContentByUrl,
		);

		logger.info(
			"scraper: persistence pipeline starting",
			{
				userId,
				sourceUrl,
				pages: pages.length,
				chunks: chunks.length,
				contentHash,
			},
		);
		// Persist to PostgreSQL BEFORE starting the Pinecone upsert.
		// This makes the website appear immediately in the data-source list
		// (with 0 indexed chunks) so users are not staring at a blank list
		// for the entire duration of the embedding preparation (which can
		// take 10+ minutes for large sites). The rag_source_pages chunk
		// counts are updated later when the Pinecone upsert completes.
		await scraperSourceService.persistSource(
			userId,
			sourceUrl,
			sourceTitle,
			pages,
			rawContent,
			contentHash,
		);
		try {
			await personaService.autoDetectAndApplyPersona(
				userId,
				pages,
			);
		} catch (error) {
			logger.warn(
				"scraper: persona auto-detection failed",
				{
					userId,
					sourceUrl,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
		}
		await scraperSourceService.setMetadataReady(
			userId,
			sourceUrl,
			false,
		);

		const pineconeStartedAt = Date.now();
		await pineconeService.upsertChunks(
			userId,
			chunks,
			{
				sourceRoot: sourceUrl,
				sourceRootTitle:
					sourceTitle ||
					pages[0]?.title ||
					sourceUrl,
				scrapedAt: new Date().toISOString(),
			},
			async (stageProgress) => {
				await reportProgress?.({
					totalPages: pages.length,
					scrapedPages: pages.length,
					storedPages: 0,
					currentUrl: sourceUrl,
					stage: stageProgress.stage,
					percent: stageProgress.percent,
					stageLabel: stageProgress.label,
				});
			},
		);
		logger.info(
			"scraper: primary Pinecone upsert completed",
			{
				userId,
				sourceUrl,
				pages: pages.length,
				chunks: chunks.length,
				durationMs:
					Date.now() - pineconeStartedAt,
			},
		);
		const indexedPages = new Set(
			chunks.map((chunk) => chunk.url),
		).size;
		await reportProgress?.({
			totalPages: pages.length,
			scrapedPages: pages.length,
			storedPages: indexedPages,
			currentUrl: sourceUrl,
			stage:
				"scraper_primary_pinecone_upsert_completed",
			percent: 100,
			stageLabel:
				"Training completed",
		});
		logger.info(
			"scraper: enrichment started",
			{
				userId,
				sourceUrl,
				pages: pages.length,
				chunks: chunks.length,
				indexedPages,
			},
		);

		const enrichmentStartedAt = Date.now();
		void (async () => {
			try {
				const metadataResult =
					await extractPageMetadataAsync(
						pages,
						chunks,
						async (
							ownerId,
							vectorId,
							metadata,
						) =>
							pineconeService.updateVectorMetadata(
								ownerId,
								vectorId,
								metadata,
							),
					);
				if (metadataResult.completed) {
					await scraperSourceService.setMetadataReady(
						userId,
						sourceUrl,
						true,
					);
				}
			} catch (error) {
				logger.warn(
					"scraper: enrichment task failed",
					{
						userId,
						sourceUrl,
						task: "page_metadata",
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}

			try {
				await upsertHypeAsync(
					userId,
					sourceUrl,
					chunks,
				);
			} catch (error) {
				logger.warn(
					"scraper: enrichment task failed",
					{
						userId,
						sourceUrl,
						task: "hype",
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}

			logger.info(
				"scraper: background enrichment completed",
				{
					userId,
					sourceUrl,
					pages: pages.length,
					chunks: chunks.length,
					indexedPages,
					durationMs:
						Date.now() - enrichmentStartedAt,
				},
			);
		})();

		logger.info(
			"scraper: persistence pipeline finished",
			{
				userId,
				sourceUrl,
				pages: pages.length,
				chunks: chunks.length,
				indexedPages,
				durationMs: Date.now() - startedAt,
			},
		);
		return {
			chunks: chunks.length,
			indexedPages,
			skippedEmbedding: false,
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
		const maxDepth = options.maxDepth || 4;
		const requestedMaxPages =
			typeof options.maxPages === "number" &&
			Number.isFinite(options.maxPages) &&
			options.maxPages > 0
				? Math.trunc(options.maxPages)
				: undefined;
		const crawlerMaxPages =
			requestedMaxPages ?? 300;
		const reportProgress = options.onProgress;
		const visitedUrls = new Set<string>();
		const enqueuedUrls = new Set<string>();
		const urlQueue: Array<{
			url: string;
			depth: number;
		}> = [{ url: rootUrl, depth: 0 }];
		enqueuedUrls.add(rootUrl);
		const scrapedPages: ScrapedPage[] = [];
		let firstFailureReason: string | null = null;
		const robotsPolicy =
			await this.fetchRobotsPolicy(rootUrl);

		for (const seed of this.buildPrioritySeedUrls(
			rootUrl,
		)) {
			if (enqueuedUrls.has(seed)) continue;
			urlQueue.push({ url: seed, depth: 1 });
			enqueuedUrls.add(seed);
		}
		for (const seed of await this.discoverSitemapUrls(
			rootUrl,
			crawlerMaxPages * 2,
		)) {
			if (enqueuedUrls.has(seed)) continue;
			urlQueue.push({ url: seed, depth: 1 });
			enqueuedUrls.add(seed);
		}

		logger.info(
			`Starting synchronous scrape for user ${userId} on ${url}`,
			{
				maxDepth,
				maxPages: requestedMaxPages ?? null,
				crawlerMaxPages,
			},
		);

		await pineconeService.ensureIndexExists();
		await reportProgress?.({
			totalPages: 1,
			scrapedPages: 0,
			storedPages: 0,
			currentUrl: rootUrl,
			stage: "scraping_pages",
			percent: 5,
			stageLabel: "Scraping pages",
		});

		let usedFirecrawl = false;
		if (firecrawlEnabled()) {
			try {
				const firecrawlPages =
					await firecrawlCrawlWebsite(
						rootUrl,
						requestedMaxPages,
						(completed, total) => {
							void reportProgress?.({
								totalPages: Math.max(
									total,
									completed,
								),
								scrapedPages: completed,
								storedPages: 0,
								currentUrl: rootUrl,
								stage: "scraping_pages",
								percent:
									5 +
									Math.round(
										Math.min(
											1,
											completed /
												Math.max(total, 1),
										) * 40,
									),
								stageLabel: "Scraping pages",
							});
						},
					);
				if (firecrawlPages.length > 0) {
					rootTitle =
						firecrawlPages[0]?.title || "";
					const persisted =
						await this.persistScrapedPages(
							userId,
							rootUrl,
							rootTitle,
							firecrawlPages,
							reportProgress,
						);
					await reportProgress?.({
						totalPages: firecrawlPages.length,
						scrapedPages: firecrawlPages.length,
						storedPages:
							persisted.indexedPages,
						currentUrl: rootUrl,
					});
					return {
						success: true,
						message: `Successfully scraped ${firecrawlPages.length} page(s) via Firecrawl`,
						pagesScraped: firecrawlPages.length,
						visitedPages: firecrawlPages.length,
						storedPages:
							persisted.indexedPages,
						pages: firecrawlPages,
					};
				}
			} catch (error) {
				usedFirecrawl = true;
				const errorMessage =
					error instanceof Error
						? error.message
						: String(error);
				firstFailureReason =
					firstFailureReason || errorMessage;
				logger.warn(
					"Firecrawl failed, falling back to built-in scraper",
					{ url: rootUrl, error: errorMessage },
				);
			}
		}

		while (
			urlQueue.length > 0 &&
			visitedUrls.size < crawlerMaxPages
		) {
			const { url: currentUrl, depth } =
				urlQueue.shift()!;
			const normalizedUrl =
				this.normalizeUrl(currentUrl);

			if (visitedUrls.has(normalizedUrl))
				continue;
			if (depth > maxDepth) continue;
			if (this.shouldSkipCrawlPath(normalizedUrl))
				continue;
			if (
				!this.isRobotsAllowed(
					robotsPolicy,
					normalizedUrl,
				)
			) {
				continue;
			}

			visitedUrls.add(normalizedUrl);

			try {
				const pageResponse =
					await this.fetchPageContent(
						normalizedUrl,
					);
				let html = pageResponse.html;
				let finalUrl = this.normalizeUrl(
					pageResponse.finalUrl || normalizedUrl,
				);
				let contentType =
					pageResponse.contentType;
				let status = pageResponse.status;

				if (
					status >= 300 &&
					this.canUseRenderFallback() &&
					this.isLikelyBotChallenge(status, html)
				) {
					try {
						const rendered =
							await this.fetchRenderedHTML(
								finalUrl,
							);
						if (rendered.html.trim()) {
							html = rendered.html;
							finalUrl = this.normalizeUrl(
								rendered.finalUrl || finalUrl,
							);
							contentType = "text/html";
							status = 200;
						}
					} catch (renderError) {
						logger.warn(
							"Render fallback failed for blocked scraper page",
							{
								url: normalizedUrl,
								renderError,
								status,
							},
						);
					}
				}

				if (status >= 300) {
					continue;
				}

				let pageData = this.extractPageData(
					html,
					finalUrl,
				);

				if (
					this.canUseRenderFallback() &&
					((contentType.includes("text/html") &&
						this.looksLikeClientRendered(
							html,
							pageData.content,
						)) ||
						!pageData.content.trim())
				) {
					try {
						const rendered =
							await this.fetchRenderedHTML(
								finalUrl,
							);
						if (rendered.html.trim()) {
							html = rendered.html;
							finalUrl = this.normalizeUrl(
								rendered.finalUrl || finalUrl,
							);
							pageData = this.extractPageData(
								rendered.html,
								finalUrl,
							);
						}
					} catch (renderError) {
						logger.warn(
							"Render fallback failed for scraper page",
							{
								url: normalizedUrl,
								renderError,
							},
						);
					}
				}

				if (depth === 0 && pageData.title) {
					rootTitle = pageData.title;
				}

				if (!pageData.content.trim()) {
					continue;
				}

				const canonical = String(
					pageData.metadata?.canonical || "",
				).trim();
				if (
					canonical &&
					this.sameSiteHost(
						this.hostNameFromUrl(rootUrl),
						this.hostNameFromUrl(canonical),
					)
				) {
					const normalizedCanonical =
						this.normalizeUrl(canonical);
					if (
						!visitedUrls.has(
							normalizedCanonical,
						) &&
						!enqueuedUrls.has(normalizedCanonical)
					) {
						urlQueue.push({
							url: normalizedCanonical,
							depth: depth + 1,
						});
						enqueuedUrls.add(normalizedCanonical);
					}
				}

				scrapedPages.push(pageData);

				if (depth < maxDepth) {
					for (const link of pageData.links) {
						const normalizedLink =
							this.normalizeUrl(link);
						if (
							!visitedUrls.has(normalizedLink) &&
							!enqueuedUrls.has(normalizedLink) &&
							this.isValidInternalUrl(
								normalizedLink,
								url,
							)
						) {
							urlQueue.push({
								url: normalizedLink,
								depth: depth + 1,
							});
							enqueuedUrls.add(normalizedLink);
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
				logger.error(
					`Error scraping ${normalizedUrl}`,
					{ error, errorMessage },
				);
			} finally {
				await reportProgress?.({
					totalPages:
						requestedMaxPages !== undefined
							? Math.min(
									requestedMaxPages,
									Math.max(
										visitedUrls.size +
											urlQueue.length,
										visitedUrls.size,
									),
								)
							: Math.max(
									visitedUrls.size +
										urlQueue.length,
									visitedUrls.size,
								),
					scrapedPages: visitedUrls.size,
					storedPages: 0,
					currentUrl: normalizedUrl,
					stage: "scraping_pages",
					percent:
						5 +
						Math.round(
							Math.min(
								1,
								visitedUrls.size /
									Math.max(
										visitedUrls.size +
											urlQueue.length,
										1,
									),
							) * 40,
						),
					stageLabel: "Scraping pages",
				});
			}
		}

		let indexedPages = 0;
		if (scrapedPages.length > 0) {
			const persisted = await this.persistScrapedPages(
				userId,
				rootUrl,
				rootTitle,
				scrapedPages,
				reportProgress,
			);
			indexedPages = persisted.indexedPages;
			await reportProgress?.({
				totalPages: Math.max(
					scrapedPages.length,
					visitedUrls.size,
				),
				scrapedPages: scrapedPages.length,
				storedPages: indexedPages,
				currentUrl: rootUrl,
			});
		}

		logger.info(
			`Scrape completed for user ${userId}`,
			{
				pagesScraped: scrapedPages.length,
				url,
				usedFirecrawl,
			},
		);

		const wasSuccessful = scrapedPages.length > 0;

		return {
			success: wasSuccessful,
			message: wasSuccessful
				? `Successfully scraped ${scrapedPages.length} page(s)`
				: firstFailureReason
					? `Failed to scrape any pages from the provided website: ${firstFailureReason}`
					: "Failed to scrape any pages from the provided website",
			pagesScraped: scrapedPages.length,
			visitedPages: visitedUrls.size,
			storedPages: indexedPages,
			pages: scrapedPages,
			failureReason: wasSuccessful
				? undefined
				: (firstFailureReason ?? undefined),
		};
	}
}

export const scraperService =
	new ScraperService();
