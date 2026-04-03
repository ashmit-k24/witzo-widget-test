import { Request, Response } from "express";
import { config } from "../config/env";
import { calendlyIntegrationService } from "../services/calendlyIntegrationService";
import logger from "../utils/logger";

function getUserId(req: Request): string | null {
	return req.user?.id ?? null;
}

function getErrorRedirect(message: string): string {
	return `${config.FRONTEND_URL}/dashboard/calendly?calendly_error=${encodeURIComponent(message)}`;
}

function getStatusCodeForError(message: string): number {
	if (message.includes("Authentication required")) return 401;
	return 400;
}

function handleControllerError(res: Response, error: unknown, defaultMessage: string): void {
	const message = error instanceof Error ? error.message : defaultMessage;
	res.status(getStatusCodeForError(message)).json({ success: false, message });
}

export const getCalendlyConfig = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) return void res.status(401).json({ success: false, message: "Authentication required" });
		res.status(200).json({ success: true, data: await calendlyIntegrationService.getConfig(userId) });
	} catch (error) {
		logger.error("Failed to fetch Calendly config", { error });
		handleControllerError(res, error, "Failed to fetch Calendly config");
	}
};

export const getCalendlyConnectUrl = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) return void res.status(401).json({ success: false, message: "Authentication required" });
		const returnTo = typeof req.body?.returnTo === "string" ? req.body.returnTo : undefined;
		res.status(200).json({ success: true, data: await calendlyIntegrationService.getConnectUrl(userId, returnTo) });
	} catch (error) {
		logger.error("Failed to create Calendly connect URL", { error });
		handleControllerError(res, error, "Failed to create Calendly connect URL");
	}
};

export const handleCalendlyCallback = async (req: Request, res: Response): Promise<void> => {
	const providerError = typeof req.query.error === "string" ? req.query.error : null;
	const providerDescription = typeof req.query.error_description === "string" ? req.query.error_description : null;
	if (providerError) {
		return void res.redirect(getErrorRedirect(providerDescription ? `${providerError}: ${providerDescription}` : providerError));
	}
	try {
		const code = typeof req.query.code === "string" ? req.query.code : null;
		const state = typeof req.query.state === "string" ? req.query.state : null;
		if (!code || !state) return void res.redirect(getErrorRedirect("Missing Calendly callback parameters."));
		const result = await calendlyIntegrationService.handleOauthCallback({ code, state });
		res.redirect(result.redirectTo);
	} catch (error) {
		logger.error("Calendly OAuth callback failed", { error });
		res.redirect(getErrorRedirect(error instanceof Error ? error.message : "Calendly OAuth callback failed"));
	}
};

export const updateCalendlySettings = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) return void res.status(401).json({ success: false, message: "Authentication required" });
		const data = await calendlyIntegrationService.updateSettings(userId, {
			isActive: req.body?.isActive,
			widgetBookingEnabled: req.body?.widgetBookingEnabled,
			bookingIntentEnabled: req.body?.bookingIntentEnabled,
			bookingLabel: req.body?.bookingLabel,
			selectedEventTypeUri: req.body?.selectedEventTypeUri,
		});
		res.status(200).json({ success: true, data });
	} catch (error) {
		logger.error("Failed to update Calendly settings", { error });
		handleControllerError(res, error, "Failed to update Calendly settings");
	}
};

export const disconnectCalendly = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) return void res.status(401).json({ success: false, message: "Authentication required" });
		await calendlyIntegrationService.disconnect(userId);
		res.status(200).json({ success: true, message: "Calendly disconnected" });
	} catch (error) {
		logger.error("Failed to disconnect Calendly", { error });
		handleControllerError(res, error, "Failed to disconnect Calendly");
	}
};

export const listCalendlyAppointments = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) return void res.status(401).json({ success: false, message: "Authentication required" });
		const limit = Number(req.query.limit || 50);
		res.status(200).json({ success: true, data: await calendlyIntegrationService.listAppointments(userId, limit) });
	} catch (error) {
		logger.error("Failed to list Calendly appointments", { error });
		handleControllerError(res, error, "Failed to fetch Calendly appointments");
	}
};

export const handleCalendlyWebhook = async (req: Request, res: Response): Promise<void> => {
	try {
		const integrationId = req.params.integrationId;
		const rawBody = (req as Request & { rawBody?: string }).rawBody;
		await calendlyIntegrationService.processWebhook(
			integrationId,
			rawBody || JSON.stringify(req.body || {}),
			req.get("Calendly-Webhook-Signature"),
			req.body,
		);
		res.status(200).json({ success: true });
	} catch (error) {
		logger.error("Calendly webhook handling failed", { error, integrationId: req.params.integrationId });
		res.status(400).json({ success: false, message: error instanceof Error ? error.message : "Calendly webhook failed" });
	}
};
