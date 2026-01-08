import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config/env";
import { ChatMessage, ChatSession } from "../types";
import logger from "../utils/logger";
import { pineconeService } from "./pineconeService";

class ChatService {
     private openai: OpenAI;
     private sessions: Map<string, ChatSession> = new Map();

     constructor() {
          this.openai = new OpenAI({
               apiKey: config.OPENAI_API_KEY,
          });
     }

     private getOrCreateSession(userId: string, sessionId?: string): ChatSession {
          if (sessionId && this.sessions.has(sessionId)) {
               const session = this.sessions.get(sessionId)!;
               if (session.userId === userId) {
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

          this.sessions.set(newSessionId, newSession);
          return newSession;
     }

     private async retrieveRelevantContext(
          userId: string,
          query: string,
          topK: number = 5
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
               const session = this.getOrCreateSession(userId, sessionId);

               const userMessage: ChatMessage = {
                    role: "user",
                    content: message,
                    timestamp: new Date(),
               };
               session.messages.push(userMessage);

               const { context, sources } = await this.retrieveRelevantContext(userId, message);

               // Build conversation history with prompt caching
               // The system prompt and context will be cached to reduce token costs
               const conversationHistory: Array<any> = [
                    {
                         role: "system",
                         content: [
                              {
                                   type: "text",
                                   text: `You are a helpful AI assistant that answers questions based ONLY on the provided context from the user's scraped website data.

IMPORTANT RULES:
1. Answer questions ONLY using the information from the provided context
2. If the answer is not in the context, respond with: "I don't have data related to your question in the scraped content."
3. Do not use any external knowledge or make up information
4. Be concise and accurate
5. Always cite which source you're using when answering`,
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
                    model: "gpt-4o",  // Using GPT-4o for faster responses
                    messages: conversationHistory,
                    temperature: 0.3,
                    max_tokens: 500,
                    store: true,  // Enable prompt caching
               });

               const assistantResponse = completion.choices[0].message.content || "I apologize, but I couldn't generate a response.";

               const assistantMessage: ChatMessage = {
                    role: "assistant",
                    content: assistantResponse,
                    timestamp: new Date(),
               };
               session.messages.push(assistantMessage);
               session.updatedAt = new Date();

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

     getSession(sessionId: string): ChatSession | undefined {
          return this.sessions.get(sessionId);
     }

     clearSession(sessionId: string): boolean {
          return this.sessions.delete(sessionId);
     }

     clearUserSessions(userId: string): number {
          let count = 0;
          for (const [sessionId, session] of this.sessions.entries()) {
               if (session.userId === userId) {
                    this.sessions.delete(sessionId);
                    count++;
               }
          }
          return count;
     }
}

export const chatService = new ChatService();
