import { Request, Response } from "express";
import { leadWebhookService } from "../services/leadWebhookService";
import logger from "../utils/logger";

function getUserId(req: Request): string | null {
	return req.user?.id ?? null;
}

function handleControllerError(
	res: Response,
	error: unknown,
	defaultMessage: string,
): void {
	const message =
		error instanceof Error
			? error.message
			: defaultMessage;
	const statusCode =
		message.includes("enterprise")
			? 403
			: 400;
	res.status(statusCode).json({
		success: false,
		message,
	});
}

export const getLeadWebhookConfig = async (
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

		const config =
			await leadWebhookService.getConfig(
				userId,
			);
		res.status(200).json({
			success: true,
			data: config,
		});
	} catch (error) {
		logger.error("Failed to get lead webhook config", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to fetch lead webhook config",
		);
	}
};

export const upsertLeadWebhookConfig = async (
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

		const { webhookUrl, isActive, rotateSecret } =
			req.body;
		const config =
			await leadWebhookService.upsertConfig(
				userId,
				{
					webhookUrl,
					isActive,
					rotateSecret,
				},
			);
		res.status(200).json({
			success: true,
			data: config,
		});
	} catch (error) {
		logger.error("Failed to update lead webhook config", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to update lead webhook config",
		);
	}
};

export const sendLeadWebhookTest = async (
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

		await leadWebhookService.sendTestEvent(
			userId,
		);
		res.status(200).json({
			success: true,
			message: "Test webhook event queued",
		});
	} catch (error) {
		logger.error("Failed to send test webhook event", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to send test webhook event",
		);
	}
};

export const listLeadWebhookEvents = async (
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

		const limit = Number(req.query.limit || 50);
		const events =
			await leadWebhookService.getEvents(
				userId,
				limit,
			);
		res.status(200).json({
			success: true,
			data: events,
		});
	} catch (error) {
		logger.error("Failed to list lead webhook events", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to fetch lead webhook events",
		);
	}
};

export const retryLeadWebhookEvent = async (
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

		const { eventId } = req.params;
		await leadWebhookService.retryEvent(
			userId,
			eventId,
		);
		res.status(200).json({
			success: true,
			message:
				"Webhook event retry queued successfully",
		});
	} catch (error) {
		logger.error("Failed to retry lead webhook event", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to retry webhook event",
		);
	}
};
