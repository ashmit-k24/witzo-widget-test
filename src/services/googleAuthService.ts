import { PoolClient } from "pg";
import pool from "../config/database";
import { PROFILE_COMPLETION_PROMPT_LOGIN_THRESHOLD } from "../constants";
import { config } from "../config/env";
import { User, UserResponse } from "../types";
import logger from "../utils/logger";
import tokenUtil from "../utils/token";
import uuidUtil from "../utils/uuid";

export interface GoogleProfile {
	id: string;
	email: string;
	verified_email: boolean;
	name: string;
	given_name: string;
	family_name: string;
	picture: string;
}

export interface GoogleAuthResponse {
	success: boolean;
	message: string;
	accessToken?: string;
	refreshToken?: string;
	user?: UserResponse;
}

class GoogleAuthService {
	/**
	 * Convert database user to API response format
	 */
	private formatUserResponse(
		user: User,
		sessionId?: number,
	): UserResponse {
		const requiresProfileCompletion =
			!user.profile_completed &&
			user.login_count >
				PROFILE_COMPLETION_PROMPT_LOGIN_THRESHOLD;

		return {
			id: user.id,
			email: user.email,
			isVerified: user.is_verified,
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
			requiresProfileCompletion,
			profilePromptRequiredAt:
				user.profile_prompt_required_at,
			profileCompletedAt:
				user.profile_completed_at,
			onboardingStep: user.onboarding_step,
			onboardingCompleted: user.onboarding_completed,
			useDefaultSystemMessage:
				user.use_default_system_message ?? true,
			systemMessageConfigured:
				user.system_message_configured ??
				user.onboarding_completed,
		};
	}

	/**
	 * Authenticate user with Google profile
	 */
	async authenticateWithGoogle(
		profile: GoogleProfile,
		ipAddress?: string,
		userAgent?: string,
	): Promise<GoogleAuthResponse> {
		const client: PoolClient =
			await pool.connect();

		try {
			await client.query("BEGIN");

			const normalizedEmail = profile.email
				.toLowerCase()
				.trim();

			// Check if user exists
			let userResult = await client.query<User>(
				"SELECT * FROM users WHERE email = $1",
				[normalizedEmail],
			);

			let userId: string;
			let isNewUser = false;

			if (userResult.rows.length === 0) {
				// Create new user with Google account
				const newUserId = uuidUtil.generateUuid();
				const insertResult =
					await client.query<User>(
						"INSERT INTO users (id, email, is_verified) VALUES ($1, $2, $3) RETURNING *",
						[
							newUserId,
							normalizedEmail,
							profile.verified_email,
						],
					);
				userId = insertResult.rows[0].id;
				userResult = insertResult;
				isNewUser = true;
				logger.info(
					"New user created via Google OAuth",
					{
						email: normalizedEmail,
						userId,
					},
				);
			} else {
				// User exists
				userId = userResult.rows[0].id;

				// Update user as verified if Google email is verified
				if (
					profile.verified_email &&
					!userResult.rows[0].is_verified
				) {
					await client.query(
						"UPDATE users SET is_verified = TRUE WHERE id = $1",
						[userId],
					);
				}

				logger.info(
					"Existing user logged in via Google OAuth",
					{
						email: normalizedEmail,
						userId,
					},
				);
			}

			// Update last login and increment login counter
			const updatedUserResult =
				await client.query<User>(
					`UPDATE users
					 SET last_login = CURRENT_TIMESTAMP,
					     login_count = login_count + 1,
					     profile_prompt_required_at = CASE
					       WHEN (login_count + 1) > $2 AND profile_completed = FALSE
					         THEN COALESCE(profile_prompt_required_at, CURRENT_TIMESTAMP)
					       ELSE profile_prompt_required_at
					     END
					 WHERE id = $1
					 RETURNING *`,
					[
						userId,
						PROFILE_COMPLETION_PROMPT_LOGIN_THRESHOLD,
					],
				);
			const updatedUser =
				updatedUserResult.rows[0] ??
				userResult.rows[0];

			// Create new session
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
					userId,
					"pending",
					"pending",
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

			// Generate tokens
			const {
				token: accessToken,
				expiresAt: accessTokenExpiresAt,
			} = tokenUtil.generateAccessToken({
				userId,
				email: normalizedEmail,
				sessionId,
			});

			const {
				token: refreshToken,
				expiresAt: refreshTokenExpiresAt,
			} = tokenUtil.generateRefreshToken({
				userId,
				email: normalizedEmail,
				sessionId,
			});

			// Hash both tokens for storage
			const hashedAccessToken =
				tokenUtil.hashToken(accessToken);
			const hashedRefreshToken =
				tokenUtil.hashToken(refreshToken);

			// Update session with actual tokens
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

			if (
				updateResult.rowCount === null ||
				updateResult.rowCount === 0
			) {
				throw new Error(
					"Failed to update session with tokens",
				);
			}

			await client.query("COMMIT");

			const user = updatedUser;
			user.is_verified =
				profile.verified_email ||
				user.is_verified;

			logger.info(
				"Google OAuth authentication successful",
				{
					email: normalizedEmail,
					userId,
					sessionId,
					isNewUser,
				},
			);

			return {
				success: true,
				message: isNewUser
					? "Account created and logged in successfully"
					: "Login successful",
				accessToken,
				refreshToken,
				user: this.formatUserResponse(
					user,
					sessionId,
				),
			};
		} catch (error) {
			await client.query("ROLLBACK");
			const err = error as Error;
			logger.error(
				"Error authenticating with Google",
				{
					email: profile.email,
					error: err.message,
					stack: err.stack,
				},
			);
			throw new Error(
				"Failed to authenticate with Google",
			);
		} finally {
			client.release();
		}
	}
}

export default new GoogleAuthService();
