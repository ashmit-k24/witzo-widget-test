import {
	NextFunction,
	Request,
	Response,
} from "express";
import { pineconeService } from "../services/pineconeService";
import usageTrackingService from "../services/usageTrackingService";
import logger from "../utils/logger";

/**
 * Middleware to check if user has reached conversation limit
 * Blocks request if user has exceeded their plan's conversation limit
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
				message:
					"Unauthorized - User ID not found",
			});
			return;
		}

		// Check if user can chat
		const canChat =
			await usageTrackingService.canUserChat(
				userId,
			);

		if (!canChat) {
			// Get usage stats to provide helpful info
			const usage =
				await usageTrackingService.getUserUsage(
					userId,
				);

			res.status(403).json({
				success: false,
				message:
					"You've reached your conversation limit for this month",
				data: {
					planType: usage.planType,
					conversationsUsed:
						usage.conversationsUsed,
					conversationsLimit:
						usage.conversationsLimit,
					resetDate: usage.resetDate,
					upgradeUrl: "/api/auth/upgrade",
				},
			});
			return;
		}

		// User can chat, proceed
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
 * Middleware to track conversation after successful response
 * This runs after the chat response is sent
 */
export const trackConversation = (
	req: Request,
	res: Response,
	next: NextFunction,
): void => {
	const userId = (req as any).user?.id;

	if (!userId) {
		next();
		return;
	}

	// Track after response is sent
	res.on("finish", async () => {
		// Only track if response was successful
		if (res.statusCode === 200) {
			try {
				await usageTrackingService.trackConversation(
					userId,
				);

				// Check if user is approaching limit and log a warning
				const isApproaching =
					await usageTrackingService.isApproachingLimit(
						userId,
					);
				if (isApproaching) {
					const remaining =
						await usageTrackingService.getRemainingConversations(
							userId,
						);
					logger.warn(
						"User approaching conversation limit",
						{
							userId,
							conversationsRemaining: remaining,
						},
					);
				}
			} catch (error) {
				const err = error as Error;
				logger.error(
					"Error tracking conversation",
					{
						userId,
						error: err.message,
					},
				);
				// Don't throw error here - conversation was already processed
			}
		}
	});

	next();
};

/**
 * Middleware to add usage stats to response
 * Adds current usage info to successful chat responses
 */
export const addUsageToResponse = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	const userId = (req as any).user?.id;

	if (!userId) {
		next();
		return;
	}

	try {
		const usage =
			await usageTrackingService.getUserUsage(
				userId,
			);

		// Store usage in res.locals to be accessed by controller
		res.locals.usage = {
			conversationsRemaining:
				usage.conversationsRemaining,
			isApproachingLimit:
				usage.isApproachingLimit,
			resetDate: usage.resetDate,
		};
	} catch (error) {
		const err = error as Error;
		logger.error(
			"Error adding usage to response",
			{
				userId,
				error: err.message,
			},
		);
		// Continue without usage info
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
		const planType =
			(req as any).user?.plan_type || "free";

		if (!userId) {
			res.status(401).json({
				success: false,
				message:
					"Unauthorized - User ID not found",
			});
			return;
		}

		// Check if user can scrape more pages
		const canScrape =
			await pineconeService.canUserScrape(
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

			logger.warn(
				"User has reached scraper page limit",
				{
					userId,
					planType,
					pagesUsed: usage.pagesUsed,
					pagesLimit: usage.pagesLimit,
				},
			);

			res.status(403).json({
				success: false,
				message: `You've reached your website scraping limit. ${planType === "free" ? "Free" : "Basic"} plan allows ${usage.pagesLimit} websites.`,
				data: {
					planType: usage.planType,
					pagesUsed: usage.pagesUsed,
					pagesLimit: usage.pagesLimit,
					pagesRemaining: usage.pagesRemaining,
					upgradeUrl:
						planType === "free"
							? "/api/auth/upgrade"
							: undefined,
					upgradeMessage:
						planType === "free"
							? "Upgrade to Basic plan for 30 website pages"
							: "You have reached the maximum limit for Basic plan",
				},
			});
			return;
		}

		// User can scrape, proceed
		next();
	} catch (error) {
		const err = error as Error;
		logger.error(
			"Error in checkScraperLimit middleware",
			{
				error: err.message,
				stack: err.stack,
			},
		);

		res.status(500).json({
			success: false,
			message:
				"Internal server error while checking scraper limit",
		});
	}
};
