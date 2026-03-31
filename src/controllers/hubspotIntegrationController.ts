import { Request, Response } from "express";
import { config } from "../config/env";
import { hubspotIntegrationService } from "../services/hubspotIntegrationService";
import logger from "../utils/logger";

function getUserId(req: Request): string | null {
	return req.user?.id ?? null;
}

function getHubspotErrorRedirect(
	message: string,
): string {
	const safeMessage = encodeURIComponent(message);
	return `${config.FRONTEND_URL}/dashboard/hubspot?hubspot_error=${safeMessage}`;
}

function getStatusCodeForError(
	message: string,
): number {
	if (message.includes("Authentication required")) {
		return 401;
	}
	if (
		message.includes("Basic, Standard, and Enterprise")
	) {
		return 403;
	}
	return 400;
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
	res.status(getStatusCodeForError(message)).json({
		success: false,
		message,
	});
}

export const getHubspotConfig = async (
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

		const configData =
			await hubspotIntegrationService.getConfig(
				userId,
			);
		res.status(200).json({
			success: true,
			data: configData,
		});
	} catch (error) {
		logger.error("Failed to fetch HubSpot config", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to fetch HubSpot config",
		);
	}
};

export const getHubspotConnectUrl = async (
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

		const returnTo =
			typeof req.body?.returnTo === "string"
				? req.body.returnTo
				: undefined;
		const result =
			await hubspotIntegrationService.getConnectUrl(
				userId,
				returnTo,
			);
		res.status(200).json({
			success: true,
			data: result,
		});
	} catch (error) {
		logger.error("Failed to create HubSpot connect URL", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to create HubSpot connect URL",
		);
	}
};

export const handleHubspotCallback = async (
	req: Request,
	res: Response,
): Promise<void> => {
	const hubspotError =
		typeof req.query.error === "string"
			? req.query.error
			: null;
	const hubspotErrorDescription =
		typeof req.query.error_description ===
		"string"
			? req.query.error_description
			: null;

	if (hubspotError) {
		const message = hubspotErrorDescription
			? `${hubspotError}: ${hubspotErrorDescription}`
			: hubspotError;
		res.redirect(getHubspotErrorRedirect(message));
		return;
	}

	try {
		const code =
			typeof req.query.code === "string"
				? req.query.code
				: null;
		const state =
			typeof req.query.state === "string"
				? req.query.state
				: null;
		if (!code || !state) {
			res.redirect(
				getHubspotErrorRedirect(
					"Missing HubSpot callback parameters.",
				),
			);
			return;
		}

		const result =
			await hubspotIntegrationService.handleOauthCallback(
				{
					code,
					state,
				},
			);
		res.redirect(result.redirectTo);
	} catch (error) {
		logger.error("HubSpot OAuth callback failed", {
			error,
		});
		const message =
			error instanceof Error
				? error.message
				: "HubSpot OAuth callback failed";
		res.redirect(getHubspotErrorRedirect(message));
	}
};

export const updateHubspotSettings = async (
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

		const result =
			await hubspotIntegrationService.updateSettings(
				userId,
				{
					isActive: req.body?.isActive,
					contactSyncEnabled:
						req.body?.contactSyncEnabled,
					companySyncEnabled:
						req.body?.companySyncEnabled,
					noteSyncEnabled:
						req.body?.noteSyncEnabled,
				},
			);
		res.status(200).json({
			success: true,
			data: result,
		});
	} catch (error) {
		logger.error("Failed to update HubSpot settings", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to update HubSpot settings",
		);
	}
};

export const disconnectHubspot = async (
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

		await hubspotIntegrationService.disconnect(
			userId,
		);
		res.status(200).json({
			success: true,
			message: "HubSpot disconnected",
		});
	} catch (error) {
		logger.error("Failed to disconnect HubSpot", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to disconnect HubSpot",
		);
	}
};

export const sendHubspotTest = async (
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

		await hubspotIntegrationService.sendTestEvent(
			userId,
		);
		res.status(200).json({
			success: true,
			message: "Test HubSpot sync event queued",
		});
	} catch (error) {
		logger.error("Failed to queue HubSpot test event", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to queue HubSpot test event",
		);
	}
};

export const listHubspotEvents = async (
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
			await hubspotIntegrationService.getEvents(
				userId,
				limit,
			);
		res.status(200).json({
			success: true,
			data: events,
		});
	} catch (error) {
		logger.error("Failed to list HubSpot events", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to fetch HubSpot events",
		);
	}
};

export const retryHubspotEvent = async (
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
		const eventId = req.params.eventId;
		await hubspotIntegrationService.retryEvent(
			userId,
			eventId,
		);
		res.status(200).json({
			success: true,
			message: "HubSpot event retry queued",
		});
	} catch (error) {
		logger.error("Failed to retry HubSpot event", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to retry HubSpot event",
		);
	}
};
