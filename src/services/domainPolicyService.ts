import pool from "../config/database";

const CACHE_TTL_MS = 60_000;

type DomainCache = {
	domains: string[];
	expiresAt: number;
};

let domainCache: DomainCache | null = null;

const normalizeDomain = (value: string): string | null => {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return null;

	const isWildcard = trimmed.startsWith("*.");
	const candidate = isWildcard ? trimmed.slice(2) : trimmed;
	const withProtocol = /^https?:\/\//i.test(candidate)
		? candidate
		: `https://${candidate}`;

	try {
		const hostname = new URL(withProtocol).hostname
			.toLowerCase()
			.replace(/^www\./, "")
			.replace(/\.$/, "");
		if (!hostname) return null;
		return isWildcard ? `*.${hostname}` : hostname;
	} catch {
		return null;
	}
};

const normalizeHostnameFromUrl = (value: string): string | null => {
	const withProtocol = /^https?:\/\//i.test(value)
		? value
		: `https://${value}`;
	try {
		return new URL(withProtocol).hostname
			.toLowerCase()
			.replace(/^www\./, "")
			.replace(/\.$/, "");
	} catch {
		return null;
	}
};

const matchDomain = (hostname: string, rule: string): boolean => {
	const normalizedRule = rule.startsWith("*.")
		? rule.slice(2)
		: rule;
	return (
		hostname === normalizedRule ||
		hostname.endsWith(`.${normalizedRule}`)
	);
};

export const domainPolicyService = {
	normalizeDomain,
	async getDisallowedDomains(): Promise<string[]> {
		const now = Date.now();
		if (domainCache && domainCache.expiresAt > now) {
			return domainCache.domains;
		}

		const result = await pool.query<{ domain: string }>(
			`SELECT domain FROM disallowed_domains ORDER BY domain ASC`,
		);
		const domains = result.rows
			.map((row) => row.domain)
			.filter(Boolean);

		domainCache = {
			domains,
			expiresAt: now + CACHE_TTL_MS,
		};

		return domains;
	},
	async isDomainDisallowed(rawUrl: string): Promise<{
		blocked: boolean;
		matchedDomain?: string;
	}> {
		const hostname = normalizeHostnameFromUrl(rawUrl);
		if (!hostname) {
			return { blocked: false };
		}

		const disallowedDomains =
			await this.getDisallowedDomains();
		for (const rule of disallowedDomains) {
			if (matchDomain(hostname, rule)) {
				return { blocked: true, matchedDomain: rule };
			}
		}
		return { blocked: false };
	},
	invalidateCache(): void {
		domainCache = null;
	},
};
