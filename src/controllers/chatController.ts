import { Request, Response } from "express";
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
		const limitedSessions =
			maxVisibleSessions === null
				? sessions
				: sessions.slice(
						0,
						maxVisibleSessions,
				  );

		res.status(200).json({
			success: true,
			data: limitedSessions,
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

		res.status(200).json({
			success: true,
			data: {
				sessionId: session.sessionId,
				messageCount: session.messages.length,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
				messages: session.messages,
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
