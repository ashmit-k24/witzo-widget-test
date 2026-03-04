import {
	NextFunction,
	Request,
	Response,
} from "express";
import { coercePlanType } from "../config/planConfig";
import { pineconeService } from "../services/pineconeService";
import usageTrackingService from "../services/usageTrackingService";
import logger from "../utils/logger";

const getScraperUpgradeMessage = (
	planType: "free" | "basic" | "enterprise",
): string => {
	if (planType === "free") {
		return "Upgrade to Basic plan for 30 website pages";
	}
	if (planType === "basic") {
		return "Upgrade to Enterprise plan for up to 300 website pages";
	}
	return "You have reached the maximum limit for Enterprise plan (300 pages)";
};

/**
 * Middleware to atomically check the conversation limit AND increment the
 * usage counter in a single DB UPDATE.  This eliminates the TOCTOU race
 * that existed when canUserChat() (SELECT) and trackConversation() (UPDATE)
 * were two separate round-trips: concurrent requests for the same user
 * could both pass the check and both increment, letting a user exceed their
 * plan limit.
 *
 * On success the post-increment usage stats are stored in res.locals.usage
 * so the chat controller and addUsageToResponse can read them without an
 * additional DB query.
 */
export const checkConversationLimit = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = (req as any).user?.id;

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Unauthorized - User ID not found",
			});
			return;
		}

		const { allowed, usage } =
			await usageTrackingService.checkAndTrackConversation(userId);

		if (!allowed) {
			// Fetch current stats (read-only, no increment) for the error body
			const currentUsage =
				await usageTrackingService.getUserUsage(userId);

			res.status(403).json({
				success: false,
				message:
					"You've reached your conversation limit for this month",
				data: {
					planType: currentUsage.planType,
					conversationsUsed: currentUsage.conversationsUsed,
					conversationsLimit: currentUsage.conversationsLimit,
					resetDate: currentUsage.resetDate,
				},
			});
			return;
		}

		// Make usage stats available to downstream middleware and controllers
		// without requiring another DB round-trip.
		(res.locals as any).usage = {
			conversationsRemaining: usage!.conversationsRemaining,
			isApproachingLimit: usage!.isApproachingLimit,
			resetDate: usage!.resetDate,
		};

		next();
	} catch (error) {
		const err = error as Error;
		logger.error(
			"Error in checkConversationLimit middleware",
			{
				error: err.message,
				stack: err.stack,
			},
		);

		res.status(500).json({
			success: false,
			message:
				"Internal server error while checking conversation limit",
		});
	}
};

/**
 * No-op pass-through kept for backward-compatibility with the route
 * definition.  Tracking is now done atomically inside checkConversationLimit,
 * so there is nothing left to do here.
 */
export const trackConversation = (
	_req: Request,
	_res: Response,
	next: NextFunction,
): void => {
	next();
};

/**
 * Middleware to add usage stats to the response locals.
 * If checkConversationLimit already ran and populated res.locals.usage,
 * this is a no-op (saves an extra DB query).  Otherwise it fetches from
 * the service (which is Redis-cached for 60 s).
 */
export const addUsageToResponse = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	// Already populated by checkConversationLimit — nothing to do.
	if ((res.locals as any).usage) {
		next();
		return;
	}

	const userId = (req as any).user?.id;

	if (!userId) {
		next();
		return;
	}

	try {
		const usage =
			await usageTrackingService.getUserUsage(userId);

		(res.locals as any).usage = {
			conversationsRemaining: usage.conversationsRemaining,
			isApproachingLimit: usage.isApproachingLimit,
			resetDate: usage.resetDate,
		};
	} catch (error) {
		const err = error as Error;
		logger.error("Error adding usage to response", {
			userId,
			error: err.message,
		});
		// Continue without usage info — don't block the response
	}

	next();
};

/**
 * Middleware to check if user has reached scraper page limit
 * Blocks request if user has exceeded their plan's page limit
 * Free users: 15 pages, Basic users: 30 pages
 */
export const checkScraperLimit = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = (req as any).user?.id;
		const planType = coercePlanType(
			(req as any).user?.plan_type,
		);

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Unauthorized - User ID not found",
			});
			return;
		}

		// Check if user can scrape more pages
		const canScrape = await pineconeService.canUserScrape(
			userId,
			planType,
		);

		if (!canScrape) {
			// Get usage stats to provide helpful info
			const usage =
				await pineconeService.getScraperUsageStats(
					userId,
					planType,
				);

			logger.warn("User has reached scraper page limit", {
				userId,
				planType,
				pagesUsed: usage.pagesUsed,
				pagesLimit: usage.pagesLimit,
			});

			res.status(403).json({
				success: false,
			message: `You've reached your website scraping limit. ${planType} plan allows ${usage.pagesLimit ?? "unlimited"} websites.`,
				data: {
					planType: usage.planType,
					pagesUsed: usage.pagesUsed,
					pagesLimit: usage.pagesLimit,
					pagesRemaining: usage.pagesRemaining,
					upgradeMessage:
						getScraperUpgradeMessage(
							planType,
						),
				},
			});
			return;
		}

		// User can scrape, proceed
		next();
	} catch (error) {
		const err = error as Error;
		logger.error("Error in checkScraperLimit middleware", {
			error: err.message,
			stack: err.stack,
		});

		res.status(500).json({
			success: false,
			message:
				"Internal server error while checking scraper limit",
		});
	}
};
