import {
	NextFunction,
	Request,
	Response,
} from "express";
import { coercePlanType } from "../config/planConfig";
import { config } from "../config/env";
import { memCache } from "../utils/memCache";
import logger from "../utils/logger";

/**
 * User-based rate limiter using in-memory cache.
 * Suitable for single-process deployments (no Redis required).
 * Fails open on errors.
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
export const createUserRateLimiter = (
	options: RateLimitOptions,
) => {
	const {
		windowMs,
		max,
		message,
		keyPrefix,
		skipSuccessfulRequests = false,
	} = options;

	return async (
		req: Request,
		res: Response,
		next: NextFunction,
	) => {
		try {
			const userId = (req as any).user?.id;
			const identifier =
				userId || req.ip || "anonymous";
			const key = `rate_limit:${keyPrefix}:${identifier}`;

			const current = memCache.get(key);
			const count = current
				? parseInt(current, 10)
				: 0;

			if (count >= max) {
				logger.warn("Rate limit exceeded", {
					identifier,
					key,
					count,
					max,
					path: req.path,
				});

				res.status(429).json({
					success: false,
					message,
					code: "RATE_LIMIT_EXCEEDED",
					retryAfter: Math.ceil(windowMs / 1000),
				});
				return;
			}

			if (count === 0) {
				memCache.setex(
					key,
					Math.ceil(windowMs / 1000),
					"1",
				);
			} else {
				memCache.incr(key);
			}

			res.setHeader("X-RateLimit-Limit", max);
			res.setHeader(
				"X-RateLimit-Remaining",
				Math.max(0, max - count - 1),
			);
			res.setHeader(
				"X-RateLimit-Reset",
				Date.now() + windowMs,
			);

			if (skipSuccessfulRequests) {
				const originalJson = res.json.bind(res);
				res.json = function (body: any) {
					if (res.statusCode < 400) {
						memCache.decr(key);
					}
					return originalJson(body);
				};
			}

			next();
		} catch (error) {
			logger.error("Rate limiter error", {
				error:
					error instanceof Error
						? error.message
						: "Unknown error",
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
	standardMax?: number;
	enterpriseMax?: number;
	message: string;
	keyPrefix: string;
}) => {
	return async (
		req: Request,
		res: Response,
		next: NextFunction,
	) => {
		try {
			const user = (req as any).user;
			const userId = user?.id;
			const planType = coercePlanType(
				user?.plan_type,
			);
			const identifier =
				userId || req.ip || "anonymous";
			const key = `rate_limit:${options.keyPrefix}:${identifier}`;

			const max =
				planType === "enterprise"
					? options.enterpriseMax ??
					  (options.standardMax ??
							options.basicMax * 2) * 2
					: planType === "standard"
					  ? options.standardMax ??
							options.basicMax * 2
					  : planType === "basic"
					    ? options.basicMax
					    : options.freeMax;

			const current = memCache.get(key);
			const count = current
				? parseInt(current, 10)
				: 0;

			if (count >= max) {
				logger.warn("Rate limit exceeded", {
					identifier,
					planType,
					count,
					max,
					path: req.path,
				});

				res.status(429).json({
					success: false,
					message: options.message,
					code: "RATE_LIMIT_EXCEEDED",
					retryAfter: Math.ceil(
						options.windowMs / 1000,
					),
					planType,
					upgradeMessage:
						planType === "free"
							? "Upgrade to Basic plan for higher limits"
							: planType === "basic"
							  ? "Upgrade to Standard plan for higher limits"
							  : undefined,
				});
				return;
			}

			if (count === 0) {
				memCache.setex(
					key,
					Math.ceil(options.windowMs / 1000),
					"1",
				);
			} else {
				memCache.incr(key);
			}

			res.setHeader("X-RateLimit-Limit", max);
			res.setHeader(
				"X-RateLimit-Remaining",
				Math.max(0, max - count - 1),
			);
			res.setHeader(
				"X-RateLimit-Reset",
				Date.now() + options.windowMs,
			);

			next();
		} catch (error) {
			logger.error("Tiered rate limiter error", {
				error:
					error instanceof Error
						? error.message
						: "Unknown error",
				path: req.path,
			});
			next();
		}
	};
};

/**
 * Pre-configured rate limiters for common endpoints
 */

export const globalRateLimiter =
	createTieredRateLimiter({
		windowMs: config.RATE_LIMIT_WINDOW_MS,
		freeMax: config.RATE_LIMIT_MAX_REQUESTS,
		basicMax: config.RATE_LIMIT_MAX_REQUESTS * 2,
		standardMax:
			config.RATE_LIMIT_MAX_REQUESTS * 3,
		enterpriseMax:
			config.RATE_LIMIT_MAX_REQUESTS * 5,
		message:
			"Too many requests, please try again later.",
		keyPrefix: "global",
	});

export const authRateLimiter =
	createUserRateLimiter({
		windowMs: config.RATE_LIMIT_WINDOW_MS,
		max: 10,
		message:
			"Too many authentication attempts. Please try again later.",
		keyPrefix: "auth",
		skipSuccessfulRequests: false,
	});

export const verifyRateLimiter =
	createUserRateLimiter({
		windowMs: config.RATE_LIMIT_WINDOW_MS,
		max: 20,
		message:
			"Too many verification attempts. Please try again later.",
		keyPrefix: "verify",
	});

export const chatRateLimiter =
	createTieredRateLimiter({
		windowMs: 60000,
		freeMax: 10,
		basicMax: 30,
		standardMax: 45,
		enterpriseMax: 60,
		message:
			"Chat rate limit exceeded. Please slow down.",
		keyPrefix: "chat",
	});

export const scraperRateLimiter =
	createTieredRateLimiter({
		windowMs: 300000,
		freeMax: 5,
		basicMax: 20,
		standardMax: 40,
		enterpriseMax: 60,
		message:
			"Scraping rate limit exceeded. Please try again later.",
		keyPrefix: "scraper",
	});

export const widgetRateLimiter =
	createUserRateLimiter({
		windowMs: 60000,
		max: 100,
		message:
			"Widget rate limit exceeded. Please try again later.",
		keyPrefix: "widget",
	});
