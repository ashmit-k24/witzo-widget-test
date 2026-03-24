import OpenAI from "openai";
import { config } from "../config/env";
import logger from "../utils/logger";

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export function normalizeWidgetQuery(q: string): string {
	return q.toLowerCase().trim().replace(/\s+/g, " ");
}

export function isFollowUpIntent(q: string): boolean {
	return /\b(that|this|those|these|it|them|what about|tell me more|what else|the one|which one|more about|go on|continue|expand|elaborate)\b/.test(q);
}

export function isPaginationIntent(q: string): boolean {
	return /\b(more|next|show more|another|others|different|additional|other examples|more examples|any others|what else)\b/.test(q) &&
		!/\b(tell me more about|more information about|more details about)\b/.test(q);
}

export function isContactIntent(q: string): boolean {
	return /\b(contact|address|phone|email|location|office|reach|get in touch|find you|where are you|support email|contact us|reach out)\b/.test(q);
}

export function isWidgetLocationQuery(q: string): boolean {
	return /\b(location|address|office|where are you located|where are you based|where are you|contact us)\b/.test(q);
}

export function isWidgetCaseStudyQuery(q: string): boolean {
	return /\b(case stud|portfolio|work|project|client|success stor|example|showcase|past work|previous work|your work|done for|built for|made for)\b/.test(q);
}

export function isWidgetTopListQuery(q: string): boolean {
	return /\b(top|best|featured|highlight|list)\b/.test(q);
}

export function isWidgetMedicalQuery(q: string): boolean {
	return /\b(medical|healthcare|clinic|doctor|hospital|dermatology|skin|hair)\b/.test(q);
}

export function isWidgetTechProjectQuery(q: string): boolean {
	return (
		/\b(project|work|built|made|developed|using|with)\b/.test(q) &&
		/\b(next\.?js|nextjs|react|vue|angular|shopify|wordpress|magento|woocommerce|laravel|node|python|flutter|kotlin|swift|aws|azure|tailwind|webflow|typescript)\b/.test(q)
	);
}

export function isLinkIntent(q: string): boolean {
	return /\b(link|url|website link|where can i find|give me the link|show me the link|link to the|link of the|case study link|case study url)\b/.test(q);
}

export function isWidgetServiceOverviewQuery(q: string): boolean {
	return /\b(service|what do you (do|offer|provide)|what (can|does) .* (do|offer|provide)|offering|solution|capability|capabilities|speciali)\b/.test(q);
}

function detectServiceFocusTerms(q: string): string[] {
	const focusTerms: string[] = [];
	const candidates = [
		"website development",
		"web development",
		"custom web development",
		"full-stack development",
		"e-commerce development",
		"ecommerce development",
		"cloud-based web development",
		"ui ux development",
		"ui/ux development",
		"cms development",
		"seo",
		"local seo",
		"digital marketing",
		"social media marketing",
		"ppc",
		"content writing",
		"web hosting",
		"brochure designing",
		"microsoft dynamics",
		"business central",
	];

	for (const candidate of candidates) {
		if (q.includes(candidate)) {
			focusTerms.push(candidate);
		}
	}

	return focusTerms;
}

export function detectIndustryFromQuery(q: string): string {
	const industries: Record<string, string> = {
		healthcare: "healthcare",
		health: "healthcare",
		medical: "healthcare",
		clinic: "healthcare",
		hospital: "healthcare",
		retail: "retail",
		ecommerce: "retail",
		fashion: "retail",
		education: "education",
		school: "education",
		college: "education",
		fintech: "fintech",
		finance: "fintech",
		payment: "fintech",
		"real estate": "real-estate",
		property: "real-estate",
		restaurant: "hospitality",
		hotel: "hospitality",
		software: "technology",
		tech: "technology",
		saas: "technology",
		insurance: "insurance",
		insurtech: "insurance",
	};
	for (const [keyword, industry] of Object.entries(industries)) {
		if (q.includes(keyword)) return industry;
	}
	return "";
}

// buildPineconeFilter returns a Pinecone metadata filter based on detected query intent.
// Returns null for general queries (no filter = search all chunks).
export function buildPineconeFilter(query: string): Record<string, unknown> | null {
	const normalized = normalizeWidgetQuery(query);

	if (isContactIntent(normalized)) {
		return { pageType: { $in: ["contact", "about", "home"] } };
	}

	if (isWidgetLocationQuery(normalized)) {
		return { pageType: { $in: ["contact", "about", "home"] } };
	}

	if (isWidgetTechProjectQuery(normalized)) {
		return {
			pageType: { $in: ["case_study", "portfolio", "service", "home"] },
		};
	}

	if (isWidgetCaseStudyQuery(normalized)) {
		const industry = detectIndustryFromQuery(normalized);
		if (industry) {
			return {
				$and: [
					{ pageType: { $eq: "case_study" } },
					{ industry: { $eq: industry } },
				],
			};
		}
		return { pageType: { $eq: "case_study" } };
	}

	if (isWidgetServiceOverviewQuery(normalized)) {
		return {
			pageType: {
				$in: ["service", "home", "about", "pricing", "portfolio"],
			},
		};
	}

	return null;
}

// Deterministic rewrites for common business intent patterns
function rewriteWidgetRetrievalQuery(q: string): [string, boolean] {
	const normalized = normalizeWidgetQuery(q);
	switch (true) {
		case isContactIntent(normalized):
			return [
				"contact details phone number email address office location reach us get in touch headquarters branch city how to contact",
				true,
			];
		case isWidgetLocationQuery(normalized):
			return [
				"company office locations contact us page business address Bangalore Dubai branch office address",
				true,
			];
		case isWidgetMedicalQuery(normalized) &&
			isWidgetCaseStudyQuery(normalized):
			return [
				"medical healthcare clinic case studies project results SEO Google Ads web development healthcare brand outcomes",
				true,
			];
		case isWidgetCaseStudyQuery(normalized) &&
			isWidgetTopListQuery(normalized):
			return [
				"top case studies portfolio projects client success stories brand names results outcomes metrics flagship work",
				true,
			];
		case isWidgetServiceOverviewQuery(normalized):
			const focusTerms = detectServiceFocusTerms(normalized);
			return [
				focusTerms.length > 0
					? `exact service offerings ${focusTerms.join(" ")} service pages solutions capabilities packages sub-services website headings page titles`
					: "exact services offered by the business from service pages, home page, about page, and solution pages including website development, custom web development, full-stack development, ecommerce development, cloud-based web development, UI UX development, CMS development, SEO, digital marketing, hosting, content writing, brochure designing, and business solutions",
				true,
			];
		default:
			return [q, false];
	}
}

// stepBackRewrite uses a cheap LLM call to rewrite a short user query into a broader,
// more descriptive retrieval query. Returns original on failure or if already long enough.
export async function stepBackRewrite(
	query: string,
	history?: Array<{ role: string; content: string }>,
): Promise<string> {
	const q = query.trim();
	if (!q || !config.OPENAI_API_KEY?.trim()) {
		return q;
	}

	const [rewritten, ok] = rewriteWidgetRetrievalQuery(q);
	if (ok) return rewritten;

	const normalized = normalizeWidgetQuery(q);
	const needsContext = isFollowUpIntent(normalized) || isPaginationIntent(normalized);

	if (!needsContext && q.split(/\s+/).length > 12) {
		logger.info("[RAG 1/5] step-back rewrite: skipped (query > 12 words)", { query: q });
		return q;
	}

	logger.info("[RAG 1/5] step-back rewrite: rewriting...", { original: q, needsContext });

	let contextBlock = "";
	if (needsContext && history && history.length > 0) {
		const last = history.slice(-6);
		const lines: string[] = [];
		for (const msg of last) {
			const content = msg.content.length > 300 ? msg.content.slice(0, 300) + "..." : msg.content;
			if (msg.role === "user") lines.push(`User: ${content}`);
			else if (msg.role === "assistant") lines.push(`Assistant: ${content}`);
		}
		contextBlock = lines.join("\n");
	}

	let prompt: string;
	if (contextBlock) {
		if (isPaginationIntent(normalized)) {
			prompt = `You are a search query optimizer for a customer support chatbot.\n\nConversation so far:\n${contextBlock}\nUser: ${q}\n\nThe user wants MORE results on the same topic. Rewrite the FINAL user message into a standalone search query that:\n1. Identifies the topic from the conversation history\n2. Requests additional or different items not already shown\nOutput ONLY the rewritten query, nothing else.`;
		} else {
			prompt = `You are a search query optimizer for a customer support chatbot.\n\nConversation so far:\n${contextBlock}\nUser: ${q}\n\nRewrite the FINAL user message into a standalone, specific search query that resolves all pronouns and references from the conversation history. Output ONLY the rewritten query, nothing else.`;
		}
	} else {
		prompt = `You are a search query optimizer. Rewrite the following short user query into a broader, more descriptive retrieval query that will help find relevant business information. Output ONLY the rewritten query, nothing else.\n\nOriginal: ${q}\nRewritten:`;
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 8000);
		try {
			const completion = await openai.chat.completions.create(
				{
					model: "gpt-4o-mini",
					messages: [{ role: "user", content: prompt }],
					temperature: 0.0,
					max_tokens: 60,
				},
				{ signal: controller.signal as any },
			);
			const result = (completion.choices[0]?.message?.content ?? "").trim();
			if (!result) return q;
			logger.info("[RAG 1/5] step-back rewrite: done", { original: q, rewritten: result });
			return result;
		} finally {
			clearTimeout(timeout);
		}
	} catch {
		logger.info("[RAG 1/5] step-back rewrite: failed, using original", { query: q });
		return q;
	}
}
