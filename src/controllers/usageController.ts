import { Request, Response } from "express";
import usageTrackingService from "../services/usageTrackingService";
import logger from "../utils/logger";

/**
 * Get current user's usage statistics
 * @route GET /api/auth/usage
 */
export const getUserUsage = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = (req as any).user?.id;

		if (!userId) {
			res.status(401).json({
				success: false,
				message:
					"Unauthorized - User ID not found",
			});
			return;
		}

		const usage =
			await usageTrackingService.getUserUsage(
				userId,
			);

		res.status(200).json({
			success: true,
			data: {
				planType: usage.planType,
				conversationsUsed:
					usage.conversationsUsed,
				conversationsLimit:
					usage.conversationsLimit,
				conversationsRemaining:
					usage.conversationsRemaining,
				resetDate: usage.resetDate,
				isApproachingLimit:
					usage.isApproachingLimit,
				isAtLimit: usage.isAtLimit,
			},
		});
	} catch (error) {
		const err = error as Error;
		logger.error("Error getting user usage", {
			error: err.message,
			stack: err.stack,
		});

		res.status(500).json({
			success: false,
			message: "Failed to get usage statistics",
			error: err.message,
		});
	}
};

/**
 * Get authenticated user's usage statistics via POST
 * @route POST /api/auth/usage/check
 */
export const checkUsage = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = (req as any).user?.id;

		if (!userId) {
			res.status(401).json({
				success: false,
				message:
					"Unauthorized - User ID not found",
			});
			return;
		}

		const usage =
			await usageTrackingService.getUserUsage(
				userId,
			);

		res.status(200).json({
			success: true,
			data: {
				planType: usage.planType,
				conversationsUsed:
					usage.conversationsUsed,
				conversationsLimit:
					usage.conversationsLimit,
				conversationsRemaining:
					usage.conversationsRemaining,
				resetDate: usage.resetDate,
				isApproachingLimit:
					usage.isApproachingLimit,
				isAtLimit: usage.isAtLimit,
			},
		});
	} catch (error) {
		const err = error as Error;
		logger.error("Error checking usage", {
			error: err.message,
			stack: err.stack,
		});

		res.status(500).json({
			success: false,
			message: "Failed to check usage",
			error: err.message,
		});
	}
};
