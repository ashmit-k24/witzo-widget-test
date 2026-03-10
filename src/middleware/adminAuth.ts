import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { config } from "../config/env";
import adminAuthService, {
	AdminPermissionKey,
	AdminRole,
	AdminUser,
} from "../services/adminAuthService";
import logger from "../utils/logger";

type LegacyAdminRole = "admin";

interface AdminTokenPayload {
	adminId?: string;
	role: AdminRole | LegacyAdminRole;
	email: string;
	exp: number;
	iat: number;
}

declare global {
	namespace Express {
		interface Request {
			admin?: AdminUser;
		}
	}
}

const ANY_ADMIN_ROLES: AdminRole[] = [
	"super_admin",
	"ops_admin",
	"support_admin",
];

function verifyAdminToken(
	token: string,
): AdminTokenPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;

		const [encodedHeader, encodedPayload, signature] =
			parts;

		const expectedSignature = crypto
			.createHmac(
				"sha256",
				config.ADMIN_JWT_SECRET,
			)
			.update(
				`${encodedHeader}.${encodedPayload}`,
			)
			.digest("base64url");

		const sigBuf = Buffer.from(signature);
		const expBuf = Buffer.from(expectedSignature);
		let match = false;
		try {
			match = crypto.timingSafeEqual(
				sigBuf,
				expBuf,
			);
		} catch {
			match = false;
		}
		if (!match) return null;

		const payload = JSON.parse(
			Buffer.from(
				encodedPayload,
				"base64url",
			).toString("utf-8"),
		) as AdminTokenPayload;

		const allowedRoles = new Set<
			AdminRole | LegacyAdminRole
		>([
			...ANY_ADMIN_ROLES,
			"admin",
		]);

		if (!allowedRoles.has(payload.role)) {
			return null;
		}

		if (
			typeof payload.email !== "string" ||
			!payload.email
		) {
			return null;
		}

		if (
			Math.floor(Date.now() / 1000) >
			payload.exp
		) {
			return null;
		}

		return payload;
	} catch {
		return null;
	}
}

export function signAdminToken(
	admin: Pick<AdminUser, "id" | "email" | "role">,
): string {
	const now = Math.floor(Date.now() / 1000);
	const exp =
		now + config.ADMIN_TOKEN_EXPIRY_HOURS * 3600;

	const header = Buffer.from(
		JSON.stringify({
			alg: "HS256",
			typ: "JWT",
		}),
	).toString("base64url");

	const payload = Buffer.from(
		JSON.stringify({
			adminId: admin.id,
			role: admin.role,
			email: admin.email,
			iat: now,
			exp,
		}),
	).toString("base64url");

	const signature = crypto
		.createHmac(
			"sha256",
			config.ADMIN_JWT_SECRET,
		)
		.update(`${header}.${payload}`)
		.digest("base64url");

	return `${header}.${payload}.${signature}`;
}

export const adminAuth = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	const authHeader = req.headers.authorization;
	const token = authHeader?.startsWith("Bearer ")
		? authHeader.slice(7)
		: undefined;

	if (!token) {
		res.status(401).json({
			message: "Admin authentication required",
		});
		return;
	}

	const payload = verifyAdminToken(token);
	if (!payload) {
		logger.warn(
			"Invalid admin token attempt",
			{ ip: req.ip },
		);
		res.status(401).json({
			message: "Invalid or expired admin token",
		});
		return;
	}

	const admin =
		await adminAuthService.resolveAuthenticatedAdmin(
			{
				adminId: payload.adminId,
				email: payload.email,
			},
		);

	if (!admin) {
		logger.warn(
			"Rejected admin token with unknown or inactive admin identity",
			{
				ip: req.ip,
				email: payload.email,
				adminId: payload.adminId,
			},
		);
		res.status(401).json({
			message: "Invalid or expired admin token",
		});
		return;
	}

	req.admin = admin;
	next();
};

export const requireAdminRole =
	(...roles: AdminRole[]) =>
	(
		req: Request,
		res: Response,
		next: NextFunction,
	): void => {
		const admin = req.admin;
		if (!admin) {
			res.status(401).json({
				message:
					"Admin authentication required",
			});
			return;
		}

		if (!roles.includes(admin.role)) {
			res.status(403).json({
				message:
					"Insufficient admin permissions",
			});
			return;
		}

		next();
	};

export const requireAdminPermission =
	(...permissions: AdminPermissionKey[]) =>
	(
		req: Request,
		res: Response,
		next: NextFunction,
	): void => {
		const admin = req.admin;
		if (!admin) {
			res.status(401).json({
				message: "Admin authentication required",
			});
			return;
		}

		if (
			permissions.some((permission) =>
				adminAuthService.hasAdminPermission(
					admin,
					permission,
				),
			)
		) {
			next();
			return;
		}

		res.status(403).json({
			message: "Insufficient admin permissions",
		});
	};
