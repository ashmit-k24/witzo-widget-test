import {
	NextFunction,
	Request,
	Response,
} from "express";
import { config } from "../config/env";
import authService from "../services/authService";
import logger from "../utils/logger";

// Extend Express Request type to include user
declare global {
	namespace Express {
		interface Request {
			user?: User; // Allow only User for OAuth profiles
		}
	}
}

/**
 * Cookie names for authentication tokens
 */
export const COOKIE_NAMES = {
	ACCESS_TOKEN: "access_token",
	REFRESH_TOKEN: "refresh_token",
} as const;

/**
 * Authentication middleware that validates access token from cookies
 * Automatically attempts to refresh the token if expired
 */
export const authenticateToken = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		// Get access token from cookie
		const accessToken =
			req.cookies?.[COOKIE_NAMES.ACCESS_TOKEN];

		if (!accessToken) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
				code: "NO_TOKEN",
			});
			return;
		}

		// Validate access token
		const validation =
			await authService.validateAccessToken(
				accessToken,
			);

		if (validation.valid && validation.user) {
			// Token is valid, attach user to request
			req.user = validation.user;
			next();
			return;
		}

		// Access token is invalid or expired
		// Try to refresh using refresh token
		const refreshToken =
			req.cookies?.[COOKIE_NAMES.REFRESH_TOKEN];

		if (!refreshToken) {
			res.status(401).json({
				success: false,
				message:
					"Session expired. Please login again.",
				code: "TOKEN_EXPIRED",
			});
			return;
		}

		// Attempt to refresh the access token
		const refreshResult =
			await authService.refreshAccessToken(
				refreshToken,
			);

		if (
			!refreshResult.success ||
			!refreshResult.accessToken ||
			!refreshResult.newRefreshToken
		) {
			// Clear cookies and require re-login
			clearCookies(res);

			res.status(401).json({
				success: false,
				message:
					"Session expired. Please login again.",
				code: "REFRESH_FAILED",
			});
			return;
		}

		// Set new tokens in cookies
		setCookies(
			res,
			refreshResult.accessToken,
			refreshResult.newRefreshToken,
		);

		// Attach user to request
		req.user = refreshResult.user;

		logger.debug(
			"Token automatically refreshed",
			{
				userId: refreshResult.user?.id,
			},
		);

		next();
	} catch (error) {
		const err = error as Error;
		logger.error(
			"Authentication middleware error",
			{
				error: err.message,
				stack: err.stack,
			},
		);

		res.status(500).json({
			success: false,
			message: "Authentication failed",
			code: "AUTH_ERROR",
		});
	}
};

/**
 * Optional authentication middleware
 * Attaches user to request if valid token exists, but doesn't reject if missing
 */
export const optionalAuth = async (
	req: Request,
	_res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const accessToken =
			req.cookies?.[COOKIE_NAMES.ACCESS_TOKEN];

		if (!accessToken) {
			next();
			return;
		}

		const validation =
			await authService.validateAccessToken(
				accessToken,
			);

		if (validation.valid && validation.user) {
			req.user = validation.user;
		}

		next();
	} catch (error) {
		// Log error but continue without authentication
		const err = error as Error;
		logger.error(
			"Optional auth middleware error",
			{
				error: err.message,
			},
		);
		next();
	}
};

/**
 * Helper function to set authentication cookies
 */
export const setCookies = (
	res: Response,
	accessToken: string,
	refreshToken: string,
	options?: {
		secure?: boolean;
		sameSite?:
			| boolean
			| "lax"
			| "strict"
			| "none";
		domain?: string;
	},
): void => {
	const isProduction =
		process.env.NODE_ENV === "production";
	const defaultSameSite:
		| boolean
		| "none"
		| "lax"
		| "strict" =
		options?.sameSite ??
		(isProduction ? "none" : "lax");
	const secureFlag =
		options?.secure ??
		(isProduction || defaultSameSite === "none");

	const cookieBaseOptions = {
		httpOnly: true,
		secure: secureFlag,
		sameSite: defaultSameSite,
		domain: options?.domain,
		path: "/",
	} as const;

	// Access token cookie - use config values
	res.cookie(
		COOKIE_NAMES.ACCESS_TOKEN,
		accessToken,
		{
			...cookieBaseOptions,
			maxAge:
				config.ACCESS_TOKEN_EXPIRY_MINUTES *
				60 *
				1000,
		},
	);

	// Refresh token cookie - use config values
	res.cookie(
		COOKIE_NAMES.REFRESH_TOKEN,
		refreshToken,
		{
			...cookieBaseOptions,
			maxAge:
				config.REFRESH_TOKEN_EXPIRY_DAYS *
				24 *
				60 *
				60 *
				1000,
		},
	);
};

/**
 * Helper function to clear authentication cookies
 */
export const clearCookies = (
	res: Response,
	options?: { domain?: string },
): void => {
	const isProduction =
		process.env.NODE_ENV === "production";
	const sameSite = isProduction ? "none" : "lax";

	res.clearCookie(COOKIE_NAMES.ACCESS_TOKEN, {
		httpOnly: true,
		secure: isProduction,
		sameSite,
		domain: options?.domain,
		path: "/",
	});

	res.clearCookie(COOKIE_NAMES.REFRESH_TOKEN, {
		httpOnly: true,
		secure: isProduction,
		sameSite,
		domain: options?.domain,
		path: "/",
	});
};
