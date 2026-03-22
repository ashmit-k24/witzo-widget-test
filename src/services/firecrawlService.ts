import Firecrawl from "@mendable/firecrawl-js";
import {
	ScrapedPage,
	ScrapedPageBlockType,
	ScrapedPageContentBlock,
} from "../types";
import { config } from "../config/env";
import logger from "../utils/logger";
import {
	isUrlUnderSourceRoot,
	normalizeDiscoveredUrl,
} from "../utils/scrapeUrl";

const FIRECRAWL_MIN_CONTENT_LENGTH = 100;

class FirecrawlService {
	private readonly client: Firecrawl | null = null;

	constructor() {
		if (config.FIRECRAWL_API_KEY) {
			this.client = new Firecrawl({
				apiKey: config.FIRECRAWL_API_KEY,
				...(config.FIRECRAWL_API_URL
					? { apiUrl: config.FIRECRAWL_API_URL }
					: {}),
			});
			logger.info("[Firecrawl] Service initialized", {
				apiUrl:
					config.FIRECRAWL_API_URL ??
					"https://api.firecrawl.dev (default)",
			});
		} else {
			logger.info(
				"[Firecrawl] FIRECRAWL_API_KEY not set; built-in crawler only",
			);
		}
	}

	get isAvailable(): boolean {
		return this.client !== null;
	}

	private hasContactSignals(text: string): boolean {
		return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d\s().-]{6,}|\b(address|phone|email|office|contact|call|reach us|get in touch)\b/i.test(
			text,
		);
	}

	private detectBlockType(
		text: string,
		isList: boolean,
		sectionTitle?: string,
	): ScrapedPageBlockType {
		const normalized =
			`${sectionTitle ?? ""} ${text}`.toLowerCase();
		if (isList) return "list";
		if (
			/\b(price|pricing|plan|package|fee|cost)\b/.test(
				normalized,
			)
		) {
			return "table";
		}
		if (
			/\?$/.test(text.trim()) ||
			/\b(faq|frequently asked|question|answer)\b/.test(
				normalized,
			)
		) {
			return "faq";
		}
		if (this.hasContactSignals(normalized)) {
			return "contact";
		}
		return "paragraph";
	}

	private markdownToContentBlocks(
		markdown: string,
		title: string,
		description: string,
	): ScrapedPageContentBlock[] {
		const blocks: ScrapedPageContentBlock[] = [];
		const seenText = new Set<string>();

		if (description) {
			const summaryText = [title, description]
				.filter(Boolean)
				.join(". ");
			blocks.push({
				text: summaryText,
				blockType: "summary",
				position: 0,
				sectionTitle: title || undefined,
				sectionPath: title ? [title] : undefined,
			});
			seenText.add(summaryText.toLowerCase());
		}

		const sectionStack: Array<{
			level: number;
			title: string;
		}> = [];
		const rawBlocks = markdown
			.split(/\n\s*\n/)
			.map((block) => block.trim())
			.filter(Boolean);

		for (const rawBlock of rawBlocks) {
			const lines = rawBlock
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			if (lines.length === 0) {
				continue;
			}

			const headingMatch = lines[0].match(
				/^(#{1,6})\s+(.+)/,
			);
			if (headingMatch && lines.length === 1) {
				const level = headingMatch[1].length;
				const headingText = headingMatch[2].trim();
				while (
					sectionStack.length > 0 &&
					sectionStack[sectionStack.length - 1].level >=
						level
				) {
					sectionStack.pop();
				}
				sectionStack.push({
					level,
					title: headingText,
				});
				continue;
			}

			const contentLines = lines.filter(
				(line) => !/^#{1,6}\s+/.test(line),
			);
			if (contentLines.length === 0) {
				continue;
			}

			const isList = contentLines.every(
				(line) =>
					/^[-*+]\s+/.test(line) ||
					/^\d+\.\s+/.test(line),
			);
			const text = isList
				? contentLines
						.map((line) =>
							line.replace(/^[-*+\d.]+\s+/, "").trim(),
						)
						.filter(Boolean)
						.join(" | ")
				: contentLines
						.join(" ")
						.replace(/\s+/g, " ")
						.trim();

			if (!text || text.length < 30) {
				continue;
			}

			const normalizedKey = text.toLowerCase();
			if (seenText.has(normalizedKey)) {
				continue;
			}
			seenText.add(normalizedKey);

			const sectionPath = sectionStack.map(
				(section) => section.title,
			);
			const sectionTitle =
				sectionPath[sectionPath.length - 1];

			blocks.push({
				text,
				blockType: this.detectBlockType(
					text,
					isList,
					sectionTitle,
				),
				position: blocks.length,
				sectionTitle,
				sectionPath:
					sectionPath.length > 0
						? sectionPath
						: undefined,
			});
		}

		return blocks.map((block, index) => ({
			...block,
			position: index,
		}));
	}

	private documentToScrapedPage(
		document: any,
		sourceRoot: string,
	): ScrapedPage | null {
		const markdown =
			typeof document?.markdown === "string"
				? document.markdown.trim()
				: "";
		if (markdown.length < FIRECRAWL_MIN_CONTENT_LENGTH) {
			return null;
		}

		const rawUrl =
			document?.metadata?.sourceURL ??
			document?.metadata?.url ??
			sourceRoot;
		const normalizedUrl =
			normalizeDiscoveredUrl(rawUrl) ?? sourceRoot;
		if (!isUrlUnderSourceRoot(normalizedUrl, sourceRoot)) {
			return null;
		}

		const title =
			document?.metadata?.title?.trim() || "No Title";
		const description =
			document?.metadata?.description?.trim() || "";
		const canonicalUrl =
			document?.metadata?.ogUrl?.trim() ||
			document?.metadata?.canonicalUrl?.trim() ||
			document?.metadata?.sourceURL?.trim() ||
			undefined;
		const contentBlocks = this.markdownToContentBlocks(
			markdown,
			title,
			description,
		);
		const links: string[] = [];
		if (Array.isArray(document?.links)) {
			for (const rawLink of document.links as unknown[]) {
				if (typeof rawLink !== "string") {
					continue;
				}
				const normalizedLink =
					normalizeDiscoveredUrl(
						rawLink,
						normalizedUrl,
					);
				if (
					normalizedLink &&
					isUrlUnderSourceRoot(
						normalizedLink,
						sourceRoot,
					)
				) {
					links.push(normalizedLink);
				}
			}
		}

		return {
			url: normalizedUrl,
			title,
			content: markdown,
			links: [...new Set(links)],
			metadata: {
				description,
				canonicalUrl,
				contentBlocks,
				scrapedVia: "firecrawl",
			},
		};
	}

	async crawlWebsite(
		url: string,
		maxPages: number,
		maxDepth: number,
		onProgress?: (
			done: number,
			total: number,
		) => Promise<void> | void,
	): Promise<ScrapedPage[]> {
		if (!this.client) {
			return [];
		}

		logger.info("[Firecrawl] Starting site crawl", {
			url,
			maxPages,
		});

		const start = await this.client.startCrawl(url, {
			limit: maxPages,
			maxDiscoveryDepth: maxDepth,
			ignoreQueryParameters: true,
			deduplicateSimilarURLs: true,
			allowExternalLinks: false,
			scrapeOptions: {
				formats: ["markdown", "links"],
				onlyMainContent: true,
				timeout: config.FIRECRAWL_TIMEOUT_MS,
			},
		});

		if (!start?.id) {
			throw new Error(
				"Firecrawl did not return a crawl job id",
			);
		}

		const deadline =
			Date.now() + config.FIRECRAWL_TIMEOUT_MS;
		const pagesByUrl = new Map<string, ScrapedPage>();

		while (Date.now() < deadline) {
			const status = await this.client.getCrawlStatus(
				start.id,
			);
			await onProgress?.(
				status.completed ?? pagesByUrl.size,
				status.total ?? maxPages,
			);

			for (const document of status.data ?? []) {
				const page = this.documentToScrapedPage(
					document,
					url,
				);
				if (!page) {
					continue;
				}
				pagesByUrl.set(page.url, page);
			}

			if (status.status === "completed") {
				const pages = Array.from(
					pagesByUrl.values(),
				).slice(0, maxPages);
				logger.info("[Firecrawl] Site crawl completed", {
					url,
					pages: pages.length,
				});
				return pages;
			}

			if (
				status.status === "failed" ||
				status.status === "cancelled"
			) {
				throw new Error(
					`Firecrawl crawl ended with status ${status.status}`,
				);
			}

			await new Promise((resolve) =>
				setTimeout(
					resolve,
					config.FIRECRAWL_POLL_INTERVAL_MS,
				),
			);
		}

		throw new Error(
			`Firecrawl crawl timed out after ${config.FIRECRAWL_TIMEOUT_MS} ms`,
		);
	}
}

export const firecrawlService = new FirecrawlService();
