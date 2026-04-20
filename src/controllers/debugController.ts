import { NextFunction, Request, Response } from "express";
import pool from "../config/database";
import logger from "../utils/logger";
import { chatService } from "../services/chatService";
import { retrieveRelevantContext as fetchRelevantContext } from "../services/contextRetrievalService";

/**
 * GET /api/admin/debug/prompt?userId=&query=
 *
 * Returns the exact messages array that would be sent to OpenAI for a given
 * userId + query. Use this to audit what the model sees and why it might be
 * giving a poor response.
 */
export const getDebugPrompt = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { userId, query } = req.query as {
			userId?: string;
			query?: string;
		};

		if (!userId || !query) {
			res.status(400).json({
				error: "userId and query are required query parameters",
			});
			return;
		}

		const result = await chatService.buildDebugPrompt(userId, query);

		res.json({
			userId,
			query,
			matchCount: result.matchCount,
			topScore: result.topScore,
			matches: result.matches,
			messages: result.messages,
		});
	} catch (error) {
		logger.error("Debug prompt endpoint failed", {
			error: (error as Error).message,
		});
		next(error);
	}
};

/**
 * POST /api/admin/debug/rag-test
 * Body: { userId: string, queries: string[] }
 *
 * Runs a batch of test queries through the retrieval pipeline (no LLM call)
 * and returns what Pinecone + reranker returns for each. Use to quickly
 * diagnose retrieval quality without going through the full chat flow.
 */
export const runRagTest = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { userId, queries } = req.body as {
			userId?: string;
			queries?: string[];
		};

		if (!userId || !Array.isArray(queries) || queries.length === 0) {
			res.status(400).json({
				error: "userId and queries[] are required",
			});
			return;
		}

		if (queries.length > 20) {
			res.status(400).json({ error: "Maximum 20 queries per batch" });
			return;
		}

		const results = await Promise.all(
			queries.map(async (query) => {
				try {
					const { matches } = await fetchRelevantContext(
						userId,
						query,
						"rag-test",
						[],
					);
					return {
						query,
						matchCount: matches.length,
						topScore: matches[0]?.score ?? matches[0]?.cohereScore ?? null,
						topMatches: matches.slice(0, 3).map((m: any) => ({
							title: m.metadata?.title || "",
							url: m.metadata?.url || "",
							score: m.score ?? m.cohereScore ?? null,
							excerpt: String(
								m.metadata?.parentText || m.metadata?.content || "",
							).slice(0, 200),
						})),
					};
				} catch (err) {
					return {
						query,
						error: (err as Error).message,
					};
				}
			}),
		);

		res.json({ userId, results });
	} catch (error) {
		logger.error("RAG test endpoint failed", {
			error: (error as Error).message,
		});
		next(error);
	}
};

/**
 * GET /api/admin/debug/chat-insights?userId=&days=7
 *
 * Surfaces failure patterns from recent chat sessions:
 * - Fallback rate (% sessions that hit the fallback)
 * - Sessions with zero retrieved sources (no RAG match)
 * - Most common queries that ended with 0 sources
 */
export const getChatInsights = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { userId } = req.query as { userId?: string };
		const days = Math.min(
			parseInt((req.query.days as string) || "7", 10),
			30,
		);

		const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

		// Total conversations in window
		const totalResult = await pool.query<{ count: string }>(
			`SELECT COUNT(*) AS count
			 FROM chat_conversations
			 WHERE created_at >= $1
			 ${userId ? "AND user_id = $2" : ""}`,
			userId ? [since, userId] : [since],
		);

		// Fallback messages (isFallback = true stored in metadata)
		const fallbackResult = await pool.query<{ count: string }>(
			`SELECT COUNT(*) AS count
			 FROM chat_messages
			 WHERE role = 'assistant'
			   AND created_at >= $1
			   AND (metadata->>'isFallback')::boolean = true
			   ${userId ? "AND conversation_id IN (SELECT id FROM chat_conversations WHERE user_id = $2)" : ""}`,
			userId ? [since, userId] : [since],
		);

		// Total assistant messages
		const totalMsgResult = await pool.query<{ count: string }>(
			`SELECT COUNT(*) AS count
			 FROM chat_messages
			 WHERE role = 'assistant'
			   AND created_at >= $1
			   ${userId ? "AND conversation_id IN (SELECT id FROM chat_conversations WHERE user_id = $2)" : ""}`,
			userId ? [since, userId] : [since],
		);

		// Zero-source assistant messages — model answered without any RAG context
		const zeroSourceResult = await pool.query<{ count: string }>(
			`SELECT COUNT(*) AS count
			 FROM chat_messages
			 WHERE role = 'assistant'
			   AND created_at >= $1
			   AND (metadata->>'sourcesCount')::int = 0
			   ${userId ? "AND conversation_id IN (SELECT id FROM chat_conversations WHERE user_id = $2)" : ""}`,
			userId ? [since, userId] : [since],
		);

		// Recent user queries that got zero sources — the most actionable failure signal
		const zeroSourceQueriesResult = await pool.query<{
			content: string;
			created_at: Date;
		}>(
			`SELECT u.content, u.created_at
			 FROM chat_messages u
			 JOIN chat_messages a ON a.conversation_id = u.conversation_id
			   AND a.role = 'assistant'
			   AND (a.metadata->>'sourcesCount')::int = 0
			 WHERE u.role = 'user'
			   AND u.created_at >= $1
			   ${userId ? "AND u.conversation_id IN (SELECT id FROM chat_conversations WHERE user_id = $2)" : ""}
			 ORDER BY u.created_at DESC
			 LIMIT 20`,
			userId ? [since, userId] : [since],
		);

		const total = parseInt(totalResult.rows[0]?.count ?? "0", 10);
		const fallbackCount = parseInt(fallbackResult.rows[0]?.count ?? "0", 10);
		const totalMsg = parseInt(totalMsgResult.rows[0]?.count ?? "0", 10);
		const zeroSourceCount = parseInt(zeroSourceResult.rows[0]?.count ?? "0", 10);

		res.json({
			periodDays: days,
			userId: userId ?? "all",
			conversations: total,
			assistantMessages: totalMsg,
			fallbackRate:
				totalMsg > 0
					? `${((fallbackCount / totalMsg) * 100).toFixed(1)}%`
					: "0%",
			zeroSourceRate:
				totalMsg > 0
					? `${((zeroSourceCount / totalMsg) * 100).toFixed(1)}%`
					: "0%",
			zeroSourceQueries: zeroSourceQueriesResult.rows.map((r) => ({
				query: r.content,
				at: r.created_at,
			})),
		});
	} catch (error) {
		logger.error("Chat insights endpoint failed", {
			error: (error as Error).message,
		});
		next(error);
	}
};
