import crypto from "crypto";
import OpenAI from "openai";
import { config } from "../config/env";
import { memCache } from "../utils/memCache";
import { openAICircuitBreaker } from "../utils/circuitBreaker";
import logger from "../utils/logger";
import { ScrapedPageType } from "../types";

const PAGE_CLASSIFICATION_TTL_SECONDS = 3600; // 1 hour

const VALID_PAGE_TYPES: ScrapedPageType[] = [
	"home",
	"contact",
	"pricing",
	"services",
	"about",
	"blog",
	"faq",
	"portfolio",
	"legal",
	"general",
];

export interface PageClassificationResult {
	pageType: ScrapedPageType;
	confidence: number;
}

class PageClassificationService {
	private openai: OpenAI;

	constructor() {
		this.openai = new OpenAI({
			apiKey: config.OPENAI_API_KEY,
		});
	}

	private buildCacheKey(url: string, title: string): string {
		const raw = `${url}|${title}`;
		return `page_classify:${crypto.createHash("sha1").update(raw).digest("hex")}`;
	}

	async classifyPageType(
		url: string,
		title: string,
		description: string = "",
		firstContent: string = "",
	): Promise<PageClassificationResult> {
		const cacheKey = this.buildCacheKey(url, title);
		const cached = memCache.get(cacheKey);
		if (cached) {
			try {
				return JSON.parse(cached) as PageClassificationResult;
			} catch {
				// ignore corrupt cache entry
			}
		}

		try {
			const prompt = `You are a web page classifier. Given the URL, title, description, and a snippet of content from a web page, classify the page into exactly one of these types:
home, contact, pricing, services, about, blog, faq, portfolio, legal, general

URL: ${url}
Title: ${title}
Description: ${description}
Content snippet: ${firstContent.slice(0, 500)}

Respond ONLY with a JSON object in this exact format:
{"pageType": "<one of the valid types>", "confidence": <number between 0 and 1>}`;

			const response = await openAICircuitBreaker.execute(async () => {
				return await this.openai.chat.completions.create({
					model: "gpt-4o-mini",
					messages: [{ role: "user", content: prompt }],
					response_format: { type: "json_object" },
					max_tokens: 60,
					temperature: 0,
				});
			});

			const raw = response.choices[0]?.message?.content ?? "";
			let parsed: { pageType?: unknown; confidence?: unknown };
			try {
				parsed = JSON.parse(raw);
			} catch {
				logger.warn("[PageClassification] Failed to parse LLM JSON", { raw, url });
				return { pageType: "general", confidence: 0 };
			}

			const pageType = VALID_PAGE_TYPES.includes(parsed.pageType as ScrapedPageType)
				? (parsed.pageType as ScrapedPageType)
				: "general";
			const confidence =
				typeof parsed.confidence === "number" &&
				parsed.confidence >= 0 &&
				parsed.confidence <= 1
					? parsed.confidence
					: 0;

			const result: PageClassificationResult = { pageType, confidence };
			memCache.setex(cacheKey, PAGE_CLASSIFICATION_TTL_SECONDS, JSON.stringify(result));
			return result;
		} catch (error) {
			logger.warn("[PageClassification] LLM classification failed, using fallback", {
				url,
				error: error instanceof Error ? error.message : String(error),
			});
			return { pageType: "general", confidence: 0 };
		}
	}
}

export const pageClassificationService = new PageClassificationService();
