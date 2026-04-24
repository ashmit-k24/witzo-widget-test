import { Request, Response } from "express";
import pool from "../config/database";
import {
	coercePlanType,
	getPlanCapabilities,
} from "../config/planConfig";
import { chatService } from "../services/chatService";
import { ChatRequest } from "../types";
import logger from "../utils/logger";

export const chat = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const {
			sessionId,
			message,
			language,
		} =
			req.body as ChatRequest;
		const userId = req.user?.id;

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		if (!message || !message.trim()) {
			res.status(400).json({
				success: false,
				message:
					"message is required and cannot be empty",
			});
			return;
		}

		logger.info("Processing chat request", {
			userId,
			sessionId,
			language,
			messageLength: message.length,
		});
		const streamRequested =
			req.query.stream === "1" ||
			(req.get("accept") || "").includes(
				"text/event-stream",
			);

		if (streamRequested) {
			const usage = (res.locals as any).usage;
			res.status(200);
			res.setHeader(
				"Content-Type",
				"text/event-stream",
			);
			res.setHeader(
				"Cache-Control",
				"no-cache, no-transform",
			);
			res.setHeader(
				"Connection",
				"keep-alive",
			);
			res.flushHeaders?.();

			const writeEvent = (
				payload: Record<string, any>,
			) => {
				res.write(
					`data: ${JSON.stringify(payload)}\n\n`,
				);
			};

			try {
				const result =
					await chatService.chatStream(
						userId,
						message,
						sessionId,
						{
							onToken: (token) =>
								writeEvent({
									type: "token",
									token,
								}),
						},
						language,
					);

				writeEvent({
					type: "done",
					sessionId: result.sessionId,
					assistantMessageId:
						(
							await chatService.getLatestAssistantMessageMeta(
								result.sessionId,
								userId,
							)
						)?.messageId,
					language: result.language,
					usage: usage
						? {
								conversationsRemaining:
									usage.conversationsRemaining,
								resetDate:
									usage.resetDate,
						  }
						: undefined,
					warning:
						usage?.isApproachingLimit
							? "You're approaching your monthly conversation limit"
							: undefined,
				});
				res.end();
				return;
			} catch (streamError) {
				logger.error(
					"Error in streaming chat controller",
					{ streamError },
				);
				writeEvent({
					type: "error",
					message:
						"Internal server error while processing chat",
				});
				res.end();
				return;
			}
		}

		const result = await chatService.chat(
			userId,
			message,
			sessionId,
			language,
		);

		// Add usage stats from middleware if available
		const usage = (res.locals as any).usage;

		const responseData: any = {
			success: true,
			sessionId: result.sessionId,
			response: result.response,
			assistantMessageId:
				(
					await chatService.getLatestAssistantMessageMeta(
						result.sessionId,
						userId,
					)
				)?.messageId,
			language: result.language,
			// sources: result.sources,
		};

		// Include usage information if available
		if (usage) {
			responseData.usage = {
				conversationsRemaining:
					usage.conversationsRemaining,
				resetDate: usage.resetDate,
			};

			// Add warning if approaching limit
			if (usage.isApproachingLimit) {
				responseData.warning =
					"You're approaching your monthly conversation limit";
			}
		}

		res.status(200).json(responseData);
	} catch (error) {
		logger.error("Error in chat controller", {
			error,
		});
		res.status(500).json({
			success: false,
			message:
				"Internal server error while processing chat",
		});
	}
};

export const getUserChatSessions = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = req.user?.id;
		const userPlanType =
			req.user?.plan_type;
		const planType =
			coercePlanType(userPlanType);
		const planCapabilities =
			getPlanCapabilities(planType);
		const maxVisibleSessions =
			planCapabilities.chatHistoryLimit;

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const sessions =
			await chatService.getUserChatSessions(
				userId,
			);

		// Mark each session as locked if it's beyond the plan's first-created visible limit.
		// We send ALL sessions so the frontend can show real blurred sessions
		// instead of dummy placeholders — but locked sessions get no messages.
		const taggedSessions = sessions.map((s, i) => ({
			...s,
			isLocked: maxVisibleSessions !== null && i >= maxVisibleSessions,
		}));

		res.status(200).json({
			success: true,
			data: taggedSessions,
			meta: {
				planType,
				maxVisibleSessions,
			},
		});
	} catch (error) {
		logger.error(
			"Error getting user chat sessions",
			{ error },
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while retrieving sessions",
		});
	}
};

export const getChatSession = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const { sessionId } = req.params;
		const userId = req.user?.id;

		if (!sessionId) {
			res.status(400).json({
				success: false,
				message: "sessionId is required",
			});
			return;
		}

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const session =
			await chatService.getSession(sessionId);

		if (!session || session.userId !== userId) {
			res.status(404).json({
				success: false,
				message: "Session not found",
			});
			return;
		}

		// Check plan limit — determine if this session is beyond the visible window
		const planType = coercePlanType(req.user?.plan_type);
		const planCapabilities = getPlanCapabilities(planType);
		const maxVisible = planCapabilities.chatHistoryLimit; // null = unlimited

		let isGated = false;
		if (maxVisible !== null) {
			// Find the rank of this session among all sessions ordered by creation time ASC.
			const rankResult = await pool.query<{ rank: string }>(
				`SELECT COUNT(*) AS rank
				 FROM chat_conversations
				 WHERE user_id = $1 AND is_deleted = FALSE
				   AND created_at < (
				     SELECT created_at
				     FROM chat_conversations
				     WHERE id = $2 AND user_id = $1 AND is_deleted = FALSE
				   )`,
				[userId, sessionId],
			);
			// rank = number of sessions older than this one (0-based index)
			const rank = parseInt(rankResult.rows[0]?.rank ?? "0", 10);
			isGated = rank >= maxVisible;
		}

		// Fetch lead info, page views, and message-level feedback details in parallel.
		const [leadResult, pageViewsResult, detailedMessagesResult] = await Promise.all([
			pool.query<{ name: string | null; email: string | null; phone: string | null; country: string | null }>(
				`SELECT name, email, phone, country FROM leads WHERE session_id = $1 AND user_id = $2 LIMIT 1`,
				[session.sessionId, userId],
			),
			pool.query<{ url: string; viewed_at: string }>(
				`SELECT url, viewed_at FROM session_page_views
				 WHERE session_id = $1 AND user_id = $2
				 ORDER BY viewed_at ASC`,
				[session.sessionId, userId],
			).catch(() => ({ rows: [] as { url: string; viewed_at: string }[] })),
			isGated
				? Promise.resolve({
						rows: [] as Array<{
							message_id: string;
							role: "user" | "assistant" | "system";
							content: string;
							timestamp: string;
							feedback_type: "up" | "down" | null;
							feedback_reason: string | null;
							feedback_created_at: string | null;
						}>,
				  })
				: pool.query<{
						message_id: string;
						role: "user" | "assistant" | "system";
						content: string;
						timestamp: string;
						feedback_type: "up" | "down" | null;
						feedback_reason: string | null;
						feedback_created_at: string | null;
				  }>(
						`SELECT
							m.id::text AS message_id,
							m.role,
							m.content,
							m.created_at::text AS timestamp,
							f.feedback_type,
							f.feedback_reason,
							f.created_at::text AS feedback_created_at
						 FROM chat_messages m
						 LEFT JOIN chat_message_feedback f
						   ON f.user_id = m.user_id
						  AND f.session_id = m.conversation_id
						  AND f.message_id = m.id
						 WHERE m.conversation_id = $1
						   AND m.user_id = $2
						 ORDER BY m.created_at ASC, m.id ASC
						 LIMIT 200`,
						[session.sessionId, userId],
				  ),
		]);
		const lead = leadResult.rows[0] ?? null;
		const viewedPages = pageViewsResult.rows.map((r) => ({
			url: r.url,
			timestamp: r.viewed_at,
		}));
		const detailedMessages = detailedMessagesResult.rows.map((row) => ({
			messageId: Number(row.message_id),
			role: row.role,
			content: row.content,
			timestamp: row.timestamp,
			feedbackType: row.feedback_type,
			feedbackReason: row.feedback_reason,
			feedbackCreatedAt: row.feedback_created_at,
		}));
		const sessionRatings = detailedMessages.reduce(
			(acc, message) => {
				if (message.feedbackType === "up") acc.thumbsUp += 1;
				if (message.feedbackType === "down") acc.thumbsDown += 1;
				return acc;
			},
			{ thumbsUp: 0, thumbsDown: 0 },
		);

		res.status(200).json({
			success: true,
			data: {
				sessionId: session.sessionId,
				messageCount: session.messages.length,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
				// Strip messages server-side for gated sessions
				messages: isGated ? [] : detailedMessages,
				ratings: isGated ? { thumbsUp: 0, thumbsDown: 0 } : sessionRatings,
				isGated,
				customerName: lead?.name ?? null,
				customerEmail: lead?.email ?? null,
				customerPhone: lead?.phone ?? null,
				customerCountry: lead?.country ?? null,
				viewedPages,
			},
		});
	} catch (error) {
		logger.error("Error getting chat session", {
			error,
		});
		res.status(500).json({
			success: false,
			message:
				"Internal server error while retrieving session",
		});
	}
};

export const clearChatSession = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const { sessionId } = req.params;
		const userId = req.user?.id;

		if (!sessionId) {
			res.status(400).json({
				success: false,
				message: "sessionId is required",
			});
			return;
		}

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const session =
			await chatService.getSession(sessionId);
		if (!session || session.userId !== userId) {
			res.status(404).json({
				success: false,
				message: "Session not found",
			});
			return;
		}

		const cleared =
			await chatService.clearSession(sessionId);

		if (!cleared) {
			res.status(404).json({
				success: false,
				message: "Session not found",
			});
			return;
		}

		res.status(200).json({
			success: true,
			message: "Session cleared successfully",
		});
	} catch (error) {
		logger.error("Error clearing chat session", {
			error,
		});
		res.status(500).json({
			success: false,
			message:
				"Internal server error while clearing session",
		});
	}
};

export const clearUserSessions = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = req.user?.id;

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const clearedCount =
			await chatService.clearUserSessions(userId);

		res.status(200).json({
			success: true,
			message: `Cleared ${clearedCount} session(s)`,
			clearedCount,
		});
	} catch (error) {
		logger.error("Error clearing user sessions", {
			error,
		});
		res.status(500).json({
			success: false,
			message:
				"Internal server error while clearing user sessions",
		});
	}
};
