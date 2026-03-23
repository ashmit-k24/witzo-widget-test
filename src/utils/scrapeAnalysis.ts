import {
	ScrapedPage,
	ScrapedPageContentBlock,
	ScrapedPageType,
	ScrapedStructuredFact,
	ScrapedStructuredFactType,
} from "../types";

const ADDRESS_KEYWORDS =
	/\b(address|street|st\.|road|rd\.|avenue|ave\.|lane|ln\.|floor|building|tower|suite|unit|block|city|state|country|postcode|postal|zip|pincode|pin code)\b/i;
const EMAIL_REGEX =
	/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_REGEX =
	/(?:\+?\d[\d\s().-]{6,}\d)/g;
const SERVICE_HINTS =
	/\b(service|services|solution|solutions|product|products|offering|offerings|capabilities)\b/i;
const CASE_STUDY_HINTS =
	/\b(case stud(?:y|ies)|portfolio|project|projects|client|clients|success stor(?:y|ies)|work)\b/i;
const PRICING_HINTS =
	/\b(price|pricing|plan|plans|package|packages|cost|quote|subscription)\b/i;
const CONTACT_HINTS =
	/\b(contact|address|phone|email|office|location|branch|get in touch|reach us|head office|registered office|headquarters)\b/i;
const FAQ_HINTS =
	/\b(faq|faqs|frequently asked|question|questions|answer|answers|help|support)\b/i;
const LEGAL_HINTS =
	/\b(privacy|terms|policy|policies|refund|shipping|cookies|gdpr)\b/i;
const BLOG_HINTS =
	/\b(blog|article|articles|news|insight|insights|resource|resources|guide|guides)\b/i;

export function normalizeScrapedText(
	text: string,
): string {
	return text
		.replace(/\u00a0/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function hasContactSignals(
	text: string,
): boolean {
	return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d\s().-]{6,}|\b(address|phone|email|office|contact|call|reach us|get in touch|pin code|pincode|zip code|zip|postal code|floor|building|suite|unit|branch office|regional office|corporate office|head office|registered office)\b/i.test(
		text,
	);
}

export function detectScrapedPageType(
	url: string,
	title: string,
	description: string = "",
	content: string = "",
	blocks: ScrapedPageContentBlock[] = [],
): ScrapedPageType {
	let pathname = "";
	try {
		pathname = new URL(url).pathname.toLowerCase();
	} catch {
		pathname = "";
	}

	const signals = [
		url,
		title,
		description,
		content.slice(0, 1200),
		blocks
			.slice(0, 8)
			.map((block) => block.sectionTitle || block.text)
			.join(" "),
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();

	if ((pathname === "/" || pathname === "") && !signals.replace(url.toLowerCase(), "").trim()) {
		return "home";
	}
	if (pathname === "/" || pathname === "") return "home";
	if (CONTACT_HINTS.test(signals)) return "contact";
	if (PRICING_HINTS.test(signals)) return "pricing";
	if (CASE_STUDY_HINTS.test(signals)) return "portfolio";
	if (FAQ_HINTS.test(signals)) return "faq";
	if (SERVICE_HINTS.test(signals)) return "services";
	if (LEGAL_HINTS.test(signals)) return "legal";
	if (BLOG_HINTS.test(signals)) return "blog";
	if (/\b(about|company|who we are|our story|team|mission|vision|founder)\b/i.test(signals)) {
		return "about";
	}

	if (/\/(contact|reach|get-in-touch|location|office|map)/.test(pathname)) return "contact";
	if (/\/(service|solution|product|offering|what-we-do)/.test(pathname)) return "services";
	if (/\/(price|pricing|plan|cost|rate|package)/.test(pathname)) return "pricing";
	if (/\/(about|team|history|who-we-are|company|our-story|founder)/.test(pathname)) return "about";
	if (/\/(faq|help|support|question|answer|kb|knowledge)/.test(pathname)) return "faq";
	if (/\/(blog|article|news|post|insight|update|resource)/.test(pathname)) return "blog";
	if (/\/(portfolio|case-stud|work|project|client)/.test(pathname)) return "portfolio";
	if (/\/(privacy|terms|policy|refund|shipping|cookie)/.test(pathname)) return "legal";

	return "general";
}

export function scorePagePriority(
	pageType: ScrapedPageType,
	url: string,
): number {
	const baseScores: Record<ScrapedPageType, number> = {
		home: 120,
		contact: 115,
		pricing: 110,
		services: 105,
		portfolio: 100,
		about: 92,
		faq: 88,
		general: 70,
		blog: 35,
		legal: 20,
	};

	let score = baseScores[pageType] ?? 50;
	const normalizedUrl = url.toLowerCase();
	if (normalizedUrl.includes("/contact")) score += 8;
	if (normalizedUrl.includes("/pricing")) score += 6;
	if (normalizedUrl.includes("/services")) score += 5;
	if (normalizedUrl.includes("/case") || normalizedUrl.includes("/portfolio")) score += 5;
	return score;
}

function pushFact(
	facts: ScrapedStructuredFact[],
	seen: Set<string>,
	type: ScrapedStructuredFactType,
	value: string,
	label?: string,
	sourceText?: string,
): void {
	const normalizedValue = normalizeScrapedText(value);
	if (!normalizedValue) return;
	const key = `${type}:${normalizedValue.toLowerCase()}`;
	if (seen.has(key)) return;
	seen.add(key);
	facts.push({
		type,
		value: normalizedValue,
		label,
		sourceText,
	});
}

export function extractStructuredFacts(
	page: Pick<ScrapedPage, "url" | "title" | "content" | "metadata">,
): ScrapedStructuredFact[] {
	const facts: ScrapedStructuredFact[] = [];
	const seen = new Set<string>();
	const pageType =
		(page.metadata?.pageType as ScrapedPageType | undefined) ??
		detectScrapedPageType(
			page.url,
			page.title,
			String(page.metadata?.description ?? ""),
			page.content,
			Array.isArray(page.metadata?.contentBlocks)
				? page.metadata.contentBlocks
				: [],
		);
	const content = String(page.content ?? "");
	const blocks = Array.isArray(page.metadata?.contentBlocks)
		? page.metadata.contentBlocks
		: [];

	for (const match of content.matchAll(EMAIL_REGEX)) {
		pushFact(facts, seen, "email", match[0], "Email", match[0]);
	}

	for (const match of content.matchAll(PHONE_REGEX)) {
		const raw = normalizeScrapedText(match[0]);
		const digits = raw.replace(/\D/g, "");
		if (digits.length >= 7 && digits.length <= 16) {
			pushFact(facts, seen, "phone", raw, "Phone", match[0]);
		}
	}

	for (const block of blocks) {
		const text = normalizeScrapedText(block.text);
		if (!text) continue;

		if (hasContactSignals(text)) {
			const label = block.sectionTitle || "Contact";
			if (ADDRESS_KEYWORDS.test(text) && /\d/.test(text)) {
				pushFact(facts, seen, "address", text, label, text);
			}
			if (
				/\b(office|location|branch|head office|headquarters|registered office|dubai|bangalore|bengaluru|california|singapore|uae|india)\b/i.test(
					text,
				)
			) {
				pushFact(facts, seen, "location", text, label, text);
			}
		}

		if (
			(pageType === "services" ||
				pageType === "home" ||
				pageType === "about") &&
			(block.blockType === "list" ||
				block.sectionTitle?.match(SERVICE_HINTS))
		) {
			for (const item of text.split("|")) {
				const candidate = normalizeScrapedText(item);
				if (
					candidate &&
					candidate.length >= 4 &&
					candidate.length <= 90
				) {
					pushFact(
						facts,
						seen,
						"service",
						candidate,
						block.sectionTitle || "Service",
						text,
					);
				}
			}
		}

		if (
			pageType === "portfolio" &&
			block.sectionTitle &&
			!CASE_STUDY_HINTS.test(block.sectionTitle) &&
			block.sectionTitle.length <= 80
		) {
			pushFact(
				facts,
				seen,
				"case_study",
				block.sectionTitle,
				"Case Study",
				text,
			);
		}

		if (
			pageType === "pricing" &&
			(block.blockType === "table" ||
				block.blockType === "list")
		) {
			pushFact(
				facts,
				seen,
				"pricing",
				text,
				block.sectionTitle || "Pricing",
				text,
			);
		}
	}

	if (pageType === "portfolio") {
		pushFact(
			facts,
			seen,
			"case_study",
			page.title,
			"Case Study",
			page.title,
		);
	}

	return facts.slice(0, 40);
}

export function buildFactBlocks(
	facts: ScrapedStructuredFact[],
): ScrapedPageContentBlock[] {
	return facts.map((fact, index) => ({
		text: fact.label
			? `${fact.label}: ${fact.value}`
			: fact.value,
		blockType:
			fact.type === "address" ||
			fact.type === "phone" ||
			fact.type === "email" ||
			fact.type === "location"
				? "contact"
				: fact.type === "pricing"
					? "table"
					: "list",
		position: index,
		sectionTitle: fact.label,
		sectionPath: fact.label ? [fact.label] : undefined,
		factType: fact.type,
	}));
}

export function enrichScrapedPage(
	page: ScrapedPage,
): ScrapedPage {
	const description = String(
		page.metadata?.description ?? "",
	);
	const originalBlocks = Array.isArray(
		page.metadata?.contentBlocks,
	)
		? [...page.metadata.contentBlocks]
		: [];
	const pageType = detectScrapedPageType(
		page.url,
		page.title,
		description,
		page.content,
		originalBlocks,
	);
	const pagePriority = scorePagePriority(
		pageType,
		page.url,
	);
	const structuredFacts = extractStructuredFacts({
		url: page.url,
		title: page.title,
		content: page.content,
		metadata: {
			...(page.metadata ?? {}),
			pageType,
			contentBlocks: originalBlocks,
		},
	});
	const factBlocks = buildFactBlocks(structuredFacts);
	const contentBlocks = [...factBlocks, ...originalBlocks]
		.filter((block, index, array) => {
			const normalized = block.text.toLowerCase();
			return (
				normalized &&
				array.findIndex(
					(candidate) =>
						candidate.text.toLowerCase() ===
						normalized,
				) === index
			);
		})
		.map((block, index) => ({
			...block,
			position: index,
		}));

	return {
		...page,
		metadata: {
			...(page.metadata ?? {}),
			pageType,
			pagePriority,
			structuredFacts,
			contentBlocks,
		},
	};
}
