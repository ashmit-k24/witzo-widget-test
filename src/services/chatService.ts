import crypto from "crypto";
import OpenAI from "openai";
import pool from "../config/database";
import { config } from "../config/env";
import { redisCache } from "../config/redis";
import {
	CHAT_COMPLETION_MAX_TOKENS,
	CHAT_COMPLETION_TEMPERATURE,
	CHAT_DEFAULT_TIMEOUT_MS,
	CHAT_GENERATION_MODEL,
	CHAT_HISTORY_WINDOW_MESSAGES,
	CHAT_LANGUAGE_LABELS,
	CHAT_SESSION_CACHE_MESSAGE_LIMIT,
	CHAT_SESSION_CACHE_TTL_SECONDS,
	CHAT_SUPPORTED_LANGUAGE_SET,
	UUID_V1_TO_V5_REGEX,
} from "../constants";
import {
	ChatMessage,
	ChatSession,
} from "../types";
import {
	extractMatchText,
	extractMatchTitle,
	extractMatchUrl,
	getRagScoreThreshold,
	relevantRagMatches,
	retrieveRelevantContext as fetchRelevantContext,
} from "./contextRetrievalService";
import { classifyTurn } from "./chatGraph";
import { openAICircuitBreaker } from "../utils/circuitBreaker";
import logger from "../utils/logger";
import { retryOnRateLimit } from "../utils/retry";
import systemMessageService from "./systemMessageService";
import websiteBrandingService from "./websiteBrandingService";
import usageTrackingService from "./usageTrackingService";

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

	private finalizeAssistantResponse(
		response: string,
		input: {
			websiteName?: string;
			sources?: Array<{ url: string }>;
			query: string;
		},
	): string {
		return this.formatAssistantResponse(
			response,
			input.query,
			input.websiteName,
			(input.sources ?? []).map((s) => s.url),
		);
	}

	private normalizeUrlForComparison(url: string): string {
		try {
			const parsed = new URL(url.trim());
			parsed.hash = "";
			return parsed.toString().replace(/\/+$/, "").toLowerCase();
		} catch {
			return url.trim().replace(/\/+$/, "").toLowerCase();
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

	private async buildChatMessages(
		userId: string,
		query: string,
		matches: any[],
		messages: ChatMessage[],
		_languageCode?: string,
	): Promise<Array<any>> {
		const effectiveSystemMessage =
			await systemMessageService.resolveEffectiveSystemMessage(userId);

		const allContextParts: string[] = [];
		for (const match of matches) {
			const text = extractMatchText(match);
			if (!text) continue;
			const sourceUrl = extractMatchUrl(match);
			const sourceTitle = extractMatchTitle(match);
			const headerParts = [
				sourceTitle ? `Title: ${sourceTitle}` : "",
				sourceUrl ? `Source: ${sourceUrl}` : "",
			].filter(Boolean);
			allContextParts.push(
				headerParts.length > 0
					? `${headerParts.join("\n")}\n${text}`
					: text,
			);
		}

		const systemPrompt = effectiveSystemMessage.trim();
		const languageInstruction = this.buildLanguageInstruction(_languageCode);

		const TOKEN_MODEL_LIMIT = 128000;
		const TOKEN_COMPLETION_RESERVE = CHAT_COMPLETION_MAX_TOKENS + 2000;
		const TOKEN_BUDGET = TOKEN_MODEL_LIMIT - TOKEN_COMPLETION_RESERVE;

		const fixedTokens = Math.ceil(
			[
				systemPrompt,
				languageInstruction ?? "",
				...messages.slice(-CHAT_HISTORY_WINDOW_MESSAGES).map((m) => m.content),
				query,
			].join(" ").length / 4,
		);

		const ragBudget = TOKEN_BUDGET - fixedTokens;
		const contextParts: string[] = [];
		let ragTokensUsed = 0;
		for (const part of allContextParts) {
			const partTokens = Math.ceil(part.length / 4);
			if (ragTokensUsed + partTokens > ragBudget) {
				logger.warn("RAG context trimmed to fit token budget", {
					keptChunks: contextParts.length,
					droppedChunks: allContextParts.length - contextParts.length,
					ragBudget,
					ragTokensUsed,
				});
				break;
			}
			contextParts.push(part);
			ragTokensUsed += partTokens;
		}

		const conversationHistory: Array<any> = [{ role: "system", content: systemPrompt }];
		if (languageInstruction) {
			conversationHistory.push({ role: "system", content: languageInstruction });
		}

		for (const msg of messages.slice(-CHAT_HISTORY_WINDOW_MESSAGES)) {
			conversationHistory.push({ role: msg.role, content: msg.content });
		}

		const userPrompt = contextParts.length > 0
			? `Knowledge Base:\n${contextParts.join("\n\n---\n\n")}\n\nQuestion: ${query}`
			: `Question: ${query}`;

		conversationHistory.push({ role: "user", content: userPrompt });
		return conversationHistory;
	}

	// ── Debug / evaluation helpers (admin-only) ───────────────────────────────

	async buildDebugPrompt(
		userId: string,
		query: string,
	): Promise<{
		messages: Array<{ role: string; content: string }>;
		matches: any[];
		matchCount: number;
		topScore: number | null;
	}> {
		const { matches } = await fetchRelevantContext(userId, query, "debug", []);
		const threshold = getRagScoreThreshold();
		const relevant = relevantRagMatches(matches, threshold);
		const messages = await this.buildChatMessages(
			userId,
			query,
			relevant,
			[],
		);
		return {
			messages,
			matches: relevant.map((m: any) => ({
				text: extractMatchText(m).slice(0, 300),
				url: extractMatchUrl(m),
				title: extractMatchTitle(m),
				score: m.score ?? m.cohereScore ?? null,
			})),
			matchCount: relevant.length,
			topScore: relevant[0]?.score ?? relevant[0]?.cohereScore ?? null,
		};
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
										model: CHAT_GENERATION_MODEL,
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
					completion.choices[0].message.content || "",
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
		const { matches, sources } = await fetchRelevantContext(
			userId,
			message,
			syntheticSessionId,
			[],
		);
		const relevantMatches = relevantRagMatches(matches, getRagScoreThreshold());

		const completion = await this.generateNonStreamingResponse(
			await this.buildChatMessages(
				userId,
				message,
				relevantMatches,
				[],
				resolvedLanguage,
			),
			CHAT_DEFAULT_TIMEOUT_MS,
		);
		let answer = completion.response;

		const websiteName =
			await websiteBrandingService.resolveUserWebsiteName(userId);
		answer = this.finalizeAssistantResponse(answer, {
			query: message,
			websiteName,
			sources,
		});
		return {
			answer,
			language: resolvedLanguage,
			sources,
			matches: relevantMatches,
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

			const retrievalStart = Date.now();
			const turnType = await classifyTurn(
				message,
				historyMessages,
				this.openai,
			);
			const skipRetrieval =
				turnType === "continuation" || turnType === "greeting";
			let matches: any[] = [];
			let sources: Array<{
				url: string;
				title: string;
				relevanceScore: number;
			}> = [];
			if (!skipRetrieval) {
				({ matches, sources } = await fetchRelevantContext(
					userId,
					message,
					session.sessionId,
					historyMessages,
				));
			}
			timing.retrievalMs = Date.now() - retrievalStart;

			const scoreThreshold = getRagScoreThreshold();
			const relevantMatches = skipRetrieval
				? []
				: relevantRagMatches(matches, scoreThreshold);

			logger.info("[CHAT] rag-retrieval", {
				userId,
				query: message,
				turnType,
				skipped: skipRetrieval,
				totalMatches: matches.length,
				relevantMatchesCount: relevantMatches.length,
				scoreThreshold,
				topScore: matches[0]?.score ?? null,
			});

			const llmStart = Date.now();
			let assistantResponse: string;
			let usage: CompletionUsage | undefined;

			try {
				const conversationHistory = await this.buildChatMessages(
					userId,
					message,
					relevantMatches,
					historyMessages,
					resolvedLanguage,
				);
				const completionResult = await this.generateNonStreamingResponse(
					conversationHistory,
					CHAT_DEFAULT_TIMEOUT_MS,
				);
				assistantResponse = completionResult.response;
				usage = completionResult.usage;
			} catch (error) {
				logger.error("Chat generation failed", { error, userId });
				throw error;
			}

			const websiteName =
				await websiteBrandingService.resolveUserWebsiteName(userId);
			assistantResponse = this.finalizeAssistantResponse(
				assistantResponse,
				{
					query: message,
					websiteName,
					sources,
				},
			);
			timing.llmMs = Date.now() - llmStart;

			const usageMeta = this.buildUsageMetadata(usage);
			if (usage) {
				void usageTrackingService.recordTokenUsage({
					userId,
					sessionId: session.sessionId,
					model: CHAT_GENERATION_MODEL,
					promptTokens: usage.prompt_tokens,
					completionTokens: usage.completion_tokens,
					source: "chat",
				});
			}
			const assistantTimestamp = await this.persistMessage(
				session.sessionId,
				userId,
				"assistant",
				assistantResponse,
				{
					sourcesCount: sources.length,
					language: resolvedLanguage,
					isFallback: false,
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

			logger.info("chat:trace", {
				userId,
				sessionId: session.sessionId,
				query: message,
				matchCount: relevantMatches.length,
				topMatchScore: relevantMatches[0]?.score ?? relevantMatches[0]?.cohereScore,
				responseLength: assistantResponse.length,
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
			logger.error("Error in chat service", { error, userId });
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

		const retrievalStart = Date.now();
		const turnType = await classifyTurn(
			message,
			historyMessages,
			this.openai,
		);
		const skipRetrieval =
			turnType === "continuation" || turnType === "greeting";
		let matches: any[] = [];
		let sources: Array<{
			url: string;
			title: string;
			relevanceScore: number;
		}> = [];
		if (!skipRetrieval) {
			({ matches, sources } = await fetchRelevantContext(
				userId,
				message,
				session.sessionId,
				historyMessages,
			));
		}
		timing.retrievalMs = Date.now() - retrievalStart;

		const scoreThreshold = getRagScoreThreshold();
		const relevantMatches = skipRetrieval
			? []
			: relevantRagMatches(matches, scoreThreshold);

		logger.info("[STREAM] rag-retrieval", {
			userId,
			query: message,
			turnType,
			skipped: skipRetrieval,
			totalMatches: matches.length,
			relevantMatchesCount: relevantMatches.length,
			scoreThreshold,
			topScore: matches[0]?.score ?? null,
		});

		let assistantResponse = "";
		let usage: CompletionUsage | undefined;
		const llmStart = Date.now();

		const timeoutController = new AbortController();
		const timeout = setTimeout(() => {
			timeoutController.abort("OpenAI stream timeout");
		}, timeoutMs);

		try {
			const conversationHistory = await this.buildChatMessages(
				userId,
				message,
				relevantMatches,
				historyMessages,
				resolvedLanguage,
			);
			const stream = await openAICircuitBreaker.execute(async () => {
				return await this.openai.chat.completions.create(
					{
						model: CHAT_GENERATION_MODEL,
						messages: conversationHistory,
						temperature: CHAT_COMPLETION_TEMPERATURE,
						max_tokens: CHAT_COMPLETION_MAX_TOKENS,
						stream: true,
						stream_options: { include_usage: true },
					},
					{ signal: timeoutController.signal },
				);
			});

			for await (const chunk of stream) {
				if (chunk.usage) {
					usage = {
						prompt_tokens: chunk.usage.prompt_tokens ?? 0,
						completion_tokens: chunk.usage.completion_tokens ?? 0,
						total_tokens: chunk.usage.total_tokens ?? 0,
					};
				}
				const token = chunk.choices?.[0]?.delta?.content ?? "";
				if (!token) continue;
				assistantResponse += token;
				options?.onToken?.(token);
			}
		} catch (error) {
			logger.error("Streaming chat failed", { error, userId });
			throw error;
		} finally {
			clearTimeout(timeout);
		}

		timing.llmMs = Date.now() - llmStart;

		const websiteName = await websiteBrandingService.resolveUserWebsiteName(userId);
		const streamedAssistantResponse = assistantResponse;
		assistantResponse = this.finalizeAssistantResponse(assistantResponse, {
			query: message,
			websiteName,
			sources,
		});
		const streamedTrimmed = streamedAssistantResponse.trimEnd();
		if (
			assistantResponse !== streamedAssistantResponse &&
			streamedTrimmed &&
			assistantResponse.startsWith(streamedTrimmed)
		) {
			const postProcessDelta = assistantResponse.slice(streamedTrimmed.length);
			if (postProcessDelta) {
				options?.onToken?.(postProcessDelta);
			}
		}
		const usageMeta = this.buildUsageMetadata(usage);
		if (usage) {
			void usageTrackingService.recordTokenUsage({
				userId,
				sessionId: session.sessionId,
				model: CHAT_GENERATION_MODEL,
				promptTokens: usage.prompt_tokens,
				completionTokens: usage.completion_tokens,
				source: "chat_stream",
			});
		}
		const assistantTimestamp = await this.persistMessage(
			session.sessionId,
			userId,
			"assistant",
			assistantResponse,
			{
				sourcesCount: sources.length,
				language: resolvedLanguage,
				isFallback: false,
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

		logger.info("chat:trace", {
			userId,
			sessionId: session.sessionId,
			query: message,
			matchCount: relevantMatches.length,
			topMatchScore: relevantMatches[0]?.score ?? relevantMatches[0]?.cohereScore,
			responseLength: assistantResponse.length,
			language: resolvedLanguage,
			sourcesCount: sources.length,
			timing,
			stream: true,
		});

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
