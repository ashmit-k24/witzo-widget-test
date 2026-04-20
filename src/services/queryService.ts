import OpenAI from "openai";
import { config } from "../config/env";
import logger from "../utils/logger";

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export async function stepBackRewrite(
	query: string,
	history?: Array<{ role: string; content: string }>,
): Promise<string> {
	const trimmed = query.trim();
	if (!trimmed) return trimmed;

	const words = trimmed.split(/\s+/);
	const contextDependent =
		/\b(it|this|that|they|them|those|there|same|above|previous)\b/i.test(trimmed);
	if (words.length > 12 && !contextDependent) {
		return trimmed;
	}
	if (!config.OPENAI_API_KEY?.trim()) {
		return trimmed;
	}

	logger.info("[STEP-BACK] rewriting query", { original: trimmed, historyLength: (history ?? []).length });

	try {
		const recentHistory = (history ?? [])
			.slice(-6)
			.map((message) => `${message.role}: ${message.content.slice(0, 400)}`)
			.join("\n");

		const completion = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [
				{
					role: "system",
					content:
						"Given the conversation history, rewrite the user's latest message into a single detailed standalone search query that captures exactly what they want to know. " +
						"If the message is vague or short (e.g. 'yes', 'tell me more', 'what about that?'), resolve what specific topic they are referring to from the conversation. " +
						"Return only the rewritten query — never return the original word 'yes' or a similar non-specific reply.",
				},
				{
					role: "user",
					content: recentHistory
						? `Conversation:\n${recentHistory}\n\nLatest message: ${trimmed}`
						: `Query: ${trimmed}`,
				},
			],
			temperature: 0,
			max_tokens: 80,
		});
		const rewritten =
			completion.choices[0]?.message?.content?.trim() || trimmed;
		const finalQuery = rewritten.length > 0 && rewritten.length < 300
			? rewritten.replace(/^["']|["']$/g, "")
			: trimmed;
		logger.info("[STEP-BACK] rewrite result", { original: trimmed, rewritten: finalQuery });
		return finalQuery;
	} catch (error) {
		logger.warn("[STEP-BACK] rewrite failed, using original query", {
			original: trimmed,
			error: error instanceof Error ? error.message : String(error),
		});
		return trimmed;
	}
}
