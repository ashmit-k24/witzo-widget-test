/**
 * Witzo Chat Widget - Standalone Version
 * Updated to match text-widget design
 */
(function () {
	"use strict";

	// Helper: Sanitize URL
	function sanitizeURL(url) {
		if (!url) return "";
		// Allow http, https, mailto, tel protocols
		if (/^(https?|mailto|tel):/i.test(url))
			return url;
		return "";
	}
	function appendSources(wrapper, sources) {
		if (
			!Array.isArray(sources) ||
			sources.length === 0
		)
			return;
		const seen = new Set();
		const unique = [];
		for (const s of sources) {
			const url = sanitizeURL(
				String(s.url || "").trim(),
			);
			if (!url || seen.has(url)) continue;
			seen.add(url);
			unique.push({
				url,
				title:
					String(s.title || url).trim() || url,
			});
			if (unique.length >= 5) break;
		}
		if (unique.length === 0) return;
		const block = document.createElement("div");
		block.style.cssText =
			"margin-top:5px;padding:5px 10px;font-size:11px;line-height:1.7;opacity:0.65;border-top:1px solid rgba(128,128,128,0.2);";
		const label = document.createElement("span");
		label.textContent = "Sources: ";
		label.style.fontWeight = "600";
		block.appendChild(label);
		unique.forEach((s, i) => {
			if (i > 0) {
				const sep =
					document.createElement("span");
				sep.textContent = "  ·  ";
				block.appendChild(sep);
			}
			const a = document.createElement("a");
			a.href = s.url;
			a.target = "_blank";
			a.rel = "noopener noreferrer";
			a.textContent = s.title;
			a.style.cssText =
				"color:inherit;text-decoration:underline;text-underline-offset:2px;word-break:break-all;";
			block.appendChild(a);
		});
		wrapper.appendChild(block);
	}

	// Helper: Sanitize HTML (simple version)
	function sanitizeHTML(str) {
		const div = document.createElement("div");
		div.textContent = str;
		return div.innerHTML;
	}

	// Define the custom element
	class WitzoChatWidget extends HTMLElement {
		constructor() {
			super();
			this.attachShadow({ mode: "open" });

			// Properties
			this.apiUrl = "";
			this.apiBaseUrl = "";
			this.widgetKey = "";
			this.originToken = "";
			this.sessionId = "";
			this.isOpen = false;
			this.hasStartedChat = false;
			this.successfulChatCount = 0;
			this.userMessageCount = 0;
			this.botMessageCount = 0;
			this.pendingEndIntentRating = false;
			this.ratingShown = false;
			this.ratingSubmitted = false;
			this._wasEndIntent = false;
			this._idleTimer = null;
			this._pendingHopeBanner = false;
			this._ratingToastTimer = null;
			this.selectedLanguage = "en";
			this.isExpanded = false;
			this.date = new Date();
			this._cfBound = false;
			this._introAnimResetTimer = null;
			this.isEmbeddedPreview = false;
			this.isAwaitingResponse = false;
			this._calendlyAssetPromise = null;
			this._calendlyMessageHandler = null;
			this._calendlyBookingActive = false;
			this._leadFormCompleted = false;
			this._leadFormStatusChecking = false;
			this._messageFeedbackReasons = [
				"Incorrect",
				"Not helpful",
				"Too long",
				"Incomplete",
				"Slow",
				"Tell us more",
			];

			this.elements = {};
			this.supportedLanguages = [
				{ code: "en", label: "English" },
				{ code: "es", label: "Spanish" },
				{ code: "fr", label: "French" },
				{ code: "de", label: "German" },
				{ code: "hi", label: "Hindi" },
				{ code: "ar", label: "Arabic" },
				{ code: "pt", label: "Portuguese" },
				{ code: "ru", label: "Russian" },
				{ code: "ja", label: "Japanese" },
				{ code: "zh", label: "Chinese" },
				{ code: "it", label: "Italian" },
				{ code: "nl", label: "Dutch" },
				{ code: "ko", label: "Korean" },
				{ code: "tr", label: "Turkish" },
				{ code: "pl", label: "Polish" },
			];

			// Configuration with defaults (matching text-widget types)
			this.config = {
				primaryText: null,
				botColor: "#fc0e3f",
				sendColor: "#fc0e3f",
				floatingBtnColor: "#fc0e3f",
				floatingBtn: "#fc0e3f",
				floatingType: "small",
				autoOpen: false,
				bannerText: "Text Chat",
				bannerTextColor: "",
				bannerColor: "#120b14",
				userChatColor: "#d01137ff",
				closeButtonColor: "",
				logoIcon: null,
				bubbleIcon: null,
				showIntroScreen: false,
				planType: "free",
				defaultLanguage: "en",
				placeholderText: null,
				leadFormEnabled: false,
				leadFormButtonText: "Fill the form to continue chat",
				leadFormNameEnabled: true,
				leadFormEmailEnabled: true,
				leadFormPhoneEnabled: true,
				leadFormCountryEnabled: true,
				leadFormTriggerMessageCount: 5,
			};
		}

		connectedCallback() {
			// Initialize Session
			this.initializeSession();

			// Read attributes
			this.apiUrl =
				this.getAttribute("api-url") || "";
			this.apiBaseUrl =
				this.getAttribute("api-base-url") ||
				this.apiUrl.replace(
					"/api/v1/webhook",
					"",
				);
			this.widgetKey =
				this.getAttribute("widget-key") || "";
			this._leadFormCompleted =
				sessionStorage.getItem(
					this.getLeadFormCompletedKey(),
				) === "1";
			this.originToken =
				this.getAttribute("origin-token") || "";
			this.isEmbeddedPreview =
				this.getAttribute("preview-mode") ===
				"embedded";

			// Read configuration from attributes (supports legacy + friendly aliases)
			const ATTR_TO_CONFIG_KEY = [
				["primary-text", "primaryText"],
				["welcome-message", "primaryText"],
				["bot-color", "botColor"],
				["send-color", "sendColor"],
				["send-button-color", "sendColor"],
				[
					"floating-btn-color",
					"floatingBtnColor",
				],
				["floating-btn", "floatingBtn"],
				["launcher-color", "floatingBtn"],
				["floating-type", "floatingType"],
				["launcher-type", "floatingType"],
				["auto-open", "autoOpen"],
				["banner-text", "bannerText"],
				["header-title", "bannerText"],
				["banner-text-color", "bannerTextColor"],
				["header-title-color", "bannerTextColor"],
				["banner-color", "bannerColor"],
				[
					"header-background-color",
					"bannerColor",
				],
				["user-chat-color", "userChatColor"],
				["user-message-color", "userChatColor"],
				[
					"close-button-color",
					"closeButtonColor",
				],
				["logo-icon", "logoIcon"],
				["header-logo-url", "logoIcon"],
				["bubble-icon", "bubbleIcon"],
				["launcher-icon-url", "bubbleIcon"],
				["plan-type", "planType"],
				["default-language", "defaultLanguage"],
				["placeholder-text", "placeholderText"],
				["input-placeholder", "placeholderText"],
				["intro-title", "introTitle"],
				["intro-message", "introMessage"],
				[
					"intro-help-option-one-text",
					"introHelpOptionOneText",
				],
				[
					"intro-help-option-one-url",
					"introHelpOptionOneUrl",
				],
				[
					"intro-help-option-two-text",
					"introHelpOptionTwoText",
				],
				[
					"intro-help-option-two-url",
					"introHelpOptionTwoUrl",
				],
				[
					"intro-primary-button-text",
					"introPrimaryButtonText",
				],
				[
					"intro-secondary-button-text",
					"introSecondaryButtonText",
				],
				[
					"intro-primary-button-color",
					"introPrimaryButtonColor",
				],
				[
					"intro-secondary-button-color",
					"introSecondaryButtonColor",
				],
				[
					"intro-primary-button-background-color",
					"introPrimaryButtonBackgroundColor",
				],
				[
					"intro-secondary-button-background-color",
					"introSecondaryButtonBackgroundColor",
				],
				[
					"show-quick-options",
					"showQuickOptions",
				],
				["show-intro-screen", "showIntroScreen"],
				["lead-form-enabled", "leadFormEnabled"],
				["lead-form-button-text", "leadFormButtonText"],
				["lead-form-name-enabled", "leadFormNameEnabled"],
				["lead-form-email-enabled", "leadFormEmailEnabled"],
				["lead-form-phone-enabled", "leadFormPhoneEnabled"],
				["lead-form-country-enabled", "leadFormCountryEnabled"],
				["lead-form-trigger-message-count", "leadFormTriggerMessageCount"],
			];

			ATTR_TO_CONFIG_KEY.forEach(
				([attr, configKey]) => {
					const value = this.getAttribute(attr);
					if (value === null) return;
					if (value === "true")
						this.config[configKey] = true;
					else if (value === "false")
						this.config[configKey] = false;
					else this.config[configKey] = value;
				},
			);
			if (
				!this.getAttribute("plan-type") &&
				typeof this.__witzoPlanType ===
				"string" &&
				this.__witzoPlanType
			) {
				this.config.planType =
					this.__witzoPlanType;
			}

			this.config.floatingType =
				this.normalizeFloatingType(
					this.config.floatingType,
				);
			// Intro screen is intentionally disabled so the widget opens directly to chat.
			this.config.showIntroScreen = false;

			this.initializeLanguagePreference();
			if (
				!document.getElementById(
					"witzo-fonts-preconnect",
				)
			) {
				const preconnect =
					document.createElement("link");
				preconnect.id =
					"witzo-fonts-preconnect";
				preconnect.rel = "preconnect";
				preconnect.href =
					"https://fonts.googleapis.com";
				document.head.appendChild(preconnect);
			}
			if (
				!document.getElementById(
					"witzo-fonts-preconnect-crossorigin",
				)
			) {
				const preconnectCrossorigin =
					document.createElement("link");
				preconnectCrossorigin.id =
					"witzo-fonts-preconnect-crossorigin";
				preconnectCrossorigin.rel = "preconnect";
				preconnectCrossorigin.href =
					"https://fonts.gstatic.com";
				preconnectCrossorigin.crossOrigin =
					"anonymous";
				document.head.appendChild(
					preconnectCrossorigin,
				);
			}
			if (
				!document.getElementById(
					"witzo-fonts",
				)
			) {
				const link =
					document.createElement("link");
				link.id = "witzo-fonts";
				link.rel = "stylesheet";
				link.href =
					"https://fonts.googleapis.com/css2?family=Manrope:wght@200..800&family=Plus+Jakarta+Sans:ital,wght@0,200..800;1,200..800&display=swap";
				document.head.appendChild(link);
			}
			this.render();
			this.bindEvents();
			// Track this page view for the session (fire-and-forget)
			this.trackPageView();
			this.updateSendButtonState();
			this._bindCalendlyMessageListener();


			this.hasStartedChat = true;
			this.showIntroScreen(false);

			// if (this.config.showIntroScreen === false) {
			// 	this.hasStartedChat = true;
			// }
			// this.showIntroScreen(!this.hasStartedChat);
			// Process default message
			if (this.config.primaryText) {
				setTimeout(() => {
					this.displayDefaultMessage();
				}, 500);
			}

			// Auto-open only when explicitly configured
			if (this.config.autoOpen) {
				setTimeout(
					() => {
						if (!this.isOpen) this.toggleChat();
					},
					this.isEmbeddedPreview ? 120 : 700,
				);
			}

			// Preload logo icon; only reveal the floating button once the image
			// is fully loaded so the icon is never seen mid-load.
			this._logoReady = false;
			this._floatingBtnTimerFired = false;
			const _iconUrl = this.getDisplayIconUrl();
			if (_iconUrl) {
				const _preload = new Image();
				_preload.onload = () => {
					this._logoReady = true;
					this._maybeRevealFloatingBtn();
				};
				_preload.onerror = () => {
					this._logoReady = true;
					this._maybeRevealFloatingBtn();
				};
				_preload.src = _iconUrl;
			} else {
				this._logoReady = true;
			}

			// Show floating button after delay AND once logo is ready
			setTimeout(
				() => {
					this._floatingBtnTimerFired = true;
					this._maybeRevealFloatingBtn();
				},
				this.isEmbeddedPreview ? 0 : 2000,
			);
		}

		disconnectedCallback() {
			if (this._calendlyMessageHandler) {
				window.removeEventListener(
					"message",
					this._calendlyMessageHandler,
				);
				this._calendlyMessageHandler = null;
			}
		}

		initializeSession() {
			const date = sessionStorage.getItem(
				"witzo_chat_date",
			);
			if (date) {
				this.date = new Date(date);
			} else {
				sessionStorage.setItem(
					"witzo_chat_date",
					new Date().toISOString(),
				);
			}

			const chatCount = sessionStorage.getItem(
				"witzo_chat_count",
			);
			if (chatCount)
				this.successfulChatCount =
					Number(chatCount);
			else
				sessionStorage.setItem(
					"witzo_chat_count",
					`0`,
				);

			// Session Token
			const STORAGE_KEY =
				"witzo_chat_session_token";
			let session =
				sessionStorage.getItem(STORAGE_KEY);
			if (!session) {
				// UUID Fallback
				session =
					"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
						/[xy]/g,
						(c) => {
							const r = (Math.random() * 16) | 0;
							const v =
								c === "x" ? r : (r & 0x3) | 0x8;
							return v.toString(16);
						},
					);
				sessionStorage.setItem(
					STORAGE_KEY,
					session,
				);
			}
			this.sessionId = session;
			this.ratingShown =
				this.getRatingShownState();
			this.ratingSubmitted =
				this.getRatingSubmittedState();
			this._leadFormCompleted =
				sessionStorage.getItem(
					this.getLeadFormCompletedKey(),
				) === "1";
		}

		getLeadFormCompletedKey() {
			return `witzo_chat_lead_form_completed_${this.widgetKey || "default"}_${this.sessionId}`;
		}

		setLeadFormCompletedState(value) {
			this._leadFormCompleted = Boolean(value);
			sessionStorage.setItem(
				this.getLeadFormCompletedKey(),
				value ? "1" : "0",
			);
		}

		getRatingShownKey() {
			return `witzo_chat_rating_shown_${this.sessionId}`;
		}

		getRatingSubmittedKey() {
			return `witzo_chat_rating_submitted_${this.sessionId}`;
		}

		getRatingShownState() {
			return (
				sessionStorage.getItem(
					this.getRatingShownKey(),
				) === "1"
			);
		}

		getRatingSubmittedState() {
			return (
				sessionStorage.getItem(
					this.getRatingSubmittedKey(),
				) === "1"
			);
		}

		setRatingShownState(value) {
			this.ratingShown = value;
			sessionStorage.setItem(
				this.getRatingShownKey(),
				value ? "1" : "0",
			);
		}

		setRatingSubmittedState(value) {
			this.ratingSubmitted = value;
			sessionStorage.setItem(
				this.getRatingSubmittedKey(),
				value ? "1" : "0",
			);
		}

		normalizeLanguageCode(value) {
			if (typeof value !== "string") return null;
			const normalized = value
				.trim()
				.toLowerCase();
			if (!normalized) return null;
			const isSupported =
				this.supportedLanguages.some(
					(language) =>
						language.code === normalized,
				);
			return isSupported ? normalized : null;
		}

		normalizeFloatingType(value) {
			const normalized = String(value || "small")
				.trim()
				.toLowerCase();

			if (
				normalized === "full" ||
				normalized === "full-size" ||
				normalized === "full size" ||
				normalized === "fullsize"
			) {
				// Backward compatibility: older "full" values now map to compact.
				return "compact";
			}
			if (normalized === "compact") {
				return "compact";
			}
			return "small";
		}

		getFloatingIconSvg() {
			const displayIconUrl =
				this.getDisplayIconUrl();
			if (displayIconUrl) {
				return `<img src="${displayIconUrl}" alt="icon" style="width:28px;height:28px;border-radius:50%;object-fit:cover;" />`;
			}
			return `<svg width="32" height="32" viewBox="0 0 32 26" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path fill-rule="evenodd" clip-rule="evenodd" d="M0.375 6.3125C0.375 3.27493 2.83743 0.8125 5.875 0.8125H25.8125C28.8501 0.8125 31.3125 3.27493 31.3125 6.3125V15.1743L27.5114 13.7677C27.411 13.7306 27.3319 13.6515 27.2948 13.5511L25.4689 8.6168C25.3507 8.29761 24.8993 8.29761 24.7811 8.6168L22.9552 13.5511C22.9181 13.6515 22.839 13.7306 22.7386 13.7677L17.8043 15.5936C17.4851 15.7118 17.4851 16.1632 17.8043 16.2814L22.7386 18.1073C22.839 18.1444 22.9181 18.2235 22.9552 18.3239L24.3618 22.125H18.9339C18.9202 22.1484 18.9049 22.1714 18.888 22.1939L16.3936 25.5174C16.1186 25.8838 15.5689 25.8838 15.2939 25.5174L12.7994 22.1939C12.7826 22.1714 12.7673 22.1484 12.7536 22.125H5.875C2.83743 22.125 0.375 19.6626 0.375 16.625V6.3125ZM19.1094 8.15215C19.0504 7.99255 18.8246 7.99255 18.7656 8.15215L18.4097 9.11387C18.3911 9.16405 18.3516 9.20363 18.3014 9.2222L17.3397 9.57808C17.1801 9.6371 17.1801 9.8629 17.3397 9.92192L18.3014 10.2778C18.3516 10.2964 18.3911 10.3359 18.4097 10.3861L18.7656 11.3478C18.8246 11.5074 19.0504 11.5074 19.1094 11.3478L19.4653 10.3861C19.4839 10.3359 19.5234 10.2964 19.5736 10.2778L20.5353 9.92192C20.6949 9.8629 20.6949 9.6371 20.5353 9.57808L19.5736 9.2222C19.5234 9.20363 19.4839 9.16405 19.4653 9.11387L19.1094 8.15215Z" fill="white"/>
                  </svg>`;
		}

		getFloatingTriggerMarkup() {
			const type = this.config.floatingType;
			const closeIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="11" viewBox="0 0 18 11" fill="none">
<path d="M1 1L8.64758 8.64758L16.2952 1" stroke="white" stroke-width="2" stroke-linecap="round"/>
</svg>`;
			const iconMarkup = `<span class="floating-orb"><span class="floating-orb-inner"><span class="floating-icon-chat">${this.getFloatingIconSvg()}</span><span class="floating-icon-close">${closeIconSvg}</span></span></span>`;

			if (type === "full") {
				return `
          <button class="floating-launcher floating-launcher-full hidden" id="floating-btn" aria-label="Open chat">
            <span class="floating-full-message">Hey there! ðŸ˜Š What brings you here today?</span>
            <span class="floating-full-row">
              ${iconMarkup}
              <span class="floating-full-cta">Let&apos;s Chat</span>
            </span>
          </button>
        `;
			}

			if (type === "compact") {
				return `
          <button class="floating-launcher floating-launcher-compact hidden" id="floating-btn" aria-label="Open chat">
            ${iconMarkup}
            <span class="floating-compact-label">Need<br/> Assistance ?</span>
          </button>
        `;
			}

			return `
        <button class="floating-launcher floating-launcher-small hidden" id="floating-btn" aria-label="Open chat">
          ${iconMarkup}
        </button>
      `;
		}

		getFloatingTriggerMarkup() {
			const placeholder =
				this.config.placeholderText ||
				"Type your message...";
			const chatIcon = this.getFloatingIconSvg();
			return `
        <div class="floating-launcher floating-launcher-prompt hidden" id="floating-btn">
          <button type="button" id="floatingHelpBtn" class="floating-help-pill" aria-label="Open chat">
            <span class="floating-help-pill-text">👋 Need help?</span>
          </button>
          <div class="floating-input-shell">
            <div id="floatingPromptInputWrapper" class="floating-prompt-input-wrapper is-glowing">
              <div class="chat-input-beam"></div>
              <input id="floatingPromptInput" type="text" class="floating-prompt-input" placeholder="${placeholder}" />
            </div>
            <button type="button" id="floatingPromptSend" class="floating-prompt-send" aria-label="Send message">
              <span class="floating-prompt-send-icon floating-prompt-send-icon-chat">
                ${chatIcon}
              </span>
              <span class="floating-prompt-send-icon floating-prompt-send-icon-arrow">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="11" viewBox="0 0 18 11" fill="none">
<path d="M1 1L8.64758 8.64758L16.2952 1" stroke="white" stroke-width="2" stroke-linecap="round"/>
</svg>
              </span>
            </button>
          </div>
        </div>
      `;
		}

		updateFloatingType(newType) {
			var normalizedType =
				this.normalizeFloatingType(newType);
			this.config.floatingType = normalizedType;
			var floatingBtnDiv =
				this.shadowRoot.getElementById(
					"floatingBtn",
				);
			if (!floatingBtnDiv) return;
			floatingBtnDiv.className =
				"floating floating-" + normalizedType;
			floatingBtnDiv.innerHTML =
				this.getFloatingTriggerMarkup();
			this.elements.floatingBtn =
				this.shadowRoot.getElementById(
					"floating-btn",
				);
			this.elements.floatingPromptInput =
				this.shadowRoot.getElementById(
					"floatingPromptInput",
				);
			this.elements.floatingPromptSend =
				this.shadowRoot.getElementById(
					"floatingPromptSend",
				);
			this.elements.floatingHelpBtn =
				this.shadowRoot.getElementById(
					"floatingHelpBtn",
				);
			if (!this.elements.floatingBtn) return;
			this.elements.floatingBtn.classList.remove(
				"hidden",
			);
		}

		getLanguageStorageKey() {
			return `witzo_chat_language_${this.widgetKey || "default"}`;
		}

		initializeLanguagePreference() {
			const configuredLanguage =
				this.normalizeLanguageCode(
					this.config.defaultLanguage,
				) || "en";
			const storageKey =
				this.getLanguageStorageKey();
			const storedLanguage =
				this.normalizeLanguageCode(
					sessionStorage.getItem(storageKey),
				);
			const hasConfiguredDefaultLanguageAttr =
				this.getAttribute("default-language") !==
				null;

			// Dashboard-configured default language should win on initial widget load.
			this.selectedLanguage =
				hasConfiguredDefaultLanguageAttr
					? configuredLanguage
					: storedLanguage || configuredLanguage;
			this.config.defaultLanguage =
				this.selectedLanguage;
			sessionStorage.setItem(
				storageKey,
				this.selectedLanguage,
			);

			console.log(
				this.selectedLanguage,
				"this.selectedLanguage",
			);
		}

		resetConversationRatingState() {
			this.pendingEndIntentRating = false;
			this.setRatingShownState(false);
			this.setRatingSubmittedState(false);
			this._pendingHopeBanner = false;
			this._clearHopeBannerTimer();
			if (
				this.elements &&
				this.elements.conversationRatingSlot
			) {
				this.elements.conversationRatingSlot.innerHTML =
					"";
				this.elements.conversationRatingSlot.classList.add(
					"hidden",
				);
			}
			this._hideHopeBanner();
		}

		isConversationEndMessage(text) {
			if (!text) return false;
			const normalized = String(text)
				.toLowerCase()
				.trim();
			if (!normalized) return false;

			const endPatterns = [
				/\b(thanks|thank you|thankyou|thx)\b/,
				/\b(bye|goodbye|see you|see ya|take care)\b/,
				/\b(that'?s all|thats all|done|resolved|got it)\b/,
				/\b(no thanks|no thank you|i'?m good|im good)\b/,
			];

			return endPatterns.some((pattern) =>
				pattern.test(normalized),
			);
		}

		_maybeRevealFloatingBtn() {
			if (
				!this._logoReady ||
				!this._floatingBtnTimerFired
			)
				return;
			const btn = this.elements.floatingBtn;
			if (
				!btn ||
				!btn.classList.contains("hidden")
			)
				return;
			btn.classList.remove("hidden");
			btn.classList.add("entering");
			setTimeout(
				() => btn.classList.remove("entering"),
				1300,
			);
		}

		getUnifiedIconUrl() {
			return (
				this.config.logoIcon ||
				this.config.bubbleIcon ||
				""
			);
		}

		getDefaultIconUrl() {
			if (!this.apiBaseUrl) return "";
			return `${this.apiBaseUrl.replace(/\/+$/, "")}/assets/images/witzo.png`;
		}

		getDisplayIconUrl() {
			return (
				this.getUnifiedIconUrl() ||
				this.getDefaultIconUrl()
			);
		}

		openIntroHelpLink(url) {
			const safeUrl = sanitizeURL(url);
			if (!safeUrl) return;
			const openedWindow = window.open(
				safeUrl,
				"_blank",
				"noopener,noreferrer",
			);
			if (openedWindow) {
				openedWindow.opener = null;
			}
		}

		render() {
			// Use the CSS and HTML from template.ts
			const leadFields = (this.config.leadFormEnabled
				? [
					this.config.leadFormNameEnabled !== false ? '<input id="cf-name" type="text" placeholder="Your name" />' : '',
					this.config.leadFormEmailEnabled !== false ? '<input id="cf-email" type="email" placeholder="Your email" />' : '',
					this.config.leadFormPhoneEnabled !== false ? '<input id="cf-phone" type="tel" placeholder="Phone number" />' : '',
					this.config.leadFormCountryEnabled !== false ? '<input id="cf-country" type="text" placeholder="Country" />' : '',
				]
				: [
					'<input id="cf-name" type="text" placeholder="Your name" />',
					'<input id="cf-email" type="email" placeholder="Your email *" />',
				]).filter(Boolean).join("");
			this.shadowRoot.innerHTML = `
      <link rel="preconnect" href="https://fonts.googleapis.com">
	  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@200..800&family=Plus+Jakarta+Sans:ital,wght@0,200..800;1,200..800&display=swap" rel="stylesheet">
      <style>
          *,
          ::after,
          ::before {
            box-sizing: border-box;
          }
          :host {
            --color-primary:      ${this.config.sendColor || "#fc0e3f"};
            --color-banner-bg:    ${this.config.bannerColor || "#120b14"};
            --color-user-bubble:  ${this.config.userChatColor || "#ffdde4"};
            --color-floating-btn: ${this.config.floatingBtn || this.config.floatingBtnColor || "#fc0e3f"};
            --color-bot-icon:     ${this.config.botColor || "#f1f5f9"};
            --color-close-btn:    ${this.config.closeButtonColor || "black"};
            --color-intro-primary-btn: ${this.config.introPrimaryButtonBackgroundColor || this.config.introPrimaryButtonColor || "#111827"};
            --color-intro-secondary-btn: ${this.config.introSecondaryButtonBackgroundColor || this.config.introSecondaryButtonColor || "#F5F5F7"};
			font-family: "Manrope", sans-serif;
            font-weight: 400;
            display: block;
            position: relative;
            z-index: 2147483647;
          }
          :host, :host * {
             font-family: "Manrope", sans-serif;
          }
          :host([preview-mode="embedded"]) {
            position: relative;
            width: 100%;
            height: 100%;
            overflow: hidden;
          }
          #textChatWidget {
            position: fixed;
            bottom: 6em;
            right: 2em;
            z-index: 2147483647;
            width: 400px;
    		height: 570px;
            max-width: 90vw;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            border-radius: 20px;
            overflow: hidden;
            transition:
              right 0.6s cubic-bezier(0.22, 1, 0.36, 1);
            background: #fff; /* Ensure background is white */
            will-change: width, height;
          }
          :host([preview-mode="embedded"]) #textChatWidget {
            position: absolute;
            right: 16px;
            bottom: 92px;
            width: min(27rem, calc(100% - 32px));
            max-width: calc(100% - 32px);
            max-height: calc(100% - 108px);
            min-height: 420px;
            z-index: 2;
          }
          :host([preview-mode="embedded"][launcher-type="compact"]) #textChatWidget {
            bottom: 116px;
            max-height: calc(100% - 132px);
          }
          #textChatWidget.intro-mode {
            background:#FBFBFB;
            height: 570px;
            min-height: 570px;
          }
          :host([preview-mode="embedded"]) #textChatWidget.intro-mode {
            width: min(30em, calc(100% - 32px));
          }
          #textChatWidget.intro-mode .intro-screen {
            flex: 0 0 auto;
          }
          
          #textChatWidget.intro-mode #backToIntroBtn,
          #textChatWidget.intro-mode #expandChatBtn,
          #textChatWidget.intro-mode #headerMenuBtn,
          #textChatWidget.intro-mode #headerMenuDropdown,
          #textChatWidget.intro-mode .header-online-status {
            display: none !important;
          }
          #textChatWidget.intro-mode .chat-header-identity {
            justify-content: flex-start;
            width: auto;
          }
          #textChatWidget.intro-mode .intro-screen.play-intro-anim [data-intro-anim] {
            opacity: 0;
            animation-duration: 0.55s;
            animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
            animation-fill-mode: forwards;
            animation-delay: calc(var(--fade-order, 0) * 80ms);
            will-change: transform, opacity;
          }
          #textChatWidget.intro-mode .intro-screen.play-intro-anim [data-intro-anim="fade-up"] {
            transform: translateY(14px);
            animation-name: introAnimFadeUp;
          }
          #textChatWidget.intro-mode .intro-screen.play-intro-anim [data-intro-anim="fade"] {
            transform: translateY(0);
            animation-name: introAnimFade;
          }
          #textChatWidget.intro-mode .intro-screen.play-intro-anim [data-intro-anim="scale"] {
            transform: scale(0.965);
            transform-origin: center;
            animation-name: introAnimScale;
          }
          #textChatWidget.intro-mode .intro-screen.play-intro-anim [data-intro-anim="soft"] {
            transform: translateY(8px) scale(0.985);
            transform-origin: center;
            animation-name: introAnimSoft;
          }
          @keyframes introAnimFadeUp {
            0% {
              opacity: 0;
              transform: translateY(14px);
            }
            100% {
              opacity: 1;
              transform: translateY(0);
            }
          }
          @keyframes introAnimFade {
            0% {
              opacity: 0;
            }
            100% {
              opacity: 1;
            }
          }
          @keyframes introAnimScale {
            0% {
              opacity: 0;
              transform: scale(0.965);
            }
            100% {
              opacity: 1;
              transform: scale(1);
            }
          }
          @keyframes introAnimSoft {
            0% {
              opacity: 0;
              transform: translateY(8px) scale(0.985);
            }
            100% {
              opacity: 1;
              transform: translateY(0) scale(1);
            }
          }
            .flex{
              display: flex;
              }

          .chat-widget {
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
            backdrop-filter: blur(10px);
            transform: translateY(18px) scale(0.965);
            opacity: 0;
            animation: slideUp 0.8s cubic-bezier(0.22, 1, 0.36, 1) forwards;
            transform-origin: right bottom;
            position: relative;
          }
          :host([preview-mode="embedded"]) .chat-widget {
            animation: none;
            transform: none;
            opacity: 1;
          }
          :host([preview-mode="embedded"]) .chat-widget::before {
            display: none;
          }
          
          .hidden { display: none !important; }

          @keyframes slideUp {
            0% {
              transform: translateY(18px) scale(0.5);
              opacity: 0;
            }
            100% {
              transform: translateY(0) scale(1);
              opacity: 1;
            }
          }
          @keyframes contentReveal {
            0% {
              background: #ffffff;
            }
            70% {
              background: #ffffff;
            }
            100% {
              background: #ffffff;
            }
          }

          .chat-widget.minimizing {
            opacity: 1;
            transform: translateY(0) scale(1);
            animation: slideDown 0.32s cubic-bezier(0.4, 0, 0.2, 1) forwards;
          }

          @keyframes slideDown {
            0% {
              transform: translateY(0) scale(1);
              opacity: 1;
            }
            
            100% {
              transform: translateY(16px) scale(0.9);
              opacity: 0;
            }
          }

          .chat-widget::before {
            content: '';
            position: absolute;
            inset: 0;
            background: #ffffff;
            border-radius: inherit;
            animation: overlayFade 0.42s ease-out forwards;
            pointer-events: none;
            z-index: 10;
          }

          .chat-widget.minimizing::before {
            animation: overlayMinimize 0.32s cubic-bezier(0.4, 0, 0.2, 1) forwards;
          }

          @keyframes overlayFade {
            0% {
              opacity: 1;
            }
            100% {
              opacity: 0;
              pointer-events: none;
            }
          }

          @keyframes overlayMinimize {
            0% {
              opacity: 0;
              pointer-events: auto;
            }
            100% {
              opacity: 1;
              pointer-events: auto;
            }
          }

          /* Header */
          .chat-header {
            background: var(--color-banner-bg, #120b14);
            padding: 0rem 1rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-shrink: 0;
            height: 60px; /* Fixed height for header */
            gap:20px;
            border-radius: 10px 10px 0 0;
            position: relative;
            z-index: 20;
          }
          .chat-header-left {
            display: flex;
            width: auto;
            justify-content: flex-start;
            align-items: center;
            gap: 0.75rem;
            flex: 1;
            min-width: 0;
          }
          .chat-header-identity {
            display: flex;
            align-items: center;
            gap: 6px;
            justify-content: center;
            width: 100%;
          }
          .online-ready-text {
            display: flex;
            flex-direction: column;
            gap: 4px;
			items-align: center;
          }

		  .sub-title{
			font-weight: 600;
			font-size: 11px;
			line-height: 1;
			letter-spacing: 0%;
			vertical-align: middle;
			color: white;
		  }

		  .sub-title-text{
		  	position: relative;
		  	top: -2px;
		  	left:5px
		  }
          .header-online-status {
            display: flex;
            align-items: center;
            gap: 6px;
            color: #888;
            font-size: 11px;
            line-height: 1;
          }

		  .intro-mode .header-online-dot {
			display: none !important;
		  }
          
          @keyframes onlineDotGlow {
            0% {
              box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.45);
            }
            70% {
              box-shadow: 0 0 0 7px rgba(16, 185, 129, 0);
            }
            100% {
              box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
            }
          }
          .chat-icon {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
			position: relative;
          }
          .bot-msg-chat-icon {
            margin-right: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
			color: var(--color-primary, #8B27FB);

          }
            .bot-msg-chat-icon img{
              width: 100%;
              height: 100%;
              object-fit: contain;
            box-shadow: 0px 2.4px 4.8px 0px #00000033;
            border-radius: 50%;


            }
          .chat-title,
          #banner-text {
			font-weight: 700;
			font-size: 16px;
			letter-spacing: 0;
			vertical-align: middle;
			font-family: "Plus Jakarta Sans", sans-serif !important;
			margin: 0 !important;
          }
          .chat-header-right {
            display: flex;
            align-items: center;
            position: relative;
			gap:10px
          }

		  .chat-action-row{
		  	display: flex;
            align-items: center;
            position: relative;
			gap:14px;
		  }
          .chat-action-btn {
            border: none;
   			background: #0000001e;
   			border-radius: 50%;
   			display: flex;
   			align-items: center;
   			justify-content: center;
   			cursor: pointer;
   			padding: 0;
   			transition: all 0.4s ease-in;
   			color: white;
   			width: 30px;
   			height: 30px;
          }
          .chat-action-btn.back-btn {
            margin-left: 0;
            margin-right: 0.1rem;
          }
			.chat-action-btn.back-btn svg{
            width: 24px;
			height: 24px;
          }
			.chat-action-btn:hover svg{
			opacity: 0.9
			}

          .chat-action-btn svg, .chat-action-btn path { fill: white; }
          .chat-action-btn.icon-stroke svg path {
            fill: none;
            stroke: white;
          }
          .chat-header-menu {
            position: absolute;
            top: 42px;
            right: 0;
            min-width: 188px;
            background: #fff;
            border-radius: 16px;
            box-shadow: 0 18px 40px rgba(17, 17, 17, 0.18);
            padding: 6px;
            overflow: visible;
            z-index: 12;
            transform-origin: right top;
            animation: headerMenuIn 0.22s ease-out;
          }
          .chat-header-menu-list {
            max-height: 318px;
            overflow-y: auto;
            scrollbar-width: thin;
            scrollbar-color: rgba(17, 17, 17, 0.18) transparent;
          }
          @keyframes headerMenuIn {
            0% {
              opacity: 0;
              transform: scale(0.7);
            }
            100% {
              opacity: 1;
              transform: scale(1);
            }
          }
          .chat-header-menu .chat-menu-item {
            width: 100%;
            border: none;
            background: transparent;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: flex-start;
            gap: 14px;
            padding: 6px 10px;
            cursor: pointer;
            text-align: left;
            font-size: 14px;
            line-height: 1.2;
            color: #111111;
          }
          .chat-header-menu .chat-menu-item.has-submenu {
            justify-content: space-between;
          }
          .chat-header-menu .chat-menu-item > svg {
            flex-shrink: 0;
          }
          .chat-header-menu .chat-menu-item > span:last-child {
            min-width: 0;
          }
          .chat-menu-item-main {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
            flex: 1;
          }
          .chat-menu-chevron {
            flex-shrink: 0;
          }
          .chat-header-menu .chat-menu-item:hover,
          .chat-header-menu .chat-menu-item.is-open {
            background: #f4f4f5;
          }
          .chat-menu-submenu {
            position: absolute;
            top: 0;
            right: calc(100% + 10px);
            min-width: 188px;
            max-height: 318px;
            background: #ffffff;
            border-radius: 16px;
            box-shadow: 0 18px 40px rgba(17, 17, 17, 0.18);
            padding: 6px;
            overflow-y: auto;
            scrollbar-width: thin;
            scrollbar-color: rgba(17, 17, 17, 0.18) transparent;
            opacity: 0;
            transform: translateY(8px) scale(0.96);
            transform-origin: top right;
            pointer-events: none;
            transition: opacity 0.22s ease, transform 0.22s ease;
            z-index: 13;
          }
          .chat-menu-submenu.show {
            opacity: 1;
            transform: translateY(0) scale(1);
            pointer-events: auto;
          }
          .chat-menu-language-item {
            width: 100%;
            border: none;
            background: transparent;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 14px;
            padding: 6px 10px;
            color: #111111;
            cursor: pointer;
            text-align: left;
            font-size: 14px;
            line-height: 1.2;
          }
          .chat-menu-language-item:hover {
            background: #f4f4f5;
          }
          .chat-menu-language-item.active {
            background: #f1f1f3;
          }
          
          .chat-widget.expanded {
            width: min(96vw, 555px) !important;
            max-width: min(96vw, 555px) !important;
			height: 80vh !important;
			min-height: 80vh !important;
			max-height: 80vh !important;
          }

		  .chat-widget.expanded .chat-bubble-ai,
		  .chat-widget.expanded .chat-bubble-user
		  {
		 	 max-width:490px;
		  }

		  .chat-widget.expanded.intro-mode{
		  width: 27rem !important;
		  }

          
          /* Messages Area */
          .chat-messages {
            padding: 30px 16px 16px;
            background: #fff;
            flex: 1;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 1rem;
            scrollbar-width: thin;
            scrollbar-color: #888 #f5f5f5;
            transition: all 0.6s ease-in-out;
			border-radius:20px 20px 0 0;
          }
          .chat-messages::-webkit-scrollbar {
            width: 8px;
          }
          .chat-messages::-webkit-scrollbar-track {
            background: #f5f5f5;
            border-radius: 999px;
          }
          .chat-messages::-webkit-scrollbar-thumb {
            background: #9ca3af;
            border-radius: 999px;
          }
          .chat-messages::-webkit-scrollbar-thumb:hover {
            background: #6b7280;
          }
          .chat-message { display: flex; align-items: flex-start; gap: 0.75rem; }
          .chat-message.mt-space {
            margin-top: 46px;
            transition: all 0.7s ease-in 0.3s;
          }
          .chat-message.has-feedback {
            position: relative;
          }

		  
          
          /* Bubbles */
          .chat-bubble-ai { 
            padding: 0; 
            max-width: 340px; 
			font-weight: 500;
			font-size: 13px;
			line-height: 20px;
			letter-spacing: 0%;

          }
          .chat-bubble-user {

		  	border: solid 1px #D3D3D3;
			padding:10px 16px;
            max-width: 280px;
            font-size: 14px;
            line-height: 1.3;
			    border-top-left-radius: 16px;
    		border-top-right-radius: 16px;
    		border-bottom-right-radius: 2px;
    		border-bottom-left-radius: 16px;
          }
          
          .chat-message.user {
            display: flex;
            flex-direction: row;
            gap: 0.5em;
            justify-content: flex-end;
            position: relative;
            padding-bottom: 16px;
          }
          .msg-status-tick {
            position: absolute;
            bottom: 2px;
            right: -10px;
            display: flex;
            align-items: center;
            gap: 0;
            line-height: 1;
			color: #888888c9;
          }
          .msg-status-tick svg {
            display: block;
			width: 14px;
			height: 14px;
          }
          .msg-status-tick small {
            padding-right: 3px; 
			font-size: 10px;
			padding-top: 2px;
          }

            /* Inputs */
          .chat-input {
            padding: 12px 16px 12px;
            background: #fff;
            display: flex;
            flex-direction: column;
            gap: 8px;
            overflow: visible;
          }
          .chat-input-container {
            display: flex;
            flex-direction: column;
            background: #FFFFFF;
            border: 1px solid #D3D3D3;
            border-radius: 24px;
            position: relative;
            transition: all 0.3s ease;
            z-index: 1;
          }
          
          .chat-input-container.is-glowing {
            box-shadow: 1px 0px 18px -11px #800CF4;
          }
          
          /* Beam Implementaton */
          .chat-input-beam {
            position: absolute;
            width: 80px;
            height: 4px;
            background: var(--color-banner-bg, #120b14);
            filter: blur(18px);
            border-radius: 50%;
            z-index: -1;
            pointer-events: none;
            transform: translate(-50%, -50%);
            animation: orbitBeam 4s linear infinite;
            opacity: 0;
            transition: opacity 0.6s ease;
          }

          .chat-input-container.is-glowing .chat-input-beam {
            opacity: 1;
          }

          @keyframes orbitBeam {
            0%   { top: 0%; left: 0%; transform: translate(-50%, -50%) rotate(0deg); width: 80px; }
            38%  { top: 0%; left: 100%; transform: translate(-50%, -50%) rotate(0deg); width: 80px; }
            40%  { top: 0%; left: 100%; transform: translate(-50%, -50%) rotate(90deg); width: 40px; }
            48%  { top: 100%; left: 100%; transform: translate(-50%, -50%) rotate(90deg); width: 40px; }
            50%  { top: 100%; left: 100%; transform: translate(-50%, -50%) rotate(180deg); width: 80px; }
            88%  { top: 100%; left: 0%; transform: translate(-50%, -50%) rotate(180deg); width: 80px; }
            90%  { top: 100%; left: 0%; transform: translate(-50%, -50%) rotate(270deg); width: 40px; }
            98%  { top: 0%; left: 0%; transform: translate(-50%, -50%) rotate(270deg); width: 40px; }
            100% { top: 0%; left: 0%; transform: translate(-50%, -50%) rotate(360deg); width: 80px; }
          }
          
          .chat-input-container:focus-within {
            border-color: var(--color-primary, #fc0e3f);
          }
          
          .chat-input-row {
            display: flex;
            width: 100%;
            padding: 12px 6px 0 16px;
			border-radius:24px 24px  0 0 ;
			background: white
          }

          .chat-text-input {
            flex: 1;
            background: transparent;
            border: none;
            font-size: 13px;
            outline: none;
            width: 100%;
            min-height: 28px;
            max-height: 80px;
            line-height: 20px;
            padding: 4px 2px 4px 0;
            color: #000000;
            font-family: inherit;
            resize: none;
            overflow-y: hidden;
            scrollbar-width: none;
          }
          .chat-text-input.is-scrollable {
            overflow-y: auto;
            scrollbar-width: thin;
            scrollbar-color:#D3D3D3 transparent;
          }
          .chat-text-input::-webkit-scrollbar {
            width: 3px;
          }
          .chat-text-input::-webkit-scrollbar-track {
            background: transparent;
          }
          .chat-text-input::-webkit-scrollbar-button {
            display: none !important;
            width: 0 !important;
            height: 0 !important;
          }
          .chat-text-input::-webkit-scrollbar-thumb {
            background: #D3D3D3;
            border-radius: 200px;
          }
          .chat-text-input::-webkit-scrollbar-thumb:hover {
            background: #6b7280;
          }
          .chat-text-input::placeholder {
            color: #9ca3af;
          }

          .chat-input-actions {
            display: flex;
            align-items: end;
            justify-content: space-between;
            padding: 0 16px 12px;
			background:white;
			border-radius:0 0 24px 24px;
          }

          .chat-input-left-actions {
            display: flex;
            align-items: center;
            gap: 12px;
          }

          .input-action-btn {
            background: transparent;
            border: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #9ca3af;
            transition: color 0.2s ease;
			padding:0;
          }
          .input-action-btn:hover {
            color: #6b7280;
          }
          .input-action-btn svg {
            width: 18px;
            height: 18px;
          }

		  

          .chat-send-btn {
            width: 36px;
            height: 36px;
            border: none;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #fff;
            cursor: pointer;
            background: #7E0AF5;
            padding: 0;
            transition: all 0.3s ease;
            opacity: 0.45;
          }
          .chat-send-btn:disabled {
            cursor: not-allowed;
          }
          .chat-send-btn.is-active {
            opacity: 1;
          }

          .chat-send-icon {
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .chat-send-icon svg {
            width: 18px;
            height: 18px;
          }

          /* Custom Language Dropdown (Shadcn Style) */
          .lang-dropdown {
            position: absolute;
            bottom: calc(100% + 10px);
            right: 0;
            min-width: 150px;
            background: #ffffff;
            border-radius: 0.75rem;
            border: 1px solid #e2e8f0;
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1);
            padding: 0.5rem;
            z-index: 1000;
            opacity: 0;
            transform: translateY(10px) scale(0.9);
            pointer-events: none;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            transform-origin: bottom right;
            max-height: 300px;
            overflow-y: auto;
          }
          .lang-dropdown.show {
            opacity: 1;
            transform: translateY(0) scale(1);
            pointer-events: auto;
          }
          .lang-dropdown-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.5rem 0.75rem;
            font-size: 0.82rem;
            font-weight: 500;
            color: #0f172a;
            border-radius: 0.4rem;
            cursor: pointer;
            transition: background 0.15s;
          }
          .lang-dropdown-item:hover {
            background: #f1f5f9;
          }
          .lang-dropdown-item.active {
            color: var(--color-primary, #fc0e3f);
            background: #f8fafc;
          }
          .lang-check {
            width: 14px;
            height: 14px;
            color: var(--color-primary, #fc0e3f);
            opacity: 0;
          }
          .lang-dropdown-item.active .lang-check {
            opacity: 1;
          }

          /* Webkit Browsers (Chrome, Edge, Safari) */
          .lang-dropdown::-webkit-scrollbar {
            width: 3px;
          }
          .lang-dropdown::-webkit-scrollbar-track {
            background: transparent;
          }
          .lang-dropdown::-webkit-scrollbar-thumb {
            background-color: rgba(0, 0, 0, 0.2);
            border-radius: 999px;
            transition: background-color 0.2s ease;
          }
          .lang-dropdown::-webkit-scrollbar-thumb:hover {
            background-color: rgba(0, 0, 0, 0.35);
          }

          /* Firefox */
          .lang-dropdown {
            scrollbar-width: thin;
            scrollbar-color: rgba(0, 0, 0, 0.1) transparent;
          }

          .chat-emoji-picker {
            position: absolute;
            bottom: 100%;
            left: 0;
            margin-bottom: 12px;
            background: white;
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.1);
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 4px;
            padding: 8px;
            z-index: 100;
            opacity: 0;
            visibility: hidden;
            transform: translateY(10px);
            transition: all 0.2s ease;
          }
          .chat-emoji-picker.show {
            opacity: 1;
            visibility: visible;
            transform: translateY(0);
          }
          .chat-emoji-btn {
            background: none;
            border: none;
            font-size: 20px;
            cursor: pointer;
            padding: 4px;
            border-radius: 8px;
            transition: background 0.2s;
          }
          .chat-emoji-btn:hover {
            background: #f1f5f9;
          }
          .chat-input-left-actions {
            position: relative;
          }

          .chat-main-view {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            opacity: 1;
            transform: none;
            transition: opacity 0.56s cubic-bezier(0.22, 1, 0.36, 1);
			background: var(--color-banner-bg, #471791);
            overflow: hidden;
          }

          .intro-screen {
            padding: 20px;
            background: #fff;
            display: flex;
            flex-direction: column;
            flex: 1;
            opacity: 1;
            transform: none;
            transition: opacity 0.56s cubic-bezier(0.22, 1, 0.36, 1);
          }

          .view-fade-in {
            opacity: 1;
            transform: none;
          }
          .view-fade-out {
            opacity: 0;
            transform: none;
            pointer-events: none;
          }

          .intro-message-card {
            border-radius: 14px;
            color: #111827;
            font-size: 15px;
            line-height: 1.5;
          }
		  .intro-message-card-wrapper{
			display: flex;
			align-items: start;
			gap: 10px;
		  }
		  .intro-message-card-wrapper .img-container {
			position: relative;
			width: 40px;
			height: 40px;
			flex-shrink: 0;
		  }
		  .intro-message-card-wrapper .img-container img{
			width: 40px;
			height: 40px;
			border-radius: 50%;
			object-fit: cover;
		  }
		  .intro-message-card-wrapper .img-container .online-status-dot {
			position: absolute;
			bottom: 1.5px;
			right: 1.5px;
			width: 10px;
			height: 10px;
			background: #10b981;
			border: 2px solid #fff;
			border-radius: 50%;
			z-index: 1;
		  }
		  .intro-top-section{
			box-shadow: rgba(0, 0, 0, 0.06) 0px 4px 24px;
			padding:20px;
			border-radius: 16px;
			border: 1px solid rgb(234, 234, 234);
			background: #fff;
		  }

		  .status-pill {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			background: #f5f5f786;
			border: 1px solid rgb(234, 234, 234);
			border-radius: 9999px;
			padding: 6px 12px;

		  }
		  .status-pill-dot {
			width: 6px;
			height: 6px;
			background: #10b981;
			border-radius: 50%;
		  }
		  .status-pill-text {
			font-size: 12px;
			font-weight: 500;
			color: #111;
		  }
		  .status-indicators-row {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-top: 10px;
		  }
		  .status-secondary-text {
			font-size: 12px;
			color: #888;
			font-weight: 400;
		  }

          .intro-actions {
            display: flex;
            flex-direction: column;
            gap: 10px;
			margin-top:16px;
          }

          .intro-action-btn {
            height: 44px;
            border-radius: 12px;
            border: 1px solid var(--color-intro-secondary-btn, #eaeaea);
            background: var(--color-intro-secondary-btn, #F5F5F7);
            color: #3d434c;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.3s ease;
          }

		  #introTitle{
			font-size: 13px;
			font-weight: 600;
			color: #111;
		  }
			#introMessage{
				font-size: 13px;
				font-weight: 400;
				color: #888;
				line-height: 18px;
				display: inline-block;
			}
          

          .intro-action-btn.primary {
            border-color: var(--color-intro-primary-btn, #121212);
            background: var(--color-intro-primary-btn, #121212);
            color: #fff;
          }

		  .help-links-list {
			margin-top: 10px;
			display: flex;
			flex-direction: column;
			padding-bottom: 8px;
		  }
		  .help-link-item {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: 12px 0;
			cursor: pointer;
			border-bottom: 1px solid rgb(234, 234, 234);
		  }
		  .intro-mode .chat-footer{
			position:relative;
			width:100%;
			bottom:auto;
			padding-bottom: 0;
		  }

          .chat-footer {
            display: flex;
            padding-bottom:10px;
            background: #fff;
            flex-direction: column;
            align-items: center;
            gap: 20px;
			
          }
          .bottom-nav {
            display: none;
            justify-content: center;
            gap: 48px;
            width: 100%;
          }
          .chat-widget.intro-mode .bottom-nav {
            display: flex;
          }
			.chat-widget.intro-mode .hope-banner{
				display: none;}
          .nav-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
            cursor: pointer;
            color: #888888;
            transition: all 0.2s;
            text-decoration: none;
          }
          .nav-item.active {
            color: rgb(17, 17, 17);
          }
          .nav-item svg {
            width: 22px;
            height: 22px;
          }
          .nav-label {
            font-size: 11px;
            font-weight: 500;
          }
          .nav-item.active .nav-label {
            font-weight: 600;
          }
          .powered-by {
            margin: 0;
            font-size: 11px;
            color: #818181;
            font-weight: 400;
            letter-spacing: 0.01em;
            text-align: center;
          }
          .powered-by-brand {
            color: #1F1F1F;
            text-decoration: none;
            font-weight: 700;
          }
		  .help-link-content {
			display: flex;
			align-items: center;
			gap: 12px;
		  }
		  .help-link-icon {
			font-size: 16px;
			opacity: 0.9;
			transition: opacity 0.3s ease;
		  }
		  .help-link-text {
			flex: 1 1 auto;
			min-width: 0;
			font-size: 14px;
			font-weight: 500;
			color: #111;
		  }

		  .help-link-item:hover .help-link-arrow{
		 	color: #2e2f31ff ;
			border:1px solid #a2a0a0ff;
		  }
		  .help-link-arrow {
			color: #77797eff;
			display: flex;
			align-items: center;
			transition: transform 0.3s ease;
			border:1px solid #e8e8e8;
			padding: 6px;
			border-radius: 50%;
			margin-right:2px;
			transition: all 0.3s ease;


		  }
		  .help-link-item:hover .help-link-icon {
			opacity: 1;
		  }
		  .help-link-item:hover .help-link-arrow {
			transform: translateX(-3px);
		  }

		  .intro-action-icon{
			 padding-right: 4px;
			 position: relative;
			 top: 4px; 
		  }
		.intro-action-icon.second{
			 padding-right: 3px;
			 position: relative;
			 top: 2px; 
		  }
          
          /* Floating Button */
          #floatingBtn {
            bottom: 20px;
            position: fixed;
            right: 24px;
            z-index: 2147483647;
          }
          :host([preview-mode="embedded"]) #floatingBtn {
            position: absolute;
            right: 16px;
            bottom: 16px;
            z-index: 4;
          }
          .floating-launcher {
            font-family: inherit;
            cursor: pointer;
            border: 0;
            display: flex;
            transition: transform 0.25s ease, box-shadow 0.25s ease;
          }
          .floating-launcher.widget-open {
            opacity: 1;
            pointer-events: auto;
          }
          
          .floating-launcher:focus-visible {
            outline: 2px solid var(--color-primary, #fc0e3f);
            outline-offset: 2px;
          }

          .floating-orb {
            width: 58px;
            height: 58px;
            border-radius: 9999px;
            box-shadow: 0 10px 24px rgba(0, 0, 0, 0.22);
            flex-shrink: 0;
            display: flex;
            perspective: 600px;
          }
          .floating-orb-inner {
            width: 100%;
            height: 100%;
            border-radius: inherit;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            transform-style: preserve-3d;
            transition: transform 0.45s cubic-bezier(0.4, 0, 0.2, 1);
          }
          .floating-launcher.widget-open .floating-orb-inner {
            transform: rotateY(180deg);
          }
          .floating-orb-inner svg {
            width: 20px;
            height: 20px;
          }
          .floating-orb-inner img{
			width: 100% !important;
			height: 100% !important;
			object-fit: contain;
		  }

          /* Flip animation: chat icon (front face) â†” close icon (back face) */
          .floating-icon-chat,
          .floating-icon-close {
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            backface-visibility: hidden;
            -webkit-backface-visibility: hidden;
          }
          .floating-icon-close {
            	transform: rotateY(180deg);
			    background: #161616;
    			border-radius: 50%;
		  }

          }
          .floating-icon-close svg {
            width: 30% !important;
            height: 30% !important;
          }

          /* Collapse text labels when widget is open */
          .floating-launcher.widget-open .floating-compact-label { display: none; }
          .floating-launcher-compact.widget-open { background: transparent; box-shadow: none; padding: 0; }
          .floating-launcher.widget-open .floating-full-message,
          .floating-launcher.widget-open .floating-full-cta { display: none; }
          .floating-launcher-full.widget-open { width: auto; border-radius: 9999px; background: transparent; box-shadow: none; padding: 0; }

          .floating-launcher-small {
            background: transparent;
            padding: 0;
          }

          .floating-launcher-compact {
            align-items: center;
            gap: 12px;
            border-radius: 9999px;
            background: #ffffff;
            color: #111827;
            box-shadow: 0 14px 34px rgba(0, 0, 0, 0.2);
            padding: 7px 16px 7px 7px;
          }
          .floating-compact-label {
            font-size: 16px;
            line-height: 1.1;
            font-weight: 700;
            white-space: nowrap;
            text-align: left;
          }

          .floating-launcher-full {
            width: 270px;
            border-radius: 18px;
            background: #ffffff;
            box-shadow: 0 18px 40px rgba(0, 0, 0, 0.24);
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            text-align: left;
          }
          .floating-full-message {
            color: #0f172a;
            font-size: 25px;
            font-weight: 600;
            line-height: 1.25;
          }
          .floating-full-row {
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .floating-full-row .floating-orb {
            width: 46px;
            height: 46px;
          }
          .floating-full-row .floating-orb-inner svg {
            width: 24px;
            height: 24px;
          }
          .floating-full-cta {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            border-radius: 10px;
            padding: 10px 14px;
            background: linear-gradient(90deg, #6d28d9 0%, var(--color-floating-btn, #fc0e3f) 100%);
            color: #ffffff;
            font-size: 14px;
            font-weight: 700;
            letter-spacing: 0.2px;
          }
          .floating-full-cta svg {
            width: 20px;
            height: 19px;
            flex-shrink: 0;
          }

          .floating-launcher-prompt {
            --floating-help-pill-right-rest: 70px;
            --floating-help-pill-right-typing: 0px;
            --floating-help-pill-top-space: 40px;
            position: relative;
            width: min(690px, calc(100vw - 48px));
            min-height: calc(56px + var(--floating-help-pill-top-space));
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 0;
            padding-top: var(--floating-help-pill-top-space);
            padding-right: 0;
            cursor: default;
            transition: width 0.35s ease, opacity 0.35s ease;
            transform-origin: right bottom;
          }
          .floating-launcher-prompt.widget-open {
            pointer-events: none;
          }
          .floating-launcher-prompt.widget-open .floating-help-pill {
            display: none;
          }
          .floating-launcher-prompt.is-collapsed {
            width: auto;
            min-height: 58px;
            padding-top: 0;
          }
          .floating-launcher-prompt.is-collapsed .floating-help-pill {
            display: none;
          }
          .floating-launcher-prompt.is-collapsed .floating-input-shell {
            width: 92px;
            min-height: 92px;
            padding: 0;
            border: none;
            background: transparent;
            background-image: none;
            box-shadow: none;
          }
          .floating-launcher-prompt.is-collapsed .floating-input-shell::before {
            transform: scaleX(0);
          }
          .floating-launcher-prompt.is-collapsed .floating-prompt-input {
            display: none;
          }
          .floating-launcher-prompt.is-collapsed .floating-prompt-send {
            margin: 0;
          }
          .floating-help-pill {
            position: absolute;
            top: 0;
            right: var(--floating-help-pill-right-rest);
            border: none;
            background: #ffffff;
            border-radius: 999px 999px 0 999px;
            padding: 8px 16px;
            color: #111111;
            font-size: 14px;
            font-weight: 600;
            line-height: 1;
            box-shadow: 0 10px 26px rgba(0, 0, 0, 0.14);
            cursor: pointer;
            white-space: nowrap;
            z-index: 2;
            transition: top 0.6s cubic-bezier(0.22, 1, 0.36, 1), right 0.6s cubic-bezier(0.22, 1, 0.36, 1), transform 0.6s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.6s cubic-bezier(0.22, 1, 0.36, 1);
            transform-origin: right bottom;
            will-change: transform, opacity;
          }
          .floating-help-pill-text {
            display: inline-flex;
            align-items: center;
            gap: 6px;
          }
          .floating-input-shell {
            width: 100%;
			max-width: 326px;
            position: relative;
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 0;
            border-radius: 999px;
            background: transparent;
			height: 56px;
            transition: max-width 0.6s cubic-bezier(0.22, 1, 0.36, 1), padding 0.6s cubic-bezier(0.22, 1, 0.36, 1), gap 0.6s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.6s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.6s cubic-bezier(0.22, 1, 0.36, 1);
            transform-origin: right center;
            will-change: transform, opacity;
          }
          .floating-input-shell::before {
            content: "";
            position: absolute;
            top: 0; bottom: 0; left: 0; right: 70px;
            border-radius: inherit;
            background: #ffffff;
            transition: right 1s cubic-bezier(0.22, 1, 0.36, 1);
            will-change: right;
            pointer-events: none;
          }
          .floating-input-shell::after {
            content: "";
            position: absolute;
            top: 0; bottom: 0; left: 0; right: 70px;
            border-radius: inherit;
            border: 1px solid transparent;
            opacity: 1;
            transition: right 1s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.16s ease;
            will-change: right, opacity;
            pointer-events: none;
            z-index: 2;
          }
          .floating-input-shell.input-focused::after {
            border-color: var(--color-primary, #fc0e3f);
          }
          .floating-input-shell > * {
            position: relative;
            z-index: 1;
          }
          .floating-prompt-input-wrapper {
            flex: 1;
            display: flex;
            position: relative;
            border-radius: 999px;
            transition: all 0.3s ease;
            height: 100%;
            z-index: 1;
          }
          .floating-prompt-input-wrapper.is-glowing {
            box-shadow: 1px 0px 18px -11px #800CF4;
          }
          .floating-prompt-input-wrapper.is-glowing .chat-input-beam {
            opacity: 1;
          }
          .floating-prompt-input {
            flex: 1;
            background: #ffffff;
            border: none;
            border-radius: 999px;
            color: #000000;
            line-height: 1.35;
            padding: 18px 19px;
            min-width: 0;
			font-weight: 500;
			font-size: 14px;
			line-height: 100%;
			height: 100%;
			letter-spacing: 0%;
            box-shadow: 0 12px 28px rgba(0, 0, 0, 0.12);
            transition: transform 0.75s cubic-bezier(0.22, 1, 0.36, 1), width 0.75s cubic-bezier(0.22, 1, 0.36, 1), padding 0.75s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.75s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.75s cubic-bezier(0.22, 1, 0.36, 1);
          }
          .floating-prompt-input:focus,
          .floating-prompt-input:focus-visible {
            outline: none;
            box-shadow: 0 12px 28px rgba(0, 0, 0, 0.12);
            border: none;
          }
          .floating-prompt-input::placeholder {
            color: #b7b7b7;
          }
          .floating-prompt-send {
            width: 58px;
            height: 58px;
            margin: 0;
            border: none;
            border-radius: 50%;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: transparent;
            color: #ffffff;
            cursor: pointer;
            box-shadow: none;
            position: relative;
            overflow: hidden;
            flex-shrink: 0;
            transition: background-color 0.75s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.75s cubic-bezier(0.22, 1, 0.36, 1), transform 0.75s cubic-bezier(0.22, 1, 0.36, 1);
            will-change: transform, opacity;
          }
          .floating-prompt-send-icon {
            position: absolute;
            inset: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: transform 0.75s cubic-bezier(0.22, 1, 0.36, 1);
          }
          .floating-prompt-send-icon svg {
            width: 100%;
            height: 100%;
          }
          .floating-prompt-send-icon-chat img {
            width: 100% !important;
            height: 100% !important;
            border-radius: inherit;
            object-fit: cover;
          }
          .floating-prompt-send-icon-chat svg {
            width: 100%;
            height: 100%;
          }
          .floating-launcher-prompt.is-typing .floating-prompt-send-icon-chat {
            opacity: 1;
            transform: scale(0.9);
          }
          .floating-launcher-prompt.is-typing .floating-input-shell {
            gap: 0;
            padding: 0 0 0 12px;
            background: transparent;
          }
          .floating-launcher-prompt.is-typing {
            min-height: calc(56px + var(--floating-help-pill-top-space));
            padding-top: var(--floating-help-pill-top-space);
            padding-right: 0;
          }
          .floating-launcher-prompt.is-typing .floating-help-pill {
            top: 0;
            right: var(--floating-help-pill-right-typing);
            transform: none;
          }
          .floating-launcher-prompt.is-typing .floating-input-shell::before {
            right: 0;
          }
          .floating-launcher-prompt.is-typing .floating-input-shell::after {
            right: 0;
          }
          .floating-launcher-prompt.is-typing .floating-prompt-input-wrapper {
            background: transparent;
            box-shadow: none;
          }
          .floating-launcher-prompt.is-typing .floating-prompt-input {
            background: transparent;
            box-shadow: none;
            padding-left: 8px;
            border: none;
          }
          .floating-launcher-prompt .floating-prompt-send-icon-arrow {
            opacity: 0;
            transform: scale(0.82);
          }
          .floating-launcher-prompt .floating-prompt-send-icon-arrow svg {
            width: 16px;
            height: 16px;
          }
          .floating-launcher-prompt.widget-open .floating-prompt-send {
            background: var(--color-primary, #471791);
            box-shadow: 0 14px 30px rgba(var(--color-primary, #471791), 0.3);
            pointer-events: auto;
          }
          .floating-launcher-prompt.widget-open .floating-prompt-send-icon-chat {
            opacity: 0;
            transform: scale(0.82);
          }
          .floating-launcher-prompt.widget-open .floating-prompt-send-icon-arrow {
            opacity: 1;
            transform: scale(1);
          }
          .floating-launcher-prompt.widget-open .floating-input-shell {
            background: transparent;
            box-shadow: none;
          }
          .floating-launcher-prompt.widget-open .floating-input-shell::before,
          .floating-launcher-prompt.widget-open .floating-input-shell::after {
            opacity: 0;
          }
          .floating-launcher-prompt.widget-open .floating-prompt-input-wrapper {
            opacity: 0;
            pointer-events: none;
          }

          .floating-launcher.entering {
            animation: floatingBtnIn 1.15s cubic-bezier(0.22, 1, 0.36, 1) both !important;
          }
          .floating-launcher-prompt.entering {
            pointer-events: none;
          }
          .floating-launcher-prompt.entering .floating-prompt-send {
            animation: floatingOrbIn 0.48s cubic-bezier(0.16, 1, 0.3, 1) 0.02s both;
          }
          .floating-launcher-prompt.entering .floating-prompt-send-icon-chat {
            animation: floatingOrbIconIn 0.42s cubic-bezier(0.16, 1, 0.3, 1) 0.08s both;
          }
          .floating-launcher-prompt.entering .floating-input-shell {
            animation: floatingFieldFrameIn 0.72s cubic-bezier(0.22, 1, 0.36, 1) 0.18s both;
          }
          .floating-launcher-prompt.entering .floating-input-shell::before {
            opacity: 0;
            animation: none;
            transition: none;
          }
          .floating-launcher-prompt.entering .floating-prompt-input {
            animation: floatingInputTextIn 0.66s cubic-bezier(0.22, 1, 0.36, 1) 0.34s both;
          }
          .floating-launcher-prompt.entering .floating-help-pill {
            animation: floatingHelpPillIn 0.62s cubic-bezier(0.22, 1, 0.36, 1) 0.52s both;
          }

          @keyframes floatingBtnIn {
            0% {
              opacity: 0;
              transform: translate3d(0, 18px, 0) scale(0.985);
            }
            100% {
              opacity: 1;
              transform: translate3d(0, 0, 0) scale(1);
            }
          }
          @keyframes floatingOrbIn {
            0% {
              opacity: 0;
              transform: translate3d(20px, 0, 0) scale(0.76);
              filter: blur(6px);
            }
            100% {
              opacity: 1;
              transform: translate3d(0, 0, 0) scale(1);
              filter: blur(0);
            }
          }
          @keyframes floatingOrbIconIn {
            0% {
              opacity: 0;
              transform: scale(0.78);
            }
            100% {
              opacity: 1;
              transform: scale(1);
            }
          }
          @keyframes floatingFieldFrameIn {
            0% {
              opacity: 0;
              transform: translate3d(28px, 0, 0) scaleX(0.94);
            }
            100% {
              opacity: 1;
              transform: translate3d(0, 0, 0) scaleX(1);
            }
          }
          @keyframes floatingInputTextIn {
            0% {
              opacity: 0;
              transform: translate3d(22px, 0, 0);
            }
            100% {
              opacity: 1;
              transform: translate3d(0, 0, 0);
            }
          }
          @keyframes floatingHelpPillIn {
            0% {
              opacity: 0;
              transform: translate3d(22px, -6px, 0) scale(0.96);
              filter: blur(6px);
            }
            100% {
              opacity: 1;
              transform: translate3d(0, 0, 0) scale(1);
              filter: blur(0);
            }
          }

          @media (max-width: 640px) {
            #floatingBtn {
              right: 14px;
              bottom: 14px;
            }
            #floatingBtn .floating-launcher.widget-open {
              opacity: 0 !important;
              pointer-events: none !important;
              transform: translateY(12px) scale(0.96);
            }
            #textChatWidget {
              inset: 0;
              right: auto;
              bottom: auto;
              width: 100vw;
              max-width: 100vw;
              height: 100vh;
              min-height: 100vh;
              max-height: 100vh;
              border-radius: 0;
            }
            #textChatWidget.intro-mode {
              width: 100vw;
              height: 100vh;
              min-height: 100vh;
              max-height: 100vh;
              border-radius: 0;
            }
			.chat-header{
			  border-radius: 0; 
			}
            .floating-launcher-full {
              width: 230px;
            }
            .floating-launcher-prompt {
              width: min(92vw, 460px);
              --floating-help-pill-right-rest: 52px;
              --floating-help-pill-right-typing: 0px;
              --floating-help-pill-top-space: 40px;
            }
            .floating-launcher-prompt.is-collapsed .floating-input-shell {
              width: 58px;
              min-height: 58px;
            }
            .floating-help-pill {
              padding: 8px 16px;
              font-size: 14px;
            }
            .floating-input-shell {
              min-height: 56px;
            }
            .floating-prompt-input-wrapper {
              font-size: 15px;
            }
            .floating-prompt-input {
              font-size: 15px;
              padding: 0 16px 0 20px;
            }
            .floating-prompt-send {
              width: 58px;
              height: 58px;
            }
            .chat-widget.expanded {
              inset: 0 !important;
              right: auto !important;
              width: 100vw !important;
              max-width: 100vw !important;
              height: 100vh !important;
              min-height: 100vh !important;
              max-height: 100vh !important;
              border-radius: 0 !important;
            }
			  .chat-widget.expanded.intro-mode {
              height: 100vh !important;
				
			  }

			  .intro-screen{
			  	padding:16px
			  }
            .floating-full-message {
              font-size: 16px;
            }
            .floating-compact-label {
              font-size: 14px;
            }
			.status-pill-text {
				font-size: 9px;
			}
				.floating-input-shell::before {
					transform: scaleX(0.79);
				}
          }

           @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-5px); }
          }
          
          /* Typing Indicators */
           .typing-indicator {
            display: flex;
            align-items: center;
            gap: 0.25rem;
          }
           .typing-container{
              border-radius: 50px;
              padding: 7px 15px;
              font-size: 14px;
              color: #4b4b4b;
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 3px;
              position: relative;
              height: 36px;

            }
             
           .typing-dots-text  {
            font-size: 2.5rem;
            line-height: 1;
            animation: typingBounce 2.2s infinite;
            opacity: 0;
            display: inline-block;
            position: relative;
            top: -9px;
			border-radius: 50%;
          }
           .typing-dots-text:nth-child(1) { animation-delay: 0s; }
           .typing-dots-text:nth-child(2) { animation-delay: 0.5s; }
           .typing-dots-text:nth-child(3) { animation-delay: 1s; }
           
           @keyframes typingBounce {
            0%, 100% { opacity: 0.5; transform: translateY(0); }
            50% { opacity: 1; transform: translateY(-3px); }
          }

           #logoIcon{
            width: 40px;
            height: 40px;
            border-radius: 50%;
            object-fit: cover;
            }
            .bot-message-row {
              display: flex;
              flex-direction: row;
              align-items: flex-start;
            }
            .bot-response-block {
              display: flex;
              flex-direction: column;
              align-items: flex-start;
              gap: 6px;
              position: relative;
            }
            .bot-message-row .bot-msg-chat-icon {
              flex-shrink: 0;
            }
			  .bot-message-row .md-content{
				background-color: #F1F1F1;
				padding: 10px 16px;
				border-top-left-radius: 2px;
				border-top-right-radius: 16px;
				border-bottom-right-radius: 16px;
				border-bottom-left-radius: 16px;

			  }
            .message-feedback-row {
              display: flex;
              align-items: center;
              gap: 11px;
              margin-left: 56px;
              position: relative;
              opacity: 0;
              visibility: hidden;
              pointer-events: none;
              transition: opacity 0.2s ease, transform 0.2s ease,
                visibility 0.2s ease;
				margin-top: 3px;
            }
            .bot-response-block:hover .message-feedback-row,
            .message-feedback:hover .message-feedback-row,
            .message-feedback:focus-within .message-feedback-row {
              opacity: 1;
              visibility: visible;
              pointer-events: auto;
              transform: translateY(0);
            }
            .message-feedback-btn {
              position: relative;
              width: 15px;
              height: 15px;
              border: none;
              background: transparent;
              color: #8f8f95;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              padding: 0;
              cursor: pointer;
              transition: color 0.2s ease, transform 0.2s ease;
            }
            .message-feedback-btn:hover {
              color: #111111;
              transform: translateY(-1px);
            }
            .message-feedback-btn.active {
              color: #111111;
            }
            .message-feedback-btn svg {
              width: 19px;
              height: 19px;
              stroke: currentColor;
              fill: none;
              stroke-width: 1.9;
              stroke-linecap: round;
              stroke-linejoin: round;
            }
            .message-feedback-btn.active svg path {
              fill: currentColor;
            }
            .message-feedback-tooltip {
              position: absolute;
              left: 50%;
              top: calc(100% + 8px);
              transform: translateX(-50%) translateY(-4px);
              background: #1f1f22;
              color: #ffffff;
              border-radius: 999px;
              padding: 8px 12px;
              font-size: 12px;
              line-height: 1;
              white-space: nowrap;
              opacity: 0;
              pointer-events: none;
              transition: opacity 0.18s ease, transform 0.18s ease;
              box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
              z-index: 3;
            }
            .message-feedback-btn:hover .message-feedback-tooltip,
            .message-feedback-btn:focus-visible .message-feedback-tooltip {
              opacity: 1;
              transform: translateX(-50%) translateY(0);
            }
            .message-feedback.menu-open .message-feedback-btn:hover .message-feedback-tooltip,
            .message-feedback.menu-open .message-feedback-btn:focus-visible .message-feedback-tooltip {
              opacity: 0;
              transform: translateX(-50%) translateY(-4px);
            }
            .message-feedback-menu {
              position: absolute;
              top: calc(100% + 10px);
              left: 16px;
              min-width: 188px;
              background: #ffffff;
              border-radius: 16px;
              box-shadow: 0 18px 40px rgba(17, 17, 17, 0.18);
              padding: 6px;
              opacity: 0;
              transform: translateY(8px) scale(0.96);
              transform-origin: top left;
              pointer-events: none;
              transition: opacity 0.22s ease, transform 0.22s ease;
              z-index: 4;
            }
            .message-feedback-menu.show {
              opacity: 1;
              transform: translateY(0) scale(1);
              pointer-events: auto;
            }
            .message-feedback-item {
              width: 100%;
              border: none;
              background: transparent;
              border-radius: 6px;
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 14px;
              padding: 6px 10px;
              color: #111111;
              cursor: pointer;
              text-align: left;
              font-size: 14px;
              line-height: 1.2;
            }
            .message-feedback-item:hover {
              background: #f4f4f5;
            }
            .message-feedback-item.active {
              background: #f1f1f3;
            }
            .message-feedback-item-icon {
              width: 18px;
              height: 18px;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              color: #111111;
              flex-shrink: 0;
            }
            .message-feedback-item-icon svg {
              width: 18px;
              height: 18px;
              stroke: currentColor;
              fill: none;
              stroke-width: 1.8;
              stroke-linecap: round;
              stroke-linejoin: round;
            }
            
            /* Markdown Styles inside bubbles */

			.md-content {
				line-height: 1.6;
				word-break: break-word;
			}
			.md-content strong {
				font-weight: 600;
			}
            .md-content h2,
            .md-content h3,
            .md-content h4 {
              margin: 0 0 0.55rem 0;
              color: #0f172a;
              line-height: 1.35;
              font-weight: 700;
            }
            .md-content h2 { font-size: 1rem; }
            .md-content h3 { font-size: 0.94rem; }
            .md-content h4 { font-size: 0.9rem; }
            .md-content p { margin: 0; font-weight:500; line-height: 20px }
            .md-content p + p,
            .md-content p + ul,
            .md-content p + ol,
            .md-content h2 + p,
            .md-content h2 + ul,
            .md-content h3 + p,
            .md-content h3 + ul,
            .md-content h4 + p,
            .md-content h4 + ul,
            .md-content h4 + ol,
            .md-content ul + h2,
            .md-content ul + h3,
            .md-content ul + h4,
            .md-content ol + h2,
            .md-content ol + h3,
            .md-content ol + h4 { margin-top: 0.55rem; }
            .md-content ul, .md-content ol { padding-left: 20px; margin: 0.35rem 0; }
            .md-content li { margin: 0.22rem 0; }
            .md-content a { color: #007bff; text-decoration: none; }
            .md-content a:hover { text-decoration: underline; }

            /* --- Contact Form (basic plan fallback) --- */
            .contact-form {
              padding: 1.25rem;
              display: flex;
              flex-direction: column;
              gap: 0.75rem;
              background: #fff;
              flex: 1;
              overflow-y: auto;
            }
            .contact-form h3 { margin: 0 0 0.25rem 0; font-size: 1rem; font-weight: 700; color: #0f172a; }
            .contact-form p { margin: 0 0 0.5rem 0; font-size: 0.82rem; color: #64748b; line-height: 1.5; }
            .contact-form input, .contact-form textarea {
              width: 100%;
              border: 1px solid #e2e8f0;
              border-radius: 0.5rem;
              padding: 0.6rem 0.75rem;
              font-size: 0.875rem;
              outline: none;
              font-family: inherit;
              box-sizing: border-box;
            }
            .contact-form input:focus, .contact-form textarea:focus { border-color: #3b82f6; }
            .contact-form textarea { min-height: 70px; resize: vertical; }
            .contact-form-submit {
              background: #0f172a;
              color: #fff;
              border: none;
              border-radius: 0.5rem;
              padding: 0.65rem 1rem;
              font-size: 0.875rem;
              font-weight: 600;
              cursor: pointer;
              width: 100%;
              font-family: inherit;
            }
            .contact-form-submit:disabled { opacity: 0.6; cursor: not-allowed; }
            .contact-form-success { text-align: center; font-size: 0.9rem; color: #16a34a; padding: 2rem 0; }
            .contact-form.lead-form-gate {
              flex: 0 0 auto;
              max-height: 48%;
              border-top: 1px solid #e2e8f0;
              box-shadow: 0 -18px 36px rgba(15, 23, 42, 0.08);
            }
            .chat-messages.lead-form-open {
              flex: 1 1 52%;
              min-height: 42%;
            }

            /* --- Rating Buttons (basic plan) --- */
            .rating-row {
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 0.4rem;
              padding: 0.55rem 0.75rem;
              background: #f8fafc;
              border-top: 1px solid #e2e8f0;
            }
            .rating-btn {
              background: transparent;
              border: 1px solid #e2e8f0;
              border-radius: 0.4rem;
              padding: 2px 6px;
              font-size: 0.9rem;
              cursor: pointer;
              transition: background 0.15s;
              line-height: 1.2;
            }
            .rating-btn:hover { background: #f1f5f9; }
            .rating-btn.active { background: #dbeafe; border-color: #93c5fd; }
            .rating-label { font-size: 0.7rem; color: #94a3b8; }
            .rating-feedback-toast {
              margin: 0.75rem auto 0;
              max-width: calc(100% - 1.5rem);
              padding: 0.75rem 0.95rem;
              border-radius: 0.9rem;
              font-size: 0.8rem;
              font-weight: 500;
              line-height: 1.45;
              color: #f8fafc;
              background: linear-gradient(135deg, rgba(24, 24, 27, 0.96) 0%, rgba(47, 47, 55, 0.92) 100%);
              border: 1px solid rgba(255, 255, 255, 0.09);
              box-shadow: 0 14px 32px rgba(15, 23, 42, 0.18);
              text-align: center;
              animation: ratingFeedbackIn 0.2s ease-out;
            }
            .rating-feedback-toast--up {
              border-color: rgba(34, 197, 94, 0.28);
            }
            .rating-feedback-toast--down {
              border-color: rgba(251, 191, 36, 0.3);
            }
            .rating-feedback-toast.is-hiding {
              opacity: 0;
              transform: translateY(6px);
              transition: opacity 0.2s ease, transform 0.2s ease;
            }
            @keyframes ratingFeedbackIn {
              from { opacity: 0; transform: translateY(8px); }
              to { opacity: 1; transform: translateY(0); }
            }

            /* Hope Banner */
            @keyframes hopeBannerSlideIn {
              0% {
                opacity: 0;
                transform: translateY(-15px) scaleY(0.95);
              }
              40% {
                opacity: 1;
              }
              65% {
                transform: translateY(0) scaleY(1);
              }
              85% {
                transform: translateY(-4px) scaleY(0.85);
              }
              100% {
                opacity: 1;
                transform: translateY(0) scaleY(1);
              }
            }
            @keyframes textFadeInExpand {
              0% {
                opacity: 0;
                min-width: 0;
                margin-right: 0;
              }
              50% {
                opacity: 0;
                min-width: 0;
                margin-right: 0;
              }
              100% {
                opacity: 1;
                min-width: 124px;
                margin-right: 20px;
              }
            }
            @keyframes messageSlideDown {
              0% {
                transform: translateY(-30px);
                opacity: 0;
              }
              100% {
                transform: translateY(0);
                opacity: 1;
              }
            }
            .hope-banner {
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 0;
              width:fit-content;
              left: 0;
              right: 0;
              padding: 12px 24px;
              border-radius: 0 0 25px 25px;
              background: linear-gradient(135deg, color-mix(in srgb, var(--color-banner-bg, #120b14) 5%, white) 0%, color-mix(in srgb, var(--color-primary, #350535) 15%, white) 100%);
              border: 1.5px solid transparent;
              background-clip: padding-box;
              box-shadow: inset 0 0 0 1.5px transparent;
              position: fixed;
              font-size: 0.9rem;
              font-weight: 500;
              color: #1a1a2e;
              flex-shrink: 0;
              z-index: 10;
              animation: hopeBannerSlideIn 1.6s cubic-bezier(0.68, -0.55, 0.265, 1.55) forwards;
              animation-delay: 0.3s;
              opacity: 0;
              top: 56px;
              margin: 0 auto;
            }
             
            .hope-banner.hidden {
              animation: none;
            }

            #hopeBannerUp, #hopeBannerDown {
              transition: transform 0.8s ease;
            }
            #hopeBannerDown{
              transform: translateY(2px);
            }
            .hope-banner::before {
              content: '';
              position: absolute;
              inset: 0;
              border-radius: 0 0 25px 25px;
              padding: 1.5px;
              background: linear-gradient(135deg, var(--color-banner-bg, #120b14) 0%, var(--color-primary, #350535) 100%);
              -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
              -webkit-mask-composite: xor;
              mask-composite: exclude;
              pointer-events: none;
            }
            .hope-banner-text {
              flex: 1;
              text-align: center;
              animation: textFadeInExpand 1s cubic-bezier(0.25, 0.46, 0.45, 0.94) 0.7s forwards;
              overflow: hidden;
              white-space: nowrap;
              width: 0;
            }
            .hope-banner-btns{
              display: flex;
              gap: 5px;
            }
            .hope-banner-btn {
              background: transparent;
              border: none;
              cursor: pointer;
              font-size: 1.1rem;
              padding: 0 2px;
              line-height: 1;
              transition: transform 0.15s;
              flex-shrink: 0;
              
            }

            .hope-banner-btn:hover {
             drop-shadow(0 0 4px var(--color-primary, #350535));
            }
            .hope-banner-btn.active { filter: drop-shadow(0 0 4px var(--color-primary, #350535)); }
            .hope-banner.hidden { display: none; }

      </style>

        <!-- Chat Widget Box -->
        <div id="textChatWidget" class="chat-widget hidden">
            <!-- Header -->
            <div id="chat-header" class="chat-header">
                
                <div class="chat-header-left" data-intro-anim="fade" style="--fade-order:0">
                   <div class="chat-action-row">

				   <div class="chat-icon">
                    ${this.getDisplayIconUrl()
					? `<img id="logoIcon" src="${this.getDisplayIconUrl()}" alt="Logo" />`
					: `<svg width="32" height="32" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 6C13.66 6 15 7.34 15 9C15 10.66 13.66 12 12 12C10.34 12 9 10.66 9 9C9 7.34 10.34 6 12 6ZM12 19.2C9.5 19.2 7.29 17.92 6 15.98C6.03 13.99 10 12.9 12 12.9C13.99 12.9 17.97 13.99 18 15.98C16.71 17.92 14.5 19.2 12 19.2Z"/></svg>`
				}

					  
                      </div>
                      <div class="online-ready">
                        <div class="online-ready-text">
                        <h3 id="banner-text" class="chat-title" style="color: ${this.config.bannerTextColor || "black"}">${this.config.bannerText}</h3>

						<span class="sub-title">
						<svg xmlns="http://www.w3.org/2000/svg" width="7" height="11" viewBox="0 0 7 11" fill="none">
							<path d="M6.91865 3.48495H4.67424L6.69247 0.172064C6.73424 0.101915 6.69655 0 6.62829 0H2.72122C2.69269 0 2.66518 0.0198535 2.65092 0.0529427L0.0112289 5.97591C-0.0203537 6.04606 0.0183604 6.13474 0.0815256 6.13474H1.8583L0.9475 10.8678C0.928143 10.9711 1.02391 11.0439 1.083 10.9697L6.97468 3.66628C7.02766 3.60143 6.992 3.48495 6.91865 3.48495Z" fill="url(#paint0_linear_2074_8426)"/>
							<defs>
							<linearGradient id="paint0_linear_2074_8426" x1="3.5" y1="0" x2="3.5" y2="11" gradientUnits="userSpaceOnUse">
							<stop stop-color="currentColor"/>
							<stop offset="1" stop-color="currentColor"/>
							</linearGradient>
							</defs>
						</svg>

						<span class="sub-title-text">Instant Responds</span>
						</span>
                        </div>
                      </div>
                    </div>
 						<button id="backToIntroBtn" class="chat-action-btn back-btn hidden icon-stroke" aria-label="Back to intro">
                        	<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-left h-5 w-5" aria-hidden="true"><path d="m15 18-6-6 6-6"></path>
							</svg>
                    	</button>
						
				   </div>


                <div class="chat-header-right">
                    <button id="expandChatBtn" class="chat-action-btn icon-stroke" aria-label="Expand chat">
                        	<!-- Expand Icon -->
                       		 
							<svg class="expand-icon"  xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none" >
								<path d="M10.7004 5.87891V10.7004H5.87891" stroke="black" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
								<path d="M0.699219 5.52168V0.700195H5.52071" stroke="black" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
							</svg>
                        	
							<svg  class="collapse-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="15" viewBox="0 0 14 15" fill="none"  style="display: none;">
								<path d="M7.88554 13.7007V8.8792H12.707" stroke="black" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
								<path d="M5.52344 0.699998V5.52148H0.701951" stroke="black" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
							</svg>
							
                   	</button>
                    <button id="headerMenuBtn" class="chat-action-btn icon-stroke" aria-label="Header options">
                       <svg xmlns="http://www.w3.org/2000/svg" width="17" height="4" viewBox="0 0 17 4" fill="currentColor">
							<ellipse cx="1.60714" cy="1.60722" rx="1.60714" ry="1.60714" transform="rotate(-90 1.60714 1.60722)" fill="currentColor"/>
							<circle cx="8.4375" cy="1.6875" r="1.6875" transform="rotate(-90 8.4375 1.6875)" fill="currentColor"/>
							<circle cx="15.1914" cy="1.6875" r="1.6875" transform="rotate(-90 15.1914 1.6875)" fill="currentColor"/>
						</svg>
                    </button>
                    <button id="headerCloseBtn" class="chat-action-btn icon-stroke" aria-label="Close chat">
                       <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none">
<path d="M10.6992 0.700012L0.699219 10.7M0.699219 0.700012L10.6992 10.7" stroke="white" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
                    </button>
                    <div id="headerMenuDropdown" class="chat-header-menu hidden">
                      <div class="chat-header-menu-list">
                      <button id="headerLanguageBtn" class="chat-menu-item has-submenu" type="button">
                        <span class="chat-menu-item-main">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>
                          <span>Language</span>
                        </span>
                        <svg class="chat-menu-chevron" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"></path></svg>
                      </button>
                      <button id="downloadTranscriptBtn" class="chat-menu-item" type="button">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-download-icon lucide-download"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>
                        <span>Download transcript</span>
                      </button>
                      <button id="headerHelpBtn" class="chat-menu-item" type="button">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M9.09 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg>
                        <span>Help</span>
                      </button>
                      <button id="clearConversationBtn" class="chat-menu-item" type="button">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash2 lucide-trash-2 h-4 w-4 text-muted-foreground" aria-hidden="true"><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
						</svg>
                        <span>Clear conversation</span>
                      </button>
                      </div>
                      <div id="headerLanguageMenu" class="chat-menu-submenu">
                        ${this.supportedLanguages
					.map(
						(language) => `
                          <button class="chat-menu-language-item${language.code === this.selectedLanguage ? " active" : ""}" type="button" data-code="${this.escapeHtml(language.code)}">
                            <span>${this.escapeHtml(language.label)}</span>
                          </button>`,
					)
					.join("")}
                      </div>
                    </div>
                </div>
            </div>

            <!-- Hope Banner (shown after first user message) -->
            <div id="hopeBanner" class="hope-banner hidden">
              <span class="hope-banner-text">Hope that helped!</span>
              <div class="hope-banner-btns">
                  <button class="hope-banner-btn" id="hopeBannerUp" title="Thumbs up">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="16" viewBox="0 0 18 16" fill="none">
                    <path d="M16.9591 4.98816C16.7839 4.78957 16.5684 4.63054 16.3269 4.52162C16.0855 4.41271 15.8237 4.35641 15.5588 4.35647H11.2023V3.11176C11.2023 2.28647 10.8745 1.49498 10.2909 0.911414C9.70736 0.327846 8.91587 1.59557e-07 8.09058 1.59557e-07C7.97496 -8.26176e-05 7.86161 0.0320443 7.76322 0.0927784C7.66484 0.153513 7.58532 0.240453 7.53358 0.34385L4.59452 6.22353H1.24471C0.914589 6.22353 0.597993 6.35466 0.364566 6.58809C0.131138 6.82152 0 7.13811 0 7.46823V14.3141C0 14.6442 0.131138 14.9608 0.364566 15.1942C0.597993 15.4277 0.914589 15.5588 1.24471 15.5588H14.6253C15.0801 15.559 15.5194 15.3931 15.8606 15.0923C16.2018 14.7915 16.4215 14.3764 16.4783 13.9251L17.4119 6.45691C17.445 6.19398 17.4217 5.92702 17.3436 5.67378C17.2656 5.42054 17.1345 5.18682 16.9591 4.98816ZM1.24471 7.46823H4.35647V14.3141H1.24471V7.46823ZM16.1765 6.30132L15.243 13.7696C15.224 13.92 15.1508 14.0583 15.0371 14.1586C14.9233 14.2589 14.7769 14.3142 14.6253 14.3141H5.60117V6.99291L8.45699 1.28049C8.88026 1.3652 9.2611 1.59397 9.5347 1.92785C9.8083 2.26173 9.95776 2.6801 9.95764 3.11176V4.97882C9.95764 5.14388 10.0232 5.30218 10.1399 5.41889C10.2566 5.5356 10.4149 5.60117 10.58 5.60117H15.5588C15.6471 5.60114 15.7344 5.61991 15.8149 5.65622C15.8954 5.69254 15.9673 5.74557 16.0257 5.8118C16.0841 5.87802 16.1278 5.95593 16.1538 6.04033C16.1798 6.12473 16.1875 6.2137 16.1765 6.30132Z" fill="black"/>
                  </svg>
                  </button>
                  <button class="hope-banner-btn" id="hopeBannerDown" title="Thumbs down">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="16" viewBox="0 0 18 16" fill="none">
                    <path d="M17.4119 9.10191L16.4783 1.63368C16.4215 1.18238 16.2018 0.767359 15.8606 0.466553C15.5194 0.165746 15.0801 -0.000156023 14.6253 1.10104e-07H1.24471C0.914589 1.10104e-07 0.597993 0.131138 0.364566 0.364566C0.131138 0.597993 0 0.914589 0 1.24471V8.09058C0 8.4207 0.131138 8.7373 0.364566 8.97072C0.597993 9.20415 0.914589 9.33529 1.24471 9.33529H4.59452L7.53358 15.215C7.58532 15.3184 7.66484 15.4053 7.76322 15.466C7.86161 15.5268 7.97496 15.5589 8.09058 15.5588C8.91587 15.5588 9.70736 15.231 10.2909 14.6474C10.8745 14.0638 11.2023 13.2723 11.2023 12.4471V11.2023H15.5588C15.8238 11.2024 16.0857 11.1461 16.3272 11.0372C16.5687 10.9282 16.7843 10.7691 16.9595 10.5705C17.1348 10.3718 17.2658 10.1381 17.3438 9.88488C17.4218 9.63168 17.445 9.36477 17.4119 9.10191ZM4.35647 8.09058H1.24471V1.24471H4.35647V8.09058ZM16.0256 9.74682C15.9676 9.81354 15.8958 9.86692 15.8153 9.90331C15.7347 9.9397 15.6472 9.95823 15.5588 9.95764H10.58C10.4149 9.95764 10.2566 10.0232 10.1399 10.1399C10.0232 10.2566 9.95764 10.4149 9.95764 10.58V12.4471C9.95776 12.8787 9.8083 13.2971 9.5347 13.631C9.2611 13.9648 8.88026 14.1936 8.45699 14.2783L5.60117 8.5659V1.24471H14.6253C14.7769 1.24465 14.9233 1.29995 15.0371 1.40022C15.1508 1.50049 15.224 1.63883 15.243 1.78926L16.1765 9.25749C16.1882 9.34512 16.1807 9.43422 16.1547 9.51869C16.1286 9.60316 16.0846 9.68099 16.0256 9.74682Z" fill="black"/>
                  </svg>
                  </div>
              </button>
            </div>

            <div id="introScreen" class="intro-screen">
              	<div class="intro-top-section" data-intro-anim="fade-up" style="--fade-order:1">
			  		<div class="intro-message-card-wrapper" data-intro-anim="soft" style="--fade-order:2">

						<div class="img-container">
							<img src="${this.getDisplayIconUrl() || "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 24 24' fill='%23111827'%3E%3Cpath d='M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 6C13.66 6 15 7.34 15 9C15 10.66 13.66 12 12 12C10.34 12 9 10.66 9 9C9 7.34 10.34 6 12 6ZM12 19.2C9.5 19.2 7.29 17.92 6 15.98C6.03 13.99 10 12.9 12 12.9C13.99 12.9 17.97 13.99 18 15.98C16.71 17.92 14.5 19.2 12 19.2Z'/%3E%3C/svg%3E"}" alt="Intro Image" class="intro-image">
							<span class="online-status-dot"></span>
						</div>
						<div class="intro-message-card">
              		  		<strong id="introTitle">${sanitizeHTML(this.config.introTitle || "👋Good to see you!")}</strong><br/>
              		  		<span id="introMessage">${sanitizeHTML(this.config.introMessage || "We're ready to help. Ask anything, from quick questions to complex topics.")}</span>
							
              			</div>
					</div>
					<div class="status-indicators-row">
						<div class="status-pill">
							<span class="status-pill-dot"></span>
							<span class="status-pill-text">AI-powered support</span>
						</div>
						<span class="status-secondary-text">Responds instantly</span>
					</div>

					<div class="feature-pills" data-intro-anim="fade" style="--fade-order:3">

					</div>
              		<div class="intro-actions" data-intro-anim="fade-up" style="--fade-order:4">
              		  <button id="introStartBtn" class="intro-action-btn primary" data-intro-anim="scale" style="--fade-order:5">
						<span class="intro-action-icon">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        					</svg>
						</span>
						${sanitizeHTML(this.config.introPrimaryButtonText || "Let's Chat!")}

						</button>
              		 
              		</div>
			  	</div>
				
				<div class="help-links-list${this.config.showQuickOptions === false ? " hidden" : ""}" data-intro-anim="fade-up" style="--fade-order:7">
					<div id="introHelpOptionOne" class="help-link-item" data-intro-anim="soft" style="--fade-order:8" data-url="${sanitizeHTML(sanitizeURL(this.config.introHelpOptionOneUrl) || "")}">
						<div class="help-link-content">
							<span id="introHelpOptionOneText" class="help-link-text">${sanitizeHTML(this.config.introHelpOptionOneText || "How Witzo works")}</span>
						</div>
						<span class="help-link-arrow">
							<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-right h-3.5 w-3.5" aria-hidden="true"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>
						</span>
					</div>
					<div id="introHelpOptionTwo" class="help-link-item" data-intro-anim="soft" style="--fade-order:9" data-url="${sanitizeHTML(sanitizeURL(this.config.introHelpOptionTwoUrl) || "")}">
						<div class="help-link-content">
							<span id="introHelpOptionTwoText" class="help-link-text">${sanitizeHTML(this.config.introHelpOptionTwoText || "Explore AI features")}</span>
						</div>
						<span class="help-link-arrow">
							<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-right h-3.5 w-3.5" aria-hidden="true"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>
						</span>
					</div>
				</div>
            </div>

            <div id="chatMainView" class="chat-main-view hidden">
            <!-- Messages Area -->
            <div id="textMessagesArea" class="chat-messages" data-lenis-prevent>
                <!-- Messages will be appended here -->
            </div>

            <!-- Contact Form (basic plan — shown when conversation limit hit) -->
            <div id="contactFormSlot" class="contact-form hidden">
              <h3>Get in Touch</h3>
              <p>Our team will respond as soon as possible.</p>
              ${leadFields}
              ${this.config.leadFormEnabled ? "" : '<textarea id="cf-message" placeholder="Your message"></textarea>'}
              <button class="contact-form-submit" id="cf-submit">${this.config.leadFormEnabled ? sanitizeHTML(this.config.leadFormButtonText || "Fill the form to continue chat") : "Send Message"}</button>
            </div>
            <div id="calendlySlot" class="contact-form hidden"></div>

            <!-- Conversation Rating Slot -->
            <div id="conversationRatingSlot" class="hidden"></div>

            <!-- Input Area -->
            <div class="chat-input" id="chatInputArea">
                <div class="chat-input-container">
                    <div class="chat-input-beam"></div>
                    <div class="chat-input-row">
                        <textarea id="textMessageInput" rows="1" placeholder="${this.config.placeholderText || "Type your message..."}" class="chat-text-input"></textarea>
                    </div>
                    <div class="chat-input-actions">
                        <div class="chat-input-left-actions" style="position: relative;">
                            <button type="button" class="input-action-btn" id="emojiPickerBtn" aria-label="Add emoji">
                                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none">
									<path d="M9.69922 18.7002C14.6698 18.7002 18.6992 14.6708 18.6992 9.7002C18.6992 4.72963 14.6698 0.700195 9.69922 0.700195C4.72866 0.700195 0.699219 4.72963 0.699219 9.7002C0.699219 14.6708 4.72866 18.7002 9.69922 18.7002Z" stroke="#969696" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
									<path d="M6.77872 8.48419C7.45041 8.48419 7.99493 7.93967 7.99493 7.26797C7.99493 6.59628 7.45041 6.05176 6.77872 6.05176C6.10702 6.05176 5.5625 6.59628 5.5625 7.26797C5.5625 7.93967 6.10702 8.48419 6.77872 8.48419Z" fill="#969696"/>
									<path d="M12.6186 8.48419C13.2903 8.48419 13.8348 7.93967 13.8348 7.26797C13.8348 6.59628 13.2903 6.05176 12.6186 6.05176C11.9469 6.05176 11.4023 6.59628 11.4023 7.26797C11.4023 7.93967 11.9469 8.48419 12.6186 8.48419Z" fill="#969696"/>
									<path d="M13.0689 11.8892C12.7273 12.4808 12.236 12.972 11.6444 13.3136C11.0527 13.6551 10.3816 13.8349 9.6985 13.8349C9.01537 13.8349 8.34426 13.6551 7.75264 13.3136C7.16102 12.972 6.66972 12.4808 6.32812 11.8892" stroke="#969696" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="chat-emoji-picker" id="chatEmojiPicker">
                                <button type="button" class="chat-emoji-btn">😀</button>
                                <button type="button" class="chat-emoji-btn">😂</button>
                                <button type="button" class="chat-emoji-btn">🥺</button>
                                <button type="button" class="chat-emoji-btn">😍</button>
                                <button type="button" class="chat-emoji-btn">🙏</button>
                                <button type="button" class="chat-emoji-btn">✨</button>
                                <button type="button" class="chat-emoji-btn">🔥</button>
                                <button type="button" class="chat-emoji-btn">👍</button>
                                <button type="button" class="chat-emoji-btn">😢</button>
                                <button type="button" class="chat-emoji-btn">😊</button>
                                <button type="button" class="chat-emoji-btn">🎉</button>
                                <button type="button" class="chat-emoji-btn">🤔</button>
                                <button type="button" class="chat-emoji-btn">🙌</button>
                                <button type="button" class="chat-emoji-btn">😎</button>
                                <button type="button" class="chat-emoji-btn">👀</button>
                            </div>
                        </div>
                        <button class="chat-send-btn" id="textSendButton" disabled aria-disabled="true">
                            <div class="chat-send-icon">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="17" viewBox="0 0 14 17" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M7 15V1M7 1L1 7M7 1L13 7" stroke="white"/>
                                </svg>
                            </div>
                        </button>
                    </div>
                    
                    <!-- Hidden Language Settings (preserved for logic) -->
                    <div id="langPillBtn" style="display:none"></div>
                    <div id="langDropdown" style="display:none"></div>
                </div>
            </div>
            </div> <!-- close chatMainView -->

            <div class="chat-footer">
                <div class="bottom-nav">
                    <div id="navHome" class="nav-item active">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                        <span class="nav-label">Home</span>
                    </div>
                    <div id="navChat" class="nav-item">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>
                        <span class="nav-label">Chat</span>
                    </div>
                </div>
                <h3 class="powered-by">
                Powered by <a href="https://witzo.ai/" target="_blank" rel="noopener noreferrer" class="powered-by-brand">witzo.ai</a>
                </h3>
            </div>
        </div>

        <!-- Floating Chat Button -->
        <div id="floatingBtn" class="floating floating-${this.config.floatingType}">
            ${this.getFloatingTriggerMarkup()}
        </div>
      `;

			// Cache elements
			this.elements = {
				widget: this.shadowRoot.getElementById(
					"textChatWidget",
				),
				floatingBtn:
					this.shadowRoot.getElementById(
						"floating-btn",
					),
			floatingPromptInput:
				this.shadowRoot.getElementById(
					"floatingPromptInput",
				),
			floatingInputShell:
				this.shadowRoot.querySelector(
					".floating-input-shell",
				),
			floatingPromptSend:
				this.shadowRoot.getElementById(
					"floatingPromptSend",
				),
				floatingHelpBtn:
					this.shadowRoot.getElementById(
						"floatingHelpBtn",
					),
				backBtn: this.shadowRoot.getElementById(
					"backToIntroBtn",
				),
				introScreen:
					this.shadowRoot.getElementById(
						"introScreen",
					),
				chatMainView:
					this.shadowRoot.getElementById(
						"chatMainView",
					),
				introStartBtn:
					this.shadowRoot.getElementById(
						"introStartBtn",
					),
				introBrowseBtn:
					this.shadowRoot.getElementById(
						"introBrowseBtn",
					),
				introHelpLinks: Array.from(
					this.shadowRoot.querySelectorAll(
						".help-link-item",
					),
				),
				messagesContainer:
					this.shadowRoot.getElementById(
						"textMessagesArea",
					),
				textMessageInput: this.shadowRoot.getElementById("textMessageInput"),
				emojiPickerBtn: this.shadowRoot.getElementById("emojiPickerBtn"),
				chatEmojiPicker: this.shadowRoot.getElementById("chatEmojiPicker"),
				input: this.shadowRoot.getElementById(
					"textMessageInput",
				),
				sendBtn: this.shadowRoot.getElementById(
					"textSendButton",
				),
				languageSelector:
					this.shadowRoot.getElementById(
						"languageSelector",
					),
				contactFormSlot:
					this.shadowRoot.getElementById(
						"contactFormSlot",
					),
				calendlySlot:
					this.shadowRoot.getElementById(
						"calendlySlot",
					),
				cfName:
					this.shadowRoot.getElementById(
						"cf-name",
					),
				cfEmail:
					this.shadowRoot.getElementById(
						"cf-email",
					),
				cfPhone:
					this.shadowRoot.getElementById(
						"cf-phone",
					),
				cfCountry:
					this.shadowRoot.getElementById(
						"cf-country",
					),
				cfMessage:
					this.shadowRoot.getElementById(
						"cf-message",
					),
				cfSubmit:
					this.shadowRoot.getElementById(
						"cf-submit",
					),
				chatInput: this.shadowRoot.querySelector(
					".chat-input",
				),
				chatInputContainer: this.shadowRoot.querySelector(
					".chat-input-container",
				),
				conversationRatingSlot:
					this.shadowRoot.getElementById(
						"conversationRatingSlot",
					),
				hopeBanner:
					this.shadowRoot.getElementById(
						"hopeBanner",
					),
				hopeBannerUp:
					this.shadowRoot.getElementById(
						"hopeBannerUp",
					),
				hopeBannerDown:
					this.shadowRoot.getElementById(
						"hopeBannerDown",
					),
				langPillBtn:
					this.shadowRoot.getElementById(
						"langPillBtn",
					),
				langDropdown:
					this.shadowRoot.getElementById(
						"langDropdown",
					),
				langItems:
					this.shadowRoot.querySelectorAll(
						".lang-dropdown-item",
					),
				expandChatBtn:
					this.shadowRoot.getElementById(
						"expandChatBtn",
					),
				headerMenuBtn:
					this.shadowRoot.getElementById(
						"headerMenuBtn",
					),
				headerCloseBtn:
					this.shadowRoot.getElementById(
						"headerCloseBtn",
					),
				headerMenuDropdown:
					this.shadowRoot.getElementById(
						"headerMenuDropdown",
					),
				headerLanguageBtn:
					this.shadowRoot.getElementById(
						"headerLanguageBtn",
					),
				headerLanguageMenu:
					this.shadowRoot.getElementById(
						"headerLanguageMenu",
					),
				headerLanguageItems:
					this.shadowRoot.querySelectorAll(
						".chat-menu-language-item",
					),
				headerHelpBtn:
					this.shadowRoot.getElementById(
						"headerHelpBtn",
					),
				downloadTranscriptBtn:
					this.shadowRoot.getElementById(
						"downloadTranscriptBtn",
					),
				clearConversationBtn:
					this.shadowRoot.getElementById(
						"clearConversationBtn",
					),
				navHome:
					this.shadowRoot.getElementById(
						"navHome",
					),
				navChat:
					this.shadowRoot.getElementById(
						"navChat",
					),
			};
		}

		trackPageView() {
			if (!this.apiBaseUrl || !this.widgetKey || !this.sessionId) return;
			const url = window.location.href;
			fetch(this.apiBaseUrl.replace(/\/+$/, '') + '/api/v1/widget/page-view', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ widgetKey: this.widgetKey, sessionId: this.sessionId, url }),
			}).catch(() => { });
		}

		bindEvents() {
			if (this.elements.floatingHelpBtn) {
				this.elements.floatingHelpBtn.addEventListener(
					"click",
					() => this.openFromFloatingLauncher(),
				);
			}
			if (this.elements.floatingPromptSend) {
				this.elements.floatingPromptSend.addEventListener(
					"click",
					() => {
						if (this.isOpen) {
							this.toggleChat();
							return;
						}
						this.handleFloatingLauncherSend();
					},
				);
			}
			if (this.elements.floatingPromptInput) {
				this.elements.floatingPromptInput.addEventListener(
					"input",
					() =>
						this.updateFloatingLauncherState(),
				);
				this.elements.floatingPromptInput.addEventListener(
					"keydown",
					(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							this.handleFloatingPromptSubmit();
						}
					},
				);
				this.elements.floatingPromptInput.addEventListener(
					"focus",
					() => {
						const wrapper = this.shadowRoot.getElementById("floatingPromptInputWrapper");
						this.elements.floatingInputShell?.classList.add(
							"input-focused",
						);
						if (wrapper) {
							wrapper.classList.remove("is-glowing");
						}
					}
				);
				this.elements.floatingPromptInput.addEventListener(
					"blur",
					() => {
						const wrapper = this.shadowRoot.getElementById("floatingPromptInputWrapper");
						this.elements.floatingInputShell?.classList.remove(
							"input-focused",
						);
						if (wrapper && !this.elements.floatingPromptInput.value.trim()) {
							wrapper.classList.add("is-glowing");
						}
					}
				);
			}
			if (this.elements.backBtn) {
				this.elements.backBtn.addEventListener(
					"click",
					() => {
						this.hasStartedChat = false;
						this.showIntroScreen(true);
					},
				);
			}
			if (this.elements.introStartBtn) {
				this.elements.introStartBtn.addEventListener(
					"click",
					() => this.startChatFromIntro(),
				);
			}
			if (this.elements.introBrowseBtn) {
				this.elements.introBrowseBtn.addEventListener(
					"click",
					() => {
						this.hasStartedChat = false;
						if (this.isOpen) this.toggleChat();
					},
				);
			}
			if (
				this.elements.introHelpLinks &&
				this.elements.introHelpLinks.length
			) {
				this.elements.introHelpLinks.forEach(
					(item) => {
						item.addEventListener("click", () => {
							this.openIntroHelpLink(
								item.dataset.url || "",
							);
						});
					},
				);
			}

			this.elements.sendBtn.addEventListener(
				"click",
				() => this.handleSend(),
			);
			this.elements.input.addEventListener(
				"input",
				() => {
					this.resizeChatInput();
					this.updateSendButtonState();
				},
			);
			this.elements.input.addEventListener(
				"keydown",
				(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						this.handleSend();
					}
				},
			);
			this.elements.input.addEventListener("focus", () => {
				if (this.elements.chatInputContainer) {
					if (this.glowTimeout) clearTimeout(this.glowTimeout);
					this.elements.chatInputContainer.classList.add(
						"is-glowing",
					);
					this.glowTimeout = setTimeout(() => {
						this.elements.chatInputContainer.classList.remove(
							"is-glowing",
						);
					}, 5000);
				}
			});
			this.resizeChatInput(true);
			this.updateFloatingLauncherState();

			// Custom Language Dropdown Logic
			if (this.elements.langPillBtn) {
				this.elements.langPillBtn.addEventListener(
					"click",
					(e) => {
						e.stopPropagation();
						this.elements.langDropdown.classList.toggle(
							"show",
						);
					},
				);
			}
			if (this.elements.emojiPickerBtn) {
				this.elements.emojiPickerBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.elements.chatEmojiPicker.classList.toggle("show");
				});
			}
			this.shadowRoot.querySelectorAll(".chat-emoji-btn").forEach(btn => {
				btn.addEventListener("click", (e) => {
					e.stopPropagation();
					const emoji = btn.textContent;
					this.elements.textMessageInput.value += emoji;
					this.resizeChatInput();
					this.updateSendButtonState();
					this.elements.chatEmojiPicker.classList.remove("show");
					this.elements.textMessageInput.focus();
				});
			});
			if (this.elements.expandChatBtn) {
				this.elements.expandChatBtn.addEventListener(
					"click",
					(e) => {
						e.stopPropagation();
						this.toggleExpandedView();
					},
				);
			}
			if (this.elements.headerMenuBtn) {
				this.elements.headerMenuBtn.addEventListener(
					"click",
					(e) => {
						e.stopPropagation();
						this.elements.headerLanguageMenu?.classList.remove(
							"show",
						);
						this.elements.headerLanguageBtn?.classList.remove(
							"is-open",
						);
						this.elements.headerMenuDropdown?.classList.toggle(
							"hidden",
						);
					},
				);
			}
			if (this.elements.headerCloseBtn) {
				this.elements.headerCloseBtn.addEventListener(
					"click",
					(e) => {
						e.stopPropagation();
						if (this.isOpen) {
							this.toggleChat();
						}
					},
				);
			}
			if (this.elements.headerMenuDropdown) {
				this.elements.headerMenuDropdown.addEventListener(
					"click",
					(e) => e.stopPropagation(),
				);
			}
			if (this.elements.headerLanguageBtn) {
				this.elements.headerLanguageBtn.addEventListener(
					"click",
					(e) => {
						e.stopPropagation();
						const willShow =
							!this.elements.headerLanguageMenu?.classList.contains(
								"show",
							);
						this.elements.headerLanguageMenu?.classList.toggle(
							"show",
							willShow,
						);
						this.elements.headerLanguageBtn?.classList.toggle(
							"is-open",
							willShow,
						);
					},
				);
			}
			if (this.elements.downloadTranscriptBtn) {
				this.elements.downloadTranscriptBtn.addEventListener(
					"click",
					() => {
						this.downloadTranscript();
						this.elements.headerMenuDropdown?.classList.add(
							"hidden",
						);
					},
				);
			}
			if (this.elements.headerHelpBtn) {
				this.elements.headerHelpBtn.addEventListener(
					"click",
					() => {
						const helpUrl = sanitizeURL(
							this.config.introHelpOptionOneUrl ||
							this.config.introHelpOptionTwoUrl ||
							"",
						);
						this.elements.headerMenuDropdown?.classList.add(
							"hidden",
						);
						this.elements.headerLanguageMenu?.classList.remove(
							"show",
						);
						this.elements.headerLanguageBtn?.classList.remove(
							"is-open",
						);
						if (helpUrl) {
							window.open(
								helpUrl,
								"_blank",
								"noopener,noreferrer",
							);
							return;
						}
						this.hasStartedChat = false;
						this.showIntroScreen(true);
					},
				);
			}
			if (this.elements.clearConversationBtn) {
				this.elements.clearConversationBtn.addEventListener(
					"click",
					() => {
						this.clearConversation();
						this.elements.headerMenuDropdown?.classList.add(
							"hidden",
						);
						this.elements.headerLanguageMenu?.classList.remove(
							"show",
						);
						this.elements.headerLanguageBtn?.classList.remove(
							"is-open",
						);
					},
				);
			}

			this.elements.langItems.forEach((item) => {
				item.addEventListener("click", (e) => {
					e.stopPropagation();
					const code =
						item.getAttribute("data-code");
					this.handleLanguageSelect(code);
				});
			});
			this.elements.headerLanguageItems.forEach((item) => {
				item.addEventListener("click", (e) => {
					e.stopPropagation();
					const code =
						item.getAttribute("data-code");
					this.handleLanguageSelect(code);
					this.elements.headerLanguageMenu?.classList.remove(
						"show",
					);
					this.elements.headerLanguageBtn?.classList.remove(
						"is-open",
					);
					this.elements.headerMenuDropdown?.classList.add(
						"hidden",
					);
				});
			});

			// Close dropdown when clicking outside
			this.shadowRoot.addEventListener(
				"click",
				(e) => {
					if (
						!e.target.closest(
							".message-feedback",
						)
					) {
						this.closeAllMessageFeedbackMenus();
					}
					if (this.elements.langDropdown) {
						this.elements.langDropdown.classList.remove(
							"show",
						);
					}
					if (this.elements.headerLanguageMenu) {
						this.elements.headerLanguageMenu.classList.remove(
							"show",
						);
					}
					if (this.elements.headerLanguageBtn) {
						this.elements.headerLanguageBtn.classList.remove(
							"is-open",
						);
					}
					if (this.elements.chatEmojiPicker) {
						this.elements.chatEmojiPicker.classList.remove("show");
					}
					if (this.elements.headerMenuDropdown) {
						this.elements.headerMenuDropdown.classList.add(
							"hidden",
						);
					}
				},
			);
			this.elements.messagesContainer?.addEventListener(
				"click",
				(e) =>
					this.handleMessageFeedbackClick(e),
			);

			// Hope Banner Buttons
			if (this.elements.hopeBannerUp) {
				this.elements.hopeBannerUp.addEventListener(
					"click",
					() => {
						this.elements.hopeBannerUp.classList.add(
							"active",
						);
						this.elements.hopeBannerDown.classList.remove(
							"active",
						);
						this.submitRating("up");
					},
				);
			}
			if (this.elements.hopeBannerDown) {
				this.elements.hopeBannerDown.addEventListener(
					"click",
					() => {
						this.elements.hopeBannerDown.classList.add(
							"active",
						);
						this.elements.hopeBannerUp.classList.remove(
							"active",
						);
						this.submitRating("down");
					},
				);
			}

			// Bottom Nav Events
			if (this.elements.navChat) {
				this.elements.navChat.addEventListener(
					"click",
					() => {
						this.startChatFromIntro();
					},
				);
			}
		}

		handleLanguageSelect(code) {
			const nextLanguage = code || "en";
			console.log(
				"Language changed to:",
				nextLanguage,
			);
			this.selectedLanguage = nextLanguage;
			this.config.defaultLanguage = nextLanguage;
			sessionStorage.setItem(
				this.getLanguageStorageKey(),
				nextLanguage,
			);

			// Update UI
			const pillCode =
				this.shadowRoot.getElementById(
					"langPillCode",
				);
			if (pillCode)
				pillCode.textContent = nextLanguage
					.slice(0, 2)
					.toUpperCase();

			// Update active state in dropdown
			this.elements.langItems.forEach((item) => {
				if (
					item.getAttribute("data-code") ===
					nextLanguage
				) {
					item.classList.add("active");
				} else {
					item.classList.remove("active");
				}
			});
			this.elements.headerLanguageItems.forEach((item) => {
				if (
					item.getAttribute("data-code") ===
					nextLanguage
				) {
					item.classList.add("active");
				} else {
					item.classList.remove("active");
				}
			});

			// Close dropdown
			if (this.elements.langDropdown) {
				this.elements.langDropdown.classList.remove(
					"show",
				);
			}
			this.elements.headerLanguageMenu?.classList.remove(
				"show",
			);
			this.elements.headerLanguageBtn?.classList.remove(
				"is-open",
			);
		}

		setAwaitingResponse(isAwaiting) {
			this.isAwaitingResponse =
				Boolean(isAwaiting);
			this.updateSendButtonState();
		}

		updateBackButtonVisibility(
			showingIntro = false,
		) {
			if (!this.elements.backBtn) {
				return;
			}

			const shouldHideBackButton =
				showingIntro ||
				this.config.showIntroScreen === false;

			this.elements.backBtn.classList.toggle(
				"hidden",
				shouldHideBackButton,
			);
		}

		showIntroScreen(visible, animate = false) {
			if (
				!this.elements.introScreen ||
				!this.elements.chatMainView
			) {
				return;
			}
			if (this._viewTransitionTimer) {
				clearTimeout(this._viewTransitionTimer);
				this._viewTransitionTimer = null;
			}
			const introScreen =
				this.elements.introScreen;
			const chatMainView =
				this.elements.chatMainView;

			if (!animate) {
				introScreen.classList.remove(
					"view-fade-in",
					"view-fade-out",
				);
				chatMainView.classList.remove(
					"view-fade-in",
					"view-fade-out",
				);
				if (visible) {
					if (this.elements.widget) {
						this.elements.widget.classList.add(
							"intro-mode",
						);
					}
					this.updateBackButtonVisibility(true);
					if (this.elements.navHome)
						this.elements.navHome.classList.add(
							"active",
						);
					if (this.elements.navChat)
						this.elements.navChat.classList.remove(
							"active",
						);
					introScreen.classList.remove("hidden");
					this.playIntroAnimations();
					chatMainView.classList.add("hidden");
					return;
				}
				if (this.elements.widget) {
					this.elements.widget.classList.remove(
						"intro-mode",
					);
				}
				this.updateBackButtonVisibility(false);
				if (this.elements.navHome)
					this.elements.navHome.classList.remove(
						"active",
					);
				if (this.elements.navChat)
					this.elements.navChat.classList.add(
						"active",
					);
				introScreen.classList.remove(
					"play-intro-anim",
				);
				introScreen.classList.add("hidden");
				chatMainView.classList.remove("hidden");
				return;
			}

			const transitionMs = 560;

			if (visible) {
				if (this.elements.widget) {
					this.elements.widget.classList.add(
						"intro-mode",
					);
				}
				this.updateBackButtonVisibility(true);
				if (this.elements.navHome)
					this.elements.navHome.classList.add(
						"active",
					);
				if (this.elements.navChat)
					this.elements.navChat.classList.remove(
						"active",
					);
				introScreen.classList.remove("hidden");
				this.playIntroAnimations();
				chatMainView.classList.remove("hidden");
				introScreen.classList.remove(
					"view-fade-out",
				);
				introScreen.classList.add("view-fade-in");
				chatMainView.classList.remove(
					"view-fade-in",
				);
				chatMainView.classList.add(
					"view-fade-out",
				);
				this._viewTransitionTimer = setTimeout(
					() => {
						chatMainView.classList.add("hidden");
						introScreen.classList.remove(
							"view-fade-in",
						);
						chatMainView.classList.remove(
							"view-fade-out",
						);
					},
					transitionMs,
				);
				return;
			}

			if (this.elements.widget) {
				this.elements.widget.classList.remove(
					"intro-mode",
				);
			}
			this.updateBackButtonVisibility(false);
			if (this.elements.navHome)
				this.elements.navHome.classList.remove(
					"active",
				);
			if (this.elements.navChat)
				this.elements.navChat.classList.add(
					"active",
				);
			introScreen.classList.remove(
				"play-intro-anim",
			);
			introScreen.classList.remove("hidden");
			chatMainView.classList.remove("hidden");
			chatMainView.classList.remove(
				"view-fade-out",
			);
			chatMainView.classList.add("view-fade-in");
			introScreen.classList.remove(
				"view-fade-in",
			);
			introScreen.classList.add("view-fade-out");
			this._viewTransitionTimer = setTimeout(
				() => {
					introScreen.classList.add("hidden");
					chatMainView.classList.remove(
						"view-fade-in",
					);
					introScreen.classList.remove(
						"view-fade-out",
					);
				},
				transitionMs,
			);
		}

		playIntroAnimations() {
			const introScreen =
				this.elements?.introScreen;
			if (!introScreen) return;
			introScreen.classList.remove(
				"play-intro-anim",
			);
			// Force reflow so animation restarts every time intro is shown.
			void introScreen.offsetWidth;
			introScreen.classList.add(
				"play-intro-anim",
			);
			if (this._introAnimResetTimer) {
				clearTimeout(this._introAnimResetTimer);
			}
			this._introAnimResetTimer = setTimeout(
				() => {
					introScreen.classList.remove(
						"play-intro-anim",
					);
				},
				1600,
			);
		}

		startChatFromIntro() {
			this.hasStartedChat = true;
			this.showIntroScreen(false);
			setTimeout(() => {
				if (
					this.elements.input &&
					!this.isEmbeddedPreview
				) {
					this.elements.input.focus();
				}
			}, 120);
		}

		openFromFloatingLauncher() {
			this.elements.floatingBtn?.classList.remove(
				"is-collapsed",
			);
			this.hasStartedChat = true;
			if (!this.isOpen) {
				this.toggleChat();
				return;
			}
			this.showIntroScreen(false);
			if (
				this.elements.input &&
				!this.isEmbeddedPreview
			) {
				this.elements.input.focus();
			}
		}

		handleFloatingLauncherSend() {
			if (this.isAwaitingResponse) {
				return;
			}
			const prompt =
				this.elements.floatingPromptInput?.value.trim() ||
				"";
			if (!prompt) {
				this.openFromFloatingLauncher();
				return;
			}
			this.openFromFloatingLauncher();
			if (this.elements.input) {
				this.elements.input.value = prompt;
			}
			if (this.elements.floatingPromptInput) {
				this.elements.floatingPromptInput.value = "";
			}
			this.updateFloatingLauncherState();
			this.resizeChatInput();
			this.updateSendButtonState();
			this.handleSend();
		}

		updateFloatingLauncherState() {
			if (!this.elements.floatingBtn) {
				return;
			}
			const hasValue = Boolean(
				this.elements.floatingPromptInput?.value.trim(),
			);
			this.elements.floatingBtn.classList.toggle(
				"is-typing",
				hasValue,
			);
		}

		dismissFloatingLauncher() {
			if (this.isOpen) {
				this.toggleChat();
				return;
			}
			if (this.elements.floatingPromptInput) {
				this.elements.floatingPromptInput.value = "";
			}
			this.updateFloatingLauncherState();
			this.elements.floatingBtn?.classList.add(
				"is-collapsed",
			);
		}

		toggleExpandedView() {
			const widget = this.elements.widget;
			if (!widget) {
				this.isExpanded = !this.isExpanded;
				return;
			}

			// Cancel any in-progress animation
			if (this._expandRaf) {
				cancelAnimationFrame(this._expandRaf);
				this._expandRaf = null;
			}

			// Measure current rendered size (start)
			const startW = widget.getBoundingClientRect().width;
			const startH = widget.getBoundingClientRect().height;

			// Determine target (end) — toggle class off-screen, measure, restore
			this.isExpanded = !this.isExpanded;
			widget.style.setProperty("width", `${startW}px`, "important");
			widget.style.setProperty("height", `${startH}px`, "important");
			widget.style.setProperty("min-height", `${startH}px`, "important");
			widget.style.setProperty("max-height", `${startH}px`, "important");
			widget.classList.toggle("expanded", this.isExpanded);
			// getBCR after class set but inline pins size, so read computed target
			const cs = window.getComputedStyle(widget);
			const endW = parseFloat(cs.getPropertyValue("--_ew") || 0) ||
				(this.isExpanded
					? Math.min(window.innerWidth * 0.96, 555)
					: 400);
			const endH = this.isExpanded
				? window.innerHeight * 0.80
				: 570;

			const DURATION = 620; // ms
			const ease = (t) => {
				// easeInOutQuart
				return t < 0.5
					? 8 * t * t * t * t
					: 1 - Math.pow(-2 * t + 2, 4) / 2;
			};

			const startTime = performance.now();
			const animate = (now) => {
				const elapsed = now - startTime;
				const progress = Math.min(elapsed / DURATION, 1);
				const t = ease(progress);

				const w = startW + (endW - startW) * t;
				const h = startH + (endH - startH) * t;

				widget.style.setProperty("width", `${w}px`, "important");
				widget.style.setProperty("height", `${h}px`, "important");
				widget.style.setProperty("min-height", `${h}px`, "important");
				widget.style.setProperty("max-height", `${h}px`, "important");

				if (progress < 1) {
					this._expandRaf = requestAnimationFrame(animate);
				} else {
					// Done — clear inline overrides, let CSS hold final state
					widget.style.width = "";
					widget.style.height = "";
					widget.style.minHeight = "";
					widget.style.maxHeight = "";
					this._expandRaf = null;
				}
			};
			this._expandRaf = requestAnimationFrame(animate);

			if (this.elements.expandChatBtn) {
				this.elements.expandChatBtn.setAttribute(
					"aria-label",
					this.isExpanded
						? "Collapse chat"
						: "Expand chat",
				);
				// Toggle icon visibility
				const expandIcon =
					this.elements.expandChatBtn.querySelector(
						".expand-icon",
					);
				const collapseIcon =
					this.elements.expandChatBtn.querySelector(
						".collapse-icon",
					);
				if (expandIcon && collapseIcon) {
					expandIcon.style.display = this
						.isExpanded
						? "none"
						: "block";
					collapseIcon.style.display = this
						.isExpanded
						? "block"
						: "none";
				}
			}
		}

		downloadTranscript() {
			if (!this.elements.messagesContainer)
				return;
			const chatRows = Array.from(
				this.elements.messagesContainer.querySelectorAll(
					".chat-message",
				),
			);
			const lines = [
				`Witzo transcript (${new Date().toLocaleString()})`,
				"",
			];
			chatRows.forEach((row) => {
				const isUser =
					row.classList.contains("user");
				const textNode = row.querySelector(
					".md-content",
				);
				const text = (
					textNode?.innerText || ""
				).trim();
				if (!text) return;
				lines.push(
					`${isUser ? "You" : "Witzo AI"}: ${text}`,
				);
			});
			const blob = new Blob(
				[lines.join("\n\n")],
				{ type: "text/plain;charset=utf-8" },
			);
			const link = document.createElement("a");
			link.href = URL.createObjectURL(blob);
			link.download = `witzo-transcript-${Date.now()}.txt`;
			link.click();
			URL.revokeObjectURL(link.href);
		}

		clearConversation() {
			if (this.elements.messagesContainer) {
				this.elements.messagesContainer.innerHTML =
					"";
			}
			this.userMessageCount = 0;
			this.botMessageCount = 0;
			this.pendingEndIntentRating = false;
			this.resetConversationRatingState();
			if (this.elements.hopeBanner) {
				this.elements.hopeBanner.classList.add(
					"hidden",
				);
			}
			if (this.elements.hopeBannerUp) {
				this.elements.hopeBannerUp.classList.remove(
					"active",
				);
			}
			if (this.elements.hopeBannerDown) {
				this.elements.hopeBannerDown.classList.remove(
					"active",
				);
			}
			if (this.elements.contactFormSlot) {
				this.elements.contactFormSlot.classList.add(
					"hidden",
				);
			}
			if (this.elements.chatInput) {
				this.elements.chatInput.classList.remove(
					"hidden",
				);
			}
			if (this.config.primaryText) {
				this.displayDefaultMessage();
			}
			if (this.elements.input) {
				if (!this.isEmbeddedPreview) {
					this.elements.input.focus();
				}
			}
		}

		toggleChat() {
			if (!this.isOpen) {
				// Open
				this.isOpen = true;
				this.elements.floatingPromptInput?.blur();
				if (this.elements.floatingBtn) {
					this.elements.floatingBtn.classList.add(
						"widget-open",
					);
					this.elements.floatingBtn.classList.remove(
						"entering",
					);
				}
				this.elements.widget.classList.remove(
					"hidden",
				);
				this.elements.widget.classList.remove(
					"minimizing",
				);
				const shouldShowIntro =
					!this.hasStartedChat;
				this.showIntroScreen(shouldShowIntro);
				this.showPendingHopeBanner();
				if (!shouldShowIntro) {
					setTimeout(() => {
						if (
							this.elements.input &&
							!this.isEmbeddedPreview
						) {
							this.elements.input.focus();
						}
					}, 100);
				}
			} else {
				// Close
				this.isOpen = false;
				this.elements.floatingPromptInput?.blur();
				this.elements.input?.blur();
				this.elements.widget.classList.add(
					"minimizing",
				);
				setTimeout(() => {
					this.elements.widget.classList.add(
						"hidden",
					);
					if (this.elements.floatingBtn) {
						this.elements.floatingBtn.classList.remove(
							"widget-open",
						);
						this.elements.floatingBtn.classList.add(
							"entering",
						);
						setTimeout(() => {
							this.elements.floatingBtn?.classList.remove(
								"entering",
							);
						}, 1300);
					}
				}, 300);
			}
		}

		async handleSend() {
			if (this.isAwaitingResponse) {
				return;
			}

			const text =
				this.elements.input.value.trim();
			if (!text) {
				this.updateSendButtonState();
				return;
			}

			// Reset chat count if time gap large (simple version)
			const gap =
				new Date().getTime() -
				this.date.getTime();
			if (gap > 2 * 60 * 1000) {
				this.successfulChatCount = 0;
				this.date = new Date();
				this.userMessageCount = 0;
				this.botMessageCount = 0;
				this.resetConversationRatingState();
			}

			this._clearHopeBannerTimer();
			this._hideHopeBanner();

			// Add User Message
			this.appendMessage(text, "user");
			this.userMessageCount += 1;
			this._wasEndIntent =
				this.isConversationEndMessage(text);
			this.pendingEndIntentRating =
				this._wasEndIntent &&
				!this.ratingShown &&
				!this.ratingSubmitted;
			this.elements.input.value = "";
			this.resizeChatInput(true);
			this.setAwaitingResponse(true);

			// Show Typing Indicator
			const typingWrapper =
				this.showTypingIndicator();

			try {
				const body = {
					widgetKey: this.widgetKey,
					message: text,
					sessionId: this.sessionId,
					language: this.selectedLanguage,
				};

				const url = this.apiUrl.includes("?")
					? `${this.apiUrl}&stream=1`
					: `${this.apiUrl}?stream=1`;

				const response = await fetch(url, {
					method: "POST",
					headers: this.getRequestHeaders({
						"Content-Type": "application/json",
						Accept:
							"text/event-stream, application/json",
					}),
					body: JSON.stringify(body),
				});

				let content = "Sorry, didn't get that.";
				const contentType = (
					response.headers.get("content-type") ||
					""
				).toLowerCase();

				if (
					response.ok &&
					response.body &&
					contentType.includes(
						"text/event-stream",
					)
				) {
					const streamResult =
						await this.consumeStreamedResponse(
							response,
							typingWrapper,
						);
					if (
						streamResult &&
						streamResult.completed
					) {
						this.successfulChatCount++;
						sessionStorage.setItem(
							"witzo_chat_count",
							`${this.successfulChatCount}`,
						);
					}
					return;
				}

				const rawText = await response.text();

				if (response.ok) {
					try {
						const result = JSON.parse(rawText);
						// Support both old and new response formats
						content =
							result.response ||
							result.output ||
							result.message ||
							content;

						// Update sessionId if provided
						if (result.sessionId) {
							this.sessionId = result.sessionId;
							sessionStorage.setItem(
								"witzo_chat_session_token",
								result.sessionId,
							);
							this.ratingShown =
								this.getRatingShownState();
							this.ratingSubmitted =
								this.getRatingSubmittedState();
						}
						if (Array.isArray(result.sources))
							this._jsonSources = result.sources;
						if (result.calendlyBooking) {
							this._jsonCalendlyBooking =
								result.calendlyBooking;
						}
					} catch (e) {
						console.error("JSON Error", e);
					}
					this.successfulChatCount++;
					sessionStorage.setItem(
						"witzo_chat_count",
						`${this.successfulChatCount}`,
					);
					this.appendBotReply(
						typingWrapper,
						content,
					);
					appendSources(
						typingWrapper,
						this._jsonSources || [],
					);
					if (this._jsonCalendlyBooking) {
						this.showCalendlyEmbed(
							this._jsonCalendlyBooking,
						);
					}
					this._jsonSources = null;
					this._jsonCalendlyBooking = null;
					return;
				} else {
					try {
						const err = JSON.parse(rawText);
						if (
							err.limitReached &&
							err.data?.planType === "basic"
						) {
							this.updateTypingToMessage(
								typingWrapper,
								"You've reached the conversation limit. Please use the form below to get in touch.",
							);
							this.pendingEndIntentRating = false;
							this.showContactForm();
							return;
						}
						content = err.message || content;
					} catch (e) { }
				}

				// Replace typing indicator with response (error / free plan limit)
				this.updateTypingToMessage(
					typingWrapper,
					content,
				);
				this.pendingEndIntentRating = false;
			} catch (error) {
				console.error("Network Error", error);
				this.updateTypingToMessage(
					typingWrapper,
					"Sorry, network error occurred.",
				);
				this.pendingEndIntentRating = false;
			} finally {
				this.setAwaitingResponse(false);
			}
		}

		updateSendButtonState() {
			if (
				!this.elements?.sendBtn ||
				!this.elements?.input
			) {
				return;
			}
			const inputDisabled = this._sessionLocked;
			this.elements.input.disabled =
				inputDisabled;
			if (this.elements.langPillBtn) {
				this.elements.langPillBtn.style.pointerEvents =
					this.isAwaitingResponse ? "none" : "";
				this.elements.langPillBtn.style.opacity =
					this.isAwaitingResponse ? "0.55" : "";
			}
			const hasValue = Boolean(
				this.elements.input.value.trim(),
			);
			const disabled =
				inputDisabled ||
				this.isAwaitingResponse ||
				!hasValue;
			this.elements.sendBtn.disabled = disabled;
			this.elements.sendBtn.setAttribute(
				"aria-disabled",
				String(disabled),
			);
			this.elements.sendBtn.classList.toggle(
				"is-active",
				!disabled,
			);
		}

		resizeChatInput(reset = false) {
			if (!this.elements?.input) {
				return;
			}

			const input = this.elements.input;
			input.style.height = "24px";
			if (reset) {
				input.style.height = "24px";
				input.classList.remove("is-scrollable");
				return;
			}

			const maxHeight = 80;
			const scrollHeight = input.scrollHeight;
			const nextHeight = Math.min(
				scrollHeight,
				maxHeight,
			);
			input.style.height = `${Math.max(
				nextHeight,
				24,
			)}px`;
			input.classList.toggle(
				"is-scrollable",
				scrollHeight > maxHeight,
			);
		}

		appendMessage(text, type) {
			const wrapper =
				document.createElement("div");
			wrapper.className = `chat-message ${type === "user" ? "user" : ""}`;

			const bubble =
				document.createElement("div");
			// Type 'user' gets chat-bubble-user, bot gets chat-bubble-ai
			bubble.className =
				type === "user"
					? "chat-bubble-user"
					: "chat-bubble-ai";

			// Render content
			bubble.innerHTML = `<div class="md-content">${this.parseMarkdown(text)}</div>`;

			wrapper.appendChild(bubble);



			this.elements.messagesContainer.appendChild(
				wrapper,
			);
			this.elements.messagesContainer.scrollTop =
				this.elements.messagesContainer.scrollHeight;
		}

		showTypingIndicator() {
			const wrapper =
				document.createElement("div");
			wrapper.className = "chat-message";

			const bubble =
				document.createElement("div");
			bubble.className =
				"typing-indicator chat-bubble-ai"; // Borrow styles
			bubble.innerHTML = `
            <div class="typing-container">
                <span class="typing-dots-text">.</span>
                <span class="typing-dots-text">.</span>
                <span class="typing-dots-text">.</span>
            </div>
        `;

			wrapper.appendChild(bubble);
			this.elements.messagesContainer.appendChild(
				wrapper,
			);
			this.elements.messagesContainer.scrollTop =
				this.elements.messagesContainer.scrollHeight;
			return wrapper;
		}

		getBotIconHtml() {
			return `<div class="bot-msg-chat-icon">
                       <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none">
							<circle cx="16" cy="16" r="16" fill="url(#paint0_radial_2257_38075)" fill-opacity="0.1"/>
							<circle cx="16" cy="16" r="1" fill="url(#paint1_radial_2257_38075)" fill-opacity="0.2"/>
							<path d="M15.861 8.92114C15.8821 8.80321 16.1179 8.80321 16.139 8.92114C16.3754 10.2376 16.9526 12.6311 18.1607 13.8393C19.3689 15.0474 21.7624 15.6246 23.0789 15.861C23.1968 15.8821 23.1968 16.1179 23.0789 16.139C21.7624 16.3754 19.3689 16.9526 18.1607 18.1607C16.9526 19.3689 16.3754 21.7624 16.139 23.0789C16.1179 23.1968 15.8821 23.1968 15.861 23.0789C15.6246 21.7624 15.0474 19.3689 13.8393 18.1607C12.6311 16.9526 10.2376 16.3754 8.92114 16.139C8.80321 16.1179 8.80321 15.8821 8.92114 15.861C10.2376 15.6246 12.6311 15.0474 13.8393 13.8393C15.0474 12.6311 15.6246 10.2376 15.861 8.92114Z" fill="url(#paint2_linear_2257_38075)"/>
							<defs>
							<radialGradient id="paint0_radial_2257_38075" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(16 16) rotate(90) scale(16)">
							<stop stop-color="white" stop-opacity="0"/>
							<stop offset="0.442308" stop-color="currentColor"/>
							<stop offset="1" stop-color="currentColor"/>
							</radialGradient>
							<radialGradient id="paint1_radial_2257_38075" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(16 16) rotate(90)">
							<stop stop-color="white" stop-opacity="0"/>
							<stop offset="0.442308" stop-color="currentColor"/>
							<stop offset="1" stop-color="currentColor"/>
							</radialGradient>
							<linearGradient id="paint2_linear_2257_38075" x1="16" y1="8" x2="16" y2="24" gradientUnits="userSpaceOnUse">
							<stop stop-color="currentColor"/>
							<stop offset="1" stop-color="currentColor"/>
							</linearGradient>
							</defs>
						</svg>
                    </div>`;
		}

		getMessageFeedbackIcon(type) {
			if (type === "up") {
				return `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="14" viewBox="0 0 15 14" fill="none">
				<path d="M3.75804 5.94837V11.9466C3.75804 12.1454 3.67748 12.3361 3.53407 12.4767C3.39065 12.6173 3.19615 12.6963 2.99334 12.6963H1.46392C1.26111 12.6963 1.06661 12.6173 0.923196 12.4767C0.779786 12.3361 0.699219 12.1454 0.699219 11.9466V6.69815C0.699219 6.49929 0.779786 6.30859 0.923196 6.16798C1.06661 6.02737 1.26111 5.94837 1.46392 5.94837H3.75804ZM3.75804 5.94837C4.56929 5.94837 5.34732 5.6324 5.92096 5.06996C6.4946 4.50752 6.81687 3.74468 6.81687 2.94927V2.1995C6.81687 1.80179 6.978 1.42038 7.26482 1.13916C7.55164 0.857939 7.94065 0.699951 8.34628 0.699951C8.7519 0.699951 9.14091 0.857939 9.42773 1.13916C9.71456 1.42038 9.87569 1.80179 9.87569 2.1995V5.94837H12.1698C12.5754 5.94837 12.9644 6.10636 13.2513 6.38758C13.5381 6.6688 13.6992 7.05022 13.6992 7.44792L12.9345 11.1968C12.8245 11.6568 12.6159 12.0517 12.3401 12.3222C12.0642 12.5926 11.7361 12.7239 11.4051 12.6963H6.05216C5.44372 12.6963 4.8602 12.4594 4.42997 12.0375C3.99974 11.6157 3.75804 11.0436 3.75804 10.447" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>`;
			}
			if (type === "down") {
				return `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="14" viewBox="0 0 15 14" fill="none">
				<path d="M10.6404 7.45165V1.45346C10.6404 1.25461 10.721 1.0639 10.8644 0.923287C11.0078 0.782677 11.2023 0.703684 11.4051 0.703684H12.9345C13.1373 0.703684 13.3318 0.782677 13.4752 0.923287C13.6187 1.0639 13.6992 1.25461 13.6992 1.45346V6.70188C13.6992 6.90073 13.6187 7.09144 13.4752 7.23205C13.3318 7.37266 13.1373 7.45165 12.9345 7.45165H10.6404ZM10.6404 7.45165C9.82914 7.45165 9.05112 7.76763 8.47748 8.33007C7.90384 8.89251 7.58157 9.65534 7.58157 10.4508V11.2005C7.58157 11.5982 7.42044 11.9796 7.13362 12.2609C6.8468 12.5421 6.45779 12.7001 6.05216 12.7001C5.64653 12.7001 5.25752 12.5421 4.9707 12.2609C4.68388 11.9796 4.52275 11.5982 4.52275 11.2005V7.45165H2.22863C1.82301 7.45165 1.43399 7.29366 1.14717 7.01244C0.860353 6.73123 0.699219 6.34981 0.699219 5.9521L1.46392 2.20323C1.5739 1.74326 1.78252 1.34831 2.05837 1.07785C2.33421 0.807388 2.66234 0.676075 2.99334 0.703684H8.34628C8.95472 0.703684 9.53823 0.940665 9.96846 1.3625C10.3987 1.78432 10.6404 2.35645 10.6404 2.95301" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>`;
			}
			const icons = {
				Incorrect: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>`,
				"Not helpful": `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="14" viewBox="0 0 15 14" fill="none">
				<path d="M10.5427 7.35168V1.35348C10.5427 1.15463 10.6233 0.963921 10.7667 0.823312C10.9101 0.682702 11.1046 0.603708 11.3074 0.603708H12.8369C13.0397 0.603708 13.2342 0.682702 13.3776 0.823312C13.521 0.963921 13.6016 1.15463 13.6016 1.35348V6.6019C13.6016 6.80076 13.521 6.99146 13.3776 7.13207C13.2342 7.27268 13.0397 7.35168 12.8369 7.35168H10.5427ZM10.5427 7.35168C9.73149 7.35168 8.95346 7.66765 8.37982 8.23009C7.80618 8.79253 7.48392 9.55536 7.48392 10.3508V11.1005C7.48392 11.4983 7.32278 11.8797 7.03596 12.1609C6.74914 12.4421 6.36013 12.6001 5.9545 12.6001C5.54888 12.6001 5.15987 12.4421 4.87305 12.1609C4.58623 11.8797 4.42509 11.4983 4.42509 11.1005V7.35168H2.13097C1.72535 7.35168 1.33634 7.19369 1.04952 6.91247C0.762697 6.63125 0.601562 6.24983 0.601562 5.85213L1.36627 2.10326C1.47624 1.64329 1.68487 1.24833 1.96071 0.977872C2.23656 0.707413 2.56469 0.576099 2.89568 0.603708H8.24862C8.85706 0.603708 9.44058 0.84069 9.87081 1.26252C10.301 1.68435 10.5427 2.25647 10.5427 2.85303" stroke="black" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>`,
				"Too long": `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="12"
  height="14"
  viewBox="0 0 12 14"
  fill="none"
>
  <path
    d="M7.333 10H0.667M11.333 7.333H0.667M7.333 4.667H0.667M11.333 1.333H0.667"
    stroke="currentColor"
    stroke-width="1.333"
    stroke-linecap="round"
  />
</svg>`,
				Incomplete: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>`,
				Slow: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
				"Tell us more": `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="14" viewBox="0 0 16 14" fill="none">
				<path d="M12.2682 0.600098C12.8871 0.600098 13.4806 0.823206 13.9181 1.22034C14.3557 1.61748 14.6016 2.15611 14.6016 2.71774V8.3648C14.6016 8.92644 14.3557 9.46507 13.9181 9.86221C13.4806 10.2593 12.8871 10.4825 12.2682 10.4825H8.37934L4.49045 12.6001V10.4825H2.9349C2.31606 10.4825 1.72256 10.2593 1.28498 9.86221C0.847395 9.46507 0.601563 8.92644 0.601562 8.3648V2.71774C0.601563 2.15611 0.847395 1.61748 1.28498 1.22034C1.72256 0.823206 2.31606 0.600098 2.9349 0.600098H12.2682Z" stroke="black" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>`,
			};
			return icons[type] || "";
		}

		getMessageFeedbackMarkup() {
			const items = this._messageFeedbackReasons
				.map(
					(reason) => `
              <button type="button" class="message-feedback-item" data-feedback-reason="${this.escapeHtml(reason)}">
                <span>${this.escapeHtml(reason)}</span>
                <span class="message-feedback-item-icon">${this.getMessageFeedbackIcon(reason)}</span>
              </button>`,
				)
				.join("");
			return `
            <div class="message-feedback">
              <div class="message-feedback-row">
                <button type="button" class="message-feedback-btn" data-feedback="up" aria-label="Helpful">
                  ${this.getMessageFeedbackIcon("up")}
                  <span class="message-feedback-tooltip">Helpful</span>
                </button>
                <button type="button" class="message-feedback-btn" data-feedback="down" aria-label="Not helpful">
                  ${this.getMessageFeedbackIcon("down")}
                  <span class="message-feedback-tooltip">Not helpful</span>
                </button>
              </div>
              <div class="message-feedback-menu" role="menu" aria-label="Why was this not helpful?">
                ${items}
              </div>
            </div>`;
		}

		getBotMessageMarkup(text) {
			return `<div class="bot-response-block"><div class="bot-message-row">${this.getBotIconHtml()}<div class="md-content">${this.parseMarkdown(text)}</div></div>${this.getMessageFeedbackMarkup()}</div>`;
		}

		closeAllMessageFeedbackMenus() {
			this.shadowRoot
				.querySelectorAll(".message-feedback-menu.show")
				.forEach((menu) => {
					menu.classList.remove("show");
					menu
						.closest(".message-feedback")
						?.classList.remove("menu-open");
				});
		}

		handleMessageFeedbackClick(e) {
			const feedbackButton = e.target.closest(
				".message-feedback-btn",
			);
			if (feedbackButton) {
				e.stopPropagation();
				const feedbackRoot =
					feedbackButton.closest(
						".message-feedback",
					);
				if (!feedbackRoot) return;
				const allButtons =
					feedbackRoot.querySelectorAll(
						".message-feedback-btn",
					);
				allButtons.forEach((button) =>
					button.classList.remove("active"),
				);
				feedbackButton.classList.add("active");
				const menu =
					feedbackRoot.querySelector(
						".message-feedback-menu",
					);
				if (
					feedbackButton.dataset.feedback ===
					"down"
				) {
					const willOpen =
						!menu?.classList.contains("show");
					this.closeAllMessageFeedbackMenus();
					if (willOpen) {
						menu?.classList.add("show");
						feedbackRoot.classList.add(
							"menu-open",
						);
					}
					return;
				}
				menu?.classList.remove("show");
				feedbackRoot.classList.remove(
					"menu-open",
				);
				feedbackRoot
					.querySelectorAll(
						".message-feedback-item.active",
					)
					.forEach((item) =>
						item.classList.remove("active"),
					);
				return;
			}

			const feedbackItem = e.target.closest(
				".message-feedback-item",
			);
			if (!feedbackItem) return;
			e.stopPropagation();
			const feedbackRoot = feedbackItem.closest(
				".message-feedback",
			);
			if (!feedbackRoot) return;
			feedbackRoot
				.querySelectorAll(
					".message-feedback-item",
				)
				.forEach((item) =>
					item.classList.remove("active"),
				);
			feedbackItem.classList.add("active");
			feedbackRoot
				.querySelector(
					'.message-feedback-btn[data-feedback="down"]',
				)
				?.classList.add("active");
			feedbackRoot
				.querySelector(".message-feedback-menu")
				?.classList.remove("show");
			feedbackRoot.classList.remove("menu-open");
		}

		queueScrollToBottom() {
			if (this._scrollFrameQueued) return;
			this._scrollFrameQueued = true;
			requestAnimationFrame(() => {
				if (this.elements?.messagesContainer) {
					this.elements.messagesContainer.scrollTop =
						this.elements.messagesContainer.scrollHeight;
				}
				this._scrollFrameQueued = false;
			});
		}

		updateTypingStreaming(wrapper, text) {
			const bubble = wrapper.querySelector(
				".typing-indicator, .chat-bubble-ai",
			);
			if (!bubble) return;

			let streamingTextNode =
				bubble.querySelector(".streaming-text");
			if (!streamingTextNode) {
				bubble.classList.remove(
					"typing-indicator",
				);
				bubble.innerHTML = `<div class="bot-message-row">${this.getBotIconHtml()}<div class="md-content streaming-text"></div></div>`;
				streamingTextNode = bubble.querySelector(
					".streaming-text",
				);
			}
			if (streamingTextNode) {
				const normalizedText =
					this.normalizeStreamingMarkdown(
						text || "",
					);
				streamingTextNode.innerHTML =
					this.parseMarkdown(normalizedText);
			}
			this.queueScrollToBottom();
		}

		normalizeStreamingMarkdown(text) {
			if (!text) return "";
			let normalized = text;
			const boldMarkerCount = (
				normalized.match(/\*\*/g) || []
			).length;
			if (boldMarkerCount % 2 !== 0) {
				const lastBoldMarkerIndex =
					normalized.lastIndexOf("**");
				if (lastBoldMarkerIndex >= 0) {
					normalized =
						normalized.slice(
							0,
							lastBoldMarkerIndex,
						) +
						normalized.slice(
							lastBoldMarkerIndex + 2,
						);
				}
			}
			return normalized;
		}

		updateTypingToMessage(wrapper, text) {
			const bubble = wrapper.querySelector(
				".typing-indicator",
			);
			wrapper.classList.add("has-feedback");
			if (bubble) {
				bubble.classList.remove(
					"typing-indicator",
				);
				bubble.innerHTML =
					this.getBotMessageMarkup(text);
			} else {
				const bubbleNode = wrapper.querySelector(
					".chat-bubble-ai",
				);
				if (bubbleNode) {
					bubbleNode.innerHTML =
						this.getBotMessageMarkup(text);
				}
			}
			this.queueScrollToBottom();
		}

		async consumeStreamedResponse(
			response,
			typingWrapper,
		) {
			const TYPING_TICK_MS = 20;
			const BASE_CHARS_PER_TICK = 6;
			const getCharsPerTick = (pendingLen) => {
				if (pendingLen > 240) return 16;
				if (pendingLen > 120) return 12;
				if (pendingLen > 60) return 9;
				return BASE_CHARS_PER_TICK;
			};
			const sleep = (ms) =>
				new Promise((resolve) =>
					setTimeout(resolve, ms),
				);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let assembled = "";
			let donePayload = null;
			let streamHadError = false;
			let rendered = "";
			let pending = "";
			let isPumping = false;

			const pump = async () => {
				if (isPumping) return;
				isPumping = true;
				while (pending.length > 0) {
					const charsPerTick = getCharsPerTick(
						pending.length,
					);
					rendered += pending.slice(
						0,
						charsPerTick,
					);
					pending = pending.slice(charsPerTick);
					this.updateTypingStreaming(
						typingWrapper,
						rendered,
					);
					await sleep(TYPING_TICK_MS);
				}
				isPumping = false;
			};

			const processEvent = (payload) => {
				if (!payload || !payload.type) return;
				if (
					payload.type === "token" &&
					typeof payload.token === "string"
				) {
					assembled += payload.token;
					pending += payload.token;
					void pump();
					return;
				}
				if (payload.type === "done") {
					donePayload = payload;
					return;
				}
				if (payload.type === "error") {
					streamHadError = true;
				}
			};

			while (true) {
				const { value, done } =
					await reader.read();
				if (done) break;

				buffer += decoder.decode(value, {
					stream: true,
				});
				const events = buffer.split("\n\n");
				buffer = events.pop() || "";

				for (const rawEvent of events) {
					const lines = rawEvent.split("\n");
					for (const line of lines) {
						if (!line.startsWith("data: "))
							continue;
						const jsonPart = line.slice(6).trim();
						if (!jsonPart) continue;
						try {
							processEvent(JSON.parse(jsonPart));
						} catch (_) { }
					}
				}
			}

			if (buffer.trim().startsWith("data:")) {
				const jsonPart = buffer
					.replace(/^data:\s*/, "")
					.trim();
				if (jsonPart) {
					try {
						processEvent(JSON.parse(jsonPart));
					} catch (_) { }
				}
			}

			while (isPumping || pending.length > 0) {
				if (!isPumping && pending.length > 0) {
					await pump();
					continue;
				}
				await sleep(TYPING_TICK_MS);
			}

			if (rendered !== assembled) {
				this.updateTypingStreaming(
					typingWrapper,
					assembled,
				);
			}

			if (streamHadError) {
				this.updateTypingToMessage(
					typingWrapper,
					"Sorry, network error occurred.",
				);
				this.pendingEndIntentRating = false;
				return { completed: false };
			}

			if (donePayload && donePayload.sessionId) {
				this.sessionId = donePayload.sessionId;
				sessionStorage.setItem(
					"witzo_chat_session_token",
					donePayload.sessionId,
				);
				this.ratingShown =
					this.getRatingShownState();
				this.ratingSubmitted =
					this.getRatingSubmittedState();
			}

			if (!assembled.trim()) {
				this.updateTypingToMessage(
					typingWrapper,
					"Sorry, didn't get that.",
				);
				this.pendingEndIntentRating = false;
				return { completed: false };
			}

			this.appendBotReply(
				typingWrapper,
				assembled,
			);
			appendSources(
				typingWrapper,
				(donePayload && donePayload.sources) ||
				[],
			);
			if (
				donePayload &&
				donePayload.calendlyBooking
			) {
				this.showCalendlyEmbed(
					donePayload.calendlyBooking,
				);
			}
			return { completed: true };
		}

		appendBotReply(typingWrapper, text) {
			this.updateTypingToMessage(
				typingWrapper,
				text,
			);
			this.botMessageCount += 1;
			this.maybeShowLeadForm();

			// Show rating only once per session and only when conversation-end intent is detected.
			const shouldShowConversationRating =
				this.pendingEndIntentRating &&
				!this.ratingShown &&
				!this.ratingSubmitted &&
				this.userMessageCount > 0 &&
				this.botMessageCount > 0;

			if (shouldShowConversationRating) {
				if (
					!this.elements.conversationRatingSlot
				) {
					this.pendingEndIntentRating = false;
					return;
				}
				const ratingRow =
					document.createElement("div");
				ratingRow.className = "rating-row";
				ratingRow.innerHTML = `
                <span class="rating-label">Rate this conversation</span>
                <button class="rating-btn" data-rating="up" title="Thumbs up">&#128077;</button>
                <button class="rating-btn" data-rating="down" title="Thumbs down">&#128078;</button>
            `;
				ratingRow
					.querySelectorAll(".rating-btn")
					.forEach((btn) => {
						btn.addEventListener("click", (e) => {
							const chosen =
								e.currentTarget.dataset.rating;
							ratingRow
								.querySelectorAll(".rating-btn")
								.forEach((b) =>
									b.classList.remove("active"),
								);
							e.currentTarget.classList.add(
								"active",
							);
							if (
								this.elements
									.conversationRatingSlot
							) {
								this.elements.conversationRatingSlot.innerHTML =
									"";
								this.elements.conversationRatingSlot.classList.add(
									"hidden",
								);
							}
							this.submitRating(chosen);
						});
					});
				this.elements.conversationRatingSlot.innerHTML =
					"";
				this.elements.conversationRatingSlot.appendChild(
					ratingRow,
				);
				this.elements.conversationRatingSlot.classList.remove(
					"hidden",
				);
				this.elements.messagesContainer.scrollTop =
					this.elements.messagesContainer.scrollHeight;
				this.setRatingShownState(true);
			}

			this.pendingEndIntentRating = false;

			if (
				this.userMessageCount > 0 &&
				this.botMessageCount > 0
			) {
				if (this._wasEndIntent) {
					this._showHopeBanner();
				} else {
					this._scheduleHopeBanner();
				}
			}
			this._wasEndIntent = false;
		}

		_clearHopeBannerTimer() {
			if (this._idleTimer) {
				clearTimeout(this._idleTimer);
				this._idleTimer = null;
			}
		}

		_hideHopeBanner() {
			this._pendingHopeBanner = false;
			if (this.elements.hopeBanner) {
				this.elements.hopeBanner.classList.add(
					"hidden",
				);
			}
			if (this.elements.hopeBannerUp) {
				this.elements.hopeBannerUp.classList.remove(
					"active",
				);
			}
			if (this.elements.hopeBannerDown) {
				this.elements.hopeBannerDown.classList.remove(
					"active",
				);
			}
		}

		_scheduleHopeBanner() {
			if (this.ratingSubmitted) return;
			this._clearHopeBannerTimer();
			this._idleTimer = setTimeout(() => {
				if (this.isOpen) {
					this._showHopeBanner();
					return;
				}
				this._pendingHopeBanner = true;
			}, 25000);
		}

		showPendingHopeBanner() {
			if (!this._pendingHopeBanner) return;
			this._pendingHopeBanner = false;
			this._showHopeBanner();
		}

		_showHopeBanner() {
			if (this.ratingSubmitted) return;
			if (
				this.userMessageCount <= 0 ||
				this.botMessageCount <= 0
			) {
				return;
			}
			this._clearHopeBannerTimer();
			if (this.elements.hopeBanner) {
				this.elements.hopeBanner.classList.remove(
					"hidden",
				);
				const firstMessage =
					this.elements.messagesContainer?.querySelector(
						".chat-message",
					);
				if (firstMessage) {
					firstMessage.classList.add("mt-space");
				}
			}
		}

		async submitRating(rating) {
			this.setRatingSubmittedState(true);
			this._hideHopeBanner();
			this.showRatingAcknowledgement(rating);
			try {
				await fetch(
					this.apiBaseUrl +
					"/api/v1/widget/rating",
					{
						method: "POST",
						headers: this.getRequestHeaders({
							"Content-Type": "application/json",
						}),
						body: JSON.stringify({
							widgetKey: this.widgetKey,
							sessionId: this.sessionId,
							rating,
						}),
					},
				);
				if (
					this.elements.conversationRatingSlot
				) {
					this.elements.conversationRatingSlot.innerHTML =
						"";
					this.elements.conversationRatingSlot.classList.add(
						"hidden",
					);
				}
			} catch (e) {
				// Non-fatal â€” silently ignore
			}
		}

		showRatingAcknowledgement(rating) {
			if (!this.elements.messagesContainer)
				return;

			clearTimeout(this._ratingToastTimer);
			const existingToast =
				this.shadowRoot.querySelector(
					".rating-feedback-toast",
				);
			if (existingToast) {
				existingToast.remove();
			}

			const toast = document.createElement("div");
			toast.className = `rating-feedback-toast rating-feedback-toast--${rating === "down" ? "down" : "up"}`;
			toast.textContent =
				rating === "down"
					? "Thanks for your feedback. We'll use it to make the experience better."
					: "Thanks for your feedback. Glad that helped.";

			this.elements.messagesContainer.appendChild(
				toast,
			);
			this.elements.messagesContainer.scrollTop =
				this.elements.messagesContainer.scrollHeight;

			this._ratingToastTimer = setTimeout(() => {
				toast.classList.add("is-hiding");
				setTimeout(() => toast.remove(), 220);
			}, 2400);
		}

		_bindCalendlyMessageListener() {
			if (this._calendlyMessageHandler) return;
			this._calendlyMessageHandler = (event) => {
				const origin = String(
					event.origin || "",
				);
				if (!origin.includes("calendly.com"))
					return;
				const eventName =
					typeof event.data === "string"
						? event.data
						: event.data?.event;
				if (
					eventName !==
					"calendly.event_scheduled" ||
					!this._calendlyBookingActive
				) {
					return;
				}

				this.hideCalendlyEmbed();
				const typingWrapper =
					this.showTypingIndicator();
				this.appendBotReply(
					typingWrapper,
					"Your appointment has been booked successfully. Please check your email for the confirmation details.",
				);
			};
			window.addEventListener(
				"message",
				this._calendlyMessageHandler,
			);
		}

		_buildCalendlyUtm(tracking = {}) {
			return {
				utmSource:
					this.widgetKey || "witzo-widget",
				utmMedium: "chat_widget",
				utmCampaign: "witzo_calendly",
				utmContent:
					tracking.sessionId ||
					this.sessionId ||
					"",
				...(tracking.leadId
					? { utmTerm: tracking.leadId }
					: {}),
			};
		}

		async _ensureCalendlyAssets() {
			if (
				window.Calendly &&
				window.Calendly.initInlineWidget
			) {
				return;
			}
			if (this._calendlyAssetPromise) {
				await this._calendlyAssetPromise;
				return;
			}

			this._calendlyAssetPromise = new Promise(
				(resolve, reject) => {
					if (
						!document.getElementById(
							"witzo-calendly-widget-css",
						)
					) {
						const cssLink =
							document.createElement("link");
						cssLink.id =
							"witzo-calendly-widget-css";
						cssLink.rel = "stylesheet";
						cssLink.href =
							"https://assets.calendly.com/assets/external/widget.css";
						document.head.appendChild(cssLink);
					}

					const existingScript =
						document.getElementById(
							"witzo-calendly-widget-script",
						);
					if (
						existingScript &&
						window.Calendly &&
						window.Calendly.initInlineWidget
					) {
						resolve();
						return;
					}

					const script =
						existingScript ||
						document.createElement("script");
					if (!existingScript) {
						script.id =
							"witzo-calendly-widget-script";
						script.src =
							"https://assets.calendly.com/assets/external/widget.js";
						script.async = true;
						document.head.appendChild(script);
					}
					script.addEventListener(
						"load",
						() => resolve(),
						{ once: true },
					);
					script.addEventListener(
						"error",
						() =>
							reject(
								new Error(
									"Failed to load Calendly widget assets",
								),
							),
						{ once: true },
					);
				},
			);

			try {
				await this._calendlyAssetPromise;
			} finally {
				this._calendlyAssetPromise = null;
			}
		}

		hideCalendlyEmbed() {
			if (!this.elements.calendlySlot) return;
			this._calendlyBookingActive = false;
			this.elements.calendlySlot.classList.add(
				"hidden",
			);
			this.elements.calendlySlot.innerHTML = "";
			this.elements.messagesContainer?.classList.remove(
				"hidden",
			);
			if (
				this.elements.contactFormSlot &&
				!this.elements.contactFormSlot.classList.contains(
					"hidden",
				)
			) {
				return;
			}
			if (this.elements.chatInput) {
				this.elements.chatInput.classList.remove(
					"hidden",
				);
			}
		}

		async showCalendlyEmbed(calendlyBooking) {
			if (
				!this.elements.calendlySlot ||
				!calendlyBooking ||
				!calendlyBooking.schedulingUrl
			) {
				return;
			}

			this._clearHopeBannerTimer();
			this._hideHopeBanner();
			this._calendlyBookingActive = true;
			this.elements.contactFormSlot?.classList.add(
				"hidden",
			);
			this.elements.conversationRatingSlot?.classList.add(
				"hidden",
			);
			this.elements.messagesContainer?.classList.add(
				"hidden",
			);
			this.elements.chatInput?.classList.add(
				"hidden",
			);
			this.elements.calendlySlot.classList.remove(
				"hidden",
			);
			this.elements.calendlySlot.innerHTML = `
				<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem;">
					<div>
						<h3 style="margin:0;">${this.escapeHtml(calendlyBooking.bookingLabel || "Book an appointment")}</h3>
						<p style="margin:0.25rem 0 0;">Choose a date and time that works for you.</p>
					</div>
					<button id="calendlyBackBtn" type="button" style="border:none;background:transparent;color:#475569;font-size:0.85rem;font-weight:600;cursor:pointer;padding:0;">Back to chat</button>
				</div>
				<div id="calendlyEmbedContainer" style="min-height:620px;border:1px solid #e2e8f0;border-radius:0.75rem;overflow:hidden;background:#fff;"></div>
			`;

			const backButton =
				this.elements.calendlySlot.querySelector(
					"#calendlyBackBtn",
				);
			if (backButton) {
				backButton.addEventListener(
					"click",
					() => this.hideCalendlyEmbed(),
				);
			}

			const container =
				this.elements.calendlySlot.querySelector(
					"#calendlyEmbedContainer",
				);
			if (!container) return;

			try {
				await this._ensureCalendlyAssets();
				if (
					window.Calendly &&
					window.Calendly.initInlineWidget
				) {
					container.innerHTML = "";
					window.Calendly.initInlineWidget({
						url: calendlyBooking.schedulingUrl,
						parentElement: container,
						prefill:
							calendlyBooking.prefill || {},
						utm: this._buildCalendlyUtm(
							calendlyBooking.tracking || {},
						),
					});
					return;
				}
			} catch (error) {
				console.warn(
					"Calendly asset load failed",
					error,
				);
			}

			container.innerHTML = `<iframe title="Calendly booking" src="${this.escapeHtml(calendlyBooking.schedulingUrl)}" style="width:100%;height:620px;border:0;" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
		}

		showContactForm() {
			if (!this.elements.contactFormSlot) return;
			this.hideCalendlyEmbed();
			this.elements.contactFormSlot.classList.toggle(
				"lead-form-gate",
				Boolean(this.config.leadFormEnabled),
			);
			this.elements.messagesContainer.classList.toggle(
				"lead-form-open",
				Boolean(this.config.leadFormEnabled),
			);
			if (!this.config.leadFormEnabled) {
				this.elements.messagesContainer.classList.add(
					"hidden",
				);
			}
			if (this.elements.chatInput)
				this.elements.chatInput.classList.add(
					"hidden",
				);
			this.elements.contactFormSlot.classList.remove(
				"hidden",
			);

			if (!this._cfBound) {
				this._cfBound = true;
				this.elements.cfSubmit.addEventListener(
					"click",
					() => this.submitContactForm(),
				);
			}
		}

		async submitContactForm() {
			const values = {
				name: this.elements.cfName
					? this.elements.cfName.value.trim() || null
					: null,
				email: this.elements.cfEmail
					? this.elements.cfEmail.value.trim() || null
					: null,
				phone: this.elements.cfPhone
					? this.elements.cfPhone.value.trim() || null
					: null,
				country: this.elements.cfCountry
					? this.elements.cfCountry.value.trim() || null
					: null,
				message: this.elements.cfMessage
					? this.elements.cfMessage.value.trim() || null
					: null,
			};
			const requiredFields = this.config.leadFormEnabled
				? [
					this.config.leadFormNameEnabled !== false
						? this.elements.cfName
						: null,
					this.config.leadFormEmailEnabled !== false
						? this.elements.cfEmail
						: null,
					this.config.leadFormPhoneEnabled !== false
						? this.elements.cfPhone
						: null,
					this.config.leadFormCountryEnabled !== false
						? this.elements.cfCountry
						: null,
				].filter(Boolean)
				: [this.elements.cfEmail].filter(Boolean);
			const missing = requiredFields.filter(
				(field) => !field.value.trim(),
			);
			if (missing.length > 0) {
				missing.forEach((field) => {
					field.style.borderColor = "#ef4444";
				});
				return;
			}
			if (this.elements.cfSubmit) {
				this.elements.cfSubmit.disabled = true;
				this.elements.cfSubmit.textContent =
					"Sending...";
			}
			try {
				const resp = await fetch(
					this.apiBaseUrl +
					"/api/v1/widget/contact",
					{
						method: "POST",
						headers: this.getRequestHeaders({
							"Content-Type": "application/json",
						}),
						body: JSON.stringify({
							widgetKey: this.widgetKey,
							sessionId: this.sessionId,
							...values,
						}),
					},
				);
				if (resp.ok) {
					if (this.config.leadFormEnabled) {
						this.setLeadFormCompletedState(true);
						this.elements.contactFormSlot.classList.add(
							"hidden",
						);
						this.elements.contactFormSlot.classList.remove(
							"lead-form-gate",
						);
						this.elements.messagesContainer.classList.remove(
							"lead-form-open",
						);
						this.elements.messagesContainer.classList.remove(
							"hidden",
						);
						if (this.elements.chatInput) {
							this.elements.chatInput.classList.remove(
								"hidden",
							);
						}
						if (
							this.elements.input &&
							!this.isEmbeddedPreview
						) {
							this.elements.input.focus();
						}
						return;
					}
					this.elements.contactFormSlot.innerHTML =
						'<div class="contact-form-success">âœ“ Message sent! We\'ll be in touch soon.</div>';
				} else {
					if (this.elements.cfSubmit) {
						this.elements.cfSubmit.disabled = false;
						this.elements.cfSubmit.textContent =
							this.config.leadFormEnabled
								? this.config.leadFormButtonText || "Fill the form to continue chat"
								: "Send Message";
					}
				}
			} catch (e) {
				if (this.elements.cfSubmit) {
					this.elements.cfSubmit.disabled = false;
					this.elements.cfSubmit.textContent =
						this.config.leadFormEnabled
							? this.config.leadFormButtonText || "Fill the form to continue chat"
							: "Send Message";
				}
			}
		}

		getLeadFormTriggerMessageCount() {
			const parsed = Number.parseInt(
				this.config.leadFormTriggerMessageCount,
				10,
			);
			return Number.isFinite(parsed) && parsed > 0
				? parsed
				: 5;
		}

		async maybeShowLeadForm() {
			if (
				!this.config.leadFormEnabled ||
				this._leadFormCompleted
			) {
				return;
			}
			if (
				this.elements.contactFormSlot &&
				!this.elements.contactFormSlot.classList.contains(
					"hidden",
				)
			) {
				return;
			}
			if (
				this.userMessageCount <
				this.getLeadFormTriggerMessageCount()
			) {
				return;
			}
			if (this._leadFormStatusChecking) {
				return;
			}

			this._leadFormStatusChecking = true;
			try {
				const resp = await fetch(
					this.apiBaseUrl +
					"/api/v1/widget/lead-status",
					{
						method: "POST",
						headers: this.getRequestHeaders({
							"Content-Type": "application/json",
						}),
						body: JSON.stringify({
							widgetKey: this.widgetKey,
							sessionId: this.sessionId,
						}),
					},
				);
				if (resp.ok) {
					const payload = await resp
						.json()
						.catch(() => null);
					if (payload?.data?.completed) {
						this.setLeadFormCompletedState(true);
						return;
					}
				}
			} catch (e) {
				// Non-fatal: if the status check is unavailable, keep the configured lead gate behavior.
			} finally {
				this._leadFormStatusChecking = false;
			}

			if (
				this._leadFormCompleted ||
				(this.elements.contactFormSlot &&
					!this.elements.contactFormSlot.classList.contains(
						"hidden",
					))
			) {
				return;
			}
			window.setTimeout(
				() => this.showContactForm(),
				250,
			);
		}

		displayDefaultMessage() {
			const wrapper =
				document.createElement("div");
			wrapper.className =
				"chat-message has-feedback";
			const bubble =
				document.createElement("div");
			bubble.className = "chat-bubble-ai";
			bubble.innerHTML = this.getBotMessageMarkup(
				this.config.primaryText,
			);
			wrapper.appendChild(bubble);
			this.elements.messagesContainer.appendChild(
				wrapper,
			);
		}

		parseMarkdown(text) {
			if (!text) return "";
			const formatInlineMarkdown = (value) => {
				let html = this.escapeHtml(
					String(value || ""),
				);

				html = html.replace(
					/\[([^\]]+)\]\(([^)]+)\)/g,
					(match, label, url) => {
						const safe = sanitizeURL(url);
						return safe
							? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
							: label;
					},
				);

				html = html.replace(
					/(^|\s)(https?:\/\/[^\s<>"\)\]]+)/g,
					(match, before, url) => {
						const stripped = url.replace(
							/[.,;:!?]+$/,
							"",
						);
						const trailing = url.slice(
							stripped.length,
						);
						const safe = sanitizeURL(stripped);
						return safe
							? `${before}<a href="${safe}" target="_blank" rel="noopener noreferrer">${stripped}</a>${trailing}`
							: `${before}${url}`;
					},
				);

				return html.replace(
					/\*\*(.+?)\*\*/g,
					"<strong>$1</strong>",
				);
			};

			const normalizeMarkdown = (value) => {
				const inputLines = String(value || "")
					.replace(/\r\n/g, "\n")
					.split("\n");

				return inputLines
					.map((rawLine) => {
						let line = rawLine
							.replace(/\*{3,}/g, "**")
							.replace(/\s+$/g, "");
						const boldMarkers =
							line.match(/\*\*/g) || [];
						if (boldMarkers.length % 2 !== 0) {
							const lastMarkerIndex =
								line.lastIndexOf("**");
							if (lastMarkerIndex >= 0) {
								line =
									line.slice(0, lastMarkerIndex) +
									line.slice(lastMarkerIndex + 2);
							}
						}
						return line;
					})
					.join("\n");
			};

			const lines =
				normalizeMarkdown(text).split("\n");
			const blocks = [];
			const paragraphLines = [];
			const listItems = [];
			let currentListType = "";

			const flushParagraph = () => {
				if (paragraphLines.length === 0) return;
				blocks.push(
					`<p>${paragraphLines
						.map((line) =>
							formatInlineMarkdown(line),
						)
						.join("<br>")}</p>`,
				);
				paragraphLines.length = 0;
			};

			const flushList = () => {
				if (
					!currentListType ||
					listItems.length === 0
				) {
					return;
				}
				blocks.push(
					`<${currentListType}>${listItems
						.map(
							(item) =>
								`<li>${formatInlineMarkdown(item)}</li>`,
						)
						.join("")}</${currentListType}>`,
				);
				listItems.length = 0;
				currentListType = "";
			};

			const flushAll = () => {
				flushParagraph();
				flushList();
			};

			for (const rawLine of lines) {
				const line = rawLine.trim();

				if (!line) {
					flushAll();
					continue;
				}

				const headingMatch = line.match(
					/^(#{2,4})\s+(.+)$/,
				);
				if (headingMatch) {
					flushAll();
					const level = Math.min(
						4,
						headingMatch[1].length,
					);
					blocks.push(
						`<h${level}>${formatInlineMarkdown(
							headingMatch[2],
						)}</h${level}>`,
					);
					continue;
				}

				const strongHeadingMatch = line.match(
					/^\*\*(.+?)\*\*:?\s*$/,
				);
				if (strongHeadingMatch) {
					flushAll();
					blocks.push(
						`<h3>${formatInlineMarkdown(
							strongHeadingMatch[1],
						)}</h3>`,
					);
					continue;
				}

				const unorderedMatch = line.match(
					/^[-*]\s+(.+)$/,
				);
				if (unorderedMatch) {
					flushParagraph();
					if (
						currentListType &&
						currentListType !== "ul"
					) {
						flushList();
					}
					currentListType = "ul";
					listItems.push(unorderedMatch[1]);
					continue;
				}

				const orderedMatch = line.match(
					/^\d+\.\s+(.+)$/,
				);
				if (orderedMatch) {
					flushParagraph();
					if (
						currentListType &&
						currentListType !== "ol"
					) {
						flushList();
					}
					currentListType = "ol";
					listItems.push(orderedMatch[1]);
					continue;
				}

				if (currentListType) {
					flushList();
				}

				paragraphLines.push(line);
			}

			flushAll();
			return blocks.join("");
		}
		escapeHtml(text) {
			return text.replace(
				/[&<>"']/g,
				function (m) {
					return {
						"&": "&amp;",
						"<": "&lt;",
						">": "&gt;",
						'"': "&quot;",
						"'": "&#039;",
					}[m];
				},
			);
		}

		getRequestHeaders(additionalHeaders) {
			var headers = Object.assign(
				{},
				additionalHeaders || {},
			);
			var originToken =
				this.originToken ||
				this.getAttribute("origin-token") ||
				"";
			if (originToken) {
				headers["X-Witzo-Origin-Token"] =
					originToken;
			}
			return headers;
		}
	}

	// Register the custom element
	if (!customElements.get("witzo-chat")) {
		customElements.define(
			"witzo-chat",
			WitzoChatWidget,
		);
	}
})();
