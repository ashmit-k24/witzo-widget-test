import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config/env";
import { redis } from "../config/redis";
import { ChatMessage, ChatSession } from "../types";
import logger from "../utils/logger";
import { pineconeService } from "./pineconeService";

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days

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

     private getUserSessionsKey(userId: string): string {
          return `chat:user_sessions:${userId}`;
     }

     private async getOrCreateSession(userId: string, sessionId?: string): Promise<ChatSession> {
          if (sessionId) {
               const session = await this.getSession(sessionId);
               if (session && session.userId === userId) {
                    return session;
               }
          }

          const newSessionId = sessionId || uuidv4();
          const newSession: ChatSession = {
               sessionId: newSessionId,
               userId,
               messages: [],
               createdAt: new Date(),
               updatedAt: new Date(),
          };

          await this.saveSession(newSession);

          // Track session for user
          await redis.sadd(this.getUserSessionsKey(userId), newSessionId);

          return newSession;
     }

     private async saveSession(session: ChatSession): Promise<void> {
          const key = this.getSessionKey(session.sessionId);
          await redis.setex(key, SESSION_TTL, JSON.stringify(session));
     }

     private async retrieveRelevantContext(
          userId: string,
          query: string,
          topK: number = 15
     ): Promise<{
          context: string;
          sources: Array<{ url: string; title: string; relevanceScore: number }>;
     }> {
          try {
               const results = await pineconeService.queryDocuments(userId, query, topK);

               if (!results || results.length === 0) {
                    return { context: "", sources: [] };
               }

               const contextPieces: string[] = [];
               const sources: Array<{ url: string; title: string; relevanceScore: number }> = [];

               for (const match of results) {
                    if (match.metadata && match.metadata.content) {
                         contextPieces.push(`[Source: ${match.metadata.title || match.metadata.url}]\n${match.metadata.content}`);

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
               return { context, sources };
          } catch (error) {
               logger.error("Error retrieving context from Pinecone", { error, userId });
               return { context: "", sources: [] };
          }
     }

     async chat(
          userId: string,
          message: string,
          sessionId?: string
     ): Promise<{
          sessionId: string;
          response: string;
          sources: Array<{ url: string; title: string; relevanceScore: number }>;
     }> {
          try {
               const session = await this.getOrCreateSession(userId, sessionId);

               const userMessage: ChatMessage = {
                    role: "user",
                    content: message,
                    timestamp: new Date(),
               };
               session.messages.push(userMessage);

               const { context, sources } = await this.retrieveRelevantContext(userId, message);

               // Build conversation history with prompt caching
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
                                   cache_control: { type: "ephemeral" }
                              },
                              {
                                   type: "text",
                                   text: `\n\nContext from scraped websites:\n${context || "No relevant context found."}`,
                                   cache_control: { type: "ephemeral" }
                              }
                         ]
                    }
               ];

               const recentMessages = session.messages.slice(-10);
               for (const msg of recentMessages) {
                    conversationHistory.push({
                         role: msg.role,
                         content: msg.content,
                    });
               }

               const completion = await this.openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: conversationHistory,
                    temperature: 0.3,
                    max_tokens: 500,
                    store: true,
               });

               const assistantResponse = completion.choices[0].message.content || "I apologize, but I couldn't generate a response.";

               const assistantMessage: ChatMessage = {
                    role: "assistant",
                    content: assistantResponse,
                    timestamp: new Date(),
               };
               session.messages.push(assistantMessage);
               session.updatedAt = new Date();

               await this.saveSession(session);

               logger.info("Chat response generated", {
                    userId,
                    sessionId: session.sessionId,
                    sourcesCount: sources.length,
               });

               return {
                    sessionId: session.sessionId,
                    response: assistantResponse,
                    sources,
               };
          } catch (error) {
               logger.error("Error in chat service", { error, userId });
               throw error;
          }
     }

     async getSession(sessionId: string): Promise<ChatSession | null> {
          const key = this.getSessionKey(sessionId);
          const data = await redis.get(key);
          if (!data) return null;
          return JSON.parse(data);
     }

     async clearSession(sessionId: string): Promise<boolean> {
          const session = await this.getSession(sessionId);
          if (session) {
               const key = this.getSessionKey(sessionId);
               await redis.del(key);
               await redis.srem(this.getUserSessionsKey(session.userId), sessionId);
               return true;
          }
          return false;
     }

     async clearUserSessions(userId: string): Promise<number> {
          const userSessionsKey = this.getUserSessionsKey(userId);
          const sessionIds = await redis.smembers(userSessionsKey);

          if (sessionIds.length === 0) return 0;

          const pipeline = redis.pipeline();

          // Delete all individual session keys
          for (const sessionId of sessionIds) {
               pipeline.del(this.getSessionKey(sessionId));
          }

          // Delete the user's session list
          pipeline.del(userSessionsKey);

          await pipeline.exec();

          return sessionIds.length;
     }
}

export const chatService = new ChatService();
