import {
	NextFunction,
	Request,
	Response,
} from "express";
import {
	coercePlanType,
} from "../config/planConfig";
import { pineconeService } from "../services/pineconeService";
import usageTrackingService from "../services/usageTrackingService";
import logger from "../utils/logger";

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
 * Middleware to check if user has reached the global scraper page limit.
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

		// Fetch usage stats once and cache on res.locals so the controller
		// can reuse them without making a second Pinecone round-trip.
		const usage =
			await pineconeService.getScraperUsageStats(
				userId,
				planType,
			);

		if (usage.isAtLimit) {
			logger.warn("User has reached scraper page limit", {
				userId,
				planType,
				pagesUsed: usage.pagesUsed,
				pagesLimit: usage.pagesLimit,
			});

			res.status(403).json({
				success: false,
				message: `You've reached your website scraping limit. You can scrape up to ${usage.pagesLimit} pages in total.`,
				data: {
					planType: usage.planType,
					pagesUsed: usage.pagesUsed,
					pagesLimit: usage.pagesLimit,
					pagesRemaining: usage.pagesRemaining,
				},
			});
			return;
		}

		// Pass usage stats to controller so it doesn't need another Pinecone call
		(res.locals as any).scraperUsage = usage;

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
