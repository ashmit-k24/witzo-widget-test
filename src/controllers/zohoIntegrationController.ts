import { Request, Response } from "express";
import { config } from "../config/env";
import { zohoIntegrationService } from "../services/zohoIntegrationService";
import logger from "../utils/logger";

function getUserId(req: Request): string | null {
	return req.user?.id ?? null;
}

function getZohoErrorRedirect(message: string): string {
	return `${config.FRONTEND_URL}/dashboard/zoho?zoho_error=${encodeURIComponent(message)}`;
}

function getStatusCodeForError(message: string): number {
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

export const getZohoConfig = async (
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
			await zohoIntegrationService.getConfig(userId);
		res.status(200).json({
			success: true,
			data: configData,
		});
	} catch (error) {
		logger.error("Failed to fetch Zoho config", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to fetch Zoho config",
		);
	}
};

export const getZohoConnectUrl = async (
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
		logger.info("Zoho connect endpoint hit", {
			userId,
			returnTo: returnTo ?? null,
		});
		const result =
			await zohoIntegrationService.getConnectUrl(
				userId,
				returnTo,
			);
		res.status(200).json({
			success: true,
			data: result,
		});
	} catch (error) {
		logger.error("Failed to create Zoho connect URL", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to create Zoho connect URL",
		);
	}
};

export const handleZohoCallback = async (
	req: Request,
	res: Response,
): Promise<void> => {
	logger.info("Zoho callback query received", {
		codePresent:
			typeof req.query.code === "string",
		statePresent:
			typeof req.query.state === "string",
		error:
			typeof req.query.error === "string"
				? req.query.error
				: null,
		errorDescription:
			typeof req.query.error_description ===
			"string"
				? req.query.error_description
				: null,
		accountsServer:
			typeof req.query["accounts-server"] ===
			"string"
				? req.query["accounts-server"]
				: null,
		location:
			typeof req.query.location === "string"
				? req.query.location
				: null,
	});
	const zohoError =
		typeof req.query.error === "string"
			? req.query.error
			: null;
	const zohoErrorDescription =
		typeof req.query.error_description ===
		"string"
			? req.query.error_description
			: null;

	if (zohoError) {
		res.redirect(
			getZohoErrorRedirect(
				zohoErrorDescription
					? `${zohoError}: ${zohoErrorDescription}`
					: zohoError,
			),
		);
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
		const accountsServer =
			typeof req.query["accounts-server"] ===
			"string"
				? req.query["accounts-server"]
				: null;
		const location =
			typeof req.query.location === "string"
				? req.query.location
				: null;
		if (!code || !state) {
			res.redirect(
				getZohoErrorRedirect(
					"Missing Zoho callback parameters.",
				),
			);
			return;
		}
		const result =
			await zohoIntegrationService.handleOauthCallback(
				{
					code,
					state,
					accountsServer,
					location,
				},
			);
		res.redirect(result.redirectTo);
	} catch (error) {
		logger.error("Zoho OAuth callback failed", {
			error,
		});
		res.redirect(
			getZohoErrorRedirect(
				error instanceof Error
					? error.message
					: "Zoho OAuth callback failed",
			),
		);
	}
};

export const updateZohoSettings = async (
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
			await zohoIntegrationService.updateSettings(
				userId,
				{
					isActive: req.body?.isActive,
					leadSyncEnabled:
						req.body?.leadSyncEnabled,
					noteSyncEnabled:
						req.body?.noteSyncEnabled,
				},
			);
		res.status(200).json({
			success: true,
			data: result,
		});
	} catch (error) {
		logger.error("Failed to update Zoho settings", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to update Zoho settings",
		);
	}
};

export const disconnectZoho = async (
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
		await zohoIntegrationService.disconnect(userId);
		res.status(200).json({
			success: true,
			message: "Zoho CRM disconnected",
		});
	} catch (error) {
		logger.error("Failed to disconnect Zoho", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to disconnect Zoho",
		);
	}
};

export const sendZohoTest = async (
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
		await zohoIntegrationService.sendTestEvent(userId);
		res.status(200).json({
			success: true,
			message: "Test Zoho sync event queued",
		});
	} catch (error) {
		logger.error("Failed to queue Zoho test event", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to queue Zoho test event",
		);
	}
};

export const listZohoEvents = async (
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
			await zohoIntegrationService.getEvents(
				userId,
				limit,
			);
		res.status(200).json({
			success: true,
			data: events,
		});
	} catch (error) {
		logger.error("Failed to list Zoho events", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to fetch Zoho events",
		);
	}
};

export const retryZohoEvent = async (
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
		await zohoIntegrationService.retryEvent(
			userId,
			req.params.eventId,
		);
		res.status(200).json({
			success: true,
			message: "Zoho event retry queued",
		});
	} catch (error) {
		logger.error("Failed to retry Zoho event", {
			error,
		});
		handleControllerError(
			res,
			error,
			"Failed to retry Zoho event",
		);
	}
};
