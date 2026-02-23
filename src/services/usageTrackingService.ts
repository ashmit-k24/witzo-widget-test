import pool from "../config/database";
import {
	coercePlanType,
	PLAN_CONVERSATION_DEFAULT_LIMITS,
} from "../config/planConfig";
import {
	USAGE_APPROACHING_LIMIT_THRESHOLD,
	USAGE_CACHE_TTL_SECONDS,
} from "../constants";
import { redisCache } from "../config/redis";
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

		return {
			planType: coercePlanType(user.plan_type),
			conversationsUsed: user.conversations_used,
			conversationsLimit: limit,
			conversationsRemaining,
			resetDate: user.plan_reset_date,
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
			const cached = await redisCache.get(cacheKey);
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

			await redisCache.setex(
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
			await redisCache.del(usageCacheKey(userId));

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

			await redisCache.del(usageCacheKey(userId));

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
				const pipeline = redisCache.pipeline();
				for (const user of result.rows) {
					pipeline.del(usageCacheKey(user.id));
				}
				await pipeline.exec();
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

	/**
	 * Upgrade user to basic plan. Invalidates Redis cache.
	 */
	async upgradeUserPlan(
		userId: string,
		stripeCustomerId: string,
		subscriptionId: string,
	): Promise<void> {
		try {
			await pool.query(
				`UPDATE users
        SET plan_type = 'basic',
            conversations_limit = $4,
            stripe_customer_id = $2,
            subscription_id = $3,
            subscription_status = 'active',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
				[
					userId,
					stripeCustomerId,
					subscriptionId,
					PLAN_CONVERSATION_DEFAULT_LIMITS
						.basic as number,
				],
			);

			await redisCache.del(usageCacheKey(userId));

			logger.info("User upgraded to basic plan", {
				userId,
				stripeCustomerId,
				subscriptionId,
			});
		} catch (error) {
			const err = error as Error;
			logger.error("Error upgrading user plan", {
				userId,
				error: err.message,
			});
			throw error;
		}
	}

	/**
	 * Downgrade user to free plan. Invalidates Redis cache.
	 */
	async downgradeUserPlan(userId: string): Promise<void> {
		try {
			await pool.query(
				`UPDATE users
        SET plan_type = 'free',
            conversations_limit = $2,
            subscription_status = 'canceled',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
				[
					userId,
					PLAN_CONVERSATION_DEFAULT_LIMITS
						.free as number,
				],
			);

			await redisCache.del(usageCacheKey(userId));

			logger.info("User downgraded to free plan", { userId });
		} catch (error) {
			const err = error as Error;
			logger.error("Error downgrading user plan", {
				userId,
				error: err.message,
			});
			throw error;
		}
	}

	/**
	 * Update subscription status
	 */
	async updateSubscriptionStatus(
		userId: string,
		status: string,
	): Promise<void> {
		try {
			await pool.query(
				`UPDATE users
        SET subscription_status = $2,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
				[userId, status],
			);

			logger.info("Subscription status updated", {
				userId,
				status,
			});
		} catch (error) {
			const err = error as Error;
			logger.error("Error updating subscription status", {
				userId,
				error: err.message,
			});
			throw error;
		}
	}
}

export default new UsageTrackingService();
