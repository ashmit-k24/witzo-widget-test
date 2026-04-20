import crypto from "crypto";
import {
	CHAT_RETRIEVAL_CACHE_TTL_SECONDS,
} from "../constants";
import { redisCache } from "../config/redis";
import { ChatMessage } from "../types";
import logger from "../utils/logger";
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

export function diversifyByUrl(matches: any[], maxPerUrl: number = 3): any[] {
	const urlCount = new Map<string, number>();
	return matches.filter((m) => {
		const url = String(m?.metadata?.url || "");
		const count = urlCount.get(url) ?? 0;
		if (count >= maxPerUrl) return false;
		urlCount.set(url, count + 1);
		return true;
	});
}

export function getRagScoreThreshold(): number {
	const envVal = parseFloat(process.env.RAG_SCORE_THRESHOLD ?? "");
	if (Number.isFinite(envVal) && envVal >= 0 && envVal <= 1) return envVal;
	return 0.27;
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

		const topK = 15;
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

