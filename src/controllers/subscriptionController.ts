import { Request, Response } from "express";
import {
	GetCheckoutInfoInput,
	subscriptionService,
} from "../services/subscriptionService";
import logger from "../utils/logger";

const getUserId = (req: Request): string | null =>
	req.user?.id ?? null;

const getHeaderValue = (
	header: string | string[] | undefined,
): string => {
	if (Array.isArray(header))
		return header[0] ?? "";
	return header ?? "";
};

export const getPlans = async (
	_req: Request,
	res: Response,
): Promise<void> => {
	try {
		res.setHeader(
			"Cache-Control",
			"no-store, no-cache, must-revalidate, proxy-revalidate",
		);
		res.setHeader("Pragma", "no-cache");
		res.setHeader("Expires", "0");

		const plans =
			await subscriptionService.listPlans(false);
		res
			.status(200)
			.json({ success: true, data: plans });
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to fetch plans";
		logger.error("Failed to fetch plans", {
			error: message,
		});
		res
			.status(500)
			.json({
				success: false,
				message: "Failed to fetch plans",
			});
	}
};

export const getCheckoutInfo = async (
	req: Request<{}, {}, GetCheckoutInfoInput>,
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
			await subscriptionService.getCheckoutInfo(
				userId,
				req.body,
				req.user?.email ?? null,
			);
		res
			.status(200)
			.json({ success: true, data: response });
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to get checkout info";
		logger.error("Failed to get checkout info", {
			error: message,
			userId: req.user?.id,
		});
		res
			.status(400)
			.json({ success: false, message });
	}
};

export const getPaddleRuntimeConfig = async (
	_req: Request,
	res: Response,
): Promise<void> => {
	try {
		const response =
			subscriptionService.getPublicPaddleRuntimeConfig();
		res
			.status(200)
			.json({ success: true, data: response });
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to get Paddle runtime config";
		logger.error(
			"Failed to get Paddle runtime config",
			{
				error: message,
			},
		);
		res
			.status(400)
			.json({ success: false, message });
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
		res
			.status(200)
			.json({ success: true, data: response });
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to cancel subscription";
		logger.error(
			"Failed to cancel subscription",
			{
				error: message,
				userId: req.user?.id,
			},
		);
		res
			.status(400)
			.json({ success: false, message });
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
		res
			.status(200)
			.json({ success: true, data: response });
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
		res
			.status(400)
			.json({ success: false, message });
	}
};

export const handlePaddleWebhook = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		logger.info("Received Paddle webhook", {
			body: req.body,
			headers: req.headers,
		});
		const signature = getHeaderValue(
			req.headers["paddle-signature"],
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

		res
			.status(200)
			.json({ success: true, data: result });
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to process webhook";
		logger.error("Paddle webhook failed", {
			error: message,
		});
		res
			.status(400)
			.json({ success: false, message });
	}
};

export const getPaymentHistory = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({ success: false, message: "Authentication required" });
			return;
		}
		const payments = await subscriptionService.getPaymentHistory(userId);
		res.status(200).json({ success: true, data: payments });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to fetch payment history";
		logger.error("Failed to fetch payment history", { error: message });
		res.status(500).json({ success: false, message });
	}
};
