import crypto from "crypto";
import OpenAI from "openai";
import pool from "../config/database";
import { config } from "../config/env";
import { memCache } from "../utils/memCache";
import {
	CHAT_COMPLETION_MAX_TOKENS,
	CHAT_COMPLETION_MODEL,
	CHAT_COMPLETION_TEMPERATURE,
	CHAT_DEFAULT_TIMEOUT_MS,
	CHAT_HISTORY_WINDOW_MESSAGES,
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
import {
	endTrace,
	recordGeneration,
	startChatTrace,
} from "../utils/langfuseTracer";
import logger from "../utils/logger";
import { retryOnRateLimit } from "../utils/retry";
import { memorySummarizationService } from "./memorySummarizationService";
import { QueryIntent } from "./queryTransformService";
import { queryTransformService } from "./queryTransformService";
import {
	ragPipelineService,
	RagConversationContext,
	WorkspaceBoundary,
} from "./ragPipelineService";
import systemMessageService from "./systemMessageService";
import websiteBrandingService from "./websiteBrandingService";

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

	private isGpt5FamilyModel(
		model: string,
	): boolean {
		return /^gpt-5(?:$|-)/i.test(model.trim());
	}

	private buildChatCompletionRequest(
		messages: Array<any>,
		options?: {
			stream?: boolean;
		},
	): any {
		const payload: Record<string, unknown> = {
			model: CHAT_COMPLETION_MODEL,
			messages,
			max_tokens: CHAT_COMPLETION_MAX_TOKENS,
		};
		if (!this.isGpt5FamilyModel(CHAT_COMPLETION_MODEL)) {
			payload.temperature = CHAT_COMPLETION_TEMPERATURE;
		}
		if (options?.stream) {
			payload.stream = true;
			payload.stream_options = {
				include_usage: true,
			};
		}
		return payload;
	}

	private mapWorkspaceBoundary(
		workspaceMode:
			| "workspace_only"
			| "workspace_prefer",
	): WorkspaceBoundary {
		return workspaceMode === "workspace_only"
			? "workspace_only"
			: "general_allowed";
	}

	private async resolveRagSettings(
		userId: string,
	): Promise<{
		systemPrompt: string;
		workspaceBoundary: WorkspaceBoundary;
	}> {
		const settings = await systemMessageService
			.getSettings(userId)
			.catch(async () => ({
				effectiveSystemMessage:
					await systemMessageService.resolveEffectiveSystemMessage(
						userId,
					),
				workspaceMode:
					"workspace_prefer" as const,
			}));

		return {
			systemPrompt:
				settings.effectiveSystemMessage,
			workspaceBoundary:
				this.mapWorkspaceBoundary(
					settings.workspaceMode ??
						"workspace_prefer",
				),
		};
	}

	private buildRagConversationMessages(
		systemPrompt: string,
		prompt: string,
		messages: ChatMessage[],
	): Array<any> {
		const conversationHistory: Array<any> = [];

		if (systemPrompt.trim()) {
			conversationHistory.push({
				role: "system",
				content: systemPrompt,
			});
		}

		const recentMessages = messages
			.slice(-CHAT_HISTORY_WINDOW_MESSAGES)
			.map((message) => ({
				role: message.role,
				content: message.content,
			}));

		conversationHistory.push(...recentMessages);
		conversationHistory.push({
			role: "user",
			content: prompt,
		});

		return conversationHistory;
	}

	private async buildRagConversationContext(
		sessionId: string,
		messages: ChatMessage[],
	): Promise<RagConversationContext> {
		const historyMessages = messages.slice(0, -1);
		const recentUserQuestions = historyMessages
			.filter((message) => message.role === "user")
			.slice(-20)
			.map((message) => message.content)
			.filter((content) => content.trim());
		const recentAssistantReplies = historyMessages
			.filter(
				(message) => message.role === "assistant",
			)
			.slice(-10)
			.map((message) => message.content)
			.filter((content) => content.trim());

		let conversationSummary = "";
		if (historyMessages.length > 0) {
			const memory =
				await memorySummarizationService.buildMemory(
					sessionId,
					historyMessages,
				);
			conversationSummary = memory.summary;
		}

		return {
			recentUserQuestions,
			recentAssistantReplies,
			conversationSummary,
		};
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
		const data = memCache.get(
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
		memCache.setex(
			this.getSessionKey(session.sessionId),
			CHAT_SESSION_CACHE_TTL_SECONDS,
			JSON.stringify(payload),
		);
	}

	private getFallbackResponse(): string {
		return "I'm sorry, I'm facing a temporary delay. Please try again in a moment.";
	}

	private getWebsiteReference(
		websiteName: string,
	): string {
		const normalized = websiteName.trim();
		if (
			!normalized ||
			normalized.toLowerCase() === "this website"
		) {
			return "this website";
		}
		if (/\bwebsite\b/i.test(normalized)) {
			return normalized;
		}
		return `the ${normalized} website`;
	}

	private async resolveWebsiteName(
		userId: string,
		sources: Array<{
			url: string;
			title: string;
			relevanceScore: number;
		}>,
	): Promise<string> {
		for (const source of sources) {
			const fromSource =
				websiteBrandingService.extractBrandFromUrl(
					source.url,
				);
			if (fromSource) {
				return fromSource;
			}
		}

		return websiteBrandingService.resolveUserWebsiteName(
			userId,
		);
	}

	private stripFormulaicPreface(
		text: string,
		intent: QueryIntent,
	): string {
		const trimmed = text.trim();
		if (!trimmed) return trimmed;
		if (
			intent === "complex" ||
			intent === "explanation"
		) {
			return trimmed;
		}
		return trimmed.replace(
			/^(?:based on the available (?:data|information|context)|according to the available (?:data|information|context)|from the available (?:data|information|context))[:,]?\s*/i,
			"",
		);
	}

	private toFirstPersonVerb(
		verb: string,
	): string {
		switch (verb.toLowerCase()) {
			case "offers":
				return "offer";
			case "provides":
				return "provide";
			case "delivers":
				return "deliver";
			case "shares":
				return "share";
			case "supports":
				return "support";
			case "includes":
				return "include";
			case "covers":
				return "cover";
			case "has":
				return "have";
			case "is":
				return "are";
			case "specializes in":
				return "specialize in";
			default:
				return verb.toLowerCase();
		}
	}

	private normalizeBusinessVoice(
		text: string,
		websiteName: string,
	): string {
		let result = text.trim();
		if (!result) return result;

		const brandCandidates = new Set<string>();
		const normalizedWebsiteName =
			websiteName.trim();
		if (
			normalizedWebsiteName &&
			normalizedWebsiteName.toLowerCase() !==
				"this website"
		) {
			brandCandidates.add(normalizedWebsiteName);
		}
		const websiteRef =
			this.getWebsiteReference(websiteName);
		if (websiteRef !== "this website") {
			brandCandidates.add(websiteRef);
		}

		const voicePattern =
			"(offers|provides|delivers|shares|supports|includes|covers|has|is|specializes in|can help with)";
		for (const candidate of Array.from(
			brandCandidates,
		).sort(
			(left, right) => right.length - left.length,
		)) {
			const pattern = new RegExp(
				`^(?:the\\s+)?${this.escapeRegex(candidate)}(?:\\s+website)?\\s+${voicePattern}\\b`,
				"i",
			);
			if (pattern.test(result)) {
				result = result.replace(
					pattern,
					(_match: string, verb: string) =>
						`We ${this.toFirstPersonVerb(verb)}`,
				);
				return result;
			}
		}

		return result.replace(
			new RegExp(
				`^(?:the company|they)\\s+${voicePattern}\\b`,
				"i",
			),
			(_match: string, verb: string) =>
				`We ${this.toFirstPersonVerb(verb)}`,
		);
	}

	private highlightKeywordTerms(
		text: string,
	): string {
		const keywords = [
			"full name",
			"work email",
			"phone number",
			"company",
			"case studies",
			"products",
			"services",
			"pricing",
			"support",
			"policies",
			"features",
			"solutions",
			"integrations",
			"contact",
			"demo",
			"trial",
		];

		let result = text;
		for (const keyword of keywords) {
			const escaped = keyword
				.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				.replace(/\s+/g, "\\s+");
			const regex = new RegExp(
				`\\b(${escaped})\\b`,
				"gi",
			);
			result = result.replace(
				regex,
				(
					match: string,
					_group: string,
					offset: number,
					source: string,
				) => {
					const before = source.slice(
						Math.max(0, offset - 2),
						offset,
					);
					const after = source.slice(
						offset + match.length,
						offset + match.length + 2,
					);
					if (before === "**" && after === "**") {
						return match;
					}
					return `**${match}**`;
				},
			);
		}
		return result;
	}

	private ensureAtLeastOneHighlight(
		text: string,
	): string {
		if (/\*\*[^*]+\*\*/.test(text)) return text;
		const firstPhrase = text.match(
			/[A-Za-z][A-Za-z0-9/-]*(?:\s+[A-Za-z][A-Za-z0-9/-]*){0,2}/,
		);
		if (!firstPhrase) return text;
		return text.replace(
			firstPhrase[0],
			`**${firstPhrase[0]}**`,
		);
	}

	private formatAssistantResponse(
		response: string,
		_userMessage: string,
		websiteName: string = "this website",
		intent: QueryIntent = "general",
	): string {
		const websiteRef =
			this.getWebsiteReference(websiteName);
		const withWebsiteName =
			websiteRef === "this website"
				? response
				: response
						.replace(
							/this website'?s content/gi,
							websiteRef,
						)
						.replace(
							/\bthis website\b/gi,
							websiteRef,
						);
		const withoutFormulaicPreface =
			this.stripFormulaicPreface(
				withWebsiteName,
				intent,
			);
		const withBusinessVoice =
			this.normalizeBusinessVoice(
				withoutFormulaicPreface,
				websiteName,
			);
		const withLengthLimit = withBusinessVoice.replace(/\r\n/g, "\n").trim();
		const withHighlights =
			this.highlightKeywordTerms(withLengthLimit);
		const withMinimumHighlight =
			this.ensureAtLeastOneHighlight(
				withHighlights,
			).trim();
		return this.finalizeResponseEnding(
			withMinimumHighlight,
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

	private escapeRegex(value: string): string {
		return value.replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		);
	}

	private normalizePersonName(
		raw: string,
	): string | null {
		const cleaned = raw
			.trim()
			.replace(/[.,!?;:]+$/g, "")
			.replace(/\s+/g, " ");
		if (!cleaned) return null;

		const words = cleaned.split(" ");
		if (words.length < 1 || words.length > 4) {
			return null;
		}

		const stopWords = new Set([
			"looking",
			"interested",
			"searching",
			"need",
			"want",
			"asking",
			"here",
			"there",
			"from",
			"for",
			"about",
			"pricing",
			"product",
			"products",
			"service",
			"services",
			"support",
			"help",
			"details",
			"information",
			"more",
			"real-time",
			"spend",
			"visibility",
			"procurement",
			"solution",
			"solutions",
			"feature",
			"features",
			"platform",
		]);

		for (const word of words) {
			if (
				!/^[A-Za-z][A-Za-z'-]{0,24}$/.test(word)
			) {
				return null;
			}
			if (stopWords.has(word.toLowerCase())) {
				return null;
			}
		}

		return words
			.map((word) =>
				word.length > 1
					? word.charAt(0).toUpperCase() +
						word.slice(1).toLowerCase()
					: word.toUpperCase(),
			)
			.join(" ");
	}

	private extractNameFromUserMessage(
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

	private getKnownUserName(
		messages: ChatMessage[],
	): string | null {
		let latest: string | null = null;
		for (const msg of messages) {
			if (msg.role !== "user") continue;
			const extracted =
				this.extractNameFromUserMessage(
					msg.content || "",
				);
			if (extracted) {
				latest = extracted;
			}
		}
		return latest;
	}

	private messageContainsEmailOrPhone(
		message: string,
	): boolean {
		const text = message.trim();
		if (!text) return false;

		const hasEmail =
			/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(
				text,
			);
		const phoneDigits = text.replace(/\D/g, "");
		const hasPhone = phoneDigits.length >= 7;

		return hasEmail || hasPhone;
	}

	private normalizeCompanyName(
		raw: string,
	): string | null {
		const cleaned = raw
			.trim()
			.replace(/[.,!?;:]+$/g, "")
			.replace(/\s+/g, " ");
		if (!cleaned) return null;
		if (
			cleaned.length < 2 ||
			cleaned.length > 80
		) {
			return null;
		}

		return cleaned;
	}

	private extractCompanyFromUserMessage(
		message: string,
	): string | null {
		const text = message.trim();
		if (!text) return null;

		const patterns = [
			/\b(?:my company name is|company name is)\s+([A-Za-z0-9&.,'()\- ]{2,80})$/i,
			/\b(?:my company is|company is)\s+([A-Za-z0-9&.,'()\- ]{2,80})$/i,
			/\b(?:i work at|i am from|i'm from|we are from)\s+([A-Za-z0-9&.,'()\- ]{2,80})$/i,
			/^\s*company\s*[:=-]\s*([A-Za-z0-9&.,'()\- ]{2,80})\s*$/i,
		];

		for (const pattern of patterns) {
			const match = text.match(pattern);
			if (!match || !match[1]) continue;
			const normalized =
				this.normalizeCompanyName(match[1]);
			if (normalized) return normalized;
		}

		return null;
	}

	private getKnownUserCompany(
		messages: ChatMessage[],
	): string | null {
		let latest: string | null = null;
		for (const msg of messages) {
			if (msg.role !== "user") continue;
			const extracted =
				this.extractCompanyFromUserMessage(
					msg.content || "",
				);
			if (extracted) {
				latest = extracted;
			}
		}
		return latest;
	}

	private isNameRecallQuery(
		message: string,
	): boolean {
		const text = message.toLowerCase().trim();
		if (!text) return false;
		return (
			/\b(what(?:'s| is)|tell me|remember|recall|know)\b.*\bmy name\b/.test(
				text,
			) ||
			/\bmy name\??$/.test(text) ||
			/\bwho am i\b/.test(text)
		);
	}

	private applyNameRecallOverride(
		response: string,
		userMessage: string,
		knownUserName: string | null,
		websiteName: string,
	): string {
		if (!this.isNameRecallQuery(userMessage)) {
			return response;
		}

		const websiteRef =
			this.getWebsiteReference(websiteName);
		if (!knownUserName) {
			return `I do not have your **name** yet in this chat window. Please share your **full name**, and I will remember it for this conversation.`;
		}
		const deniesPersonalInfo =
			/don't have access to your personal information|do not have access to your personal information|cannot access your personal information|don't know your name|do not know your name/i.test(
				response,
			);
		const mentionsKnownName = new RegExp(
			`\\b${this.escapeRegex(knownUserName)}\\b`,
			"i",
		).test(response);

		if (
			deniesPersonalInfo ||
			!mentionsKnownName
		) {
			return `You shared your **name** as **${knownUserName}** earlier in this chat. How can I help you next with **${websiteRef}**?`;
		}

		return response;
	}

	private applyLeadCaptureFollowUpOverride(
		response: string,
		userMessage: string,
		messages: ChatMessage[],
	): string {
		if (
			!this.messageContainsEmailOrPhone(
				userMessage,
			)
		) {
			return response;
		}

		const knownUserName =
			this.getKnownUserName(messages);
		const knownUserCompany =
			this.getKnownUserCompany(messages);
		const missingName = !knownUserName;
		const missingCompany = !knownUserCompany;

		if (!missingName && !missingCompany) {
			return response;
		}

		let followUp = "";
		if (missingName && missingCompany) {
			followUp =
				"Could you also share your **full name** and **company name**?";
		} else if (missingName) {
			followUp =
				"Could you also share your **full name**?";
		} else {
			followUp =
				"Could you also share your **company name**?";
		}

		if (!response.trim()) {
			return `Thanks for sharing your **contact details**. ${followUp}`;
		}

		if (
			/\bfull name\b/i.test(response) ||
			/\bcompany name\b/i.test(response)
		) {
			return response;
		}

		if (
			response.trim() ===
			this.getFallbackResponse()
		) {
			return `Thanks for sharing your **contact details**. ${followUp}`;
		}

		return `${this.finalizeResponseEnding(response)}\n\nThanks for sharing your **contact details**. ${followUp}`;
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
									this.buildChatCompletionRequest(
										conversationHistory,
									),
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
					{ language: resolvedLanguage },
				);
			const userMessage: ChatMessage = {
				role: "user",
				content: message,
				timestamp: userTimestamp,
			};
			session.messages.push(userMessage);
			{
				let responseIntent: QueryIntent =
					"general";
				const trace = startChatTrace({
					userId,
					sessionId: session.sessionId,
					message,
					intent: "rag_pipeline",
				});
				const retrievalStart = Date.now();
				const priorMessages = session.messages.slice(0, -1);
				const [
					{
						systemPrompt,
						workspaceBoundary,
					},
					ragConversationContext,
					transformResult,
				] = await Promise.all([
					this.resolveRagSettings(userId),
					this.buildRagConversationContext(
						session.sessionId,
						session.messages,
					),
					queryTransformService.transform(
						message,
						priorMessages,
					),
				]);
				responseIntent =
					transformResult.intent;

				const shouldSkipRetrieval =
					transformResult.intent === "small_talk" ||
					transformResult.intent === "lead_capture";

				const ragResult = shouldSkipRetrieval
					? null
					: await ragPipelineService.prepare(
							userId,
							message,
							workspaceBoundary,
							ragConversationContext,
							{
								retrievalQuery: transformResult.retrievalQuery,
								isContactQuery: transformResult.isContactQuery,
								structuredPlan: transformResult.structuredPlan,
							},
					  );
				timing.retrievalMs =
					Date.now() - retrievalStart;
				const sources = ragResult?.sources ?? [];
				const websiteName =
					await this.resolveWebsiteName(
						userId,
						sources,
					);
				const knownUserName =
					this.getKnownUserName(
						session.messages,
					);
				const fallbackResponse =
					this.getFallbackResponse();
				let assistantResponse =
					fallbackResponse;
				let usedFallback = false;
				let usage:
					| CompletionUsage
					| undefined;
				const llmStart = Date.now();
				const conversationHistory =
					shouldSkipRetrieval
						? this.buildRagConversationMessages(
								systemPrompt,
								message,
								priorMessages,
						  )
						: ragResult!.noContextResponse
							? []
							: this.buildRagConversationMessages(
									systemPrompt,
									ragResult!.prompt,
									priorMessages,
							  );

				if (!shouldSkipRetrieval && ragResult!.noContextResponse) {
					assistantResponse =
						ragResult!.noContextResponse;
					usedFallback = true;
				} else {
					try {
						const completionResult =
							await this.generateNonStreamingResponse(
								conversationHistory,
								CHAT_DEFAULT_TIMEOUT_MS,
							);
						assistantResponse =
							completionResult.response;
						usage =
							completionResult.usage;
						usedFallback =
							assistantResponse ===
							fallbackResponse;
						recordGeneration(trace, {
							name: "chat-completion",
							model: CHAT_COMPLETION_MODEL,
							input: conversationHistory,
							output: assistantResponse,
							promptTokens:
								completionResult
									.usage
									?.prompt_tokens,
							completionTokens:
								completionResult
									.usage
									?.completion_tokens,
							totalTokens:
								completionResult
									.usage
									?.total_tokens,
							metadata: {
								workspaceBoundary,
								intent:
									responseIntent,
							},
						});
					} catch (error) {
						logger.error(
							"Chat generation failed, using fallback",
							{ error, userId },
						);
						usedFallback = true;
					}
				}
				assistantResponse =
					this.formatAssistantResponse(
						assistantResponse,
						message,
						websiteName,
						responseIntent,
					);
				assistantResponse =
					this.applyNameRecallOverride(
						assistantResponse,
						message,
						knownUserName,
						websiteName,
					);
				assistantResponse =
					this.applyLeadCaptureFollowUpOverride(
						assistantResponse,
						message,
						session.messages,
					);
				timing.llmMs =
					Date.now() - llmStart;

				endTrace(trace, assistantResponse, {
					workspaceBoundary,
					sourcesCount: sources.length,
					timing,
				});

				const usageMeta =
					this.buildUsageMetadata(
						usage,
					);
				const assistantTimestamp =
					await this.persistMessage(
						session.sessionId,
						userId,
						"assistant",
						assistantResponse,
						{
							sourcesCount:
								sources.length,
							language:
								resolvedLanguage,
							isFallback:
								usedFallback,
							intent:
								responseIntent,
							...usageMeta.metadata,
						},
						usageMeta.tokenCount,
					);
				const assistantMessage: ChatMessage =
					{
						role: "assistant",
						content: assistantResponse,
						timestamp:
							assistantTimestamp,
					};
				session.messages.push(
					assistantMessage,
				);
				session.updatedAt =
					assistantTimestamp;

				await this.saveCachedSession(session);
				timing.saveMs =
					Date.now() - saveStart;
				timing.totalMs =
					Date.now() - startedAt;

				logger.info(
					"Chat response generated",
					{
						userId,
						sessionId:
							session.sessionId,
						language:
							resolvedLanguage,
						intent:
							responseIntent,
						sourcesCount:
							sources.length,
						timing,
					},
				);

				return {
					sessionId:
						session.sessionId,
					response:
						assistantResponse,
					language:
						resolvedLanguage,
					sources,
				};
			}

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
				{ language: resolvedLanguage },
			);
		session.messages.push({
			role: "user",
			content: message,
			timestamp: userTimestamp,
		});
		{
			let responseIntent: QueryIntent =
				"general";
			const trace = startChatTrace({
				userId,
				sessionId: session.sessionId,
				message,
				intent: "rag_pipeline",
			});
			const retrievalStart = Date.now();
			const priorMessagesStream = session.messages.slice(0, -1);
			const [
				{
					systemPrompt,
					workspaceBoundary,
				},
				ragConversationContext,
				transformResultStream,
			] = await Promise.all([
				this.resolveRagSettings(userId),
				this.buildRagConversationContext(
					session.sessionId,
					session.messages,
				),
				queryTransformService.transform(
					message,
					priorMessagesStream,
				),
			]);
			responseIntent =
				transformResultStream.intent;

			const shouldSkipRetrievalStream =
				transformResultStream.intent === "small_talk" ||
				transformResultStream.intent === "lead_capture";

			const ragResult = shouldSkipRetrievalStream
				? null
				: await ragPipelineService.prepare(
						userId,
						message,
						workspaceBoundary,
						ragConversationContext,
						{
							retrievalQuery: transformResultStream.retrievalQuery,
							isContactQuery: transformResultStream.isContactQuery,
							structuredPlan: transformResultStream.structuredPlan,
						},
				  );
			timing.retrievalMs =
				Date.now() - retrievalStart;

			const sources = ragResult?.sources ?? [];
			const websiteName =
				await this.resolveWebsiteName(
					userId,
					sources,
				);
			const knownUserName =
				this.getKnownUserName(
					session.messages,
				);
			const fallbackResponse =
				this.getFallbackResponse();
			let assistantResponse = "";
			let usedFallback = false;
			let usage:
				| CompletionUsage
				| undefined;
			const conversationHistory =
				shouldSkipRetrievalStream
					? this.buildRagConversationMessages(
							systemPrompt,
							message,
							priorMessagesStream,
					  )
					: ragResult!.noContextResponse
						? []
						: this.buildRagConversationMessages(
								systemPrompt,
								ragResult!.prompt,
								priorMessagesStream,
						  );
			const timeoutController =
				new AbortController();
			const llmStart = Date.now();
			const timeout = setTimeout(() => {
				timeoutController.abort(
					"OpenAI stream timeout",
				);
			}, timeoutMs);
			try {
				if (!shouldSkipRetrievalStream && ragResult!.noContextResponse) {
					assistantResponse =
						ragResult!.noContextResponse;
					usedFallback = true;
				} else {
					const stream: any =
						await openAICircuitBreaker.execute(
							async () => {
								return await this.openai.chat.completions.create(
									this.buildChatCompletionRequest(
										conversationHistory,
										{
											stream: true,
										},
									),
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
									chunk.usage
										.prompt_tokens ?? 0,
								completion_tokens:
									chunk.usage
										.completion_tokens ?? 0,
								total_tokens:
									chunk.usage
										.total_tokens ?? 0,
							};
						}
						const token =
							chunk.choices?.[0]?.delta?.content ??
							"";
						if (!token) {
							continue;
						}
						assistantResponse += token;
					}
				}
			} catch (error) {
				logger.error(
					"Streaming chat failed, falling back",
					{ error, userId },
				);
				if (!assistantResponse) {
					assistantResponse =
						fallbackResponse;
					usedFallback = true;
				}
			} finally {
				clearTimeout(timeout);
			}
			timing.llmMs =
				Date.now() - llmStart;

			if (!assistantResponse.trim()) {
				assistantResponse =
					fallbackResponse;
				usedFallback = true;
			}

			if (!shouldSkipRetrievalStream && !ragResult?.noContextResponse) {
				recordGeneration(trace, {
					name: "chat-stream-completion",
					model: CHAT_COMPLETION_MODEL,
					input: conversationHistory,
					output: assistantResponse,
					promptTokens:
						usage?.prompt_tokens,
					completionTokens:
						usage?.completion_tokens,
					totalTokens:
						usage?.total_tokens,
					metadata: {
						workspaceBoundary,
						intent:
							responseIntent,
					},
				});
			}

			assistantResponse =
				this.formatAssistantResponse(
					assistantResponse,
					message,
					websiteName,
					responseIntent,
				);
			assistantResponse =
				this.applyNameRecallOverride(
					assistantResponse,
					message,
					knownUserName,
					websiteName,
				);
			assistantResponse =
				this.applyLeadCaptureFollowUpOverride(
					assistantResponse,
					message,
					session.messages,
				);
			options?.onToken?.(assistantResponse);

			endTrace(trace, assistantResponse, {
				workspaceBoundary,
				sourcesCount: sources.length,
				timing,
			});

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
						intent: responseIntent,
						...usageMeta.metadata,
					},
					usageMeta.tokenCount,
				);
			session.messages.push({
				role: "assistant",
				content: assistantResponse,
				timestamp: assistantTimestamp,
			});
			session.updatedAt =
				assistantTimestamp;

			await this.saveCachedSession(session);
			timing.saveMs =
				Date.now() - saveStart;
			timing.totalMs =
				Date.now() - startedAt;

			logger.info(
				"Chat streaming response generated",
				{
					userId,
					sessionId: session.sessionId,
					language: resolvedLanguage,
					intent: responseIntent,
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
			memCache.del(
				this.getSessionKey(normalized),
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
			for (const row of result.rows) {
			memCache.del(this.getSessionKey(row.id));
		}
		}

		return result.rows.length;
	}
}

export const chatService = new ChatService();
