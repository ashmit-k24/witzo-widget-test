import { Request, Response } from "express";
import { config } from "../config/env";
import { salesforceIntegrationService } from "../services/salesforceIntegrationService";
import logger from "../utils/logger";

function getUserId(req: Request): string | null {
	return req.user?.id ?? null;
}

function getErrorRedirect(message: string): string {
	return `${config.FRONTEND_URL}/dashboard/salesforce?salesforce_error=${encodeURIComponent(message)}`;
}

function getStatusCodeForError(message: string): number {
	if (message.includes("Authentication required")) return 401;
	if (message.includes("Basic, Standard, and Enterprise")) return 403;
	return 400;
}

function handleControllerError(res: Response, error: unknown, defaultMessage: string): void {
	const message = error instanceof Error ? error.message : defaultMessage;
	res.status(getStatusCodeForError(message)).json({ success: false, message });
}

export const getSalesforceConfig = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) return void res.status(401).json({ success: false, message: "Authentication required" });
		res.status(200).json({ success: true, data: await salesforceIntegrationService.getConfig(userId) });
	} catch (error) {
		logger.error("Failed to fetch Salesforce config", { error });
		handleControllerError(res, error, "Failed to fetch Salesforce config");
	}
};

export const getSalesforceConnectUrl = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) return void res.status(401).json({ success: false, message: "Authentication required" });
		const returnTo = typeof req.body?.returnTo === "string" ? req.body.returnTo : undefined;
		logger.info("Salesforce connect endpoint hit", {
			userId,
			returnTo: returnTo ?? null,
		});
		res.status(200).json({ success: true, data: await salesforceIntegrationService.getConnectUrl(userId, returnTo) });
	} catch (error) {
		logger.error("Failed to create Salesforce connect URL", { error });
		handleControllerError(res, error, "Failed to create Salesforce connect URL");
	}
};

export const handleSalesforceCallback = async (req: Request, res: Response): Promise<void> => {
	const providerError = typeof req.query.error === "string" ? req.query.error : null;
	const providerDescription = typeof req.query.error_description === "string" ? req.query.error_description : null;
	logger.info("Salesforce callback query received", {
		error: providerError,
		errorDescription: providerDescription,
		codePresent: typeof req.query.code === "string",
		codeLength: typeof req.query.code === "string" ? req.query.code.length : 0,
		statePresent: typeof req.query.state === "string",
		stateLength: typeof req.query.state === "string" ? req.query.state.length : 0,
		redirectUri: config.SALESFORCE_REDIRECT_URI,
	});
	if (providerError) {
		return void res.redirect(getErrorRedirect(providerDescription ? `${providerError}: ${providerDescription}` : providerError));
	}
	try {
		const code = typeof req.query.code === "string" ? req.query.code : null;
		const state = typeof req.query.state === "string" ? req.query.state : null;
		if (!code || !state) return void res.redirect(getErrorRedirect("Missing Salesforce callback parameters."));
		const result = await salesforceIntegrationService.handleOauthCallback({ code, state });
		res.redirect(result.redirectTo);
	} catch (error) {
		logger.error("Salesforce OAuth callback failed", { error });
		res.redirect(getErrorRedirect(error instanceof Error ? error.message : "Salesforce OAuth callback failed"));
	}
};

export const updateSalesforceSettings = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) return void res.status(401).json({ success: false, message: "Authentication required" });
		const data = await salesforceIntegrationService.updateSettings(userId, { isActive: req.body?.isActive, leadSyncEnabled: req.body?.leadSyncEnabled, taskSyncEnabled: req.body?.taskSyncEnabled });
		res.status(200).json({ success: true, data });
	} catch (error) {
		logger.error("Failed to update Salesforce settings", { error });
		handleControllerError(res, error, "Failed to update Salesforce settings");
	}
};

export const disconnectSalesforce = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) return void res.status(401).json({ success: false, message: "Authentication required" });
		await salesforceIntegrationService.disconnect(userId);
		res.status(200).json({ success: true, message: "Salesforce CRM disconnected" });
	} catch (error) {
		logger.error("Failed to disconnect Salesforce", { error });
		handleControllerError(res, error, "Failed to disconnect Salesforce");
	}
};

export const sendSalesforceTest = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) return void res.status(401).json({ success: false, message: "Authentication required" });
		await salesforceIntegrationService.sendTestEvent(userId);
		res.status(200).json({ success: true, message: "Test Salesforce sync event queued" });
	} catch (error) {
		logger.error("Failed to queue Salesforce test event", { error });
		handleControllerError(res, error, "Failed to queue Salesforce test event");
	}
};

export const listSalesforceEvents = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) return void res.status(401).json({ success: false, message: "Authentication required" });
		const limit = Number(req.query.limit || 50);
		res.status(200).json({ success: true, data: await salesforceIntegrationService.getEvents(userId, limit) });
	} catch (error) {
		logger.error("Failed to list Salesforce events", { error });
		handleControllerError(res, error, "Failed to fetch Salesforce events");
	}
};

export const retrySalesforceEvent = async (req: Request, res: Response): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) return void res.status(401).json({ success: false, message: "Authentication required" });
		await salesforceIntegrationService.retryEvent(userId, req.params.eventId);
		res.status(200).json({ success: true, message: "Salesforce event retry queued" });
	} catch (error) {
		logger.error("Failed to retry Salesforce event", { error });
		handleControllerError(res, error, "Failed to retry Salesforce event");
	}
};
