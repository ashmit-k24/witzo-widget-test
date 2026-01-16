import { Request, Response } from "express";
import { chatService } from "../services/chatService";
import { ChatRequest } from "../types";
import logger from "../utils/logger";

export const chat = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const { sessionId, message } =
			req.body as ChatRequest;
		const userId = (req.user as any)?.id;

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
			messageLength: message.length,
		});

		const result = await chatService.chat(
			userId,
			message,
			sessionId,
		);

		// Add usage stats from middleware if available
		const usage = (res.locals as any).usage;

		const responseData: any = {
			success: true,
			sessionId: result.sessionId,
			response: result.response,
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
			error:
				error instanceof Error
					? error.message
					: "Unknown error",
		});
	}
};

export const getChatSession = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const { sessionId } = req.params;
		const userId = (req.user as any)?.id;

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
				userId: session.userId,
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
			error:
				error instanceof Error
					? error.message
					: "Unknown error",
		});
	}
};

export const clearChatSession = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const { sessionId } = req.params;
		const userId = (req.user as any)?.id;

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
			error:
				error instanceof Error
					? error.message
					: "Unknown error",
		});
	}
};

export const clearUserSessions = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = (req.user as any)?.id;

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
			error:
				error instanceof Error
					? error.message
					: "Unknown error",
		});
	}
};
