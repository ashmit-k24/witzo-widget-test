import { Request, Response } from "express";
import { coercePlanType, getPlanCapabilities } from "../config/planConfig";
import pool from "../config/database";
import widgetService from "../services/widgetService";
import { chatRatingService } from "../services/chatRatingService";
import { leadService } from "../services/leadService";
import logger from "../utils/logger";

function extractDomain(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * Verifies a widget key and resolves the owner userId.
 * Returns null with a JSON error response already written on failure.
 */
async function resolveWidget(
	req: Request,
	res: Response,
	widgetKey: string,
): Promise<{ userId: string; referer: string } | null> {
	const referer = req.get("referer") || req.get("origin") || "";
	const refererDomain = extractDomain(referer);

	const verification = await widgetService.verifyWidgetKey(widgetKey, refererDomain);
	if (!verification.valid) {
		res.status(403).json({ success: false, message: "Invalid widget key" });
		return null;
	}

	return { userId: verification.userId!, referer };
}

/**
 * POST /api/v1/widget/contact
 * Fallback contact form submission when the conversation limit is hit (basic plan only).
 */
export async function submitContactForm(req: Request, res: Response): Promise<void> {
	try {
		const { widgetKey, sessionId, name, email, message } = req.body;

		const resolved = await resolveWidget(req, res, widgetKey);
		if (!resolved) return;

		const { userId, referer } = resolved;

		const { rows } = await pool.query<{ plan_type: string }>(
			`SELECT plan_type FROM users WHERE id = $1`,
			[userId],
		);
		const planType = coercePlanType(rows[0]?.plan_type);

		if (!getPlanCapabilities(planType).fallbackLeadForm) {
			res.status(403).json({ success: false, message: "Feature not available on your plan" });
			return;
		}

		const widget = await widgetService.getWidgetKeyByKey(widgetKey);
		if (!widget) {
			res.status(404).json({ success: false, message: "Widget not found" });
			return;
		}

		await leadService.saveContactFormLead(userId, sessionId, widget.id, {
			name: name || null,
			email,
			summary: message || null,
			ipAddress: req.ip,
			sourceUrl: referer,
		});

		res.status(200).json({ success: true, message: "Message received. We will be in touch!" });
	} catch (err) {
		logger.error("Error saving contact form lead", { err });
		res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
	}
}

/**
 * POST /api/v1/widget/rating
 * Submit a chat rating (thumbs up/down) for a session (basic plan only).
 */
export async function submitChatRating(req: Request, res: Response): Promise<void> {
	try {
		const { widgetKey, sessionId, rating } = req.body;

		const resolved = await resolveWidget(req, res, widgetKey);
		if (!resolved) return;

		const { userId } = resolved;

		const { rows } = await pool.query<{ plan_type: string }>(
			`SELECT plan_type FROM users WHERE id = $1`,
			[userId],
		);
		const planType = coercePlanType(rows[0]?.plan_type);

		if (!getPlanCapabilities(planType).chatRating) {
			res.status(403).json({ success: false, message: "Feature not available on your plan" });
			return;
		}

		const widget = await widgetService.getWidgetKeyByKey(widgetKey);
		if (!widget) {
			res.status(404).json({ success: false, message: "Widget not found" });
			return;
		}

		await chatRatingService.upsertRating(userId, sessionId, widget.id, rating as "up" | "down");

		res.status(200).json({ success: true, message: "Rating recorded" });
	} catch (err) {
		logger.error("Error saving chat rating", { err });
		res.status(500).json({ success: false, message: "Failed to save rating" });
	}
}
