import { Request, Response } from "express";
import { coercePlanType, getPlanCapabilities } from "../config/planConfig";
import pool from "../config/database";
import widgetService from "../services/widgetService";
import { chatRatingService } from "../services/chatRatingService";
import { chatService } from "../services/chatService";
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
	const originToken =
		req
			.get("x-witzo-origin-token")
			?.trim() || undefined;

	const verification =
		await widgetService.verifyWidgetKey(
			widgetKey,
			refererDomain,
			originToken,
		);
	if (!verification.valid) {
		res.status(403).json({
			success: false,
			message:
				verification.message ||
				"Invalid widget key",
		});
		return null;
	}

	return { userId: verification.userId!, referer };
}

function getRequiredLeadFields(widgetConfig: Record<string, any> | null | undefined) {
	return {
		name: widgetConfig?.leadFormNameEnabled !== false,
		email: widgetConfig?.leadFormEmailEnabled !== false,
		phone: widgetConfig?.leadFormPhoneEnabled !== false,
		country: widgetConfig?.leadFormCountryEnabled !== false,
	};
}

/**
 * POST /api/v1/widget/contact
 * Contact form submission for the configured pre-chat lead gate or the paid fallback form.
 */
export async function submitContactForm(req: Request, res: Response): Promise<void> {
	try {
		const { widgetKey, sessionId, name, email, phone, country, message } = req.body;

		const resolved = await resolveWidget(req, res, widgetKey);
		if (!resolved) return;

		const { userId, referer } = resolved;

		const { rows } = await pool.query<{ plan_type: string }>(
			`SELECT plan_type FROM users WHERE id = $1`,
			[userId],
		);
		const planType = coercePlanType(rows[0]?.plan_type);

		const widget = await widgetService.getWidgetKeyByKey(widgetKey);
		if (!widget) {
			res.status(404).json({ success: false, message: "Widget not found" });
			return;
		}
		const leadFormEnabled = Boolean(widget.widget_config?.leadFormEnabled);
		if (!leadFormEnabled) {
			if (!email) {
				res.status(400).json({ success: false, message: "Email is required" });
				return;
			}

			if (!getPlanCapabilities(planType).fallbackLeadForm) {
				res.status(403).json({ success: false, message: "Feature not available on your plan" });
				return;
			}

			const sessionContext =
				await chatService.getConversationContext(
					sessionId,
					userId,
				);
			if (
				!sessionContext ||
				sessionContext.widgetKeyId !== widget.id
			) {
				res.status(403).json({
					success: false,
					message: "Invalid widget session",
				});
				return;
			}
		}

		if (!name && !email && !phone && !country && !message) {
			res.status(400).json({ success: false, message: "At least one lead field is required" });
			return;
		}

		await leadService.saveContactFormLead(userId, sessionId, widget.id, {
			name: name || null,
			email: email || null,
			phone: phone || null,
			country: country || null,
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
 * POST /api/v1/widget/lead-status
 * Checks whether the configured lead-form fields are already captured for this session.
 */
export async function getLeadFormStatus(req: Request, res: Response): Promise<void> {
	try {
		const { widgetKey, sessionId } = req.body;
		const resolved = await resolveWidget(req, res, widgetKey);
		if (!resolved) return;

		const { userId, referer } = resolved;
		const widget = await widgetService.getWidgetKeyByKey(widgetKey);
		if (!widget) {
			res.status(404).json({ success: false, message: "Widget not found" });
			return;
		}

		if (!widget.widget_config?.leadFormEnabled) {
			res.status(200).json({
				success: true,
				data: {
					completed: true,
					missingFields: [],
				},
			});
			return;
		}

		const sessionContext =
			await chatService.getConversationContext(
				sessionId,
				userId,
			);
		if (
			!sessionContext ||
			sessionContext.widgetKeyId !== widget.id
		) {
			res.status(403).json({
				success: false,
				message: "Invalid widget session",
			});
			return;
		}

		const requiredFields = getRequiredLeadFields(widget.widget_config);
		let status = await leadService.getLeadFormStatus(
			userId,
			sessionId,
			requiredFields,
		);

		if (!status.completed) {
			const session = await chatService.getSession(sessionId);
			if (session?.messages?.length) {
				await leadService.extractAndUpsertLeadFormFields(
					userId,
					sessionId,
					widget.id,
					session.messages,
					requiredFields,
					{
						ipAddress: req.ip,
						sourceUrl: referer,
					},
				);
				status = await leadService.getLeadFormStatus(
					userId,
					sessionId,
					requiredFields,
				);
			}
		}

		res.status(200).json({
			success: true,
			data: status,
		});
	} catch (err) {
		logger.error("Error checking lead form status", { err });
		res.status(500).json({ success: false, message: "Failed to check lead status" });
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
		const sessionContext =
			await chatService.getConversationContext(
				sessionId,
				userId,
			);
		if (
			!sessionContext ||
			sessionContext.widgetKeyId !== widget.id
		) {
			res.status(403).json({
				success: false,
				message: "Invalid widget session",
			});
			return;
		}

		await chatRatingService.upsertRating(userId, sessionId, widget.id, rating as "up" | "down");

		res.status(200).json({ success: true, message: "Rating recorded" });
	} catch (err) {
		logger.error("Error saving chat rating", { err });
		res.status(500).json({ success: false, message: "Failed to save rating" });
	}
}
