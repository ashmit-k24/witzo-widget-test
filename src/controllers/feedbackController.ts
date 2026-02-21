import { Request, Response } from "express";
import {
	feedbackService,
	FeedbackType,
} from "../services/feedbackService";
import logger from "../utils/logger";

const FEEDBACK_TYPES: FeedbackType[] = [
	"feedback",
	"suggestion",
];

export const createFeedback = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = (req as any).user?.id as
			| string
			| undefined;
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const type = req.body.type as FeedbackType;
		const title = req.body.title as
			| string
			| undefined;
		const message = req.body.message as string;
		const pagePath = req.body.pagePath as
			| string
			| undefined;

		if (!FEEDBACK_TYPES.includes(type)) {
			res.status(400).json({
				success: false,
				message:
					"type must be either feedback or suggestion",
			});
			return;
		}

		const created =
			await feedbackService.createFeedback({
				userId,
				type,
				title,
				message,
				pagePath,
				userAgent: req.get("user-agent") || undefined,
			});

		res.status(201).json({
			success: true,
			data: {
				id: created.id,
				type: created.type,
				title: created.title,
				message: created.message,
				created_at: created.created_at,
			},
		});
	} catch (error) {
		logger.error("Error creating feedback", {
			error,
		});
		res.status(500).json({
			success: false,
			message: "Failed to submit feedback",
		});
	}
};

export const listFeedback = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = (req as any).user?.id as
			| string
			| undefined;
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const rawLimit = req.query.limit as
			| string
			| undefined;
		const parsedLimit = rawLimit
			? Number.parseInt(rawLimit, 10)
			: 50;
		const limit = Number.isFinite(parsedLimit)
			? parsedLimit
			: 50;

		const entries =
			await feedbackService.listFeedbackByUser(
				userId,
				limit,
			);

		res.status(200).json({
			success: true,
			data: entries.map((entry) => ({
				id: entry.id,
				type: entry.type,
				title: entry.title,
				message: entry.message,
				created_at: entry.created_at,
			})),
		});
	} catch (error) {
		logger.error("Error listing feedback", {
			error,
		});
		res.status(500).json({
			success: false,
			message: "Failed to fetch feedback",
		});
	}
};
