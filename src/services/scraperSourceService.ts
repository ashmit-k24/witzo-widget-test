import crypto from "crypto";
import pool from "../config/database";
import { ScrapedPage } from "../types";

type WebsiteSource = {
	rootUrl: string;
	title: string;
	totalChunks: number;
	scrapedAt: string;
	scrapedPages: number;
	indexedPages: number;
	pages: Array<{
		url: string;
		title: string;
		chunks: number;
		scrapedAt: string;
		indexed: boolean;
	}>;
};

class ScraperSourceService {
	computeContentHash(rawContent: string): string {
		return crypto
			.createHash("sha256")
			.update(rawContent)
			.digest("hex");
	}

	buildRawContent(pages: ScrapedPage[]): string {
		return pages
			.map((page) => page.content.trim())
			.filter(Boolean)
			.join("\n\n---\n\n");
	}

	async getContentHash(
		userId: string,
		sourceUrl: string,
	): Promise<string> {
		const result = await pool.query<{
			content_hash: string | null;
		}>(
			`SELECT content_hash
			 FROM scraper_sources
			 WHERE user_id = $1 AND source_url = $2`,
			[userId, sourceUrl],
		);
		return result.rows[0]?.content_hash ?? "";
	}

	async persistSource(
		userId: string,
		sourceUrl: string,
		sourceTitle: string,
		pages: ScrapedPage[],
		rawContent: string,
		contentHash: string,
	): Promise<void> {
		const title =
			sourceTitle ||
			pages.find((page) => page.title.trim())?.title ||
			sourceUrl;

		await pool.query(
			`INSERT INTO scraper_sources
				(user_id, source_url, source_title, scraped_pages, content_hash, raw_content)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (user_id, source_url)
			 DO UPDATE SET
				source_title = EXCLUDED.source_title,
				scraped_pages = EXCLUDED.scraped_pages,
				content_hash = EXCLUDED.content_hash,
				raw_content = EXCLUDED.raw_content,
				metadata_ready = FALSE,
				metadata_ready_at = NULL,
				pending_delete = FALSE,
				updated_at = CURRENT_TIMESTAMP`,
			[
				userId,
				sourceUrl,
				title,
				pages.length,
				contentHash,
				rawContent,
			],
		);

		await pool.query(
			`DELETE FROM scraped_pages
			 WHERE user_id = $1 AND source_url = $2`,
			[userId, sourceUrl],
		);

		for (const page of pages) {
			await pool.query(
				`INSERT INTO scraped_pages
					(user_id, source_url, page_url, page_title)
				 VALUES ($1, $2, $3, $4)
				 ON CONFLICT (user_id, page_url)
				 DO UPDATE SET
					source_url = EXCLUDED.source_url,
					page_title = EXCLUDED.page_title,
					updated_at = CURRENT_TIMESTAMP`,
				[
					userId,
					sourceUrl,
					page.url,
					page.title || page.url,
				],
			);
		}
	}

	async setMetadataReady(
		userId: string,
		sourceUrl: string,
		ready: boolean,
	): Promise<void> {
		await pool.query(
			`UPDATE scraper_sources
			 SET metadata_ready = $3,
				 metadata_ready_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END,
				 updated_at = CURRENT_TIMESTAMP
			 WHERE user_id = $1 AND source_url = $2`,
			[userId, sourceUrl, ready],
		);
	}

	async isMetadataReady(userId: string): Promise<boolean> {
		const result = await pool.query<{
			ready: boolean;
		}>(
			`SELECT COALESCE(bool_and(metadata_ready), FALSE) AS ready
			 FROM scraper_sources
			 WHERE user_id = $1`,
			[userId],
		);
		return result.rows[0]?.ready ?? false;
	}

	async deleteSource(
		userId: string,
		sourceUrl: string,
	): Promise<void> {
		const normalizedRoot = sourceUrl.replace(/\/+$/, "");
		const normalizedRootWithSlash = `${normalizedRoot}/`;

		await pool.query(
			`DELETE FROM scraped_pages
			 WHERE user_id = $1
			   AND (
					source_url = $2
					OR source_url = $3
					OR source_url LIKE $4
					OR page_url = $2
					OR page_url = $3
					OR page_url LIKE $4
			   )`,
			[
				userId,
				normalizedRoot,
				normalizedRootWithSlash,
				`${normalizedRootWithSlash}%`,
			],
		);
		await pool.query(
			`DELETE FROM scraper_sources
			 WHERE user_id = $1
			   AND (
					source_url = $2
					OR source_url = $3
					OR source_url LIKE $4
			   )`,
			[
				userId,
				normalizedRoot,
				normalizedRootWithSlash,
				`${normalizedRootWithSlash}%`,
			],
		);
	}

	async deletePage(
		userId: string,
		pageUrl: string,
	): Promise<void> {
		await pool.query(
			`DELETE FROM scraped_pages
			 WHERE user_id = $1 AND page_url = $2`,
			[userId, pageUrl],
		);
		await pool.query(
			`UPDATE scraper_sources source
			 SET scraped_pages = (
				 SELECT COUNT(*)::int
				 FROM scraped_pages page
				 WHERE page.user_id = source.user_id
				   AND page.source_url = source.source_url
			 ),
			 updated_at = CURRENT_TIMESTAMP
			 WHERE source.user_id = $1`,
			[userId],
		);
	}

	async deleteAll(userId: string): Promise<void> {
		await pool.query(
			`DELETE FROM scraped_pages WHERE user_id = $1`,
			[userId],
		);
		await pool.query(
			`DELETE FROM scraper_sources WHERE user_id = $1`,
			[userId],
		);
	}

	async getWebsiteSources(
		userId: string,
	): Promise<WebsiteSource[]> {
		const result = await pool.query<{
			source_url: string;
			source_title: string | null;
			scraped_pages: number;
			source_updated_at: Date;
			page_url: string | null;
			page_title: string | null;
			page_created_at: Date | null;
			chunks: number | null;
			vector_scraped_at: Date | null;
		}>(
			`SELECT
				source.source_url,
				source.source_title,
				source.scraped_pages,
				source.updated_at AS source_updated_at,
				page.page_url,
				page.page_title,
				page.created_at AS page_created_at,
				COALESCE(rag.chunks, 0) AS chunks,
				rag.scraped_at AS vector_scraped_at
			 FROM scraper_sources source
			 LEFT JOIN scraped_pages page
			   ON page.user_id = source.user_id
			  AND page.source_url = source.source_url
			 LEFT JOIN rag_source_pages rag
			   ON rag.user_id = source.user_id
			  AND rag.source_type = 'website'
			  AND rag.source_url = page.page_url
			 WHERE source.user_id = $1
			   AND source.pending_delete = FALSE
			 ORDER BY source.updated_at DESC, page.created_at ASC`,
			[userId],
		);

		const websites = new Map<string, WebsiteSource>();

		for (const row of result.rows) {
			const sourceUpdatedAt =
				row.source_updated_at instanceof Date
					? row.source_updated_at.toISOString()
					: new Date().toISOString();
			const website =
				websites.get(row.source_url) ?? {
					rootUrl: row.source_url,
					title: row.source_title || row.source_url,
					totalChunks: 0,
					scrapedAt: sourceUpdatedAt,
					scrapedPages: Math.max(
						0,
						Number(row.scraped_pages) || 0,
					),
					indexedPages: 0,
					pages: [],
				};

			if (row.page_url) {
				const chunks = Math.max(
					0,
					Number(row.chunks) || 0,
				);
				const scrapedAt =
					row.vector_scraped_at instanceof Date
						? row.vector_scraped_at.toISOString()
						: row.page_created_at instanceof Date
							? row.page_created_at.toISOString()
							: sourceUpdatedAt;
				website.pages.push({
					url: row.page_url,
					title: row.page_title || row.page_url,
					chunks,
					scrapedAt,
					indexed: chunks > 0,
				});
				website.totalChunks += chunks;
				if (chunks > 0) {
					website.indexedPages += 1;
				}
			}

			websites.set(row.source_url, website);
		}

		return Array.from(websites.values());
	}

	async markPendingDelete(
		userId: string,
		sourceUrl: string,
	): Promise<void> {
		const normalized = sourceUrl.replace(/\/+$/, "");
		const normalizedWithSlash = `${normalized}/`;
		await pool.query(
			`UPDATE scraper_sources
			 SET pending_delete = TRUE, updated_at = CURRENT_TIMESTAMP
			 WHERE user_id = $1
			   AND (source_url = $2 OR source_url = $3 OR source_url LIKE $4)`,
			[userId, normalized, normalizedWithSlash, `${normalizedWithSlash}%`],
		);
	}

	async isPendingDelete(
		userId: string,
		sourceUrl: string,
	): Promise<boolean> {
		const normalized = sourceUrl.replace(/\/+$/, "");
		const normalizedWithSlash = `${normalized}/`;
		const result = await pool.query<{
			pending: boolean;
		}>(
			`SELECT COALESCE(bool_or(pending_delete), FALSE) AS pending
			 FROM scraper_sources
			 WHERE user_id = $1
			   AND (source_url = $2 OR source_url = $3 OR source_url LIKE $4)`,
			[userId, normalized, normalizedWithSlash, `${normalizedWithSlash}%`],
		);
		return result.rows[0]?.pending ?? false;
	}

	async clearPendingDelete(
		userId: string,
		sourceUrl: string,
	): Promise<void> {
		const normalized = sourceUrl.replace(/\/+$/, "");
		const normalizedWithSlash = `${normalized}/`;
		await pool.query(
			`UPDATE scraper_sources
			 SET pending_delete = FALSE, updated_at = CURRENT_TIMESTAMP
			 WHERE user_id = $1
			   AND (source_url = $2 OR source_url = $3 OR source_url LIKE $4)`,
			[userId, normalized, normalizedWithSlash, `${normalizedWithSlash}%`],
		);
	}

	async getPendingDeleteRoots(
		userId: string,
	): Promise<Set<string>> {
		const result = await pool.query<{
			source_url: string;
		}>(
			`SELECT source_url FROM scraper_sources
			 WHERE user_id = $1 AND pending_delete = TRUE`,
			[userId],
		);
		const roots = new Set<string>();
		for (const row of result.rows) {
			const normalized = row.source_url.replace(/\/+$/, "");
			roots.add(normalized);
			roots.add(`${normalized}/`);
		}
		return roots;
	}

	async sourceExists(
		userId: string,
		sourceUrl: string,
	): Promise<boolean> {
		const normalized = sourceUrl.replace(/\/+$/, "");
		const normalizedWithSlash = `${normalized}/`;
		const result = await pool.query<{ exists: boolean }>(
			`SELECT EXISTS(
				SELECT 1 FROM scraper_sources
				WHERE user_id = $1
				  AND (source_url = $2 OR source_url = $3)
			) AS exists`,
			[userId, normalized, normalizedWithSlash],
		);
		return result.rows[0]?.exists ?? false;
	}

	async getScrapedPageCount(userId: string): Promise<number> {
		const result = await pool.query<{
			total: string;
		}>(
			`SELECT COALESCE(SUM(scraped_pages), 0)::text AS total
			 FROM scraper_sources
			 WHERE user_id = $1`,
			[userId],
		);
		return Number(result.rows[0]?.total ?? 0);
	}
}

export const scraperSourceService =
	new ScraperSourceService();
