import crypto from "crypto";
import {
	NextFunction,
	Request,
	Response,
} from "express";
import { config } from "../config/env";
import {
	CSRF_COOKIE_NAME,
	CSRF_HEADER_NAME,
	CSRF_RESPONSE_HEADER_NAME,
	CSRF_SAFE_METHODS,
	CSRF_TOKEN_MAX_AGE_MS,
} from "../constants";
import logger from "../utils/logger";

/**
 * CSRF Protection Middleware using Double Submit Cookie pattern
 * More suitable for cookie-based authentication with SPAs
 */

/**
 * Generate a cryptographically secure CSRF token
 */
function generateCsrfToken(): string {
	return crypto.randomBytes(32).toString("hex");
}

/**
 * Middleware to set CSRF token cookie
 * Call this on GET requests that serve pages/SPAs
 */
export const setCsrfToken = (
	req: Request,
	res: Response,
	next: NextFunction,
): void => {
	// Generate or reuse existing CSRF token
	let csrfToken = req.cookies?.[CSRF_COOKIE_NAME];

	if (!csrfToken) {
		csrfToken = generateCsrfToken();

		// Set CSRF token as a cookie
		res.cookie(CSRF_COOKIE_NAME, csrfToken, {
			httpOnly: false, // Must be readable by JavaScript
			secure: config.NODE_ENV === "production",
			// "lax" (not "strict") allows the cookie to be sent on
			// top-level cross-site navigations (e.g. OAuth redirects),
			// which is required for the Google OAuth callback flow.
			sameSite: "lax",
			maxAge: CSRF_TOKEN_MAX_AGE_MS,
			path: "/",
		});
	}

	// Also send in response header for convenience
	res.setHeader(CSRF_RESPONSE_HEADER_NAME, csrfToken);
	next();
};

/**
 * Middleware to verify CSRF token on state-changing operations
 * Use this on POST, PUT, PATCH, DELETE routes
 */
export const verifyCsrfToken = (
	req: Request,
	res: Response,
	next: NextFunction,
): void => {
	// Skip CSRF check for safe methods
	if (
		(CSRF_SAFE_METHODS as readonly string[]).includes(
			req.method,
		)
	) {
		next();
		return;
	}

	const cookieToken =
		req.cookies?.[CSRF_COOKIE_NAME];
	const headerToken = req.get(CSRF_HEADER_NAME);

	// Check if both tokens exist
	if (!cookieToken || !headerToken) {
		logger.warn("CSRF token missing", {
			path: req.path,
			method: req.method,
			ip: req.ip,
			hasCookie: !!cookieToken,
			hasHeader: !!headerToken,
		});

		res.status(403).json({
			success: false,
			message: "CSRF token missing",
			code: "CSRF_TOKEN_MISSING",
		});
		return;
	}

	// Verify tokens match using constant-time comparison
	const cookieBuffer = Buffer.from(cookieToken);
	const headerBuffer = Buffer.from(headerToken);

	let tokensMatch = false;
	try {
		tokensMatch = crypto.timingSafeEqual(
			cookieBuffer,
			headerBuffer,
		);
	} catch (error) {
		// Tokens are different lengths
		tokensMatch = false;
	}

	if (!tokensMatch) {
		logger.warn("CSRF token mismatch", {
			path: req.path,
			method: req.method,
			ip: req.ip,
		});

		res.status(403).json({
			success: false,
			message: "Invalid CSRF token",
			code: "CSRF_TOKEN_INVALID",
		});
		return;
	}

	// Tokens match, allow request
	next();
};

/**
 * Combined middleware that sets and verifies CSRF token
 * Use this as a catch-all if you want automatic CSRF protection
 */
export const csrfProtection = [
	setCsrfToken,
	verifyCsrfToken,
];
