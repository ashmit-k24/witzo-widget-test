import OpenAI from "openai";
import { ChatMessage } from "../types";
import logger from "../utils/logger";

export type TurnType = "continuation" | "new_question" | "greeting";

const CLASSIFY_MODEL = "gpt-4o-mini";

const CLASSIFY_SYSTEM = `You are a conversation turn classifier for a website assistant chatbot.

Given conversation history and the latest user message, classify the message as exactly one of:
- "new_question": the user is asking a substantively new question, switching topic, or starting fresh
- "continuation": the user is continuing, confirming, or following up directly on what the assistant just said — e.g. short acknowledgements, "yes", "tell me more", "go on", "how much?", "what about X?" where X was just mentioned, very brief reactions that don't introduce a genuinely new topic
- "greeting": pure greeting or small talk with no information need (hi, hello, thanks, bye)

Rules:
- When uncertain, prefer "new_question" (safe default — retrieval is cheap)
- Single-word or very short messages following a long assistant response are almost always "continuation"
- If the user introduces a new named concept not in the last assistant message, classify as "new_question"

Respond with ONLY valid JSON on one line: {"type":"continuation"|"new_question"|"greeting"}`;

// Fast local lookup — these never need an LLM call
const OBVIOUS_CONTINUATIONS = new Set([
	"yes", "yeah", "yep", "yup", "sure", "ok", "okay", "alright",
	"great", "cool", "nice", "perfect", "fine", "good", "sounds good",
	"go on", "tell me more", "continue", "more", "and?", "so?", "and",
	"interesting", "i see", "i understand", "got it", "understood",
	"please", "please do", "yes please", "go ahead", "absolutely",
	"makes sense", "noted", "i see", "proceed", "next", "what else",
	"tell me", "ok great", "okay great", "ok sure", "okay sure",
	"exactly", "right", "correct", "true", "fair enough",
]);

const OBVIOUS_GREETINGS = new Set([
	"hi", "hello", "hey", "hii", "hola", "greetings", "howdy", "sup",
	"thanks", "thank you", "thank you!", "thanks!", "bye", "goodbye",
	"good morning", "good afternoon", "good evening",
]);

export async function classifyTurn(
	query: string,
	history: ChatMessage[],
	openai: OpenAI,
): Promise<TurnType> {
	const q = query.trim().toLowerCase().replace(/[.!?]+$/, "");

	if (OBVIOUS_CONTINUATIONS.has(q)) {
		return "continuation";
	}

	if (OBVIOUS_GREETINGS.has(q)) {
		return "greeting";
	}

	// No prior context → always a new question
	if (history.length === 0) {
		return "new_question";
	}

	// Very long messages are almost always new questions
	if (query.trim().length > 120) {
		return "new_question";
	}

	try {
		const recentHistory = history.slice(-4);
		const historyText = recentHistory
			.map(
				(m) =>
					`${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 300)}`,
			)
			.join("\n");

		const completion = await openai.chat.completions.create({
			model: CLASSIFY_MODEL,
			messages: [
				{ role: "system", content: CLASSIFY_SYSTEM },
				{
					role: "user",
					content: `Conversation so far:\n${historyText}\n\nLatest user message: "${query}"`,
				},
			],
			temperature: 0,
			max_tokens: 20,
		});

		const raw =
			completion.choices[0]?.message?.content?.trim() ?? "{}";
		const parsed = JSON.parse(raw) as { type?: string };
		const t = parsed.type;
		if (t === "continuation" || t === "new_question" || t === "greeting") {
			return t;
		}
		return "new_question";
	} catch (err) {
		logger.warn("Turn classification failed, defaulting to new_question", {
			err,
		});
		return "new_question";
	}
}
