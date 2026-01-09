import { v4 as uuidv4 } from "uuid";
import pool from "../config/database";
import { redis } from "../config/redis";
import logger from "../utils/logger";

const WIDGET_KEY_CACHE_TTL = 3600; // 1 hour
const ANALYTICS_BUFFER_KEY = "analytics:buffer";
const ANALYTICS_BATCH_SIZE = 100;

export interface WidgetKey {
     id: number;
     user_id: string;
     widget_key: string;
     widget_name: string;
     is_active: boolean;
     allowed_domains: string[] | null;
     widget_config: WidgetConfig;
     created_at: Date;
     updated_at: Date;
     last_used_at: Date | null;
     usage_count: number;
}

export interface WidgetConfig {
     primaryText?: string;
     botColor?: string;
     sendColor?: string;
     floatingBtn?: string;
     chatVoiceIconColor?: string;
     voiceSendButton?: string;
     autoOpen?: boolean;
     bannerText?: string;
     bannerTextColor?: string;
     closeButtonColor?: string;
     logoIcon?: string;
     bannerColor?: string;
     userChatColor?: string;
     [key: string]: any;
}

export interface CreateWidgetKeyParams {
     userId: string;
     widgetName?: string;
     allowedDomains?: string[];
     widgetConfig?: WidgetConfig;
}

class WidgetService {
     /**
      * Generate a unique widget key
      */
     private generateWidgetKey(): string {
          return `wk_${uuidv4().replace(/-/g, "")}`;
     }

     private getCacheKey(widgetKey: string): string {
          return `widget_key:${widgetKey}`;
     }

     /**
      * Create a new widget key for a user
      */
     async createWidgetKey(params: CreateWidgetKeyParams): Promise<WidgetKey> {
          const { userId, widgetName = "My Chat Widget", allowedDomains = null, widgetConfig = {} } = params;

          try {
               // Check if user already has a widget key
               const existingKey = await this.getUserWidgetKey(userId);
               if (existingKey) {
                    throw new Error("User already has a widget key. Use updateWidgetKey to modify it.");
               }

               const widgetKey = this.generateWidgetKey();

               const result = await pool.query(
                    `INSERT INTO widget_keys
                    (user_id, widget_key, widget_name, allowed_domains, widget_config)
                    VALUES ($1, $2, $3, $4, $5)
                    RETURNING *`,
                    [userId, widgetKey, widgetName, allowedDomains, JSON.stringify(widgetConfig)]
               );

               const widget = this.mapRowToWidgetKey(result.rows[0]);

               // Cache the new key
               await redis.setex(this.getCacheKey(widgetKey), WIDGET_KEY_CACHE_TTL, JSON.stringify(widget));

               logger.info("Widget key created", { userId, widgetKey });
               return widget;
          } catch (error) {
               logger.error("Error creating widget key", { error, userId });
               throw error;
          }
     }

     /**
      * Get widget key by key string (Cached)
      */
     async getWidgetKeyByKey(widgetKey: string): Promise<WidgetKey | null> {
          try {
               // Try cache first
               const cached = await redis.get(this.getCacheKey(widgetKey));
               if (cached) {
                    return JSON.parse(cached);
               }

               const result = await pool.query(`SELECT * FROM widget_keys WHERE widget_key = $1`, [widgetKey]);

               if (result.rows.length === 0) {
                    return null;
               }

               const widget = this.mapRowToWidgetKey(result.rows[0]);

               // Cache result
               await redis.setex(this.getCacheKey(widgetKey), WIDGET_KEY_CACHE_TTL, JSON.stringify(widget));

               return widget;
          } catch (error) {
               logger.error("Error fetching widget key", { error, widgetKey });
               throw error;
          }
     }

     /**
      * Get user's widget key
      */
     async getUserWidgetKey(userId: string): Promise<WidgetKey | null> {
          try {
               // We don't cache by userID easily because primary lookup is by key
               // But we could add a secondary cache if needed
               const result = await pool.query(`SELECT * FROM widget_keys WHERE user_id = $1`, [userId]);

               if (result.rows.length === 0) {
                    return null;
               }

               return this.mapRowToWidgetKey(result.rows[0]);
          } catch (error) {
               logger.error("Error fetching user widget key", { error, userId });
               throw error;
          }
     }

     /**
      * Verify widget key and check domain restrictions
      */
     async verifyWidgetKey(widgetKey: string, refererDomain?: string): Promise<{ valid: boolean; userId?: string; message?: string }> {
          try {
               const widget = await this.getWidgetKeyByKey(widgetKey);

               if (!widget) {
                    return { valid: false, message: "Invalid widget key" };
               }

               if (!widget.is_active) {
                    return { valid: false, message: "Widget key is inactive" };
               }

               // Check domain restrictions
               if (widget.allowed_domains && widget.allowed_domains.length > 0 && refererDomain) {
                    const isAllowed = widget.allowed_domains.some((domain) => {
                         // Support wildcard domains like *.example.com
                         if (domain.startsWith("*.")) {
                              const baseDomain = domain.slice(2);
                              return refererDomain.endsWith(baseDomain);
                         }
                         return refererDomain === domain || refererDomain.endsWith(`.${domain}`);
                    });

                    if (!isAllowed) {
                         return { valid: false, message: "Domain not allowed" };
                    }
               }

               // Update usage stats (fire and forget, maybe buffered later if needed)
               this.updateWidgetUsage(widget.id);

               return { valid: true, userId: widget.user_id };
          } catch (error) {
               logger.error("Error verifying widget key", { error, widgetKey });
               return { valid: false, message: "Error verifying widget key" };
          }
     }

     /**
      * Update widget key configuration
      */
     async updateWidgetKey(
          userId: string,
          updates: {
               widgetName?: string;
               isActive?: boolean;
               allowedDomains?: string[];
               widgetConfig?: WidgetConfig;
          }
     ): Promise<WidgetKey> {
          try {
               const setClauses: string[] = [];
               const values: any[] = [];
               let paramIndex = 1;

               if (updates.widgetName !== undefined) {
                    setClauses.push(`widget_name = $${paramIndex++}`);
                    values.push(updates.widgetName);
               }

               if (updates.isActive !== undefined) {
                    setClauses.push(`is_active = $${paramIndex++}`);
                    values.push(updates.isActive);
               }

               if (updates.allowedDomains !== undefined) {
                    setClauses.push(`allowed_domains = $${paramIndex++}`);
                    values.push(updates.allowedDomains);
               }

               if (updates.widgetConfig !== undefined) {
                    setClauses.push(`widget_config = $${paramIndex++}`);
                    values.push(JSON.stringify(updates.widgetConfig));
               }

               setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
               values.push(userId);

               const result = await pool.query(
                    `UPDATE widget_keys
                    SET ${setClauses.join(", ")}
                    WHERE user_id = $${paramIndex}
                    RETURNING *`,
                    values
               );

               if (result.rows.length === 0) {
                    throw new Error("Widget key not found");
               }

               const widget = this.mapRowToWidgetKey(result.rows[0]);

               // Invalidate cache
               await redis.del(this.getCacheKey(widget.widget_key));

               logger.info("Widget key updated", { userId });
               return widget;
          } catch (error) {
               logger.error("Error updating widget key", { error, userId });
               throw error;
          }
     }

     /**
      * Update widget usage statistics (Now just DB update, low priority)
      */
     private async updateWidgetUsage(widgetKeyId: number): Promise<void> {
          try {
               await pool.query(
                    `UPDATE widget_keys
                    SET last_used_at = CURRENT_TIMESTAMP,
                        usage_count = usage_count + 1
                    WHERE id = $1`,
                    [widgetKeyId]
               );
          } catch (error) {
               logger.error("Error updating widget usage", { error, widgetKeyId });
          }
     }

     /**
      * Track widget analytics event (Buffered)
      */
     async trackWidgetEvent(widgetKey: string, eventType: string, eventData: any = {}, metadata?: { ipAddress?: string; userAgent?: string; refererUrl?: string }): Promise<void> {
          try {
               // We verify key exists quickly via cache
               const widget = await this.getWidgetKeyByKey(widgetKey);
               if (!widget) return;

               const event = {
                    widget_key_id: widget.id,
                    event_type: eventType,
                    event_data: eventData,
                    ip_address: metadata?.ipAddress,
                    user_agent: metadata?.userAgent,
                    referer_url: metadata?.refererUrl,
                    created_at: new Date().toISOString()
               };

               // Push to Redis Buffer
               await redis.lpush(ANALYTICS_BUFFER_KEY, JSON.stringify(event));
          } catch (error) {
               logger.error("Error tracing widget event", { error, widgetKey, eventType });
          }
     }

     /**
      * Flush buffered analytics to Database
      */
     async flushAnalytics(): Promise<void> {
          try {
               const len = await redis.llen(ANALYTICS_BUFFER_KEY);
               if (len === 0) return;

               const batchSize = Math.min(len, ANALYTICS_BATCH_SIZE);
               const eventsStr = await redis.rpop(ANALYTICS_BUFFER_KEY, batchSize);

               if (!eventsStr || (Array.isArray(eventsStr) && eventsStr.length === 0)) return;

               // Redis implementation of rpop with count returns array (ioredis support?)
               // If ioredis version doesn't support count, we loop. 
               // Assuming standard redis rpop with count support or we use loop.
               // Let's safe guard:
               const events = (Array.isArray(eventsStr) ? eventsStr : [eventsStr])
                    .map(s => s ? JSON.parse(s) : null)
                    .filter(e => e !== null);

               if (events.length === 0) return;

               const client = await pool.connect();
               try {
                    await client.query("BEGIN");

                    for (const event of events) {
                         await client.query(
                              `INSERT INTO widget_analytics
                              (widget_key_id, event_type, event_data, ip_address, user_agent, referer_url, created_at)
                              VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                              [event.widget_key_id, event.event_type, JSON.stringify(event.event_data), event.ip_address, event.user_agent, event.referer_url, event.created_at]
                         );
                    }

                    await client.query("COMMIT");
                    logger.info(`Flushed ${events.length} analytics events to DB`);
               } catch (error) {
                    await client.query("ROLLBACK");
                    logger.error("Error flushing analytics", { error });
                    // Re-queue events? For now we drop them to avoid death loop, or log specifically
               } finally {
                    client.release();
               }
          } catch (error) {
               logger.error("Error in flushAnalytics", { error });
          }
     }

     /**
      * Delete widget key
      */
     async deleteWidgetKey(userId: string): Promise<void> {
          try {
               const currentWidget = await this.getUserWidgetKey(userId);

               await pool.query(`DELETE FROM widget_keys WHERE user_id = $1`, [userId]);

               if (currentWidget) {
                    await redis.del(this.getCacheKey(currentWidget.widget_key));
               }

               logger.info("Widget key deleted", { userId });
          } catch (error) {
               logger.error("Error deleting widget key", { error, userId });
               throw error;
          }
     }

     /**
      * Regenerate widget key (creates new key, keeps same config)
      */
     async regenerateWidgetKey(userId: string): Promise<WidgetKey> {
          try {
               const currentWidget = await this.getUserWidgetKey(userId);
               if (!currentWidget) {
                    throw new Error("No widget key found for user");
               }

               const newWidgetKey = this.generateWidgetKey();

               const result = await pool.query(
                    `UPDATE widget_keys
                    SET widget_key = $1, updated_at = CURRENT_TIMESTAMP
                    WHERE user_id = $2
                    RETURNING *`,
                    [newWidgetKey, userId]
               );

               // Invalidate old key cache
               await redis.del(this.getCacheKey(currentWidget.widget_key));

               // New key will be cached on first read

               logger.info("Widget key regenerated", { userId, newWidgetKey });
               return this.mapRowToWidgetKey(result.rows[0]);
          } catch (error) {
               logger.error("Error regenerating widget key", { error, userId });
               throw error;
          }
     }

     /**
      * Get widget analytics
      */
     async getWidgetAnalytics(userId: string, limit: number = 100): Promise<any[]> {
          try {
               const result = await pool.query(
                    `SELECT wa.*
                    FROM widget_analytics wa
                    JOIN widget_keys wk ON wa.widget_key_id = wk.id
                    WHERE wk.user_id = $1
                    ORDER BY wa.created_at DESC
                    LIMIT $2`,
                    [userId, limit]
               );

               return result.rows;
          } catch (error) {
               logger.error("Error fetching widget analytics", { error, userId });
               throw error;
          }
     }

     /**
      * Map database row to WidgetKey object
      */
     private mapRowToWidgetKey(row: any): WidgetKey {
          return {
               id: row.id,
               user_id: row.user_id,
               widget_key: row.widget_key,
               widget_name: row.widget_name,
               is_active: row.is_active,
               allowed_domains: row.allowed_domains,
               widget_config: row.widget_config || {},
               created_at: row.created_at,
               updated_at: row.updated_at,
               last_used_at: row.last_used_at,
               usage_count: row.usage_count,
          };
     }
}

export default new WidgetService();
