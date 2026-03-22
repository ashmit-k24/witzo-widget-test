import { assertSafeOutgoingUrl } from "./networkSafety";

const TRACKING_PARAMS = new Set([
	"fbclid",
	"gclid",
	"msclkid",
	"ref",
	"source",
	"utm_campaign",
	"utm_content",
	"utm_medium",
	"utm_source",
	"utm_term",
]);

const SKIPPED_EXTENSIONS =
	/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4|mp3|css|js|woff2?|ico|xml)(\?|$)/i;

const SKIPPED_PATH_SEGMENTS =
	/\/(wp-admin|wp-login|admin|login|logout|signin|signout|cart|checkout)(\/|$)/i;

function removeTrackingParams(url: URL): void {
	for (const key of [...url.searchParams.keys()]) {
		if (TRACKING_PARAMS.has(key.toLowerCase())) {
			url.searchParams.delete(key);
		}
	}
}

function normalizeParsedUrl(url: URL): URL {
	url.hash = "";
	url.username = "";
	url.password = "";
	url.hostname = url.hostname.toLowerCase();
	removeTrackingParams(url);

	if (!url.pathname) {
		url.pathname = "/";
	}

	if (url.pathname !== "/") {
		url.pathname = url.pathname.replace(/\/+$/, "");
	}

	return url;
}

export async function normalizeScrapeUrl(
	raw: string,
): Promise<string> {
	const trimmed = raw.trim();
	const withProtocol = /^https?:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed.replace(/^\/\//, "")}`;
	const safeUrl = await assertSafeOutgoingUrl(
		withProtocol,
		{ allowHttp: true },
	);
	return normalizeParsedUrl(safeUrl).toString();
}

export function normalizeDiscoveredUrl(
	raw: string,
	baseUrl?: string,
): string | null {
	try {
		const parsed = baseUrl
			? new URL(raw, baseUrl)
			: new URL(raw);
		if (
			parsed.protocol !== "http:" &&
			parsed.protocol !== "https:"
		) {
			return null;
		}
		return normalizeParsedUrl(parsed).toString();
	} catch {
		return null;
	}
}

export function isUrlUnderSourceRoot(
	candidateUrl: string,
	sourceRoot: string,
): boolean {
	try {
		const candidate = new URL(candidateUrl);
		const root = new URL(sourceRoot);

		if (
			candidate.protocol !== root.protocol ||
			candidate.hostname !== root.hostname ||
			candidate.port !== root.port
		) {
			return false;
		}

		const rootPath =
			root.pathname === "/"
				? "/"
				: root.pathname.replace(/\/+$/, "");
		const candidatePath =
			candidate.pathname === "/"
				? "/"
				: candidate.pathname.replace(/\/+$/, "");

		if (rootPath === "/") {
			return true;
		}

		return (
			candidatePath === rootPath ||
			candidatePath.startsWith(`${rootPath}/`)
		);
	} catch {
		return false;
	}
}

export function shouldSkipScrapeUrl(url: string): boolean {
	const lowerUrl = url.toLowerCase();
	return (
		SKIPPED_EXTENSIONS.test(lowerUrl) ||
		SKIPPED_PATH_SEGMENTS.test(lowerUrl)
	);
}
