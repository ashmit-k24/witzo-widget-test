import OpenAI from "openai";
import crypto from "crypto";
import { config } from "../config/env";
import { redisCache } from "../config/redis";
import { ChatMessage } from "../types";
import {
	CHAT_SUMMARY_CACHE_TTL_SECONDS,
	CHAT_SUMMARY_KEEP_RECENT,
	CHAT_SUMMARY_TRIGGER_MESSAGES,
} from "../constants";
import logger from "../utils/logger";

type SummarizedMemory = {
	summary: string;           // compact summary of older messages
	recentMessages: ChatMessage[]; // verbatim recent messages
};

class MemorySummarizationService {
	private openai: OpenAI;

	constructor() {
		this.openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
	}

	/**
	 * Given the full message history, returns a summarized memory object.
	 * If history is short enough, returns it unchanged (summary="").
	 * Caches the summary by a hash of the older messages so it's only generated once.
	 */
	async buildMemory(
		sessionId: string,
		messages: ChatMessage[],
	): Promise<SummarizedMemory> {
		if (messages.length <= CHAT_SUMMARY_TRIGGER_MESSAGES) {
			return { summary: "", recentMessages: messages };
		}

		const cutoff = messages.length - CHAT_SUMMARY_KEEP_RECENT;
		const olderMessages = messages.slice(0, cutoff);
		const recentMessages = messages.slice(cutoff);

		// Check cache
		const cacheKey = this.buildCacheKey(sessionId, olderMessages);
		const cached = await redisCache.get(cacheKey);
		if (cached) {
			return { summary: cached, recentMessages };
		}

		// Generate summary
		const summary = await this.summarize(olderMessages);

		// Cache it
		await redisCache.setex(cacheKey, CHAT_SUMMARY_CACHE_TTL_SECONDS, summary);

		logger.info("[MemorySummarization] Generated conversation summary", {
			sessionId,
			olderCount: olderMessages.length,
			recentCount: recentMessages.length,
			summaryLength: summary.length,
		});

		return { summary, recentMessages };
	}

	private buildCacheKey(sessionId: string, messages: ChatMessage[]): string {
		// Hash the content of older messages for cache key
		const content = messages.map((m) => `${m.role}:${m.content}`).join("|");
		const digest = crypto.createHash("sha1").update(content).digest("hex");
		return `chat:summary:${sessionId}:${digest}`;
	}

	private async summarize(messages: ChatMessage[]): Promise<string> {
		const transcript = messages
			.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
			.join("\n");

		try {
			const completion = await this.openai.chat.completions.create({
				model: "gpt-4o-mini",
				messages: [
					{
						role: "system",
						content:
							"Summarize the following conversation into a compact memory block (3-5 sentences). Capture: what the user asked about, key facts shared (name, email, company, interests), and what was already answered. Write in third person about the user. Be factual and brief.",
					},
					{
						role: "user",
						content: transcript.slice(0, 4000), // cap to avoid token overflow
					},
				],
				max_tokens: 200,
				temperature: 0.1,
			});

			return (
				completion.choices[0]?.message?.content?.trim() ||
				"[No summary available]"
			);
		} catch (error) {
			logger.error("[MemorySummarization] Summary generation failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return "";
		}
	}
}

export const memorySummarizationService = new MemorySummarizationService();
