import OpenAI from "openai";
import crypto from "crypto";
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
	CHAT_SUPPORTED_LANGUAGE_SET,
	UUID_V1_TO_V5_REGEX,
} from "../constants";
import { ChatMessage, ChatSession } from "../types";
import logger from "../utils/logger";
import { pineconeService } from "./pineconeService";
import { scraperStatusService } from "./scraperStatusService";
import systemMessageService from "./systemMessageService";
import { openAICircuitBreaker } from "../utils/circuitBreaker";
import { retryOnRateLimit } from "../utils/retry";
import {
	isContactIntent,
	isLinkIntent,
	isWidgetCaseStudyQuery,
	isWidgetLocationQuery,
	isWidgetMedicalQuery,
	isWidgetServiceOverviewQuery,
	isWidgetTechProjectQuery,
	isWidgetTopListQuery,
	normalizeWidgetQuery,
} from "./queryService";

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
		return isWidgetServiceOverviewQuery(normalizeWidgetQuery(query)) ? 25 : 15;
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

	private truncateAtSentence(
		text: string,
		maxChars: number,
	): string {
		if (text.length <= maxChars) return text;
		const truncated = text.slice(0, maxChars);
		const lastBoundary = Math.max(
			truncated.lastIndexOf(". "),
			truncated.lastIndexOf("! "),
			truncated.lastIndexOf("? "),
		);
		return lastBoundary > maxChars / 2
			? truncated.slice(0, lastBoundary + 1)
			: truncated;
	}

	private ragMatchScore(match: any): number {
		const raw = match?.score;
		return typeof raw === "number" && Number.isFinite(raw)
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
		return String(match?.metadata?.title || "").trim();
	}

	private extractMatchUrl(match: any): string {
		return String(match?.metadata?.url || "").trim();
	}

	private extractMatchPageType(match: any): string {
		return String(match?.metadata?.pageType || "").trim();
	}

	private relevantRagMatches(
		matches: any[],
		minScore: number,
	): any[] {
		return matches.filter((match) => {
			const score = this.ragMatchScore(match);
			if (score < minScore) {
				return false;
			}
			return !Boolean(match?.metadata?.isHype);
		});
	}

	private ragScoreThreshold(query: string): number {
		const n = normalizeWidgetQuery(query);
		if (isContactIntent(n)) return 0.25;
		if (isWidgetTechProjectQuery(n)) return 0.25;
		if (isWidgetCaseStudyQuery(n)) return 0.28;
		return 0.3;
	}

	private jaccardSimilarity(
		left: string,
		right: string,
	): number {
		const a = new Set(
			left.toLowerCase().split(/\s+/).filter(Boolean),
		);
		const b = new Set(
			right.toLowerCase().split(/\s+/).filter(Boolean),
		);
		if (a.size === 0 || b.size === 0) {
			return 0;
		}
		let intersection = 0;
		for (const token of a) {
			if (b.has(token)) {
				intersection += 1;
			}
		}
		const union = a.size + b.size - intersection;
		return union === 0 ? 0 : intersection / union;
	}

	private mmrRerank(
		matches: any[],
		topN: number,
	): any[] {
		if (matches.length <= topN) {
			return matches;
		}

		const selected: any[] = [];
		const remaining = [...matches];
		const lambda = 0.7;
		while (
			selected.length < topN &&
			remaining.length > 0
		) {
			let bestIndex = 0;
			let bestScore = -Infinity;
			for (let index = 0; index < remaining.length; index += 1) {
				const candidate = remaining[index];
				const relevance = this.ragMatchScore(candidate);
				const candidateText =
					this.extractMatchText(candidate);
				let diversityPenalty = 0;
				for (const picked of selected) {
					const pickedText =
						this.extractMatchText(picked);
					diversityPenalty = Math.max(
						diversityPenalty,
						this.jaccardSimilarity(
							candidateText,
							pickedText,
						),
					);
				}
				const mmrScore =
					lambda * relevance -
					(1 - lambda) * diversityPenalty;
				if (mmrScore > bestScore) {
					bestScore = mmrScore;
					bestIndex = index;
				}
			}
			selected.push(
				remaining.splice(bestIndex, 1)[0],
			);
		}
		return selected;
	}

	private isServiceHeavyMatch(match: any): boolean {
		const pageType =
			this.extractMatchPageType(match).toLowerCase();
		if (
			pageType === "service" ||
			pageType === "home" ||
			pageType === "about"
		) {
			return true;
		}

		const title = this.extractMatchTitle(match).toLowerCase();
		const url = this.extractMatchUrl(match).toLowerCase();
		return /\b(service|solutions?|web development|website development|seo|hosting|content writing|brochure|e-?commerce|ui\/ux|cms)\b/.test(
			`${title} ${url}`,
		);
	}

	private selectMatchesForPrompt(
		query: string,
		matches: any[],
	): any[] {
		const normalized =
			normalizeWidgetQuery(query);
		if (isLinkIntent(normalized)) {
			return matches.slice(0, 8);
		}

		if (!isWidgetServiceOverviewQuery(normalized)) {
			return this.mmrRerank(matches, 8);
		}

		const preferredMatches = matches.filter((match) =>
			this.isServiceHeavyMatch(match),
		);
		const pool =
			preferredMatches.length >= 4
				? preferredMatches
				: matches;
		const ranked = [...pool].sort((left, right) => {
			const serviceBoost =
				Number(this.isServiceHeavyMatch(right)) -
				Number(this.isServiceHeavyMatch(left));
			if (serviceBoost !== 0) {
				return serviceBoost;
			}
			return (
				this.ragMatchScore(right) -
				this.ragMatchScore(left)
			);
		});
		const dedupedByUrl: any[] = [];
		const seenUrls = new Set<string>();
		for (const match of ranked) {
			const url = this.extractMatchUrl(match);
			if (url && seenUrls.has(url)) {
				continue;
			}
			if (url) {
				seenUrls.add(url);
			}
			dedupedByUrl.push(match);
			if (dedupedByUrl.length >= 12) {
				break;
			}
		}

		return dedupedByUrl.length > 0
			? dedupedByUrl
			: this.mmrRerank(matches, 8);
	}

	private buildServiceOverviewPromptNote(): string {
		return [
			"For service-overview questions, preserve the website's own service structure whenever possible.",
			"If the context contains a named section like 'Our website development services', use that exact category wording instead of replacing it with a generic umbrella label.",
			"List explicitly mentioned sub-services beneath the relevant main service family.",
			"After the strongest primary service section, add a short 'Other services we offer' section for additional categories if the context supports them.",
			"Do not collapse distinct website-listed services into a vague digital-agency summary.",
		].join("\n");
	}

	private defaultGeneratedSystemPrompt(): string {
		return "You are an expert AI assistant embedded on this company's website. Your mission is to give visitors the most complete, accurate, and well-structured answers possible — better than any competitor chatbot.\n\n" +
			"## Formatting Rules (always follow these)\n" +
			"- Use **bold** for key terms, names, metrics, and important points.\n" +
			"- Use bullet points (`-`) for lists of 3 or more items.\n" +
			"- Use numbered lists (`1.`) for steps, rankings, or ordered content.\n" +
			"- Use `##` headings to separate distinct sections in longer answers.\n" +
			"- For questions asking about multiple items (e.g. services, case studies, features, examples): present EVERY item — give each one its own `##` heading with bullet-point details underneath. Do not summarize or skip items.\n" +
			"- Add a blank line between sections. Never write a wall of unbroken text.\n\n" +
			"## Completeness Rules (critical)\n" +
			"- Always give the FULL answer. Never truncate, summarize vaguely, or say 'and more' when you have the actual data.\n" +
			"- When listing services, products, case studies, features, or team members — list ALL of them with details for each.\n" +
			"- Include specific numbers, percentages, names, and outcomes whenever they appear in the knowledge base.\n" +
			"- Match response depth to the question — factual questions get concise answers, detail-seeking questions get thorough answers.\n" +
			"- If the question is broad (e.g. 'what do you do'), give a structured overview covering all major areas.\n\n" +
			"## Accuracy Rules\n" +
			"- Use the provided context as your primary source. Extract all relevant details — names, stats, descriptions.\n" +
			"- Never invent facts, prices, metrics, or claims not found in the context.\n" +
			"- If specific information is missing, say so clearly and suggest where the visitor can learn more.\n\n" +
			"## Tone Rules\n" +
			"- Be friendly, confident, and professional.\n" +
			"- Respond to greetings warmly before helping.\n" +
			"- Never be dismissive — every question deserves a complete answer.";
	}

	private buildWidgetResponseStyleSystemPrompt(
		query: string,
	): string {
		const normalized =
			normalizeWidgetQuery(query);
		const lines = [
			"You are writing a reply for a public website chat widget.",
			"Answer like a polished sales/support assistant, not a raw retrieval dump.",
			"Lead with the answer immediately.",
			"Do not open with greetings, thank-yous, or filler unless the user greeted you first.",
			"Keep the reply concise, scannable, and commercially useful.",
			"Prefer a short intro sentence plus a compact bullet list.",
			"Use headings only when the answer genuinely needs multiple sections.",
			"Do not end with generic filler like 'If you need more information...' unless you offer one concrete next step.",
		];

		if (isWidgetServiceOverviewQuery(normalized)) {
			lines.push(
				"For service-overview questions, mirror the website's own service structure when possible.",
				"If the context shows a named service family like 'Our website development services', use that exact wording as a heading.",
				"List the explicitly mentioned sub-services underneath that heading instead of flattening everything into generic agency categories.",
				"After the lead section, add 'Other services we offer' only when there are clearly separate additional categories in the context.",
			);
		}
		if (
			isWidgetCaseStudyQuery(normalized) &&
			isWidgetTopListQuery(normalized)
		) {
			lines.push(
				"For top case studies or project questions, curate the strongest 3-6 examples from the context instead of dumping everything.",
				"Prioritize named brands, flagship work, and concrete outcomes or metrics when available.",
				"Format each example in one tight bullet: Brand - what was done and the strongest result.",
			);
		}
		if (
			isWidgetMedicalQuery(normalized) &&
			isWidgetCaseStudyQuery(normalized)
		) {
			lines.push(
				"For medical or healthcare case-study questions, include only the clearly relevant healthcare examples from the context.",
				"For each example, give the brand or clinic name plus the key result, objective, or channel in one or two lines.",
			);
		}
		if (isWidgetLocationQuery(normalized)) {
			lines.push(
				"For location questions, answer with exact office addresses first when they are present in the context.",
				"If the context only confirms cities or countries, say that clearly instead of implying a full street address.",
			);
		}
		return lines.join("\n");
	}

	private buildWidgetFormatDirective(
		query: string,
	): string {
		const normalized =
			normalizeWidgetQuery(query);
		const lines = [
			"IMPORTANT: Format your response using markdown.",
			"- Use **bold** sparingly for service names, company names, and metrics.",
			"- Use bullet points (-) for lists.",
			"- Use numbered lists only for steps or explicit rankings.",
			"- Keep short answers compact; do not turn simple answers into long reports.",
			"- Never invent facts, locations, metrics, prices, or case-study outcomes.",
		];
		if (isWidgetServiceOverviewQuery(normalized)) {
			lines.push(
				"- For service overviews, preserve the website's own category labels and service-family headings when they are visible in the context.",
				"- If a source explicitly lists sub-services, show them as bullets under the main service family.",
				"- Avoid generic umbrella wording when the context gives a more exact service name.",
			);
		}
		if (
			isWidgetCaseStudyQuery(normalized) &&
			isWidgetTopListQuery(normalized)
		) {
			lines.push(
				"- If the user asks for top items, rank or curate only the strongest 3-6 examples.",
			);
		}
		if (isWidgetLocationQuery(normalized)) {
			lines.push(
				"- For location questions, return exact addresses when available; otherwise clearly state only the confirmed cities or countries.",
			);
		}
		return `\n\n${lines.join("\n")}`;
	}

	private formatAssistantResponse(
		response: string,
		_userMessage: string,
		_websiteName: string = "this website",
	): string {
		return this.finalizeResponseEnding(
			response.trim(),
		);
	}

	private finalizeResponseEnding(text: string): string {
		let output = text.trim();
		if (!output) return output;

		const boldMarkerCount = (output.match(/\*\*/g) || []).length;
		if (boldMarkerCount % 2 !== 0) {
			output = output.replace(/\*\*([^*]*)$/g, "$1");
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
			const normalized = this.normalizePersonName(match[1]);
			if (normalized) return normalized;
		}

		return null;
	}

	private isLikelySmallTalk(message: string): boolean {
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
		if (!CHAT_SUPPORTED_LANGUAGE_SET.has(normalized)) {
			return undefined;
		}
		return normalized;
	}

	private async getConversation(
		sessionId: string,
		userId: string,
	): Promise<ConversationRow | null> {
		const result = await pool.query<ConversationRow>(
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
			const explicit = await pool.query<ConversationRow>(
				`INSERT INTO chat_conversations (id, user_id)
				 VALUES ($1, $2)
				 ON CONFLICT (id) DO NOTHING
				 RETURNING id, user_id, widget_key_id, visitor_id, created_at, updated_at`,
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
		tokenCount?: number,
	): Promise<Date> {
		const result = await pool.query<{ created_at: Date }>(
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
			throw new Error("Failed to persist chat message");
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
			const cacheKey = this.getRetrievalCacheKey(userId, sessionId, query);
			const cached = await redisCache.get(cacheKey);
			if (cached) {
				return JSON.parse(cached) as ContextResult;
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
			logger.error("Error retrieving context from Pinecone", { error, userId });
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
		const normalized =
			normalizeWidgetQuery(query);
		const selectedMatches =
			this.selectMatchesForPrompt(
				query,
				matches,
			);
		const contextParts: string[] = [];
		for (const match of selectedMatches) {
			const text =
				this.extractMatchText(match);
			if (!text) {
				continue;
			}
			const sourceUrl =
				this.extractMatchUrl(match);
			const sourceTitle =
				this.extractMatchTitle(match);
			const pageType =
				this.extractMatchPageType(match);
			const truncated = this.truncateAtSentence(
				text,
				isWidgetServiceOverviewQuery(normalized)
					? 2600
					: 2000,
			);
			const headerParts = [
				sourceTitle
					? `Title: ${sourceTitle}`
					: "",
				pageType
					? `Page Type: ${pageType}`
					: "",
				sourceUrl
					? `Source: ${sourceUrl}`
					: "",
			].filter(Boolean);
			contextParts.push(
				headerParts.length > 0
					? `${headerParts.join("\n")}\n${truncated}`
					: truncated,
			);
		}

		const formatDirective =
			this.buildWidgetFormatDirective(query);
		const knowledgeBoundary =
			await systemMessageService.resolveKnowledgeBoundary(
				userId,
			);
		let userPrompt: string;
		const serviceOverviewNote =
			isWidgetServiceOverviewQuery(normalized)
				? `\n${this.buildServiceOverviewPromptNote()}\n`
				: "";

		if (contextParts.length > 0) {
			const contextBlock =
				contextParts.join("\n\n---\n\n");
			if (knowledgeBoundary === "workspace_only") {
				userPrompt = `Answer using ONLY the information provided in the context below.
Treat page titles, URLs, headings, and snippets as relevant evidence about the business.
Synthesize across multiple context sections to form the most complete answer you can.
For broad overview questions asking for services, products, features, or capabilities, compile a combined list from every relevant context section and infer the service or category name from the source title or URL when needed.
If the context partially answers the question, provide the supported details you do have instead of refusing.
If the user is asking for "more" or additional items and the context does not contain more items beyond what was already discussed, acknowledge that these are all the results available and suggest they visit the website or contact the team for a complete list.
When the context includes a URL for a specific blog post, article, or resource the user is asking about, include it as a clickable markdown link — e.g. [Read more](https://...).
Only say you don't have information when the context is genuinely not related to the question at all.
${serviceOverviewNote}

Context:
${contextBlock}

Question: ${query}${formatDirective}`;
			} else {
				userPrompt = `Answer the user's question using the context below as your primary source.
If the context does not fully cover the question, use your general knowledge to fill in, but never fabricate specific facts, prices, features, or policies about this company that are not in the context.
If the user is asking for "more" items and the context has no further results, acknowledge that and suggest they visit the website.
When the context includes a URL for a blog post, article, or resource being asked about, include it as a clickable markdown link.
${serviceOverviewNote}

Context:
${contextBlock}

Question: ${query}${formatDirective}`;
			}
		} else {
			if (knowledgeBoundary === "workspace_only") {
				userPrompt = `The user sent: "${query}"

If this is a greeting, thank you, farewell, or casual conversational message, respond warmly and naturally as a helpful assistant.
Otherwise, if it is a specific question about this business: honestly say you couldn't find that specific information right now, suggest they visit the website directly or reach out to the team for accurate details, and invite them to ask something else you might be able to help with.${formatDirective}`;
			} else {
				userPrompt = `Answer the user's question as helpfully and completely as possible using your general knowledge.
Do not invent specific facts, prices, features, or policies about this company or its products.
When the question asks for multiple items (examples, case studies, options), present each one with a clear heading and supporting details.

Question: ${query}${formatDirective}`;
			}
		}

		const systemPrompt =
			effectiveSystemMessage.trim() ||
			this.defaultGeneratedSystemPrompt();
		const stylePrompt =
			this.buildWidgetResponseStyleSystemPrompt(
				query,
			);

		const conversationHistory: Array<any> = [
			{
				role: "system",
				content: systemPrompt,
			},
			{
				role: "system",
				content: stylePrompt,
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

			return {
				response:
					completion.choices[0].message.content ||
					this.getFallbackResponse(),
				usage: completion.usage
					? {
							prompt_tokens: completion.usage.prompt_tokens ?? 0,
							completion_tokens:
								completion.usage.completion_tokens ?? 0,
							total_tokens: completion.usage.total_tokens ?? 0,
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
			this.normalizeLanguagePreference(
				language,
			);
		const shouldSkipRetrieval =
			this.isLikelySmallTalk(message);
		const syntheticSessionId = `adhoc:${crypto
			.createHash("sha1")
			.update(`${userId}:${message}`)
			.digest("hex")}`;
		const { matches, sources } = shouldSkipRetrieval
			? { matches: [], sources: [] }
			: await this.retrieveRelevantContext(
					userId,
					message,
					syntheticSessionId,
					[],
			  );
		const ragThreshold = this.ragScoreThreshold(message);
		const relevantMatches =
			this.relevantRagMatches(
				matches,
				ragThreshold,
			);
		const shouldCallLlm =
			shouldSkipRetrieval ||
			relevantMatches.length > 0;
		const fallbackResponse =
			!shouldSkipRetrieval &&
			relevantMatches.length === 0 &&
			(await this.hasActiveScrapeJob(userId))
				? this.getLearningFallbackResponse()
				: this.getFallbackResponse();
		let answer = fallbackResponse;

		if (shouldCallLlm) {
			const completion =
				await this.generateNonStreamingResponse(
					await this.buildChatMessages(
						userId,
						message,
						relevantMatches,
						[],
						resolvedLanguage,
					),
					CHAT_DEFAULT_TIMEOUT_MS,
				);
			answer = completion.response || fallbackResponse;
		}

		answer = this.formatAssistantResponse(
			answer,
			message,
			"this website",
		);

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
			const session = await this.getOrCreateSession(userId, sessionId);
			timing.sessionMs = Date.now() - sessionStart;

			const saveStart = Date.now();
			const userTimestamp = await this.persistMessage(
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
			const shouldSkipRetrieval = this.isLikelySmallTalk(message);
			const { matches, sources } = shouldSkipRetrieval
				? {
						matches: [],
						sources: [],
				  }
				: await this.retrieveRelevantContext(
						userId,
						message,
						session.sessionId,
						historyMessages,
				  );
			timing.retrievalMs = Date.now() - retrievalStart;
			const relevantMatches =
				this.relevantRagMatches(
					matches,
					this.ragScoreThreshold(message),
				);
			const shouldCallLlm =
				shouldSkipRetrieval ||
				relevantMatches.length > 0;

			const fallbackResponse =
				!shouldSkipRetrieval &&
				relevantMatches.length === 0 &&
				(await this.hasActiveScrapeJob(userId))
					? this.getLearningFallbackResponse()
					: this.getFallbackResponse();
			let assistantResponse = fallbackResponse;
			let usedFallback =
				!shouldCallLlm;
			let usage: CompletionUsage | undefined;
			const llmStart = Date.now();
			if (shouldCallLlm) {
				try {
					const conversationHistory =
						await this.buildChatMessages(
							userId,
							message,
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
					usage =
						completionResult.usage;
					usedFallback =
						assistantResponse ===
						fallbackResponse;
				} catch (error) {
					logger.error("Chat generation failed, using fallback", {
						error,
						userId,
					});
					usedFallback = true;
				}
			}
			assistantResponse = this.formatAssistantResponse(
				assistantResponse,
				message,
				"this website",
			);
			timing.llmMs = Date.now() - llmStart;

			const usageMeta =
				this.buildUsageMetadata(usage);
			const assistantTimestamp = await this.persistMessage(
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
		const timeoutMs = options?.timeoutMs ?? CHAT_DEFAULT_TIMEOUT_MS;
		const resolvedLanguage =
			this.normalizeLanguagePreference(
				language,
			);

		const sessionStart = Date.now();
		const session = await this.getOrCreateSession(userId, sessionId);
		timing.sessionMs = Date.now() - sessionStart;

		const saveStart = Date.now();
		const userTimestamp = await this.persistMessage(
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
		const shouldSkipRetrieval = this.isLikelySmallTalk(message);
		const { matches, sources } = shouldSkipRetrieval
			? { matches: [], sources: [] }
			: await this.retrieveRelevantContext(
					userId,
					message,
					session.sessionId,
					historyMessages,
			  );
		timing.retrievalMs = Date.now() - retrievalStart;
		const relevantMatches =
			this.relevantRagMatches(
				matches,
				this.ragScoreThreshold(message),
			);
		const shouldCallLlm =
			shouldSkipRetrieval ||
			relevantMatches.length > 0;

		const fallbackResponse = this.getFallbackResponse();
		let assistantResponse =
			!shouldSkipRetrieval &&
			relevantMatches.length === 0 &&
			(await this.hasActiveScrapeJob(userId))
				? this.getLearningFallbackResponse()
				: fallbackResponse;
		let usedFallback = !shouldCallLlm;
		let usage: CompletionUsage | undefined;
		const llmStart = Date.now();
		if (shouldCallLlm) {
			const timeoutController = new AbortController();
			const timeout = setTimeout(() => {
				timeoutController.abort("OpenAI stream timeout");
			}, timeoutMs);
			assistantResponse = "";
			try {
				const conversationHistory =
					await this.buildChatMessages(
						userId,
						message,
						relevantMatches,
						historyMessages,
						resolvedLanguage,
					);
				const stream =
					await openAICircuitBreaker.execute(async () => {
						return await this.openai.chat.completions.create(
							{
								model: CHAT_COMPLETION_MODEL,
								messages: conversationHistory,
								temperature: CHAT_COMPLETION_TEMPERATURE,
								max_tokens: CHAT_COMPLETION_MAX_TOKENS,
								stream: true,
								stream_options: { include_usage: true },
							},
							{
								signal: timeoutController.signal,
							},
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
					const token =
						chunk.choices?.[0]?.delta?.content ??
						"";
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
					assistantResponse = fallbackResponse;
					usedFallback = true;
				}
			} finally {
				clearTimeout(timeout);
			}
		}
		timing.llmMs = Date.now() - llmStart;

		if (!assistantResponse.trim()) {
			assistantResponse = fallbackResponse;
			usedFallback = true;
		}
		assistantResponse = this.formatAssistantResponse(
			assistantResponse,
			message,
			"this website",
		);

		const usageMeta = this.buildUsageMetadata(usage);
		const assistantTimestamp = await this.persistMessage(
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

		logger.info("Chat streaming response generated", {
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
			timing,
		};
	}

	async getSession(sessionId: string): Promise<ChatSession | null> {
		const normalized = this.normalizeSessionId(sessionId);
		if (!normalized) return null;

		const conversationResult = await pool.query<ConversationRow>(
			`SELECT id, user_id, widget_key_id, visitor_id, created_at, updated_at
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
			[normalized, userId, widgetKeyId, visitorId],
		);
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

