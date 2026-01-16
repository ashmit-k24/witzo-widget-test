import rateLimit from "express-rate-limit";
import { config } from "../config/env";

export const authLimiter = rateLimit({
	windowMs: config.RATE_LIMIT_WINDOW_MS,
	max: 5,
	standardHeaders: true,
	legacyHeaders: false,
	message: {
		success: false,
		message:
			"Too many authentication attempts. Please try again later.",
		code: "RATE_LIMIT_EXCEEDED",
	},
});

export const verifyLimiter = rateLimit({
	windowMs: config.RATE_LIMIT_WINDOW_MS,
	max: 10,
	standardHeaders: true,
	legacyHeaders: false,
	message: {
		success: false,
		message:
			"Too many verification attempts. Please try again later.",
		code: "RATE_LIMIT_EXCEEDED",
	},
});
