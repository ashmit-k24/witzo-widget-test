import pool from "../config/database";
import logger from "../utils/logger";

type WebsiteSourceRow = {
	source_root: string | null;
	source_url: string;
};

type UserBrandRow = {
	company_name: string | null;
	company_website: string | null;
};

class WebsiteBrandingService {
	private extractRootLabel(
		url?: string | null,
	): string | null {
		if (!url) return null;
		const raw = url.trim();
		if (!raw) return null;

		try {
			const withProtocol = /^https?:\/\//i.test(raw)
				? raw
				: `https://${raw}`;
			const hostname = new URL(withProtocol).hostname
				.toLowerCase()
				.replace(/^www\./, "");
			if (!hostname) return null;

			const parts = hostname
				.split(".")
				.filter(Boolean);
			if (parts.length === 0) return null;

			const secondLevelSuffixes = new Set([
				"co",
				"com",
				"org",
				"net",
				"gov",
				"edu",
				"ac",
			]);

			let root = parts[0];
			if (parts.length >= 2) {
				root = parts[parts.length - 2];
			}
			if (
				parts.length >= 3 &&
				secondLevelSuffixes.has(parts[parts.length - 2])
			) {
				root = parts[parts.length - 3];
			}

			return root.trim().toLowerCase() || null;
		} catch {
			return null;
		}
	}

	private toDisplayBrandName(raw: string): string {
		const normalized = raw
			.replace(/[-_]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (!normalized) return "";
		return normalized
			.split(" ")
			.map((part) =>
				part.length > 1
					? part.charAt(0).toUpperCase() +
					  part.slice(1)
					: part.toUpperCase(),
			)
			.join(" ");
	}

	extractBrandFromUrl(url?: string | null): string | null {
		const root = this.extractRootLabel(url);
		if (!root) return null;
		const display = this.toDisplayBrandName(root);
		return display || null;
	}

	extractWidgetLabelFromUrl(
		url?: string | null,
	): string | null {
		return this.extractRootLabel(url);
	}

	private async resolveFromSources(
		userId: string,
	): Promise<string | null> {
		const result = await pool.query<WebsiteSourceRow>(
			`SELECT source_root, source_url
       FROM rag_source_pages
       WHERE user_id = $1
         AND source_type = 'website'
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 10`,
			[userId],
		);

		for (const row of result.rows) {
			const fromRoot = this.extractBrandFromUrl(
				row.source_root,
			);
			if (fromRoot) {
				return fromRoot;
			}

			const fromUrl = this.extractBrandFromUrl(
				row.source_url,
			);
			if (fromUrl) {
				return fromUrl;
			}
		}

		return null;
	}

	private async resolveFromUser(
		userId: string,
	): Promise<string | null> {
		const result = await pool.query<UserBrandRow>(
			`SELECT company_name, company_website
       FROM users
       WHERE id = $1
       LIMIT 1`,
			[userId],
		);
		const row = result.rows[0];
		const companyName = (row?.company_name || "").trim();
		if (companyName) {
			return this.toDisplayBrandName(companyName);
		}

		return this.extractBrandFromUrl(
			row?.company_website,
		);
	}

	async resolveUserWebsiteName(
		userId: string,
	): Promise<string> {
		try {
			const fromSources =
				await this.resolveFromSources(userId);
			if (fromSources) {
				return fromSources;
			}

			const fromUser = await this.resolveFromUser(
				userId,
			);
			if (fromUser) {
				return fromUser;
			}
		} catch (error) {
			logger.warn(
				"Unable to resolve website branding name",
				{
					error,
					userId,
				},
			);
		}

		return "This business";
	}

	async resolveUserWidgetLabel(
		userId: string,
	): Promise<string> {
		try {
			const fromSources =
				await this.resolveFromSources(userId);
			if (fromSources) {
				return fromSources
					.replace(/\s+/g, "")
					.toLowerCase();
			}

			const userResult = await pool.query<UserBrandRow>(
				`SELECT company_website
				 FROM users
				 WHERE id = $1
				 LIMIT 1`,
				[userId],
			);
			const fromWebsite =
				this.extractWidgetLabelFromUrl(
					userResult.rows[0]?.company_website,
				);
			if (fromWebsite) {
				return fromWebsite;
			}
		} catch (error) {
			logger.warn(
				"Unable to resolve widget label",
				{
					error,
					userId,
				},
			);
		}

		return "this-business";
	}
}

export default new WebsiteBrandingService();
