import { Request, Response } from "express";
import { OVERVIEW_ANALYTICS_LIMIT } from "../constants";
import { getPlanCapabilities } from "../config/planConfig";
import { chatRatingService } from "../services/chatRatingService";
import { pineconeService } from "../services/pineconeService";
import { chatService } from "../services/chatService";
import usageTrackingService from "../services/usageTrackingService";
import widgetService from "../services/widgetService";
import logger from "../utils/logger";

interface WidgetEvent {
	event_type?: string;
	ip_address?: string | null;
	created_at?: string | Date;
}

function toDateKey(value: string | Date): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return date.toISOString().slice(0, 10);
}

function getLastNDaysKeys(days: number): string[] {
	const keys: string[] = [];
	const now = new Date();
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date(now);
		d.setDate(now.getDate() - i);
		keys.push(d.toISOString().slice(0, 10));
	}
	return keys;
}

export const getOverviewAnalytics = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = req.user?.id;

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const [usage, sessions, widgetEvents, ratings] =
			await Promise.all([
				usageTrackingService.getUserUsage(userId),
				chatService.getUserChatSessions(userId),
				widgetService.getWidgetAnalytics(
					userId,
					OVERVIEW_ANALYTICS_LIMIT,
				),
				chatRatingService.getRatingsForUser(
					userId,
					OVERVIEW_ANALYTICS_LIMIT,
				),
			]);

		const events = (widgetEvents || []) as WidgetEvent[];
		const widgetLoadedEvents = events.filter(
			(event) =>
				event.event_type === "widget_loaded",
		);
		const embedLoadedEvents = events.filter(
			(event) =>
				event.event_type === "embed_script_loaded",
		);
		const viewEvents =
			widgetLoadedEvents.length > 0
				? widgetLoadedEvents
				: embedLoadedEvents;
		const totalViews = viewEvents.length;
		const totalMessages = events.filter(
			(event) => event.event_type === "message_sent",
		).length;
		const uniqueVisitors = new Set(
			viewEvents
				.map((event) => event.ip_address || "")
				.filter(Boolean),
		).size;

		let sources;
		try {
			sources = await pineconeService.getAllUserSourcesFromDB(
				userId,
			);
		} catch (error) {
			logger.warn(
				"Failed to fetch sources for overview analytics; using empty defaults",
				{
					userId,
					error,
				},
			);
			sources = {
				documents: [],
				websites: [],
				totalChunks: 0,
			};
		}

		const totalWebsites = sources.websites.length;
		const totalPages = sources.websites.reduce(
			(sum, website) =>
				sum + website.pages.length,
			0,
		);
		const totalDocuments = sources.documents.length;
		const totalChunks = sources.totalChunks;
		const totalSessions = sessions.length;
		const avgMessagesPerSession =
			totalSessions > 0
				? Number(
						(
							sessions.reduce(
								(sum, session) =>
									sum + session.messageCount,
								0,
							) / totalSessions
						).toFixed(1),
				  )
				: 0;
		const avgSessionDurationMinutes =
			totalSessions > 0
				? Number(
						(
							sessions.reduce((sum, session) => {
								const created = new Date(
									session.createdAt,
								).getTime();
								const updated = new Date(
									session.updatedAt,
								).getTime();
								if (
									Number.isNaN(created) ||
									Number.isNaN(updated) ||
									updated < created
								) {
									return sum;
								}
								return (
									sum +
									(updated - created) /
										(1000 * 60)
								);
							}, 0) / totalSessions
						).toFixed(1),
				  )
				: 0;
		const bounceSessions = sessions.filter(
			(session) => session.messageCount <= 2,
		).length;
		const bounceRate =
			totalSessions > 0
				? Number(
						(
							(bounceSessions / totalSessions) *
							100
						).toFixed(1),
				  )
				: 0;
		const thumbsUp = ratings.filter(
			(rating) => rating.rating === "up",
		).length;
		const thumbsDown = ratings.filter(
			(rating) => rating.rating === "down",
		).length;
		const totalRatings = thumbsUp + thumbsDown;
		const positiveRate =
			totalRatings > 0
				? Number(
						(
							(thumbsUp / totalRatings) *
							100
						).toFixed(1),
				  )
				: 0;

		const last7DaysKeys = getLastNDaysKeys(7);
		const dailyEventCounts = new Map<string, number>();
		for (const key of last7DaysKeys) {
			dailyEventCounts.set(key, 0);
		}
		for (const event of events) {
			if (!event.created_at) continue;
			const key = toDateKey(event.created_at);
			if (!key || !dailyEventCounts.has(key))
				continue;
			dailyEventCounts.set(
				key,
				(dailyEventCounts.get(key) || 0) + 1,
			);
		}

		const activityLast7Days = last7DaysKeys.map(
			(date) => ({
				date,
				totalEvents:
					dailyEventCounts.get(date) || 0,
			}),
		);
		const activeDaysLast7 =
			activityLast7Days.filter(
				(point) => point.totalEvents > 0,
			).length;

		const messagesPerView =
			totalViews > 0
				? Number(
						(totalMessages / totalViews).toFixed(1),
				  )
				: 0;
		const engagementRate =
			totalViews > 0
				? Number(
						(
							(totalSessions / totalViews) *
							100
						).toFixed(1),
				  )
				: 0;

		res.status(200).json({
			success: true,
			data: {
				widget: {
					totalViews,
					totalMessages,
					uniqueVisitors,
					engagementRate,
					messagesPerView,
				},
				conversations: {
					totalSessions,
					avgMessagesPerSession,
					conversationsUsed:
						usage.conversationsUsed,
					conversationsLimit:
						usage.conversationsLimit,
					conversationsRemaining:
						usage.conversationsRemaining,
					isApproachingLimit:
						usage.isApproachingLimit,
					isAtLimit: usage.isAtLimit,
					planType: usage.planType,
					capabilities:
						getPlanCapabilities(
							usage.planType,
						),
					resetDate: usage.resetDate,
				},
				knowledgeBase: {
					totalWebsites,
					totalPages,
					totalDocuments,
					totalChunks,
				},
				sessionInsights: {
					avgSessionDurationMinutes,
					bounceSessions,
					bounceRate,
					activeDaysLast7,
				},
				ratings: {
					totalRatings,
					thumbsUp,
					thumbsDown,
					positiveRate,
				},
				activityLast7Days,
			},
		});
	} catch (error) {
		logger.error(
			"Error getting overview analytics",
			{
				error,
			},
		);
		res.status(500).json({
			success: false,
			message:
				"Internal server error while getting overview analytics",
		});
	}
};
