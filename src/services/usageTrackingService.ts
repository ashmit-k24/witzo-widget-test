import pool from '../config/database';
import logger from '../utils/logger';
import { UsageStats } from '../types';

/**
 * Usage Tracking Service
 * Manages conversation limits and usage tracking for free and basic plans
 */
class UsageTrackingService {
  /**
   * Get user's current usage statistics
   */
  async getUserUsage(userId: string): Promise<UsageStats> {
    try {
      const result = await pool.query(
        `SELECT
          plan_type,
          conversations_used,
          conversations_limit,
          plan_reset_date
        FROM users
        WHERE id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        throw new Error('User not found');
      }

      const user = result.rows[0];
      const conversationsRemaining = user.conversations_limit - user.conversations_used;
      const isAtLimit = user.conversations_used >= user.conversations_limit;
      const isApproachingLimit = (user.conversations_used / user.conversations_limit) >= 0.9;

      return {
        planType: user.plan_type,
        conversationsUsed: user.conversations_used,
        conversationsLimit: user.conversations_limit,
        conversationsRemaining: Math.max(0, conversationsRemaining),
        resetDate: user.plan_reset_date,
        isApproachingLimit: isApproachingLimit && !isAtLimit,
        isAtLimit,
      };
    } catch (error) {
      const err = error as Error;
      logger.error('Error getting user usage', {
        userId,
        error: err.message,
      });
      throw error;
    }
  }

  /**
   * Track a conversation (increment usage counter)
   */
  async trackConversation(userId: string): Promise<void> {
    try {
      await pool.query(
        `UPDATE users
        SET conversations_used = conversations_used + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
        [userId]
      );

      logger.info('Conversation tracked', { userId });
    } catch (error) {
      const err = error as Error;
      logger.error('Error tracking conversation', {
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
        [userId]
      );

      if (result.rows.length === 0) {
        throw new Error('User not found');
      }

      const user = result.rows[0];
      return user.conversations_used < user.conversations_limit;
    } catch (error) {
      const err = error as Error;
      logger.error('Error checking if user can chat', {
        userId,
        error: err.message,
      });
      throw error;
    }
  }

  /**
   * Get remaining conversations for a user
   */
  async getRemainingConversations(userId: string): Promise<number> {
    try {
      const result = await pool.query(
        `SELECT conversations_used, conversations_limit
        FROM users
        WHERE id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        throw new Error('User not found');
      }

      const user = result.rows[0];
      return Math.max(0, user.conversations_limit - user.conversations_used);
    } catch (error) {
      const err = error as Error;
      logger.error('Error getting remaining conversations', {
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
        [userId]
      );

      if (result.rows.length === 0) {
        throw new Error('User not found');
      }

      const user = result.rows[0];
      const usagePercentage = user.conversations_used / user.conversations_limit;
      return usagePercentage >= 0.9 && user.conversations_used < user.conversations_limit;
    } catch (error) {
      const err = error as Error;
      logger.error('Error checking if approaching limit', {
        userId,
        error: err.message,
      });
      throw error;
    }
  }

  /**
   * Reset monthly usage for all users
   * This should be run as a cron job on the 1st of every month
   */
  async resetMonthlyUsage(): Promise<void> {
    try {
      const result = await pool.query(
        `UPDATE users
        SET conversations_used = 0,
            plan_reset_date = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE plan_reset_date <= CURRENT_TIMESTAMP - INTERVAL '1 month'
        RETURNING id, email, plan_type`
      );

      logger.info('Monthly usage reset completed', {
        usersReset: result.rowCount,
        users: result.rows.map(u => ({ id: u.id, email: u.email, plan: u.plan_type })),
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Error resetting monthly usage', {
        error: err.message,
        stack: err.stack,
      });
      throw error;
    }
  }

  /**
   * Upgrade user to basic plan
   */
  async upgradeUserPlan(
    userId: string,
    stripeCustomerId: string,
    subscriptionId: string
  ): Promise<void> {
    try {
      await pool.query(
        `UPDATE users
        SET plan_type = 'basic',
            conversations_limit = 500,
            stripe_customer_id = $2,
            subscription_id = $3,
            subscription_status = 'active',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
        [userId, stripeCustomerId, subscriptionId]
      );

      logger.info('User upgraded to basic plan', {
        userId,
        stripeCustomerId,
        subscriptionId,
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Error upgrading user plan', {
        userId,
        error: err.message,
      });
      throw error;
    }
  }

  /**
   * Downgrade user to free plan
   */
  async downgradeUserPlan(userId: string): Promise<void> {
    try {
      await pool.query(
        `UPDATE users
        SET plan_type = 'free',
            conversations_limit = 20,
            subscription_status = 'canceled',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
        [userId]
      );

      logger.info('User downgraded to free plan', { userId });
    } catch (error) {
      const err = error as Error;
      logger.error('Error downgrading user plan', {
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
    status: string
  ): Promise<void> {
    try {
      await pool.query(
        `UPDATE users
        SET subscription_status = $2,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
        [userId, status]
      );

      logger.info('Subscription status updated', { userId, status });
    } catch (error) {
      const err = error as Error;
      logger.error('Error updating subscription status', {
        userId,
        error: err.message,
      });
      throw error;
    }
  }
}

export default new UsageTrackingService();
