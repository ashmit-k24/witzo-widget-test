import rateLimit from "express-rate-limit";
import { config } from "./env";

/**
 * Rate limiter for authentication endpoints (request-code)
 * Limits: 5 requests per window
 */
export const authLimiter = rateLimit({
	windowMs: config.RATE_LIMIT_WINDOW_MS,
	max: 5,
	message: {
		success: false,
		message:
			"Too many authentication attempts. Please try again later.",
		code: "RATE_LIMIT_EXCEEDED",
	},
	standardHeaders: true,
	legacyHeaders: false,
	skipSuccessfulRequests: false,
});

/**
 * Rate limiter for verification endpoints (verify-code)
 * Limits: 10 requests per window
 */
export const verifyLimiter = rateLimit({
	windowMs: config.RATE_LIMIT_WINDOW_MS,
	max: 10,
	message: {
		success: false,
		message:
			"Too many verification attempts. Please try again later.",
		code: "RATE_LIMIT_EXCEEDED",
	},
	standardHeaders: true,
	legacyHeaders: false,
});
