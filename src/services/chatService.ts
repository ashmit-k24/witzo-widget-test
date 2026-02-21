import OpenAI from "openai";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config/env";
import pool from "../config/database";
import { redisCache } from "../config/redis";
import {
	CHAT_COMPLETION_MAX_TOKENS,
	CHAT_COMPLETION_MODEL,
	CHAT_COMPLETION_TEMPERATURE,
	CHAT_DEFAULT_TIMEOUT_MS,
	CHAT_HISTORY_WINDOW_MESSAGES,
	CHAT_RETRIEVAL_CACHE_TTL_SECONDS,
	CHAT_SESSION_CACHE_MESSAGE_LIMIT,
	CHAT_SESSION_CACHE_TTL_SECONDS,
	UUID_V1_TO_V5_REGEX,
} from "../constants";
import { ChatMessage, ChatSession } from "../types";
import logger from "../utils/logger";
import { pineconeService } from "./pineconeService";
import { openAICircuitBreaker } from "../utils/circuitBreaker";
import { retryOnRateLimit } from "../utils/retry";

type ContextResult = {
	context: string;
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
	created_at: Date;
	updated_at: Date;
};

type MessageRow = {
	role: "user" | "assistant" | "system";
	content: string;
	created_at: Date;
};

class ChatService {
	private openai: OpenAI;

	constructor() {
		this.openai = new OpenAI({
			apiKey: config.OPENAI_API_KEY,
		});
	}

	private getSessionKey(sessionId: string): string {
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

	private normalizeSessionId(sessionId?: string): string | null {
		if (!sessionId) return null;
		const normalized = sessionId.trim().toLowerCase();
		if (!UUID_V1_TO_V5_REGEX.test(normalized)) return null;
		return normalized;
	}

	private mapCachedSession(data: string): ChatSession {
		const parsed = JSON.parse(data) as ChatSession;
		return {
			...parsed,
			createdAt: new Date(parsed.createdAt),
			updatedAt: new Date(parsed.updatedAt),
			messages: (parsed.messages || []).map((msg) => ({
				...msg,
				timestamp: new Date(msg.timestamp),
			})),
		};
	}

	private async getCachedSession(
		sessionId: string,
	): Promise<ChatSession | null> {
		const data = await redisCache.get(this.getSessionKey(sessionId));
		if (!data) return null;
		return this.mapCachedSession(data);
	}

	private async saveCachedSession(session: ChatSession): Promise<void> {
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

	private getTopKForQuery(query: string): number {
		const size = query.trim().length;
		if (size <= 40) return 6;
		if (size <= 160) return 8;
		return 10;
	}

	private getFallbackResponse(): string {
		return "I'm sorry, I'm facing a temporary delay. Please try again in a moment.";
	}

	private isLikelySmallTalk(message: string): boolean {
		const value = message.toLowerCase().trim();
		if (!value) return false;
		return /\b(hi|hello|hey|good morning|good evening|thanks|thank you|bye)\b/.test(
			value,
		);
	}

	private async getConversation(
		sessionId: string,
		userId: string,
	): Promise<ConversationRow | null> {
		const result = await pool.query<ConversationRow>(
			`SELECT id, user_id, created_at, updated_at
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
			const explicit = await pool.query<ConversationRow>(
				`INSERT INTO chat_conversations (id, user_id)
				 VALUES ($1, $2)
				 ON CONFLICT (id) DO NOTHING
				 RETURNING id, user_id, created_at, updated_at`,
				[sessionId, userId],
			);

			if (explicit.rows[0]) {
				return explicit.rows[0];
			}

			const existing = await this.getConversation(sessionId, userId);
			if (existing) return existing;
		}

		const created = await pool.query<ConversationRow>(
			`INSERT INTO chat_conversations (id, user_id)
			 VALUES ($1, $2)
			 RETURNING id, user_id, created_at, updated_at`,
			[uuidv4(), userId],
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

		return result.rows
			.reverse()
			.map((row) => ({
				role: row.role,
				content: row.content,
				timestamp: row.created_at,
			}));
	}

	private async getOrCreateSession(
		userId: string,
		rawSessionId?: string,
	): Promise<ChatSession> {
		const sessionId = this.normalizeSessionId(rawSessionId) ?? undefined;
		let conversation: ConversationRow | null = null;

		if (sessionId) {
			conversation = await this.getConversation(sessionId, userId);
		}

		if (!conversation) {
			conversation = await this.createConversation(userId, sessionId);
		}

		const cached = await this.getCachedSession(conversation.id);
		if (cached && cached.userId === userId) {
			return cached;
		}

		const messages = await this.loadRecentMessages(
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
	): Promise<Date> {
		const result = await pool.query<{ created_at: Date }>(
			`WITH inserted AS (
				INSERT INTO chat_messages (conversation_id, user_id, role, content, metadata)
				VALUES ($1, $2, $3, $4, $5::jsonb)
				RETURNING created_at
			)
			UPDATE chat_conversations
			SET message_count = message_count + 1,
				last_message_at = (SELECT created_at FROM inserted),
				last_message_preview = LEFT($4, 280),
				updated_at = CURRENT_TIMESTAMP
			WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE
			RETURNING (SELECT created_at FROM inserted) AS created_at`,
			[sessionId, userId, role, content, JSON.stringify(metadata)],
		);

		if (!result.rows[0]) {
			throw new Error("Failed to persist chat message");
		}

		return result.rows[0].created_at;
	}

	private async retrieveRelevantContext(
		userId: string,
		query: string,
		sessionId: string,
	): Promise<ContextResult> {
		try {
			const cacheKey = this.getRetrievalCacheKey(userId, sessionId, query);
			const cached = await redisCache.get(cacheKey);
			if (cached) {
				return JSON.parse(cached) as ContextResult;
			}

			const topK = this.getTopKForQuery(query);
			const results = await pineconeService.queryDocuments(userId, query, topK);

			if (!results || results.length === 0) {
				return { context: "", sources: [] };
			}

			const contextPieces: string[] = [];
			const sources: Array<{
				url: string;
				title: string;
				relevanceScore: number;
			}> = [];

			for (const match of results) {
				if (match.metadata && match.metadata.content) {
					contextPieces.push(
						`[Source: ${match.metadata.title || match.metadata.url}]\n${match.metadata.content}`,
					);

					if (!sources.find((s) => s.url === match.metadata.url)) {
						sources.push({
							url: match.metadata.url,
							title: match.metadata.title || match.metadata.url,
							relevanceScore: match.score || 0,
						});
					}
				}
			}

			const context = contextPieces.join("\n\n---\n\n");
			const responseData: ContextResult = { context, sources };
			await redisCache.setex(
				cacheKey,
				CHAT_RETRIEVAL_CACHE_TTL_SECONDS,
				JSON.stringify(responseData),
			);
			return responseData;
		} catch (error) {
			logger.error("Error retrieving context from Pinecone", { error, userId });
			return { context: "", sources: [] };
		}
	}

	private buildConversationHistory(
		context: string,
		messages: ChatMessage[],
	): Array<any> {
		const conversationHistory: Array<any> = [
			{
				role: "system",
				content: [
					{
						type: "text",
						text: `You are a helpful AI assistant representing a brand/website. You answer questions based on the provided context from the user's scraped website data.

IMPORTANT RULES:
1. **Greetings & Chit-chat**: If the user says "hey", "hello", "hi", "how are you?", etc., reply politely and professionally as an AI assistant. do NOT say "I don't have data". Be helpful and ask how you can assist them regarding the website content.
2. **Context-Based Answers**: For specific questions, answer ONLY using the provided context.
3. **Out of Scope**: If the user asks for tasks outside the scope of the website context (e.g., "write an email", "explain quantum physics", "write code"), politely refuse. Say: "I am designed to answer questions about this website's content and cannot assist with that request."
4. **Partial Answers**: If you find *some* relevant information (like project examples) but not a definitive "best" or complete list, SHARE what you found. Do NOT say "I don't have enough information" if you have at least one relevant example. Instead say: "Based on the available data, here are some projects..."
5. **No Hallucinations**: Do not make up information not present in the context.
6. **No Citations**: Do NOT mention the source, filename, or URL in your response. Provide the answer directly as if it is your own knowledge.`,
						cache_control: {
							type: "ephemeral",
						},
					},
					{
						type: "text",
						text: `\n\nContext from scraped websites:\n${context || "No relevant context found."}`,
						cache_control: {
							type: "ephemeral",
						},
					},
				],
			},
		];

		const recentMessages = messages.slice(
			-CHAT_HISTORY_WINDOW_MESSAGES,
		);
		for (const msg of recentMessages) {
			conversationHistory.push({
				role: msg.role,
				content: msg.content,
			});
		}

		return conversationHistory;
	}

	private async generateNonStreamingResponse(
		conversationHistory: Array<any>,
		timeoutMs: number,
	): Promise<string> {
		const timeoutController = new AbortController();
		const timeout = setTimeout(() => {
			timeoutController.abort("OpenAI request timeout");
		}, timeoutMs);

		try {
			const completion = await openAICircuitBreaker.execute(async () => {
				return await retryOnRateLimit(async () => {
					return await this.openai.chat.completions.create(
						{
							model: CHAT_COMPLETION_MODEL,
							messages: conversationHistory,
							temperature: CHAT_COMPLETION_TEMPERATURE,
							max_tokens: CHAT_COMPLETION_MAX_TOKENS,
						},
						{
							signal: timeoutController.signal,
						},
					);
				});
			});

			return completion.choices[0].message.content || this.getFallbackResponse();
		} finally {
			clearTimeout(timeout);
		}
	}

	async chat(
		userId: string,
		message: string,
		sessionId?: string,
	): Promise<{
		sessionId: string;
		response: string;
		sources: Array<{
			url: string;
			title: string;
			relevanceScore: number;
		}>;
	}> {
		try {
			const startedAt = Date.now();
			const timing: ChatTiming = {
				sessionMs: 0,
				retrievalMs: 0,
				llmMs: 0,
				saveMs: 0,
				totalMs: 0,
			};

			const sessionStart = Date.now();
			const session = await this.getOrCreateSession(userId, sessionId);
			timing.sessionMs = Date.now() - sessionStart;

			const saveStart = Date.now();
			const userTimestamp = await this.persistMessage(
				session.sessionId,
				userId,
				"user",
				message,
			);
			const userMessage: ChatMessage = {
				role: "user",
				content: message,
				timestamp: userTimestamp,
			};
			session.messages.push(userMessage);

			const retrievalStart = Date.now();
			const shouldSkipRetrieval = this.isLikelySmallTalk(message);
			const { context, sources } = shouldSkipRetrieval
				? {
						context: "",
						sources: [],
				  }
				: await this.retrieveRelevantContext(userId, message, session.sessionId);
			timing.retrievalMs = Date.now() - retrievalStart;

			const conversationHistory = this.buildConversationHistory(
				context,
				session.messages,
			);

			let assistantResponse = this.getFallbackResponse();
			const llmStart = Date.now();
			try {
				assistantResponse = await this.generateNonStreamingResponse(
					conversationHistory,
					CHAT_DEFAULT_TIMEOUT_MS,
				);
			} catch (error) {
				logger.error("Chat generation failed, using fallback", {
					error,
					userId,
				});
			}
			timing.llmMs = Date.now() - llmStart;

			const assistantTimestamp = await this.persistMessage(
				session.sessionId,
				userId,
				"assistant",
				assistantResponse,
				{ sourcesCount: sources.length },
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
				sourcesCount: sources.length,
				timing,
			});

			return {
				sessionId: session.sessionId,
				response: assistantResponse,
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
	): Promise<{
		sessionId: string;
		response: string;
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
		const timeoutMs = options?.timeoutMs ?? CHAT_DEFAULT_TIMEOUT_MS;

		const sessionStart = Date.now();
		const session = await this.getOrCreateSession(userId, sessionId);
		timing.sessionMs = Date.now() - sessionStart;

		const saveStart = Date.now();
		const userTimestamp = await this.persistMessage(
			session.sessionId,
			userId,
			"user",
			message,
		);
		session.messages.push({
			role: "user",
			content: message,
			timestamp: userTimestamp,
		});

		const retrievalStart = Date.now();
		const shouldSkipRetrieval = this.isLikelySmallTalk(message);
		const { context, sources } = shouldSkipRetrieval
			? { context: "", sources: [] }
			: await this.retrieveRelevantContext(userId, message, session.sessionId);
		timing.retrievalMs = Date.now() - retrievalStart;

		const conversationHistory = this.buildConversationHistory(
			context,
			session.messages,
		);

		let assistantResponse = "";
		const timeoutController = new AbortController();
		const timeout = setTimeout(() => {
			timeoutController.abort("OpenAI stream timeout");
		}, timeoutMs);

		const llmStart = Date.now();
		try {
			const stream = await openAICircuitBreaker.execute(async () => {
				return await this.openai.chat.completions.create(
					{
						model: CHAT_COMPLETION_MODEL,
						messages: conversationHistory,
						temperature: CHAT_COMPLETION_TEMPERATURE,
						max_tokens: CHAT_COMPLETION_MAX_TOKENS,
						stream: true,
					},
					{
						signal: timeoutController.signal,
					},
				);
			});

			for await (const chunk of stream) {
				const token = chunk.choices?.[0]?.delta?.content ?? "";
				if (!token) continue;
				assistantResponse += token;
				options?.onToken?.(token);
			}
		} catch (error) {
			logger.error("Streaming chat failed, falling back", {
				error,
				userId,
			});
			if (!assistantResponse) {
				assistantResponse = this.getFallbackResponse();
			}
		} finally {
			clearTimeout(timeout);
		}
		timing.llmMs = Date.now() - llmStart;

		if (!assistantResponse.trim()) {
			assistantResponse = this.getFallbackResponse();
		}

		const assistantTimestamp = await this.persistMessage(
			session.sessionId,
			userId,
			"assistant",
			assistantResponse,
			{ sourcesCount: sources.length },
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

		logger.info("Chat streaming response generated", {
			userId,
			sessionId: session.sessionId,
			sourcesCount: sources.length,
			timing,
		});

		return {
			sessionId: session.sessionId,
			response: assistantResponse,
			sources,
			timing,
		};
	}

	async getSession(sessionId: string): Promise<ChatSession | null> {
		const normalized = this.normalizeSessionId(sessionId);
		if (!normalized) return null;

		const conversationResult = await pool.query<ConversationRow>(
			`SELECT id, user_id, created_at, updated_at
			 FROM chat_conversations
			 WHERE id = $1 AND is_deleted = FALSE
			 LIMIT 1`,
			[normalized],
		);
		const conversation = conversationResult.rows[0];
		if (!conversation) return null;

		const messageResult = await pool.query<MessageRow>(
			`SELECT role, content, created_at
			 FROM chat_messages
			 WHERE conversation_id = $1
			 ORDER BY created_at ASC, id ASC
			 LIMIT 200`,
			[normalized],
		);

		const messages: ChatMessage[] = messageResult.rows.map((row) => ({
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
					? messages[messages.length - 1].timestamp
					: conversation.updated_at,
		};

		await this.saveCachedSession(session);
		return session;
	}

	async clearSession(sessionId: string): Promise<boolean> {
		const normalized = this.normalizeSessionId(sessionId);
		if (!normalized) return false;

		const result = await pool.query(
			`DELETE FROM chat_conversations WHERE id = $1`,
			[normalized],
		);

		if ((result.rowCount ?? 0) > 0) {
			await redisCache.del(this.getSessionKey(normalized));
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

	async clearUserSessions(userId: string): Promise<number> {
		const result = await pool.query<{ id: string }>(
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
