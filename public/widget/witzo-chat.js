/**
 * Witzo Chat Widget - Standalone Version
 * Updated to match text-widget design
 */
(function () {
  'use strict';

  // Helper: Sanitize URL
  function sanitizeURL(url) {
    if (!url) return '';
    // Allow http, https, mailto, tel protocols
    if (/^(https?|mailto|tel):/i.test(url)) return url;
    return '';
  }

  // Helper: Sanitize HTML (simple version)
  function sanitizeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Define the custom element
  class WitzoChatWidget extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });

      // Properties
      this.apiUrl = '';
      this.apiBaseUrl = '';
      this.widgetKey = '';
      this.sessionId = '';
      this.isOpen = false;
      this.successfulChatCount = 0;
      this.userMessageCount = 0;
      this.botMessageCount = 0;
      this.pendingEndIntentRating = false;
      this.ratingShown = false;
      this.ratingSubmitted = false;
      this.selectedLanguage = 'en';
      this.date = new Date();
      this._cfBound = false;

      this.elements = {};
      this.supportedLanguages = [
        { code: 'en', label: 'English' },
        { code: 'es', label: 'Spanish' },
        { code: 'fr', label: 'French' },
        { code: 'de', label: 'German' },
        { code: 'hi', label: 'Hindi' },
        { code: 'ar', label: 'Arabic' },
        { code: 'pt', label: 'Portuguese' },
        { code: 'ru', label: 'Russian' },
        { code: 'ja', label: 'Japanese' },
        { code: 'zh', label: 'Chinese' },
        { code: 'it', label: 'Italian' },
        { code: 'nl', label: 'Dutch' },
        { code: 'ko', label: 'Korean' },
        { code: 'tr', label: 'Turkish' },
        { code: 'pl', label: 'Polish' },
      ];

      // Configuration with defaults (matching text-widget types)
      this.config = {
        primaryText: null,
        botColor: '#fc0e3f',
        sendColor: '#fc0e3f',
        floatingBtnColor: '#fc0e3f',
        floatingBtn: '#fc0e3f',
        autoOpen: false,
        bannerText: 'Text Chat',
        bannerTextColor: '',
        bannerColor: '#120b14',
        userChatColor: '#d01137ff',
        closeButtonColor: '',
        logoIcon: null,
        // bannerTextParagraph: 'I am AI powered and learning',
        bannerTextParagraphColor: '',
        chatVoiceIconColor: '#7908FB',
        voiceSendButton: '#7908FB',
        planType: 'free',
        defaultLanguage: 'en'
      };
    }

    connectedCallback() {
      // Initialize Session
      this.initializeSession();

      // Read attributes
      this.apiUrl = this.getAttribute('api-url') || '';
      this.apiBaseUrl = this.getAttribute('api-base-url') || this.apiUrl.replace('/api/v1/webhook', '');
      this.widgetKey = this.getAttribute('widget-key') || '';

      // Read configuration from attributes
      const attrs = [
        'primary-text', 'bot-color', 'send-color', 'floating-btn-color', 'floating-btn',
        'auto-open', 'banner-text', 'banner-text-color', 'banner-color', 'user-chat-color',
        'close-button-color', 'logo-icon', 'banner-text-paragraph',
        'banner-text-paragraph-color', 'chat-voice-icon-color', 'voice-send-button',
        'plan-type', 'default-language'
      ];

      attrs.forEach(attr => {
        const value = this.getAttribute(attr);
        if (value !== null) {
          const key = attr.replace(/-([a-z])/g, g => g[1].toUpperCase());
          if (value === 'true') this.config[key] = true;
          else if (value === 'false') this.config[key] = false;
          else this.config[key] = value;
        }
      });

      this.initializeLanguagePreference();
      this.render();
      this.bindEvents();

      // Process default message
      if (this.config.primaryText) {
        setTimeout(() => {
          this.displayDefaultMessage();
        }, 500);
      }

      // Auto-open if configured
      if (this.config.autoOpen) {
        setTimeout(() => {
          if (!this.isOpen) this.toggleChat();
        }, 5000);
      }

      // Show floating button after delay
      setTimeout(() => {
        if (this.elements.floatingBtn) this.elements.floatingBtn.classList.remove('hidden');
      }, 2000);
    }

    initializeSession() {
      const date = sessionStorage.getItem('witzo_chat_date');
      if (date) {
        this.date = new Date(date);
      } else {
        sessionStorage.setItem('witzo_chat_date', new Date().toISOString());
      }

      const chatCount = sessionStorage.getItem('witzo_chat_count');
      if (chatCount) this.successfulChatCount = Number(chatCount);
      else sessionStorage.setItem('witzo_chat_count', `0`);

      // Session Token
      const STORAGE_KEY = 'witzo_chat_session_token';
      let session = sessionStorage.getItem(STORAGE_KEY);
      if (!session) {
        // UUID Fallback
        session = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
        sessionStorage.setItem(STORAGE_KEY, session);
      }
      this.sessionId = session;
      this.ratingShown = this.getRatingShownState();
      this.ratingSubmitted = this.getRatingSubmittedState();
    }

    getRatingShownKey() {
      return `witzo_chat_rating_shown_${this.sessionId}`;
    }

    getRatingSubmittedKey() {
      return `witzo_chat_rating_submitted_${this.sessionId}`;
    }

    getRatingShownState() {
      return sessionStorage.getItem(this.getRatingShownKey()) === '1';
    }

    getRatingSubmittedState() {
      return sessionStorage.getItem(this.getRatingSubmittedKey()) === '1';
    }

    setRatingShownState(value) {
      this.ratingShown = value;
      sessionStorage.setItem(this.getRatingShownKey(), value ? '1' : '0');
    }

    setRatingSubmittedState(value) {
      this.ratingSubmitted = value;
      sessionStorage.setItem(this.getRatingSubmittedKey(), value ? '1' : '0');
    }

    normalizeLanguageCode(value) {
      if (typeof value !== 'string') return null;
      const normalized = value.trim().toLowerCase();
      if (!normalized) return null;
      const isSupported = this.supportedLanguages.some((language) => language.code === normalized);
      return isSupported ? normalized : null;
    }

    getLanguageStorageKey() {
      return `witzo_chat_language_${this.widgetKey || 'default'}`;
    }

    initializeLanguagePreference() {
      const configuredLanguage =
        this.normalizeLanguageCode(this.config.defaultLanguage) || 'en';
      const storageKey = this.getLanguageStorageKey();
      const storedLanguage = this.normalizeLanguageCode(
        sessionStorage.getItem(storageKey),
      );
      const hasConfiguredDefaultLanguageAttr =
        this.getAttribute('default-language') !== null;

      // Dashboard-configured default language should win on initial widget load.
      this.selectedLanguage = hasConfiguredDefaultLanguageAttr
        ? configuredLanguage
        : (storedLanguage || configuredLanguage);
      this.config.defaultLanguage = this.selectedLanguage;
      sessionStorage.setItem(storageKey, this.selectedLanguage);

      console.log(this.selectedLanguage, 'this.selectedLanguage');

    }

    resetConversationRatingState() {
      this.pendingEndIntentRating = false;
      this.setRatingShownState(false);
      this.setRatingSubmittedState(false);
      if (this.elements && this.elements.conversationRatingSlot) {
        this.elements.conversationRatingSlot.innerHTML = '';
        this.elements.conversationRatingSlot.classList.add('hidden');
      }
    }

    isConversationEndMessage(text) {
      if (!text) return false;
      const normalized = String(text).toLowerCase().trim();
      if (!normalized) return false;

      const endPatterns = [
        /\b(thanks|thank you|thankyou|thx)\b/,
        /\b(bye|goodbye|see you|see ya|take care)\b/,
        /\b(that'?s all|thats all|done|resolved|got it)\b/,
        /\b(no thanks|no thank you|i'?m good|im good)\b/,
      ];

      return endPatterns.some((pattern) => pattern.test(normalized));
    }


    render() {
      // Use the CSS and HTML from template.ts
      this.shadowRoot.innerHTML = `
      <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap');
          *,
          ::after,
          ::before {
            box-sizing: border-box;
          }
          :host {
            font-family: 'Open Sans', sans-serif;
            display: block;
            /* width: 100%; height: 100%;  - Removed to avoid blocking clicks on the page */
          }
          #textChatWidget {
            position: fixed;
            bottom: 6em;
            right: 2em;
            z-index: 9999;
            width: 27rem;
            height: 100%;
            max-width: 90vw;
            max-height: 70vh;
            display: flex;
            flex-direction: column;
            border-radius: 15px;
            overflow: hidden;
            transition: width 0.4s ease-in-out, max-width 0.4s ease-in-out, max-height 0.4s ease-in-out;
            background: #fff; /* Ensure background is white */
          }
            .flex{
              display: flex;
              }

          .chat-widget {
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
            backdrop-filter: blur(10px);
            transform: translateY(20px);
            opacity: 0;
            animation: slideUp 0.4s ease-out forwards;
          }
          
          .hidden { display: none !important; }

          @keyframes slideUp {
            to {
              transform: translateY(0);
              opacity: 1;
            }
          }

          .chat-widget.minimizing {
            opacity: 1;
            transform: translateY(0px);
            animation: slideDown 0.3s ease-in forwards;
          }

          @keyframes slideDown {
            to {
              transform: translateY(20px);
              opacity: 0;
            }
          }

          /* Header */
          .chat-header {
            background: ${this.config.bannerColor || '#120b14'};
            padding: 0rem 1rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-shrink: 0;
            height: 60px; /* Fixed height for header */
            margin:10px;
            border-radius: 10px;
          }
          .chat-header-left {
            display: flex;
            width: auto;
            justify-content: space-between;
            align-items: center;
            gap: 0.75rem;
          }
          .chat-icon {
            width: auto;
            border-radius: 0.75rem;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .bot-msg-chat-icon {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            padding:4px;
            margin-right:6px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0px 2.4px 4.8px 0px #00000033;

          }
            .bot-msg-chat-icon img{
              width: 100%;
              height: 100%;
              object-fit: contain;
            }
          .chat-title {
            color: #fff;
            font-size: 20px;
            font-weight: 600;
            letter-spacing: -0.14px;
            margin: 0;
          }
          .chat-header-right {
            display: flex;
            align-items: center;
          }
          .chat-action-btn {
            border: none;
            background: transparent;
            border-radius: 0.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            margin-left: 0.5rem;
            padding: 0;
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
          }
          .chat-message { display: flex; align-items: flex-start; gap: 0.75rem; }
          
          /* Bubbles */
          .chat-bubble-ai { 
            padding: 0; 
            max-width: 280px; 
            color: #0f172a; 
            font-size: 0.875rem; 
            line-height: 1.3; 
          }
          .chat-bubble-user {
            background: ${this.config.userChatColor || '#ffdde4'}; /* Default or Config */
            color: #000;
            border-radius: 11px 0 11px 11px;
            padding: 10px 22px;
            max-width: 280px;
            font-size: 0.875rem;
            line-height: 1.3;
          }
          
          .chat-message.user {
            display: flex;
            flex-direction: row;
            gap: 0.5em;
            justify-content: flex-end;
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
            right: 52px;
            top: 50%;
            transform: translateY(-50%);
            display: flex;
            align-items: center;
            gap: 5px;
            background: #f1f3f5;
            border-radius: 9999px;
            padding: 5px 10px 5px 7px;
            cursor: pointer;
            font-size: 0.72rem;
            font-weight: 700;
            color: #1a1a2e;
            letter-spacing: 0.04em;
            user-select: none;
            transition: background 0.15s;
            z-index: 2;
          }
          .lang-pill:hover { background: #e2e8f0; }
          .lang-pill svg { flex-shrink: 0; }
          .lang-pill-select {
            position: absolute;
            opacity: 0;
            inset: 0;
            width: 100%;
            height: 100%;
            cursor: pointer;
            font-size: 1rem;
          }
          .chat-text-input {
            padding-right: 120px !important;
          }
          .chat-title-paragraph{
            color: #999;
            font-size: 10px;
            font-weight: 600;
            margin: 0;
            align-self: flex-start;
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
            padding: 0.75rem 1rem;
            font-size: 0.875rem;
            outline: none;
            border:1px solid rgba(149, 157, 165, 0.2);
            box-shadow: rgba(149, 157, 165, 0.2) 0px 8px 24px;
            


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
          }

          .chat-send-icon{
            width: 3rem;
            height: 3rem;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 0.75rem;
            background: ${this.config.sendColor};
          }
          
          /* Footer */
          .chat-footer {
            padding-bottom: 10px;
          }
          .powered-by {
            text-align: center;
            font-size: 10px;
            font-weight: 500;
            color: #999;
            margin: 6px 0 0 0;
            padding: 0;
            opacity: 0.7;
          }
          .powered-by-brand {
             font-weight: 700;
             color: #666;
             text-decoration: none;
             cursor: pointer;
          }
          
          /* Floating Button */
          #floatingBtn {
            bottom: 15px;
            position: fixed;
            right: 45px;
            z-index: 9999;
            animation: float 3s ease-in-out infinite;
          }
          .floating-btn {
            cursor: pointer;
            align-items: center;
            background: ${this.config.floatingBtn || this.config.floatingBtnColor || '#fc0e3f'};
            border: 0;
            border-radius: 9999px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
            color: #fff;
            display: flex;
            filter: brightness(1.15);
            font-weight: 500;
            overflow: hidden;
            padding: 1.25rem;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
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
              background: #ececec;
              border-radius: 50px;
              padding: 7px 15px;
              font-size: 14px;
              color: #666;
            }
           .typing-dots-text  {
            font-size: 1.5rem;
            line-height: 0.5;
            animation: fadeInOut 1.5s infinite;
            opacity: 0;
          }
           .typing-dots-text:nth-child(1) { animation-delay: 0s; }
           .typing-dots-text:nth-child(2) { animation-delay: 0.5s; }
           .typing-dots-text:nth-child(3) { animation-delay: 1s; }
           
           @keyframes fadeInOut {
            0%, 100% { opacity: 0; }
            50% { opacity: 1; }
          }

           #logoIcon{
            width: 40px;
            height: 40px;
            border-radius: 8px;
            object-fit: contain;
            }
            .bot-message-row {
              display: flex;
              flex-direction: row;
              align-items: flex-start;
              gap: 0.5rem;
            }
            .bot-message-row .bot-msg-chat-icon {
              flex-shrink: 0;
            }
            
            /* Markdown Styles inside bubbles */
            .md-content p { margin: 0; }
            .md-content ul, .md-content ol { padding-left: 20px; margin: 5px 0; }
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

            /* Hope Banner */
            .hope-banner {
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 0.6rem;
              margin: 0 10px 6px 10px;
              padding: 10px 18px;
              border-radius: 9999px;
              background: #faf8ff;
              border: 1.5px solid transparent;
              background-clip: padding-box;
              box-shadow: inset 0 0 0 1.5px transparent;
              position: relative;
              font-size: 0.9rem;
              font-weight: 500;
              color: #1a1a2e;
              flex-shrink: 0;
            }
            .hope-banner::before {
              content: '';
              position: absolute;
              inset: 0;
              border-radius: 9999px;
              padding: 1.5px;
              background: linear-gradient(135deg, #a855f7, #6366f1, #ec4899);
              -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
              -webkit-mask-composite: xor;
              mask-composite: exclude;
              pointer-events: none;
            }
            .hope-banner-text {
              flex: 1;
              text-align: center;
            }
            .hope-banner-btn {
              background: transparent;
              border: none;
              cursor: pointer;
              font-size: 1.2rem;
              padding: 0 2px;
              line-height: 1;
              transition: transform 0.15s;
            }
            .hope-banner-btn:hover { transform: scale(1.25); }
            .hope-banner-btn.active { filter: drop-shadow(0 0 4px #6366f1); }
            .hope-banner.hidden { display: none; }

      </style>

        <!-- Chat Widget Box -->
        <div id="textChatWidget" class="chat-widget hidden">
            <!-- Header -->
            <div id="chat-header" class="chat-header">
                
                <div class="chat-header-left">
                     <div class="chat-icon">
                        ${this.config.logoIcon
          ? `<img id="logoIcon" src="${this.config.logoIcon}" alt="Logo" />`
          : `<svg width="32" height="32" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 6C13.66 6 15 7.34 15 9C15 10.66 13.66 12 12 12C10.34 12 9 10.66 9 9C9 7.34 10.34 6 12 6ZM12 19.2C9.5 19.2 7.29 17.92 6 15.98C6.03 13.99 10 12.9 12 12.9C13.99 12.9 17.97 13.99 18 15.98C16.71 17.92 14.5 19.2 12 19.2Z"/></svg>`
        }
                    </div>
                     <div class="online-ready">
                        <div class="online-ready-text">
                        <h3 id="banner-text" class="chat-title" style="color: ${this.config.bannerTextColor || '#fff'}">${this.config.bannerText}</h3>
                        </div>
                    </div>
                </div>
                <div class="chat-header-right">
                    <button id="closeTextChat" class="chat-action-btn">
                         
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="${this.config.closeButtonColor || 'white'}" style="&#10;">
                            <path d="M19.707 18.292C19.7999 18.3849 19.8736 18.4952 19.9238 18.6166C19.9741 18.738 20 18.8681 20 18.9995C20 19.1309 19.9741 19.261 19.9238 19.3824C19.8736 19.5038 19.7999 19.6141 19.707 19.707C19.6141 19.7999 19.5038 19.8736 19.3824 19.9238C19.261 19.9741 19.1309 20 18.9995 20C18.8681 20 18.738 19.9741 18.6166 19.9238C18.4952 19.8736 18.3849 19.7999 18.292 19.707L10 11.4137L1.70796 19.707C1.52033 19.8946 1.26585 20 1.0005 20C0.735151 20 0.48067 19.8946 0.29304 19.707C0.105409 19.5193 5.23067e-09 19.2648 0 18.9995C-5.23067e-09 18.7341 0.105409 18.4797 0.29304 18.292L8.58633 10L0.29304 1.70796C0.105409 1.52033 0 1.26585 0 1.0005C0 0.735151 0.105409 0.48067 0.29304 0.29304C0.48067 0.105409 0.735151 0 1.0005 0C1.26585 0 1.52033 0.105409 1.70796 0.29304L10 8.58633L18.292 0.29304C18.4797 0.105409 18.7341 -5.23067e-09 18.9995 0C19.2648 5.23067e-09 19.5193 0.105409 19.707 0.29304C19.8946 0.48067 20 0.735151 20 1.0005C20 1.26585 19.8946 1.52033 19.707 1.70796L11.4137 10L19.707 18.292Z" fill="${this.config.closeButtonColor || 'white'}"/>
                        </svg>
                    </button>
                </div>
            </div>

            <!-- Hope Banner (shown after first user message) -->
            <div id="hopeBanner" class="hope-banner hidden">
              <span class="hope-banner-text">Hope that helped!</span>
              <button class="hope-banner-btn" id="hopeBannerUp" title="Thumbs up">&#128077;</button>
              <button class="hope-banner-btn" id="hopeBannerDown" title="Thumbs down">&#128078;</button>
            </div>

            <!-- Messages Area -->
            <div id="textMessagesArea" class="chat-messages">
                <!-- Messages will be appended here -->
            </div>

            <!-- Contact Form (basic plan — shown when conversation limit hit) -->
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
                <p id="banner-text-paragraph" class="chat-title-paragraph" style="color: ${this.config.bannerTextParagraphColor || '#999'}"></p>
                <div class="chat-input-container">
                    <input id="textMessageInput" type="text" placeholder="Type your message..." class="chat-text-input" />
                    <!-- Language Pill -->
                    <div class="lang-pill" id="langPillBtn">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1a1a2e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                      </svg>
                      <span id="langPillCode">${(this.selectedLanguage || 'en').slice(0, 2).toUpperCase()}</span>
                      <select id="languageSelector" class="lang-pill-select">
                          ${this.supportedLanguages
          .map((language) =>
            `<option value="${language.code}" ${language.code === this.selectedLanguage ? "selected" : ""}>${language.label}</option>`,
          )
          .join("")}
                      </select>
                    </div>
                    <button class="chat-send-btn" id="textSendButton">
                        <div class="chat-send-icon">
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="17" viewBox="0 0 14 17" fill="${this.config.sendColor}">
                            <path d="M13.4777 7.32307C13.4142 7.38665 13.3388 7.43709 13.2558 7.47151C13.1728 7.50592 13.0838 7.52364 12.9939 7.52364C12.904 7.52364 12.815 7.50592 12.732 7.47151C12.649 7.43709 12.5736 7.38665 12.5101 7.32307L7.52294 2.3351V15.7295C7.52294 15.9109 7.45089 16.0848 7.32264 16.2131C7.19439 16.3413 7.02044 16.4134 6.83907 16.4134C6.6577 16.4134 6.48375 16.3413 6.3555 16.2131C6.22725 16.0848 6.1552 15.9109 6.1552 15.7295V2.3351L1.16809 7.32307C1.03976 7.45139 0.865723 7.52348 0.684249 7.52348C0.502775 7.52348 0.328734 7.45139 0.200412 7.32307C0.0720903 7.19474 1.35209e-09 7.0207 0 6.83923C-1.35209e-09 6.65775 0.0720903 6.48371 0.200412 6.35539L6.35523 0.20057C6.41875 0.136986 6.49417 0.0865445 6.57719 0.0521293C6.66021 0.017714 6.7492 0 6.83907 0C6.92894 0 7.01793 0.017714 7.10095 0.0521293C7.18397 0.0865445 7.2594 0.136986 7.32291 0.20057L13.4777 6.35539C13.5413 6.4189 13.5918 6.49433 13.6262 6.57735C13.6606 6.66037 13.6783 6.74936 13.6783 6.83923C13.6783 6.9291 13.6606 7.01809 13.6262 7.10111C13.5918 7.18413 13.5413 7.25955 13.4777 7.32307Z" fill="white"/>
                          </svg>
                        </div>
                    </button>
                </div>
            </div>
            
            <div class="chat-footer">
                <h3 class="powered-by">
                powered by 
                <a href="https://witzo.ai/" target="_blank" rel="noopener noreferrer" class="powered-by-brand">
                    witzo
                </a>
                </h3>
            </div>
        </div>

        <!-- Floating Chat Button -->
        <div id="floatingBtn" class="floating">
            <button class="floating-btn hidden" id="floating-btn">
                 <svg width="32" height="32" viewBox="0 0 32 26" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path fill-rule="evenodd" clip-rule="evenodd" d="M0.375 6.3125C0.375 3.27493 2.83743 0.8125 5.875 0.8125H25.8125C28.8501 0.8125 31.3125 3.27493 31.3125 6.3125V15.1743L27.5114 13.7677C27.411 13.7306 27.3319 13.6515 27.2948 13.5511L25.4689 8.6168C25.3507 8.29761 24.8993 8.29761 24.7811 8.6168L22.9552 13.5511C22.9181 13.6515 22.839 13.7306 22.7386 13.7677L17.8043 15.5936C17.4851 15.7118 17.4851 16.1632 17.8043 16.2814L22.7386 18.1073C22.839 18.1444 22.9181 18.2235 22.9552 18.3239L24.3618 22.125H18.9339C18.9202 22.1484 18.9049 22.1714 18.888 22.1939L16.3936 25.5174C16.1186 25.8838 15.5689 25.8838 15.2939 25.5174L12.7994 22.1939C12.7826 22.1714 12.7673 22.1484 12.7536 22.125H5.875C2.83743 22.125 0.375 19.6626 0.375 16.625V6.3125ZM19.1094 8.15215C19.0504 7.99255 18.8246 7.99255 18.7656 8.15215L18.4097 9.11387C18.3911 9.16405 18.3516 9.20363 18.3014 9.2222L17.3397 9.57808C17.1801 9.6371 17.1801 9.8629 17.3397 9.92192L18.3014 10.2778C18.3516 10.2964 18.3911 10.3359 18.4097 10.3861L18.7656 11.3478C18.8246 11.5074 19.0504 11.5074 19.1094 11.3478L19.4653 10.3861C19.4839 10.3359 19.5234 10.2964 19.5736 10.2778L20.5353 9.92192C20.6949 9.8629 20.6949 9.6371 20.5353 9.57808L19.5736 9.2222C19.5234 9.20363 19.4839 9.16405 19.4653 9.11387L19.1094 8.15215Z" fill="white"/>
                  </svg>
            </button>
        </div>
      `;

      // Cache elements
      this.elements = {
        widget: this.shadowRoot.getElementById('textChatWidget'),
        floatingBtn: this.shadowRoot.getElementById('floating-btn'),
        closeBtn: this.shadowRoot.getElementById('closeTextChat'),
        messagesContainer: this.shadowRoot.getElementById('textMessagesArea'),
        input: this.shadowRoot.getElementById('textMessageInput'),
        sendBtn: this.shadowRoot.getElementById('textSendButton'),
        languageSelector: this.shadowRoot.getElementById('languageSelector'),
        contactFormSlot: this.shadowRoot.getElementById('contactFormSlot'),
        cfName: this.shadowRoot.getElementById('cf-name'),
        cfEmail: this.shadowRoot.getElementById('cf-email'),
        cfMessage: this.shadowRoot.getElementById('cf-message'),
        cfSubmit: this.shadowRoot.getElementById('cf-submit'),
        chatInput: this.shadowRoot.querySelector('.chat-input'),
        conversationRatingSlot: this.shadowRoot.getElementById('conversationRatingSlot'),
        hopeBanner: this.shadowRoot.getElementById('hopeBanner'),
        hopeBannerUp: this.shadowRoot.getElementById('hopeBannerUp'),
        hopeBannerDown: this.shadowRoot.getElementById('hopeBannerDown'),
      };
    }

    bindEvents() {
      this.elements.floatingBtn.addEventListener('click', () => this.toggleChat());
      this.elements.closeBtn.addEventListener('click', () => this.toggleChat());

      this.elements.sendBtn.addEventListener('click', () => this.handleSend());
      this.elements.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.handleSend();
        }
      });
      if (this.elements.languageSelector) {
        this.elements.languageSelector.addEventListener('change', () => {
          // Read directly from the element — avoids event.target ambiguity when events bubble
          const rawValue = this.elements.languageSelector.value;
          const nextLanguage = rawValue || 'en';
          console.log('Language changed to:', nextLanguage);
          this.selectedLanguage = nextLanguage;
          this.config.defaultLanguage = nextLanguage;
          sessionStorage.setItem(this.getLanguageStorageKey(), nextLanguage);
          // Update pill label
          const pillCode = this.shadowRoot.getElementById('langPillCode');
          if (pillCode) pillCode.textContent = nextLanguage.slice(0, 2).toUpperCase();
        });
      }
    }

    toggleChat() {
      if (!this.isOpen) {
        // Open
        this.isOpen = true;
        this.elements.widget.classList.remove('hidden');
        this.elements.widget.classList.remove('minimizing');
        this.elements.floatingBtn.classList.add('hidden');
        setTimeout(() => this.elements.input.focus(), 100);
      } else {
        // Close
        this.isOpen = false;
        this.elements.widget.classList.add('minimizing');
        setTimeout(() => {
          this.elements.widget.classList.add('hidden');
          this.elements.floatingBtn.classList.remove('hidden');
        }, 300);
      }
    }

    async handleSend() {
      const text = this.elements.input.value.trim();
      if (!text) return;

      // Reset chat count if time gap large (simple version)
      const gap = new Date().getTime() - this.date.getTime();
      if (gap > 2 * 60 * 1000) {
        this.successfulChatCount = 0;
        this.date = new Date();
        this.userMessageCount = 0;
        this.botMessageCount = 0;
        this.resetConversationRatingState();
      }

      // Add User Message
      this.appendMessage(text, 'user');
      this.userMessageCount += 1;
      this.pendingEndIntentRating = this.config.planType === 'basic'
        && this.isConversationEndMessage(text)
        && !this.ratingShown
        && !this.ratingSubmitted;
      this.elements.input.value = '';

      // Show Typing Indicator
      const typingWrapper = this.showTypingIndicator();

      try {
        const body = {
          widgetKey: this.widgetKey,
          message: text,
          sessionId: this.sessionId,
          language: this.selectedLanguage,
        };

        const url = this.apiUrl.includes('?')
          ? `${this.apiUrl}&stream=1`
          : `${this.apiUrl}?stream=1`;

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream, application/json'
          },
          body: JSON.stringify(body)
        });

        let content = "Sorry, didn't get that.";
        const contentType = (response.headers.get('content-type') || '').toLowerCase();

        if (response.ok && response.body && contentType.includes('text/event-stream')) {
          const streamResult = await this.consumeStreamedResponse(response, typingWrapper);
          if (streamResult && streamResult.completed) {
            this.successfulChatCount++;
            sessionStorage.setItem('witzo_chat_count', `${this.successfulChatCount}`);
          }
          return;
        }

        const rawText = await response.text();

        if (response.ok) {
          try {
            const result = JSON.parse(rawText);
            // Support both old and new response formats
            content = result.response || result.output || result.message || content;

            // Update sessionId if provided
            if (result.sessionId) {
              this.sessionId = result.sessionId;
              sessionStorage.setItem('witzo_chat_session_token', result.sessionId);
              this.ratingShown = this.getRatingShownState();
              this.ratingSubmitted = this.getRatingSubmittedState();
            }
          } catch (e) {
            console.error('JSON Error', e);
          }
          this.successfulChatCount++;
          sessionStorage.setItem('witzo_chat_count', `${this.successfulChatCount}`);
          this.appendBotReply(typingWrapper, content);
          return;
        } else {
          try {
            const err = JSON.parse(rawText);
            if (err.limitReached && err.data?.planType === 'basic') {
              this.updateTypingToMessage(typingWrapper,
                "You've reached the conversation limit. Please use the form below to get in touch."
              );
              this.pendingEndIntentRating = false;
              this.showContactForm();
              return;
            }
            content = err.message || content;
          } catch (e) { }
        }

        // Replace typing indicator with response (error / free plan limit)
        this.updateTypingToMessage(typingWrapper, content);
        this.pendingEndIntentRating = false;

      } catch (error) {
        console.error('Network Error', error);
        this.updateTypingToMessage(typingWrapper, "Sorry, network error occurred.");
        this.pendingEndIntentRating = false;
      }
    }

    appendMessage(text, type) {
      const wrapper = document.createElement('div');
      wrapper.className = `chat-message ${type === 'user' ? 'user' : ''}`;

      const bubble = document.createElement('div');
      // Type 'user' gets chat-bubble-user, bot gets chat-bubble-ai
      bubble.className = type === 'user' ? 'chat-bubble-user' : 'chat-bubble-ai';

      // Render content
      bubble.innerHTML = `<div class="md-content"><p>${this.parseMarkdown(this.escapeHtml(text))}</p></div>`;

      wrapper.appendChild(bubble);
      this.elements.messagesContainer.appendChild(wrapper);
      this.elements.messagesContainer.scrollTop = this.elements.messagesContainer.scrollHeight;
    }

    showTypingIndicator() {
      const wrapper = document.createElement('div');
      wrapper.className = 'chat-message';

      const bubble = document.createElement('div');
      bubble.className = 'typing-indicator chat-bubble-ai'; // Borrow styles
      bubble.innerHTML = `
            <div class="typing-container">
                <span class="typing-dots-text">.</span>
                <span class="typing-dots-text">.</span>
                <span class="typing-dots-text">.</span>
            </div>
        `;

      wrapper.appendChild(bubble);
      this.elements.messagesContainer.appendChild(wrapper);
      this.elements.messagesContainer.scrollTop = this.elements.messagesContainer.scrollHeight;
      return wrapper;
    }

    getBotIconHtml() {
      return `<div class="bot-msg-chat-icon">
                        ${this.config.logoIcon
          ? `<img src="${this.config.logoIcon}" alt="Logo" />`
          : `<svg width="32" height="32" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 6C13.66 6 15 7.34 15 9C15 10.66 13.66 12 12 12C10.34 12 9 10.66 9 9C9 7.34 10.34 6 12 6ZM12 19.2C9.5 19.2 7.29 17.92 6 15.98C6.03 13.99 10 12.9 12 12.9C13.99 12.9 17.97 13.99 18 15.98C16.71 17.92 14.5 19.2 12 19.2Z"/></svg>`
        }
                    </div>`;
    }

    updateTypingToMessage(wrapper, text) {
      const bubble = wrapper.querySelector('.typing-indicator');
      if (bubble) {
        bubble.classList.remove('typing-indicator');
        bubble.innerHTML = `<div class="bot-message-row">${this.getBotIconHtml()}<div class="md-content">${this.parseMarkdown(text)}</div></div>`;
      } else {
        const bubbleNode = wrapper.querySelector('.chat-bubble-ai');
        if (bubbleNode) {
          bubbleNode.innerHTML = `<div class="bot-message-row">${this.getBotIconHtml()}<div class="md-content">${this.parseMarkdown(text)}</div></div>`;
        }
      }
      this.elements.messagesContainer.scrollTop = this.elements.messagesContainer.scrollHeight;
    }

    async consumeStreamedResponse(response, typingWrapper) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assembled = '';
      let donePayload = null;
      let streamHadError = false;

      const processEvent = (payload) => {
        if (!payload || !payload.type) return;
        if (payload.type === 'token' && typeof payload.token === 'string') {
          assembled += payload.token;
          this.updateTypingToMessage(typingWrapper, assembled);
          return;
        }
        if (payload.type === 'done') {
          donePayload = payload;
          return;
        }
        if (payload.type === 'error') {
          streamHadError = true;
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const rawEvent of events) {
          const lines = rawEvent.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonPart = line.slice(6).trim();
            if (!jsonPart) continue;
            try {
              processEvent(JSON.parse(jsonPart));
            } catch (_) { }
          }
        }
      }

      if (buffer.trim().startsWith('data:')) {
        const jsonPart = buffer.replace(/^data:\s*/, '').trim();
        if (jsonPart) {
          try {
            processEvent(JSON.parse(jsonPart));
          } catch (_) { }
        }
      }

      if (streamHadError) {
        this.updateTypingToMessage(typingWrapper, "Sorry, network error occurred.");
        this.pendingEndIntentRating = false;
        return { completed: false };
      }

      if (donePayload && donePayload.sessionId) {
        this.sessionId = donePayload.sessionId;
        sessionStorage.setItem('witzo_chat_session_token', donePayload.sessionId);
        this.ratingShown = this.getRatingShownState();
        this.ratingSubmitted = this.getRatingSubmittedState();
      }

      if (!assembled.trim()) {
        this.updateTypingToMessage(typingWrapper, "Sorry, didn't get that.");
        this.pendingEndIntentRating = false;
        return { completed: false };
      }

      this.appendBotReply(typingWrapper, assembled);
      return { completed: true };
    }

    appendBotReply(typingWrapper, text) {
      this.updateTypingToMessage(typingWrapper, text);
      this.botMessageCount += 1;

      // Show rating only once per session and only when conversation-end intent is detected.
      const shouldShowConversationRating = this.config.planType === 'basic'
        && this.pendingEndIntentRating
        && !this.ratingShown
        && !this.ratingSubmitted
        && this.userMessageCount > 0
        && this.botMessageCount > 0;

      if (shouldShowConversationRating) {
        if (!this.elements.conversationRatingSlot) {
          this.pendingEndIntentRating = false;
          return;
        }
        const ratingRow = document.createElement('div');
        ratingRow.className = 'rating-row';
        ratingRow.innerHTML = `
                <span class="rating-label">Rate this conversation</span>
                <button class="rating-btn" data-rating="up" title="Thumbs up">&#128077;</button>
                <button class="rating-btn" data-rating="down" title="Thumbs down">&#128078;</button>
            `;
        ratingRow.querySelectorAll('.rating-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const chosen = e.currentTarget.dataset.rating;
            ratingRow.querySelectorAll('.rating-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            if (this.elements.conversationRatingSlot) {
              this.elements.conversationRatingSlot.innerHTML = '';
              this.elements.conversationRatingSlot.classList.add('hidden');
            }
            this.submitRating(chosen);
          });
        });
        this.elements.conversationRatingSlot.innerHTML = '';
        this.elements.conversationRatingSlot.appendChild(ratingRow);
        this.elements.conversationRatingSlot.classList.remove('hidden');
        this.elements.messagesContainer.scrollTop = this.elements.messagesContainer.scrollHeight;
        this.setRatingShownState(true);
      }

      this.pendingEndIntentRating = false;
    }

    async submitRating(rating) {
      try {
        await fetch(this.apiBaseUrl + '/api/v1/widget/rating', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            widgetKey: this.widgetKey,
            sessionId: this.sessionId,
            rating,
          }),
        });
        this.setRatingSubmittedState(true);
        if (this.elements.conversationRatingSlot) {
          this.elements.conversationRatingSlot.innerHTML = '';
          this.elements.conversationRatingSlot.classList.add('hidden');
        }
      } catch (e) {
        // Non-fatal — silently ignore
      }
    }

    showContactForm() {
      if (!this.elements.contactFormSlot) return;
      this.elements.messagesContainer.classList.add('hidden');
      if (this.elements.chatInput) this.elements.chatInput.classList.add('hidden');
      this.elements.contactFormSlot.classList.remove('hidden');

      if (!this._cfBound) {
        this._cfBound = true;
        this.elements.cfSubmit.addEventListener('click', () => this.submitContactForm());
      }
    }

    async submitContactForm() {
      const email = this.elements.cfEmail ? this.elements.cfEmail.value.trim() : '';
      if (!email) {
        if (this.elements.cfEmail) this.elements.cfEmail.style.borderColor = '#ef4444';
        return;
      }
      if (this.elements.cfSubmit) {
        this.elements.cfSubmit.disabled = true;
        this.elements.cfSubmit.textContent = 'Sending...';
      }
      try {
        const resp = await fetch(this.apiBaseUrl + '/api/v1/widget/contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            widgetKey: this.widgetKey,
            sessionId: this.sessionId,
            name: this.elements.cfName ? this.elements.cfName.value.trim() || null : null,
            email,
            message: this.elements.cfMessage ? this.elements.cfMessage.value.trim() || null : null,
          }),
        });
        if (resp.ok) {
          this.elements.contactFormSlot.innerHTML =
            '<div class="contact-form-success">✓ Message sent! We\'ll be in touch soon.</div>';
        } else {
          if (this.elements.cfSubmit) {
            this.elements.cfSubmit.disabled = false;
            this.elements.cfSubmit.textContent = 'Send Message';
          }
        }
      } catch (e) {
        if (this.elements.cfSubmit) {
          this.elements.cfSubmit.disabled = false;
          this.elements.cfSubmit.textContent = 'Send Message';
        }
      }
    }

    displayDefaultMessage() {
      const wrapper = document.createElement('div');
      wrapper.className = 'chat-message';
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble-ai';
      bubble.innerHTML = `<div class="bot-message-row">${this.getBotIconHtml()}<div class="md-content">${this.parseMarkdown(this.config.primaryText)}</div></div>`;
      wrapper.appendChild(bubble);
      this.elements.messagesContainer.appendChild(wrapper);
    }

    parseMarkdown(text) {
      if (!text) return '';
      // Simple markdown parsing to match text-widget capabilities
      let html = text;

      // Bold **text**
      html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

      // Links [text](url)
      html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, txt, url) => {
        return `<a href="${sanitizeURL(url)}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
      });

      // Newlines to br
      html = html.replace(/\n/g, '<br>');

      return html;
    }

    escapeHtml(text) {
      return text.replace(/[&<>"']/g, function (m) {
        return {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#039;'
        }[m];
      });
    }
  }

  // Register the custom element
  if (!customElements.get('witzo-chat')) {
    customElements.define('witzo-chat', WitzoChatWidget);
  }
})();

