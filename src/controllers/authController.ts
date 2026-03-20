import {
	NextFunction,
	Request,
	Response,
} from "express";
import crypto from "crypto";
import axios from "axios";
import passport from "../config/passport";
import { config } from "../config/env";
import {
	clearCookies,
	setCookies,
} from "../middleware/auth";
import authService from "../services/authService";
import googleAuthService, {
	GoogleProfile,
} from "../services/googleAuthService";
import sessionService from "../services/sessionService";
import {
	ForgotPasswordBody,
	LoginPasswordBody,
	RegisterBody,
	ResetPasswordBody,
	RequestCodeBody,
	UpdateProfileBody,
	VerifyGoogleCodeBody,
	VerifyCodeBody,
} from "../types";
import logger from "../utils/logger";

const GOOGLE_OAUTH_CLIENT_STATE_COOKIE =
	"google_oauth_client_state";
const GOOGLE_OTP_PENDING_COOKIE =
	"google_otp_pending";
const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const getFrontendUrl = (): string =>
	process.env.FRONTEND_URL ||
	"http://localhost:3001";

const isProduction =
	process.env.NODE_ENV === "production";
const authFlowCookieOptions = {
	httpOnly: true,
	secure: isProduction,
	sameSite: "lax" as const,
	path: "/api/auth/google",
};

interface GooglePendingPayload {
	email: string;
	exp: number;
	iat: number;
	nonce: string;
}

interface GoogleOAuthStatePayload {
	clientState: string;
	exp: number;
	iat: number;
	nonce: string;
}

const encodeBase64Url = (value: string): string =>
	Buffer.from(value, "utf-8").toString("base64url");

const decodeBase64Url = (value: string): string =>
	Buffer.from(value, "base64url").toString("utf-8");

const createGoogleOAuthStateToken = (
	clientState: string,
): string => {
	const payload: GoogleOAuthStatePayload = {
		clientState,
		iat: Date.now(),
		exp: Date.now() + GOOGLE_OAUTH_STATE_TTL_MS,
		nonce: crypto
			.randomBytes(16)
			.toString("hex"),
	};
	const encodedPayload = encodeBase64Url(
		JSON.stringify(payload),
	);
	const signature = crypto
		.createHmac("sha256", config.COOKIE_SECRET)
		.update(encodedPayload)
		.digest("base64url");
	return `${encodedPayload}.${signature}`;
};

const parseGoogleOAuthStateToken = (
	token: string,
): GoogleOAuthStatePayload | null => {
	const parts = token.split(".");
	if (parts.length !== 2) {
		return null;
	}

	const [encodedPayload, signature] = parts;
	const expectedSignature = crypto
		.createHmac("sha256", config.COOKIE_SECRET)
		.update(encodedPayload)
		.digest("base64url");

	let validSignature = false;
	try {
		validSignature = crypto.timingSafeEqual(
			Buffer.from(signature, "utf-8"),
			Buffer.from(expectedSignature, "utf-8"),
		);
	} catch {
		validSignature = false;
	}
	if (!validSignature) {
		return null;
	}

	try {
		const payload = JSON.parse(
			decodeBase64Url(encodedPayload),
		) as GoogleOAuthStatePayload;
		if (
			typeof payload.clientState !== "string" ||
			typeof payload.exp !== "number" ||
			typeof payload.iat !== "number" ||
			typeof payload.nonce !== "string"
		) {
			return null;
		}
		if (Date.now() > payload.exp) {
			return null;
		}
		return payload;
	} catch {
		return null;
	}
};

const parseGooglePendingToken = (
	token: string,
): GooglePendingPayload | null => {
	const parts = token.split(".");
	if (parts.length !== 2) {
		return null;
	}

	const [encodedPayload, signature] = parts;
	const expectedSignature = crypto
		.createHmac("sha256", config.COOKIE_SECRET)
		.update(encodedPayload)
		.digest("base64url");

	let validSignature = false;
	try {
		validSignature = crypto.timingSafeEqual(
			Buffer.from(signature, "utf-8"),
			Buffer.from(expectedSignature, "utf-8"),
		);
	} catch {
		validSignature = false;
	}
	if (!validSignature) {
		return null;
	}

	try {
		const payload = JSON.parse(
			decodeBase64Url(encodedPayload),
		) as GooglePendingPayload;
		if (
			typeof payload.email !== "string" ||
			typeof payload.exp !== "number" ||
			typeof payload.iat !== "number" ||
			typeof payload.nonce !== "string"
		) {
			return null;
		}
		if (Date.now() > payload.exp) {
			return null;
		}
		return payload;
	} catch {
		return null;
	}
};

/**
 * @route   POST /api/auth/request-code
 * @desc    Request verification code for email authentication
 * @access  Public
 */
const verifyEmailDeliverability = async (
	email: string,
): Promise<boolean> => {
	const apiKey = config.EMAIL_LIST_VERIFY_API_KEY;
	if (!apiKey) {
		return true; // Skip if not configured
	}

	try {
		const response = await axios.get<string>(
			"https://apps.emaillistverify.com/api/verifyEmail",
			{
				params: {
					secret: apiKey,
					email,
					timeout: 15,
				},
				timeout: 20000,
				responseType: "text",
			},
		);
		const result = String(response.data).trim().toLowerCase();
		logger.info("Email deliverability check", { email, result });
		return result === "ok";
	} catch (err) {
		logger.warn("Email deliverability check failed, allowing through", {
			email,
			error: err instanceof Error ? err.message : String(err),
		});
		return true; // Fail open — don't block users if the API is down
	}
};

export const requestCode = async (
	req: Request<{}, {}, RequestCodeBody>,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { email } = req.body;

		logger.info("Verification code requested", {
			email,
			ip: req.ip,
			userAgent: req.get("user-agent"),
		});

		const isDeliverable = await verifyEmailDeliverability(email);
		if (!isDeliverable) {
			res.status(422).json({
				success: false,
				message: "Please provide a valid email address.",
			});
			return;
		}

		const result =
			await authService.requestVerificationCode(
				email,
			);

		res.status(200).json({
			success: result.success,
			message: result.message,
		});
	} catch (error) {
		next(error);
	}
};

/**
 * @route   POST /api/auth/forgot-password
 * @desc    Request a password reset link
 * @access  Public
 */
export const forgotPassword = async (
	req: Request<{}, {}, ForgotPasswordBody>,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { email } = req.body;

		logger.info("Password reset requested", {
			email,
			ip: req.ip,
			userAgent: req.get("user-agent"),
		});

		const result =
			await authService.requestPasswordReset(
				email,
			);

		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};

/**
 * @route   POST /api/auth/verify
 * @desc    Verify code and login (sets authentication cookies)
 * @access  Public
 */
export const verifyCode = async (
	req: Request<{}, {}, VerifyCodeBody>,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { email, code } = req.body;
		const ipAddress = req.ip;
		const userAgent = req.get("user-agent");

		logger.info("Verification attempt", {
			email,
			ip: ipAddress,
			userAgent,
		});

		const result = await authService.verifyCode(
			email,
			code,
			ipAddress,
			userAgent,
		);

		if (
			result.success &&
			result.accessToken &&
			result.refreshToken
		) {
			// Set authentication cookies
			setCookies(
				res,
				result.accessToken,
				result.refreshToken,
			);

			// Return success response without tokens (they're in cookies)
			// Include token expiry info for frontend to schedule refresh
			res.status(200).json({
				success: true,
				message: result.message,
				expiresIn:
					config.ACCESS_TOKEN_EXPIRY_MINUTES * 60, // in seconds
			});
		} else {
			const statusCode = result.success
				? 200
				: 401;
			res.status(statusCode).json({
				success: result.success,
				message: result.message,
				remainingAttempts:
					result.remainingAttempts,
			});
		}
	} catch (error) {
		next(error);
	}
};

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token using refresh token from cookies
 * @access  Public (requires refresh token cookie)
 */
export const refreshToken = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const refreshToken =
			req.cookies?.refresh_token;

		if (!refreshToken) {
			res.status(401).json({
				success: false,
				message: "Refresh token not found",
				code: "NO_REFRESH_TOKEN",
			});
			return;
		}

		logger.debug("Token refresh requested", {
			ip: req.ip,
		});

		const result =
			await authService.refreshAccessToken(
				refreshToken,
			);

		if (
			result.success &&
			result.accessToken &&
			result.newRefreshToken
		) {
			// Set new authentication cookies
			setCookies(
				res,
				result.accessToken,
				result.newRefreshToken,
			);

			res.status(200).json({
				success: true,
				message: result.message,
				expiresIn:
					config.ACCESS_TOKEN_EXPIRY_MINUTES * 60, // in seconds
			});
		} else {
			// Clear invalid cookies
			clearCookies(res);

			res.status(401).json({
				success: false,
				message: result.message,
				code: "REFRESH_FAILED",
			});
		}
	} catch (error) {
		next(error);
	}
};

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user and clear authentication cookies
 * @access  Protected
 */
export const logout = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const accessToken = req.cookies?.access_token;

		if (!accessToken) {
			res.status(401).json({
				success: false,
				message: "No active session",
				code: "NO_SESSION",
			});
			return;
		}

		logger.info("Logout requested", {
			userId: req.user?.id,
			email: req.user?.email,
		});

		const result =
			await authService.logout(accessToken);

		// Clear authentication cookies
		clearCookies(res);

		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};

/**
 * @route   GET /api/auth/me
 * @desc    Get current authenticated user information
 * @access  Protected
 */
export const getCurrentUser = async (
	req: Request,
	res: Response,
): Promise<void> => {
	res.status(200).json({ user: req.user });
};

/**
 * @route   GET /api/auth/validate
 * @desc    Validate current session
 * @access  Protected
 */
export const validateSession = async (
	req: Request,
	res: Response,
): Promise<void> => {
	res.status(200).json({
		success: true,
		message: "Session is valid",
		user: req.user,
	});
};

/**
 * @route   GET /api/auth/profile
 * @desc    Get current user's profile completion status
 * @access  Protected
 */
export const getProfileStatus = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = req.user?.id;
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const profile =
			await authService.getProfileStatus(userId);
		res.status(200).json({
			success: true,
			user: profile,
		});
	} catch (error) {
		next(error);
	}
};

/**
 * @route   PUT /api/auth/profile
 * @desc    Update required profile fields
 * @access  Protected
 */
export const updateProfile = async (
	req: Request<{}, {}, UpdateProfileBody>,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = req.user?.id;
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const updated = await authService.updateUserProfile(
			userId,
			req.body,
		);
		res.status(200).json({
			success: true,
			message: "Profile updated successfully",
			user: updated,
		});
	} catch (error) {
		next(error);
	}
};

/**
 * @route   PUT /api/auth/onboarding
 * @desc    Mark an onboarding step as complete (step 4 auto-completes onboarding)
 * @access  Protected
 */
export const updateOnboarding = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = req.user?.id;
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const step = Number(req.body.step);
		const user = await authService.updateOnboardingStep(userId, step);
		res.status(200).json({ success: true, user });
	} catch (error) {
		next(error);
	}
};

/**
 * @route   GET /api/auth/sessions
 * @desc    Get all active sessions for the current user
 * @access  Protected
 */
export const getSessions = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const user = req.user;
		const currentSessionId = user?.sessionId;

		const result =
			await sessionService.getUserSessions(
				user?.id ?? "",
				currentSessionId,
			);

		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};

/**
 * @route   DELETE /api/auth/sessions/:sessionId
 * @desc    Revoke a specific session
 * @access  Protected
 */
export const revokeSession = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const user = req.user;
		const sessionIdToRevoke = parseInt(
			req.params.sessionId,
			10,
		);
		const currentSessionId = user?.sessionId;

		if (isNaN(sessionIdToRevoke)) {
			res.status(400).json({
				success: false,
				message: "Invalid session ID",
			});
			return;
		}

		const result =
			await sessionService.revokeSession(
				user?.id ?? "",
				sessionIdToRevoke,
				currentSessionId,
			);

		res.status(result.success ? 200 : 400).json(
			result,
		);
	} catch (error) {
		next(error);
	}
};

/**
 * @route   POST /api/auth/sessions/revoke-all
 * @desc    Revoke all sessions except current one
 * @access  Protected
 */
export const revokeAllOtherSessions = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const user = req.user;
		const currentSessionId = user?.sessionId;

		if (!currentSessionId) {
			res.status(400).json({
				success: false,
				message: "Current session not found",
			});
			return;
		}

		const result =
			await sessionService.revokeAllOtherSessions(
				user?.id ?? "",
				currentSessionId,
			);

		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};

/**
 * @route   POST /api/auth/logout-all
 * @desc    Logout from all devices (including current)
 * @access  Protected
 */
export const logoutAll = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const result =
			await sessionService.revokeAllSessions(
				req.user?.id ?? "",
			);

		// Clear cookies for current session
		clearCookies(res);

		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};

export const initiateGoogleAuth = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const queryClientState =
			typeof req.query.clientState ===
			"string"
				? req.query.clientState.trim()
				: "";
		const clientState =
			queryClientState.length >= 32
				? queryClientState
				: crypto
						.randomBytes(32)
						.toString("hex");
		const state =
			createGoogleOAuthStateToken(
				clientState,
			);
		res.cookie(
			GOOGLE_OAUTH_CLIENT_STATE_COOKIE,
			clientState,
			{
				...authFlowCookieOptions,
				maxAge: GOOGLE_OAUTH_STATE_TTL_MS,
			},
		);

		passport.authenticate("google", {
			session: false,
			state,
		})(req, res, next);
	} catch (error) {
		next(error);
	}
};

export const validateGoogleOAuthState = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	const queryStateToken = String(
		req.query.state || "",
	);
	const cookieClientState = String(
		req.cookies?.[
			GOOGLE_OAUTH_CLIENT_STATE_COOKIE
		] || "",
	);
	const parsedState =
		parseGoogleOAuthStateToken(
			queryStateToken,
		);

	if (!parsedState || !cookieClientState) {
		logger.warn("Missing Google OAuth state", {
			ip: req.ip,
		});
		res.clearCookie(
			GOOGLE_OAUTH_CLIENT_STATE_COOKIE,
			{
				...authFlowCookieOptions,
			},
		);
		res.redirect(
			`${getFrontendUrl()}/?error=invalid_oauth_state`,
		);
		return;
	}

	let stateMatches = false;
	try {
		stateMatches = crypto.timingSafeEqual(
			Buffer.from(
				parsedState.clientState,
				"utf-8",
			),
			Buffer.from(cookieClientState, "utf-8"),
		);
	} catch {
		stateMatches = false;
	}

	if (!stateMatches) {
		logger.warn("Invalid Google OAuth state", {
			ip: req.ip,
		});
		res.clearCookie(
			GOOGLE_OAUTH_CLIENT_STATE_COOKIE,
			{
				...authFlowCookieOptions,
			},
		);
		res.redirect(
			`${getFrontendUrl()}/?error=invalid_oauth_state`,
		);
		return;
	}

	res.clearCookie(
		GOOGLE_OAUTH_CLIENT_STATE_COOKIE,
		{
			...authFlowCookieOptions,
		},
	);
	next();
};

/**
 * @route   GET /api/auth/google/callback
 * @desc    Handle Google OAuth callback and complete login
 * @access  Public
 */
export const googleCallback = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const profile = req.user as unknown as GoogleProfile;

		if (!profile || !profile.email) {
			res.redirect(
				`${getFrontendUrl()}/?error=invalid_profile`,
			);
			return;
		}

		logger.info("Google OAuth callback", {
			email: profile.email,
			ip: req.ip,
		});

		if (!profile.verified_email) {
			res.redirect(
				`${getFrontendUrl()}/?error=google_email_not_verified`,
			);
			return;
		}

		const result =
			await googleAuthService.authenticateWithGoogle(
				profile,
				req.ip,
				req.get("user-agent"),
			);

		if (
			!result.success ||
			!result.accessToken ||
			!result.refreshToken
		) {
			res.redirect(
				`${getFrontendUrl()}/?error=google_auth_failed`,
			);
			return;
		}

		setCookies(
			res,
			result.accessToken,
			result.refreshToken,
		);
		res.clearCookie(
			GOOGLE_OTP_PENDING_COOKIE,
			{
				...authFlowCookieOptions,
			},
		);
		res.redirect(`${getFrontendUrl()}/dashboard`);
	} catch (error) {
		next(error);
	}
};

/**
 * @route   POST /api/auth/google/verify
 * @desc    Verify OTP issued after Google OAuth and complete login
 * @access  Public
 */
export const verifyGoogleCode = async (
	req: Request<{}, {}, VerifyGoogleCodeBody>,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { code } = req.body;
		const bodyPendingToken =
			typeof req.body.pendingToken ===
			"string"
				? req.body.pendingToken.trim()
				: "";
		const pendingToken =
			bodyPendingToken ||
			req.cookies?.[
				GOOGLE_OTP_PENDING_COOKIE
			] ||
			"";

		if (!pendingToken) {
			res.status(401).json({
				success: false,
				message:
					"Google verification session expired. Please sign in with Google again.",
			});
			return;
		}

		const pendingPayload =
			parseGooglePendingToken(pendingToken);
		if (!pendingPayload) {
			res.clearCookie(
				GOOGLE_OTP_PENDING_COOKIE,
				{
					...authFlowCookieOptions,
				},
			);
			res.status(401).json({
				success: false,
				message:
					"Google verification session expired. Please sign in with Google again.",
			});
			return;
		}

		const result = await authService.verifyCode(
			pendingPayload.email,
			code,
			req.ip,
			req.get("user-agent"),
		);

		if (
			result.success &&
			result.accessToken &&
			result.refreshToken
		) {
			setCookies(
				res,
				result.accessToken,
				result.refreshToken,
			);
			res.clearCookie(
				GOOGLE_OTP_PENDING_COOKIE,
				{
					...authFlowCookieOptions,
				},
			);
			res.status(200).json({
				success: true,
				message: result.message,
				expiresIn:
					config.ACCESS_TOKEN_EXPIRY_MINUTES *
					60,
			});
			return;
		}

		res.status(401).json({
			success: false,
			message: result.message,
			remainingAttempts:
				result.remainingAttempts,
		});
	} catch (error) {
		next(error);
	}
};

/**
 * @route   POST /api/auth/register
 * @desc    Register a new account with email + password
 * @access  Public
 */
export const register = async (
	req: Request<{}, {}, RegisterBody>,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { email, password } = req.body;

		logger.info("Password registration attempt", {
			email,
			ip: req.ip,
		});

		const isDeliverable = await verifyEmailDeliverability(email);
		if (!isDeliverable) {
			res.status(422).json({
				success: false,
				message: "Please provide a valid email address.",
			});
			return;
		}

		const result = await authService.registerWithPassword(
			email,
			password,
			req.ip,
			req.get("user-agent"),
		);

		if (result.success && result.accessToken && result.refreshToken) {
			setCookies(res, result.accessToken, result.refreshToken);
			res.status(201).json({
				success: true,
				message: result.message,
				expiresIn: result.expiresIn,
			});
		} else if (result.success) {
			// OTP sent — no tokens yet, user must verify email
			res.status(200).json({
				success: true,
				message: result.message,
			});
		} else {
			res.status(409).json({
				success: false,
				message: result.message,
			});
		}
	} catch (error) {
		next(error);
	}
};

/**
 * @route   POST /api/auth/login-password
 * @desc    Log in with email + password
 * @access  Public
 */
export const loginWithPassword = async (
	req: Request<{}, {}, LoginPasswordBody>,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { email, password } = req.body;

		logger.info("Password login attempt", {
			email,
			ip: req.ip,
		});

		const result = await authService.loginWithPassword(
			email,
			password,
			req.ip,
			req.get("user-agent"),
		);

		if (result.success && result.accessToken && result.refreshToken) {
			setCookies(res, result.accessToken, result.refreshToken);
			res.status(200).json({
				success: true,
				message: result.message,
				expiresIn: result.expiresIn,
			});
		} else {
			res.status(401).json({
				success: false,
				message: result.message,
			});
		}
	} catch (error) {
		next(error);
	}
};

/**
 * @route   POST /api/auth/reset-password
 * @desc    Reset the user's password using a reset token
 * @access  Public
 */
export const resetPassword = async (
	req: Request<{}, {}, ResetPasswordBody>,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { token, password } = req.body;

		logger.info("Password reset attempt", {
			ip: req.ip,
			userAgent: req.get("user-agent"),
		});

		const result = await authService.resetPassword(
			token,
			password,
		);

		res.status(result.success ? 200 : 400).json(
			result,
		);
	} catch (error) {
		next(error);
	}
};
