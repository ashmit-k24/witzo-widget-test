import { Router, Request, Response } from "express";
import * as widgetController from "../controllers/widgetController";
import pool from "../config/database";
import widgetService from "../services/widgetService";
import { chatRatingService } from "../services/chatRatingService";
import { leadService } from "../services/leadService";
import logger from "../utils/logger";

const router: Router = Router();

function extractDomain(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * Public API routes for widget embedding
 * These routes don't require authentication but need valid widget keys
 */

/**
 * @route   GET /api/v1/widget/config/:widgetKey
 * @desc    Get widget configuration by widget key
 * @access  Public (requires valid widget key)
 */
router.get(
	"/widget/config/:widgetKey",
	widgetController.getWidgetConfig,
);

/**
 * @route   POST /api/v1/webhook
 * @desc    Public webhook endpoint for widget chat messages
 * @access  Public (requires valid widget key in body)
 */
router.post(
	"/webhook",
	widgetController.webhookChat,
);

/**
 * @route   GET /api/v1/widget/embed.js
 * @desc    Serve the widget embed script (base widget loader)
 * @access  Public
 */
router.get("/widget/embed.js", (_req, res) => {
	res.setHeader(
		"Content-Type",
		"application/javascript",
	);
	res.setHeader(
		"Cache-Control",
		"public, max-age=3600",
	); // Cache for 1 hour

	// Serve the widget embed script
	// For now, we'll serve a placeholder that tells users to use their own widget
	res.send(`
// Witzo Chat Widget Embed Script
console.log('Witzo Chat Widget: Use your own chat widget component with the widget-key attribute');
console.warn('This endpoint is for serving your custom widget JavaScript. Please implement your own widget or use an existing chat widget library.');

// Example usage:
// <witzo-chat widget-key="your-key" api-url="http://localhost:3008/api/v1/webhook"></witzo-chat>
     `);
});

/**
 * @route   GET /api/v1/embed/:widgetKey.js
 * @desc    Dynamic single-script embed generator
 * @access  Public
 * @example <script src="http://localhost:3008/api/v1/embed/wk_abc123.js"></script>
 */
router.get(
	"/embed/:widgetKey.js",
	widgetController.generateEmbedScript,
);

/**
 * @route   POST /api/v1/widget/contact
 * @desc    Fallback contact form submission when conversation limit is hit (basic plan only)
 * @access  Public (requires valid widget key in body)
 */
router.post(
	"/widget/contact",
	async (req: Request, res: Response) => {
		try {
			const { widgetKey, sessionId, name, email, message } = req.body;

			if (!widgetKey || !sessionId || !email) {
				res.status(400).json({
					success: false,
					message: "widgetKey, sessionId, and email are required",
				});
				return;
			}

			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
				res.status(400).json({
					success: false,
					message: "Invalid email address",
				});
				return;
			}

			const referer =
				req.get("referer") || req.get("origin") || "";
			const refererDomain = extractDomain(referer);

			const verification = await widgetService.verifyWidgetKey(
				widgetKey,
				refererDomain,
			);
			if (!verification.valid) {
				res.status(403).json({
					success: false,
					message: "Invalid widget key",
				});
				return;
			}

			const userId = verification.userId!;

			const { rows } = await pool.query(
				`SELECT plan_type FROM users WHERE id = $1`,
				[userId],
			);
			if (!rows[0] || rows[0].plan_type !== "basic") {
				res.status(403).json({
					success: false,
					message: "Feature not available on your plan",
				});
				return;
			}

			const widget = await widgetService.getWidgetKeyByKey(widgetKey);

			await leadService.saveContactFormLead(
				userId,
				sessionId,
				widget?.id ?? 0,
				{
					name: name || null,
					email,
					summary: message || null,
					ipAddress: req.ip,
					sourceUrl: referer,
				},
			);

			res.status(200).json({
				success: true,
				message: "Message received. We will be in touch!",
			});
		} catch (err) {
			logger.error("Error saving contact form lead", { err });
			res.status(500).json({
				success: false,
				message: "Something went wrong. Please try again.",
			});
		}
	},
);

/**
 * @route   POST /api/v1/widget/rating
 * @desc    Submit a chat rating (👍/👎) for a session (basic plan only)
 * @access  Public (requires valid widget key in body)
 */
router.post(
	"/widget/rating",
	async (req: Request, res: Response) => {
		try {
			const { widgetKey, sessionId, rating } = req.body;

			if (!widgetKey || !sessionId || !rating) {
				res.status(400).json({
					success: false,
					message: "widgetKey, sessionId, and rating are required",
				});
				return;
			}
			if (rating !== "up" && rating !== "down") {
				res.status(400).json({
					success: false,
					message: 'rating must be "up" or "down"',
				});
				return;
			}

			const referer =
				req.get("referer") || req.get("origin") || "";
			const refererDomain = extractDomain(referer);

			const verification = await widgetService.verifyWidgetKey(
				widgetKey,
				refererDomain,
			);
			if (!verification.valid) {
				res.status(403).json({
					success: false,
					message: "Invalid widget key",
				});
				return;
			}

			const userId = verification.userId!;

			const { rows } = await pool.query(
				`SELECT plan_type FROM users WHERE id = $1`,
				[userId],
			);
			if (!rows[0] || rows[0].plan_type !== "basic") {
				res.status(403).json({
					success: false,
					message: "Feature not available on your plan",
				});
				return;
			}

			const widget = await widgetService.getWidgetKeyByKey(widgetKey);

			await chatRatingService.upsertRating(
				userId,
				sessionId,
				widget?.id ?? null,
				rating as "up" | "down",
			);

			res.status(200).json({ success: true, message: "Rating recorded" });
		} catch (err) {
			logger.error("Error saving chat rating", { err });
			res.status(500).json({
				success: false,
				message: "Failed to save rating",
			});
		}
	},
);

export default router;
