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
import { leadService } from "./leadService";
import { pineconeService } from "./pineconeService";
import {
	buildCtaTargetedQuery,
	classifyCtaIntent,
	CtaIntent,
	getTopKForQuery,
	getCtaQueryMode,
	getCtaTopicTerms,
	isAppointmentBookingIntent,
	normalizeWidgetQuery,
} from "./queryService";
import personaService, {
	WidgetPersonaKey,
} from "./personaService";
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
	declinedFields?: AppointmentLeadField[];
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
		| "declined_field"
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

type CtaSource = {
	url: string;
	title: string;
	relevanceScore: number;
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

type PersonaContext = {
	key: WidgetPersonaKey;
	prompt: string;
	promptHash: string;
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

	private getLastAssistantMessage(
		messages: ChatMessage[],
	): string | null {
		return (
			[...messages]
				.reverse()
				.find((m) => m.role === "assistant")
				?.content ?? null
		);
	}

	private buildLeadCaptureGuardrail(): string {
		return `[BEHAVIORAL RULES — always apply, non-negotiable]:

1. OPTIONAL FIELD DECLINE: If the visitor declines to share an optional field (phone, company, timeline) — accept it immediately with one short acknowledgement, skip the field, and deliver the closing confirmation using the name and email already collected. Never re-ask a declined field.

2. CTA AFFIRMATION: If the visitor responds "yes", "sure", "ok", "please", or any affirmation directly after you offered a demo or booking link — respond ONLY with: "Great! Here's your booking link: [use the exact Book a Demo link from your instructions above]". No new questions, no re-explaining.

3. NO RE-ASKING: Before asking for name, email, phone, or company — check the conversation history above. If the visitor already provided that detail earlier in this conversation, DO NOT ask for it again. Use it and move to the next uncollected field or the closing message.

4. ALWAYS CLOSE: Every response ends with exactly one clear next action — never leave the visitor without a next step.`;
	}

	private hashPersonaPrompt(prompt: string): string {
		return crypto
			.createHash("sha1")
			.update(prompt.trim())
			.digest("hex");
	}

	private buildPersonaOverrideInstruction(
		personaContext?: PersonaContext,
	): string {
		if (!personaContext?.prompt.trim()) {
			return "";
		}
		return [
			"Mandatory selected widget persona instructions:",
			personaContext.prompt.trim(),
			"These persona instructions are binding for every reply. If they conflict with the default website assistant instructions, follow the persona instructions.",
		].join("\n");
	}

	private async resolvePersonaContext(
		userId: string,
	): Promise<PersonaContext> {
		try {
			const key =
				await personaService.getUserPersonaKey(
					userId,
				);
			const prompt =
				await personaService.getPersonaPrompt(key);
			return {
				key,
				prompt,
				promptHash:
					this.hashPersonaPrompt(prompt),
			};
		} catch (error) {
			logger.warn(
				"Chat persona context unavailable; using general persona fallback",
				{
					userId,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
			return {
				key: "general_information",
				prompt: "",
				promptHash:
					this.hashPersonaPrompt(""),
			};
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

	// ─── Session Lead Profile ──────────────────────────────────────────────────
	// Tracks contact fields already collected in this session so the bot never
	// re-asks for information the user has already provided, even if a new
	// appointment intent fires later in the same conversation.

	private getSessionLeadProfileKey(sessionId: string): string {
		return `chat:session-lead:${sessionId}`;
	}

	private async getSessionLeadProfile(
		sessionId: string,
	): Promise<Partial<Record<AppointmentLeadField, string>> | null> {
		const cached = await redisCache.get(
			this.getSessionLeadProfileKey(sessionId),
		);
		if (!cached) return null;
		try {
			return JSON.parse(cached) as Partial<
				Record<AppointmentLeadField, string>
			>;
		} catch {
			return null;
		}
	}

	async saveSessionLeadProfile(
		sessionId: string,
		fields: Partial<Record<AppointmentLeadField, string>>,
	): Promise<void> {
		const existing =
			(await this.getSessionLeadProfile(sessionId)) ?? {};
		const merged: Partial<Record<AppointmentLeadField, string>> = {
			...existing,
		};
		for (const key of ["name", "email", "phone", "country"] as AppointmentLeadField[]) {
			if (fields[key]?.trim()) {
				merged[key] = fields[key];
			}
		}
		await redisCache.setex(
			this.getSessionLeadProfileKey(sessionId),
			60 * 60 * 24,
			JSON.stringify(merged),
		);
	}

	private hasMinimumLeadData(
		profile: Partial<Record<AppointmentLeadField, string>>,
	): boolean {
		return !!(profile.email?.trim() || profile.phone?.trim());
	}
	// ──────────────────────────────────────────────────────────────────────────

	private shouldRunAppointmentIntentClassifier(
		normalizedMessage: string,
		lastAssistantMessage?: string | null,
	): boolean {
		if (!normalizedMessage) {
			return false;
		}

		if (
			lastAssistantMessage &&
			/book\s*a?\s*demo|book\s*a?\s*slot|book\s*a?\s*meeting|schedule\s*a?\s*call|calendly/i.test(
				lastAssistantMessage,
			)
		) {
			return true;
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
		lastAssistantMessage?: string | null,
	): Promise<AppointmentIntentClassification> {
		if (
			!config.OPENAI_API_KEY?.trim() ||
			!this.shouldRunAppointmentIntentClassifier(
				normalizeWidgetQuery(message),
				lastAssistantMessage,
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

		const lastAssistantContext = lastAssistantMessage
			? `Last assistant message: ${lastAssistantMessage}\n\n`
			: "";

		const prompt = `Classify whether the latest visitor message is asking to book or arrange a human follow-up such as an appointment, meeting, demo, consultation, callback, sales conversation, or team call.

Be tolerant of typos, short phrases, and poor grammar.

IMPORTANT: If the last assistant message offered a demo booking link or asked the visitor to schedule a call, and the visitor responds with a short affirmation ("yes", "sure", "ok", "please", etc.), classify this as a positive booking intent with high confidence.

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
- "yes" (when last assistant message offered a demo/booking link)
- "sure" (when last assistant message offered a demo/booking link)

Treat these as negative examples:
- asking for office address, phone number, or email only
- asking what services are offered
- asking for pricing or plans
- general support questions without asking for a meeting/call

${lastAssistantContext}Recent conversation:
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

	private extractLeadFieldsFromHistory(
		messages: ChatMessage[],
	): Partial<Record<AppointmentLeadField, string>> {
		const fields: Partial<
			Record<AppointmentLeadField, string>
		> = {};

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];

			// Pattern-based extraction from user messages
			if (msg.role === "user") {
				const text = msg.content;
				if (!fields.email) {
					const email = this.extractEmailCandidate(text);
					if (email) fields.email = email;
				}
				if (!fields.phone) {
					const phone = this.extractPhoneCandidate(text);
					if (phone) fields.phone = phone;
				}
				if (!fields.name) {
					const name = this.extractNameCandidate(text);
					if (name) fields.name = name;
				}
				if (!fields.country) {
					const country = this.extractCountryCandidate(text);
					if (country) fields.country = country;
				}
			}

			// Context-aware pair: bot asked for a field → next user message is the answer
			if (msg.role === "assistant" && i + 1 < messages.length) {
				const next = messages[i + 1];
				if (next.role !== "user") continue;
				const askedField = this.isLastMessageAskingForLeadField(msg.content);
				if (!askedField) continue;
				const userReply = next.content.trim();
				switch (askedField) {
					case "name":
						if (!fields.name && this.isBasicAppointmentTextFieldValue(userReply)) {
							fields.name = userReply;
						}
						break;
					case "email":
						if (!fields.email) {
							const e = this.extractEmailCandidate(userReply);
							if (e) fields.email = e;
						}
						break;
					case "phone":
						if (!fields.phone) {
							const p = this.extractPhoneCandidate(userReply);
							if (p) fields.phone = p;
						}
						break;
					case "country":
						if (!fields.country && this.isBasicAppointmentTextFieldValue(userReply)) {
							fields.country = userReply;
						}
						break;
				}
			}
		}

		return fields;
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

	private isDeclinationMessage(message: string): boolean {
		const t = message.trim().toLowerCase();
		return /^(no|nope|nah|skip|not now|dont want|don't want|prefer not|no thanks|no thank you|n\/a|none|pass|later|not interested|no need|ignore|leave it|not required|not necessary)\b/.test(t);
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

		// Fast-path: clear declination for optional fields — no LLM call needed
		const optionalFields: AppointmentLeadField[] = ["phone", "country"];
		if (
			optionalFields.includes(expectedField) &&
			this.isDeclinationMessage(trimmed)
		) {
			return { action: "declined_field", confidence: "high" };
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
					parsed.action === "declined_field" ||
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
		const declined = state.declinedFields ?? [];

		for (const field of orderedFields) {
			if (declined.includes(field)) continue;
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

		// Only fill fields that are not already captured — never overwrite.
		if (!nextState.fields.email) {
			const email = this.extractEmailCandidate(message);
			if (email) nextState.fields.email = email;
		}

		if (!nextState.fields.phone) {
			const phone = this.extractPhoneCandidate(message);
			if (phone) nextState.fields.phone = phone;
		}

		if (!nextState.fields.name) {
			const name = this.extractNameCandidate(message);
			if (name) nextState.fields.name = name;
		}

		if (!nextState.fields.country) {
			const country = this.extractCountryCandidate(message);
			if (country) nextState.fields.country = country;
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
					this.extractNameCandidate(trimmed) ||
					// Accept bare names (e.g. "arjun", "John Smith") without
					// requiring a "my name is X" prefix pattern.
					(this.isBasicAppointmentTextFieldValue(trimmed)
						? trimmed
						: null);
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
					this.extractCountryCandidate(trimmed) ||
					// Accept bare country names (e.g. "india", "USA") without
					// requiring a pattern prefix like "i am from X".
					(this.isBasicAppointmentTextFieldValue(trimmed)
						? trimmed
						: null);
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
		allowedSourceUrls: Array<string> = [],
	): string {
		let output = response.trim();
		output =
			this.normalizeOrderedMarkdownLists(output);
		output = this.normalizeCompanyVoice(
			output,
			websiteName,
		);
		output = this.sanitizeLinks(
			output,
			this.buildAllowedUrlSet(allowedSourceUrls),
		);
		return this.finalizeResponseEnding(output);
	}

	private async finalizeAssistantResponse(
		response: string,
		input: {
			userId: string;
			sessionId: string;
			query: string;
			websiteName?: string;
			sources?: CtaSource[];
		},
	): Promise<string> {
		const formatted = this.formatAssistantResponse(
			response,
			input.query,
			input.websiteName,
			(input.sources ?? []).map((source) => source.url),
		);
		return this.appendQueryBasedCta(
			formatted,
			input.userId,
			input.sessionId,
			input.query,
			input.sources ?? [],
		);
	}

	private async appendQueryBasedCta(
		response: string,
		userId: string,
		sessionId: string,
		query: string,
		sources: CtaSource[],
	): Promise<string> {
		if (
			this.isFallbackLikeResponse(response) &&
			!this.responseAlreadyHasCta(
				response,
				"contact",
			)
		) {
			const knownContact =
				await this.getKnownSessionContactChannel(
					userId,
					sessionId,
				);
			if (knownContact) {
				const followUpMessage = `Our team will reach out to you shortly at ${knownContact}.`;
				if (
					!response
						.toLowerCase()
						.includes(
							followUpMessage.toLowerCase(),
						)
				) {
					return this.appendResponseLine(
						response,
						followUpMessage,
					);
				}
				return response;
			}

			const contactUrl = await this.resolveCtaUrl(
				userId,
				query,
				"contact",
				sources,
			);
			if (
				contactUrl &&
				!this.responseAlreadyHasUrl(
					response,
					contactUrl,
				)
			) {
				return this.appendResponseLine(
					response,
					this.buildCtaLine(
						query,
						"contact",
						contactUrl,
					),
				);
			}
		}

		const intent = classifyCtaIntent(query);
		if (!intent) {
			return response;
		}

		if (this.responseAlreadyHasCta(response, intent)) {
			return response;
		}

		if (intent === "contact") {
			if (!this.isFallbackLikeResponse(response)) {
				return response;
			}

			const knownContact =
				await this.getKnownSessionContactChannel(
					userId,
					sessionId,
				);
			if (knownContact) {
				const followUpMessage = `Our team will reach out to you shortly at ${knownContact}.`;
				if (
					response
						.toLowerCase()
						.includes(
							followUpMessage.toLowerCase(),
						)
				) {
					return response;
				}
				return this.appendResponseLine(
					response,
					followUpMessage,
				);
			}
		}

		const ctaUrl = await this.resolveCtaUrl(
			userId,
			query,
			intent,
			sources,
		);
		if (!ctaUrl) {
			return response;
		}

		if (
			this.responseAlreadyHasCta(
				response,
				intent,
				ctaUrl,
			)
		) {
			return response;
		}

		const ctaLine =
			this.buildCtaLine(
				query,
				intent,
				ctaUrl,
			);

		return this.appendResponseLine(response, ctaLine);
	}

	private buildCtaLine(
		query: string,
		intent: CtaIntent,
		url: string,
	): string {
		if (intent === "contact") {
			return `Get in touch: [Contact our team](${url})`;
		}

		if (intent === "case_study") {
			return getCtaQueryMode(query, intent) ===
				"general"
				? `Learn more: [View all case studies](${url})`
				: `Learn more: [View case study](${url})`;
		}

		return getCtaQueryMode(query, intent) ===
			"general"
			? `Read more: [View all blog posts](${url})`
			: `Read more: [Read blog post](${url})`;
	}

	private appendResponseLine(
		response: string,
		line: string,
	): string {
		const trimmedResponse = response.trimEnd();
		const trimmedLine = line.trim();
		if (!trimmedLine) {
			return trimmedResponse;
		}
		return trimmedResponse
			? `${trimmedResponse}\n\n${trimmedLine}`
			: trimmedLine;
	}

	private async getKnownSessionContactChannel(
		userId: string,
		sessionId: string,
	): Promise<string | null> {
		const sessionProfile =
			await this.getSessionLeadProfile(sessionId);
		const cachedContact =
			sessionProfile?.email?.trim() ||
			sessionProfile?.phone?.trim();
		if (cachedContact) {
			return cachedContact;
		}

		try {
			const leadStatus =
				await leadService.getLeadFormStatus(
					userId,
					sessionId,
					{
						email: true,
						phone: true,
					},
				);
			return (
				leadStatus.lead?.email?.trim() ||
				leadStatus.lead?.phone?.trim() ||
				null
			);
		} catch (error) {
			logger.warn(
				"CTA contact channel lookup failed",
				{
					userId,
					sessionId,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
			return null;
		}
	}

	private async resolveCtaUrl(
		userId: string,
		query: string,
		intent: CtaIntent,
		currentSources: CtaSource[],
	): Promise<string | null> {
		const directMatch = this.selectBestCtaSource(
			query,
			intent,
			currentSources,
			{ strictSpecific: true },
		);
		if (directMatch) {
			return directMatch.url;
		}

		try {
			const targetedMatches =
				await pineconeService.queryDocuments(
					userId,
					buildCtaTargetedQuery(
						query,
						intent,
					),
					8,
					{
						history: [],
					},
				);
			const targetedSources =
				this.buildCtaSourcesFromMatches(
					targetedMatches,
				);
			const targetedMatch =
				this.selectBestCtaSource(
					query,
					intent,
					targetedSources,
					{ strictSpecific: true },
				);
			if (targetedMatch) {
				return targetedMatch.url;
			}
		} catch (error) {
			logger.warn("CTA targeted Pinecone query failed", {
				userId,
				intent,
				error:
					error instanceof Error
						? error.message
						: String(error),
			});
		}

		try {
			const storedSources =
				await this.getStoredWebsiteCtaSources(
					userId,
				);
			const storedMatch =
				this.selectBestCtaSource(
					query,
					intent,
					storedSources,
					{ strictSpecific: false },
				);
			return storedMatch?.url ?? null;
		} catch (error) {
			logger.warn(
				"CTA stored-page fallback lookup failed",
				{
					userId,
					intent,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
			return null;
		}
	}

	private async getStoredWebsiteCtaSources(
		userId: string,
	): Promise<CtaSource[]> {
		const allSources =
			await pineconeService.getAllUserSourcesFromDB(
				userId,
			);
		return this.deduplicateCtaSources(
			allSources.websites.flatMap((website) =>
				website.pages.map((page) => ({
					url: page.url,
					title: page.title || page.url,
					relevanceScore: 0,
				})),
			),
		);
	}

	private buildCtaSourcesFromMatches(
		matches: any[],
	): CtaSource[] {
		return this.deduplicateCtaSources(
			matches.map((match) => ({
				url: this.extractMatchUrl(match),
				title:
					this.extractMatchTitle(match) ||
					this.extractMatchUrl(match),
				relevanceScore:
					this.ragMatchScore(match),
			})),
		);
	}

	private deduplicateCtaSources(
		sources: CtaSource[],
	): CtaSource[] {
		const byUrl = new Map<string, CtaSource>();
		for (const source of sources) {
			const url = source.url?.trim();
			if (!url) {
				continue;
			}
			const normalizedUrl =
				this.normalizeUrlForComparison(url);
			const existing = byUrl.get(normalizedUrl);
			if (
				!existing ||
				source.relevanceScore >
					existing.relevanceScore
			) {
				byUrl.set(normalizedUrl, {
					url,
					title:
						source.title?.trim() || url,
					relevanceScore:
						source.relevanceScore || 0,
				});
			}
		}
		return Array.from(byUrl.values());
	}

	private selectBestCtaSource(
		query: string,
		intent: CtaIntent,
		sources: CtaSource[],
		options: {
			strictSpecific: boolean;
		},
	): CtaSource | null {
		const candidates = this.deduplicateCtaSources(
			sources,
		)
			.filter((source) => {
				const inferredIntent =
					this.inferCtaPageIntent(
						source.url,
						source.title,
					);
				if (inferredIntent === intent) {
					return true;
				}

				return (
					intent !== "contact" &&
					this.countCtaTopicMatches(
						query,
						intent,
						source,
					) > 0
				);
			})
			.map((source) => ({
				source,
				score: this.scoreCtaSource(
					query,
					intent,
					source,
				),
				specificMatch:
					intent === "contact"
						? true
						: this.isSpecificCtaCandidate(
								query,
								intent,
								source,
						  ),
			}))
			.sort((a, b) => b.score - a.score);

		if (candidates.length === 0) {
			return null;
		}

		if (intent !== "contact") {
			const mode = getCtaQueryMode(
				query,
				intent,
			);
			if (
				mode === "specific" &&
				options.strictSpecific
			) {
				return (
					candidates.find(
						(candidate) =>
							candidate.specificMatch,
					)?.source ?? null
				);
			}
		}

		return candidates[0]?.source ?? null;
	}

	private scoreCtaSource(
		query: string,
		intent: CtaIntent,
		source: CtaSource,
	): number {
		const combined = normalizeWidgetQuery(
			`${source.title} ${source.url}`,
		);
		const pathDepth = this.getUrlPathSegments(
			source.url,
		).length;
		let score = source.relevanceScore || 0;

		if (intent === "contact") {
			if (
				/\b(contact|reach|get in touch|sales|talk|speak)\b/.test(
					combined,
				)
			) {
				score += 20;
			}
			return score;
		}

		const mode = getCtaQueryMode(query, intent);
		const topicMatches = this.countCtaTopicMatches(
			query,
			intent,
			source,
		);
		const titleTopicMatches =
			this.countCtaTitleTopicMatches(
				query,
				intent,
				source,
			);
		const isOverview = this.isOverviewCtaPage(
			intent,
			source.url,
			source.title,
		);

		if (mode === "general") {
			score += isOverview ? 15 : 2;
			score += pathDepth <= 2 ? 3 : 0;
		} else {
			score += isOverview ? -8 : 10;
			score += topicMatches * 8;
			score += titleTopicMatches * 12;
			score +=
				titleTopicMatches > 0 &&
				titleTopicMatches ===
					getCtaTopicTerms(query, intent).length
					? 15
					: 0;
			score += pathDepth > 1 ? 2 : 0;
		}

		return score;
	}

	private countCtaTopicMatches(
		query: string,
		intent: Exclude<CtaIntent, "contact">,
		source: CtaSource,
	): number {
		const haystack = normalizeWidgetQuery(
			`${source.title} ${source.url}`,
		);
		return getCtaTopicTerms(query, intent).reduce(
			(count, term) =>
				count + (haystack.includes(term) ? 1 : 0),
			0,
		);
	}

	private countCtaTitleTopicMatches(
		query: string,
		intent: Exclude<CtaIntent, "contact">,
		source: CtaSource,
	): number {
		const haystack = normalizeWidgetQuery(
			source.title,
		);
		return getCtaTopicTerms(query, intent).reduce(
			(count, term) =>
				count + (haystack.includes(term) ? 1 : 0),
			0,
		);
	}

	private isSpecificCtaCandidate(
		query: string,
		intent: Exclude<CtaIntent, "contact">,
		source: CtaSource,
	): boolean {
		if (
			this.isOverviewCtaPage(
				intent,
				source.url,
				source.title,
			)
		) {
			return false;
		}

		const topicTerms = getCtaTopicTerms(
			query,
			intent,
		);
		if (topicTerms.length === 0) {
			return true;
		}

		return (
			this.countCtaTopicMatches(
				query,
				intent,
				source,
			) > 0
		);
	}

	private inferCtaPageIntent(
		url: string,
		title: string,
	): CtaIntent | null {
		const combined = normalizeWidgetQuery(
			`${title} ${url}`,
		);
		if (
			/\b(contact|get in touch|reach|talk to|speak to|sales)\b/.test(
				combined,
			)
		) {
			return "contact";
		}
		if (
			/\b(blog|article|guide|insight|resource|news|post)\b/.test(
				combined,
			)
		) {
			return "blog";
		}
		if (
			/\b(case stud(?:y|ies)|portfolio|our work|client work|project|showcase|success stor(?:y|ies))\b/.test(
				combined,
			)
		) {
			return "case_study";
		}
		return null;
	}

	private isOverviewCtaPage(
		intent: Exclude<CtaIntent, "contact">,
		url: string,
		title: string,
	): boolean {
		const combined = normalizeWidgetQuery(
			`${title} ${url}`,
		);
		const pathSegments =
			this.getUrlPathSegments(url);
		const lastSegment =
			pathSegments[pathSegments.length - 1] || "";

		if (intent === "case_study") {
			return (
				[
					"case-study",
					"case-studies",
					"portfolio",
					"work",
					"projects",
					"showcase",
				].includes(lastSegment) ||
				(pathSegments.length <= 2 &&
					/\b(case stud(?:y|ies)|portfolio|our work|client work|projects?|showcase)\b/.test(
						combined,
					))
			);
		}

		return (
			[
				"blog",
				"blogs",
				"articles",
				"resources",
				"guides",
				"insights",
				"news",
			].includes(lastSegment) ||
			(pathSegments.length <= 2 &&
				/\b(blog|articles?|guides?|resources?|insights?|news)\b/.test(
					combined,
				))
		);
	}

	private getUrlPathSegments(url: string): string[] {
		try {
			return new URL(url).pathname
				.toLowerCase()
				.split("/")
				.map((segment) => segment.trim())
				.filter(Boolean);
		} catch {
			return url
				.toLowerCase()
				.split(/[/?#]/)
				.map((segment) => segment.trim())
				.filter(Boolean);
		}
	}

	private responseAlreadyHasCta(
		response: string,
		intent: CtaIntent,
		url?: string,
	): boolean {
		const lower = response.toLowerCase();
		if (url && this.responseAlreadyHasUrl(response, url)) {
			return true;
		}

		if (intent === "contact") {
			return /get in touch:\s*\[contact our team\]|contact(?: our)? team|reach out(?: to (?:us|our team))?|talk to(?: our)? team|speak to(?: our)? team/.test(
				lower,
			);
		}
		if (intent === "case_study") {
			return /learn more:\s*\[(?:view all case studies|view case study)\]|(?:view|see|browse|explore|check out)(?: all| our)? (?:case studies|portfolio|work|projects)|view case study/.test(
				lower,
			);
		}
		return /read more:\s*\[(?:view all blog posts|read blog post)\]|(?:explore|browse|read|see|check out|view)(?: all| our)? (?:blog|blogs|blog posts|articles|resources|guides|insights)|read blog post/.test(
			lower,
		);
	}

	private responseAlreadyHasUrl(
		response: string,
		url: string,
	): boolean {
		const normalizedTarget =
			this.normalizeUrlForComparison(url);
		return this.extractUrlsFromText(response).some(
			(existingUrl) =>
				this.normalizeUrlForComparison(
					existingUrl,
				) === normalizedTarget,
		);
	}

	private extractUrlsFromText(
		text: string,
	): string[] {
		const urls = new Set<string>();
		const markdownMatches = text.matchAll(
			/\[[^\]]+\]\((https?:\/\/[^\s)]+?)(?:\s+"[^"]*")?\)/g,
		);
		for (const match of markdownMatches) {
			if (match[1]) {
				urls.add(match[1]);
			}
		}
		const bareMatches = text.matchAll(
			/https?:\/\/[^\s<>"'()]+/g,
		);
		for (const match of bareMatches) {
			if (match[0]) {
				urls.add(match[0]);
			}
		}
		return Array.from(urls);
	}

	private isFallbackLikeResponse(
		response: string,
	): boolean {
		const normalized = normalizeWidgetQuery(
			response,
		);
		return [
			"i don't have information about that",
			"i do not have information about that",
			"i'm not sure",
			"im not sure",
			"i am not sure",
			"i'm here to help with information available on our website",
			"i am here to help with information available on our website",
			"information available on our website",
			"details not listed",
			"not listed on the website",
			"assist you directly",
			"our team would be happy to assist you directly",
			"i'm still learning this site",
			"i am still learning this site",
			"please contact support",
			"i don't know",
			"i do not know",
			"i couldn't find",
			"i could not find",
			"i can't find",
			"i cannot find",
			"not available in the knowledge base",
		].some((phrase) =>
			normalized.includes(phrase),
		);
	}

	// URL normalization for comparing a URL the model wrote against the
	// URLs in our retrieved sources. We match on protocol + host + path,
	// stripping trailing slash and fragment so tiny formatting differences
	// don't cause a valid link to get stripped.
	private normalizeUrlForComparison(raw: string): string {
		try {
			const u = new URL(raw.trim());
			let pathname = u.pathname;
			if (pathname.length > 1 && pathname.endsWith("/")) {
				pathname = pathname.slice(0, -1);
			}
			return `${u.protocol}//${u.host.toLowerCase()}${pathname}${u.search}`;
		} catch {
			return raw.trim().toLowerCase();
		}
	}

	private buildAllowedUrlSet(
		sourceUrls: Array<string>,
	): Set<string> {
		const set = new Set<string>();
		for (const url of sourceUrls) {
			const trimmed = (url || "").trim();
			if (!trimmed) continue;
			set.add(
				this.normalizeUrlForComparison(trimmed),
			);
		}
		return set;
	}

	// Post-process the LLM response to remove any URL it invented. We keep
	// markdown link text but drop the URL when the href isn't in the
	// retrieved-sources allow-list. Bare URLs in running text are stripped
	// entirely if not allowed. This is the safety net behind the prompt
	// instructions in PLATFORM_DEFAULT_SYSTEM_MESSAGE_TEMPLATE.
	private sanitizeLinks(
		text: string,
		allowedUrls: Set<string>,
	): string {
		if (!text) return text;
		let output = text;

		// Step 1: handle markdown links of the form [label](url) or
		// [label](url "title"). If the URL is allowed, keep the link as-is.
		// Otherwise collapse to just the visible label so we don't lose copy.
		output = output.replace(
			/\[([^\]]+)\]\((https?:\/\/[^\s)]+?)(?:\s+"[^"]*")?\)/g,
			(_match, linkText: string, url: string) => {
				const normalized =
					this.normalizeUrlForComparison(url);
				if (allowedUrls.has(normalized)) {
					return `[${linkText}](${url})`;
				}
				logger.warn(
					"chat: stripped hallucinated markdown link",
					{ url },
				);
				return linkText;
			},
		);

		// Step 2: handle bare URLs in running text. The negative lookbehind
		// `(?<!\()` skips URLs that are inside surviving markdown link
		// parentheses, so we don't double-process allowed links.
		output = output.replace(
			/(?<!\()https?:\/\/[^\s<>"'()\]]+/g,
			(match) => {
				const normalized =
					this.normalizeUrlForComparison(match);
				if (allowedUrls.has(normalized)) {
					return match;
				}
				logger.warn(
					"chat: stripped hallucinated bare url",
					{ url: match },
				);
				return "";
			},
		);

		// Clean up leftover "Learn more:" lines that lost their URL during
		// sanitization, plus dangling whitespace.
		output = output
			.replace(
				/^[ \t]*(?:👉\s*)?Learn more:[ \t]*\[?[ \t]*\]?[ \t]*\(?[ \t]*\)?[ \t]*$/gim,
				"",
			)
			.replace(/[ \t]+$/gm, "")
			.replace(/\n{3,}/g, "\n\n");

		return output;
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
		return /\b(hi|hello|hey|good morning|good afternoon|good evening|good night|thanks|thank you|bye|goodbye|see you|cheers|ok|okay|sure|great|awesome|perfect|got it|noted)\b/.test(
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
			widgetKeyId: conversation.widget_key_id,
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

	private buildCollectedLeadContext(
		profile: Partial<Record<AppointmentLeadField, string>>,
	): string {
		const parts: string[] = [];
		if (profile.name) parts.push(`Name: ${profile.name}`);
		if (profile.email) parts.push(`Email: ${profile.email}`);
		if (profile.phone) parts.push(`Phone: ${profile.phone}`);
		if (profile.country) parts.push(`Country: ${profile.country}`);
		if (!parts.length) return "";
		return `VISITOR DETAILS ALREADY COLLECTED — do NOT ask for any of these again:\n${parts.join(", ")}`;
	}

	private async buildChatMessages(
		userId: string,
		query: string,
		matches: any[],
		messages: ChatMessage[],
		_languageCode?: string,
		personaContext?: PersonaContext,
		sessionId?: string,
	): Promise<Array<any>> {
		const [effectiveSystemMessage, sessionProfile] =
			await Promise.all([
				systemMessageService.resolveEffectiveSystemMessage(userId),
				sessionId
					? this.getSessionLeadProfile(sessionId)
					: Promise.resolve(null),
			]);

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

		const baseSystemPrompt =
			effectiveSystemMessage.trim() ||
			this.defaultGeneratedSystemPrompt();
		const collectedContext =
			sessionProfile && this.hasMinimumLeadData(sessionProfile)
				? this.buildCollectedLeadContext(sessionProfile)
				: "";
		const systemPrompt = [
			baseSystemPrompt,
			this.buildLeadCaptureGuardrail(),
			collectedContext,
		].filter(Boolean).join("\n\n");
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
		const personaOverride =
			this.buildPersonaOverrideInstruction(
				personaContext,
			);
		if (personaOverride) {
			conversationHistory.push({
				role: "system",
				content: personaOverride,
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

	private async generatePersonaAwareFallbackResponse(
		userId: string,
		query: string,
		fallbackResponse: string,
		history: ChatMessage[],
		languageCode: string | undefined,
		personaContext: PersonaContext,
	): Promise<{
		response: string;
		usage?: CompletionUsage;
	} | null> {
		if (
			!config.OPENAI_API_KEY?.trim() ||
			!personaContext.prompt.trim()
		) {
			return null;
		}

		try {
			const systemPrompt =
				await systemMessageService.resolveEffectiveSystemMessage(
					userId,
				);
			const languageInstruction =
				this.buildLanguageInstruction(languageCode);
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
			const personaOverride =
				this.buildPersonaOverrideInstruction(
					personaContext,
				);
			if (personaOverride) {
				conversationHistory.push({
					role: "system",
					content: personaOverride,
				});
			}
			for (const msg of history.slice(
				-CHAT_HISTORY_WINDOW_MESSAGES,
			)) {
				conversationHistory.push({
					role: msg.role,
					content: msg.content,
				});
			}
			conversationHistory.push({
				role: "user",
				content: [
					`Visitor message: ${query}`,
					`The normal fallback response would be: ${fallbackResponse}`,
					"Reply to the visitor while strictly following the selected persona instructions. Do not ignore the persona just because knowledge-base retrieval had no matching result.",
				].join("\n\n"),
			});

			return await this.generateNonStreamingResponse(
				conversationHistory,
				CHAT_DEFAULT_TIMEOUT_MS,
			);
		} catch (error) {
			logger.warn(
				"Persona-aware fallback generation failed; using default fallback",
				{
					userId,
					personaKey: personaContext.key,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
			return null;
		}
	}

	private async resolveAgenticDecision(
		userId: string,
		query: string,
		history: ChatMessage[],
		languageCode?: string,
		personaContext?: PersonaContext,
		sessionId?: string,
	): Promise<AgenticDecision> {
		if (!config.OPENAI_API_KEY?.trim()) {
			return { mode: "search", query };
		}

		const [websiteName, effectiveSystemMessage, sessionProfile] =
			await Promise.all([
				websiteBrandingService.resolveUserWebsiteName(
					userId,
				),
				systemMessageService.resolveEffectiveSystemMessage(
					userId,
				),
				sessionId
					? this.getSessionLeadProfile(sessionId)
					: Promise.resolve(null),
			]);

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
						"Search the website knowledge base before answering questions about the company, its services, pricing, contact details, team, projects, policies, or any factual business content. Do NOT use for greetings, personal introductions, or social pleasantries.",
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
						"Respond directly (without searching) for: greetings ('hi', 'hello', 'hey'), farewells, personal introductions ('I am John', 'my name is...', 'I\\'m Vivek', 'call me...'), thank-you messages, acknowledgements ('ok', 'got it', 'sure'), small talk, or any message that does not need website knowledge. When the user introduces themselves by name, warmly acknowledge their name in your reply.",
					parameters: {
						type: "object",
						properties: {
							message: {
								type: "string",
								description:
									"Short, warm, direct response to the user.",
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
										content: [
											`You are a routing agent for ${websiteName}'s support widget. Choose exactly one tool.`,
											`Use respond_to_user for: greetings, farewells, personal introductions (e.g. "I am John", "my name is...", "I'm Vivek"), thank-you messages, acknowledgements, or any social exchange that doesn't need company knowledge.`,
											`Use search_knowledge_base for questions about the company, services, pricing, contact info, team, policies, or any factual business question.`,
											"CRITICAL: Personal introductions (user sharing their name or personal info) MUST use respond_to_user — never search the knowledge base for them.",
											"CRITICAL: Email addresses and phone numbers are personal contact information — even if an email contains a company domain (e.g. john@company.com), treat it as personal info and use respond_to_user, never search_knowledge_base.",
											"CRITICAL: If the previous assistant message was asking the user for their name, email, phone number, or other personal details, and the user's message is providing that information, ALWAYS use respond_to_user.",
											"When responding directly, be warm and natural, and follow the widget persona instructions.",
										].join(" "),
									},
									...(effectiveSystemMessage?.trim()
										? [
												{
													role: "system" as const,
													content: [
														`Widget persona and behavioral rules (apply these when generating a direct response):\n${effectiveSystemMessage.trim()}`,
														this.buildLeadCaptureGuardrail(),
														sessionProfile && this.hasMinimumLeadData(sessionProfile)
															? this.buildCollectedLeadContext(sessionProfile)
															: "",
													].filter(Boolean).join("\n\n"),
												},
											]
										: []),
									...(personaContext?.prompt.trim()
										? [
												{
													role: "system" as const,
													content:
														this.buildPersonaOverrideInstruction(
															personaContext,
														),
												},
											]
										: []),
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
								max_tokens: 200,
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
		const personaContext =
			await this.resolvePersonaContext(userId);
		const syntheticSessionId = `adhoc:${crypto
			.createHash("sha1")
			.update(`${userId}:${message}`)
			.digest("hex")}`;
		const decision =
			await this.resolveAgenticDecision(
				userId,
				message,
				[],
				resolvedLanguage,
				personaContext,
				syntheticSessionId,
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
						personaContext,
						syntheticSessionId,
					),
					CHAT_DEFAULT_TIMEOUT_MS,
				);
			answer =
				completion.response || fallbackResponse;
		}
		if (!shouldCallLlm) {
			const personaFallback =
				await this.generatePersonaAwareFallbackResponse(
					userId,
					message,
					fallbackResponse,
					[],
					resolvedLanguage,
					personaContext,
				);
			if (personaFallback?.response?.trim()) {
				answer = personaFallback.response;
			}
		}

		const websiteName =
			await websiteBrandingService.resolveUserWebsiteName(
				userId,
			);
		answer = await this.finalizeAssistantResponse(
			answer,
			{
				userId,
				sessionId: syntheticSessionId,
				query: message,
				websiteName,
				sources,
			},
		);
		return {
			answer,
			language: resolvedLanguage,
			sources,
			matches: relevantMatches,
		};
	}

	private isLastMessageAskingForLeadField(
		lastMessage: string,
	): AppointmentLeadField | null {
		const lower = lastMessage.toLowerCase();
		if (
			lower.includes("email") ||
			lower.includes("e-mail")
		)
			return "email";
		if (
			lower.includes("phone") ||
			lower.includes("mobile") ||
			lower.includes("number") ||
			lower.includes("contact")
		)
			return "phone";
		if (
			lower.includes("your name") ||
			lower.includes("full name") ||
			lower.includes("may i have your name") ||
			lower.includes("what's your name") ||
			lower.includes("whats your name")
		)
			return "name";
		if (
			lower.includes("country") ||
			lower.includes("based in") ||
			lower.includes("location")
		)
			return "country";
		return null;
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
		const lastAssistantMessage =
			this.getLastAssistantMessage(session.messages);
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
					lastAssistantMessage,
				);
			timing.llmMs +=
				Date.now() - classifierStart;
		}

		// Detect LLM-driven lead collection: the bot (via custom system prompt)
		// already asked for a lead field and the user is now providing it, but
		// the state machine was never activated.  Bridge the gap so we capture
		// the data and avoid re-asking.
		const llmLeadBridgeAskedField = lastAssistantMessage != null
			? this.isLastMessageAskingForLeadField(lastAssistantMessage)
			: null;
		const llmLeadBridge =
			!existingState?.active &&
			!regexMatchedIntent &&
			!classifiedIntent.isAppointmentIntent &&
			llmLeadBridgeAskedField != null &&
			(this.extractEmailCandidate(normalizedMessage) != null ||
				this.extractPhoneCandidate(normalizedMessage) != null ||
				this.extractNameCandidate(normalizedMessage) != null ||
				this.extractCountryCandidate(normalizedMessage) != null ||
				// bare name or country — accepted when bot asked for that exact field
				((llmLeadBridgeAskedField === "name" || llmLeadBridgeAskedField === "country") &&
					this.isBasicAppointmentTextFieldValue(normalizedMessage)));

		const isActive =
			Boolean(existingState?.active) ||
			regexMatchedIntent ||
			llmLeadBridge ||
			(classifiedIntent.isAppointmentIntent &&
				classifiedIntent.confidence !== "low");

		if (!isActive) {
			return null;
		}

		// ── Session lead profile check ─────────────────────────────────────────
		// If the user already provided contact details earlier in this session,
		// skip collection entirely and confirm with the known details.
		if (!existingState?.active) {
			const sessionProfile = await this.getSessionLeadProfile(
				session.sessionId,
			);
			if (
				sessionProfile &&
				this.hasMinimumLeadData(sessionProfile)
			) {
				const namePart = sessionProfile.name
					? `, ${sessionProfile.name}`
					: "";
				const contactPart =
					sessionProfile.email || sessionProfile.phone
						? ` Our team will reach out to you at ${sessionProfile.email || sessionProfile.phone}.`
						: "";
				const response = `Great${namePart}! Our team already has your details and will be in touch shortly.${contactPart}`;
				const saveStart = Date.now();
				const userTs = await this.persistMessage(
					session.sessionId,
					userId,
					"user",
					message,
					{ language: resolvedLanguage, appointmentLeadCapture: true },
				);
				session.messages.push({
					role: "user",
					content: message,
					timestamp: userTs,
				});
				const assistantTs = await this.persistMessage(
					session.sessionId,
					userId,
					"assistant",
					response,
					{
						language: resolvedLanguage,
						appointmentLeadCapture: true,
						leadCaptureCompleted: true,
					},
				);
				session.messages.push({
					role: "assistant",
					content: response,
					timestamp: assistantTs,
				});
				session.updatedAt = assistantTs;
				await this.saveCachedSession(session);
				input.onToken?.(response);
				timing.saveMs = Date.now() - saveStart;
				timing.totalMs = Date.now() - startedAt;
				logger.info("lead: skipped re-collection via session lead profile", {
					userId,
					sessionId: session.sessionId,
				});
				return {
					sessionId: session.sessionId,
					response,
					language: resolvedLanguage,
					sources: [],
					timing,
				};
			}
		}
		// ──────────────────────────────────────────────────────────────────────

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
				fields: this.extractLeadFieldsFromHistory(
					session.messages,
				),
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

		// If the visitor already submitted the lead-capture form, skip the
		// conversational field collection entirely and confirm the request.
		const existingFormLead = await leadService.getLeadFormStatus(
			userId,
			session.sessionId,
			{ name: true, email: true, phone: true, country: true },
		);
		if (existingFormLead.completed && existingFormLead.lead) {
			const lead = existingFormLead.lead;
			// Warm the session lead profile cache so subsequent triggers skip
			// the DB round-trip entirely.
			this.saveSessionLeadProfile(session.sessionId, {
				name: lead.name ?? undefined,
				email: lead.email ?? undefined,
				phone: lead.phone ?? undefined,
				country: lead.country ?? undefined,
			}).catch(() => {});
			const namePart = lead.name ? `, ${lead.name}` : "";
			const contactPart = lead.email || lead.phone
				? ` We'll reach out to you at ${lead.email || lead.phone}.`
				: "";
			const response = `Thank you${namePart}! Our team will connect with you shortly.${contactPart}`;
			await this.clearAppointmentLeadState(session.sessionId);
			const assistantTimestamp = await this.persistMessage(
				session.sessionId,
				userId,
				"assistant",
				response,
				{ language: resolvedLanguage, appointmentLeadCapture: true, leadCaptureCompleted: true },
			);
			session.messages.push({ role: "assistant", content: response, timestamp: assistantTimestamp });
			session.updatedAt = assistantTimestamp;
			await this.saveCachedSession(session);
			input.onToken?.(response);
			timing.saveMs = Date.now() - saveStart;
			timing.totalMs = Date.now() - startedAt;
			return {
				sessionId: session.sessionId,
				response,
				language: resolvedLanguage,
				sources: [],
				timing,
			};
		}

		let response = "";
		if (existingState?.active) {
			const expectedField =
				this.getNextAppointmentLeadField(
					existingState,
				);
			if (expectedField) {
				// Handle explicit declination of optional fields
				if (
					leadTurnClassification?.action ===
						"declined_field"
				) {
					state = {
						...state,
						declinedFields: [
							...(state.declinedFields ?? []),
							expectedField,
						],
					};
				} else {
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

		// Always keep the session lead profile up-to-date so subsequent
		// appointment intents in the same session skip re-collection.
		if (state.fields.email || state.fields.phone) {
			this.saveSessionLeadProfile(
				session.sessionId,
				state.fields,
			).catch((err: Error) =>
				logger.warn("Failed to save session lead profile", {
					userId,
					sessionId: session.sessionId,
					error: err.message,
				}),
			);
		}

		// Persist conversationally-collected fields to the leads table so the
		// UI lead-capture form does not pop up for data already given in chat.
		if (session.widgetKeyId != null) {
			const f = state.fields;
			if (f.name || f.email || f.phone || f.country) {
				leadService
					.saveContactFormLead(
						userId,
						session.sessionId,
						session.widgetKeyId,
						{
							name: f.name ?? null,
							email: f.email ?? null,
							phone: f.phone ?? null,
							country: f.country ?? null,
						},
					)
					.catch((err: Error) => {
						logger.warn(
							"Failed to persist appointment lead fields to leads table",
							{
								userId,
								sessionId: session.sessionId,
								error: err.message,
							},
						);
					});
			}
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
			const personaContext =
				await this.resolvePersonaContext(userId);
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

			const retrievalStart = Date.now();
			const decision =
				await this.resolveAgenticDecision(
					userId,
					message,
					historyMessages,
					resolvedLanguage,
					personaContext,
					session.sessionId,
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
							personaContext,
							session.sessionId,
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
			if (usedFallback) {
				const personaFallback =
					await this.generatePersonaAwareFallbackResponse(
						userId,
						message,
						assistantResponse || fallbackResponse,
						historyMessages,
						resolvedLanguage,
						personaContext,
					);
				if (personaFallback?.response?.trim()) {
					assistantResponse =
						personaFallback.response;
					usage = personaFallback.usage;
					usedFallback = false;
				}
			}
			const websiteName =
				await websiteBrandingService.resolveUserWebsiteName(
					userId,
				);
			assistantResponse =
				await this.finalizeAssistantResponse(
					assistantResponse,
					{
						userId,
						sessionId: session.sessionId,
						query: message,
						websiteName,
						sources,
					},
				);
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
		const personaContext =
			await this.resolvePersonaContext(userId);

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

		const retrievalStart = Date.now();
		const decision =
			await this.resolveAgenticDecision(
				userId,
				message,
				historyMessages,
				resolvedLanguage,
				personaContext,
				session.sessionId,
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
						personaContext,
						session.sessionId,
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
		if (usedFallback) {
			const personaFallback =
				await this.generatePersonaAwareFallbackResponse(
					userId,
					message,
					assistantResponse || fallbackResponse,
					historyMessages,
					resolvedLanguage,
					personaContext,
				);
			if (personaFallback?.response?.trim()) {
				assistantResponse =
					personaFallback.response;
				usage = personaFallback.usage;
				usedFallback = false;
				options?.onToken?.(assistantResponse);
			}
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
		const streamedAssistantResponse =
			assistantResponse;
		assistantResponse =
			await this.finalizeAssistantResponse(
				assistantResponse,
				{
					userId,
					sessionId: session.sessionId,
					query: message,
					websiteName,
					sources,
				},
			);
		const streamedTrimmed =
			streamedAssistantResponse.trimEnd();
		if (
			assistantResponse !==
				streamedAssistantResponse &&
			streamedTrimmed &&
			assistantResponse.startsWith(streamedTrimmed)
		) {
			const postProcessDelta =
				assistantResponse.slice(
					streamedTrimmed.length,
				);
			if (postProcessDelta) {
				options?.onToken?.(postProcessDelta);
			}
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
			widgetKeyId: conversation.widget_key_id,
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

	async getLatestAssistantMessageMeta(
		sessionId: string,
		userId: string,
	): Promise<{
		messageId: number;
		timestamp: Date;
	} | null> {
		const normalized =
			this.normalizeSessionId(sessionId);
		if (!normalized) {
			return null;
		}

		const result = await pool.query<{
			id: string;
			created_at: Date;
		}>(
			`SELECT id, created_at
			 FROM chat_messages
			 WHERE conversation_id = $1
			   AND user_id = $2
			   AND role = 'assistant'
			 ORDER BY created_at DESC, id DESC
			 LIMIT 1`,
			[normalized, userId],
		);

		const row = result.rows[0];
		if (!row) {
			return null;
		}

		return {
			messageId: Number(row.id),
			timestamp: row.created_at,
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

		// Keep Redis session cache in sync so subsequent requests within the
		// same session can read widgetKeyId without a DB round-trip.
		if (widgetKeyId != null) {
			const cached = await this.getCachedSession(normalized);
			if (cached && cached.widgetKeyId == null) {
				cached.widgetKeyId = widgetKeyId;
				await this.saveCachedSession(cached);
			}
		}
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
			customerName?: string | null;
			customerEmail?: string | null;
			customerPhone?: string | null;
			customerCountry?: string | null;
		}>
	> {
		const result = await pool.query<{
			id: string;
			message_count: number;
			created_at: Date;
			updated_at: Date;
			last_message_preview: string | null;
			last_message_at: Date;
			lead_name: string | null;
			lead_email: string | null;
			lead_phone: string | null;
			lead_country: string | null;
		}>(
			`SELECT
			   c.id,
			   c.message_count,
			   c.created_at,
			   c.updated_at,
			   c.last_message_preview,
			   c.last_message_at,
			   l.name    AS lead_name,
			   l.email   AS lead_email,
			   l.phone   AS lead_phone,
			   l.country AS lead_country
			 FROM chat_conversations c
			 LEFT JOIN leads l ON l.session_id = c.id::text AND l.user_id = c.user_id
			 WHERE c.user_id = $1 AND c.is_deleted = FALSE
			 ORDER BY c.last_message_at DESC`,
			[userId],
		);

		return result.rows.map((row) => ({
			sessionId: row.id,
			messageCount: row.message_count,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			lastMessage: row.last_message_preview,
			customerName: row.lead_name,
			customerEmail: row.lead_email,
			customerPhone: row.lead_phone,
			customerCountry: row.lead_country,
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
