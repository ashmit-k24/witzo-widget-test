import crypto from "crypto";
import { config } from "../config/env";
import { TokenPayload } from "../types";

/**
 * Token utility for generating and verifying JWT-like tokens
 * Using HMAC-SHA256 for signing instead of full JWT library to reduce dependencies
 */
class TokenUtil {
	private readonly accessTokenSecret: string;
	private readonly refreshTokenSecret: string;
	private readonly accessTokenExpiry: number; // in minutes
	private readonly refreshTokenExpiry: number; // in days

	constructor() {
		this.accessTokenSecret = config.JWT_SECRET;
		this.refreshTokenSecret =
			config.JWT_REFRESH_SECRET;
		this.accessTokenExpiry =
			config.ACCESS_TOKEN_EXPIRY_MINUTES;
		this.refreshTokenExpiry =
			config.REFRESH_TOKEN_EXPIRY_DAYS;
	}

	/**
	 * Generate a secure random token
	 */
	generateSecureToken(): string {
		return crypto.randomBytes(32).toString("hex");
	}

	/**
	 * Create HMAC signature for token payload
	 */
	private createSignature(
		payload: string,
		secret: string,
	): string {
		return crypto
			.createHmac("sha256", secret)
			.update(payload)
			.digest("base64url");
	}

	/**
	 * Generate access token
	 */
	generateAccessToken(
		payload: Omit<TokenPayload, "type">,
	): {
		token: string;
		expiresAt: Date;
	} {
		const expiresAt = new Date(
			Date.now() +
				this.accessTokenExpiry * 60 * 1000,
		);

		const tokenData: TokenPayload = {
			...payload,
			type: "access",
		};

		const header = {
			alg: "HS256",
			typ: "JWT",
		};

		const encodedHeader = Buffer.from(
			JSON.stringify(header),
		).toString("base64url");
		const encodedPayload = Buffer.from(
			JSON.stringify({
				...tokenData,
				exp: Math.floor(
					expiresAt.getTime() / 1000,
				),
				iat: Math.floor(Date.now() / 1000),
			}),
		).toString("base64url");

		const signature = this.createSignature(
			`${encodedHeader}.${encodedPayload}`,
			this.accessTokenSecret,
		);

		const token = `${encodedHeader}.${encodedPayload}.${signature}`;

		return { token, expiresAt };
	}

	/**
	 * Generate refresh token
	 */
	generateRefreshToken(
		payload: Omit<TokenPayload, "type">,
	): {
		token: string;
		expiresAt: Date;
	} {
		const expiresAt = new Date(
			Date.now() +
				this.refreshTokenExpiry *
					24 *
					60 *
					60 *
					1000,
		);

		const tokenData: TokenPayload = {
			...payload,
			type: "refresh",
		};

		const header = {
			alg: "HS256",
			typ: "JWT",
		};

		const encodedHeader = Buffer.from(
			JSON.stringify(header),
		).toString("base64url");
		const encodedPayload = Buffer.from(
			JSON.stringify({
				...tokenData,
				exp: Math.floor(
					expiresAt.getTime() / 1000,
				),
				iat: Math.floor(Date.now() / 1000),
			}),
		).toString("base64url");

		const signature = this.createSignature(
			`${encodedHeader}.${encodedPayload}`,
			this.refreshTokenSecret,
		);

		const token = `${encodedHeader}.${encodedPayload}.${signature}`;

		return { token, expiresAt };
	}

	/**
	 * Verify and decode token
	 */
	verifyToken(
		token: string,
		type: "access" | "refresh",
	): {
		valid: boolean;
		payload?: TokenPayload;
		error?: string;
	} {
		try {
			const parts = token.split(".");

			if (parts.length !== 3) {
				return {
					valid: false,
					error: "Invalid token format",
				};
			}

			const [
				encodedHeader,
				encodedPayload,
				signature,
			] = parts;
			const secret =
				type === "access"
					? this.accessTokenSecret
					: this.refreshTokenSecret;

			// Validate header and algorithm
			try {
				const headerString = Buffer.from(
					encodedHeader,
					"base64url",
				).toString("utf-8");
				const header = JSON.parse(headerString);

				if (
					header.alg !== "HS256" ||
					header.typ !== "JWT"
				) {
					return {
						valid: false,
						error: "Invalid token algorithm",
					};
				}
			} catch (error) {
				return {
					valid: false,
					error: "Invalid token header",
				};
			}

			// Verify signature using constant-time comparison
			const expectedSignature =
				this.createSignature(
					`${encodedHeader}.${encodedPayload}`,
					secret,
				);

			// Use constant-time comparison to prevent timing attacks
			const signatureBuffer =
				Buffer.from(signature);
			const expectedBuffer = Buffer.from(
				expectedSignature,
			);

			let signaturesMatch = false;
			try {
				signaturesMatch = crypto.timingSafeEqual(
					signatureBuffer,
					expectedBuffer,
				);
			} catch (error) {
				// Buffers are different lengths, signatures don't match
				signaturesMatch = false;
			}

			if (!signaturesMatch) {
				return {
					valid: false,
					error: "Invalid token signature",
				};
			}

			// Decode payload
			const payloadString = Buffer.from(
				encodedPayload,
				"base64url",
			).toString("utf-8");
			const payload = JSON.parse(
				payloadString,
			) as TokenPayload & {
				exp: number;
				iat: number;
			};

			// Check expiration
			const now = Math.floor(Date.now() / 1000);
			if (payload.exp < now) {
				return {
					valid: false,
					error: "Token expired",
				};
			}

			// Verify token type
			if (payload.type !== type) {
				return {
					valid: false,
					error: "Invalid token type",
				};
			}

			return { valid: true, payload };
		} catch (error) {
			return {
				valid: false,
				error: "Token verification failed",
			};
		}
	}

	/**
	 * Hash refresh token for secure storage
	 */
	hashToken(token: string): string {
		return crypto
			.createHash("sha256")
			.update(token)
			.digest("hex");
	}

	/**
	 * Get token expiry times
	 */
	getTokenExpiry() {
		return {
			accessTokenMinutes: this.accessTokenExpiry,
			refreshTokenDays: this.refreshTokenExpiry,
		};
	}
}

export default new TokenUtil();
