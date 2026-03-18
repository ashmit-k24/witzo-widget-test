import {
	NextFunction,
	Request,
	Response,
} from "express";
import { config } from "../config/env";
import { chatService } from "../services/chatService";
import { leadService } from "../services/leadService";
import usageTrackingService from "../services/usageTrackingService";
import { widgetIconStorageService } from "../services/widgetIconStorageService";
import widgetService, {
	WidgetKey,
} from "../services/widgetService";
import logger from "../utils/logger";

function joinPublicUrl(
	baseUrl: string,
	path: string,
): string {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function buildWidgetResponse(
	req: Request,
	widgetKey: WidgetKey,
) {
	const publicUrls = getWidgetPublicUrls(
		widgetKey.widget_key,
	);
	const previewOriginToken =
		getPreviewOriginToken(
			req,
			widgetKey.widget_key,
		);
	const installation =
		await widgetService.getWidgetInstallationStatus(
			widgetKey,
		);

	return {
		widgetKey: widgetKey.widget_key,
		widgetName: widgetKey.widget_name,
		isActive: widgetKey.is_active,
		allowedDomains:
			widgetKey.allowed_domains || [],
		widgetConfig: widgetKey.widget_config,
		apiBaseUrl: publicUrls.apiUrl,
		embedScriptUrl:
			publicUrls.embedScriptUrl,
		widgetScriptUrl:
			publicUrls.widgetScriptUrl,
		previewOriginToken,
		embedCode: generateEmbedCode(
			widgetKey.widget_key,
			widgetKey.widget_config,
		),
		...installation,
	};
}

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
		const userId = req.user?.id;
		if (!userId) {
			res.status(401).json({ success: false, message: "Authentication required" });
			return;
		}
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

		res.status(201).json({
			success: true,
			data: await buildWidgetResponse(
				req,
				widgetKey,
			),
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
		const userId = req.user?.id;
		if (!userId) {
			res.status(401).json({ success: false, message: "Authentication required" });
			return;
		}

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

		res.status(200).json({
			success: true,
			data: await buildWidgetResponse(
				req,
				widgetKey,
			),
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
		const userId = req.user?.id;
		if (!userId) {
			res.status(401).json({ success: false, message: "Authentication required" });
			return;
		}
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
		res.status(200).json({
			success: true,
			data: await buildWidgetResponse(
				req,
				updatedWidget,
			),
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
		const userId = req.user?.id;
		if (!userId) {
			res.status(401).json({ success: false, message: "Authentication required" });
			return;
		}

		const newWidget =
			await widgetService.regenerateWidgetKey(
				userId,
			);
		await widgetService.trackWidgetEventImmediate(
			newWidget.widget_key,
			"widget_key_regenerated",
			{},
			{
				ipAddress: req.ip,
				userAgent: req.get("user-agent"),
			},
		);

		res.status(200).json({
			success: true,
			data: await buildWidgetResponse(
				req,
				newWidget,
			),
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
		const userId = req.user?.id;
		if (!userId) {
			res.status(401).json({ success: false, message: "Authentication required" });
			return;
		}

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
		const userId = req.user?.id;
		if (!userId) {
			res.status(401).json({ success: false, message: "Authentication required" });
			return;
		}
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
 * @route   POST /api/auth/widget/icon/upload
 * @desc    Upload a widget icon image for the authenticated user
 * @access  Protected
 */
export const uploadWidgetIcon = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = req.user?.id;
		if (!userId) {
			res.status(401).json({ success: false, message: "Authentication required" });
			return;
		}

		if (!req.file || !req.file.buffer) {
			res.status(400).json({ success: false, message: "No icon image uploaded" });
			return;
		}

		const contentType = req.file.mimetype || "image/png";
		const uploadResult = await widgetIconStorageService.uploadWidgetIcon({
			userId,
			buffer: req.file.buffer,
			contentType,
		});

		res.status(200).json({
			success: true,
			message: "Widget icon uploaded successfully",
			data: {
				url: uploadResult.url,
				key: uploadResult.key,
				contentType,
				size: req.file.size,
			},
		});
	} catch (error) {
		logger.error("Error uploading widget icon", { error });
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
		const originToken =
			getOriginTokenHeader(req);

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
		const originToken =
			getOriginTokenHeader(req);

		// Verify widget key and get userId
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
		const visitorId =
			typeof sessionId === "string" &&
			sessionId.trim()
				? sessionId
				: undefined;

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
				await chatService.attachConversationContext(
					result.sessionId,
					userId,
					{
						widgetKeyId: widget.id,
						visitorId:
							visitorId ||
							result.sessionId,
					},
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
		await chatService.attachConversationContext(
			result.sessionId,
			userId,
			{
				widgetKeyId: widget.id,
				visitorId:
					visitorId || result.sessionId,
			},
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
		const originToken =
			getOriginTokenHeader(req);

		const verification =
			await widgetService.verifyWidgetKey(
				widgetKey,
				refererDomain,
				originToken,
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
		const runtimeOriginToken =
			refererDomain
				? widgetService.createOriginToken(
						widgetKey,
						refererDomain,
				  )
				: null;

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
			introHelpOptionOneText:    "intro-help-option-one-text",
			introHelpOptionOneUrl:     "intro-help-option-one-url",
			introHelpOptionTwoText:    "intro-help-option-two-text",
			introHelpOptionTwoUrl:     "intro-help-option-two-url",
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
			showQuickOptions:          "show-quick-options",
			showIntroScreen:           "show-intro-screen",
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

  function mountWidget() {
    try {
      if (document.getElementById('witzoChat')) {
        return;
      }

      const widget = document.createElement('witzo-chat');
      widget.id = 'witzoChat';
      widget.setAttribute('api-url', '${joinPublicUrl(apiUrl, "/api/v1/webhook")}');
      widget.setAttribute('widget-key', '${widgetKey}');
      widget.setAttribute('api-base-url', '${apiUrl}');
      widget.__witzoPlanType = '${planType}';
      ${
				runtimeOriginToken
					? `widget.setAttribute('origin-token', '${runtimeOriginToken}');`
					: ""
			}

      // Apply custom configuration
${configAttrs}

      document.body.appendChild(widget);
      console.log('Witzo Widget: Initialized successfully');
    } catch (error) {
      console.error('Witzo Widget: Initialization error', error);
    }
  }

  function initWidget() {
    if (window.customElements && window.customElements.get('witzo-chat')) {
      mountWidget();
      return;
    }

    const existingScript = document.querySelector('script[data-witzo-widget-lib="true"]');
    if (existingScript) {
      existingScript.addEventListener('load', mountWidget, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = '${widgetScriptUrl}';
    script.async = true;
    script.dataset.witzoWidgetLib = 'true';
    script.onload = mountWidget;
    script.onerror = function() {
      console.error('Witzo Widget: Failed to load widget component library from ${widgetScriptUrl}');
    };
    document.head.appendChild(script);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget, { once: true });
  } else {
    initWidget();
  }
})();
`;

		// Track widget load event immediately so installation status updates without analytics flush lag.
		await widgetService.trackWidgetEventImmediate(
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
		res.setHeader("Cache-Control", "no-store, must-revalidate");
		res.setHeader("Pragma", "no-cache");
		res.setHeader("Expires", "0");
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
		introHelpOptionOneText:    "intro-help-option-one-text",
		introHelpOptionOneUrl:     "intro-help-option-one-url",
		introHelpOptionTwoText:    "intro-help-option-two-text",
		introHelpOptionTwoUrl:     "intro-help-option-two-url",
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
		showQuickOptions:          "show-quick-options",
		showIntroScreen:           "show-intro-screen",
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
<script src="${joinPublicUrl(apiUrl, `/api/v1/embed/${widgetKey}.js`)}"></script>

<!-- OR Manual Embed -->
<!--
<witzo-chat
      id="witzoChat"
      api-url="${joinPublicUrl(apiUrl, "/api/v1/webhook")}"
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
	const embedScriptUrl = joinPublicUrl(
		apiUrl,
		`/api/v1/embed/${widgetKey}.js`,
	);

	return {
		apiUrl,
		widgetScriptUrl,
		embedScriptUrl,
	};
}

function getOriginTokenHeader(
	req: Request,
): string | undefined {
	const token = req.get(
		"x-witzo-origin-token",
	);
	return token?.trim() || undefined;
}

function getPreviewOriginToken(
	req: Request,
	widgetKey: string,
): string | undefined {
	if (!widgetKey) {
		return undefined;
	}

	const previewOrigin =
		req.get("origin") ||
		req.get("referer") ||
		config.FRONTEND_URL;
	const previewDomain =
		extractDomain(previewOrigin);

	return previewDomain
		? widgetService.createOriginToken(
				widgetKey,
				previewDomain,
		  )
		: undefined;
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
