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

export const adminLoginLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 5,
	message: {
		success: false,
		message:
			"Too many admin login attempts. Please try again later.",
		code: "ADMIN_RATE_LIMIT_EXCEEDED",
	},
	standardHeaders: true,
	legacyHeaders: false,
});

const publicWidgetKeyGenerator = (req: {
	ip?: string;
	body?: {
		widgetKey?: string;
	};
}) =>
	`${req.ip || "unknown"}:${req.body?.widgetKey || "anonymous-widget"}`;

export const publicWidgetChatLimiter = rateLimit({
	windowMs: 60 * 1000,
	max: 50,
	standardHeaders: true,
	legacyHeaders: false,
	keyGenerator: publicWidgetKeyGenerator,
	message: {
		success: false,
		message:
			"Too many widget chat requests. Please slow down and try again shortly.",
		code: "WIDGET_CHAT_RATE_LIMIT_EXCEEDED",
	},
});

export const publicWidgetActionLimiter =
	rateLimit({
		windowMs: 60 * 1000,
		max: 50,
		standardHeaders: true,
		legacyHeaders: false,
		keyGenerator: publicWidgetKeyGenerator,
		message: {
			success: false,
			message:
				"Too many widget actions. Please try again shortly.",
			code: "WIDGET_ACTION_RATE_LIMIT_EXCEEDED",
		},
	});
