import { Router } from "express";
import * as widgetController from "../controllers/widgetController";

const router: Router = Router();

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

export default router;
