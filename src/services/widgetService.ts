import { v4 as uuidv4 } from "uuid";
import pool from "../config/database";
import logger from "../utils/logger";

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

               logger.info("Widget key created", { userId, widgetKey });
               return this.mapRowToWidgetKey(result.rows[0]);
          } catch (error) {
               logger.error("Error creating widget key", { error, userId });
               throw error;
          }
     }

     /**
      * Get widget key by key string
      */
     async getWidgetKeyByKey(widgetKey: string): Promise<WidgetKey | null> {
          try {
               const result = await pool.query(`SELECT * FROM widget_keys WHERE widget_key = $1`, [widgetKey]);

               if (result.rows.length === 0) {
                    return null;
               }

               return this.mapRowToWidgetKey(result.rows[0]);
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

               // Update last used timestamp and usage count
               await this.updateWidgetUsage(widget.id);

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

               logger.info("Widget key updated", { userId });
               return this.mapRowToWidgetKey(result.rows[0]);
          } catch (error) {
               logger.error("Error updating widget key", { error, userId });
               throw error;
          }
     }

     /**
      * Update widget usage statistics
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
      * Track widget analytics event
      */
     async trackWidgetEvent(widgetKey: string, eventType: string, eventData: any = {}, metadata?: { ipAddress?: string; userAgent?: string; refererUrl?: string }): Promise<void> {
          try {
               const widget = await this.getWidgetKeyByKey(widgetKey);
               if (!widget) {
                    return;
               }

               await pool.query(
                    `INSERT INTO widget_analytics
                    (widget_key_id, event_type, event_data, ip_address, user_agent, referer_url)
                    VALUES ($1, $2, $3, $4, $5, $6)`,
                    [widget.id, eventType, JSON.stringify(eventData), metadata?.ipAddress || null, metadata?.userAgent || null, metadata?.refererUrl || null]
               );
          } catch (error) {
               logger.error("Error tracking widget event", { error, widgetKey, eventType });
          }
     }

     /**
      * Delete widget key
      */
     async deleteWidgetKey(userId: string): Promise<void> {
          try {
               await pool.query(`DELETE FROM widget_keys WHERE user_id = $1`, [userId]);
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
