import Firecrawl from "@mendable/firecrawl-js";
import {
	ScrapedPage,
	ScrapedPageBlockType,
	ScrapedPageContentBlock,
} from "../types";
import logger from "../utils/logger";
import { config } from "../config/env";

// Minimum markdown length to consider a Firecrawl response useful.
// If below this, we fall back to the own scraper.
const FIRECRAWL_MIN_CONTENT_LENGTH = 100;

class FirecrawlService {
	private readonly client: Firecrawl | null = null;

	constructor() {
		if (config.FIRECRAWL_API_KEY) {
			this.client = new Firecrawl({
				apiKey: config.FIRECRAWL_API_KEY,
			});
			logger.info("[Firecrawl] Service initialized");
		} else {
			logger.info(
				"[Firecrawl] FIRECRAWL_API_KEY not set — Firecrawl disabled, using own scraper only",
			);
		}
	}

	get isAvailable(): boolean {
		return this.client !== null;
	}

	// ── Helpers ────────────────────────────────────────────────────────────

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
		)
			return "table";
		if (
			/\?$/.test(text.trim()) ||
			/\b(faq|frequently asked|question|answer)\b/.test(
				normalized,
			)
		)
			return "faq";
		if (this.hasContactSignals(normalized)) return "contact";
		return "paragraph";
	}

	/**
	 * Convert Firecrawl markdown output into structured content blocks
	 * compatible with the existing ScrapedPageContentBlock format.
	 */
	private markdownToContentBlocks(
		markdown: string,
		title: string,
		description: string,
	): ScrapedPageContentBlock[] {
		const blocks: ScrapedPageContentBlock[] = [];
		const seenText = new Set<string>();

		// Summary block (title + meta description)
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

		// Split on blank lines to get raw blocks
		const rawBlocks = markdown
			.split(/\n\s*\n/)
			.map((b) => b.trim())
			.filter(Boolean);

		for (const rawBlock of rawBlocks) {
			const lines = rawBlock
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
			if (lines.length === 0) continue;

			// Standalone heading → update section stack, don't store as a block
			const headingMatch = lines[0].match(/^(#{1,6})\s+(.+)/);
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
				sectionStack.push({ level, title: headingText });
				continue;
			}

			// Strip any inline heading lines from mixed blocks
			const contentLines = lines.filter(
				(l) => !/^#{1,6}\s+/.test(l),
			);
			if (contentLines.length === 0) continue;

			const isList = contentLines.every(
				(l) =>
					/^[-*+]\s+/.test(l) || /^\d+\.\s+/.test(l),
			);

			const text = isList
				? contentLines
						.map((l) =>
							l.replace(/^[-*+\d.]+\s+/, "").trim(),
						)
						.filter(Boolean)
						.join(" | ")
				: contentLines.join(" ").replace(/\s+/g, " ").trim();

			if (!text || text.length < 30) continue;

			const key = text.toLowerCase();
			if (seenText.has(key)) continue;
			seenText.add(key);

			const sectionPath = sectionStack.map((s) => s.title);
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

	// ── Public API ──────────────────────────────────────────────────────────

	/**
	 * Use Firecrawl's /map endpoint to discover all URLs on a website
	 * via sitemap + link crawling — captures pages that are not reachable
	 * through normal HTML link following (JS-loaded content, pagination, etc.).
	 * Returns an empty array if Firecrawl is not configured or the call fails.
	 */
	async mapWebsite(url: string): Promise<string[]> {
		if (!this.client) {
			return [];
		}

		try {
			logger.info(`[Firecrawl] Mapping all URLs for ${url}`);

			const result = await this.client.map(url, {
				sitemap: "include", // use sitemap.xml when available
				ignoreQueryParameters: true, // dedupe ?page=1 vs ?page=2 variants
				limit: 5000,
				timeout: 60000,
			});

			const urls = (result.links ?? [])
				.map((l) => l.url)
				.filter((u) => /^https?:\/\//i.test(u));

			logger.info(
				`[Firecrawl] Map discovered ${urls.length} URLs for ${url}`,
			);
			return urls;
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: String(error);
			logger.warn(
				`[Firecrawl] Map failed for ${url}: ${message} — falling back to BFS link discovery`,
			);
			return [];
		}
	}

	/**
	 * Scrape a single page via Firecrawl.
	 * Returns null if:
	 *   - Firecrawl is not configured (no API key)
	 *   - The API call fails for any reason
	 *   - The returned content is too short to be useful
	 * Caller should fall back to the own scraper when null is returned.
	 */
	async scrapePage(url: string): Promise<ScrapedPage | null> {
		if (!this.client) {
			return null;
		}

		try {
			logger.info(`[Firecrawl] Scraping ${url}`);

			const result = await this.client.scrape(url, {
				formats: ["markdown", "links"],
				onlyMainContent: true,
				timeout: 30000,
			});

			const markdown = result.markdown ?? "";

			if (markdown.length < FIRECRAWL_MIN_CONTENT_LENGTH) {
				logger.warn(
					`[Firecrawl] Insufficient content for ${url} (${markdown.length} chars) — falling back`,
				);
				return null;
			}

			const title =
				result.metadata?.title?.trim() || "No Title";
			const description =
				result.metadata?.description?.trim() || "";
			const canonicalUrl =
				result.metadata?.ogUrl?.trim() ||
				result.metadata?.sourceURL?.trim() ||
				undefined;

			// Filter to absolute HTTP links only
			const links = (result.links ?? []).filter((l) =>
				/^https?:\/\//i.test(l),
			);

			const contentBlocks = this.markdownToContentBlocks(
				markdown,
				title,
				description,
			);

			const metadata: Record<string, unknown> = {};
			if (description) metadata.description = description;
			if (canonicalUrl) metadata.canonicalUrl = canonicalUrl;
			if (contentBlocks.length > 0)
				metadata.contentBlocks = contentBlocks;
			metadata.scrapedVia = "firecrawl";

			logger.info(
				`[Firecrawl] OK ${url} — ${markdown.length} chars, ${contentBlocks.length} blocks`,
			);

			return {
				url,
				title,
				content: markdown,
				links,
				metadata,
			};
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: String(error);
			logger.warn(
				`[Firecrawl] Failed for ${url}: ${message} — falling back to own scraper`,
			);
			return null;
		}
	}
}

export const firecrawlService = new FirecrawlService();
