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
			data: {
				widgetKey: widgetKey.widget_key,
				widgetName: widgetKey.widget_name,
				isActive: widgetKey.is_active,
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
			data: {
				widgetKey: newWidget.widget_key,
				widgetName: newWidget.widget_name,
				isActive: newWidget.is_active,
				allowedDomains: newWidget.allowed_domains,
				widgetConfig: newWidget.widget_config,
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
		const {
			widgetKey,
			message,
			sessionId,
			language,
		} =
			req.body;
		const streamRequested =
			req.query.stream === "1" ||
			(req.get("accept") || "").includes(
				"text/event-stream",
			);

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

		const widgetDefaultLanguage =
			typeof widget.widget_config
				?.defaultLanguage ===
			"string"
				? widget.widget_config.defaultLanguage
				: undefined;
		const resolvedLanguage =
			typeof language === "string" &&
			language.trim()
				? language
				: widgetDefaultLanguage;

		const trackMeta = {
			ipAddress: req.ip,
			userAgent: req.get("user-agent"),
			refererUrl: referer,
		};

		// Atomically check AND increment the conversation counter in one query,
		// eliminating the TOCTOU race that existed with the old canUserChat() +
		// trackConversation() two-step pattern.
		const { allowed, usage } =
			await usageTrackingService.checkAndTrackConversation(
				userId,
			);

		if (!allowed) {
			// Fetch current stats (read-only, no increment) for the error body
			const currentUsage =
				await usageTrackingService.getUserUsage(
					userId,
				);

			logger.warn(
				"Widget user exceeded conversation limit",
				{
					userId,
					widgetKey,
					conversationsUsed:
						currentUsage.conversationsUsed,
					conversationsLimit:
						currentUsage.conversationsLimit,
				},
			);

			res.status(403).json({
				success: false,
				message:
					"You've reached your conversation limit for this month. Please upgrade your plan to continue chatting.",
				limitReached: true,
				data: {
					planType: currentUsage.planType,
					conversationsUsed:
						currentUsage.conversationsUsed,
					conversationsLimit:
						currentUsage.conversationsLimit,
					resetDate: currentUsage.resetDate,
				},
			});
			return;
		}

		// Non-critical analytics write is intentionally decoupled from request latency.
		void widgetService
			.trackWidgetEvent(
				widgetKey,
				"message_sent",
				{ message: message.substring(0, 100) },
				trackMeta,
			)
			.catch(() => {});

		if (streamRequested) {
			res.status(200);
			res.setHeader(
				"Content-Type",
				"text/event-stream",
			);
			res.setHeader(
				"Cache-Control",
				"no-cache, no-transform",
			);
			res.setHeader(
				"Connection",
				"keep-alive",
			);
			res.flushHeaders?.();

			const writeEvent = (
				payload: Record<string, any>,
			) => {
				res.write(
					`data: ${JSON.stringify(payload)}\n\n`,
				);
			};

			let result:
				| Awaited<
						ReturnType<
							typeof chatService.chatStream
						>
				  >
				| undefined;
			try {
				result = await chatService.chatStream(
					userId,
					message,
					sessionId,
					{
						onToken: (token) =>
							writeEvent({
								type: "token",
								token,
							}),
					},
					resolvedLanguage,
				);

				// usage came from checkAndTrackConversation — no extra DB query needed
				writeEvent({
					type: "done",
					sessionId: result.sessionId,
					language: result.language,
					usage: {
						conversationsRemaining:
							usage!.conversationsRemaining,
						resetDate: usage!.resetDate,
					},
				});
			} catch (streamError) {
				logger.error(
					"Error in webhook stream chat",
					{ streamError },
				);
				writeEvent({
					type: "error",
					message:
						"Temporary issue while generating response",
				});
			} finally {
				res.end();

				if (result) {
					void (async () => {
						try {
							const session =
								await chatService.getSession(
									result!.sessionId,
								);
							if (
								session &&
								session.messages.length >= 2
							) {
								await leadService.extractAndUpsertLead(
									userId,
									result!.sessionId,
									widget?.id ?? 0,
									session.messages,
									{
										ipAddress:
											req.ip,
										sourceUrl:
											referer,
									},
									usage!.planType,
								);
							}
						} catch {
							// Non-critical side effects
						}
					})();
				}
			}
			return;
		}

		const result = await chatService.chat(
			userId,
			message,
			sessionId,
			resolvedLanguage,
		);

		// Queue non-critical writes out of request path
		void (async () => {
			try {
				const session =
					await chatService.getSession(
						result.sessionId,
					);
				if (
					session &&
					session.messages.length >= 2
				) {
					await leadService.extractAndUpsertLead(
						userId,
						result.sessionId,
						widget?.id ?? 0,
						session.messages,
						{
							ipAddress: req.ip,
							sourceUrl: referer,
						},
						usage!.planType,
					);
				}
			} catch {
				// Non-critical side effects
			}
		})();

		// usage came from checkAndTrackConversation — no extra DB query needed
		res.status(200).json({
			success: true,
			sessionId: result.sessionId,
			response: result.response,
			language: result.language,
			usage: {
				conversationsRemaining:
					usage!.conversationsRemaining,
				resetDate: usage!.resetDate,
			},
			warning: usage!.isApproachingLimit
				? "You're approaching your monthly conversation limit"
				: undefined,
		});
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

		// Explicit mapping from WidgetConfig camelCase keys → witzo-chat HTML attribute names.
		// primaryColor fans out to three attributes (banner-color, floating-btn, user-chat-color).
		const WIDGET_ATTR_MAP: Record<string, string | string[]> = {
			// Content / text
			headerTitle:               "header-title",
			welcomeMessage:            "welcome-message",
			placeholderText:           "input-placeholder",
			logoIcon:                  "header-logo-url",
			bubbleIcon:                "launcher-icon-url",
			introTitle:                "intro-title",
			introMessage:              "intro-message",
			introPrimaryButtonText:    "intro-primary-button-text",
			introSecondaryButtonText:  "intro-secondary-button-text",
			// Colors
			primaryColor:              ["header-background-color", "user-message-color"],
			bannerColor:               "header-background-color",
			userChatColor:             "user-message-color",
			accentColor:               "send-button-color",
			sendColor:                 "send-button-color",
			floatingBtnColor:          "launcher-color",
			floatingBtn:               "launcher-color",
			bannerTextColor:           "header-title-color",
			closeButtonColor:          "close-button-color",
			botColor:                  "bot-color",
			introPrimaryButtonColor:   "intro-primary-button-background-color",
			introSecondaryButtonColor: "intro-secondary-button-background-color",
			introPrimaryButtonBackgroundColor:
				"intro-primary-button-background-color",
			introSecondaryButtonBackgroundColor:
				"intro-secondary-button-background-color",
			// Layout / behavior
			floatingType:              "launcher-type",
			autoOpen:                  "auto-open",
			// Language
			defaultLanguage:           "default-language",
		};

		// Build config attributes for the widget element
		const configLines: string[] = [];
		Object.entries(config).forEach(([key, value]) => {
			const mapping = WIDGET_ATTR_MAP[key];
			if (!mapping) return;

			let attrValue: string;
			if (typeof value === "boolean") {
				attrValue = String(value);
			} else if (typeof value === "string" && value) {
				attrValue = value
					.replace(/'/g, "\\'")
					.replace(/\n/g, "\\n");
			} else if (typeof value === "number") {
				attrValue = String(value);
			} else {
				return;
			}

			const attrNames = Array.isArray(mapping) ? mapping : [mapping];
			attrNames.forEach((attr) => {
				configLines.push(`  widget.setAttribute('${attr}', '${attrValue}');`);
			});
		});
		const configAttrs = configLines.join("\n");

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
      widget.__witzoPlanType = '${planType}';

      // Apply custom configuration
${configAttrs}
      // Always open widget to show the intro screen first
      widget.setAttribute('auto-open', 'true');

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

	const MANUAL_ATTR_MAP: Record<
		string,
		string | string[]
	> = {
		headerTitle:               "header-title",
		welcomeMessage:            "welcome-message",
		placeholderText:           "input-placeholder",
		logoIcon:                  "header-logo-url",
		bubbleIcon:                "launcher-icon-url",
		introTitle:                "intro-title",
		introMessage:              "intro-message",
		introPrimaryButtonText:    "intro-primary-button-text",
		introSecondaryButtonText:  "intro-secondary-button-text",
		primaryColor:              ["header-background-color", "user-message-color"],
		bannerColor:               "header-background-color",
		userChatColor:             "user-message-color",
		accentColor:               "send-button-color",
		sendColor:                 "send-button-color",
		floatingBtnColor:          "launcher-color",
		floatingBtn:               "launcher-color",
		bannerTextColor:           "header-title-color",
		closeButtonColor:          "close-button-color",
		botColor:                  "bot-color",
		introPrimaryButtonColor:   "intro-primary-button-background-color",
		introSecondaryButtonColor: "intro-secondary-button-background-color",
		introPrimaryButtonBackgroundColor:
			"intro-primary-button-background-color",
		introSecondaryButtonBackgroundColor:
			"intro-secondary-button-background-color",
		floatingType:              "launcher-type",
		autoOpen:                  "auto-open",
		defaultLanguage:           "default-language",
	};

	const configLines: string[] = [];
	Object.entries(config || {}).forEach(
		([key, value]) => {
			const mapping = MANUAL_ATTR_MAP[key];
			if (!mapping) return;

			let attrValue: string | null = null;
			if (typeof value === "boolean") {
				attrValue = String(value);
			} else if (
				typeof value === "string" &&
				value
			) {
				attrValue = value.replace(
					/"/g,
					"&quot;",
				);
			} else if (typeof value === "number") {
				attrValue = String(value);
			}
			if (!attrValue) return;

			const attrs = Array.isArray(mapping)
				? mapping
				: [mapping];
			attrs.forEach((attr) => {
				configLines.push(
					`${attr}="${attrValue}"`,
				);
			});
		},
	);
	const configAttrs = configLines.join(
		"\n      ",
	);

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
