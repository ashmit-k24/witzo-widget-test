import { Request, Response } from "express";
import { chatService } from "../services/chatService";
import { ChatRequest } from "../types";
import logger from "../utils/logger";

export const chat = async (req: Request, res: Response): Promise<void> => {
     try {
          const { userId, sessionId, message } = req.body as ChatRequest;

          if (!userId) {
               res.status(400).json({
                    success: false,
                    message: "userId is required",
               });
               return;
          }

          if (!message || !message.trim()) {
               res.status(400).json({
                    success: false,
                    message: "message is required and cannot be empty",
               });
               return;
          }

          logger.info("Processing chat request", {
               userId,
               sessionId,
               messageLength: message.length,
          });

          const result = await chatService.chat(userId, message, sessionId);

          res.status(200).json({
               success: true,
               sessionId: result.sessionId,
               response: result.response,
               // sources: result.sources,
          });
     } catch (error) {
          logger.error("Error in chat controller", { error });
          res.status(500).json({
               success: false,
               message: "Internal server error while processing chat",
               error: error instanceof Error ? error.message : "Unknown error",
          });
     }
};

export const getChatSession = async (req: Request, res: Response): Promise<void> => {
     try {
          const { sessionId } = req.params;

          if (!sessionId) {
               res.status(400).json({
                    success: false,
                    message: "sessionId is required",
               });
               return;
          }

          const session = chatService.getSession(sessionId);

          if (!session) {
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
          logger.error("Error getting chat session", { error });
          res.status(500).json({
               success: false,
               message: "Internal server error while retrieving session",
               error: error instanceof Error ? error.message : "Unknown error",
          });
     }
};

export const clearChatSession = async (req: Request, res: Response): Promise<void> => {
     try {
          const { sessionId } = req.params;

          if (!sessionId) {
               res.status(400).json({
                    success: false,
                    message: "sessionId is required",
               });
               return;
          }

          const cleared = chatService.clearSession(sessionId);

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
          logger.error("Error clearing chat session", { error });
          res.status(500).json({
               success: false,
               message: "Internal server error while clearing session",
               error: error instanceof Error ? error.message : "Unknown error",
          });
     }
};

export const clearUserSessions = async (req: Request, res: Response): Promise<void> => {
     try {
          const { userId } = req.body;

          if (!userId) {
               res.status(400).json({
                    success: false,
                    message: "userId is required",
               });
               return;
          }

          const clearedCount = chatService.clearUserSessions(userId);

          res.status(200).json({
               success: true,
               message: `Cleared ${clearedCount} session(s)`,
               clearedCount,
          });
     } catch (error) {
          logger.error("Error clearing user sessions", { error });
          res.status(500).json({
               success: false,
               message: "Internal server error while clearing user sessions",
               error: error instanceof Error ? error.message : "Unknown error",
          });
     }
};
