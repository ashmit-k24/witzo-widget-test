import { NextFunction, Request, Response } from "express";
import logger from "../utils/logger";
import { verifyAdminToken } from "../utils/adminToken";

declare global {
	namespace Express {
		interface Request {
			admin?: {
				email: string;
				role: "admin";
			};
		}
	}
}

export const authenticateAdmin = (
	req: Request,
	res: Response,
	next: NextFunction,
): void => {
	try {
		const authHeader =
			req.get("authorization") || "";
		const [scheme, token] = authHeader.split(" ");

		if (
			scheme?.toLowerCase() !== "bearer" ||
			!token
		) {
			res.status(401).json({
				success: false,
				message: "Admin authentication required",
			});
			return;
		}

		const verification = verifyAdminToken(token);
		if (!verification.valid || !verification.payload) {
			res.status(401).json({
				success: false,
				message:
					verification.error || "Invalid admin token",
			});
			return;
		}

		req.admin = {
			email: verification.payload.email,
			role: verification.payload.role,
		};
		next();
	} catch (error) {
		logger.error("Admin auth middleware error", {
			error:
				error instanceof Error
					? error.message
					: String(error),
		});
		res.status(500).json({
			success: false,
			message: "Admin authentication failed",
		});
	}
};
