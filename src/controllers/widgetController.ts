import {
	NextFunction,
	Request,
	Response,
} from "express";
import { chatService } from "../services/chatService";
import { leadService } from "../services/leadService";
import usageTrackingService from "../services/usageTrackingService";
import widgetService from "../services/widgetService";
import logger from "../utils/logger";

/**
 * @route   POST /api/auth/widget/create
 * @desc    Create a new widget key for the authenticated user
 * @access  Protected
 */
export const createWidgetKey = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = (req.user as any)?.id;
		const {
			widgetName,
			allowedDomains,
			widgetConfig,
		} = req.body;

		const widgetKey =
			await widgetService.createWidgetKey({
				userId,
				widgetName,
				allowedDomains,
				widgetConfig,
			});
		const publicUrls = getWidgetPublicUrls(
			widgetKey.widget_key,
		);

		res.status(201).json({
			success: true,
			message: "Widget key created successfully",
			data: {
				widgetKey: widgetKey.widget_key,
				widgetName: widgetKey.widget_name,
				allowedDomains: widgetKey.allowed_domains,
				widgetConfig: widgetKey.widget_config,
				apiBaseUrl: publicUrls.apiUrl,
				embedScriptUrl:
					publicUrls.embedScriptUrl,
				widgetScriptUrl:
					publicUrls.widgetScriptUrl,
				embedCode: generateEmbedCode(
					widgetKey.widget_key,
					widgetKey.widget_config,
				),
			},
		});
	} catch (error) {
		next(error);
	}
};

/**
 * @route   GET /api/auth/widget/key
 * @desc    Get current user's widget key
 * @access  Protected
 */
export const getWidgetKey = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = (req.user as any)?.id;

		const widgetKey =
			await widgetService.getUserWidgetKey(
				userId,
			);

		if (!widgetKey) {
			res.status(404).json({
				success: false,
				message:
					"No widget key found. Create one first.",
			});
			return;
		}

		const publicUrls = getWidgetPublicUrls(
			widgetKey.widget_key,
		);

		res.status(200).json({
			success: true,
			data: {
				widgetKey: widgetKey.widget_key,
				widgetName: widgetKey.widget_name,
				isActive: widgetKey.is_active,
				allowedDomains: widgetKey.allowed_domains,
				widgetConfig: widgetKey.widget_config,
				usageCount: widgetKey.usage_count,
				lastUsedAt: widgetKey.last_used_at,
				createdAt: widgetKey.created_at,
				apiBaseUrl: publicUrls.apiUrl,
				embedScriptUrl:
					publicUrls.embedScriptUrl,
				widgetScriptUrl:
					publicUrls.widgetScriptUrl,
				embedCode: generateEmbedCode(
					widgetKey.widget_key,
					widgetKey.widget_config,
				),
			},
		});
	} catch (error) {
		next(error);
	}
};

/**
 * @route   PUT /api/auth/widget/update
 * @desc    Update widget key configuration
 * @access  Protected
 */
export const updateWidgetKey = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = (req.user as any)?.id;
		const {
			widgetName,
			isActive,
			allowedDomains,
			widgetConfig,
		} = req.body;

		const updatedWidget =
			await widgetService.updateWidgetKey(
				userId,
				{
					widgetName,
					isActive,
					allowedDomains,
					widgetConfig,
				},
			);
		const publicUrls = getWidgetPublicUrls(
			updatedWidget.widget_key,
		);

		res.status(200).json({
			success: true,
			message: "Widget key updated successfully",
			data: {
				widgetKey: updatedWidget.widget_key,
				widgetName: updatedWidget.widget_name,
				isActive: updatedWidget.is_active,
				allowedDomains:
					updatedWidget.allowed_domains,
				widgetConfig: updatedWidget.widget_config,
				apiBaseUrl: publicUrls.apiUrl,
				embedScriptUrl:
					publicUrls.embedScriptUrl,
				widgetScriptUrl:
					publicUrls.widgetScriptUrl,
				embedCode: generateEmbedCode(
					updatedWidget.widget_key,
					updatedWidget.widget_config,
				),
			},
		});
	} catch (error) {
		next(error);
	}
};

/**
 * @route   POST /api/auth/widget/regenerate
 * @desc    Regenerate widget key (creates new key, keeps config)
 * @access  Protected
 */
export const regenerateWidgetKey = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = (req.user as any)?.id;

		const newWidget =
			await widgetService.regenerateWidgetKey(
				userId,
			);
		const publicUrls = getWidgetPublicUrls(
			newWidget.widget_key,
		);

		res.status(200).json({
			success: true,
			message:
				"Widget key regenerated successfully",
			data: {
				widgetKey: newWidget.widget_key,
				apiBaseUrl: publicUrls.apiUrl,
				embedScriptUrl:
					publicUrls.embedScriptUrl,
				widgetScriptUrl:
					publicUrls.widgetScriptUrl,
				embedCode: generateEmbedCode(
					newWidget.widget_key,
					newWidget.widget_config,
				),
			},
		});
	} catch (error) {
		next(error);
	}
};

/**
 * @route   DELETE /api/auth/widget/delete
 * @desc    Delete widget key
 * @access  Protected
 */
export const deleteWidgetKey = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = (req.user as any)?.id;

		await widgetService.deleteWidgetKey(userId);

		res.status(200).json({
			success: true,
			message: "Widget key deleted successfully",
		});
	} catch (error) {
		next(error);
	}
};

/**
 * @route   GET /api/auth/widget/analytics
 * @desc    Get widget analytics
 * @access  Protected
 */
export const getWidgetAnalytics = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = (req.user as any)?.id;
		const limit =
			parseInt(req.query.limit as string) || 100;

		const analytics =
			await widgetService.getWidgetAnalytics(
				userId,
				limit,
			);

		res.status(200).json({
			success: true,
			data: analytics,
		});
	} catch (error) {
		next(error);
	}
};

/**
 * @route   GET /api/v1/widget/config/:widgetKey
 * @desc    Get widget configuration by widget key (public endpoint)
 * @access  Public
 */
export const getWidgetConfig = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { widgetKey } = req.params;
		const referer =
			req.get("referer") ||
			req.get("origin") ||
			"";
		const refererDomain = extractDomain(referer);

		const verification =
			await widgetService.verifyWidgetKey(
				widgetKey,
				refererDomain,
			);

		if (!verification.valid) {
			res.status(403).json({
				success: false,
				message:
					verification.message ||
					"Invalid widget key",
			});
			return;
		}

		const widget =
			await widgetService.getWidgetKeyByKey(
				widgetKey,
			);

		if (!widget) {
			res.status(404).json({
				success: false,
				message: "Widget not found",
			});
			return;
		}

		// Track widget load event
		await widgetService.trackWidgetEvent(
			widgetKey,
			"widget_loaded",
			{},
			{
				ipAddress: req.ip,
				userAgent: req.get("user-agent"),
				refererUrl: referer,
			},
		);

		res.status(200).json({
			success: true,
			data: {
				widgetKey: widget.widget_key,
				widgetName: widget.widget_name,
				config: widget.widget_config,
				webhookUrl: `${req.protocol}://${req.get("host")}/api/v1/webhook`,
			},
		});
	} catch (error) {
		next(error);
	}
};

/**
 * @route   POST /api/v1/webhook
 * @desc    Public webhook endpoint for widget chat messages
 * @access  Public (requires valid widget key in body)
 */
export const webhookChat = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { widgetKey, message, sessionId } =
			req.body;

		if (!widgetKey || !message) {
			res.status(400).json({
				success: false,
				message:
					"widgetKey and message are required",
			});
			return;
		}

		const referer =
			req.get("referer") ||
			req.get("origin") ||
			"";
		const refererDomain = extractDomain(referer);

		// Verify widget key and get userId
		const verification =
			await widgetService.verifyWidgetKey(
				widgetKey,
				refererDomain,
			);

		if (!verification.valid) {
			res.status(403).json({
				success: false,
				message:
					verification.message ||
					"Invalid widget key",
			});
			return;
		}

		const userId = verification.userId!;

		// CRITICAL: Check conversation limit BEFORE processing
		const canChat =
			await usageTrackingService.canUserChat(
				userId,
			);

		if (!canChat) {
			// Get usage stats to provide helpful info
			const usage =
				await usageTrackingService.getUserUsage(
					userId,
				);

			logger.warn(
				"Widget user exceeded conversation limit",
				{
					userId,
					widgetKey,
					conversationsUsed:
						usage.conversationsUsed,
					conversationsLimit:
						usage.conversationsLimit,
				},
			);

			res.status(403).json({
				success: false,
				message:
					"You've reached your conversation limit for this month. Please upgrade your plan to continue chatting.",
				limitReached: true,
				data: {
					planType: usage.planType,
					conversationsUsed:
						usage.conversationsUsed,
					conversationsLimit:
						usage.conversationsLimit,
					resetDate: usage.resetDate,
				},
			});
			return;
		}

		// Track message event
		await widgetService.trackWidgetEvent(
			widgetKey,
			"message_sent",
			{ message: message.substring(0, 100) },
			{
				ipAddress: req.ip,
				userAgent: req.get("user-agent"),
				refererUrl: referer,
			},
		);

		// Use chat service to get response
		const result = await chatService.chat(
			userId,
			message,
			sessionId,
		);

		// CRITICAL: Track conversation AFTER successful response
		await usageTrackingService.trackConversation(
			userId,
		);

		// Get updated usage stats
		const usage =
			await usageTrackingService.getUserUsage(
				userId,
			);

		// Fire-and-forget: extract lead info from conversation
		const widget = await widgetService.getWidgetKeyByKey(widgetKey);
		chatService.getSession(result.sessionId).then((session) => {
			if (session && session.messages.length >= 2) {
				leadService.extractAndUpsertLead(
					userId,
					result.sessionId,
					widget?.id ?? 0,
					session.messages,
					{
						ipAddress: req.ip,
						sourceUrl: referer,
					},
					usage.planType,
				).catch(() => {});
			}
		}).catch(() => {});

		logger.info("Widget conversation tracked", {
			userId,
			widgetKey,
			conversationsUsed: usage.conversationsUsed,
			conversationsRemaining:
				usage.conversationsRemaining,
		});

		const responseData: any = {
			success: true,
			sessionId: result.sessionId,
			response: result.response,
			// sources: result.sources,
			usage: {
				conversationsRemaining:
					usage.conversationsRemaining,
				resetDate: usage.resetDate,
			},
		};

		// Add warning if approaching limit
		if (usage.isApproachingLimit) {
			responseData.warning =
				"You're approaching your monthly conversation limit";
		}

		res.status(200).json(responseData);
	} catch (error) {
		logger.error("Error in webhook chat", {
			error,
		});
		next(error);
	}
};

/**
 * @route   GET /api/v1/embed/:widgetKey.js
 * @desc    Generate single-script embed for widget
 * @access  Public
 */
export const generateEmbedScript = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const { widgetKey } = req.params;
		const referer =
			req.get("referer") ||
			req.get("origin") ||
			"";
		const refererDomain = extractDomain(referer);

		const verification =
			await widgetService.verifyWidgetKey(
				widgetKey,
				refererDomain,
			);

		if (!verification.valid) {
			res.setHeader(
				"Content-Type",
				"application/javascript",
			);
			res
				.status(403)
				.send(
					`console.error('Witzo Widget Error: ${
						verification.message ||
						"Domain not allowed"
					}');`,
				);
			return;
		}

		// Widget exists and is active if verification passed, but fetch config for rendering
		const widget =
			await widgetService.getWidgetKeyByKey(
				widgetKey,
			);

		if (!widget) {
			res.setHeader(
				"Content-Type",
				"application/javascript",
			);
			res
				.status(404)
				.send(
					`console.error('Witzo Widget Error: Invalid widget key "${widgetKey}"');`,
				);
			return;
		}

		const config = widget.widget_config;
		const planType = widget.plan_type ?? "free";
		const apiUrl =
			process.env.WIDGET_API_URL ||
			"http://localhost:3008";
		const widgetScriptUrl =
			process.env.WIDGET_SCRIPT_URL ||
			`${apiUrl}/widget/witzo-chat.js`;

		// Build config attributes for the widget element
		const configAttrs = Object.entries(config)
			.map(([key, value]) => {
				// Convert camelCase to kebab-case
				const kebabKey = key
					.replace(/([A-Z])/g, "-$1")
					.toLowerCase();

				if (typeof value === "boolean") {
					return `  widget.setAttribute('${kebabKey}', '${value}');`;
				}
				if (typeof value === "string") {
					// Escape quotes and newlines
					const escapedValue = value
						.replace(/'/g, "\\'")
						.replace(/\n/g, "\\n");
					return `  widget.setAttribute('${kebabKey}', '${escapedValue}');`;
				}
				if (typeof value === "number") {
					return `  widget.setAttribute('${kebabKey}', '${value}');`;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");

		// Generate the embed script
		const script = `
/**
 * Witzo Chat Widget - Auto-Embed Script
 * Widget Key: ${widgetKey}
 * Generated: ${new Date().toISOString()}
 */
(function() {
  'use strict';

  // Prevent multiple loads
  if (window.witzoWidgetLoaded) {
    console.warn('Witzo Widget: Already loaded on this page');
    return;
  }
  window.witzoWidgetLoaded = true;

  // Wait for DOM to be ready
  function initWidget() {
    try {
      // Create widget element
      const widget = document.createElement('witzo-chat');
      widget.id = 'witzoChat';
      widget.setAttribute('api-url', '${apiUrl}/api/v1/webhook');
      widget.setAttribute('widget-key', '${widgetKey}');
      widget.setAttribute('api-base-url', '${apiUrl}');
      widget.setAttribute('plan-type', '${planType}');

      // Apply custom configuration
${configAttrs}

      // Append to body
      document.body.appendChild(widget);

      // Load the widget component library
      const script = document.createElement('script');
      script.src = '${widgetScriptUrl}';
      script.onerror = function() {
        console.error('Witzo Widget: Failed to load widget component library from ${widgetScriptUrl}');
      };
      document.head.appendChild(script);

      console.log('Witzo Widget: Initialized successfully');
    } catch (error) {
      console.error('Witzo Widget: Initialization error', error);
    }
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget);
  } else {
    initWidget();
  }
})();
`;

		// Track widget load event
		await widgetService.trackWidgetEvent(
			widgetKey,
			"embed_script_loaded",
			{},
			{
				ipAddress: req.ip,
				userAgent: req.get("user-agent"),
				refererUrl: req.get("referer"),
			},
		);

		res.setHeader(
			"Content-Type",
			"application/javascript",
		);
		res.setHeader(
			"Cache-Control",
			"public, max-age=3600",
		); // Cache for 1 hour
		res.setHeader(
			"Access-Control-Allow-Origin",
			"*",
		); // Allow cross-origin
		res.send(script);
	} catch (error) {
		logger.error(
			"Error generating embed script",
			{ error },
		);
		res.setHeader(
			"Content-Type",
			"application/javascript",
		);
		res
			.status(500)
			.send(
				`console.error('Witzo Widget Error: Failed to generate embed script');`,
			);
	}
};

/**
 * Generate embed code for widget
 */
function generateEmbedCode(
	widgetKey: string,
	config: any,
): string {
	const { apiUrl, widgetScriptUrl } =
		getWidgetPublicUrls(widgetKey);

	// Build config attributes
	const configAttrs = Object.entries(config)
		.map(([key, value]) => {
			// Convert camelCase to kebab-case
			const kebabKey = key
				.replace(/([A-Z])/g, "-$1")
				.toLowerCase();

			if (typeof value === "boolean") {
				return `${kebabKey}="${value}"`;
			}
			if (typeof value === "string") {
				return `${kebabKey}="${value.replace(/"/g, "&quot;")}"`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n      ");

	// Return both options: single-script and manual embed
	return `<!-- Witzo Chat Widget - Single Script (Recommended) -->
<script src="${apiUrl}/api/v1/embed/${widgetKey}.js"></script>

<!-- OR Manual Embed -->
<!--
<witzo-chat
      id="witzoChat"
      api-url="${apiUrl}/api/v1/webhook"
      widget-key="${widgetKey}"
      ${configAttrs}
    ></witzo-chat>
<script src="${widgetScriptUrl}" type="module"></script>
-->`;
}

function getWidgetPublicUrls(widgetKey: string): {
	apiUrl: string;
	widgetScriptUrl: string;
	embedScriptUrl: string;
} {
	const apiUrl =
		process.env.WIDGET_API_URL ||
		"http://localhost:3008";
	const widgetScriptUrl =
		process.env.WIDGET_SCRIPT_URL ||
		`${apiUrl}/widget/witzo-chat.js`;
	const embedScriptUrl = `${apiUrl}/api/v1/embed/${widgetKey}.js`;

	return {
		apiUrl,
		widgetScriptUrl,
		embedScriptUrl,
	};
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
	try {
		const urlObj = new URL(url);
		return urlObj.hostname.toLowerCase();
	} catch {
		return "";
	}
}
