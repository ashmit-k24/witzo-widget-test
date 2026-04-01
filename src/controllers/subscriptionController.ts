import { Request, Response } from "express";
import {
	GetCheckoutInfoInput,
	PricingPreviewLocationInput,
	UpgradeSubscriptionInput,
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

const extractPublicClientIp = (req: Request): string | null => {
	const forwardedFor = getHeaderValue(
		req.headers["x-forwarded-for"],
	);
	const candidates = [
		...forwardedFor.split(",").map((value) => value.trim()),
		getHeaderValue(req.headers["cf-connecting-ip"]).trim(),
		getHeaderValue(req.headers["x-real-ip"]).trim(),
		req.ip?.trim() ?? "",
	].filter(Boolean);

	for (const candidate of candidates) {
		const normalized = candidate.replace(/^::ffff:/i, "");
		const secondOctet = Number(normalized.split(".")[1] ?? "");
		const isPrivate172Range =
			normalized.startsWith("172.") &&
			Number.isInteger(secondOctet) &&
			secondOctet >= 16 &&
			secondOctet <= 31;
		if (
			normalized === "127.0.0.1" ||
			normalized === "::1" ||
			normalized.toLowerCase() === "localhost" ||
			normalized.startsWith("10.") ||
			normalized.startsWith("192.168.") ||
			isPrivate172Range
		) {
			continue;
		}

		return normalized;
	}

	return null;
};

const extractPricingPreviewLocation = (
	req: Request,
): PricingPreviewLocationInput => {
	const countryCode = [
		getHeaderValue(req.headers["x-vercel-ip-country"]),
		getHeaderValue(req.headers["cf-ipcountry"]),
		getHeaderValue(req.headers["cloudfront-viewer-country"]),
		getHeaderValue(req.headers["x-appengine-country"]),
		getHeaderValue(req.headers["x-geo-country"]),
		getHeaderValue(req.headers["x-forwarded-country"]),
		getHeaderValue(req.headers["x-country"]),
		getHeaderValue(req.headers["country-code"]),
		getHeaderValue(req.headers["x-country-code"]),
	]
		.map((value) => value.trim().toUpperCase())
		.find((value) => /^[A-Z]{2}$/.test(value));

	const postalCode = [
		getHeaderValue(req.headers["x-vercel-ip-postal-code"]),
		getHeaderValue(req.headers["x-postal-code"]),
	]
		.map((value) => value.trim())
		.find(Boolean);

	return {
		countryCode: countryCode ?? null,
		postalCode: postalCode ?? null,
		customerIpAddress: extractPublicClientIp(req),
	};
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

export const getLocalizedPricingPreview = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		res.setHeader(
			"Cache-Control",
			"no-store, no-cache, must-revalidate, proxy-revalidate",
		);
		res.setHeader("Pragma", "no-cache");
		res.setHeader("Expires", "0");

		const response =
			await subscriptionService.getLocalizedPricingPreview(
				extractPricingPreviewLocation(req),
			);
		res.status(200).json({ success: true, data: response });
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to preview localized pricing";
		logger.error("Failed to preview localized pricing", {
			error: message,
		});
		res.status(400).json({ success: false, message });
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

		logger.debug("Paddle webhook debug", {
			hasRawBody: !!(req as Request & { rawBody?: string }).rawBody,
			rawBodyLength: rawBody.length,
			signaturePresent: !!signature,
		});

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

export const downloadPaymentInvoice = async (
	req: Request<{ transactionId: string }>,
	res: Response,
): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res
				.status(401)
				.json({
					success: false,
					message: "Authentication required",
				});
			return;
		}

		const invoiceUrl =
			await subscriptionService.getPaymentInvoiceUrl(
				userId,
				req.params.transactionId,
			);
		res.redirect(invoiceUrl);
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to download invoice";
		logger.error("Failed to download invoice", {
			error: message,
			userId: req.user?.id,
			transactionId: req.params.transactionId,
		});
		res.status(404).json({
			success: false,
			message,
		});
	}
};

export const getPaymentStatus = async (
	req: Request<{ transactionId: string }>,
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

		const paymentStatus =
			await subscriptionService.getPaymentStatus(
				userId,
				req.params.transactionId,
			);
		res.status(200).json({
			success: true,
			data: paymentStatus,
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to fetch payment status";
		logger.error("Failed to fetch payment status", {
			error: message,
			userId: req.user?.id,
			transactionId: req.params.transactionId,
		});
		res.status(404).json({
			success: false,
			message,
		});
	}
};

export const upgradeSubscription = async (
	req: Request<{}, {}, UpgradeSubscriptionInput>,
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
			await subscriptionService.upgradeSubscription(
				userId,
				req.body,
			);
		res
			.status(200)
			.json({ success: true, data: response });
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to upgrade subscription";
		logger.error("Failed to upgrade subscription", {
			error: message,
			userId: req.user?.id,
		});
		res
			.status(400)
			.json({ success: false, message });
	}
};
