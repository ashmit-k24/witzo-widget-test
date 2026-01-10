import { NextFunction, Request, Response } from 'express';
import { config } from '../config/env';
import { redisCache } from '../config/redis';
import logger from '../utils/logger';

/**
 * User-based rate limiter using Redis
 * This is more suitable for high-concurrency scenarios than IP-based limiting
 */

interface RateLimitOptions {
  windowMs: number;
  max: number;
  message: string;
  keyPrefix: string;
  skipSuccessfulRequests?: boolean;
}

/**
 * Create a user-based rate limiter middleware
 */
export const createUserRateLimiter = (options: RateLimitOptions) => {
  const {
    windowMs,
    max,
    message,
    keyPrefix,
    skipSuccessfulRequests = false,
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Get user identifier - prioritize userId from auth, fallback to IP
      const userId = (req as any).user?.id;
      const identifier = userId || req.ip || 'anonymous';
      const key = `rate_limit:${keyPrefix}:${identifier}`;

      // Get current count from Redis
      const current = await redisCache.get(key);
      const count = current ? parseInt(current, 10) : 0;

      // Check if limit exceeded
      if (count >= max) {
        logger.warn('Rate limit exceeded', {
          identifier,
          key,
          count,
          max,
          path: req.path,
        });

        res.status(429).json({
          success: false,
          message,
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: Math.ceil(windowMs / 1000),
        });
        return;
      }

      // Increment counter
      if (count === 0) {
        // First request in window - set with expiry
        await redisCache.setex(key, Math.ceil(windowMs / 1000), '1');
      } else {
        // Subsequent request - increment
        await redisCache.incr(key);
      }

      // Add rate limit headers
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count - 1));
      res.setHeader('X-RateLimit-Reset', Date.now() + windowMs);

      // Handle skipSuccessfulRequests option
      if (skipSuccessfulRequests) {
        const originalJson = res.json.bind(res);
        res.json = function (body: any) {
          // If request was successful, decrement counter
          if (res.statusCode < 400) {
            redisCache.decr(key).catch((err) => {
              logger.error('Failed to decrement rate limit counter', { error: err.message });
            });
          }
          return originalJson(body);
        };
      }

      next();
    } catch (error) {
      // On Redis error, allow request through (fail open)
      logger.error('Rate limiter error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        path: req.path,
      });
      next();
    }
  };
};

/**
 * Tiered rate limiting based on user plan
 */
export const createTieredRateLimiter = (options: {
  windowMs: number;
  freeMax: number;
  basicMax: number;
  message: string;
  keyPrefix: string;
}) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const userId = user?.id;
      const planType = user?.plan_type || 'free';
      const identifier = userId || req.ip || 'anonymous';
      const key = `rate_limit:${options.keyPrefix}:${identifier}`;

      // Determine max based on plan
      const max = planType === 'basic' ? options.basicMax : options.freeMax;

      // Get current count from Redis
      const current = await redisCache.get(key);
      const count = current ? parseInt(current, 10) : 0;

      // Check if limit exceeded
      if (count >= max) {
        logger.warn('Rate limit exceeded', {
          identifier,
          planType,
          count,
          max,
          path: req.path,
        });

        res.status(429).json({
          success: false,
          message: options.message,
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: Math.ceil(options.windowMs / 1000),
          planType,
          upgradeMessage: planType === 'free' ? 'Upgrade to Basic plan for higher limits' : undefined,
        });
        return;
      }

      // Increment counter
      if (count === 0) {
        await redisCache.setex(key, Math.ceil(options.windowMs / 1000), '1');
      } else {
        await redisCache.incr(key);
      }

      // Add rate limit headers
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count - 1));
      res.setHeader('X-RateLimit-Reset', Date.now() + options.windowMs);

      next();
    } catch (error) {
      // On Redis error, allow request through (fail open)
      logger.error('Tiered rate limiter error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        path: req.path,
      });
      next();
    }
  };
};

/**
 * Pre-configured rate limiters for common endpoints
 */

// Global rate limiter - more permissive for authenticated users
export const globalRateLimiter = createTieredRateLimiter({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  freeMax: config.RATE_LIMIT_MAX_REQUESTS,
  basicMax: config.RATE_LIMIT_MAX_REQUESTS * 2, // 2x for paid users
  message: 'Too many requests, please try again later.',
  keyPrefix: 'global',
});

// Auth endpoints - stricter limits
export const authRateLimiter = createUserRateLimiter({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: 10, // Increased from 5
  message: 'Too many authentication attempts. Please try again later.',
  keyPrefix: 'auth',
  skipSuccessfulRequests: false,
});

// Verify endpoints
export const verifyRateLimiter = createUserRateLimiter({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: 20, // Increased from 10
  message: 'Too many verification attempts. Please try again later.',
  keyPrefix: 'verify',
});

// Chat endpoints - tiered based on plan
export const chatRateLimiter = createTieredRateLimiter({
  windowMs: 60000, // 1 minute window
  freeMax: 10, // 10 requests per minute for free
  basicMax: 30, // 30 requests per minute for basic
  message: 'Chat rate limit exceeded. Please slow down.',
  keyPrefix: 'chat',
});

// Scraper endpoints - tiered based on plan
export const scraperRateLimiter = createTieredRateLimiter({
  windowMs: 300000, // 5 minute window
  freeMax: 5, // 5 scraping jobs per 5 minutes for free
  basicMax: 20, // 20 scraping jobs per 5 minutes for basic
  message: 'Scraping rate limit exceeded. Please try again later.',
  keyPrefix: 'scraper',
});

// Widget public endpoints - IP-based (since no auth)
export const widgetRateLimiter = createUserRateLimiter({
  windowMs: 60000, // 1 minute
  max: 100, // 100 widget requests per minute per IP
  message: 'Widget rate limit exceeded. Please try again later.',
  keyPrefix: 'widget',
});
