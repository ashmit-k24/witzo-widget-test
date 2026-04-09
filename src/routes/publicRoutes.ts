import { Router } from "express";
import {
	publicWidgetActionLimiter,
	publicWidgetChatLimiter,
} from "../config/rateLimiters";
import * as subscriptionController from "../controllers/subscriptionController";
import * as calendlyIntegrationController from "../controllers/calendlyIntegrationController";
import * as widgetController from "../controllers/widgetController";
import * as publicWidgetController from "../controllers/publicWidgetController";
import {
	validate,
	validationRules,
} from "../middleware/validator";

const router: Router = Router();

/**
 * Public API routes for widget embedding.
 * These routes do not require user authentication but validate widget keys.
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
	publicWidgetChatLimiter,
	validationRules.publicWebhook,
	validate,
	widgetController.webhookChat,
);

/**
 * @route   GET /api/v1/widget/embed.js
 * @desc    Serve the widget embed script (base widget loader)
 * @access  Public
 */
router.get("/widget/embed.js", (_req, res) => {
	res.setHeader("Content-Type", "application/javascript");
	res.setHeader("Cache-Control", "public, max-age=3600");
	res.send(`
// Witzo Chat Widget Embed Script
console.log('Witzo Chat Widget: Use your own chat widget component with the widget-key attribute');
console.warn('This endpoint is for serving your custom widget JavaScript. Please implement your own widget or use an existing chat widget library.');

// Example usage:
// <witzo-chat widget-key="your-key" api-url="http://localhost:3008/api/v1/webhook"></witzo-chat>
	`);
});

/**
 * @route   POST /api/v1/paddle/webhook
 * @desc    Paddle billing webhook (no auth required — Paddle signs the payload)
 * @access  Public
 */
router.post(
	"/calendly/webhook/:integrationId",
	validationRules.calendlyWebhookParam,
	validate,
	calendlyIntegrationController.handleCalendlyWebhook,
);

router.post(
	"/paddle/webhook",
	subscriptionController.handlePaddleWebhook,
);

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
	publicWidgetActionLimiter,
	validationRules.publicWidgetContact,
	validate,
	publicWidgetController.submitContactForm,
);

/**
 * @route   POST /api/v1/widget/lead-status
 * @desc    Check whether the configured lead fields are already captured
 * @access  Public (requires valid widget key and session)
 */
router.post(
	"/widget/lead-status",
	publicWidgetActionLimiter,
	validationRules.publicWidgetLeadStatus,
	validate,
	publicWidgetController.getLeadFormStatus,
);

/**
 * @route   POST /api/v1/widget/rating
 * @desc    Submit a chat rating (👍/👎) for a session (basic plan only)
 * @access  Public (requires valid widget key in body)
 */
router.post(
	"/widget/rating",
	publicWidgetActionLimiter,
	validationRules.publicWidgetRating,
	validate,
	publicWidgetController.submitChatRating,
);

export default router;
