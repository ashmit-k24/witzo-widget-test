import crypto from "crypto";
import OpenAI from "openai";
import { config } from "../config/env";
import {
	CHAT_RETRIEVAL_CACHE_TTL_SECONDS,
} from "../constants";
import { redisCache } from "../config/redis";
import { ChatMessage } from "../types";
import logger from "../utils/logger";
import { getTopKForQuery } from "./queryService";
import { pineconeService } from "./pineconeService";

export type ContextResult = {
	matches: any[];
	sources: Array<{
		url: string;
		title: string;
		relevanceScore: number;
	}>;
};

// ── Match helpers ────────────────────────────────────────────────────────────

export function ragMatchScore(match: any): number {
	const raw = match?.score;
	return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

export function extractMatchText(match: any): string {
	return String(
		match?.metadata?.parentText ||
			match?.metadata?.content ||
			match?.metadata?.text ||
			"",
	).trim();
}

export function extractMatchTitle(match: any): string {
	return String(match?.metadata?.title || "").trim();
}

export function extractMatchUrl(match: any): string {
	return String(match?.metadata?.url || "").trim();
}

export function relevantRagMatches(matches: any[], minScore: number): any[] {
	return matches.filter((m) => ragMatchScore(m) >= minScore);
}

export function ragScoreThreshold(query: string): number {
	// Import inline to avoid circular dep — queryService has no dependency on this file
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { classifyQuery } = require("./queryService") as {
		classifyQuery: (q: string) => string;
	};
	switch (classifyQuery(query)) {
		case "pricing":
		case "contact":
			// High precision — a wrong price or wrong contact detail is worse than "I don't know"
			return 0.45;
		case "people":
			// Person queries need reasonable precision to avoid attributing the wrong role
			return 0.38;
		case "case_study":
		case "service":
			return 0.30;
		case "blog":
			return 0.28;
		case "general":
		default:
			// Open-ended questions benefit from slightly more recall
			return 0.27;
	}
}

// ── Cache key ────────────────────────────────────────────────────────────────

export function getRetrievalCacheKey(
	userId: string,
	sessionId: string,
	query: string,
): string {
	const normalized = query.toLowerCase().trim().replace(/\s+/g, " ");
	const digest = crypto.createHash("sha256").update(normalized).digest("hex");
	return `chat:retrieval:${userId}:${sessionId}:${digest}`;
}

// ── Context retrieval ────────────────────────────────────────────────────────

export async function retrieveRelevantContext(
	userId: string,
	query: string,
	sessionId: string,
	history: ChatMessage[],
): Promise<ContextResult> {
	try {
		const cacheKey = getRetrievalCacheKey(userId, sessionId, query);
		const cached = await redisCache.get(cacheKey);
		if (cached) {
			return JSON.parse(cached) as ContextResult;
		}

		const topK = getTopKForQuery(query);
		const results = await pineconeService.queryDocuments(userId, query, topK, {
			history: history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
		});

		if (!results || results.length === 0) {
			return { matches: [], sources: [] };
		}

		const sources: ContextResult["sources"] = [];
		for (const match of results) {
			if (!match?.metadata?.url) continue;
			if (!sources.find((s) => s.url === match.metadata.url)) {
				sources.push({
					url: match.metadata.url,
					title: match.metadata.title || match.metadata.url,
					relevanceScore: ragMatchScore(match),
				});
			}
		}

		const responseData: ContextResult = { matches: results, sources };
		await redisCache.setex(
			cacheKey,
			CHAT_RETRIEVAL_CACHE_TTL_SECONDS,
			JSON.stringify(responseData),
		);
		return responseData;
	} catch (error) {
		logger.error("Error retrieving context from Pinecone", { error, userId });
		return { matches: [], sources: [] };
	}
}

// ── Document grading (CRAG) + Answer grading ─────────────────────────────────

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export async function gradeDocuments(
	query: string,
	matches: any[],
): Promise<"yes" | "partial" | "no"> {
	if (!config.OPENAI_API_KEY?.trim() || matches.length === 0) return "no";

	const sampleText = matches
		.slice(0, 5)
		.map((m) => extractMatchText(m))
		.filter(Boolean)
		.join("\n---\n")
		.slice(0, 2000);

	if (!sampleText) return "no";

	try {
		const completion = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [
				{
					role: "user",
					content: `Does the following knowledge base excerpt contain enough information to answer the question: "${query}"?\n\nKnowledge Base:\n${sampleText}\n\nReply with exactly one word: yes, partial, or no.`,
				},
			],
			temperature: 0,
			max_tokens: 5,
		});
		const answer =
			completion.choices[0]?.message?.content?.trim().toLowerCase() ??
			"partial";
		if (answer === "yes" || answer === "partial" || answer === "no") {
			return answer;
		}
		return "partial";
	} catch {
		return "partial";
	}
}

// ── Answer grading (self-reflection) ─────────────────────────────────────────
// Grades whether the generated answer actually addresses the user's query.
// Used after generation to decide whether to retry with a different strategy.

export async function gradeAnswer(
	query: string,
	answer: string,
): Promise<"yes" | "no"> {
	if (!config.OPENAI_API_KEY?.trim() || !answer.trim()) return "yes";

	try {
		const completion = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [
				{
					role: "user",
					content: `Does this response actually answer the question asked?\n\nQuestion: "${query}"\n\nResponse: "${answer.slice(0, 600)}"\n\nReply with exactly one word: yes or no.`,
				},
			],
			temperature: 0,
			max_tokens: 5,
		});
		const result =
			completion.choices[0]?.message?.content?.trim().toLowerCase() ?? "yes";
		return result === "no" ? "no" : "yes";
	} catch {
		return "yes";
	}
}
