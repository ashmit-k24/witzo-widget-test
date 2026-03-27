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
				autoOpen: true,
				bannerText: "Text Chat",
				bannerTextColor: "",
				bannerColor: "#120b14",
				userChatColor: "#d01137ff",
				closeButtonColor: "",
				logoIcon: null,
				bubbleIcon: null,
				introHelpOptionOneText: "How Witzo works",
				introHelpOptionOneUrl: "",
				introHelpOptionTwoText:
					"Explore AI features",
				introHelpOptionTwoUrl: "",
				introTitle: "ðŸ‘‹Good to see you!",
				introMessage:
					"We're ready to help. Ask anything, from quick questions to complex topics.",
				introPrimaryButtonText: "Let's Chat!",
				introPrimaryButtonColor: "#111827",
				introSecondaryButtonColor: "#f3f4f6",
				introPrimaryButtonBackgroundColor:
					"#121212",
				introSecondaryButtonBackgroundColor:
					"#f3f4f6",
				planType: "free",
				defaultLanguage: "en",
				placeholderText: null,
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

			this.initializeLanguagePreference();
			if (
				!document.getElementById(
					"witzo-font-inter-preconnect",
				)
			) {
				const preconnect =
					document.createElement("link");
				preconnect.id =
					"witzo-font-inter-preconnect";
				preconnect.rel = "preconnect";
				preconnect.href =
					"https://fonts.googleapis.com";
				document.head.appendChild(preconnect);
			}
			if (
				!document.getElementById(
					"witzo-font-inter-preconnect-crossorigin",
				)
			) {
				const preconnectCrossorigin =
					document.createElement("link");
				preconnectCrossorigin.id =
					"witzo-font-inter-preconnect-crossorigin";
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
					"witzo-font-inter",
				)
			) {
				const link =
					document.createElement("link");
				link.id = "witzo-font-inter";
				link.rel = "stylesheet";
				link.href =
					"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap";
				document.head.appendChild(link);
			}
			this.render();
			this.bindEvents();
			this.updateSendButtonState();
			if (this.config.showIntroScreen === false) {
				this.hasStartedChat = true;
			}
			this.showIntroScreen(!this.hasStartedChat);

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
			const closeIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="white"><path d="M19.707 18.292C19.7999 18.3849 19.8736 18.4952 19.9238 18.6166C19.9741 18.738 20 18.8681 20 18.9995C20 19.1309 19.9741 19.261 19.9238 19.3824C19.8736 19.5038 19.7999 19.6141 19.707 19.707C19.6141 19.7999 19.5038 19.8736 19.3824 19.9238C19.261 19.9741 19.1309 20 18.9995 20C18.8681 20 18.738 19.9741 18.6166 19.9238C18.4952 19.8736 18.3849 19.7999 18.292 19.707L10 11.4137L1.70796 19.707C1.52033 19.8946 1.26585 20 1.0005 20C0.735151 20 0.48067 19.8946 0.29304 19.707C0.105409 19.5193 0 19.2648 0 18.9995C0 18.7341 0.105409 18.4797 0.29304 18.292L8.58633 10L0.29304 1.70796C0.105409 1.52033 0 1.26585 0 1.0005C0 0.735151 0.105409 0.48067 0.29304 0.29304C0.48067 0.105409 0.735151 0 1.0005 0C1.26585 0 1.52033 0.105409 1.70796 0.29304L10 8.58633L18.292 0.29304C18.4797 0.105409 18.7341 0 18.9995 0C19.2648 0 19.5193 0.105409 19.707 0.29304C19.8946 0.48067 20 0.735151 20 1.0005C20 1.26585 19.8946 1.52033 19.707 1.70796L11.4137 10L19.707 18.292Z" fill="white"/></svg>`;
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
			if (!this.elements.floatingBtn) return;
			this.elements.floatingBtn.classList.remove(
				"hidden",
			);
			this.elements.floatingBtn.addEventListener(
				"click",
				() => this.toggleChat(),
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
				550,
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
			this.shadowRoot.innerHTML = `
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
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
            --color-close-btn:    ${this.config.closeButtonColor || "white"};
            --color-intro-primary-btn: ${this.config.introPrimaryButtonBackgroundColor || this.config.introPrimaryButtonColor || "#111827"};
            --color-intro-secondary-btn: ${this.config.introSecondaryButtonBackgroundColor || this.config.introSecondaryButtonColor || "#F5F5F7"};
            font-family: Inter, "Inter Fallback", system-ui, sans-serif;
            font-weight: 400;
            display: block;
            position: relative;
            z-index: 2147483647;
            /* width: 100%; height: 100%;  - Removed to avoid blocking clicks on the page */
          }
          :host, :host * {
            font-family: Inter, "Inter Fallback", system-ui, sans-serif;
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
            width: 30em;
    		height: 584px;
            max-width: 90vw;
            max-height: 80vh;
            min-height: 460px;
            display: flex;
            flex-direction: column;
            border-radius: 15px;
            overflow: hidden;
            transition:
              width 0.62s cubic-bezier(0.22, 1, 0.36, 1),
              height 0.62s cubic-bezier(0.22, 1, 0.36, 1),
              max-height 0.62s cubic-bezier(0.22, 1, 0.36, 1),
              min-height 0.62s cubic-bezier(0.22, 1, 0.36, 1),
              max-width 0.62s cubic-bezier(0.22, 1, 0.36, 1);
            background: #fff; /* Ensure background is white */
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
            height: auto;
            min-height: 0;
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
            transform: scale(0.15) translateY(40px);
            opacity: 0;
            animation: slideUp 1s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
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
              transform: scale(0.15) translateY(40px);
              opacity: 1;
            }
            70% {
              transform: scale(1) translateY(0);
            }
            100% {
              transform: scale(1) translateY(0);
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
            transform: scale(1) translateY(0);
            animation: slideDown 0.7s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
          }

          @keyframes slideDown {
            0% {
              transform: scale(1) translateY(0);
              opacity: 1;
            }
            
            100% {
              transform: scale(0.15) translateY(40px);
              opacity: 0;
            }
          }

          .chat-widget::before {
            content: '';
            position: absolute;
            inset: 0;
            background: #ffffff;
            border-radius: 15px;
            animation: overlayFade 1.2s ease-out forwards;
            pointer-events: none;
            z-index: 10;
          }

          .chat-widget.minimizing::before {
            animation: overlayMinimize 1.2s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
          }

          @keyframes overlayFade {
            0% {
              opacity: 1;
            }
            70% {
              opacity: 1;
            }
            100% {
              opacity: 0;
              pointer-events: none;
            }
          }

          @keyframes overlayMinimize {
            0% {
              opacity: 1;
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
            gap: 2px;
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
          .header-online-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #10b981;
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.6);
            animation: onlineDotGlow 1.8s ease-out infinite;
			position: absolute;
    		right: 4px;
    		top: 4px;
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
            width: 32px;
            height: 32px;
            border-radius: 50%;
            margin-right:6px;
            display: flex;
            align-items: center;
            justify-content: center;
          }
            .bot-msg-chat-icon img{
              width: 100%;
              height: 100%;
              object-fit: contain;
            box-shadow: 0px 2.4px 4.8px 0px #00000033;
            border-radius: 50%;


            }
          .chat-title {
            color: #fff;
            font-size: 14px;
            font-weight: 500;
            margin: 0;
          }
          .chat-header-right {
            display: flex;
            align-items: center;
            position: relative;
			gap:2px
          }

		  .chat-action-row{
		  	display: flex;
            align-items: center;
            position: relative;
		  }
          .chat-action-btn {
            border: none;
            background: transparent;
            border-radius: 0.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            margin-left: 0.7rem;
            padding: 0;
			transition: all 0.4s ease-in;
			color:white;
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
				transform: scale(1.08);
			}

          .chat-action-btn svg, .chat-action-btn path { fill: var(--color-close-btn, white); }
          .chat-action-btn.icon-stroke svg path {
            fill: none;
            stroke: var(--color-close-btn, white);
          }
          .chat-header-menu {
            position: absolute;
            top: 42px;
            right: 0;
            min-width: 220px;
            background: #fff;
            border: 1px solid #e5e7eb;
            border-radius: 16px;
            box-shadow: rgba(0, 0, 0, 0.1) 0px 4px 12px;
            overflow: hidden;
            z-index: 0;
            transform-origin: right top;
            animation: headerMenuIn 0.3s ease-out;
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
            background: #fff;
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 12px 16px;
            cursor: pointer;
            text-align: left;
            font-size: 14px;
            color: #1f2937;
          }
          .chat-header-menu .chat-menu-item:hover {
            background: #f9fafb;
          }
          .chat-header-menu .chat-menu-item + .chat-menu-item {
            border-top: 1px solid #f1f5f9;
          }
          
          .chat-widget.expanded {
            width: min(96vw, 37rem) !important;
            max-width: min(96vw, 44rem) !important;
          
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
            padding: 1.25rem;
            background: #fff;
            flex: 1;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 1rem;
            scrollbar-width: thin;
            scrollbar-color: #888 #f5f5f5;
            transition: all 0.6s ease-in-out;
          }
          .chat-message { display: flex; align-items: flex-start; gap: 0.75rem; }
          .chat-message.mt-space {
            margin-top: 46px;
            transition: all 0.7s ease-in 0.3s;
          }

		  
          
          /* Bubbles */
          .chat-bubble-ai { 
            padding: 0; 
            max-width: 340px; 
            color: #0f172a; 
            font-size: 0.875rem; 
            line-height: 1.3; 
          }
          .chat-bubble-user {
            background: var(--color-user-bubble, #ffdde4); /* Default or Config */
            color: #ffffff;
            border-radius: 16px 16px 8px 16px;
            padding: 10px 16px;
            max-width: 280px;
            font-size: 0.875rem;
            line-height: 1.3;
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
            padding: 1rem;
            padding-bottom: 0.25rem;
            background: #fff;
            border-top: 1px solid #e2e8f0;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 0.75rem;
            overflow: visible;
          }
          .chat-language-row { display: none; }
          .chat-input-container {
            position: relative;
          }
          .lang-pill {
            position: absolute;
            right: 57px;
            top: 50%;
            transform: translateY(-50%);
            display: flex;
            align-items: center;
            gap: 6px;
            background: #f1f3f5;
            border-radius: 9999px;
            padding: 5px 10px 5px 7px;
            cursor: pointer;
            font-size: 0.72rem;
            font-weight: 700;
            color: #1a1a2e;
            letter-spacing: 0.04em;
            user-select: none;
            transition: all 0.2s ease;
            z-index: 2;
          }
          .lang-pill:hover { background: #e2e8f0; }
          .lang-pill svg { flex-shrink: 0; }
          
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


          .chat-text-input {
            padding-right: 80px !important;
          }
          .chat-input-container{
            display: flex;
            width: 100%;
            gap: 0.5rem;
            align-items: center;
            justify-content: space-between;
          }
          .chat-text-input {
            flex: 1;
            background: #FFFFFF;
            border-radius: 9999px;
            font-size: 0.875rem;
            outline: none;
            box-shadow: rgba(100, 100, 111, 0.2) 0px 7px 29px 0px;
            width:100%;
             padding: 14px 24px;
            border: 1px solid rgb(227, 227, 227);            box-shadow: rgba(0, 0, 0, 0.075) 0px 0.602187px 2.04744px -1.33333px, rgba(0, 0, 0, 0.067) 0px 2.28853px 7.78101px -2.66667px, rgba(0, 0, 0, 0.02) 0px 10px 34px -4px;
          }
           .chat-send-btn {
            width: 40px;
            height: 40px;
            border: none;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #fff;
            cursor: pointer;
            overflow: hidden;
            background: transparent;
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
           .chat-send-btn.is-active:hover {
            rotate: 90deg;
            box-shadow: rgba(100, 100, 111, 0.2) 0px 7px 29px 0px;


          }

          .chat-send-icon{
            width: 3rem;
            height: 3rem;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 0.75rem;
            background: #d1d5db;
            transition: background 0.2s ease, transform 0.2s ease;
          }
          .chat-send-btn.is-active .chat-send-icon {
            background: var(--color-primary, #fc0e3f);
          }


          .chat-main-view {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            opacity: 1;
            transform: none;
            transition: opacity 0.56s cubic-bezier(0.22, 1, 0.36, 1);
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
            padding: 12px 16px 16px;
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
    		color: #9f9f9f;
    		font-weight: 300;
    		letter-spacing: 0.01em;
    		margin-bottom: 13px;
          }
          .powered-by-brand {
            color: #454545;
            text-decoration: none;
            font-weight: 600;
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
            animation: float 3s ease-in-out infinite;
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
            pointer-events: auto;
          }
          .floating-launcher:hover {
            transform: translateY(-2px);
          }
          .floating-launcher:focus-visible {
            outline: 2px solid var(--color-primary, #fc0e3f);
            outline-offset: 2px;
          }

          .floating-orb {
            width: 64px;
            height: 64px;
            border-radius: 9999px;
            padding: 3px;
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
            background: #111827;
            position: relative;
            transform-style: preserve-3d;
            transition: transform 0.45s cubic-bezier(0.4, 0, 0.2, 1);
          }
          .floating-launcher.widget-open .floating-orb-inner {
            transform: rotateY(180deg);
          }
          .floating-orb-inner svg {
            width: 28px;
            height: 28px;
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

          .floating-launcher.entering {
            animation: floatingBtnIn 0.8s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards !important;
          }

          @keyframes floatingBtnIn {
            0% { opacity: 0; transform: scale(0.3); }
            55% { opacity: 1; transform: scale(1.12); }
            75% { transform: scale(0.96); }
            100% { opacity: 1; transform: scale(1); }
          }

          @media (max-width: 640px) {
            #floatingBtn {
              right: 14px;
              bottom: 14px;
            }
            #textChatWidget.intro-mode {
              width: min(570px, 25.5rem);
              height: min(570px, 82vh);
              min-height: min(570px, 82vh);
              max-height: min(570px, 82vh);
            }
            .floating-launcher-full {
              width: 230px;
            }
            .chat-widget.expanded {
              width: 96vw !important;
              max-width: 96vw !important;
              height: 85vh !important;
              max-height: 85vh !important;
              right: 2vw !important;
            }
			  .chat-widget.expanded.intro-mode {
              height: 554px !important;
				
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
              gap: 0.3rem;
            }
            .bot-message-row .bot-msg-chat-icon {
              flex-shrink: 0;
            }
			  .bot-message-row .md-content{
				background-color: rgb(245, 245, 247);
				padding:10px 16px;
				border-radius: 16px 16px 8px 8px;
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
            .md-content p { margin: 0; }
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
 						<button id="backToIntroBtn" class="chat-action-btn back-btn hidden icon-stroke" aria-label="Back to intro">
                        	<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-left h-5 w-5" aria-hidden="true"><path d="m15 18-6-6 6-6"></path>
							</svg>
                    	</button>
						<button id="expandChatBtn" class="chat-action-btn icon-stroke" aria-label="Expand chat">
                        	<!-- Expand Icon -->
                       		 <svg class="expand-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            	<path d="M15 3h6v6"></path>
                            	<path d="m21 3-7 7"></path>
                            	<path d="m3 21 7-7"></path>
                            	<path d="M9 21H3v-6"></path>
                        	</svg>
                        	<!-- Collapse Icon -->
                        	<svg class="collapse-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: none;">
                            	<path d="m14 10 7-7"></path>
                            	<path d="M20 10h-6V4"></path>
                            	<path d="m3 21 7-7"></path>
                            	<path d="M4 14h6v6"></path>
                        	</svg>
                   		 </button>
				   </div>


                    <div class="chat-header-identity">
                      <div class="chat-icon">
                    ${
											this.getDisplayIconUrl()
												? `<img id="logoIcon" src="${this.getDisplayIconUrl()}" alt="Logo" />`
												: `<svg width="32" height="32" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 6C13.66 6 15 7.34 15 9C15 10.66 13.66 12 12 12C10.34 12 9 10.66 9 9C9 7.34 10.34 6 12 6ZM12 19.2C9.5 19.2 7.29 17.92 6 15.98C6.03 13.99 10 12.9 12 12.9C13.99 12.9 17.97 13.99 18 15.98C16.71 17.92 14.5 19.2 12 19.2Z"/></svg>`
										}

					  <span class="header-online-dot"></span>
                      </div>
                      <div class="online-ready">
                        <div class="online-ready-text">
                        <h3 id="banner-text" class="chat-title" style="color: ${this.config.bannerTextColor || "#fff"}">${this.config.bannerText}</h3>
                        </div>
                      </div>
                    </div>
                </div>
                <div class="chat-header-right">
                    
                    <button id="headerMenuBtn" class="chat-action-btn icon-stroke" aria-label="Header options">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-ellipsis h-5 w-5" aria-hidden="true"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>
                    </button>
                    <button id="closeTextChat" class="chat-action-btn">
                         
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x h-5 w-5" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
                    </button>
                    <div id="headerMenuDropdown" class="chat-header-menu hidden">
                      <button id="downloadTranscriptBtn" class="chat-menu-item" type="button">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-download-icon lucide-download"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>
                        <span>Download transcript</span>
                      </button>
                      <button id="clearConversationBtn" class="chat-menu-item" type="button">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash2 lucide-trash-2 h-4 w-4 text-muted-foreground" aria-hidden="true"><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
						</svg>
                        <span>Clear conversation</span>
                      </button>
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
              		  		<strong id="introTitle">${sanitizeHTML(this.config.introTitle || "ðŸ‘‹Good to see you!")}</strong><br/>
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

            <!-- Contact Form (basic plan â€” shown when conversation limit hit) -->
            <div id="contactFormSlot" class="contact-form hidden">
              <h3>Get in Touch</h3>
              <p>Our team will respond as soon as possible.</p>
              <input id="cf-name" type="text" placeholder="Your name" />
              <input id="cf-email" type="email" placeholder="Your email *" />
              <textarea id="cf-message" placeholder="Your message"></textarea>
              <button class="contact-form-submit" id="cf-submit">Send Message</button>
            </div>

            <!-- Conversation Rating Slot -->
            <div id="conversationRatingSlot" class="hidden"></div>

             <!-- Input Area -->
            <div class="chat-input">
                <div class="chat-input-container">
                    <input id="textMessageInput" type="text" placeholder="${this.config.placeholderText || "Type your message..."}" class="chat-text-input" />
                    <!-- Language Pill -->
                    <div class="lang-pill" id="langPillBtn">
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none">
                          <path d="M9.75 0C7.82164 0 5.93657 0.571828 4.33319 1.64317C2.72982 2.71451 1.48013 4.23726 0.742179 6.01884C0.00422452 7.80042 -0.188858 9.76082 0.187348 11.6521C0.563554 13.5434 1.49215 15.2807 2.85571 16.6443C4.21928 18.0079 5.95656 18.9365 7.84787 19.3127C9.73919 19.6889 11.6996 19.4958 13.4812 18.7578C15.2627 18.0199 16.7855 16.7702 17.8568 15.1668C18.9282 13.5634 19.5 11.6784 19.5 9.75C19.4973 7.16498 18.4692 4.68661 16.6413 2.85872C14.8134 1.03084 12.335 0.00272983 9.75 0ZM9.75 1.5C11.3484 1.4983 12.9125 1.96361 14.25 2.83875V4.6875L12.1716 7.10063L9.22125 7.5L9.19219 7.47937L7.34813 6.27375C7.18464 6.15858 6.99976 6.07727 6.80439 6.0346C6.60901 5.99192 6.40707 5.98875 6.21045 6.02526C6.01382 6.06177 5.82649 6.13723 5.65945 6.24721C5.49242 6.35718 5.34906 6.49944 5.23782 6.66562L3.27469 9.6C3.11115 9.84453 3.02312 10.1318 3.02157 10.4259L3 13.8225L2.69344 14.0241C1.93558 12.7728 1.52404 11.3426 1.50101 9.87988C1.47798 8.4172 1.84429 6.97469 2.56238 5.70021C3.28048 4.42573 4.32454 3.3651 5.58756 2.62703C6.85058 1.88896 8.28714 1.5 9.75 1.5ZM3.58969 15.2316L3.82594 15.0769C4.03224 14.9408 4.20172 14.7559 4.31932 14.5385C4.43691 14.3211 4.49898 14.0781 4.5 13.8309L4.51969 10.4344L6.48469 7.5C6.49432 7.50741 6.50433 7.51429 6.51469 7.52063L8.35876 8.72719C8.66779 8.9453 9.04805 9.0381 9.42282 8.98688L12.375 8.58656C12.7391 8.53798 13.0726 8.35751 13.3125 8.07938L15.3909 5.66437C15.6234 5.39204 15.7507 5.04554 15.75 4.6875V4.09406C16.7644 5.16731 17.4717 6.49352 17.7978 7.93387C18.1238 9.37422 18.0567 10.8757 17.6034 12.2812L16.0903 10.8975C15.88 10.7044 15.6189 10.5754 15.3377 10.5256C15.0566 10.4757 14.767 10.5072 14.5031 10.6163L11.6475 11.8022C11.4087 11.9024 11.1998 12.0625 11.0408 12.2669C10.8819 12.4713 10.7783 12.7133 10.74 12.9694L10.5159 14.4872C10.4621 14.8525 10.5449 15.2249 10.7485 15.533C10.9521 15.841 11.2622 16.0632 11.6194 16.1569L13.6313 16.6875L13.8525 16.9097C12.2096 17.8523 10.2921 18.2001 8.42288 17.8944C6.55362 17.5888 4.84676 16.6484 3.58969 15.2316ZM15.0938 16.0312L14.6906 15.6272C14.5026 15.4384 14.2677 15.3032 14.01 15.2353L12 14.7047L12.2241 13.1869L15.0788 12L16.9688 13.7325C16.487 14.6052 15.8519 15.384 15.0938 16.0312Z" fill="#212121"/>
                      </svg>
                      <span id="langPillCode">${(this.selectedLanguage || "en").slice(0, 2).toUpperCase()}</span>
                      
                      <!-- Shadcn Style Dropdown -->
                      <div class="lang-dropdown" id="langDropdown">
                        ${this.supportedLanguages
													.map(
														(language) => `
                          <div class="lang-dropdown-item ${language.code === this.selectedLanguage ? "active" : ""}" data-code="${language.code}">
                            <span>${language.label}</span>
                            <svg class="lang-check" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                          </div>
                        `,
													)
													.join("")}
                      </div>
                    </div>
                    <button class="chat-send-btn" id="textSendButton" disabled aria-disabled="true">
                        <div class="chat-send-icon">
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="17" viewBox="0 0 14 17" fill="#471791">
                            <path d="M13.4777 7.32307C13.4142 7.38665 13.3388 7.43709 13.2558 7.47151C13.1728 7.50592 13.0838 7.52364 12.9939 7.52364C12.904 7.52364 12.815 7.50592 12.732 7.47151C12.649 7.43709 12.5736 7.38665 12.5101 7.32307L7.52294 2.3351V15.7295C7.52294 15.9109 7.45089 16.0848 7.32264 16.2131C7.19439 16.3413 7.02044 16.4134 6.83907 16.4134C6.6577 16.4134 6.48375 16.3413 6.3555 16.2131C6.22725 16.0848 6.1552 15.9109 6.1552 15.7295V2.3351L1.16809 7.32307C1.03976 7.45139 0.865723 7.52348 0.684249 7.52348C0.502775 7.52348 0.328734 7.45139 0.200412 7.32307C0.0720903 7.19474 1.35209e-09 7.0207 0 6.83923C-1.35209e-09 6.65775 0.0720903 6.48371 0.200412 6.35539L6.35523 0.20057C6.41875 0.136986 6.49417 0.0865445 6.57719 0.0521293C6.66021 0.017714 6.7492 0 6.83907 0C6.92894 0 7.01793 0.017714 7.10095 0.0521293C7.18397 0.0865445 7.2594 0.136986 7.32291 0.20057L13.4777 6.35539C13.5413 6.4189 13.5918 6.49433 13.6262 6.57735C13.6606 6.66037 13.6783 6.74936 13.6783 6.83923C13.6783 6.9291 13.6606 7.01809 13.6262 7.10111C13.5918 7.18413 13.5413 7.25955 13.4777 7.32307Z" fill="white"></path>
                          </svg>
                        </div>
                    </button>
                </div>
            </div>
            </div>

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
				closeBtn: this.shadowRoot.getElementById(
					"closeTextChat",
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
				cfName:
					this.shadowRoot.getElementById(
						"cf-name",
					),
				cfEmail:
					this.shadowRoot.getElementById(
						"cf-email",
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
				headerMenuDropdown:
					this.shadowRoot.getElementById(
						"headerMenuDropdown",
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

		bindEvents() {
			this.elements.floatingBtn.addEventListener(
				"click",
				() => this.toggleChat(),
			);
			this.elements.closeBtn.addEventListener(
				"click",
				() => this.toggleChat(),
			);
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
				() => this.updateSendButtonState(),
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
						this.elements.headerMenuDropdown?.classList.toggle(
							"hidden",
						);
					},
				);
			}
			if (this.elements.headerMenuDropdown) {
				this.elements.headerMenuDropdown.addEventListener(
					"click",
					(e) => e.stopPropagation(),
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
			if (this.elements.clearConversationBtn) {
				this.elements.clearConversationBtn.addEventListener(
					"click",
					() => {
						this.clearConversation();
						this.elements.headerMenuDropdown?.classList.add(
							"hidden",
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

			// Close dropdown when clicking outside
			this.shadowRoot.addEventListener(
				"click",
				() => {
					if (this.elements.langDropdown) {
						this.elements.langDropdown.classList.remove(
							"show",
						);
					}
					if (this.elements.headerMenuDropdown) {
						this.elements.headerMenuDropdown.classList.add(
							"hidden",
						);
					}
				},
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

			// Close dropdown
			if (this.elements.langDropdown) {
				this.elements.langDropdown.classList.remove(
					"show",
				);
			}
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

		toggleExpandedView() {
			this.isExpanded = !this.isExpanded;
			if (this.elements.widget) {
				this.elements.widget.classList.toggle(
					"expanded",
					this.isExpanded,
				);
			}
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
						}, 550);
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
				this.config.planType === "basic" &&
				this._wasEndIntent &&
				!this.ratingShown &&
				!this.ratingSubmitted;
			this.elements.input.value = "";
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
					this._jsonSources = null;
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
					} catch (e) {}
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

			// Double-tick read receipt for user messages
			if (type === "user") {
				const tick =
					document.createElement("div");
				tick.className = "msg-status-tick";
				tick.innerHTML = `
				<small>Read</small>
				<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-check-icon lucide-check-check"><path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/></svg>`;
				wrapper.appendChild(tick);
			}

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
                        ${
													this.getDisplayIconUrl()
														? `<img src="${this.getDisplayIconUrl()}" alt="Logo" />`
														: `<svg width="32" height="32" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 6C13.66 6 15 7.34 15 9C15 10.66 13.66 12 12 12C10.34 12 9 10.66 9 9C9 7.34 10.34 6 12 6ZM12 19.2C9.5 19.2 7.29 17.92 6 15.98C6.03 13.99 10 12.9 12 12.9C13.99 12.9 17.97 13.99 18 15.98C16.71 17.92 14.5 19.2 12 19.2Z"/></svg>`
												}
                    </div>`;
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
			if (bubble) {
				bubble.classList.remove(
					"typing-indicator",
				);
				bubble.innerHTML = `<div class="bot-message-row">${this.getBotIconHtml()}<div class="md-content">${this.parseMarkdown(text)}</div></div>`;
			} else {
				const bubbleNode = wrapper.querySelector(
					".chat-bubble-ai",
				);
				if (bubbleNode) {
					bubbleNode.innerHTML = `<div class="bot-message-row">${this.getBotIconHtml()}<div class="md-content">${this.parseMarkdown(text)}</div></div>`;
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
						} catch (_) {}
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
					} catch (_) {}
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
			return { completed: true };
		}

		appendBotReply(typingWrapper, text) {
			this.updateTypingToMessage(
				typingWrapper,
				text,
			);
			this.botMessageCount += 1;

			// Show rating only once per session and only when conversation-end intent is detected.
			const shouldShowConversationRating =
				this.config.planType === "basic" &&
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

		showContactForm() {
			if (!this.elements.contactFormSlot) return;
			this.elements.messagesContainer.classList.add(
				"hidden",
			);
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
			const email = this.elements.cfEmail
				? this.elements.cfEmail.value.trim()
				: "";
			if (!email) {
				if (this.elements.cfEmail)
					this.elements.cfEmail.style.borderColor =
						"#ef4444";
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
							name: this.elements.cfName
								? this.elements.cfName.value.trim() ||
									null
								: null,
							email,
							message: this.elements.cfMessage
								? this.elements.cfMessage.value.trim() ||
									null
								: null,
						}),
					},
				);
				if (resp.ok) {
					this.elements.contactFormSlot.innerHTML =
						'<div class="contact-form-success">âœ“ Message sent! We\'ll be in touch soon.</div>';
				} else {
					if (this.elements.cfSubmit) {
						this.elements.cfSubmit.disabled = false;
						this.elements.cfSubmit.textContent =
							"Send Message";
					}
				}
			} catch (e) {
				if (this.elements.cfSubmit) {
					this.elements.cfSubmit.disabled = false;
					this.elements.cfSubmit.textContent =
						"Send Message";
				}
			}
		}

		displayDefaultMessage() {
			const wrapper =
				document.createElement("div");
			wrapper.className = "chat-message";
			const bubble =
				document.createElement("div");
			bubble.className = "chat-bubble-ai";
			bubble.innerHTML = `<div class="bot-message-row">${this.getBotIconHtml()}<div class="md-content">${this.parseMarkdown(this.config.primaryText)}</div></div>`;
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
