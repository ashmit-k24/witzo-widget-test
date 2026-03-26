import axios from "axios";
import { assertSafeOutgoingUrl } from "../utils/networkSafety";
import logger from "../utils/logger";

type FaviconCandidate = {
	url: string;
	score: number;
};

const FAVICON_REQUEST_TIMEOUT_MS = 10000;
const MAX_ICON_DOWNLOAD_BYTES = 1024 * 1024;

const normalizeUrlInput = (value: string): string => {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error("Website URL is required");
	}

	return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const decodeHtmlAttribute = (value: string): string =>
	value
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">");

const extractAttribute = (tag: string, attribute: string): string | null => {
	const pattern = new RegExp(`${attribute}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
	const match = tag.match(pattern);
	const rawValue = match?.[2] ?? match?.[3] ?? match?.[4];
	return rawValue ? decodeHtmlAttribute(rawValue.trim()) : null;
};

const getCandidateScore = (rel: string, href: string): number => {
	const normalizedRel = rel.toLowerCase();
	const normalizedHref = href.toLowerCase();

	let score = 10;
	if (normalizedRel.includes("apple-touch-icon")) score += 40;
	if (normalizedRel.includes("shortcut icon")) score += 35;
	if (normalizedRel.includes("icon")) score += 30;
	if (normalizedRel.includes("mask-icon")) score -= 10;

	if (normalizedHref.endsWith(".svg")) score += 20;
	else if (normalizedHref.endsWith(".png")) score += 18;
	else if (normalizedHref.endsWith(".webp")) score += 16;
	else if (normalizedHref.endsWith(".ico")) score += 12;
	else if (normalizedHref.endsWith(".jpg") || normalizedHref.endsWith(".jpeg")) score += 8;

	return score;
};

const buildIconCandidatesFromHtml = (html: string, pageUrl: URL): FaviconCandidate[] => {
	const matches = html.match(/<link\b[^>]*>/gi) || [];
	const candidates: FaviconCandidate[] = [];

	for (const tag of matches) {
		const rel = extractAttribute(tag, "rel");
		const href = extractAttribute(tag, "href");
		if (!rel || !href) {
			continue;
		}

		const normalizedRel = rel.toLowerCase();
		if (!normalizedRel.includes("icon")) {
			continue;
		}

		try {
			const resolvedUrl = new URL(href, pageUrl).toString();
			candidates.push({
				url: resolvedUrl,
				score: getCandidateScore(rel, href),
			});
		} catch {
			continue;
		}
	}

	return candidates;
};

const dedupeCandidates = (candidates: FaviconCandidate[]): FaviconCandidate[] => {
	const bestByUrl = new Map<string, FaviconCandidate>();

	for (const candidate of candidates) {
		const existing = bestByUrl.get(candidate.url);
		if (!existing || candidate.score > existing.score) {
			bestByUrl.set(candidate.url, candidate);
		}
	}

	return [...bestByUrl.values()].sort((left, right) => right.score - left.score);
};

const isLikelyImageResponse = (contentType?: string, url?: string): boolean => {
	const normalizedType = (contentType || "").toLowerCase();
	if (normalizedType.startsWith("image/")) {
		return true;
	}

	const normalizedUrl = (url || "").toLowerCase();
	return [".ico", ".png", ".svg", ".webp", ".jpg", ".jpeg"].some((extension) => normalizedUrl.includes(extension));
};

const probeIconUrl = async (candidateUrl: string): Promise<boolean> => {
	try {
		const safeUrl = await assertSafeOutgoingUrl(candidateUrl, { allowHttp: true });
		const response = await axios.get<ArrayBuffer>(safeUrl.toString(), {
			responseType: "arraybuffer",
			timeout: FAVICON_REQUEST_TIMEOUT_MS,
			maxRedirects: 5,
			maxContentLength: MAX_ICON_DOWNLOAD_BYTES,
			validateStatus: (status) => status >= 200 && status < 400,
		});

		return isLikelyImageResponse(response.headers["content-type"], safeUrl.toString());
	} catch {
		return false;
	}
};

class FaviconService {
	async resolveFavicon(rawUrl: string): Promise<{ websiteUrl: string; iconUrl: string | null }> {
		const normalizedInput = normalizeUrlInput(rawUrl);
		const safePageUrl = await assertSafeOutgoingUrl(normalizedInput, { allowHttp: true });

		const fallbackCandidate = new URL("/favicon.ico", safePageUrl).toString();
		const candidates: FaviconCandidate[] = [{ url: fallbackCandidate, score: 5 }];

		try {
			const response = await axios.get<string>(safePageUrl.toString(), {
				responseType: "text",
				timeout: FAVICON_REQUEST_TIMEOUT_MS,
				maxRedirects: 5,
				validateStatus: (status) => status >= 200 && status < 400,
				headers: {
					"User-Agent": "WitzoBot/1.0 (+https://witzo.ai)",
					Accept: "text/html,application/xhtml+xml",
				},
			});
			const finalPageUrl = await assertSafeOutgoingUrl(response.request?.res?.responseUrl || safePageUrl.toString(), {
				allowHttp: true,
			});
			candidates.push(...buildIconCandidatesFromHtml(String(response.data || ""), finalPageUrl));
			candidates.unshift({
				url: new URL("/favicon.ico", finalPageUrl).toString(),
				score: 6,
			});
		} catch (error) {
			logger.warn("faviconService: failed to fetch page HTML, falling back to default favicon location", {
				url: safePageUrl.toString(),
				error: error instanceof Error ? error.message : String(error),
			});
		}

		for (const candidate of dedupeCandidates(candidates)) {
			if (await probeIconUrl(candidate.url)) {
				return {
					websiteUrl: safePageUrl.toString(),
					iconUrl: candidate.url,
				};
			}
		}

		return {
			websiteUrl: safePageUrl.toString(),
			iconUrl: null,
		};
	}
}

export const faviconService = new FaviconService();
