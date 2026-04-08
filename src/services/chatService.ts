import crypto from "crypto";
import OpenAI from "openai";
import pool from "../config/database";
import { config } from "../config/env";
import { redisCache } from "../config/redis";
import {
	CHAT_COMPLETION_MAX_TOKENS,
	CHAT_COMPLETION_MODEL,
	CHAT_COMPLETION_TEMPERATURE,
	CHAT_DEFAULT_TIMEOUT_MS,
	CHAT_HISTORY_WINDOW_MESSAGES,
	CHAT_LANGUAGE_LABELS,
	CHAT_RETRIEVAL_CACHE_TTL_SECONDS,
	CHAT_SESSION_CACHE_MESSAGE_LIMIT,
	CHAT_SESSION_CACHE_TTL_SECONDS,
	CHAT_SUPPORTED_LANGUAGE_SET,
	UUID_V1_TO_V5_REGEX,
} from "../constants";
import {
	ChatMessage,
	ChatSession,
} from "../types";
import { openAICircuitBreaker } from "../utils/circuitBreaker";
import logger from "../utils/logger";
import { retryOnRateLimit } from "../utils/retry";
import {
	calendlyIntegrationService,
	CalendlyWidgetBookingAction,
} from "./calendlyIntegrationService";
import { pineconeService } from "./pineconeService";
import {
	getTopKForQuery,
	isAppointmentBookingIntent,
	normalizeWidgetQuery,
} from "./queryService";
import { scraperStatusService } from "./scraperStatusService";
import systemMessageService from "./systemMessageService";
import websiteBrandingService from "./websiteBrandingService";

type AppointmentLeadField =
	| "name"
	| "email"
	| "phone"
	| "country";

type AppointmentLeadState = {
	active: boolean;
	intentMessage: string | null;
	fields: Partial<
		Record<AppointmentLeadField, string>
	>;
	updatedAt: string;
};

type AppointmentIntentClassification = {
	isAppointmentIntent: boolean;
	confidence: "high" | "medium" | "low";
};

type AppointmentLeadTurnClassification = {
	action:
		| "requested_field"
		| "normal_chat"
		| "unclear";
	confidence: "high" | "medium" | "low";
};

type ContextResult = {
	matches: any[];
	sources: Array<{
		url: string;
		title: string;
		relevanceScore: number;
	}>;
};

type ChatTiming = {
	sessionMs: number;
	retrievalMs: number;
	llmMs: number;
	saveMs: number;
	totalMs: number;
};

type ConversationRow = {
	id: string;
	user_id: string;
	widget_key_id: number | null;
	visitor_id: string | null;
	created_at: Date;
	updated_at: Date;
};

type MessageRow = {
	role: "user" | "assistant" | "system";
	content: string;
	created_at: Date;
};

type CompletionUsage = {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
};

type AgenticDecision =
	| {
			mode: "search";
			query: string;
	  }
	| {
			mode: "respond";
			message: string;
	  };

type SemanticAnswerCacheEntry = {
	query: string;
	embedding: number[];
	response: string;
	sources: ContextResult["sources"];
	language?: string;
	createdAt: string;
};

class ChatService {
	private openai: OpenAI;

	constructor() {
		this.openai = new OpenAI({
			apiKey: config.OPENAI_API_KEY,
		});
	}

	private getSessionKey(
		sessionId: string,
	): string {
		return `chat:session:${sessionId}`;
	}

	private getRetrievalCacheKey(
		userId: string,
		sessionId: string,
		query: string,
	): string {
		const normalized = query
			.toLowerCase()
			.trim()
			.replace(/\s+/g, " ");
		const digest = crypto
			.createHash("sha1")
			.update(normalized)
			.digest("hex");
		return `chat:retrieval:${userId}:${sessionId}:${digest}`;
	}

	private getAppointmentLeadStateKey(
		sessionId: string,
	): string {
		return `chat:appointment-lead:${sessionId}`;
	}

	private getSemanticAnswerCacheKey(
		userId: string,
	): string {
		return `chat:semantic-answer:${userId}`;
	}

	private cosineSimilarity(
		a: number[],
		b: number[],
	): number {
		if (a.length === 0 || a.length !== b.length) {
			return 0;
		}
		let dot = 0;
		let normA = 0;
		let normB = 0;
		for (let i = 0; i < a.length; i += 1) {
			dot += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}
		return normA > 0 && normB > 0
			? dot / (Math.sqrt(normA) * Math.sqrt(normB))
			: 0;
	}

	private async getSemanticCachedAnswer(
		userId: string,
		query: string,
		language?: string,
	): Promise<{
		response: string;
		sources: ContextResult["sources"];
	} | null> {
		if (!config.SEMANTIC_ANSWER_CACHE_ENABLED) {
			return null;
		}
		try {
			const cached = await redisCache.get(
				this.getSemanticAnswerCacheKey(userId),
			);
			if (!cached) return null;
			const entries = JSON.parse(
				cached,
			) as SemanticAnswerCacheEntry[];
			if (entries.length === 0) return null;
			const queryEmbedding =
				await pineconeService.generateEmbedding(query);
			let best:
				| {
						score: number;
						entry: SemanticAnswerCacheEntry;
				  }
				| undefined;
			for (const entry of entries) {
				if ((entry.language || "") !== (language || "")) {
					continue;
				}
				const score = this.cosineSimilarity(
					queryEmbedding,
					entry.embedding,
				);
				if (!best || score > best.score) {
					best = { score, entry };
				}
			}
			if (
				!best ||
				best.score < config.SEMANTIC_ANSWER_CACHE_THRESHOLD
			) {
				return null;
			}
			logger.info("Chat semantic answer cache hit", {
				userId,
				score: best.score,
			});
			return {
				response: best.entry.response,
				sources: best.entry.sources,
			};
		} catch (error) {
			logger.warn("Chat semantic answer cache read failed", {
				userId,
				error:
					error instanceof Error
						? error.message
						: String(error),
			});
			return null;
		}
	}

	private async setSemanticCachedAnswer(
		userId: string,
		query: string,
		response: string,
		sources: ContextResult["sources"],
		language?: string,
	): Promise<void> {
		if (!config.SEMANTIC_ANSWER_CACHE_ENABLED) {
			return;
		}
		if (!response.trim()) return;
		try {
			const key = this.getSemanticAnswerCacheKey(userId);
			const cached = await redisCache.get(key);
			const entries = cached
				? (JSON.parse(cached) as SemanticAnswerCacheEntry[])
				: [];
			const embedding =
				await pineconeService.generateEmbedding(query);
			entries.unshift({
				query,
				embedding,
				response,
				sources,
				language,
				createdAt: new Date().toISOString(),
			});
			await redisCache.setex(
				key,
				60 * 60 * 12,
				JSON.stringify(
					entries.slice(
						0,
						config.SEMANTIC_ANSWER_CACHE_MAX_ENTRIES,
					),
				),
			);
		} catch (error) {
			logger.warn("Chat semantic answer cache write failed", {
				userId,
				error:
					error instanceof Error
						? error.message
						: String(error),
			});
		}
	}

	private async getAppointmentLeadState(
		sessionId: string,
	): Promise<AppointmentLeadState | null> {
		const cached = await redisCache.get(
			this.getAppointmentLeadStateKey(sessionId),
		);
		if (!cached) {
			return null;
		}

		try {
			return JSON.parse(
				cached,
			) as AppointmentLeadState;
		} catch {
			return null;
		}
	}

	private async saveAppointmentLeadState(
		sessionId: string,
		state: AppointmentLeadState,
	): Promise<void> {
		await redisCache.setex(
			this.getAppointmentLeadStateKey(sessionId),
			60 * 60 * 24,
			JSON.stringify(state),
		);
	}

	private async clearAppointmentLeadState(
		sessionId: string,
	): Promise<void> {
		await redisCache.del(
			this.getAppointmentLeadStateKey(sessionId),
		);
	}

	private shouldRunAppointmentIntentClassifier(
		normalizedMessage: string,
	): boolean {
		if (!normalizedMessage) {
			return false;
		}

		return (
			/\b(book|booking|schedule|scheduling|arrange|arranging|set up|setup|plan|planning|meet|meeting|demo|consult|consultation|call|callback|connect|contact|sales|team|speak|talk|discuss)\b/.test(
				normalizedMessage,
			) ||
			normalizedMessage.includes("appoint") ||
			normalizedMessage.includes("appoin") ||
			normalizedMessage.includes("meting") ||
			normalizedMessage.includes("schedul")
		);
	}

	private async classifyAppointmentIntent(
		message: string,
		recentMessages: ChatMessage[],
	): Promise<AppointmentIntentClassification> {
		if (
			!config.OPENAI_API_KEY?.trim() ||
			!this.shouldRunAppointmentIntentClassifier(
				normalizeWidgetQuery(message),
			)
		) {
			return {
				isAppointmentIntent: false,
				confidence: "low",
			};
		}

		const recentConversation = recentMessages
			.filter((entry) => entry.role !== "system")
			.slice(-4)
			.map(
				(entry) =>
					`${entry.role === "assistant" ? "Assistant" : "Visitor"}: ${entry.content}`,
			)
			.join("\n");

		const prompt = `Classify whether the latest visitor message is asking to book or arrange a human follow-up such as an appointment, meeting, demo, consultation, callback, sales conversation, or team call.

Be tolerant of typos, short phrases, and poor grammar.

Return only valid JSON with this exact shape:
{
  "isAppointmentIntent": true,
  "confidence": "high"
}

Use "high" when the visitor clearly wants to schedule or be contacted for a meeting/demo/call.
Use "medium" when the visitor likely wants that but wording is indirect or typo-heavy.
Use "low" when it is not a booking/contact request.

Treat these as positive examples:
- "i wanted to book an appoinment"
- "can your team call me"
- "i need a demo"
- "want to discuss my project with sales"
- "can we schedule a meeting"

Treat these as negative examples:
- asking for office address, phone number, or email only
- asking what services are offered
- asking for pricing or plans
- general support questions without asking for a meeting/call

Recent conversation:
${recentConversation || "None"}

Latest visitor message:
${message}`;

		try {
			const timeoutController =
				new AbortController();
			const timeout = setTimeout(() => {
				timeoutController.abort();
			}, CHAT_DEFAULT_TIMEOUT_MS);

			try {
				const completion =
					await openAICircuitBreaker.execute(
						async () => {
							return await retryOnRateLimit(
								async () => {
									return await this.openai.chat.completions.create(
										{
											model:
												CHAT_COMPLETION_MODEL,
											messages: [
												{
													role: "user",
													content: prompt,
												},
											],
											temperature: 0,
											max_tokens: 80,
											response_format: {
												type: "json_object",
											},
										},
										{
											signal:
												timeoutController.signal,
										},
									);
								},
								2,
							);
						},
					);

				const raw =
					completion.choices[0]?.message
						.content || "{}";
				const parsed = JSON.parse(
					raw,
				) as Partial<AppointmentIntentClassification>;
				const confidence =
					parsed.confidence === "high" ||
					parsed.confidence === "medium" ||
					parsed.confidence === "low"
						? parsed.confidence
						: "low";

				return {
					isAppointmentIntent:
						parsed.isAppointmentIntent === true,
					confidence,
				};
			} finally {
				clearTimeout(timeout);
			}
		} catch (error) {
			logger.warn(
				"Appointment intent classification failed",
				{
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
			return {
				isAppointmentIntent: false,
				confidence: "low",
			};
		}
	}

	private extractEmailCandidate(
		message: string,
	): string | null {
		const match = message.match(
			/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
		);
		return match?.[0]?.trim() || null;
	}

	private extractPhoneCandidate(
		message: string,
	): string | null {
		const match = message.match(
			/(?:(?:\+?\d[\d\s().-]{6,}\d))/,
		);
		if (!match?.[0]) {
			return null;
		}

		const candidate = match[0].trim();
		const digits = candidate.replace(/\D/g, "");
		if (digits.length < 7 || digits.length > 15) {
			return null;
		}

		return candidate;
	}

	private extractNameCandidate(
		message: string,
	): string | null {
		const patterns = [
			/\bmy name is\s+([a-z][a-z\s.'-]{1,60})/i,
			/\bi am\s+([a-z][a-z\s.'-]{1,60})/i,
			/\bthis is\s+([a-z][a-z\s.'-]{1,60})/i,
		];

		for (const pattern of patterns) {
			const match = message.match(pattern);
			if (match?.[1]) {
				return match[1].trim();
			}
		}

		return null;
	}

	private isBasicAppointmentTextFieldValue(
		message: string,
	): boolean {
		const trimmed = message.trim();
		if (
			!trimmed ||
			trimmed.length > 60 ||
			trimmed.includes("?") ||
			/@/.test(trimmed) ||
			/\d/.test(trimmed)
		) {
			return false;
		}

		const words = trimmed
			.split(/\s+/)
			.filter(Boolean);
		if (words.length < 1 || words.length > 4) {
			return false;
		}

		return words.every((word) =>
			/^[a-z]+(?:[.'-][a-z]+)*$/i.test(word),
		);
	}

	private extractCountryCandidate(
		message: string,
	): string | null {
		const patterns = [
			/\bi(?:'m| am) from\s+([a-z][a-z\s.'-]{1,60})/i,
			/\bi am based in\s+([a-z][a-z\s.'-]{1,60})/i,
			/\bcountry(?: is|:)?\s+([a-z][a-z\s.'-]{1,60})/i,
		];

		for (const pattern of patterns) {
			const match = message.match(pattern);
			if (match?.[1]) {
				return match[1].trim();
			}
		}

		return null;
	}

	private async classifyAppointmentLeadTurn(
		message: string,
		expectedField: AppointmentLeadField,
		state: AppointmentLeadState,
		recentMessages: ChatMessage[],
	): Promise<AppointmentLeadTurnClassification> {
		const trimmed = message.trim();
		if (!trimmed) {
			return {
				action: "unclear",
				confidence: "low",
			};
		}

		if (trimmed.includes("?")) {
			return {
				action: "normal_chat",
				confidence: "medium",
			};
		}

		if (!config.OPENAI_API_KEY?.trim()) {
			return {
				action: "unclear",
				confidence: "low",
			};
		}

		const recentConversation = recentMessages
			.filter((entry) => entry.role !== "system")
			.slice(-6)
			.map(
				(entry) =>
					`${entry.role === "assistant" ? "Assistant" : "Visitor"}: ${entry.content}`,
			)
			.join("\n");

		const prompt = `You are classifying the visitor's latest message during an appointment booking flow.

The assistant previously asked for this exact field: "${expectedField}".
The original appointment request was: "${state.intentMessage || "Not provided"}".

Return only valid JSON with this exact shape:
{
  "action": "requested_field",
  "confidence": "high"
}

Valid actions:
- "requested_field": the visitor is trying to provide the requested detail
- "normal_chat": the visitor is asking a different question or changing topic and should get a normal chatbot answer
- "unclear": the visitor is not clearly doing either

Rules:
- If the visitor asks a business question, requests information, or changes the topic, use "normal_chat"
- If the visitor clearly provides the requested field value, use "requested_field"
- Greetings, acknowledgements, or vague replies like "hi", "okay", "thanks" should usually be "unclear"
- Be tolerant of typos and short casual wording

Recent conversation:
${recentConversation || "None"}

Latest visitor message:
${message}`;

		try {
			const timeoutController =
				new AbortController();
			const timeout = setTimeout(() => {
				timeoutController.abort();
			}, CHAT_DEFAULT_TIMEOUT_MS);

			try {
				const completion =
					await openAICircuitBreaker.execute(
						async () => {
							return await retryOnRateLimit(
								async () => {
									return await this.openai.chat.completions.create(
										{
											model:
												CHAT_COMPLETION_MODEL,
											messages: [
												{
													role: "user",
													content: prompt,
												},
											],
											temperature: 0,
											max_tokens: 80,
											response_format: {
												type: "json_object",
											},
										},
										{
											signal:
												timeoutController.signal,
										},
									);
								},
								2,
							);
						},
					);

				const raw =
					completion.choices[0]?.message
						.content || "{}";
				const parsed = JSON.parse(
					raw,
				) as Partial<AppointmentLeadTurnClassification>;
				const action =
					parsed.action === "requested_field" ||
					parsed.action === "normal_chat" ||
					parsed.action === "unclear"
						? parsed.action
						: "unclear";
				const confidence =
					parsed.confidence === "high" ||
					parsed.confidence === "medium" ||
					parsed.confidence === "low"
						? parsed.confidence
						: "low";

				return {
					action,
					confidence,
				};
			} finally {
				clearTimeout(timeout);
			}
		} catch (error) {
			logger.warn(
				"Appointment lead turn classification failed",
				{
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
			return {
				action: "unclear",
				confidence: "low",
			};
		}
	}

	private getNextAppointmentLeadField(
		state: AppointmentLeadState,
	): AppointmentLeadField | null {
		const orderedFields: AppointmentLeadField[] =
			["name", "email", "phone", "country"];

		for (const field of orderedFields) {
			if (!state.fields[field]?.trim()) {
				return field;
			}
		}

		return null;
	}

	private buildAppointmentLeadPrompt(
		nextField: AppointmentLeadField,
		state: AppointmentLeadState,
	): string {
		switch (nextField) {
			case "name":
				return "We'd be happy to help you book an appointment. To get this arranged, may I have your full name?";
			case "email":
				return state.fields.name
					? `Thanks, ${state.fields.name}. What email address should we use to confirm the appointment?`
					: "Thanks. What email address should we use to confirm the appointment?";
			case "phone":
				return "Great. What phone number can we reach you on for the appointment?";
			case "country":
				return "Thank you. Which country are you based in?";
			default:
				return "Thanks. Please share the next detail so we can arrange the appointment.";
		}
	}

	private buildInvalidAppointmentLeadPrompt(
		field: AppointmentLeadField,
	): string {
		switch (field) {
			case "email":
				return "Please share a valid email address so we can confirm your appointment.";
			case "phone":
				return "Please share a valid phone number, including country code if possible.";
			case "name":
				return "Please share your full name so we can arrange the appointment for you.";
			case "country":
				return "Please share the country you're based in so our team can route your appointment correctly.";
			default:
				return "Please share that detail so we can continue with the appointment request.";
		}
	}

	private hydrateAppointmentLeadState(
		state: AppointmentLeadState,
		message: string,
	): AppointmentLeadState {
		const nextState: AppointmentLeadState = {
			...state,
			fields: {
				...state.fields,
			},
			updatedAt: new Date().toISOString(),
		};

		const email =
			this.extractEmailCandidate(message);
		if (email) {
			nextState.fields.email = email;
		}

		const phone =
			this.extractPhoneCandidate(message);
		if (phone) {
			nextState.fields.phone = phone;
		}

		const name =
			this.extractNameCandidate(message);
		if (name) {
			nextState.fields.name = name;
		}

		const country =
			this.extractCountryCandidate(message);
		if (country) {
			nextState.fields.country = country;
		}

		return nextState;
	}

	private captureExpectedAppointmentField(
		state: AppointmentLeadState,
		field: AppointmentLeadField,
		message: string,
	): {
		state: AppointmentLeadState;
		valid: boolean;
	} {
		const trimmed = message.trim();
		const nextState: AppointmentLeadState = {
			...state,
			fields: {
				...state.fields,
			},
			updatedAt: new Date().toISOString(),
		};

		switch (field) {
			case "email": {
				const email =
					nextState.fields.email ||
					this.extractEmailCandidate(trimmed);
				if (!email) {
					return {
						state: nextState,
						valid: false,
					};
				}
				nextState.fields.email = email;
				return { state: nextState, valid: true };
			}
			case "phone": {
				const phone =
					nextState.fields.phone ||
					this.extractPhoneCandidate(trimmed);
				if (!phone) {
					return {
						state: nextState,
						valid: false,
					};
				}
				nextState.fields.phone = phone;
				return { state: nextState, valid: true };
			}
			case "name": {
				const extractedName =
					nextState.fields.name ||
					this.extractNameCandidate(trimmed);
				if (extractedName) {
					nextState.fields.name = extractedName;
					return {
						state: nextState,
						valid: true,
					};
				}
				return { state: nextState, valid: false };
			}
			case "country": {
				const extractedCountry =
					nextState.fields.country ||
					this.extractCountryCandidate(trimmed);
				if (extractedCountry) {
					nextState.fields.country =
						extractedCountry;
					return {
						state: nextState,
						valid: true,
					};
				}
				return { state: nextState, valid: false };
			}
			default:
				return { state: nextState, valid: false };
		}
	}

	private normalizeSessionId(
		sessionId?: string,
	): string | null {
		if (!sessionId) return null;
		const normalized = sessionId
			.trim()
			.toLowerCase();
		if (!UUID_V1_TO_V5_REGEX.test(normalized))
			return null;
		return normalized;
	}

	private mapCachedSession(
		data: string,
	): ChatSession {
		const parsed = JSON.parse(
			data,
		) as ChatSession;
		return {
			...parsed,
			createdAt: new Date(parsed.createdAt),
			updatedAt: new Date(parsed.updatedAt),
			messages: (parsed.messages || []).map(
				(msg) => ({
					...msg,
					timestamp: new Date(msg.timestamp),
				}),
			),
		};
	}

	private async getCachedSession(
		sessionId: string,
	): Promise<ChatSession | null> {
		const data = await redisCache.get(
			this.getSessionKey(sessionId),
		);
		if (!data) return null;
		return this.mapCachedSession(data);
	}

	private async saveCachedSession(
		session: ChatSession,
	): Promise<void> {
		const payload: ChatSession = {
			...session,
			messages: session.messages.slice(
				-CHAT_SESSION_CACHE_MESSAGE_LIMIT,
			),
		};
		await redisCache.setex(
			this.getSessionKey(session.sessionId),
			CHAT_SESSION_CACHE_TTL_SECONDS,
			JSON.stringify(payload),
		);
	}

	private getTopKForQuery(_query: string): number {
		return getTopKForQuery(_query);
	}

	private getFallbackResponse(): string {
		return "I don't have information about that. Please contact support.";
	}

	private getLearningFallbackResponse(): string {
		return "I'm still learning this site. Try again in a few minutes.";
	}

	private async hasActiveScrapeJob(
		userId: string,
	): Promise<boolean> {
		const latest =
			await scraperStatusService.getLatestJobForUser(
				userId,
			);
		return (
			latest?.status === "pending" ||
			latest?.status === "in_progress"
		);
	}

	private ragMatchScore(match: any): number {
		const raw = match?.score;
		return typeof raw === "number" &&
			Number.isFinite(raw)
			? raw
			: 0;
	}

	private extractMatchText(match: any): string {
		return String(
			match?.metadata?.parentText ||
				match?.metadata?.content ||
				match?.metadata?.text ||
				"",
		).trim();
	}

	private extractMatchTitle(match: any): string {
		return String(
			match?.metadata?.title || "",
		).trim();
	}

	private extractMatchUrl(match: any): string {
		return String(
			match?.metadata?.url || "",
		).trim();
	}

	private relevantRagMatches(
		matches: any[],
		minScore: number,
	): any[] {
		return matches.filter((match) => {
			const score = this.ragMatchScore(match);
			return score >= minScore;
		});
	}

	private ragScoreThreshold(
		_query: string,
	): number {
		return 0.3;
	}

	private defaultGeneratedSystemPrompt(): string {
		return (
			"You are a helpful assistant for this company's website. " +
			"Answer the user's question using only the knowledge base provided in the user message. " +
			"If the knowledge base does not contain the answer, say so honestly and suggest the user contact the team. " +
			"Never invent facts, prices, features, or policies. " +
			"Be concise and direct. Use markdown when helpful, but do not pad answers with unnecessary descriptions or filler."
		);
	}

	private formatAssistantResponse(
		response: string,
		_userMessage: string,
		websiteName: string = "this website",
	): string {
		let output = response.trim();
		output =
			this.normalizeOrderedMarkdownLists(output);
		output = this.normalizeCompanyVoice(
			output,
			websiteName,
		);
		return this.finalizeResponseEnding(output);
	}

	private normalizeOrderedMarkdownLists(
		text: string,
	): string {
		const lines = text.split("\n");
		let orderedIndex = 0;
		let lastOrderedLine = false;
		let pendingBlankAfterOrdered = false;

		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i];
			const trimmed = line.trim();

			if (!trimmed) {
				if (lastOrderedLine) {
					pendingBlankAfterOrdered = true;
				} else {
					orderedIndex = 0;
				}
				lastOrderedLine = false;
				continue;
			}

			const orderedMatch = line.match(
				/^(\s*)\d+\.\s+(.+)$/,
			);
			if (orderedMatch) {
				orderedIndex += 1;
				lines[i] =
					`${orderedMatch[1]}${orderedIndex}. ${orderedMatch[2]}`;
				lastOrderedLine = true;
				pendingBlankAfterOrdered = false;
				continue;
			}

			if (
				pendingBlankAfterOrdered ||
				!lastOrderedLine
			) {
				orderedIndex = 0;
			}
			pendingBlankAfterOrdered = false;
			lastOrderedLine = false;
		}

		return lines.join("\n");
	}

	private normalizeCompanyVoice(
		text: string,
		websiteName: string,
	): string {
		const normalizedWebsiteName = String(
			websiteName || "",
		).trim();
		if (!normalizedWebsiteName) {
			return text;
		}

		const escapedWebsiteName =
			normalizedWebsiteName.replace(
				/[.*+?^${}()|[\]\\]/g,
				"\\$&",
			);

		const replacements: Array<[RegExp, string]> =
			[
				[
					new RegExp(
						`(^|\\n)${escapedWebsiteName}\\s+offers\\b`,
						"gi",
					),
					"$1We offer",
				],
				[
					new RegExp(
						`(^|\\n)${escapedWebsiteName}\\s+provides\\b`,
						"gi",
					),
					"$1We provide",
				],
				[
					new RegExp(
						`(^|\\n)${escapedWebsiteName}\\s+has\\b`,
						"gi",
					),
					"$1We have",
				],
				[
					new RegExp(
						`(^|\\n)${escapedWebsiteName}\\s+is\\b`,
						"gi",
					),
					"$1We are",
				],
				[
					new RegExp(
						`(^|\\n)To apply for a job at\\s+${escapedWebsiteName}\\b`,
						"gi",
					),
					"$1To apply for a job with us",
				],
				[
					new RegExp(
						`(^|\\n)At\\s+${escapedWebsiteName}\\b`,
						"gi",
					),
					"$1With us",
				],
			];

		return replacements.reduce(
			(output, [pattern, replacement]) =>
				output.replace(pattern, replacement),
			text,
		);
	}

	private finalizeResponseEnding(
		text: string,
	): string {
		let output = text.trim();
		if (!output) return output;

		const boldMarkerCount = (
			output.match(/\*\*/g) || []
		).length;
		if (boldMarkerCount % 2 !== 0) {
			output = output.replace(
				/\*\*([^*]*)$/g,
				"$1",
			);
		}

		if (/[,:;]$/.test(output)) {
			output = `${output.slice(0, -1).trim()}.`;
		}
		return output;
	}

	public normalizePersonName(
		_raw: string,
	): string | null {
		return null;
	}

	public extractNameFromUserMessage(
		message: string,
	): string | null {
		const text = message.trim();
		if (!text) return null;

		const patterns = [
			/^\s*my name is\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,2})\s*$/i,
			/^\s*this is\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,2})\s*$/i,
			/^\s*i am\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,2})\s*$/i,
			/^\s*i['’]m\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,2})\s*$/i,
			/^\s*(?:my\s+)?(?:full\s+name|name)\s*[:=-]\s*([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,2})\s*$/i,
		];

		for (const pattern of patterns) {
			const match = text.match(pattern);
			if (!match || !match[1]) continue;
			const normalized = this.normalizePersonName(
				match[1],
			);
			if (normalized) return normalized;
		}

		return null;
	}

	private isLikelySmallTalk(
		message: string,
	): boolean {
		const value = message.toLowerCase().trim();
		if (!value) return false;
		return /\b(hi|hello|hey|good morning|good evening|thanks|thank you|bye)\b/.test(
			value,
		);
	}

	private normalizeLanguagePreference(
		language?: string,
	): string | undefined {
		if (!language) return undefined;
		const normalized = language
			.trim()
			.toLowerCase();
		if (!normalized) return undefined;
		if (
			!CHAT_SUPPORTED_LANGUAGE_SET.has(normalized)
		) {
			return undefined;
		}
		return normalized;
	}

	private buildLanguageInstruction(
		languageCode?: string,
	): string | null {
		if (!languageCode) {
			return null;
		}

		const normalized =
			this.normalizeLanguagePreference(
				languageCode,
			);
		if (!normalized) {
			return null;
		}

		const languageLabel =
			CHAT_LANGUAGE_LABELS[
				normalized as keyof typeof CHAT_LANGUAGE_LABELS
			] || normalized;

		return [
			`IMPORTANT LANGUAGE RULE: Reply in ${languageLabel}.`,
			`Use ${languageLabel} for the full answer, including headings, bullets, and summary sentences.`,
			"Only keep URLs, brand names, product names, email addresses, and technical identifiers in their original form when needed.",
			"Even if the visitor writes in English, keep the response in the requested language unless they explicitly ask you to switch languages.",
		].join("\n");
	}

	private async getConversation(
		sessionId: string,
		userId: string,
	): Promise<ConversationRow | null> {
		const result =
			await pool.query<ConversationRow>(
				`SELECT id, user_id, widget_key_id, visitor_id, created_at, updated_at
			 FROM chat_conversations
			 WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE
			 LIMIT 1`,
				[sessionId, userId],
			);

		return result.rows[0] ?? null;
	}

	private async createConversation(
		userId: string,
		sessionId?: string,
	): Promise<ConversationRow> {
		if (sessionId) {
			const explicit =
				await pool.query<ConversationRow>(
					`INSERT INTO chat_conversations (id, user_id)
				 VALUES ($1, $2)
				 ON CONFLICT (id) DO NOTHING
				 RETURNING id, user_id, widget_key_id, visitor_id, created_at, updated_at`,
					[sessionId, userId],
				);

			if (explicit.rows[0]) {
				return explicit.rows[0];
			}

			const existing = await this.getConversation(
				sessionId,
				userId,
			);
			if (existing) return existing;
		}

		const created =
			await pool.query<ConversationRow>(
				`INSERT INTO chat_conversations (id, user_id)
			 VALUES ($1, $2)
			 RETURNING id, user_id, widget_key_id, visitor_id, created_at, updated_at`,
				[crypto.randomUUID(), userId],
			);

		return created.rows[0];
	}

	private async loadRecentMessages(
		sessionId: string,
		limit: number,
	): Promise<ChatMessage[]> {
		const result = await pool.query<MessageRow>(
			`SELECT role, content, created_at
			 FROM chat_messages
			 WHERE conversation_id = $1
			 ORDER BY created_at DESC, id DESC
			 LIMIT $2`,
			[sessionId, limit],
		);

		return result.rows.reverse().map((row) => ({
			role: row.role,
			content: row.content,
			timestamp: row.created_at,
		}));
	}

	private async getOrCreateSession(
		userId: string,
		rawSessionId?: string,
	): Promise<ChatSession> {
		const sessionId =
			this.normalizeSessionId(rawSessionId) ??
			undefined;
		let conversation: ConversationRow | null =
			null;

		if (sessionId) {
			conversation = await this.getConversation(
				sessionId,
				userId,
			);
		}

		if (!conversation) {
			conversation =
				await this.createConversation(
					userId,
					sessionId,
				);
		}

		const cached = await this.getCachedSession(
			conversation.id,
		);
		if (cached && cached.userId === userId) {
			return cached;
		}

		const messages =
			await this.loadRecentMessages(
				conversation.id,
				CHAT_SESSION_CACHE_MESSAGE_LIMIT,
			);

		const session: ChatSession = {
			sessionId: conversation.id,
			userId: conversation.user_id,
			messages,
			createdAt: conversation.created_at,
			updatedAt: conversation.updated_at,
		};

		await this.saveCachedSession(session);
		return session;
	}

	private async persistMessage(
		sessionId: string,
		userId: string,
		role: "user" | "assistant" | "system",
		content: string,
		metadata: Record<string, unknown> = {},
		tokenCount?: number,
	): Promise<Date> {
		const result = await pool.query<{
			created_at: Date;
		}>(
			`WITH inserted AS (
				INSERT INTO chat_messages (conversation_id, user_id, role, content, metadata, token_count)
				VALUES ($1, $2, $3, $4, $5::jsonb, $6)
				RETURNING created_at
			)
			UPDATE chat_conversations
			SET message_count = message_count + 1,
				last_message_at = (SELECT created_at FROM inserted),
				last_message_preview = LEFT($4, 280),
				updated_at = CURRENT_TIMESTAMP
			WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE
			RETURNING (SELECT created_at FROM inserted) AS created_at`,
			[
				sessionId,
				userId,
				role,
				content,
				JSON.stringify(metadata),
				tokenCount ?? null,
			],
		);

		if (!result.rows[0]) {
			throw new Error(
				"Failed to persist chat message",
			);
		}

		return result.rows[0].created_at;
	}

	private async retrieveRelevantContext(
		userId: string,
		query: string,
		sessionId: string,
		history: ChatMessage[],
	): Promise<ContextResult> {
		try {
			const cacheKey = this.getRetrievalCacheKey(
				userId,
				sessionId,
				query,
			);
			const cached =
				await redisCache.get(cacheKey);
			if (cached) {
				return JSON.parse(
					cached,
				) as ContextResult;
			}

			const topK = this.getTopKForQuery(query);
			const results =
				await pineconeService.queryDocuments(
					userId,
					query,
					topK,
					{
						history: history
							.slice(-6)
							.map((message) => ({
								role: message.role,
								content: message.content,
							})),
					},
				);

			if (!results || results.length === 0) {
				return { matches: [], sources: [] };
			}

			const sources: Array<{
				url: string;
				title: string;
				relevanceScore: number;
			}> = [];

			for (const match of results) {
				if (!match?.metadata?.url) {
					continue;
				}
				if (
					!sources.find(
						(source) =>
							source.url === match.metadata.url,
					)
				) {
					sources.push({
						url: match.metadata.url,
						title:
							match.metadata.title ||
							match.metadata.url,
						relevanceScore:
							this.ragMatchScore(match),
					});
				}
			}

			const responseData: ContextResult = {
				matches: results,
				sources,
			};
			await redisCache.setex(
				cacheKey,
				CHAT_RETRIEVAL_CACHE_TTL_SECONDS,
				JSON.stringify(responseData),
			);
			return responseData;
		} catch (error) {
			logger.error(
				"Error retrieving context from Pinecone",
				{ error, userId },
			);
			return { matches: [], sources: [] };
		}
	}

	private async buildChatMessages(
		userId: string,
		query: string,
		matches: any[],
		messages: ChatMessage[],
		_languageCode?: string,
	): Promise<Array<any>> {
		const effectiveSystemMessage =
			await systemMessageService.resolveEffectiveSystemMessage(
				userId,
			);

		// Build a flat knowledge-base block from retrieved matches.
		const contextParts: string[] = [];
		for (const match of matches) {
			const text = this.extractMatchText(match);
			if (!text) continue;
			const sourceUrl =
				this.extractMatchUrl(match);
			const sourceTitle =
				this.extractMatchTitle(match);
			const headerParts = [
				sourceTitle
					? `Title: ${sourceTitle}`
					: "",
				sourceUrl ? `Source: ${sourceUrl}` : "",
			].filter(Boolean);
			contextParts.push(
				headerParts.length > 0
					? `${headerParts.join("\n")}\n${text}`
					: text,
			);
		}

		const systemPrompt =
			effectiveSystemMessage.trim() ||
			this.defaultGeneratedSystemPrompt();
		const languageInstruction =
			this.buildLanguageInstruction(
				_languageCode,
			);

		const conversationHistory: Array<any> = [
			{
				role: "system",
				content: systemPrompt,
			},
		];
		if (languageInstruction) {
			conversationHistory.push({
				role: "system",
				content: languageInstruction,
			});
		}

		const recentMessages = messages.slice(
			-CHAT_HISTORY_WINDOW_MESSAGES,
		);
		for (const msg of recentMessages) {
			conversationHistory.push({
				role: msg.role,
				content: msg.content,
			});
		}

		const userPrompt =
			contextParts.length > 0
				? `Knowledge Base:\n${contextParts.join("\n\n---\n\n")}\n\nQuestion: ${query}`
				: `Question: ${query}`;

		conversationHistory.push({
			role: "user",
			content: userPrompt,
		});
		return conversationHistory;
	}

	private async generateNonStreamingResponse(
		conversationHistory: Array<any>,
		timeoutMs: number,
	): Promise<{
		response: string;
		usage?: CompletionUsage;
	}> {
		const timeoutController =
			new AbortController();
		const timeout = setTimeout(() => {
			timeoutController.abort(
				"OpenAI request timeout",
			);
		}, timeoutMs);

		try {
			const completion =
				await openAICircuitBreaker.execute(
					async () => {
						return await retryOnRateLimit(
							async () => {
								return await this.openai.chat.completions.create(
									{
										model: CHAT_COMPLETION_MODEL,
										messages: conversationHistory,
										temperature:
											CHAT_COMPLETION_TEMPERATURE,
										max_tokens:
											CHAT_COMPLETION_MAX_TOKENS,
									},
									{
										signal:
											timeoutController.signal,
									},
								);
							},
						);
					},
				);

			return {
				response:
					completion.choices[0].message.content ||
					this.getFallbackResponse(),
				usage: completion.usage
					? {
							prompt_tokens:
								completion.usage.prompt_tokens ??
								0,
							completion_tokens:
								completion.usage
									.completion_tokens ?? 0,
							total_tokens:
								completion.usage.total_tokens ??
								0,
						}
					: undefined,
			};
		} finally {
			clearTimeout(timeout);
		}
	}

	private async resolveAgenticDecision(
		userId: string,
		query: string,
		history: ChatMessage[],
		languageCode?: string,
	): Promise<AgenticDecision> {
		if (!config.OPENAI_API_KEY?.trim()) {
			return { mode: "search", query };
		}

		const websiteName =
			await websiteBrandingService.resolveUserWebsiteName(
				userId,
			);
		const recentHistory = history
			.slice(-CHAT_HISTORY_WINDOW_MESSAGES)
			.map((message) => ({
				role: message.role,
				content: message.content,
			}));
		const languageInstruction =
			this.buildLanguageInstruction(languageCode);
		const tools: any[] = [
			{
				type: "function",
				function: {
					name: "search_knowledge_base",
					description:
						"Search the website knowledge base before answering questions about the company, services, pricing, contact details, projects, policies, or website content.",
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description:
									"Standalone search query for the knowledge base.",
							},
						},
						required: ["query"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "respond_to_user",
					description:
						"Respond directly only for greetings, thanks, simple conversational turns, or when no website knowledge is needed.",
					parameters: {
						type: "object",
						properties: {
							message: {
								type: "string",
								description:
									"Short direct response to the user.",
							},
						},
						required: ["message"],
					},
				},
			},
		];

		try {
			const completion =
				await openAICircuitBreaker.execute(
					async () =>
						await retryOnRateLimit(async () =>
							this.openai.chat.completions.create({
								model: CHAT_COMPLETION_MODEL,
								messages: [
									{
										role: "system",
										content: `You are deciding whether to search ${websiteName}'s website knowledge base. Choose exactly one tool.`,
									},
									...(languageInstruction
										? [
												{
													role: "system" as const,
													content:
														languageInstruction,
												},
											]
										: []),
									...recentHistory,
									{
										role: "user",
										content: query,
									},
								],
								temperature: 0,
								max_tokens: 120,
								tools,
								tool_choice: "required",
							}),
						),
				);
			const toolCall: any =
				completion.choices[0]?.message
					?.tool_calls?.[0];
			if (!toolCall) {
				return { mode: "search", query };
			}
			const args = JSON.parse(
				toolCall.function.arguments || "{}",
			) as {
				query?: string;
				message?: string;
			};
			if (
				toolCall.function.name ===
				"respond_to_user"
			) {
				return {
					mode: "respond",
					message:
						args.message?.trim() ||
						this.getFallbackResponse(),
				};
			}
			return {
				mode: "search",
				query: args.query?.trim() || query,
			};
		} catch (error) {
			logger.warn(
				"Agentic retrieval decision failed; using knowledge search",
				{
					userId,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
			return {
				mode: this.isLikelySmallTalk(query)
					? "respond"
					: "search",
				...(this.isLikelySmallTalk(query)
					? {
							message:
								"How can I help you today?",
						}
					: { query }),
			} as AgenticDecision;
		}
	}

	private buildUsageMetadata(
		usage?: CompletionUsage,
	): {
		metadata: Record<string, number>;
		tokenCount?: number;
	} {
		if (!usage) {
			return { metadata: {} };
		}

		const promptTokens = Math.max(
			0,
			Math.trunc(usage.prompt_tokens || 0),
		);
		const completionTokens = Math.max(
			0,
			Math.trunc(usage.completion_tokens || 0),
		);
		const totalTokens = Math.max(
			0,
			Math.trunc(usage.total_tokens || 0),
		);

		return {
			metadata: {
				promptTokens,
				completionTokens,
				totalTokens,
			},
			tokenCount: totalTokens,
		};
	}

	async answerKnowledgeQuery(
		userId: string,
		message: string,
		language?: string,
	): Promise<{
		answer: string;
		language?: string;
		sources: Array<{
			url: string;
			title: string;
			relevanceScore: number;
		}>;
		matches: any[];
	}> {
		const resolvedLanguage =
			this.normalizeLanguagePreference(language);
		const syntheticSessionId = `adhoc:${crypto
			.createHash("sha1")
			.update(`${userId}:${message}`)
			.digest("hex")}`;
		const cachedAnswer =
			await this.getSemanticCachedAnswer(
				userId,
				message,
				resolvedLanguage,
			);
		if (cachedAnswer) {
			return {
				answer: cachedAnswer.response,
				language: resolvedLanguage,
				sources: cachedAnswer.sources,
				matches: [],
			};
		}
		const decision =
			await this.resolveAgenticDecision(
				userId,
				message,
				[],
				resolvedLanguage,
			);
		const { matches, sources } =
			decision.mode === "respond"
				? { matches: [], sources: [] }
				: await this.retrieveRelevantContext(
						userId,
						decision.query,
						syntheticSessionId,
						[],
					);
		const ragThreshold =
			this.ragScoreThreshold(message);
		const relevantMatches =
			this.relevantRagMatches(
				matches,
				ragThreshold,
			);
		const shouldCallLlm =
			decision.mode === "respond" ||
			relevantMatches.length > 0;
		const fallbackResponse =
			decision.mode === "search" &&
			relevantMatches.length === 0 &&
			(await this.hasActiveScrapeJob(userId))
				? this.getLearningFallbackResponse()
				: this.getFallbackResponse();
		let answer =
			decision.mode === "respond"
				? decision.message
				: fallbackResponse;

		if (shouldCallLlm && decision.mode === "search") {
			const completion =
				await this.generateNonStreamingResponse(
					await this.buildChatMessages(
						userId,
						decision.query,
						relevantMatches,
						[],
						resolvedLanguage,
					),
					CHAT_DEFAULT_TIMEOUT_MS,
				);
			answer =
				completion.response || fallbackResponse;
		}

		const websiteName =
			await websiteBrandingService.resolveUserWebsiteName(
				userId,
			);
		answer = this.formatAssistantResponse(
			answer,
			message,
			websiteName,
		);
		if (shouldCallLlm) {
			await this.setSemanticCachedAnswer(
				userId,
				message,
				answer,
				sources,
				resolvedLanguage,
			);
		}

		return {
			answer,
			language: resolvedLanguage,
			sources,
			matches: relevantMatches,
		};
	}

	async handleAppointmentLeadCapture(
		userId: string,
		message: string,
		input: {
			sessionId?: string;
			language?: string;
			onToken?: (token: string) => void;
		},
	): Promise<{
		sessionId: string;
		response: string;
		language?: string;
		sources: Array<{
			url: string;
			title: string;
			relevanceScore: number;
		}>;
		timing: ChatTiming;
		calendlyBooking?: CalendlyWidgetBookingAction;
	} | null> {
		const startedAt = Date.now();
		const timing: ChatTiming = {
			sessionMs: 0,
			retrievalMs: 0,
			llmMs: 0,
			saveMs: 0,
			totalMs: 0,
		};
		const resolvedLanguage =
			this.normalizeLanguagePreference(
				input.language,
			);
		const normalizedMessage =
			normalizeWidgetQuery(message);

		const sessionStart = Date.now();
		const session = await this.getOrCreateSession(
			userId,
			input.sessionId,
		);
		timing.sessionMs = Date.now() - sessionStart;

		const existingState =
			await this.getAppointmentLeadState(
				session.sessionId,
			);
		const regexMatchedIntent =
			isAppointmentBookingIntent(
				normalizedMessage,
			);
		let classifiedIntent: AppointmentIntentClassification =
			{
				isAppointmentIntent: false,
				confidence: "low",
			};

		if (
			!existingState?.active &&
			!regexMatchedIntent
		) {
			const classifierStart = Date.now();
			classifiedIntent =
				await this.classifyAppointmentIntent(
					message,
					session.messages,
				);
			timing.llmMs +=
				Date.now() - classifierStart;
		}

		const isActive =
			Boolean(existingState?.active) ||
			regexMatchedIntent ||
			(classifiedIntent.isAppointmentIntent &&
				classifiedIntent.confidence !== "low");

		if (!isActive) {
			return null;
		}

		let leadTurnClassification: AppointmentLeadTurnClassification | null =
			null;
		if (existingState?.active) {
			const expectedField =
				this.getNextAppointmentLeadField(
					existingState,
				);
			if (expectedField) {
				const previewState =
					this.hydrateAppointmentLeadState(
						existingState,
						message,
					);
				const previewCapture =
					this.captureExpectedAppointmentField(
						previewState,
						expectedField,
						message,
					);
				if (!previewCapture.valid) {
					const leadTurnClassifierStart =
						Date.now();
					leadTurnClassification =
						await this.classifyAppointmentLeadTurn(
							message,
							expectedField,
							existingState,
							session.messages,
						);
					timing.llmMs +=
						Date.now() - leadTurnClassifierStart;
					if (
						leadTurnClassification.action ===
							"normal_chat" &&
						leadTurnClassification.confidence !==
							"low"
					) {
						return null;
					}
				}
			}
		}

		const saveStart = Date.now();
		const userTimestamp =
			await this.persistMessage(
				session.sessionId,
				userId,
				"user",
				message,
				{
					language: resolvedLanguage,
					appointmentLeadCapture: true,
				},
			);
		session.messages.push({
			role: "user",
			content: message,
			timestamp: userTimestamp,
		});

		let state: AppointmentLeadState =
			existingState ?? {
				active: true,
				intentMessage: message.trim() || null,
				fields: {},
				updatedAt: new Date().toISOString(),
			};

		state = this.hydrateAppointmentLeadState(
			state,
			message,
		);

		const calendlyBooking =
			await calendlyIntegrationService.getWidgetBookingAction(
				userId,
				session.sessionId,
			);

		if (calendlyBooking) {
			const response =
				"Absolutely. You can choose a date and time directly in the calendar below.";
			await this.clearAppointmentLeadState(
				session.sessionId,
			);
			const assistantTimestamp =
				await this.persistMessage(
					session.sessionId,
					userId,
					"assistant",
					response,
					{
						language: resolvedLanguage,
						appointmentLeadCapture: true,
						calendlyBookingPrompt: true,
						leadCaptureCompleted: true,
					},
				);
			session.messages.push({
				role: "assistant",
				content: response,
				timestamp: assistantTimestamp,
			});
			session.updatedAt = assistantTimestamp;
			await this.saveCachedSession(session);
			input.onToken?.(response);

			timing.saveMs = Date.now() - saveStart;
			timing.totalMs = Date.now() - startedAt;

			logger.info(
				"Calendly booking prompt handled",
				{
					userId,
					sessionId: session.sessionId,
				},
			);

			return {
				sessionId: session.sessionId,
				response,
				language: resolvedLanguage,
				sources: [],
				timing,
				calendlyBooking,
			};
		}

		let response = "";
		if (existingState?.active) {
			const expectedField =
				this.getNextAppointmentLeadField(
					existingState,
				);
			if (expectedField) {
				const captured =
					this.captureExpectedAppointmentField(
						state,
						expectedField,
						message,
					);
				state = captured.state;
				if (!captured.valid) {
					if (
						leadTurnClassification?.action ===
							"requested_field" &&
						(expectedField === "name" ||
							expectedField === "country") &&
						this.isBasicAppointmentTextFieldValue(
							message,
						)
					) {
						state.fields[expectedField] =
							message.trim();
					} else {
						response =
							this.buildInvalidAppointmentLeadPrompt(
								expectedField,
							);
					}
				}
			}
		}

		const nextField =
			this.getNextAppointmentLeadField(state);
		if (!response) {
			if (nextField) {
				response =
					this.buildAppointmentLeadPrompt(
						nextField,
						state,
					);
			} else {
				response =
					"Thank you. We've captured your appointment request, and our team will reach out soon to schedule the meeting.";
			}
		}

		if (nextField) {
			await this.saveAppointmentLeadState(
				session.sessionId,
				state,
			);
		} else {
			await this.clearAppointmentLeadState(
				session.sessionId,
			);
		}

		const assistantTimestamp =
			await this.persistMessage(
				session.sessionId,
				userId,
				"assistant",
				response,
				{
					language: resolvedLanguage,
					appointmentLeadCapture: true,
					leadCaptureCompleted: !nextField,
				},
			);
		session.messages.push({
			role: "assistant",
			content: response,
			timestamp: assistantTimestamp,
		});
		session.updatedAt = assistantTimestamp;
		await this.saveCachedSession(session);
		input.onToken?.(response);

		timing.saveMs = Date.now() - saveStart;
		timing.totalMs = Date.now() - startedAt;

		logger.info(
			"Appointment lead capture handled",
			{
				userId,
				sessionId: session.sessionId,
				completed: !nextField,
				nextField,
				intentSource: existingState?.active
					? "session_state"
					: regexMatchedIntent
						? "rule"
						: "openai_classifier",
				intentConfidence:
					classifiedIntent.confidence,
			},
		);

		return {
			sessionId: session.sessionId,
			response,
			language: resolvedLanguage,
			sources: [],
			timing,
		};
	}

	async chat(
		userId: string,
		message: string,
		sessionId?: string,
		language?: string,
	): Promise<{
		sessionId: string;
		response: string;
		language?: string;
		sources: Array<{
			url: string;
			title: string;
			relevanceScore: number;
		}>;
	}> {
		try {
			const startedAt = Date.now();
			const resolvedLanguage =
				this.normalizeLanguagePreference(
					language,
				);
			const timing: ChatTiming = {
				sessionMs: 0,
				retrievalMs: 0,
				llmMs: 0,
				saveMs: 0,
				totalMs: 0,
			};

			const sessionStart = Date.now();
			const session =
				await this.getOrCreateSession(
					userId,
					sessionId,
				);
			timing.sessionMs =
				Date.now() - sessionStart;

			const saveStart = Date.now();
			const userTimestamp =
				await this.persistMessage(
					session.sessionId,
					userId,
					"user",
					message,
					{
						language: resolvedLanguage,
					},
				);
			const userMessage: ChatMessage = {
				role: "user",
				content: message,
				timestamp: userTimestamp,
			};
			session.messages.push(userMessage);
			const historyMessages =
				session.messages.slice(0, -1);

			if (historyMessages.length <= 2) {
				const cachedAnswer =
					await this.getSemanticCachedAnswer(
						userId,
						message,
						resolvedLanguage,
					);
				if (cachedAnswer) {
					const assistantTimestamp =
						await this.persistMessage(
							session.sessionId,
							userId,
							"assistant",
							cachedAnswer.response,
							{
								sourcesCount:
									cachedAnswer.sources.length,
								language: resolvedLanguage,
								isCacheHit: true,
							},
						);
					session.messages.push({
						role: "assistant",
						content: cachedAnswer.response,
						timestamp: assistantTimestamp,
					});
					session.updatedAt =
						assistantTimestamp;
					await this.saveCachedSession(session);
					return {
						sessionId: session.sessionId,
						response: cachedAnswer.response,
						language: resolvedLanguage,
						sources: cachedAnswer.sources,
					};
				}
			}

			const retrievalStart = Date.now();
			const decision =
				await this.resolveAgenticDecision(
					userId,
					message,
					historyMessages,
					resolvedLanguage,
				);
			const { matches, sources } =
				decision.mode === "respond"
					? {
							matches: [],
							sources: [],
						}
					: await this.retrieveRelevantContext(
							userId,
							decision.query,
							session.sessionId,
							historyMessages,
						);
			timing.retrievalMs =
				Date.now() - retrievalStart;
			const relevantMatches =
				this.relevantRagMatches(
					matches,
					this.ragScoreThreshold(
						decision.mode === "search"
							? decision.query
							: message,
					),
				);
			const shouldCallLlm =
				decision.mode === "respond" ||
				relevantMatches.length > 0;

			const fallbackResponse =
				decision.mode === "search" &&
				relevantMatches.length === 0 &&
				(await this.hasActiveScrapeJob(userId))
					? this.getLearningFallbackResponse()
					: this.getFallbackResponse();
			let assistantResponse =
				decision.mode === "respond"
					? decision.message
					: fallbackResponse;
			let usedFallback = !shouldCallLlm;
			let usage: CompletionUsage | undefined;
			const llmStart = Date.now();
			if (shouldCallLlm && decision.mode === "search") {
				try {
					const conversationHistory =
						await this.buildChatMessages(
							userId,
							decision.query,
							relevantMatches,
							historyMessages,
							resolvedLanguage,
						);
					const completionResult =
						await this.generateNonStreamingResponse(
							conversationHistory,
							CHAT_DEFAULT_TIMEOUT_MS,
						);
					assistantResponse =
						completionResult.response;
					usage = completionResult.usage;
					usedFallback =
						assistantResponse ===
						fallbackResponse;
				} catch (error) {
					logger.error(
						"Chat generation failed, using fallback",
						{
							error,
							userId,
						},
					);
					usedFallback = true;
				}
			}
			const websiteName =
				await websiteBrandingService.resolveUserWebsiteName(
					userId,
				);
			assistantResponse =
				this.formatAssistantResponse(
					assistantResponse,
					message,
					websiteName,
				);
			if (!usedFallback) {
				await this.setSemanticCachedAnswer(
					userId,
					message,
					assistantResponse,
					sources,
					resolvedLanguage,
				);
			}
			timing.llmMs = Date.now() - llmStart;

			const usageMeta =
				this.buildUsageMetadata(usage);
			const assistantTimestamp =
				await this.persistMessage(
					session.sessionId,
					userId,
					"assistant",
					assistantResponse,
					{
						sourcesCount: sources.length,
						language: resolvedLanguage,
						isFallback: usedFallback,
						...usageMeta.metadata,
					},
					usageMeta.tokenCount,
				);
			const assistantMessage: ChatMessage = {
				role: "assistant",
				content: assistantResponse,
				timestamp: assistantTimestamp,
			};
			session.messages.push(assistantMessage);
			session.updatedAt = assistantTimestamp;

			await this.saveCachedSession(session);
			timing.saveMs = Date.now() - saveStart;
			timing.totalMs = Date.now() - startedAt;

			logger.info("Chat response generated", {
				userId,
				sessionId: session.sessionId,
				language: resolvedLanguage,
				sourcesCount: sources.length,
				timing,
			});

			return {
				sessionId: session.sessionId,
				response: assistantResponse,
				language: resolvedLanguage,
				sources,
			};
		} catch (error) {
			logger.error("Error in chat service", {
				error,
				userId,
			});
			throw error;
		}
	}

	async chatStream(
		userId: string,
		message: string,
		sessionId: string | undefined,
		options?: {
			timeoutMs?: number;
			onToken?: (token: string) => void;
		},
		language?: string,
	): Promise<{
		sessionId: string;
		response: string;
		language?: string;
		sources: Array<{
			url: string;
			title: string;
			relevanceScore: number;
		}>;
		timing: ChatTiming;
	}> {
		const startedAt = Date.now();
		const timing: ChatTiming = {
			sessionMs: 0,
			retrievalMs: 0,
			llmMs: 0,
			saveMs: 0,
			totalMs: 0,
		};
		const timeoutMs =
			options?.timeoutMs ??
			CHAT_DEFAULT_TIMEOUT_MS;
		const resolvedLanguage =
			this.normalizeLanguagePreference(language);

		const sessionStart = Date.now();
		const session = await this.getOrCreateSession(
			userId,
			sessionId,
		);
		timing.sessionMs = Date.now() - sessionStart;

		const saveStart = Date.now();
		const userTimestamp =
			await this.persistMessage(
				session.sessionId,
				userId,
				"user",
				message,
				{
					language: resolvedLanguage,
				},
			);
		session.messages.push({
			role: "user",
			content: message,
			timestamp: userTimestamp,
		});
		const historyMessages =
			session.messages.slice(0, -1);

		if (historyMessages.length <= 2) {
			const cachedAnswer =
				await this.getSemanticCachedAnswer(
					userId,
					message,
					resolvedLanguage,
				);
			if (cachedAnswer) {
				options?.onToken?.(cachedAnswer.response);
				const assistantTimestamp =
					await this.persistMessage(
						session.sessionId,
						userId,
						"assistant",
						cachedAnswer.response,
						{
							sourcesCount:
								cachedAnswer.sources.length,
							language: resolvedLanguage,
							isCacheHit: true,
						},
					);
				session.messages.push({
					role: "assistant",
					content: cachedAnswer.response,
					timestamp: assistantTimestamp,
				});
				session.updatedAt = assistantTimestamp;
				await this.saveCachedSession(session);
				timing.saveMs = Date.now() - saveStart;
				timing.totalMs = Date.now() - startedAt;
				return {
					sessionId: session.sessionId,
					response: cachedAnswer.response,
					language: resolvedLanguage,
					sources: cachedAnswer.sources,
					timing,
				};
			}
		}

		const retrievalStart = Date.now();
		const decision =
			await this.resolveAgenticDecision(
				userId,
				message,
				historyMessages,
				resolvedLanguage,
			);
		const { matches, sources } =
			decision.mode === "respond"
				? { matches: [], sources: [] }
				: await this.retrieveRelevantContext(
						userId,
						decision.query,
						session.sessionId,
						historyMessages,
					);
		timing.retrievalMs =
			Date.now() - retrievalStart;
		const relevantMatches =
			this.relevantRagMatches(
				matches,
				this.ragScoreThreshold(
					decision.mode === "search"
						? decision.query
						: message,
				),
			);
		const shouldCallLlm =
			decision.mode === "respond" ||
			relevantMatches.length > 0;

		const fallbackResponse =
			this.getFallbackResponse();
		let assistantResponse =
			decision.mode === "respond"
				? decision.message
				: decision.mode === "search" &&
					  relevantMatches.length === 0 &&
					  (await this.hasActiveScrapeJob(userId))
					? this.getLearningFallbackResponse()
					: fallbackResponse;
		let usedFallback = !shouldCallLlm;
		let usage: CompletionUsage | undefined;
		const llmStart = Date.now();
		if (shouldCallLlm && decision.mode === "search") {
			const timeoutController =
				new AbortController();
			const timeout = setTimeout(() => {
				timeoutController.abort(
					"OpenAI stream timeout",
				);
			}, timeoutMs);
			assistantResponse = "";
			try {
				const conversationHistory =
					await this.buildChatMessages(
						userId,
						decision.query,
						relevantMatches,
						historyMessages,
						resolvedLanguage,
					);
				const stream =
					await openAICircuitBreaker.execute(
						async () => {
							return await this.openai.chat.completions.create(
								{
									model: CHAT_COMPLETION_MODEL,
									messages: conversationHistory,
									temperature:
										CHAT_COMPLETION_TEMPERATURE,
									max_tokens:
										CHAT_COMPLETION_MAX_TOKENS,
									stream: true,
									stream_options: {
										include_usage: true,
									},
								},
								{
									signal:
										timeoutController.signal,
								},
							);
						},
					);

				for await (const chunk of stream) {
					if (chunk.usage) {
						usage = {
							prompt_tokens:
								chunk.usage.prompt_tokens ?? 0,
							completion_tokens:
								chunk.usage.completion_tokens ??
								0,
							total_tokens:
								chunk.usage.total_tokens ?? 0,
						};
					}
					const token =
						chunk.choices?.[0]?.delta?.content ??
						"";
					if (!token) continue;
					assistantResponse += token;
					options?.onToken?.(token);
				}
			} catch (error) {
				logger.error(
					"Streaming chat failed, falling back",
					{
						error,
						userId,
					},
				);
				if (!assistantResponse) {
					assistantResponse = fallbackResponse;
					usedFallback = true;
				}
			} finally {
				clearTimeout(timeout);
			}
		} else if (decision.mode === "respond") {
			options?.onToken?.(assistantResponse);
		}
		timing.llmMs = Date.now() - llmStart;

		if (!assistantResponse.trim()) {
			assistantResponse = fallbackResponse;
			usedFallback = true;
		}
		const websiteName =
			await websiteBrandingService.resolveUserWebsiteName(
				userId,
			);
		assistantResponse =
			this.formatAssistantResponse(
				assistantResponse,
				message,
				websiteName,
			);
		if (!usedFallback) {
			await this.setSemanticCachedAnswer(
				userId,
				message,
				assistantResponse,
				sources,
				resolvedLanguage,
			);
		}

		const usageMeta =
			this.buildUsageMetadata(usage);
		const assistantTimestamp =
			await this.persistMessage(
				session.sessionId,
				userId,
				"assistant",
				assistantResponse,
				{
					sourcesCount: sources.length,
					language: resolvedLanguage,
					isFallback: usedFallback,
					...usageMeta.metadata,
				},
				usageMeta.tokenCount,
			);
		session.messages.push({
			role: "assistant",
			content: assistantResponse,
			timestamp: assistantTimestamp,
		});
		session.updatedAt = assistantTimestamp;

		await this.saveCachedSession(session);
		timing.saveMs = Date.now() - saveStart;
		timing.totalMs = Date.now() - startedAt;

		logger.info(
			"Chat streaming response generated",
			{
				userId,
				sessionId: session.sessionId,
				language: resolvedLanguage,
				sourcesCount: sources.length,
				timing,
			},
		);

		return {
			sessionId: session.sessionId,
			response: assistantResponse,
			language: resolvedLanguage,
			sources,
			timing,
		};
	}

	async getSession(
		sessionId: string,
	): Promise<ChatSession | null> {
		const normalized =
			this.normalizeSessionId(sessionId);
		if (!normalized) return null;

		const conversationResult =
			await pool.query<ConversationRow>(
				`SELECT id, user_id, widget_key_id, visitor_id, created_at, updated_at
			 FROM chat_conversations
			 WHERE id = $1 AND is_deleted = FALSE
			 LIMIT 1`,
				[normalized],
			);
		const conversation =
			conversationResult.rows[0];
		if (!conversation) return null;

		const messageResult =
			await pool.query<MessageRow>(
				`SELECT role, content, created_at
			 FROM chat_messages
			 WHERE conversation_id = $1
			 ORDER BY created_at ASC, id ASC
			 LIMIT 200`,
				[normalized],
			);

		const messages: ChatMessage[] =
			messageResult.rows.map((row) => ({
				role: row.role,
				content: row.content,
				timestamp: row.created_at,
			}));

		const session: ChatSession = {
			sessionId: conversation.id,
			userId: conversation.user_id,
			messages,
			createdAt: conversation.created_at,
			updatedAt:
				messages.length > 0
					? messages[messages.length - 1]
							.timestamp
					: conversation.updated_at,
		};

		await this.saveCachedSession(session);
		return session;
	}

	async getConversationContext(
		sessionId: string,
		userId: string,
	): Promise<{
		widgetKeyId: number | null;
		visitorId: string | null;
	} | null> {
		const normalized =
			this.normalizeSessionId(sessionId);
		if (!normalized) {
			return null;
		}

		const result = await pool.query<{
			widget_key_id: number | null;
			visitor_id: string | null;
		}>(
			`SELECT widget_key_id, visitor_id
			 FROM chat_conversations
			 WHERE id = $1
			   AND user_id = $2
			   AND is_deleted = FALSE
			 LIMIT 1`,
			[normalized, userId],
		);

		const row = result.rows[0];
		if (!row) {
			return null;
		}

		return {
			widgetKeyId: row.widget_key_id,
			visitorId: row.visitor_id,
		};
	}

	async attachConversationContext(
		sessionId: string,
		userId: string,
		context: {
			widgetKeyId?: number | null;
			visitorId?: string | null;
		},
	): Promise<void> {
		const normalized =
			this.normalizeSessionId(sessionId);
		if (!normalized) {
			return;
		}

		const widgetKeyId =
			context.widgetKeyId ?? null;
		const visitorId =
			context.visitorId?.trim() || null;

		await pool.query(
			`UPDATE chat_conversations
			 SET widget_key_id = COALESCE($3, widget_key_id),
			     visitor_id = COALESCE($4, visitor_id),
			     updated_at = CURRENT_TIMESTAMP
			 WHERE id = $1
			   AND user_id = $2
			   AND is_deleted = FALSE`,
			[
				normalized,
				userId,
				widgetKeyId,
				visitorId,
			],
		);
	}

	async clearSession(
		sessionId: string,
	): Promise<boolean> {
		const normalized =
			this.normalizeSessionId(sessionId);
		if (!normalized) return false;

		const result = await pool.query(
			`DELETE FROM chat_conversations WHERE id = $1`,
			[normalized],
		);

		if ((result.rowCount ?? 0) > 0) {
			await redisCache.del(
				this.getSessionKey(normalized),
			);
			await this.clearAppointmentLeadState(
				normalized,
			);
			return true;
		}
		return false;
	}

	async getUserChatSessions(
		userId: string,
	): Promise<
		Array<{
			sessionId: string;
			messageCount: number;
			createdAt: Date;
			updatedAt: Date;
			lastMessage: string | null;
		}>
	> {
		const result = await pool.query<{
			id: string;
			message_count: number;
			created_at: Date;
			updated_at: Date;
			last_message_preview: string | null;
			last_message_at: Date;
		}>(
			`SELECT id, message_count, created_at, updated_at, last_message_preview, last_message_at
			 FROM chat_conversations
			 WHERE user_id = $1 AND is_deleted = FALSE
			 ORDER BY last_message_at DESC`,
			[userId],
		);

		return result.rows.map((row) => ({
			sessionId: row.id,
			messageCount: row.message_count,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			lastMessage: row.last_message_preview,
		}));
	}

	async clearUserSessions(
		userId: string,
	): Promise<number> {
		const result = await pool.query<{
			id: string;
		}>(
			`DELETE FROM chat_conversations
			 WHERE user_id = $1
			 RETURNING id`,
			[userId],
		);

		if (result.rows.length > 0) {
			const pipeline = redisCache.pipeline();
			for (const row of result.rows) {
				pipeline.del(this.getSessionKey(row.id));
			}
			await pipeline.exec();
		}

		return result.rows.length;
	}
}

export const chatService = new ChatService();
