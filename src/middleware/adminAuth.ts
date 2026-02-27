import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { config } from "../config/env";
import logger from "../utils/logger";

interface AdminTokenPayload {
	role: "admin";
	email: string;
	exp: number;
	iat: number;
}

function verifyAdminToken(token: string): AdminTokenPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;

		const [encodedHeader, encodedPayload, signature] = parts;

		const expectedSignature = crypto
			.createHmac("sha256", config.ADMIN_JWT_SECRET)
			.update(`${encodedHeader}.${encodedPayload}`)
			.digest("base64url");

		const sigBuf = Buffer.from(signature);
		const expBuf = Buffer.from(expectedSignature);
		let match = false;
		try {
			match = crypto.timingSafeEqual(sigBuf, expBuf);
		} catch {
			match = false;
		}
		if (!match) return null;

		const payload = JSON.parse(
			Buffer.from(encodedPayload, "base64url").toString("utf-8"),
		) as AdminTokenPayload;

		if (payload.role !== "admin") return null;
		if (Math.floor(Date.now() / 1000) > payload.exp) return null;

		return payload;
	} catch {
		return null;
	}
}

export function signAdminToken(email: string): string {
	const now = Math.floor(Date.now() / 1000);
	const exp = now + config.ADMIN_TOKEN_EXPIRY_HOURS * 3600;

	const header = Buffer.from(
		JSON.stringify({ alg: "HS256", typ: "JWT" }),
	).toString("base64url");

	const payload = Buffer.from(
		JSON.stringify({ role: "admin", email, iat: now, exp }),
	).toString("base64url");

	const signature = crypto
		.createHmac("sha256", config.ADMIN_JWT_SECRET)
		.update(`${header}.${payload}`)
		.digest("base64url");

	return `${header}.${payload}.${signature}`;
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
	const authHeader = req.headers.authorization;
	const token = authHeader?.startsWith("Bearer ")
		? authHeader.slice(7)
		: undefined;

	if (!token) {
		res.status(401).json({ message: "Admin authentication required" });
		return;
	}

	const payload = verifyAdminToken(token);
	if (!payload) {
		logger.warn("Invalid admin token attempt", { ip: req.ip });
		res.status(401).json({ message: "Invalid or expired admin token" });
		return;
	}

	next();
}
