import { Request, Response } from "express";
import { coercePlanType } from "../config/planConfig";
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
		}, {
			requiredFields: leadFormEnabled ? getRequiredLeadFields(widget.widget_config) : undefined,
			finalize: true,
			planType,
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

export async function finalizeLeadCapture(req: Request, res: Response): Promise<void> {
	try {
		const { widgetKey, sessionId } = req.body as {
			widgetKey: string;
			sessionId: string;
		};
		const resolved = await resolveWidget(req, res, widgetKey);
		if (!resolved) return;

		const { userId, referer } = resolved;
		const widget = await widgetService.getWidgetKeyByKey(widgetKey);
		if (!widget) {
			res.status(404).json({ success: false, message: "Widget not found" });
			return;
		}

		const { rows } = await pool.query<{ plan_type: string }>(
			`SELECT plan_type FROM users WHERE id = $1`,
			[userId],
		);
		const planType = coercePlanType(rows[0]?.plan_type);

		const sessionContext = await chatService.getConversationContext(sessionId, userId);
		if (!sessionContext || sessionContext.widgetKeyId !== widget.id) {
			res.status(403).json({
				success: false,
				message: "Invalid widget session",
			});
			return;
		}

		const finalized = await leadService.finalizeLeadCapture(
			userId,
			sessionId,
			widget.id,
			widget.widget_config?.leadFormEnabled ? getRequiredLeadFields(widget.widget_config) : undefined,
			{
				ipAddress: req.ip,
				sourceUrl: referer,
			},
			planType,
		);

		res.status(200).json({
			success: true,
			data: {
				finalized,
			},
		});
	} catch (err) {
		logger.error("Error finalizing lead capture", { err });
		res.status(500).json({ success: false, message: "Failed to finalize lead capture" });
	}
}

export async function submitMessageFeedback(req: Request, res: Response): Promise<void> {
	try {
		const {
			widgetKey,
			sessionId,
			messageId,
			feedbackType,
			feedbackReason,
		} = req.body as {
			widgetKey: string;
			sessionId: string;
			messageId: number;
			feedbackType: "up" | "down";
			feedbackReason?: string | null;
		};

		const resolved = await resolveWidget(req, res, widgetKey);
		if (!resolved) return;

		const { userId } = resolved;
		const widget = await widgetService.getWidgetKeyByKey(widgetKey);
		if (!widget) {
			res.status(404).json({ success: false, message: "Widget not found" });
			return;
		}

		const sessionContext = await chatService.getConversationContext(sessionId, userId);
		if (!sessionContext || sessionContext.widgetKeyId !== widget.id) {
			res.status(403).json({
				success: false,
				message: "Invalid widget session",
			});
			return;
		}

		const messageResult = await pool.query<{ role: "user" | "assistant" | "system" }>(
			`SELECT role
			 FROM chat_messages
			 WHERE conversation_id = $1
			   AND user_id = $2
			   AND id = $3
			 LIMIT 1`,
			[sessionId, userId, messageId],
		);
		const message = messageResult.rows[0];
		if (!message) {
			res.status(404).json({ success: false, message: "Message not found" });
			return;
		}
		if (message.role !== "assistant") {
			res.status(400).json({ success: false, message: "Feedback can only be saved for assistant messages" });
			return;
		}

		await chatRatingService.upsertMessageFeedback(
			userId,
			sessionId,
			messageId,
			widget.id,
			feedbackType,
			feedbackReason,
		);

		res.status(200).json({ success: true, message: "Message feedback recorded" });
	} catch (err) {
		logger.error("Error saving chat message feedback", { err });
		res.status(500).json({ success: false, message: "Failed to save message feedback" });
	}
}

/**
 * Track a page view from the widget.
 * Body: { widgetKey, sessionId, url }
 * Stores in session_page_views table.
 */
export async function trackPageView(req: Request, res: Response): Promise<void> {
	try {
		const { widgetKey, sessionId, url } = req.body as {
			widgetKey?: string;
			sessionId?: string;
			url?: string;
		};

		if (!widgetKey || !sessionId || !url) {
			res.status(400).json({ success: false, message: "widgetKey, sessionId, and url are required" });
			return;
		}

		const widget = await resolveWidget(req, res, widgetKey);
		if (!widget) return;

		await pool.query(
			`INSERT INTO session_page_views (session_id, user_id, url, viewed_at)
			 VALUES ($1, $2, $3, NOW())`,
			[sessionId, widget.userId, url],
		);

		res.status(200).json({ success: true });
	} catch (error) {
		logger.warn("Failed to track page view", { error });
		// Non-critical — always return success to avoid breaking the widget
		res.status(200).json({ success: true });
	}
}
