import crypto from "crypto";
import { config } from "../config/env";

type AdminTokenPayload = {
	email: string;
	role: "admin";
	iat: number;
	exp: number;
};

const encode = (value: unknown): string =>
	Buffer.from(JSON.stringify(value)).toString(
		"base64url",
	);

const decode = <T>(value: string): T =>
	JSON.parse(
		Buffer.from(value, "base64url").toString(
			"utf8",
		),
	) as T;

const sign = (value: string): string =>
	crypto
		.createHmac("sha256", config.ADMIN_JWT_SECRET)
		.update(value)
		.digest("base64url");

export const createAdminToken = (
	email: string,
): string => {
	const now = Math.floor(Date.now() / 1000);
	const exp =
		now + config.ADMIN_TOKEN_EXPIRY_HOURS * 60 * 60;
	const header = { alg: "HS256", typ: "JWT" };
	const payload: AdminTokenPayload = {
		email,
		role: "admin",
		iat: now,
		exp,
	};

	const encodedHeader = encode(header);
	const encodedPayload = encode(payload);
	const signature = sign(
		`${encodedHeader}.${encodedPayload}`,
	);

	return `${encodedHeader}.${encodedPayload}.${signature}`;
};

export const verifyAdminToken = (
	token: string,
): {
	valid: boolean;
	payload?: AdminTokenPayload;
	error?: string;
} => {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) {
			return {
				valid: false,
				error: "Invalid token format",
			};
		}

		const [encodedHeader, encodedPayload, signature] =
			parts;
		const expected = sign(
			`${encodedHeader}.${encodedPayload}`,
		);

		const signatureBuffer = Buffer.from(signature);
		const expectedBuffer = Buffer.from(expected);

		if (
			signatureBuffer.length !==
			expectedBuffer.length
		) {
			return {
				valid: false,
				error: "Invalid token signature",
			};
		}

		const validSignature = crypto.timingSafeEqual(
			signatureBuffer,
			expectedBuffer,
		);

		if (!validSignature) {
			return {
				valid: false,
				error: "Invalid token signature",
			};
		}

		const header = decode<{ alg: string; typ: string }>(
			encodedHeader,
		);
		if (header.alg !== "HS256" || header.typ !== "JWT") {
			return {
				valid: false,
				error: "Invalid token algorithm",
			};
		}

		const payload = decode<AdminTokenPayload>(
			encodedPayload,
		);
		const now = Math.floor(Date.now() / 1000);
		if (payload.exp < now) {
			return {
				valid: false,
				error: "Token expired",
			};
		}

		if (payload.role !== "admin") {
			return {
				valid: false,
				error: "Invalid token role",
			};
		}

		return {
			valid: true,
			payload,
		};
	} catch (error) {
		return {
			valid: false,
			error: "Token verification failed",
		};
	}
};
