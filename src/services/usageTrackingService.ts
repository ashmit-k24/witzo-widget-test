import pool from "../config/database";
import { coercePlanType } from "../config/planConfig";
import {
	USAGE_APPROACHING_LIMIT_THRESHOLD,
	USAGE_CACHE_TTL_SECONDS,
} from "../constants";
import { memCache } from "../utils/memCache";
import logger from "../utils/logger";
import { UsageStats } from "../types";

const usageCacheKey = (userId: string) =>
	`usage:stats:${userId}`;

/**
 * Usage Tracking Service
 * Manages conversation limits and usage tracking for free and basic plans
 */
class UsageTrackingService {
	private buildUsageStats(user: {
		plan_type: string;
		conversations_used: number;
		conversations_limit: number | null;
		plan_reset_date: Date;
	}): UsageStats {
		const limit = user.conversations_limit;
		const hasUnlimitedLimit = limit === null;
		const conversationsRemaining =
			hasUnlimitedLimit
				? null
				: Math.max(
						0,
						limit -
							user.conversations_used,
					);
		const isAtLimit = hasUnlimitedLimit
			? false
			: user.conversations_used >= limit;
		const isApproachingLimit = hasUnlimitedLimit
			? false
			: limit > 0 &&
				user.conversations_used / limit >=
					USAGE_APPROACHING_LIMIT_THRESHOLD;

		// plan_reset_date is the date of the last reset; next reset is +1 month
		const nextResetDate = new Date(user.plan_reset_date);
		nextResetDate.setMonth(nextResetDate.getMonth() + 1);

		return {
			planType: coercePlanType(user.plan_type),
			conversationsUsed: user.conversations_used,
			conversationsLimit: limit,
			conversationsRemaining,
			resetDate: nextResetDate,
			isApproachingLimit:
				isApproachingLimit && !isAtLimit,
			isAtLimit,
		};
	}

	/**
	 * Get user's current usage statistics.
	 * Result is cached in Redis for 60 seconds to reduce DB load.
	 */
	async getUserUsage(userId: string): Promise<UsageStats> {
		try {
			const cacheKey = usageCacheKey(userId);
			const cached = memCache.get(cacheKey);
			if (cached) {
				return JSON.parse(cached) as UsageStats;
			}

			const result = await pool.query(
				`SELECT
          plan_type,
          conversations_used,
          conversations_limit,
          plan_reset_date
        FROM users
        WHERE id = $1`,
				[userId],
			);

			if (result.rows.length === 0) {
				throw new Error("User not found");
			}

			const user = result.rows[0];
			const stats = this.buildUsageStats(user);

			memCache.setex(
				cacheKey,
				USAGE_CACHE_TTL_SECONDS,
				JSON.stringify(stats),
			);

			return stats;
		} catch (error) {
			const err = error as Error;
			logger.error("Error getting user usage", {
				userId,
				error: err.message,
			});
			throw error;
		}
	}

	/**
	 * Atomically check the conversation limit AND increment the counter
	 * in a single UPDATE statement, eliminating the TOCTOU race condition
	 * that exists when check and increment are two separate queries.
	 *
	 * Returns { allowed: false } if the user is at their limit (0 rows updated).
	 * Returns { allowed: true, usage } with the post-increment stats on success.
	 */
	async checkAndTrackConversation(userId: string): Promise<{
		allowed: boolean;
		usage: UsageStats | null;
	}> {
		try {
			const result = await pool.query<{
				conversations_used: number;
				conversations_limit: number | null;
				plan_reset_date: Date;
				plan_type: string;
			}>(
				`UPDATE users
         SET conversations_used = conversations_used + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND (conversations_limit IS NULL OR conversations_used < conversations_limit)
         RETURNING conversations_used, conversations_limit, plan_reset_date, plan_type`,
				[userId],
			);

			if ((result.rowCount ?? 0) === 0) {
				return { allowed: false, usage: null };
			}

			const user = result.rows[0];
			const usage = this.buildUsageStats(user);

			// Invalidate cached stats since the counter just changed
			memCache.del(usageCacheKey(userId));

			if (usage.isApproachingLimit) {
				logger.warn("User approaching conversation limit", {
					userId,
					conversationsRemaining:
						usage.conversationsRemaining,
				});
			}

			logger.info("Conversation tracked", { userId });
			return { allowed: true, usage };
		} catch (error) {
			const err = error as Error;
			logger.error("Error in checkAndTrackConversation", {
				userId,
				error: err.message,
			});
			throw error;
		}
	}

	/**
	 * Track a conversation (increment usage counter).
	 * Kept for any manual / non-request-lifecycle callers.
	 * Invalidates the Redis cache after incrementing.
	 */
	async trackConversation(userId: string): Promise<void> {
		try {
			await pool.query(
				`UPDATE users
        SET conversations_used = conversations_used + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
				[userId],
			);

			memCache.del(usageCacheKey(userId));

			logger.info("Conversation tracked", { userId });
		} catch (error) {
			const err = error as Error;
			logger.error("Error tracking conversation", {
				userId,
				error: err.message,
			});
			throw error;
		}
	}

	/**
	 * Check if user can chat (has not reached limit)
	 */
	async canUserChat(userId: string): Promise<boolean> {
		try {
			const result = await pool.query(
				`SELECT conversations_used, conversations_limit
        FROM users
        WHERE id = $1`,
				[userId],
			);

			if (result.rows.length === 0) {
				throw new Error("User not found");
			}

			const user = result.rows[0];
			return (
				user.conversations_limit === null ||
				user.conversations_used <
					user.conversations_limit
			);
		} catch (error) {
			const err = error as Error;
			logger.error("Error checking if user can chat", {
				userId,
				error: err.message,
			});
			throw error;
		}
	}

	/**
	 * Get remaining conversations for a user
	 */
	async getRemainingConversations(
		userId: string,
	): Promise<number | null> {
		try {
			const result = await pool.query(
				`SELECT conversations_used, conversations_limit
        FROM users
        WHERE id = $1`,
				[userId],
			);

			if (result.rows.length === 0) {
				throw new Error("User not found");
			}

			const user = result.rows[0];
			if (user.conversations_limit === null) {
				return null;
			}
			return Math.max(
				0,
				user.conversations_limit -
					user.conversations_used,
			);
		} catch (error) {
			const err = error as Error;
			logger.error("Error getting remaining conversations", {
				userId,
				error: err.message,
			});
			throw error;
		}
	}

	/**
	 * Check if user is approaching limit (>= 90%)
	 */
	async isApproachingLimit(userId: string): Promise<boolean> {
		try {
			const result = await pool.query(
				`SELECT conversations_used, conversations_limit
        FROM users
        WHERE id = $1`,
				[userId],
			);

			if (result.rows.length === 0) {
				throw new Error("User not found");
			}

			const user = result.rows[0];
			if (
				user.conversations_limit === null ||
				user.conversations_limit <= 0
			) {
				return false;
			}
			const usagePercentage =
				user.conversations_used /
				user.conversations_limit;
			return (
				usagePercentage >=
					USAGE_APPROACHING_LIMIT_THRESHOLD &&
				user.conversations_used < user.conversations_limit
			);
		} catch (error) {
			const err = error as Error;
			logger.error("Error checking if approaching limit", {
				userId,
				error: err.message,
			});
			throw error;
		}
	}

	/**
	 * Reset monthly usage for all users whose reset date has passed.
	 * This should be run as a cron job on the 1st of every month.
	 * Invalidates Redis cache for all reset users.
	 */
	async resetMonthlyUsage(): Promise<void> {
		try {
			const result = await pool.query(
				`UPDATE users
        SET conversations_used = 0,
            plan_reset_date = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE plan_reset_date <= CURRENT_TIMESTAMP - INTERVAL '1 month'
        RETURNING id, email, plan_type`,
			);

			if (result.rows.length > 0) {
				for (const user of result.rows) {
					memCache.del(usageCacheKey(user.id));
				}
			}

			logger.info("Monthly usage reset completed", {
				usersReset: result.rowCount,
				users: result.rows.map((u) => ({
					id: u.id,
					email: u.email,
					plan: u.plan_type,
				})),
			});
		} catch (error) {
			const err = error as Error;
			logger.error("Error resetting monthly usage", {
				error: err.message,
				stack: err.stack,
			});
			throw error;
		}
	}

}

export default new UsageTrackingService();
