import crypto from "crypto";
import { PoolClient } from "pg";
import pool from "../config/database";
import {
	redisAnalytics,
	redisCache,
} from "../config/redis";
import { WIDGET_ANALYTICS_BUFFER_KEY } from "../constants/widget.constants";
import { PlanType } from "../config/planConfig";
import { config } from "../config/env";
import {
	CleanupResult,
	ChangePasswordBody,
	LogoutResponse,
	RefreshTokenResponse,
	RequestCodeResponse,
	User,
	UserResponse,
	ValidationResponse,
	VerificationCode,
	VerifyCodeResponse,
} from "../types";
import {
	isStrongUserPassword,
	USER_PASSWORD_POLICY_MESSAGE,
} from "../utils/passwordPolicy";
import logger from "../utils/logger";
import tokenUtil from "../utils/token";
import uuidUtil from "../utils/uuid";
import emailService from "./emailService";
import { pineconeService } from "./pineconeService";
import { widgetIconStorageService } from "./widgetIconStorageService";
import { scraperQueue } from "../config/queue";
import { subscriptionService } from "./subscriptionService";
import { getUserSystemMessageSelectFields } from "./userSystemMessageSchemaService";
import { hubspotIntegrationService } from "./hubspotIntegrationService";
import { zohoIntegrationService } from "./zohoIntegrationService";
import { salesforceIntegrationService } from "./salesforceIntegrationService";
import { calendlyIntegrationService } from "./calendlyIntegrationService";

/**
 * Authentication Service
 * Handles email-based authentication with JWT tokens and refresh tokens
 */
class AuthService {
	private async createDeletionRequest(
		userId: string,
		email: string,
		context?: {
			ipAddress?: string | null;
			userAgent?: string | null;
		},
	): Promise<string> {
		const result = await pool.query<{ id: string }>(
			`INSERT INTO account_deletion_requests
				(user_id, email, status, requested_ip, requested_user_agent)
			 VALUES ($1, $2, 'pending', $3, $4)
			 RETURNING id`,
			[
				userId,
				email,
				context?.ipAddress ?? null,
				context?.userAgent ?? null,
			],
		);

		return result.rows[0].id;
	}

	private async updateDeletionRequest(
		requestId: string,
		payload: {
			status: "pending" | "in_progress" | "completed" | "failed";
			failureReason?: string | null;
			completedAt?: boolean;
		},
	): Promise<void> {
		await pool.query(
			`UPDATE account_deletion_requests
			    SET status = $2,
			        failure_reason = $3,
			        completed_at = CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE completed_at END,
			        updated_at = CURRENT_TIMESTAMP
			  WHERE id = $1`,
			[
				requestId,
				payload.status,
				payload.failureReason ?? null,
				payload.completedAt ?? false,
			],
		);
	}

	private createHttpError(
		message: string,
		statusCode: number,
	): Error & { statusCode: number } {
		const error = new Error(message) as Error & {
			statusCode: number;
		};
		error.statusCode = statusCode;
		return error;
	}

	/**
	 * Generate a cryptographically secure 6-digit verification code
	 */
	private generateVerificationCode(): string {
		// Use crypto.randomInt for cryptographically secure random numbers
		const randomNum = crypto.randomInt(
			100000,
			1000000,
		);
		return randomNum.toString();
	}

	/**
	 * Convert database user to API response format
	 */
	private formatUserResponse(
		user: User & { password_hash?: string | null },
		sessionId?: number,
	): UserResponse {
		return {
			id: user.id,
			email: user.email,
			isVerified: user.is_verified,
			hasPassword: Boolean(user.password_hash),
			plan_type: user.plan_type,
			sessionId,
			loginCount: user.login_count,
			fullName: user.full_name,
			companyName: user.company_name,
			phoneNumber: user.phone_number,
			country: user.country,
			jobTitle: user.job_title,
			industry: user.industry,
			companyWebsite: user.company_website,
			profileCompleted: user.profile_completed,
			profileCompletedAt:
				user.profile_completed_at,
			onboardingStep: user.onboarding_step,
			onboardingCompleted: user.onboarding_completed,
			dashboardTourCompleted:
				user.dashboard_tour_completed,
			dashboardTourCompletedAt:
				user.dashboard_tour_completed_at,
			useDefaultSystemMessage:
				user.use_default_system_message ?? true,
			systemMessageConfigured:
				user.system_message_configured ??
				user.onboarding_completed,
			knowledgeBoundary:
				user.knowledge_boundary ?? "workspace_only",
		};
	}

	private normalizeOptionalText(
		value: unknown,
	): string | null {
		if (typeof value !== "string") return null;
		const normalized = value.trim();
		return normalized.length > 0 ? normalized : null;
	}

	private async scanRedisKeys(
		pattern: string,
	): Promise<string[]> {
		const keys: string[] = [];
		let cursor = "0";
		do {
			const [nextCursor, batch] =
				await redisCache.scan(
					cursor,
					"MATCH",
					pattern,
					"COUNT",
					100,
				);
			cursor = nextCursor;
			keys.push(...batch);
		} while (cursor !== "0");
		return keys;
	}

	private async clearScraperRedisKeysForUser(
		userId: string,
	): Promise<void> {
		const matchingKeys: string[] = [];
		let cursor = "0";

		do {
			const [nextCursor, batch] =
				await redisCache.scan(
					cursor,
					"MATCH",
					"scraper:job:*",
					"COUNT",
					100,
				);
			cursor = nextCursor;
			if (batch.length === 0) {
				continue;
			}

			const pipeline = redisCache.pipeline();
			for (const key of batch) {
				pipeline.get(key);
			}
			const responses = await pipeline.exec();
			responses?.forEach((response, index) => {
				const [, rawValue] = response || [];
				if (typeof rawValue !== "string") {
					return;
				}
				try {
					const parsed = JSON.parse(rawValue) as {
						userId?: string;
					};
					if (parsed.userId === userId) {
						matchingKeys.push(batch[index]);
					}
				} catch {
					// Ignore malformed cached job payloads
				}
			});
		} while (cursor !== "0");

		if (matchingKeys.length > 0) {
			await redisCache.del(...matchingKeys);
		}
	}

	private async removePendingScrapeJobsForUser(
		userId: string,
	): Promise<void> {
		const jobs = await scraperQueue.getJobs(
			[
				"waiting",
				"delayed",
				"prioritized",
				"paused",
				"waiting-children",
			],
			0,
			-1,
			false,
		);

		for (const job of jobs) {
			if (job.data?.userId !== userId) {
				continue;
			}

			try {
				await job.remove();
			} catch (error) {
				logger.warn(
					"Failed to remove pending scrape job during account deletion",
					{
						userId,
						jobId: job.id,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}
		}
	}

	private async clearUserRedisState(
		userId: string,
		chatSessionIds: string[],
	): Promise<void> {
		const directKeys = [
			`scraper:user:${userId}:latest`,
			`usage:stats:${userId}`,
		];
		for (const sessionId of chatSessionIds) {
			directKeys.push(
				`chat:session:${sessionId}`,
				`chat:appointment-lead:${sessionId}`,
			);
		}

		const retrievalKeys =
			await this.scanRedisKeys(
				`chat:retrieval:${userId}:*`,
			);
		const keysToDelete = [
			...directKeys,
			...retrievalKeys,
		].filter(Boolean);

		if (keysToDelete.length > 0) {
			await redisCache.del(...keysToDelete);
		}

		await this.clearScraperRedisKeysForUser(userId);
	}

	private async removeBufferedWidgetAnalytics(
		widgetKeyId: number,
	): Promise<void> {
		const rawEvents = await redisAnalytics.lrange(
			WIDGET_ANALYTICS_BUFFER_KEY,
			0,
			-1,
		);
		if (rawEvents.length === 0) {
			return;
		}

		const filteredEvents = rawEvents.filter((raw) => {
			try {
				const parsed = JSON.parse(raw) as {
					widget_key_id?: number;
				};
				return parsed.widget_key_id !== widgetKeyId;
			} catch {
				return true;
			}
		});

		if (filteredEvents.length === rawEvents.length) {
			return;
		}

		const pipeline = redisAnalytics.pipeline();
		pipeline.del(WIDGET_ANALYTICS_BUFFER_KEY);
		if (filteredEvents.length > 0) {
			pipeline.rpush(
				WIDGET_ANALYTICS_BUFFER_KEY,
				...filteredEvents,
			);
		}
		await pipeline.exec();
	}

	private async disconnectExternalIntegrationsForUser(
		userId: string,
	): Promise<void> {
		const steps: Array<{
			label: string;
			run: () => Promise<void>;
		}> = [
			{
				label: "Calendly",
				run: () =>
					calendlyIntegrationService.disconnect(
						userId,
					),
			},
			{
				label: "HubSpot",
				run: () =>
					hubspotIntegrationService.disconnect(
						userId,
					),
			},
			{
				label: "Zoho",
				run: () =>
					zohoIntegrationService.disconnect(
						userId,
					),
			},
			{
				label: "Salesforce",
				run: () =>
					salesforceIntegrationService.disconnect(
						userId,
					),
			},
		];

		for (const step of steps) {
			try {
				await step.run();
			} catch (error) {
				logger.warn(
					"External integration disconnect failed during account deletion",
					{
						userId,
						integration: step.label,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}
		}
	}

	/**
	 * Request verification code for authentication
	 */
	async requestVerificationCode(
		email: string,
	): Promise<RequestCodeResponse> {
		const client: PoolClient =
			await pool.connect();

		try {
			await client.query("BEGIN");

			const normalizedEmail = email
				.toLowerCase()
				.trim();

			// Check if user exists, if not create one with a unique UUID
			const userResult = await client.query<User>(
				"SELECT id, is_verified FROM users WHERE email = $1",
				[normalizedEmail],
			);

			let userId: string;
			if (userResult.rows.length === 0) {
				// Create new user with a unique UUID (long string, not sequential)
				const newUserId = uuidUtil.generateUuid();
				const insertResult = await client.query<{
					id: string;
				}>(
					"INSERT INTO users (id, email) VALUES ($1, $2) RETURNING id",
					[newUserId, normalizedEmail],
				);
				userId = insertResult.rows[0].id;
				logger.info("New user created", {
					email: normalizedEmail,
					userId,
				});
			} else {
				// Email exists - use the same existing ID
				userId = userResult.rows[0].id;
				logger.info("Existing user found", {
					email: normalizedEmail,
					userId,
				});
			}

			// Service-layer rate limiting: Check unused code requests in last hour
			const recentRequestsResult =
				await client.query(
					`SELECT COUNT(*) as count FROM verification_codes
         WHERE user_id = $1
         AND created_at > NOW() - INTERVAL '1 hour'
         AND is_used = FALSE`,
					[userId],
				);

			const recentRequests = parseInt(
				recentRequestsResult.rows[0].count,
				10,
			);
			if (recentRequests >= 3) {
				logger.warn(
					"Rate limit exceeded for verification code requests",
					{
						email: normalizedEmail,
						userId,
						requests: recentRequests,
					},
				);
				throw this.createHttpError(
					"Too many verification code requests. Please try again in an hour.",
					429,
				);
			}

			// Invalidate previous unused codes for this user
			await client.query(
				"UPDATE verification_codes SET is_used = TRUE WHERE user_id = $1 AND is_used = FALSE",
				[userId],
			);

			// Generate new verification code
			const code =
				this.generateVerificationCode();
			const expiresAt = new Date(
				Date.now() +
					config.VERIFICATION_CODE_EXPIRY_MINUTES *
						60 *
						1000,
			);

			// Store verification code
			await client.query(
				`INSERT INTO verification_codes (user_id, code, expires_at)
         VALUES ($1, $2, $3)`,
				[userId, code, expiresAt],
			);

			// Send verification email BEFORE committing the transaction
			// This ensures atomicity - if email fails, the entire transaction is rolled back
			try {
				await emailService.sendVerificationCode(
					normalizedEmail,
					code,
				);
				logger.info(
					"Verification code sent successfully",
					{
						email: normalizedEmail,
						userId,
					},
				);
			} catch (emailError) {
				const err = emailError as Error;
				logger.error(
					"Failed to send verification email",
					{
						email: normalizedEmail,
						userId,
						error: err.message,
						stack: err.stack,
					},
				);

				// Throw error to trigger rollback in the catch block
				throw new Error(
					"Failed to send verification email. Please try again.",
				);
			}

			// Only commit if email was sent successfully
			await client.query("COMMIT");

			logger.info("Verification code generated", {
				email: normalizedEmail,
				userId,
			});

			return {
				success: true,
				message:
					"Verification code sent to your email",
				expiresIn:
					config.VERIFICATION_CODE_EXPIRY_MINUTES *
					60, // in seconds
			};
		} catch (error) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// Transaction may already be closed in edge paths.
			}

			const err = error as Error;
			logger.error(
				"Error requesting verification code",
				{
					email,
					error: err.message,
					stack: err.stack,
				},
			);

			if ("statusCode" in err) {
				throw err;
			}

			throw this.createHttpError(
				"Failed to generate verification code",
				500,
			);
		} finally {
			client.release();
		}
	}

	/**
	 * Verify code and create session with tokens
	 */
	async verifyCode(
		email: string,
		code: string,
		ipAddress?: string,
		userAgent?: string,
	): Promise<
		VerifyCodeResponse & {
			accessToken?: string;
			refreshToken?: string;
		}
	> {
		const client: PoolClient =
			await pool.connect();

		try {
			await client.query("BEGIN");

			const normalizedEmail = email
				.toLowerCase()
				.trim();

			// Get user
			const userResult = await client.query<User>(
				"SELECT * FROM users WHERE email = $1",
				[normalizedEmail],
			);

			if (userResult.rows.length === 0) {
				await client.query("ROLLBACK");
				return {
					success: false,
					message:
						"Invalid email or verification code",
				};
			}

			const user = userResult.rows[0];
			const isFirstTimeSignup =
				!user.is_verified;

			// Get the latest verification code
			const codeResult =
				await client.query<VerificationCode>(
					`SELECT id, code, attempts, expires_at, is_used
         FROM verification_codes
         WHERE user_id = $1 AND is_used = FALSE
         ORDER BY created_at DESC
         LIMIT 1`,
					[user.id],
				);

			if (codeResult.rows.length === 0) {
				await client.query("ROLLBACK");
				return {
					success: false,
					message:
						"No valid verification code found. Please request a new one.",
				};
			}

			const verificationRecord =
				codeResult.rows[0];

			// Check if code has expired
			if (
				new Date() >
				new Date(verificationRecord.expires_at)
			) {
				await client.query(
					"UPDATE verification_codes SET is_used = TRUE WHERE id = $1",
					[verificationRecord.id],
				);
				await client.query("COMMIT");
				return {
					success: false,
					message:
						"Verification code has expired. Please request a new one.",
				};
			}

			// Check max attempts
			if (
				verificationRecord.attempts >=
				config.MAX_VERIFICATION_ATTEMPTS
			) {
				await client.query(
					"UPDATE verification_codes SET is_used = TRUE WHERE id = $1",
					[verificationRecord.id],
				);
				await client.query("COMMIT");
				return {
					success: false,
					message:
						"Maximum verification attempts exceeded. Please request a new code.",
				};
			}

			// Check if code matches using constant-time comparison to prevent timing attacks
			const storedCodeBuffer = Buffer.from(
				verificationRecord.code.padStart(6, "0"),
			);
			const providedCodeBuffer = Buffer.from(
				code.padStart(6, "0"),
			);

			let isCodeValid = false;
			try {
				isCodeValid = crypto.timingSafeEqual(
					storedCodeBuffer,
					providedCodeBuffer,
				);
			} catch (error) {
				// Buffers are different lengths, code is invalid
				isCodeValid = false;
			}

			if (!isCodeValid) {
				// Increment attempts
				await client.query(
					"UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1",
					[verificationRecord.id],
				);
				await client.query("COMMIT");

				const remainingAttempts =
					config.MAX_VERIFICATION_ATTEMPTS -
					(verificationRecord.attempts + 1);
				return {
					success: false,
					message: `Invalid verification code. ${remainingAttempts} attempt${remainingAttempts !== 1 ? "s" : ""} remaining.`,
					remainingAttempts,
				};
			}

			// Code is valid - mark as used
			await client.query(
				"UPDATE verification_codes SET is_used = TRUE WHERE id = $1",
				[verificationRecord.id],
			);

			// Update verification + login tracking. Profile editing remains optional in Settings.
			const updatedUserResult =
				await client.query<User>(
					`UPDATE users
					 SET is_verified = TRUE,
					     last_login = CURRENT_TIMESTAMP,
					     login_count = login_count + 1
					 WHERE id = $1
					 RETURNING *`,
					[user.id],
				);
			const updatedUser =
				updatedUserResult.rows[0] ?? user;

			// NOTE: We intentionally do NOT revoke other sessions on login.
			// Users may be logged in on multiple devices simultaneously.
			// They can revoke individual or all other sessions explicitly
			// via the /sessions and /logout-all endpoints.

			// Create new session first to get the actual session ID
			const sessionResult = await client.query<{
				id: number;
			}>(
				`INSERT INTO sessions (
          user_id,
          access_token,
          refresh_token,
          access_token_expires_at,
          refresh_token_expires_at,
          ip_address,
          user_agent
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id`,
				[
					user.id,
					"pending", // Temporary placeholder
					"pending", // Temporary placeholder
					new Date(
						Date.now() +
							config.ACCESS_TOKEN_EXPIRY_MINUTES *
								60 *
								1000,
					),
					new Date(
						Date.now() +
							config.REFRESH_TOKEN_EXPIRY_DAYS *
								24 *
								60 *
								60 *
								1000,
					),
					ipAddress || null,
					userAgent || null,
				],
			);

			const sessionId = sessionResult.rows[0].id;

			// Generate access and refresh tokens with actual session ID
			const {
				token: accessToken,
				expiresAt: accessTokenExpiresAt,
			} = tokenUtil.generateAccessToken({
				userId: user.id,
				email: user.email,
				sessionId,
			});

			const {
				token: refreshToken,
				expiresAt: refreshTokenExpiresAt,
			} = tokenUtil.generateRefreshToken({
				userId: user.id,
				email: user.email,
				sessionId,
			});

			// Hash both tokens for storage — access token stored as hash so
			// a DB compromise cannot be used to forge authenticated requests
			const hashedAccessToken =
				tokenUtil.hashToken(accessToken);
			const hashedRefreshToken =
				tokenUtil.hashToken(refreshToken);

			// Update session with actual tokens - MUST succeed before commit
			const updateResult = await client.query(
				`UPDATE sessions
         SET access_token = $1,
             refresh_token = $2,
             access_token_expires_at = $3,
             refresh_token_expires_at = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
				[
					hashedAccessToken,
					hashedRefreshToken,
					accessTokenExpiresAt,
					refreshTokenExpiresAt,
					sessionId,
				],
			);

			// Verify the update succeeded
			if (
				updateResult.rowCount === null ||
				updateResult.rowCount === 0
			) {
				throw new Error(
					"Failed to update session with tokens",
				);
			}

			await client.query("COMMIT");

			if (isFirstTimeSignup) {
				emailService
					.sendWelcomeEmail(normalizedEmail)
					.then(() => {
						logger.info(
							"Welcome email flow completed",
							{
								email: normalizedEmail,
								userId: user.id,
							},
						);
					})
					.catch((welcomeError) => {
						const err =
							welcomeError as Error;
						logger.warn(
							"Welcome email failed after signup",
							{
								email: normalizedEmail,
								userId: user.id,
								error: err.message,
							},
						);
					});
			}

			logger.info("User verified and logged in", {
				email: normalizedEmail,
				userId: user.id,
				sessionId,
			});

			return {
				success: true,
				message: "Login successful",
				accessToken,
				refreshToken,
				user: this.formatUserResponse(
					updatedUser,
					sessionId,
				),
			};
		} catch (error) {
			await client.query("ROLLBACK");
			const err = error as Error;
			logger.error("Error verifying code", {
				email,
				error: err.message,
				stack: err.stack,
			});
			throw new Error("Failed to verify code");
		} finally {
			client.release();
		}
	}

	/**
	 * Validate access token
	 */
	async validateAccessToken(
		accessToken: string,
	): Promise<ValidationResponse> {
		try {
			// Verify token signature and expiry
			const verification = tokenUtil.verifyToken(
				accessToken,
				"access",
			);

			if (
				!verification.valid ||
				!verification.payload
			) {
				return {
					valid: false,
					message:
						verification.error ||
						"Invalid access token",
				};
			}

			const { userId, sessionId } =
				verification.payload;

			// Hash the incoming token before comparing with the stored hash
			const hashedAccessToken = tokenUtil.hashToken(accessToken);

			// Check if session exists and is not revoked
			const systemMessageFields =
				await getUserSystemMessageSelectFields("u");
			const sessionResult = await pool.query(
				`SELECT s.id, s.is_revoked, u.id as user_id, u.email, u.is_verified, u.plan_type,
				        u.login_count, u.full_name, u.company_name, u.phone_number, u.country,
				        u.job_title, u.industry, u.company_website, u.profile_completed,
				        u.profile_completed_at,
				        u.onboarding_step, u.onboarding_completed,
				        u.dashboard_tour_completed, u.dashboard_tour_completed_at
				        ${systemMessageFields}
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = $1 AND s.user_id = $2 AND s.access_token = $3 AND s.is_revoked = FALSE`,
				[sessionId, userId, hashedAccessToken],
			);

			if (sessionResult.rows.length === 0) {
				return {
					valid: false,
					message:
						"Session not found or has been revoked",
				};
			}

			const session = sessionResult.rows[0];

			return {
				valid: true,
				user: {
					id: session.user_id,
					email: session.email,
					isVerified: session.is_verified,
					plan_type: session.plan_type,
					sessionId,
					loginCount: session.login_count,
					fullName: session.full_name,
					companyName: session.company_name,
					phoneNumber: session.phone_number,
					country: session.country,
					jobTitle: session.job_title,
					industry: session.industry,
					companyWebsite:
						session.company_website,
					profileCompleted:
						session.profile_completed,
					profileCompletedAt:
						session.profile_completed_at,
					onboardingStep:
						session.onboarding_step,
					onboardingCompleted:
						session.onboarding_completed,
					dashboardTourCompleted:
						session.dashboard_tour_completed,
					dashboardTourCompletedAt:
						session.dashboard_tour_completed_at,
					useDefaultSystemMessage:
						session.use_default_system_message,
					systemMessageConfigured:
						session.system_message_configured,
				},
			};
		} catch (error) {
			const err = error as Error;
			logger.error(
				"Error validating access token",
				{
					error: err.message,
					stack: err.stack,
				},
			);
			return {
				valid: false,
				message: "Token validation failed",
			};
		}
	}

	/**
	 * Refresh access token using refresh token
	 */
	async refreshAccessToken(
		refreshToken: string,
	): Promise<
		RefreshTokenResponse & {
			accessToken?: string;
			newRefreshToken?: string;
		}
	> {
		const client: PoolClient =
			await pool.connect();

		try {
			await client.query("BEGIN");

			// Verify refresh token
			const verification = tokenUtil.verifyToken(
				refreshToken,
				"refresh",
			);

			if (
				!verification.valid ||
				!verification.payload
			) {
				await client.query("ROLLBACK");
				return {
					success: false,
					message:
						verification.error ||
						"Invalid refresh token",
				};
			}

			const { userId, sessionId } =
				verification.payload;
			const hashedRefreshToken =
				tokenUtil.hashToken(refreshToken);
			const systemMessageFields =
				await getUserSystemMessageSelectFields("u");

			// Verify session and refresh token
			const sessionResult = await client.query<{
				id: number;
				user_id: string;
				email: string;
				is_verified: boolean;
				plan_type: PlanType;
				refresh_token_expires_at: Date;
				login_count: number;
				full_name: string | null;
				company_name: string | null;
				phone_number: string | null;
				country: string | null;
				job_title: string | null;
				industry: string | null;
				company_website: string | null;
				profile_completed: boolean;
				profile_completed_at: Date | null;
				onboarding_step: number;
				onboarding_completed: boolean;
				dashboard_tour_completed: boolean;
				dashboard_tour_completed_at: Date | null;
				use_default_system_message: boolean;
				system_message_configured: boolean;
			}>(
				`SELECT s.id, s.user_id, u.email, u.is_verified, u.plan_type, s.refresh_token_expires_at,
				        u.login_count, u.full_name, u.company_name, u.phone_number, u.country,
				        u.job_title, u.industry, u.company_website, u.profile_completed,
				        u.profile_completed_at,
				        u.onboarding_step, u.onboarding_completed,
				        u.dashboard_tour_completed, u.dashboard_tour_completed_at
				        ${systemMessageFields}
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = $1
           AND s.user_id = $2
           AND s.refresh_token = $3
           AND s.is_revoked = FALSE
           AND s.refresh_token_expires_at > CURRENT_TIMESTAMP`,
				[sessionId, userId, hashedRefreshToken],
			);

			if (sessionResult.rows.length === 0) {
				await client.query("ROLLBACK");
				return {
					success: false,
					message:
						"Invalid or expired refresh token",
				};
			}

			const session = sessionResult.rows[0];

			// Generate new access token
			const {
				token: newAccessToken,
				expiresAt: accessTokenExpiresAt,
			} = tokenUtil.generateAccessToken({
				userId: session.user_id,
				email: session.email,
				sessionId: session.id,
			});

			// Generate new refresh token (token rotation)
			const {
				token: newRefreshToken,
				expiresAt: refreshTokenExpiresAt,
			} = tokenUtil.generateRefreshToken({
				userId: session.user_id,
				email: session.email,
				sessionId: session.id,
			});

			const hashedNewAccessToken =
				tokenUtil.hashToken(newAccessToken);
			const hashedNewRefreshToken =
				tokenUtil.hashToken(newRefreshToken);

			// Update session with new hashed tokens
			await client.query(
				`UPDATE sessions
         SET access_token = $1,
             refresh_token = $2,
             access_token_expires_at = $3,
             refresh_token_expires_at = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
				[
					hashedNewAccessToken,
					hashedNewRefreshToken,
					accessTokenExpiresAt,
					refreshTokenExpiresAt,
					session.id,
				],
			);

			await client.query("COMMIT");

			logger.info("Access token refreshed", {
				userId: session.user_id,
				sessionId: session.id,
			});

			return {
				success: true,
				message: "Token refreshed successfully",
				accessToken: newAccessToken,
				newRefreshToken,
				user: {
					id: session.user_id,
					email: session.email,
					isVerified: session.is_verified,
					plan_type: session.plan_type,
					sessionId: session.id,
					loginCount: session.login_count,
					fullName: session.full_name,
					companyName: session.company_name,
					phoneNumber: session.phone_number,
					country: session.country,
					jobTitle: session.job_title,
					industry: session.industry,
					companyWebsite:
						session.company_website,
					profileCompleted:
						session.profile_completed,
					profileCompletedAt:
						session.profile_completed_at,
					onboardingStep:
						session.onboarding_step,
					onboardingCompleted:
						session.onboarding_completed,
					dashboardTourCompleted:
						session.dashboard_tour_completed,
					dashboardTourCompletedAt:
						session.dashboard_tour_completed_at,
					useDefaultSystemMessage:
						session.use_default_system_message,
					systemMessageConfigured:
						session.system_message_configured,
				},
			};
		} catch (error) {
			await client.query("ROLLBACK");
			const err = error as Error;
			logger.error("Error refreshing token", {
				error: err.message,
				stack: err.stack,
			});
			throw new Error("Failed to refresh token");
		} finally {
			client.release();
		}
	}

	/**
	 * Logout - revoke session
	 */
	async logout(
		accessToken: string,
	): Promise<LogoutResponse> {
		try {
			// Verify token to get session ID
			const verification = tokenUtil.verifyToken(
				accessToken,
				"access",
			);

			if (
				!verification.valid ||
				!verification.payload
			) {
				return {
					success: false,
					message: "Invalid access token",
				};
			}

			const { sessionId } = verification.payload;

			// Revoke session
			const result = await pool.query(
				"UPDATE sessions SET is_revoked = TRUE WHERE id = $1 AND is_revoked = FALSE",
				[sessionId],
			);

			if (
				result.rowCount === null ||
				result.rowCount === 0
			) {
				return {
					success: false,
					message:
						"Session not found or already logged out",
				};
			}

			logger.info("User logged out", {
				sessionId,
			});

			return {
				success: true,
				message: "Logged out successfully",
			};
		} catch (error) {
			const err = error as Error;
			logger.error("Error logging out", {
				error: err.message,
				stack: err.stack,
			});
			throw new Error("Failed to logout");
		}
	}

	async getProfileStatus(userId: string): Promise<UserResponse> {
		const result = await pool.query<User>(
			"SELECT * FROM users WHERE id = $1 LIMIT 1",
			[userId],
		);

		if (result.rows.length === 0) {
			throw this.createHttpError("User not found", 404);
		}

		return this.formatUserResponse(result.rows[0]);
	}

	async updatePassword(
		userId: string,
		payload: ChangePasswordBody,
		currentSessionId?: number,
	): Promise<{
		success: boolean;
		message: string;
		hasPassword: boolean;
	}> {
		const client: PoolClient = await pool.connect();

		try {
			await client.query("BEGIN");

			const userResult = await client.query<
				User & { password_hash: string | null }
			>(
				`SELECT *,
				        password_hash
				   FROM users
				  WHERE id = $1
				  LIMIT 1`,
				[userId],
			);

			const user = userResult.rows[0];
			if (!user) {
				throw this.createHttpError("User not found", 404);
			}

			const nextPassword = String(
				payload.newPassword || "",
			).trim();
			if (!isStrongUserPassword(nextPassword)) {
				throw this.createHttpError(
					USER_PASSWORD_POLICY_MESSAGE,
					400,
				);
			}

			const currentPassword = String(
				payload.currentPassword || "",
			);
			const existingPasswordHash =
				user.password_hash;

			if (existingPasswordHash) {
				if (!currentPassword.trim()) {
					throw this.createHttpError(
						"Current password is required.",
						400,
					);
				}

				const isCurrentPasswordValid =
					await this.verifyPassword(
						currentPassword,
						existingPasswordHash,
					);
				if (!isCurrentPasswordValid) {
					throw this.createHttpError(
						"Current password is incorrect.",
						400,
					);
				}

				const isSamePassword =
					await this.verifyPassword(
						nextPassword,
						existingPasswordHash,
					);
				if (isSamePassword) {
					throw this.createHttpError(
						"New password must be different from your current password.",
						400,
					);
				}
			}

			const nextPasswordHash =
				await this.hashPassword(nextPassword);

			await client.query(
				`UPDATE users
				    SET password_hash = $2,
				        updated_at = CURRENT_TIMESTAMP
				  WHERE id = $1`,
				[userId, nextPasswordHash],
			);

			if (typeof currentSessionId === "number") {
				await client.query(
					`UPDATE sessions
					    SET is_revoked = TRUE,
					        updated_at = CURRENT_TIMESTAMP
					  WHERE user_id = $1
					    AND is_revoked = FALSE
					    AND id <> $2`,
					[userId, currentSessionId],
				);
			} else {
				await client.query(
					`UPDATE sessions
					    SET is_revoked = TRUE,
					        updated_at = CURRENT_TIMESTAMP
					  WHERE user_id = $1
					    AND is_revoked = FALSE`,
					[userId],
				);
			}

			await client.query("COMMIT");

			const isFirstPassword =
				!existingPasswordHash;
			void emailService
				.sendPasswordChangedEmail(
					user.email,
					new Date(),
				)
				.catch((error) => {
					logger.warn(
						"Failed to send password changed notification after settings update",
						{
							userId,
							email: user.email,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
				});
			logger.info("User password updated from settings", {
				userId,
				isFirstPassword,
			});

			return {
				success: true,
				message: isFirstPassword
					? "Password set successfully."
					: "Password updated successfully.",
				hasPassword: true,
			};
		} catch (error) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// ignore rollback errors
			}

			const err = error as Error & {
				statusCode?: number;
			};
			logger.error("Error updating password from settings", {
				userId,
				error: err.message,
				stack: err.stack,
			});
			throw err.statusCode
				? err
				: this.createHttpError(
						"Failed to update password.",
						500,
				  );
		} finally {
			client.release();
		}
	}

	async deleteAccount(
		userId: string,
		payload: {
			confirmationText?: unknown;
			currentPassword?: unknown;
			ipAddress?: unknown;
			userAgent?: unknown;
		},
	): Promise<{
		success: boolean;
		message: string;
	}> {
		const confirmationText = String(
			payload.confirmationText || "",
		).trim();
		if (confirmationText !== "DELETE") {
			throw this.createHttpError(
				'Type "DELETE" to confirm account deletion.',
				400,
			);
		}

		const client: PoolClient = await pool.connect();
		let chatSessionIds: string[] = [];
		let widgetKey: string | null = null;
		let widgetKeyId: number | null = null;
		let widgetIconUrls: string[] = [];
		let deletionRequestId: string | null = null;
		let userEmail: string | null = null;

		try {
			await client.query("BEGIN");

			const userResult = await client.query<
				User & { password_hash: string | null }
			>(
				`SELECT *,
				        password_hash
				   FROM users
				  WHERE id = $1
				  LIMIT 1`,
				[userId],
			);
			const user = userResult.rows[0];
			if (!user) {
				throw this.createHttpError("User not found", 404);
			}
			userEmail = user.email;

			if (user.password_hash) {
				const currentPassword = String(
					payload.currentPassword || "",
				);
				if (!currentPassword.trim()) {
					throw this.createHttpError(
						"Current password is required.",
						400,
					);
				}
				const passwordMatches =
					await this.verifyPassword(
						currentPassword,
						user.password_hash,
					);
				if (!passwordMatches) {
					throw this.createHttpError(
						"Current password is incorrect.",
						400,
					);
				}
			}

			const currentSubscription =
				await subscriptionService.getCurrentSubscription(
					userId,
				);
			if (
				currentSubscription.subscription &&
				["active", "trialing"].includes(
					currentSubscription.subscription.status,
				)
			) {
				throw this.createHttpError(
					"Cancel your active subscription before deleting your account.",
					409,
				);
			}

			deletionRequestId =
				await this.createDeletionRequest(
					userId,
					user.email,
					{
						ipAddress:
							typeof payload.ipAddress ===
							"string"
								? payload.ipAddress
								: null,
						userAgent:
							typeof payload.userAgent ===
							"string"
								? payload.userAgent
								: null,
					},
				);
			await this.updateDeletionRequest(
				deletionRequestId,
				{ status: "in_progress" },
			);

			const sessionResult = await client.query<{
				id: string;
			}>(
				`SELECT id
				   FROM chat_conversations
				  WHERE user_id = $1`,
				[userId],
			);
			chatSessionIds = sessionResult.rows.map(
				(row) => row.id,
			);

			const widgetResult = await client.query<{
				id: number;
				widget_key: string;
			}>(
				`SELECT id, widget_key
				   FROM widget_keys
				  WHERE user_id = $1
				  LIMIT 1`,
				[userId],
			);
			if (widgetResult.rows[0]) {
				widgetKeyId = widgetResult.rows[0].id;
				widgetKey = widgetResult.rows[0].widget_key;
				const widgetConfigResult = await client.query<{
					widget_config: Record<string, unknown> | null;
				}>(
					`SELECT widget_config
					   FROM widget_keys
					  WHERE id = $1
					  LIMIT 1`,
					[widgetKeyId],
				);
				const widgetConfig =
					widgetConfigResult.rows[0]
						?.widget_config ?? null;
				widgetIconUrls = Array.from(
					new Set(
						[
							typeof widgetConfig?.logoIcon ===
							"string"
								? widgetConfig.logoIcon
								: null,
							typeof widgetConfig?.bubbleIcon ===
							"string"
								? widgetConfig.bubbleIcon
								: null,
						].filter(
							(
								value,
							): value is string =>
								Boolean(value),
						),
					),
				);
			}

			await this.disconnectExternalIntegrationsForUser(
				userId,
			);

			await client.query(
				`DELETE FROM session_page_views
				  WHERE user_id = $1`,
				[userId],
			);

			await pineconeService.deleteAllUserVectors(
				userId,
			);

			const deleteUserResult = await client.query(
				`DELETE FROM users
				  WHERE id = $1`,
				[userId],
			);

			if ((deleteUserResult.rowCount || 0) === 0) {
				throw this.createHttpError(
					"User not found",
					404,
				);
			}

			await client.query("COMMIT");
		} catch (error) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// ignore rollback errors
			}

			if (deletionRequestId) {
				await this.updateDeletionRequest(
					deletionRequestId,
					{
						status: "failed",
						failureReason:
							error instanceof Error
								? error.message
								: String(error),
					},
				).catch(() => {
					// Ignore request-status update failures.
				});
			}

			throw error;
		} finally {
			client.release();
		}

		try {
			await this.clearUserRedisState(
				userId,
				chatSessionIds,
			);
			await this.removePendingScrapeJobsForUser(
				userId,
			);
			if (widgetKey) {
				await redisCache.del(
					`widget_key:${widgetKey}`,
				);
			}
			if (widgetKeyId !== null) {
				await this.removeBufferedWidgetAnalytics(
					widgetKeyId,
				);
			}
			for (const widgetIconUrl of widgetIconUrls) {
				try {
					await widgetIconStorageService.deleteWidgetIconByUrl(
						widgetIconUrl,
					);
				} catch (error) {
					logger.warn(
						"Widget icon cleanup failed during account deletion",
						{
							userId,
							widgetIconUrl,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
				}
			}
		} catch (error) {
			logger.warn(
				"Account deleted but some cache cleanup failed",
				{
					userId,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
		}

		if (deletionRequestId) {
			await this.updateDeletionRequest(
				deletionRequestId,
				{
					status: "completed",
					completedAt: true,
				},
			).catch(() => {
				logger.warn(
					"Failed to mark account deletion request completed",
					{
						userId,
						email: userEmail,
						deletionRequestId,
					},
				);
			});
		}

		logger.info("User account deleted", {
			userId,
		});

		return {
			success: true,
			message:
				"Your account has been deleted successfully.",
		};
	}

	async updateUserProfile(
		userId: string,
		payload: {
			full_name?: unknown;
			company_name?: unknown;
			phone_number?: unknown;
			country?: unknown;
			industry?: unknown;
			company_website?: unknown;
		},
	): Promise<UserResponse> {
		const userResult = await pool.query<User>(
			"SELECT * FROM users WHERE id = $1 LIMIT 1",
			[userId],
		);
		if (userResult.rows.length === 0) {
			throw this.createHttpError("User not found", 404);
		}

		const currentUser = userResult.rows[0];
		const nextUser: User = { ...currentUser };
		const updates: string[] = [];
		const values: unknown[] = [userId];
		let parameterIndex = 2;

		const fullName = this.normalizeOptionalText(
			payload.full_name,
		);
		if (fullName) {
			nextUser.full_name = fullName;
			updates.push(`full_name = $${parameterIndex}`);
			values.push(fullName);
			parameterIndex += 1;
		}

		const companyName = this.normalizeOptionalText(
			payload.company_name,
		);
		if (companyName) {
			nextUser.company_name = companyName;
			updates.push(`company_name = $${parameterIndex}`);
			values.push(companyName);
			parameterIndex += 1;
		}

		const phoneNumber = this.normalizeOptionalText(
			payload.phone_number,
		);
		if (phoneNumber) {
			const normalizedPhone = phoneNumber.replace(
				/\s+/g,
				" ",
			);
			if (!/^[+0-9() -]{7,20}$/.test(normalizedPhone)) {
				throw this.createHttpError(
					"Invalid phone number format",
					400,
				);
			}
			nextUser.phone_number = normalizedPhone;
			updates.push(`phone_number = $${parameterIndex}`);
			values.push(normalizedPhone);
			parameterIndex += 1;
		}

		const country = this.normalizeOptionalText(
			payload.country,
		);
		if (country) {
			nextUser.country = country;
			updates.push(`country = $${parameterIndex}`);
			values.push(country);
			parameterIndex += 1;
		}

		const industry = this.normalizeOptionalText(
			payload.industry,
		);
		if (industry) {
			nextUser.industry = industry;
			updates.push(`industry = $${parameterIndex}`);
			values.push(industry);
			parameterIndex += 1;
		}

		const companyWebsite = this.normalizeOptionalText(
			payload.company_website,
		);
		if (companyWebsite) {
			let normalizedWebsite =
				companyWebsite.toLowerCase();
			if (
				!normalizedWebsite.startsWith("http://") &&
				!normalizedWebsite.startsWith("https://")
			) {
				normalizedWebsite = `https://${normalizedWebsite}`;
			}

			try {
				new URL(normalizedWebsite);
			} catch {
				throw this.createHttpError(
					"Invalid company website URL",
					400,
				);
			}

			nextUser.company_website = normalizedWebsite;
			updates.push(
				`company_website = $${parameterIndex}`,
			);
			values.push(normalizedWebsite);
			parameterIndex += 1;
		}

		if (updates.length === 0) {
			return this.formatUserResponse(currentUser);
		}

		const profileCompleted = Boolean(
			nextUser.full_name &&
				nextUser.company_name &&
				nextUser.phone_number &&
				nextUser.country &&
				nextUser.industry &&
				nextUser.company_website,
		);
		updates.push(`profile_completed = $${parameterIndex}`);
		values.push(profileCompleted);
		parameterIndex += 1;

		if (profileCompleted && !currentUser.profile_completed_at) {
			updates.push(
				"profile_completed_at = CURRENT_TIMESTAMP",
			);
		}

		const result = await pool.query<User>(
			`UPDATE users
        SET ${updates.join(", ")},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *`,
			values,
		);

		return this.formatUserResponse(result.rows[0]);
	}

	/**
	 * Record the completion of an onboarding step for a user.
	 * Step 4 automatically marks onboarding as fully completed.
	 */
	async updateOnboardingStep(
		userId: string,
		step: number,
	): Promise<UserResponse> {
		const completed = step >= 4;
		const result = await pool.query<User>(
			`UPDATE users
       SET onboarding_step         = GREATEST(onboarding_step, $2),
           onboarding_completed    = CASE WHEN $3 THEN TRUE ELSE onboarding_completed END,
           onboarding_completed_at = CASE
             WHEN $3 AND onboarding_completed = FALSE
             THEN CURRENT_TIMESTAMP
             ELSE onboarding_completed_at
           END,
           updated_at              = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
			[userId, step, completed],
		);

		if (result.rows.length === 0) {
			throw this.createHttpError("User not found", 404);
		}

		return this.formatUserResponse(result.rows[0]);
	}

	async completeDashboardTour(
		userId: string,
	): Promise<UserResponse> {
		const result = await pool.query<User>(
			`UPDATE users
			    SET dashboard_tour_completed = TRUE,
			        dashboard_tour_completed_at = COALESCE(dashboard_tour_completed_at, CURRENT_TIMESTAMP),
			        updated_at = CURRENT_TIMESTAMP
			  WHERE id = $1
			  RETURNING *`,
			[userId],
		);

		if (result.rows.length === 0) {
			throw this.createHttpError("User not found", 404);
		}

		return this.formatUserResponse(result.rows[0]);
	}

	// ── Password helpers ──────────────────────────────────────────────────────

	private readonly PW_ALGORITHM = "pbkdf2_sha512";
	private readonly PW_ITERATIONS = 210_000;
	private readonly PW_KEY_LENGTH = 64;
	private readonly PASSWORD_RESET_EXPIRY_MINUTES = 30;
	private readonly PASSWORD_RESET_REQUEST_COOLDOWN_MINUTES = 2;

	private async hashPassword(password: string): Promise<string> {
		const salt = crypto.randomBytes(16).toString("hex");
		const hash = await new Promise<string>((resolve, reject) => {
			crypto.pbkdf2(
				password,
				salt,
				this.PW_ITERATIONS,
				this.PW_KEY_LENGTH,
				"sha512",
				(err, key) => {
					if (err) reject(err);
					else resolve(key.toString("hex"));
				},
			);
		});
		return `${this.PW_ALGORITHM}$${this.PW_ITERATIONS}$${salt}$${hash}`;
	}

	private async verifyPassword(
		password: string,
		storedHash: string,
	): Promise<boolean> {
		const parts = storedHash.split("$");
		if (parts.length !== 4) return false;
		const [, iterationsStr, salt, expectedHash] = parts;
		const iterations = parseInt(iterationsStr, 10);
		return new Promise((resolve, reject) => {
			crypto.pbkdf2(
				password,
				salt,
				iterations,
				this.PW_KEY_LENGTH,
				"sha512",
				(err, key) => {
					if (err) return reject(err);
					try {
						const keyBuf = Buffer.from(key.toString("hex"));
						const expectedBuf = Buffer.from(expectedHash);
						resolve(
							keyBuf.length === expectedBuf.length &&
								crypto.timingSafeEqual(keyBuf, expectedBuf),
						);
					} catch {
						resolve(false);
					}
				},
			);
		});
	}

	/** Shared helper: create session + tokens for an already-authenticated user */
	private async createSessionForUser(
		client: PoolClient,
		user: User,
		ipAddress?: string,
		userAgent?: string,
	): Promise<{
		accessToken: string;
		refreshToken: string;
		sessionId: number;
		expiresIn: number;
	}> {
		const sessionResult = await client.query<{ id: number }>(
			`INSERT INTO sessions (
        user_id, access_token, refresh_token,
        access_token_expires_at, refresh_token_expires_at,
        ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id`,
			[
				user.id,
				"pending",
				"pending",
				new Date(Date.now() + config.ACCESS_TOKEN_EXPIRY_MINUTES * 60 * 1000),
				new Date(
					Date.now() +
						config.REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
				),
				ipAddress || null,
				userAgent || null,
			],
		);

		const sessionId = sessionResult.rows[0].id;

		const { token: accessToken, expiresAt: accessTokenExpiresAt } =
			tokenUtil.generateAccessToken({
				userId: user.id,
				email: user.email,
				sessionId,
			});
		const { token: refreshToken, expiresAt: refreshTokenExpiresAt } =
			tokenUtil.generateRefreshToken({
				userId: user.id,
				email: user.email,
				sessionId,
			});

		const updateResult = await client.query(
			`UPDATE sessions
       SET access_token = $1, refresh_token = $2,
           access_token_expires_at = $3, refresh_token_expires_at = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
			[
				tokenUtil.hashToken(accessToken),
				tokenUtil.hashToken(refreshToken),
				accessTokenExpiresAt,
				refreshTokenExpiresAt,
				sessionId,
			],
		);

		if (!updateResult.rowCount) {
			throw new Error("Failed to update session with tokens");
		}

		return {
			accessToken,
			refreshToken,
			sessionId,
			expiresIn: config.ACCESS_TOKEN_EXPIRY_MINUTES * 60,
		};
	}

	// ── Password-based register ───────────────────────────────────────────────

	async requestPasswordReset(
		email: string,
	): Promise<{ success: boolean; message: string }> {
		const normalizedEmail = email.toLowerCase().trim();
		const client: PoolClient = await pool.connect();
		const genericResponse = {
			success: true,
			message:
				"If that email is registered, a password reset link has been sent.",
		};

		try {
			await client.query("BEGIN");

			const userResult = await client.query<
				User & {
					password_reset_requested_at: Date | null;
				}
			>(
				`SELECT *,
				        password_reset_requested_at
				 FROM users
				 WHERE email = $1
				 LIMIT 1`,
				[normalizedEmail],
			);

			const user = userResult.rows[0];
			if (!user) {
				await client.query("COMMIT");
				return genericResponse;
			}

			const requestedAt = user.password_reset_requested_at
				? new Date(user.password_reset_requested_at)
				: null;
			if (
				requestedAt &&
				requestedAt.getTime() >
					Date.now() -
						this.PASSWORD_RESET_REQUEST_COOLDOWN_MINUTES *
							60 *
							1000
			) {
				await client.query("COMMIT");
				return genericResponse;
			}

			const resetToken = tokenUtil.generateSecureToken();
			const hashedResetToken =
				tokenUtil.hashToken(resetToken);
			const expiresAt = new Date(
				Date.now() +
					this.PASSWORD_RESET_EXPIRY_MINUTES *
						60 *
						1000,
			);
			const resetUrl = `${config.FRONTEND_URL.replace(/\/+$/, "")}/reset-password?token=${resetToken}`;

			await client.query(
				`UPDATE users
				 SET password_reset_token_hash = $2,
				     password_reset_token_expires_at = $3,
				     password_reset_requested_at = CURRENT_TIMESTAMP,
				     updated_at = CURRENT_TIMESTAMP
				 WHERE id = $1`,
				[user.id, hashedResetToken, expiresAt],
			);

			await emailService.sendPasswordResetEmail(
				normalizedEmail,
				resetUrl,
				this.PASSWORD_RESET_EXPIRY_MINUTES,
			);

			await client.query("COMMIT");

			logger.info("Password reset link requested", {
				email: normalizedEmail,
				userId: user.id,
			});

			return genericResponse;
		} catch (error) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// ignore
			}
			const err = error as Error;
			logger.error("Error requesting password reset", {
				email: normalizedEmail,
				error: err.message,
				stack: err.stack,
			});
			if ("statusCode" in err) {
				throw err;
			}
			throw this.createHttpError(
				"Failed to start password reset.",
				500,
			);
		} finally {
			client.release();
		}
	}

	async resetPassword(
		token: string,
		newPassword: string,
	): Promise<{ success: boolean; message: string }> {
		const client: PoolClient = await pool.connect();

		try {
			await client.query("BEGIN");

			const hashedToken = tokenUtil.hashToken(token);
			const userResult = await client.query<
				User & {
					password_hash: string | null;
					password_reset_token_hash: string | null;
					password_reset_token_expires_at: Date | null;
				}
			>(
				`SELECT *,
				        password_hash,
				        password_reset_token_hash,
				        password_reset_token_expires_at
				 FROM users
				 WHERE password_reset_token_hash = $1
				 LIMIT 1`,
				[hashedToken],
			);

			const user = userResult.rows[0];
			if (!user) {
				throw this.createHttpError(
					"This reset link is invalid or has expired.",
					400,
				);
			}

			const expiresAt =
				user.password_reset_token_expires_at
					? new Date(
							user.password_reset_token_expires_at,
					  )
					: null;
			if (!expiresAt || expiresAt.getTime() < Date.now()) {
				await client.query(
					`UPDATE users
					 SET password_reset_token_hash = NULL,
					     password_reset_token_expires_at = NULL,
					     updated_at = CURRENT_TIMESTAMP
					 WHERE id = $1`,
					[user.id],
				);
				throw this.createHttpError(
					"This reset link is invalid or has expired.",
					400,
				);
			}

			const nextPasswordHash =
				await this.hashPassword(newPassword);

			await client.query(
				`UPDATE users
				 SET password_hash = $2,
				     password_reset_token_hash = NULL,
				     password_reset_token_expires_at = NULL,
				     password_reset_requested_at = NULL,
				     is_verified = TRUE,
				     updated_at = CURRENT_TIMESTAMP
				 WHERE id = $1`,
				[user.id, nextPasswordHash],
			);

			await client.query(
				`UPDATE sessions
				 SET is_revoked = TRUE,
				     updated_at = CURRENT_TIMESTAMP
				 WHERE user_id = $1
				   AND is_revoked = FALSE`,
				[user.id],
			);

			await client.query("COMMIT");

			void emailService
				.sendPasswordChangedEmail(
					user.email,
					new Date(),
				)
				.catch((error) => {
					logger.warn(
						"Failed to send password changed notification after password reset",
						{
							userId: user.id,
							email: user.email,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
				});

			logger.info("Password reset completed", {
				userId: user.id,
				email: user.email,
			});

			return {
				success: true,
				message:
					"Your password has been reset successfully. Please log in with your new password.",
			};
		} catch (error) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// ignore
			}
			const err = error as Error;
			logger.error("Error resetting password", {
				error: err.message,
				stack: err.stack,
			});
			if ("statusCode" in err) {
				throw err;
			}
			throw this.createHttpError(
				"Failed to reset password.",
				500,
			);
		} finally {
			client.release();
		}
	}
	async registerWithPassword(
		email: string,
		password: string,
		_ipAddress?: string,
		_userAgent?: string,
	): Promise<
		VerifyCodeResponse & {
			accessToken?: string;
			refreshToken?: string;
			expiresIn?: number;
		}
	> {
		const normalizedEmail = email.toLowerCase().trim();
		const client: PoolClient = await pool.connect();

		try {
			await client.query("BEGIN");

			// Check if email already registered
			const existing = await client.query<
				User & {
					password_hash: string | null;
				}
			>(
				"SELECT id, email, is_verified, password_hash FROM users WHERE email = $1",
				[normalizedEmail],
			);

			if (existing.rows.length > 0) {
				const existingUser = existing.rows[0];

				if (existingUser.is_verified) {
					await client.query("ROLLBACK");
					return {
						success: false,
						message: "An account with this email already exists. Please log in.",
					};
				}

				const passwordHash =
					await this.hashPassword(password);

				await client.query(
					`UPDATE users
         SET password_hash = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
					[existingUser.id, passwordHash],
				);

				await client.query("COMMIT");

				logger.info(
					"Resuming signup for existing unverified user",
					{
						email: normalizedEmail,
						userId: existingUser.id,
					},
				);

				await this.requestVerificationCode(
					normalizedEmail,
				);

				return {
					success: true,
					message:
						"Your account is pending verification. We've sent a new verification code to your email.",
				};
			}

			const passwordHash = await this.hashPassword(password);
			const userId = uuidUtil.generateUuid();

			await client.query(
				`INSERT INTO users (id, email, is_verified, password_hash)
         VALUES ($1, $2, FALSE, $3)`,
				[userId, normalizedEmail, passwordHash],
			);

			await client.query("COMMIT");

			logger.info("User registered with password (pending OTP verification)", {
				email: normalizedEmail,
				userId,
			});

			// Send OTP for email verification
			await this.requestVerificationCode(normalizedEmail);

			return {
				success: true,
				message: "Verification code sent to your email",
			};
		} catch (error) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// Transaction may already be closed in early-return branches.
			}
			const err = error as Error;
			logger.error("Error in registerWithPassword", {
				email,
				error: err.message,
				stack: err.stack,
			});
			throw new Error("Failed to create account");
		} finally {
			client.release();
		}
	}

	// ── Password-based login ──────────────────────────────────────────────────

	async loginWithPassword(
		email: string,
		password: string,
		ipAddress?: string,
		userAgent?: string,
	): Promise<
		VerifyCodeResponse & {
			accessToken?: string;
			refreshToken?: string;
			expiresIn?: number;
		}
	> {
		const normalizedEmail = email.toLowerCase().trim();
		const client: PoolClient = await pool.connect();

		try {
			await client.query("BEGIN");

			const userResult = await client.query<User & { password_hash: string }>(
				"SELECT * FROM users WHERE email = $1",
				[normalizedEmail],
			);

			if (userResult.rows.length === 0) {
				await client.query("ROLLBACK");
				return {
					success: false,
					message: "Invalid email or password.",
				};
			}

			const user = userResult.rows[0];
			const storedHash: string | null = (user as any).password_hash;

			if (!storedHash) {
				await client.query("ROLLBACK");
				return {
					success: false,
					message:
						"This account uses a different sign-in method. Please use Google or email OTP.",
				};
			}

			const isValid = await this.verifyPassword(password, storedHash);
			if (!isValid) {
				await client.query("ROLLBACK");
				return {
					success: false,
					message: "Invalid email or password.",
				};
			}

			if (!user.is_verified) {
				await client.query("ROLLBACK");

				await this.requestVerificationCode(
					normalizedEmail,
				);

				return {
					success: false,
					message:
						"Your account is not verified yet. We've sent a new verification code to your email. Please complete verification first.",
				};
			}

			// Update last_login + login_count. Profile editing remains optional in Settings.
			const updatedUserResult = await client.query<User>(
				`UPDATE users
         SET last_login = CURRENT_TIMESTAMP,
             login_count = login_count + 1
         WHERE id = $1
         RETURNING *`,
				[user.id],
			);
			const updatedUser = updatedUserResult.rows[0] ?? user;

			const { accessToken, refreshToken, sessionId, expiresIn } =
				await this.createSessionForUser(client, user, ipAddress, userAgent);

			await client.query("COMMIT");

			logger.info("User logged in with password", {
				email: normalizedEmail,
				userId: user.id,
				sessionId,
			});

			return {
				success: true,
				message: "Login successful",
				accessToken,
				refreshToken,
				expiresIn,
				user: this.formatUserResponse(updatedUser, sessionId),
			};
		} catch (error) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// Transaction may already be closed in early-return branches.
			}
			const err = error as Error;
			logger.error("Error in loginWithPassword", {
				email,
				error: err.message,
				stack: err.stack,
			});
			throw new Error("Failed to log in");
		} finally {
			client.release();
		}
	}

	/**
	 * Clean up expired sessions and verification codes
	 */
	async cleanupExpired(): Promise<CleanupResult> {
		try {
			// Revoke expired sessions
			const sessionsResult = await pool.query(
				`UPDATE sessions
         SET is_revoked = TRUE
         WHERE (refresh_token_expires_at < CURRENT_TIMESTAMP OR refresh_token_expires_at IS NULL)
           AND is_revoked = FALSE`,
			);

			// Delete old revoked sessions (older than 30 days)
			await pool.query(
				`DELETE FROM sessions
         WHERE is_revoked = TRUE
           AND updated_at < CURRENT_TIMESTAMP - INTERVAL '30 days'`,
			);

			// Delete old verification codes (expired/used AND older than 7 days for audit trail)
			const codesResult = await pool.query(
				`DELETE FROM verification_codes
         WHERE (expires_at < CURRENT_TIMESTAMP OR is_used = TRUE)
           AND created_at < CURRENT_TIMESTAMP - INTERVAL '7 days'`,
			);

			logger.info("Cleanup completed", {
				sessionsRevoked: sessionsResult.rowCount,
				codesDeleted: codesResult.rowCount,
			});

			return {
				sessionsDeleted:
					sessionsResult.rowCount || 0,
				codesDeleted: codesResult.rowCount || 0,
			};
		} catch (error) {
			const err = error as Error;
			logger.error("Error during cleanup", {
				error: err.message,
				stack: err.stack,
			});
			throw new Error(
				"Failed to cleanup expired records",
			);
		}
	}
}

export default new AuthService();

