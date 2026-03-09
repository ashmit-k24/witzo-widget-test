import crypto from "crypto";
import {
	coercePlanType,
	PlanType,
} from "../config/planConfig";
import pool from "../config/database";
import { config } from "../config/env";
import {
	redisAnalytics,
	redisCache,
} from "../config/redis";
import {
	WIDGET_ANALYTICS_BATCH_SIZE,
	WIDGET_ANALYTICS_BUFFER_KEY,
	WIDGET_KEY_CACHE_TTL_SECONDS,
} from "../constants";
import logger from "../utils/logger";

export interface WidgetKey {
	id: number;
	user_id: string;
	company_website: string | null;
	widget_key: string;
	widget_name: string;
	is_active: boolean;
	allowed_domains: string[] | null;
	widget_config: WidgetConfig;
	created_at: Date;
	updated_at: Date;
	last_used_at: Date | null;
	usage_count: number;
	plan_type: PlanType;
}

export interface WidgetConfig {
	primaryText?: string;
	botColor?: string;
	sendColor?: string;
	floatingBtn?: string;
	floatingBtnColor?: string;
	chatVoiceIconColor?: string;
	voiceSendButton?: string;
	autoOpen?: boolean;
	bannerText?: string;
	bannerTextColor?: string;
	closeButtonColor?: string;
	logoIcon?: string;
	bannerColor?: string;
	userChatColor?: string;
	introTitle?: string;
	introMessage?: string;
	introHelpOptionOneText?: string;
	introHelpOptionOneUrl?: string;
	introHelpOptionTwoText?: string;
	introHelpOptionTwoUrl?: string;
	introPrimaryButtonText?: string;
	introSecondaryButtonText?: string;
	introPrimaryButtonColor?: string;
	introSecondaryButtonColor?: string;
	introPrimaryButtonBackgroundColor?: string;
	introSecondaryButtonBackgroundColor?: string;
	[key: string]: any;
}

export interface CreateWidgetKeyParams {
	userId: string;
	widgetName?: string;
	allowedDomains?: string[];
	widgetConfig?: WidgetConfig;
}

export interface WidgetInstallationStatus {
	installationStatus: "installed" | "not_installed";
	installedAt: string | null;
	installedDomain: string | null;
}

class WidgetService {
	private readonly originTokenTtlMs =
		12 * 60 * 60 * 1000;

	/**
	 * Generate a unique widget key
	 */
	private generateWidgetKey(): string {
		return `wk_${crypto.randomUUID().replace(/-/g, "")}`;
	}

	private getCacheKey(widgetKey: string): string {
		return `widget_key:${widgetKey}`;
	}

	private normalizeDomain(
		value: string,
	): string | null {
		const trimmed = value.trim();
		if (!trimmed) {
			return null;
		}

		const isWildcard =
			trimmed.startsWith("*.");
		const candidate = isWildcard
			? trimmed.slice(2)
			: trimmed;
		const withProtocol =
			/^https?:\/\//i.test(candidate)
				? candidate
				: `https://${candidate}`;

		try {
			const hostname = new URL(withProtocol).hostname
				.toLowerCase()
				.replace(/\.$/, "");
			if (!hostname) {
				return null;
			}
			return isWildcard
				? `*.${hostname}`
				: hostname;
		} catch {
			return null;
		}
	}

	private normalizeAllowedDomains(
		domains?: string[] | null,
	): string[] | null {
		if (!domains) {
			return null;
		}

		const normalized = Array.from(
			new Set(
				domains
					.map((domain) =>
						this.normalizeDomain(domain),
					)
					.filter(
						(
							domain,
						): domain is string => Boolean(domain),
					),
			),
		);

		return normalized.length > 0
			? normalized
			: null;
	}

	private getEffectiveAllowedDomains(
		widget: WidgetKey,
	): string[] | null {
		return this.normalizeAllowedDomains(
			widget.allowed_domains,
		);
	}

	private getInternalWidgetDomains(): Set<string> {
		const candidates = [
			config.FRONTEND_URL,
			config.ADMIN_FRONTEND_URL,
			process.env.WIDGET_API_URL,
		];

		return new Set(
			candidates
				.map((value) =>
					typeof value === "string"
						? this.normalizeDomain(value)
						: null,
				)
				.filter(
					(domain): domain is string =>
						Boolean(domain),
				),
		);
	}

	private matchesAllowedDomain(
		refererDomain: string,
		allowedDomains: string[],
	): boolean {
		return allowedDomains.some((domain) => {
			const sanitizedDomain = domain
				.replace(/^https?:\/\//i, "")
				.toLowerCase();
			if (!sanitizedDomain) {
				return false;
			}

			if (sanitizedDomain.startsWith("*.")) {
				const baseDomain =
					sanitizedDomain.slice(2);
				return (
					refererDomain === baseDomain ||
					refererDomain.endsWith(
						`.${baseDomain}`,
					)
				);
			}

			return (
				refererDomain === sanitizedDomain ||
				refererDomain.endsWith(
					`.${sanitizedDomain}`,
				)
			);
		});
	}

	createOriginToken(
		widgetKey: string,
		originDomain: string,
	): string {
		const now = Date.now();
		const payload = {
			widgetKey,
			originDomain:
				originDomain.toLowerCase(),
			exp: now + this.originTokenTtlMs,
			iat: now,
		};
		const encodedPayload = Buffer.from(
			JSON.stringify(payload),
			"utf-8",
		).toString("base64url");
		const signature = crypto
			.createHmac("sha256", config.COOKIE_SECRET)
			.update(encodedPayload)
			.digest("base64url");
		return `${encodedPayload}.${signature}`;
	}

	private validateOriginToken(
		token: string,
		widgetKey: string,
		originDomain: string,
	): boolean {
		const parts = token.split(".");
		if (parts.length !== 2) {
			return false;
		}

		const [encodedPayload, signature] = parts;
		const expectedSignature = crypto
			.createHmac("sha256", config.COOKIE_SECRET)
			.update(encodedPayload)
			.digest("base64url");

		try {
			if (
				!crypto.timingSafeEqual(
					Buffer.from(signature, "utf-8"),
					Buffer.from(
						expectedSignature,
						"utf-8",
					),
				)
			) {
				return false;
			}
		} catch {
			return false;
		}

		try {
			const payload = JSON.parse(
				Buffer.from(
					encodedPayload,
					"base64url",
				).toString("utf-8"),
			) as {
				widgetKey: string;
				originDomain: string;
				exp: number;
			};

			return (
				payload.widgetKey === widgetKey &&
				payload.originDomain ===
					originDomain.toLowerCase() &&
				Date.now() <= payload.exp
			);
		} catch {
			return false;
		}
	}

	/**
	 * Create a new widget key for a user
	 */
	async createWidgetKey(
		params: CreateWidgetKeyParams,
	): Promise<WidgetKey> {
		const {
			userId,
			widgetName = "My Chat Widget",
			allowedDomains = null,
			widgetConfig = {},
		} = params;

		try {
			// Check if user already has a widget key
			const existingKey =
				await this.getUserWidgetKey(userId);
			if (existingKey) {
				throw new Error(
					"User already has a widget key. Use updateWidgetKey to modify it.",
				);
			}

			const widgetKey = this.generateWidgetKey();
			const effectiveAllowedDomains =
				this.normalizeAllowedDomains(
					allowedDomains,
				);

			const result = await pool.query(
				`INSERT INTO widget_keys
                    (user_id, widget_key, widget_name, allowed_domains, widget_config)
                    VALUES ($1, $2, $3, $4, $5)
                    RETURNING *`,
				[
					userId,
					widgetKey,
					widgetName,
					effectiveAllowedDomains,
					JSON.stringify(widgetConfig),
				],
			);

			const widget = this.mapRowToWidgetKey(
				result.rows[0],
			);

			// Cache the new key
			await redisCache.setex(
				this.getCacheKey(widgetKey),
				WIDGET_KEY_CACHE_TTL_SECONDS,
				JSON.stringify(widget),
			);

			logger.info("Widget key created", {
				userId,
				widgetKey,
			});
			return widget;
		} catch (error) {
			logger.error("Error creating widget key", {
				error,
				userId,
			});
			throw error;
		}
	}

	/**
	 * Get widget key by key string (Cached)
	 */
	async getWidgetKeyByKey(
		widgetKey: string,
	): Promise<WidgetKey | null> {
		try {
			// Try cache first
			const cached = await redisCache.get(
				this.getCacheKey(widgetKey),
			);
			if (cached) {
				const parsedCached =
					JSON.parse(cached) as Partial<WidgetKey>;
				if (
					parsedCached.company_website !==
					undefined
				) {
					return parsedCached as WidgetKey;
				}
			}

			const result = await pool.query(
				`SELECT wk.*, u.plan_type, u.company_website
				 FROM widget_keys wk
				 JOIN users u ON u.id = wk.user_id
				 WHERE wk.widget_key = $1`,
				[widgetKey],
			);

			if (result.rows.length === 0) {
				return null;
			}

			const widget = this.mapRowToWidgetKey(
				result.rows[0],
			);

			// Cache result
			await redisCache.setex(
				this.getCacheKey(widgetKey),
				WIDGET_KEY_CACHE_TTL_SECONDS,
				JSON.stringify(widget),
			);

			return widget;
		} catch (error) {
			logger.error("Error fetching widget key", {
				error,
				widgetKey,
			});
			throw error;
		}
	}

	/**
	 * Get user's widget key
	 */
	async getUserWidgetKey(
		userId: string,
	): Promise<WidgetKey | null> {
		try {
			// We don't cache by userID easily because primary lookup is by key
			// But we could add a secondary cache if needed
			const result = await pool.query(
				`SELECT wk.*, u.plan_type, u.company_website
				 FROM widget_keys wk
				 JOIN users u ON u.id = wk.user_id
				 WHERE wk.user_id = $1
				 ORDER BY wk.updated_at DESC
				 LIMIT 1`,
				[userId],
			);

			if (result.rows.length === 0) {
				return null;
			}

			return this.mapRowToWidgetKey(
				result.rows[0],
			);
		} catch (error) {
			logger.error(
				"Error fetching user widget key",
				{ error, userId },
			);
			throw error;
		}
	}

	/**
	 * Verify widget key and check domain restrictions
	 */
	async verifyWidgetKey(
		widgetKey: string,
		refererDomain?: string,
		originToken?: string,
	): Promise<{
		valid: boolean;
		userId?: string;
		widget?: WidgetKey;
		message?: string;
	}> {
		try {
			const widget =
				await this.getWidgetKeyByKey(widgetKey);

			if (!widget) {
				return {
					valid: false,
					message: "Invalid widget key",
				};
			}

			if (!widget.is_active) {
				return {
					valid: false,
					message: "Widget key is inactive",
				};
			}

			const normalizedReferer =
				refererDomain
					? this.normalizeDomain(
							refererDomain,
					  )
					: null;
			const allowedDomains =
				this.getEffectiveAllowedDomains(widget);

			if (
				normalizedReferer &&
				originToken &&
				this.validateOriginToken(
					originToken,
					widgetKey,
					normalizedReferer,
				)
			) {
				this.updateWidgetUsage(widget.id);
				return {
					valid: true,
					userId: widget.user_id,
					widget,
				};
			}

			if (
				!allowedDomains ||
				allowedDomains.length === 0
			) {
				this.updateWidgetUsage(widget.id);
				return {
					valid: true,
					userId: widget.user_id,
					widget,
				};
			}

			if (!normalizedReferer) {
				return {
					valid: false,
					message:
						"Missing referer for domain-restricted widget",
				};
			}

			if (
				!this.matchesAllowedDomain(
					normalizedReferer,
					allowedDomains,
				)
			) {
				return {
					valid: false,
					message: "Domain not allowed",
				};
			}

			// Update usage stats (fire and forget, maybe buffered later if needed)
			this.updateWidgetUsage(widget.id);

			return {
				valid: true,
				userId: widget.user_id,
				widget,
			};
		} catch (error) {
			logger.error("Error verifying widget key", {
				error,
				widgetKey,
			});
			return {
				valid: false,
				message: "Error verifying widget key",
			};
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
		},
	): Promise<WidgetKey> {
		try {
			const currentWidget =
				await this.getUserWidgetKey(userId);
			if (!currentWidget) {
				throw new Error("Widget key not found");
			}

			const setClauses: string[] = [];
			const values: any[] = [];
			let paramIndex = 1;

			if (updates.widgetName !== undefined) {
				setClauses.push(
					`widget_name = $${paramIndex++}`,
				);
				values.push(updates.widgetName);
			}

			if (updates.isActive !== undefined) {
				setClauses.push(
					`is_active = $${paramIndex++}`,
				);
				values.push(updates.isActive);
			}

			if (updates.allowedDomains !== undefined) {
				const effectiveAllowedDomains =
					this.normalizeAllowedDomains(
						updates.allowedDomains,
					);
				setClauses.push(
					`allowed_domains = $${paramIndex++}`,
				);
				values.push(effectiveAllowedDomains);
			}

			if (updates.widgetConfig !== undefined) {
				setClauses.push(
					`widget_config = $${paramIndex++}`,
				);
				values.push(
					JSON.stringify(updates.widgetConfig),
				);
			}

			setClauses.push(
				`updated_at = CURRENT_TIMESTAMP`,
			);
			values.push(userId);

			const result = await pool.query(
				`UPDATE widget_keys
                    SET ${setClauses.join(", ")}
                    WHERE user_id = $${paramIndex}
                    RETURNING *`,
				values,
			);

			const widget = this.mapRowToWidgetKey(
				result.rows[0],
			);

			// Invalidate cache
			await redisCache.del(
				this.getCacheKey(widget.widget_key),
			);

			logger.info("Widget key updated", {
				userId,
			});
			return widget;
		} catch (error) {
			logger.error("Error updating widget key", {
				error,
				userId,
			});
			throw error;
		}
	}

	/**
	 * Update widget usage statistics (Now just DB update, low priority)
	 */
	private async updateWidgetUsage(
		widgetKeyId: number,
	): Promise<void> {
		try {
			await pool.query(
				`UPDATE widget_keys
                    SET last_used_at = CURRENT_TIMESTAMP,
                        usage_count = usage_count + 1
                    WHERE id = $1`,
				[widgetKeyId],
			);
		} catch (error) {
			logger.error(
				"Error updating widget usage",
				{ error, widgetKeyId },
			);
		}
	}

	/**
	 * Track widget analytics event (Buffered)
	 */
	async trackWidgetEvent(
		widgetKey: string,
		eventType: string,
		eventData: any = {},
		metadata?: {
			ipAddress?: string;
			userAgent?: string;
			refererUrl?: string;
		},
	): Promise<void> {
		try {
			// We verify key exists quickly via cache
			const widget =
				await this.getWidgetKeyByKey(widgetKey);
			if (!widget) return;

			const event = {
				widget_key_id: widget.id,
				event_type: eventType,
				event_data: eventData,
				ip_address: metadata?.ipAddress,
				user_agent: metadata?.userAgent,
				referer_url: metadata?.refererUrl,
				created_at: new Date().toISOString(),
			};

			// Push to Redis Buffer
			await redisAnalytics.lpush(
				WIDGET_ANALYTICS_BUFFER_KEY,
				JSON.stringify(event),
			);
		} catch (error) {
			logger.error("Error tracing widget event", {
				error,
				widgetKey,
				eventType,
			});
		}
	}

	async trackWidgetEventImmediate(
		widgetKey: string,
		eventType: string,
		eventData: any = {},
		metadata?: {
			ipAddress?: string;
			userAgent?: string;
			refererUrl?: string;
		},
	): Promise<void> {
		try {
			const widget =
				await this.getWidgetKeyByKey(widgetKey);
			if (!widget) {
				return;
			}

			await pool.query(
				`INSERT INTO widget_analytics
					(widget_key_id, event_type, event_data, ip_address, user_agent, referer_url, created_at)
				 VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
				[
					widget.id,
					eventType,
					JSON.stringify(eventData || {}),
					metadata?.ipAddress || null,
					metadata?.userAgent || null,
					metadata?.refererUrl || null,
				],
			);
		} catch (error) {
			logger.error(
				"Error tracking immediate widget event",
				{
					error,
					widgetKey,
					eventType,
				},
			);
		}
	}

	async getWidgetInstallationStatus(
		widget: WidgetKey,
	): Promise<WidgetInstallationStatus> {
		try {
			const result = await pool.query<{
				event_type: string;
				referer_url: string | null;
				created_at: Date;
			}>(
				`SELECT event_type, referer_url, created_at
				 FROM widget_analytics
				 WHERE widget_key_id = $1
				   AND event_type IN ('embed_script_loaded', 'widget_key_regenerated')
				 ORDER BY created_at DESC`,
				[widget.id],
			);

			const internalDomains =
				this.getInternalWidgetDomains();
			const allowedDomains =
				this.getEffectiveAllowedDomains(widget);
			const latestRegeneratedAt =
				result.rows.find(
					(row) =>
						row.event_type ===
						"widget_key_regenerated",
				)?.created_at ?? null;

			for (const row of result.rows) {
				if (
					row.event_type !==
					"embed_script_loaded"
				) {
					continue;
				}

				if (
					latestRegeneratedAt &&
					row.created_at <= latestRegeneratedAt
				) {
					break;
				}

				const domain = row.referer_url
					? this.normalizeDomain(
							row.referer_url,
					  )
					: null;
				if (!domain) {
					continue;
				}

				if (internalDomains.has(domain)) {
					continue;
				}

				if (
					allowedDomains &&
					allowedDomains.length > 0 &&
					!this.matchesAllowedDomain(
						domain,
						allowedDomains,
					)
				) {
					continue;
				}

				return {
					installationStatus: "installed",
					installedAt:
						row.created_at.toISOString(),
					installedDomain: domain,
				};
			}

			return {
				installationStatus: "not_installed",
				installedAt: null,
				installedDomain: null,
			};
		} catch (error) {
			logger.error(
				"Error fetching widget installation status",
				{
					error,
					widgetKeyId: widget.id,
				},
			);
			return {
				installationStatus: "not_installed",
				installedAt: null,
				installedDomain: null,
			};
		}
	}

	/**
	 * Flush buffered analytics to Database
	 * Optimized with batch inserts for better performance
	 */
	async flushAnalytics(): Promise<void> {
		try {
			const len = await redisAnalytics.llen(
				WIDGET_ANALYTICS_BUFFER_KEY,
			);

			// Only flush if buffer has enough events or forced flush
			if (len === 0) return;

			const batchSize = Math.min(
				len,
				WIDGET_ANALYTICS_BATCH_SIZE,
			);
			const eventsStr = await redisAnalytics.rpop(
				WIDGET_ANALYTICS_BUFFER_KEY,
				batchSize,
			);

			if (
				!eventsStr ||
				(Array.isArray(eventsStr) &&
					eventsStr.length === 0)
			)
				return;

			// Parse events from Redis
			const events = (
				Array.isArray(eventsStr)
					? eventsStr
					: [eventsStr]
			)
				.map((s) => {
					try {
						return s ? JSON.parse(s) : null;
					} catch (parseError) {
						logger.error(
							"Failed to parse analytics event",
							{
								parseError,
								event: s,
							},
						);
						return null;
					}
				})
				.filter((e) => e !== null);

			if (events.length === 0) return;

			// Use batch insert for better performance
			const client = await pool.connect();
			try {
				await client.query("BEGIN");

				// Build bulk insert query
				const values: any[] = [];
				const placeholders: string[] = [];

				events.forEach((event, index) => {
					const baseIndex = index * 7;
					placeholders.push(
						`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7})`,
					);
					values.push(
						event.widget_key_id,
						event.event_type,
						JSON.stringify(event.event_data),
						event.ip_address,
						event.user_agent,
						event.referer_url,
						event.created_at,
					);
				});

				const query = `
                         INSERT INTO widget_analytics
                         (widget_key_id, event_type, event_data, ip_address, user_agent, referer_url, created_at)
                         VALUES ${placeholders.join(", ")}
                    `;

				await client.query(query, values);
				await client.query("COMMIT");

				logger.info(
					`Flushed ${events.length} analytics events to DB using batch insert`,
				);
			} catch (error) {
				await client.query("ROLLBACK");
				logger.error(
					"Error flushing analytics, attempting re-queue",
					{
						error,
						eventsCount: events.length,
					},
				);

				// Re-queue events to avoid data loss
				try {
					for (const event of events) {
						await redisAnalytics.rpush(
							WIDGET_ANALYTICS_BUFFER_KEY,
							JSON.stringify(event),
						);
					}
					logger.info(
						`Re-queued ${events.length} events after flush failure`,
					);
				} catch (requeueError) {
					logger.error(
						"Failed to re-queue events - data loss may occur",
						{
							requeueError,
						},
					);
				}
			} finally {
				client.release();
			}
		} catch (error) {
			logger.error("Error in flushAnalytics", {
				error,
			});
		}
	}

	/**
	 * Check buffer size and force flush if needed
	 */
	async checkAndFlushIfNeeded(): Promise<void> {
		try {
			const len = await redisAnalytics.llen(
				WIDGET_ANALYTICS_BUFFER_KEY,
			);

			// Force flush if buffer exceeds threshold
			if (len >= WIDGET_ANALYTICS_BATCH_SIZE) {
				logger.info(
					`Analytics buffer size ${len} exceeds threshold, forcing flush`,
				);
				await this.flushAnalytics();
			}
		} catch (error) {
			logger.error(
				"Error in checkAndFlushIfNeeded",
				{ error },
			);
		}
	}

	/**
	 * Delete widget key
	 */
	async deleteWidgetKey(
		userId: string,
	): Promise<void> {
		try {
			const currentWidget =
				await this.getUserWidgetKey(userId);

			await pool.query(
				`DELETE FROM widget_keys WHERE user_id = $1`,
				[userId],
			);

			if (currentWidget) {
				await redisCache.del(
					this.getCacheKey(
						currentWidget.widget_key,
					),
				);
			}

			logger.info("Widget key deleted", {
				userId,
			});
		} catch (error) {
			logger.error("Error deleting widget key", {
				error,
				userId,
			});
			throw error;
		}
	}

	/**
	 * Regenerate widget key (creates new key, keeps same config)
	 */
	async regenerateWidgetKey(
		userId: string,
	): Promise<WidgetKey> {
		try {
			const currentWidget =
				await this.getUserWidgetKey(userId);
			if (!currentWidget) {
				throw new Error(
					"No widget key found for user",
				);
			}

			const newWidgetKey =
				this.generateWidgetKey();

			const result = await pool.query(
				`UPDATE widget_keys
                    SET widget_key = $1, updated_at = CURRENT_TIMESTAMP
                    WHERE user_id = $2
                    RETURNING *`,
				[newWidgetKey, userId],
			);

			// Invalidate old key cache
			await redisCache.del(
				this.getCacheKey(
					currentWidget.widget_key,
				),
			);

			// New key will be cached on first read

			logger.info("Widget key regenerated", {
				userId,
				newWidgetKey,
			});
			return this.mapRowToWidgetKey(
				result.rows[0],
			);
		} catch (error) {
			logger.error(
				"Error regenerating widget key",
				{ error, userId },
			);
			throw error;
		}
	}

	/**
	 * Get widget analytics
	 */
	async getWidgetAnalytics(
		userId: string,
		limit: number = 100,
	): Promise<any[]> {
		try {
			const result = await pool.query(
				`SELECT wa.*
                    FROM widget_analytics wa
                    JOIN widget_keys wk ON wa.widget_key_id = wk.id
                    WHERE wk.user_id = $1
                    ORDER BY wa.created_at DESC
                    LIMIT $2`,
				[userId, limit],
			);

			return result.rows;
		} catch (error) {
			logger.error(
				"Error fetching widget analytics",
				{ error, userId },
			);
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
			company_website:
				row.company_website ?? null,
			widget_key: row.widget_key,
			widget_name: row.widget_name,
			is_active: row.is_active,
			allowed_domains: row.allowed_domains,
			widget_config: row.widget_config || {},
			created_at: row.created_at,
			updated_at: row.updated_at,
			last_used_at: row.last_used_at,
			usage_count: row.usage_count,
			plan_type: coercePlanType(
				row.plan_type,
			),
		};
	}
}

export default new WidgetService();
