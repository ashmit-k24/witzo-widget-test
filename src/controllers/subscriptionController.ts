import { Request, Response } from "express";
import {
	CreateSubscriptionInput,
	subscriptionService,
	VerifyPaymentInput,
} from "../services/subscriptionService";
import logger from "../utils/logger";

const getUserId = (req: Request): string | null =>
	req.user?.id ?? null;

const getHeaderValue = (
	header: string | string[] | undefined,
): string => {
	if (Array.isArray(header)) {
		return header[0] ?? "";
	}
	return header ?? "";
};

export const getPlans = async (
	_req: Request,
	res: Response,
): Promise<void> => {
	try {
		const plans =
			await subscriptionService.listPlans(false);
		res.status(200).json({
			success: true,
			data: plans,
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to fetch plans";
		logger.error("Failed to fetch plans", {
			error: message,
		});
		res.status(500).json({
			success: false,
			message: "Failed to fetch plans",
		});
	}
};

export const createSubscription = async (
	req: Request<{}, {}, CreateSubscriptionInput>,
	res: Response,
): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const response =
			await subscriptionService.createSubscription(
				userId,
				req.body,
			);
		res.status(200).json({
			success: true,
			data: response,
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to create subscription";
		logger.error("Failed to create subscription", {
			error: message,
			userId: req.user?.id,
		});
		res.status(400).json({
			success: false,
			message,
		});
	}
};

export const verifyPayment = async (
	req: Request<{}, {}, VerifyPaymentInput>,
	res: Response,
): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const response =
			await subscriptionService.verifyPayment(
				userId,
				req.body,
			);
		res.status(200).json({
			success: true,
			data: response,
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to verify payment";
		logger.error("Failed to verify payment", {
			error: message,
			userId: req.user?.id,
		});
		res.status(400).json({
			success: false,
			message,
		});
	}
};

export const cancelSubscription = async (
	req: Request<
		{},
		{},
		{ cancelAtCycleEnd?: boolean }
	>,
	res: Response,
): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const response =
			await subscriptionService.cancelSubscription(
				userId,
				{
					cancelAtCycleEnd:
						req.body.cancelAtCycleEnd,
				},
			);
		res.status(200).json({
			success: true,
			data: response,
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to cancel subscription";
		logger.error("Failed to cancel subscription", {
			error: message,
			userId: req.user?.id,
		});
		res.status(400).json({
			success: false,
			message,
		});
	}
};

export const getCurrentSubscription = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const response =
			await subscriptionService.getCurrentSubscription(
				userId,
			);
		res.status(200).json({
			success: true,
			data: response,
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to fetch current subscription";
		logger.error(
			"Failed to fetch current subscription",
			{
				error: message,
				userId: req.user?.id,
			},
		);
		res.status(400).json({
			success: false,
			message,
		});
	}
};

export const handleRazorpayWebhook = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const signature = getHeaderValue(
			req.headers["x-razorpay-signature"],
		);
		const rawBody =
			(req as Request & { rawBody?: string })
				.rawBody ??
			JSON.stringify(req.body ?? {});

		const result =
			await subscriptionService.processWebhook(
				rawBody,
				signature,
			);

		res.status(200).json({
			success: true,
			data: result,
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to process webhook";
		logger.error("Razorpay webhook failed", {
			error: message,
		});
		res.status(400).json({
			success: false,
			message,
		});
	}
};
