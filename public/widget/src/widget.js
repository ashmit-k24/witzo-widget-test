import { DEFAULT_CONFIG, SUPPORTED_LANGUAGES, ATTR_LIST } from './config.js';
import * as session from './session.js';
import * as api from './api.js';
import * as stream from './stream.js';
import * as msg from './messages.js';
import * as events from './events.js';
import { buildTemplate } from './template.js';
import { buildCSS } from '../styles/index.js';

function normalizeFloatingType(value) {
  const normalized = String(value || 'small').trim().toLowerCase();
  if (normalized === 'full' || normalized === 'full-size' || normalized === 'full size' || normalized === 'fullsize') return 'full';
  if (normalized === 'compact') return 'compact';
  return 'small';
}

export class WitzoChatWidget extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    // Instance state
    this.apiUrl = '';
    this.apiBaseUrl = '';
    this.widgetKey = '';
    this.sessionId = '';
    this.isOpen = false;
    this.date = new Date();
    this._cfBound = false;
    this.elements = {};

    // Counters
    this.successfulChatCount = 0;
    this.userMessageCount = 0;
    this.botMessageCount = 0;

    // Rating state
    this.pendingEndIntentRating = false;
    this.ratingShown = false;
    this.ratingSubmitted = false;

    // Hope banner state
    this._wasEndIntent = false;
    this._idleTimer = null;
    this._pendingHopeBanner = false;
    this._ratingToastTimer = null;
    this._calendlyAssetPromise = null;
    this._calendlyMessageHandler = null;
    this._calendlyBookingActive = false;
    this._leadFormCompleted = false;
    this._leadFormStatusChecking = false;
    this._lastLeadFinalizeSessionId = null;
    this._pageHideHandler = () => this.finalizePendingLeadDraft();
    this._visibilityHandler = () => {
      if (document.visibilityState === 'hidden') this.finalizePendingLeadDraft();
    };

    // Auto-open timer (cleared on first manual interaction)
    this._autoOpenTimer = null;

    // Daily session limit state
    this._sessionLocked = false;
    this.isAwaitingResponse = false;
    this._activeResponseCount = 0;
    this._hasVisibleStreamingResponse = false;
    this._queuedSendAfterResponse = false;

    this.selectedLanguage = 'en';
    this.config = { ...DEFAULT_CONFIG };
  }

  _hasPaidFeatures() {
    return this.config.planType && this.config.planType !== 'free';
  }

  connectedCallback() {
    // 1. Read HTML attributes into config
    this.apiUrl = this.getAttribute('api-url') || '';
    this.apiBaseUrl = this.getAttribute('api-base-url') || this.apiUrl.replace('/api/v1/webhook', '');
    this.widgetKey = this.getAttribute('widget-key') || '';
    window.addEventListener('pagehide', this._pageHideHandler);
    document.addEventListener('visibilitychange', this._visibilityHandler);

    ATTR_LIST.forEach(attr => {
      const val = this.getAttribute(attr);
      if (val === null) return;
      const key = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.config[key] = val === 'true' ? true : val === 'false' ? false : val;
    });
    this.config.floatingType = normalizeFloatingType(this.config.floatingType);

    // 2. Init session
    const sess = session.initSession();
    this.date = sess.date;
    this.successfulChatCount = sess.count;
    this.sessionId = sess.sessionId;
    this.ratingShown = session.getRatingShown(this.sessionId);
    this.ratingSubmitted = session.getRatingSubmitted(this.sessionId);

    // 3. Init language preference
    const langKey = session.getLanguageKey(this.widgetKey);
    const configuredLang = session.normalizeLanguage(this.config.defaultLanguage, SUPPORTED_LANGUAGES) || 'en';
    const storedLang = session.normalizeLanguage(sessionStorage.getItem(langKey), SUPPORTED_LANGUAGES);
    this.selectedLanguage = this.getAttribute('default-language') !== null ? configuredLang : (storedLang || configuredLang);
    this.config.defaultLanguage = this.selectedLanguage;
    sessionStorage.setItem(langKey, this.selectedLanguage);

    // 3b. Default logo icon → witzo.png served from the widget-scoped public path
    if (!this.config.logoIcon) {
      this.config.logoIcon = `${this.apiBaseUrl.replace(/\/+$/, '')}/assets/images/witzo.png`;
    }
    // Preload logo icon and track readiness so the floating button is only
    // revealed once the image is fully loaded (prevents icon-flash on first show).
    this._logoReady = !this.config.logoIcon; // instantly ready when using the default SVG
    if (this.config.logoIcon) {
      const _preload = new Image();
      _preload.onload = () => { this._logoReady = true; this._maybeRevealFloatingBtn(); };
      _preload.onerror = () => { this._logoReady = true; this._maybeRevealFloatingBtn(); };
      _preload.src = this.config.logoIcon;
    }

    // 4. Load Inter into the document head so the shadow tree can inherit a resolved font face
    if (!document.getElementById('witzo-font-inter-preconnect')) {
      const preconnect = document.createElement('link');
      preconnect.id = 'witzo-font-inter-preconnect';
      preconnect.rel = 'preconnect';
      preconnect.href = 'https://fonts.googleapis.com';
      document.head.appendChild(preconnect);
    }
    if (!document.getElementById('witzo-font-inter-preconnect-crossorigin')) {
      const preconnectCrossorigin = document.createElement('link');
      preconnectCrossorigin.id = 'witzo-font-inter-preconnect-crossorigin';
      preconnectCrossorigin.rel = 'preconnect';
      preconnectCrossorigin.href = 'https://fonts.gstatic.com';
      preconnectCrossorigin.crossOrigin = 'anonymous';
      document.head.appendChild(preconnectCrossorigin);
    }
    if (!document.getElementById('witzo-font-inter')) {
      const link = document.createElement('link');
      link.id = 'witzo-font-inter';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap';
      document.head.appendChild(link);
    }

    // 5. Render shadow DOM
    this.shadowRoot.innerHTML = `
      <style>${buildCSS(this.config)}</style>
      ${buildTemplate(this.config, this.selectedLanguage, SUPPORTED_LANGUAGES)}
    `;

    // 6. Cache DOM references
    this.elements = {
      widget: this.shadowRoot.getElementById('textChatWidget'),
      floatingBtn: this.shadowRoot.getElementById('floating-btn'),
      closeBtn: this.shadowRoot.getElementById('closeTextChat'),
      messagesContainer: this.shadowRoot.getElementById('textMessagesArea'),
      input: this.shadowRoot.getElementById('textMessageInput'),
      sendBtn: this.shadowRoot.getElementById('textSendButton'),
      contactFormSlot: this.shadowRoot.getElementById('contactFormSlot'),
      calendlySlot: this.shadowRoot.getElementById('calendlySlot'),
      cfName: this.shadowRoot.getElementById('cf-name'),
      cfEmail: this.shadowRoot.getElementById('cf-email'),
      cfPhone: this.shadowRoot.getElementById('cf-phone'),
      cfPhoneDropdown: this.shadowRoot.getElementById('cf-phone-dropdown'),
      cfCountry: this.shadowRoot.getElementById('cf-country'),
      cfCountryTrigger: this.shadowRoot.getElementById('cf-country-trigger'),
      cfCountryValue: this.shadowRoot.getElementById('cf-country-value'),
      cfCountryDropdown: this.shadowRoot.getElementById('cf-country-dropdown'),
      cfCountrySearch: this.shadowRoot.getElementById('cf-country-search'),
      cfCountryList: this.shadowRoot.getElementById('cf-country-list'),
      cfSubmit: this.shadowRoot.getElementById('cf-submit'),
      cfMessage: this.shadowRoot.getElementById('cf-message'),
      chatInput: this.shadowRoot.querySelector('.chat-input'),
      conversationRatingSlot: this.shadowRoot.getElementById('conversationRatingSlot'),
      hopeBanner: this.shadowRoot.getElementById('hopeBanner'),
      hopeBannerUp: this.shadowRoot.getElementById('hopeBannerUp'),
      hopeBannerDown: this.shadowRoot.getElementById('hopeBannerDown'),
      langPillBtn: this.shadowRoot.getElementById('langPillBtn'),
      langDropdown: this.shadowRoot.getElementById('langDropdown'),
      langItems: this.shadowRoot.querySelectorAll('.lang-dropdown-item'),
    };

    // 6. Wire events
    events.bindEvents(this);
    this.updateSendButtonState();
    this._bindCalendlyMessageListener();

    // Track this page view for the session (fire-and-forget)
    api.trackPageView({ apiBaseUrl: this.apiBaseUrl, widgetKey: this.widgetKey, sessionId: this.sessionId });

    // 7. Show default message
    if (this.config.primaryText) {
      setTimeout(() => this.displayDefaultMessage(), 500);
    }

    // 7b. Lock session on load if daily limit already reached
    if (session.isDailyLimitReached(this.widgetKey)) {
      setTimeout(() => this._lockSession(), this.config.primaryText ? 800 : 100);
    }

    // 8. Auto-open after 5 s (cancelled on first manual interaction)
    if (this.config.autoOpen) {
      this._autoOpenTimer = setTimeout(() => { if (!this.isOpen) this.toggleChat(); }, 5000);
    }

    // 9. Reveal floating button after 2 s AND once the logo image is ready
    this._floatingBtnTimerFired = false;
    setTimeout(() => {
      this._floatingBtnTimerFired = true;
      this._maybeRevealFloatingBtn();
    }, 2000);
  }

  disconnectedCallback() {
    window.removeEventListener('pagehide', this._pageHideHandler);
    document.removeEventListener('visibilitychange', this._visibilityHandler);
    if (this._calendlyMessageHandler) {
      window.removeEventListener('message', this._calendlyMessageHandler);
      this._calendlyMessageHandler = null;
    }
  }

  // ── Delegated to events.js ──────────────────────────────────────
  toggleChat() { events.toggleChat(this); }
  handleLanguageSelect(code) { events.handleLanguageSelect(this, code); }
  setAwaitingResponse(isAwaiting) {
    if (isAwaiting) {
      this._activeResponseCount = (this._activeResponseCount || 0) + 1;
      this._hasVisibleStreamingResponse = false;
    } else {
      this._activeResponseCount = Math.max(0, (this._activeResponseCount || 0) - 1);
      if (this._activeResponseCount === 0) {
        this._hasVisibleStreamingResponse = false;
      }
    }
    this.isAwaitingResponse = this._activeResponseCount > 0;
    this.updateSendButtonState();
    if (!this.isAwaitingResponse) {
      this._flushQueuedSend();
    }
  }

  _flushQueuedSend() {
    if (!this._queuedSendAfterResponse) return;
    this._queuedSendAfterResponse = false;
    if (!this.elements?.input?.value.trim()) return;
    requestAnimationFrame(() => this.handleSend());
  }

  // ── Core send flow ───────────────────────────────────────────────
  async handleSend() {
    if (this.isAwaitingResponse && !this._hasVisibleStreamingResponse) {
      if (this.elements?.input?.value.trim()) {
        this._queuedSendAfterResponse = true;
      }
      return;
    }

    const text = this.elements.input.value.trim();
    if (!text) {
      this.updateSendButtonState();
      return;
    }

    // Block if daily session limit is already reached
    if (session.isDailyLimitReached(this.widgetKey)) {
      this._lockSession();
      return;
    }

    // Reset idle conversation state (> 2 min gap)
    if (Date.now() - this.date.getTime() > 2 * 60 * 1000) {
      this.successfulChatCount = 0;
      this.date = new Date();
      this.userMessageCount = 0;
      this.botMessageCount = 0;
      this._resetRatingState();
    }

    // Reset feedback prompt state when the user continues the conversation
    this._clearHopeBannerTimer();
    this._hideHopeBanner();

    msg.appendMessage(text, 'user', this.elements.messagesContainer);
    this.userMessageCount++;
    this._wasEndIntent = msg.isConversationEndMessage(text);
    this.pendingEndIntentRating = this._wasEndIntent
      && !this.ratingShown && !this.ratingSubmitted;
    this.elements.input.value = '';
    this.setAwaitingResponse(true);

    // Show typing indicator
    const typingEl = msg.createTypingIndicator(this.config.logoIcon);
    this.elements.messagesContainer.appendChild(typingEl);
    this.elements.messagesContainer.scrollTop = this.elements.messagesContainer.scrollHeight;

    try {
      const response = await api.sendMessage({
        apiUrl: this.apiUrl, widgetKey: this.widgetKey,
        sessionId: this.sessionId, message: text, language: this.selectedLanguage,
      });

      const contentType = (response.headers.get('content-type') || '').toLowerCase();

      // — Streaming (SSE) path —
      if (response.ok && response.body && contentType.includes('text/event-stream')) {
        const result = await stream.consumeStream(response, (assembled) => {
          msg.updateStreamingBubble(typingEl, assembled, this.config.logoIcon, this);
        });

        if (result.hadError) {
          msg.updateBubble(typingEl, "Sorry, a network error occurred.", this.config.logoIcon);
          this.pendingEndIntentRating = false;
          return;
        }
        if (result.donePayload?.sessionId) this._updateSession(result.donePayload.sessionId);
        if (!result.assembled.trim()) {
          msg.updateBubble(typingEl, "Sorry, didn't get that.", this.config.logoIcon);
          this.pendingEndIntentRating = false;
          return;
        }
        this.successfulChatCount = session.incrementChatCount(this.successfulChatCount);
        this.appendBotReply(typingEl, result.assembled, result.donePayload?.assistantMessageId);
        msg.appendSources(typingEl, result.donePayload?.sources);
        if (result.donePayload?.calendlyBooking) {
          this.showCalendlyEmbed(result.donePayload.calendlyBooking);
        }
        return;
      }

      // — JSON path —
      const rawText = await response.text();
      let content = "Sorry, didn't get that.";
      let jsonSources = [];
      let assistantMessageId = undefined;

      if (response.ok) {
        try {
          const result = JSON.parse(rawText);
          content = result.response || result.output || result.message || content;
          assistantMessageId = result.assistantMessageId;
          if (result.sessionId) this._updateSession(result.sessionId);
          if (Array.isArray(result.sources)) jsonSources = result.sources;
          if (result.calendlyBooking) {
            jsonSources = Array.isArray(result.sources) ? result.sources : [];
            this.successfulChatCount = session.incrementChatCount(this.successfulChatCount);
            this.appendBotReply(typingEl, content, result.assistantMessageId);
            msg.appendSources(typingEl, jsonSources);
            this.showCalendlyEmbed(result.calendlyBooking);
            return;
          }
        } catch (_) { }
        this.successfulChatCount = session.incrementChatCount(this.successfulChatCount);
        this.appendBotReply(typingEl, content, assistantMessageId);
        msg.appendSources(typingEl, jsonSources);
        return;
      }

      // — Error response —
      try {
        const err = JSON.parse(rawText);
        if (err.limitReached && err.data?.planType !== 'free') {
          msg.updateBubble(typingEl, "You've reached the conversation limit. Please use the form below to get in touch.", this.config.logoIcon);
          this.pendingEndIntentRating = false;
          this.showContactForm();
          return;
        }
        content = err.message || content;
      } catch (_) { }

      msg.updateBubble(typingEl, content, this.config.logoIcon);
      this.pendingEndIntentRating = false;

    } catch (error) {
      msg.updateBubble(typingEl, "Sorry, a network error occurred.", this.config.logoIcon);
      this.pendingEndIntentRating = false;
    } finally {
      this.setAwaitingResponse(false);
    }
  }

  // ── Bot reply + optional rating ──────────────────────────────────
  appendBotReply(typingEl, text, messageId) {
    msg.updateBubble(typingEl, text, this.config.logoIcon, messageId);
    this.botMessageCount++;
    this.maybeShowLeadForm();

    // Increment daily message count and lock session if limit reached
    const dailyCount = session.incrementDailyCount(this.widgetKey);
    if (session.isDailyLimitReached(this.widgetKey)) {
      setTimeout(() => this._lockSession(), 800);
    }

    const shouldRate = this.pendingEndIntentRating
      && !this.ratingShown && !this.ratingSubmitted
      && this.userMessageCount > 0 && this.botMessageCount > 0;

    if (shouldRate && this.elements.conversationRatingSlot) {
      const row = document.createElement('div');
      row.className = 'rating-row';
      row.innerHTML = `
        <span class="rating-label">Rate this conversation</span>
        <button class="rating-btn" data-rating="up"   title="Thumbs up">&#128077;</button>
        <button class="rating-btn" data-rating="down" title="Thumbs down">&#128078;</button>`;
      row.querySelectorAll('.rating-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          row.querySelectorAll('.rating-btn').forEach(b => b.classList.remove('active'));
          e.currentTarget.classList.add('active');
          this.elements.conversationRatingSlot.innerHTML = '';
          this.elements.conversationRatingSlot.classList.add('hidden');
          this.doSubmitRating(e.currentTarget.dataset.rating);
        });
      });
      this.elements.conversationRatingSlot.innerHTML = '';
      this.elements.conversationRatingSlot.appendChild(row);
      this.elements.conversationRatingSlot.classList.remove('hidden');
      this.elements.messagesContainer.scrollTop = this.elements.messagesContainer.scrollHeight;
      session.setRatingShown(this.sessionId, true);
      this.ratingShown = true;
    }

    this.pendingEndIntentRating = false;

    // Show feedback prompt immediately for gratitude/end-intent, otherwise after 25s of inactivity.
    if (this.userMessageCount > 0 && this.botMessageCount > 0) {
      if (this._wasEndIntent) {
        this._showHopeBanner();
      } else {
        this._scheduleHopeBanner();
      }
    }
    this._wasEndIntent = false;
  }

  // ── Rating submission ────────────────────────────────────────────
  async doSubmitRating(rating) {
    session.setRatingSubmitted(this.sessionId, true);
    this.ratingSubmitted = true;
    this._hideHopeBanner();
    this.showRatingAcknowledgement(rating);

    try {
      await api.submitRating({ apiBaseUrl: this.apiBaseUrl, widgetKey: this.widgetKey, sessionId: this.sessionId, rating });
      this.elements.conversationRatingSlot?.classList.add('hidden');
    } catch (_) { }
  }

  finalizePendingLeadDraft() {
    if (!this.apiBaseUrl || !this.widgetKey || !this.sessionId || this._lastLeadFinalizeSessionId === this.sessionId) return;
    this._lastLeadFinalizeSessionId = this.sessionId;
    api.finalizeLead({ apiBaseUrl: this.apiBaseUrl, widgetKey: this.widgetKey, sessionId: this.sessionId }).catch(() => { });
  }

  showRatingAcknowledgement(rating) {
    if (!this.elements.messagesContainer) return;

    clearTimeout(this._ratingToastTimer);
    this.shadowRoot.querySelector('.rating-feedback-toast')?.remove();

    const toast = document.createElement('div');
    toast.className = `rating-feedback-toast rating-feedback-toast--${rating === 'down' ? 'down' : 'up'}`;
    toast.textContent = rating === 'down'
      ? "Thanks for your feedback. We'll use it to make the experience better."
      : 'Thanks for your feedback. Glad that helped.';

    this.elements.messagesContainer.appendChild(toast);
    this.elements.messagesContainer.scrollTop = this.elements.messagesContainer.scrollHeight;

    this._ratingToastTimer = setTimeout(() => {
      toast.classList.add('is-hiding');
      setTimeout(() => toast.remove(), 220);
    }, 2400);
  }

  // ── Contact form ─────────────────────────────────────────────────
  closeAllMessageFeedbackMenus() {
    this.shadowRoot
      .querySelectorAll('.message-feedback-menu.show')
      .forEach((menu) => {
        menu.classList.remove('show');
        menu.closest('.message-feedback')?.classList.remove('menu-open');
      });
  }

  handleMessageFeedbackClick(e) {
    const feedbackButton = e.target.closest('.message-feedback-btn');
    if (feedbackButton) {
      e.stopPropagation();
      const feedbackRoot = feedbackButton.closest('.message-feedback');
      if (!feedbackRoot) return;

      feedbackRoot
        .querySelectorAll('.message-feedback-btn')
        .forEach((button) => button.classList.remove('active'));
      feedbackButton.classList.add('active');

      const menu = feedbackRoot.querySelector('.message-feedback-menu');
      if (feedbackButton.dataset.feedback === 'down') {
        const willOpen = !menu?.classList.contains('show');
        this.closeAllMessageFeedbackMenus();
        if (willOpen) {
          menu?.classList.add('show');
          feedbackRoot.classList.add('menu-open');
        }
        return;
      }

      menu?.classList.remove('show');
      feedbackRoot.classList.remove('menu-open');
      feedbackRoot
        .querySelectorAll('.message-feedback-item.active')
        .forEach((item) => item.classList.remove('active'));

      const messageId = Number(feedbackRoot.dataset.messageId);
      if (Number.isFinite(messageId)) {
        void this.submitMessageFeedback(messageId, 'up');
      }
      return;
    }

    const feedbackItem = e.target.closest('.message-feedback-item');
    if (!feedbackItem) return;

    e.stopPropagation();
    const feedbackRoot = feedbackItem.closest('.message-feedback');
    if (!feedbackRoot) return;

    feedbackRoot
      .querySelectorAll('.message-feedback-item')
      .forEach((item) => item.classList.remove('active'));
    feedbackItem.classList.add('active');
    feedbackRoot
      .querySelector('.message-feedback-btn[data-feedback="down"]')
      ?.classList.add('active');
    feedbackRoot.querySelector('.message-feedback-menu')?.classList.remove('show');
    feedbackRoot.classList.remove('menu-open');

    const messageId = Number(feedbackRoot.dataset.messageId);
    const feedbackReason = feedbackItem.dataset.feedbackReason || '';
    if (Number.isFinite(messageId)) {
      void this.submitMessageFeedback(messageId, 'down', feedbackReason || null);
    }
  }

  _getMessageFeedbackAcknowledgement(feedbackType, feedbackReason = null) {
    if (feedbackType === 'down') {
      if (feedbackReason === 'Incorrect') {
        return 'Thanks for flagging that as incorrect. We will use your feedback to improve future replies.';
      }
      return 'Thanks for the feedback. We will use it to improve future replies.';
    }

    return 'Thanks for your feedback. Glad that reply was helpful.';
  }

  _upsertMessageFeedbackAcknowledgement(messageId, feedbackType, feedbackReason = null) {
    if (!this.elements.messagesContainer || !Number.isFinite(messageId)) return;

    const selector = `.chat-message[data-feedback-ack-for="${String(messageId)}"]`;
    let wrapper = this.elements.messagesContainer.querySelector(selector);

    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.className = 'chat-message';
      wrapper.dataset.feedbackAckFor = String(messageId);

      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble-ai';
      wrapper.appendChild(bubble);
      this.elements.messagesContainer.appendChild(wrapper);
    }

    msg.updateBubble(
      wrapper,
      this._getMessageFeedbackAcknowledgement(feedbackType, feedbackReason),
      this.config.logoIcon,
    );
  }

  async submitMessageFeedback(messageId, feedbackType, feedbackReason = null) {
    if (!this.apiBaseUrl || !this.widgetKey || !this.sessionId || !Number.isFinite(messageId)) return;

    try {
      const response = await fetch(`${this.apiBaseUrl}/api/v1/widget/message-feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          widgetKey: this.widgetKey,
          sessionId: this.sessionId,
          messageId,
          feedbackType,
          feedbackReason,
        }),
      });

      if (!response.ok) return;
      this._upsertMessageFeedbackAcknowledgement(messageId, feedbackType, feedbackReason);
    } catch (e) {
      console.error('Failed to submit message feedback', e);
    }
  }

  showContactForm() {
    if (!this.elements.contactFormSlot) return;
    this.hideCalendlyEmbed();
    this.elements.contactFormSlot.classList.toggle('lead-form-gate', Boolean(this.config.leadFormEnabled));
    this.elements.messagesContainer.classList.toggle('lead-form-open', Boolean(this.config.leadFormEnabled));
    if (!this.config.leadFormEnabled) {
      this.elements.messagesContainer.classList.add('hidden');
    }
    this.elements.chatInput?.classList.add('hidden');
    this.elements.contactFormSlot.classList.remove('hidden');

    if (!this._cfBound) {
      this._cfBound = true;
      this.elements.cfSubmit.addEventListener('click', () => this.submitContactForm());

      const inputs = [this.elements.cfName, this.elements.cfEmail, this.elements.cfPhone];
      inputs.forEach(input => {
        if (input) {
          input.addEventListener('input', () => {
            input.parentElement.classList.toggle('has-value', input.value.trim().length > 0);
            input.style.borderColor = "";
            this.updateCfSubmitState();
          });
          input.addEventListener('blur', () => {
            input.parentElement.classList.toggle('has-value', input.value.trim().length > 0);
          });
        }
      });

      if (this.elements.cfAgree) {
        this.elements.cfAgree.addEventListener('change', () => this.updateCfSubmitState());
      }
    }
    this.updateCfSubmitState();
  }

  updateCfSubmitState() {
    const name = this.elements.cfName?.value.trim();
    const email = this.elements.cfEmail?.value.trim();
    const phone = this.elements.cfPhone?.value.trim();
    const country = this.elements.cfCountry?.value.trim();

    let isValid = name && email;
    if (this.config.leadFormPhoneEnabled) {
      if (!phone) isValid = false;
    }
    if (this.config.leadFormCountryEnabled) {
      if (!country) isValid = false;
    }

    if (this.elements.cfSubmit) {
      this.elements.cfSubmit.disabled = !isValid;
    }
  }

  async submitContactForm() {
    const phoneCode = this.elements.cfPhoneCode?.getAttribute('data-code') || this.elements.cfPhoneCode?.textContent || '';
    const values = {
      name: this.elements.cfName?.value.trim() || null,
      email: this.elements.cfEmail?.value.trim() || null,
      phone: this.elements.cfPhone ? (phoneCode + " " + this.elements.cfPhone.value.trim()) : null,
      country: this.elements.cfCountry?.value.trim() || null,
      message: this.elements.cfMessage?.value.trim() || null,
    };

    const requiredFields = [
      this.elements.cfName,
      this.elements.cfEmail,
      this.elements.cfPhone,
      this.elements.cfCountry
    ].filter(Boolean);

    const missing = requiredFields.filter((field) => !field.value.trim());
    if (missing.length > 0) {
      requiredFields.forEach((field) => {
        if (!field.value.trim()) field.style.borderColor = '#ef4444';
      });
      return;
    }

    if (this.elements.cfSubmit) { this.elements.cfSubmit.disabled = true; this.elements.cfSubmit.textContent = 'Sending…'; }

    try {
      const resp = await api.submitContact({
        apiBaseUrl: this.apiBaseUrl, widgetKey: this.widgetKey, sessionId: this.sessionId,
        ...values,
      });
      if (resp.ok) {
        if (this.config.leadFormEnabled) {
          this._leadFormCompleted = true;
          this.elements.contactFormSlot.classList.add('hidden');
          this.elements.contactFormSlot.classList.remove('lead-form-gate');
          this.elements.messagesContainer?.classList.remove('lead-form-open');
          this.elements.messagesContainer?.classList.remove('hidden');
          this.elements.chatInput?.classList.remove('hidden');
          this.elements.input?.focus();
          return;
        }
        this.elements.contactFormSlot.innerHTML = '<div class="contact-form-success">✓ Message sent! We\'ll be in touch soon.</div>';
      } else {
        this._resetCfBtn();
      }
    } catch (_) { this._resetCfBtn(); }
  }

  // ── Default welcome message ──────────────────────────────────────
  displayDefaultMessage() {
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-message';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble-ai';
    bubble.innerHTML = msg.updateBubble
      ? ''
      : `<div class="bot-response-block"><div class="bot-message-row">${msg.getBotIconHtml(this.config.logoIcon)}<div class="md-content">${msg.parseMarkdown(this.config.primaryText)}</div></div></div>`;
    wrapper.appendChild(bubble);
    this.elements.messagesContainer.appendChild(wrapper);
    msg.updateBubble(wrapper, this.config.primaryText, this.config.logoIcon);
  }

  // ── Private helpers ──────────────────────────────────────────────
  _updateSession(id) {
    this.sessionId = id;
    session.updateSessionId(id);
    this.ratingShown = session.getRatingShown(id);
    this.ratingSubmitted = session.getRatingSubmitted(id);
  }

  _resetRatingState() {
    this.pendingEndIntentRating = false;
    this.ratingShown = false;
    this.ratingSubmitted = false;
    this._pendingHopeBanner = false;
    this._clearHopeBannerTimer();
    session.setRatingShown(this.sessionId, false);
    session.setRatingSubmitted(this.sessionId, false);
    if (this.elements?.conversationRatingSlot) {
      this.elements.conversationRatingSlot.innerHTML = '';
      this.elements.conversationRatingSlot.classList.add('hidden');
    }
    this._hideHopeBanner();
  }

  _resetCfBtn() {
    if (this.elements.cfSubmit) {
      this.elements.cfSubmit.disabled = false;
      this.elements.cfSubmit.textContent = this.config.leadFormEnabled
        ? this.config.leadFormButtonText || 'Continue'
        : 'Send Message';
    }
  }

  getLeadFormTriggerMessageCount() {
    const parsed = Number.parseInt(this.config.leadFormTriggerMessageCount, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
  }

  async maybeShowLeadForm() {
    if (!this.config.leadFormEnabled || this._leadFormCompleted) return;
    if (this.elements?.contactFormSlot && !this.elements.contactFormSlot.classList.contains('hidden')) return;
    if (this.userMessageCount < this.getLeadFormTriggerMessageCount()) return;
    if (this._leadFormStatusChecking) return;

    this._leadFormStatusChecking = true;
    try {
      const resp = await api.getLeadStatus({
        apiBaseUrl: this.apiBaseUrl,
        widgetKey: this.widgetKey,
        sessionId: this.sessionId,
      });
      if (resp.ok) {
        const payload = await resp.json().catch(() => null);
        if (payload?.data?.completed) {
          this._leadFormCompleted = true;
          return;
        }
      }
    } catch (e) {
      // Non-fatal: if the status check is unavailable, keep the configured lead gate behavior.
    } finally {
      this._leadFormStatusChecking = false;
    }

    if (this._leadFormCompleted) return;
    if (this.elements?.contactFormSlot && !this.elements.contactFormSlot.classList.contains('hidden')) return;
    window.setTimeout(() => this.showContactForm(), 250);
  }

  _clearHopeBannerTimer() {
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
  }

  _hideHopeBanner() {
    this._pendingHopeBanner = false;
    if (this.elements.hopeBanner) {
      this.elements.hopeBanner.classList.add('hidden');
    }
    this.elements.hopeBannerUp?.classList.remove('active');
    this.elements.hopeBannerDown?.classList.remove('active');
    this.elements.messagesContainer?.querySelector('.chat-message.mt-space')?.classList.remove('mt-space');
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
    this._clearHopeBannerTimer();
    if (this.userMessageCount === 0 || this.botMessageCount === 0) return;
    if (this.elements.hopeBanner) {
      this.elements.hopeBanner.classList.remove('hidden');
      this.elements.messagesContainer?.querySelector('.chat-message')?.classList.add('mt-space');
    }
  }

  _maybeRevealFloatingBtn() {
    if (!this._logoReady || !this._floatingBtnTimerFired) return;
    const btn = this.elements.floatingBtn;
    if (!btn || !btn.classList.contains('hidden')) return;
    btn.classList.remove('hidden');
    btn.classList.add('entering');
    setTimeout(() => btn.classList.remove('entering'), 550);
  }

  _bindCalendlyMessageListener() {
    if (this._calendlyMessageHandler) return;
    this._calendlyMessageHandler = (event) => {
      const origin = String(event.origin || '');
      if (!origin.includes('calendly.com')) return;
      const eventName = typeof event.data === 'string' ? event.data : event.data?.event;
      if (eventName !== 'calendly.event_scheduled') return;
      if (!this._calendlyBookingActive) return;

      this.hideCalendlyEmbed();
      const typingEl = msg.createTypingIndicator(this.config.logoIcon);
      this.elements.messagesContainer?.appendChild(typingEl);
      this.appendBotReply(
        typingEl,
        "Your appointment has been booked successfully. Please check your email for the confirmation details.",
      );
    };
    window.addEventListener('message', this._calendlyMessageHandler);
  }

  _buildCalendlyUtm(tracking = {}) {
    return {
      utmSource: this.widgetKey || 'witzo-widget',
      utmMedium: 'chat_widget',
      utmCampaign: 'witzo_calendly',
      utmContent: tracking.sessionId || this.sessionId || '',
      ...(tracking.leadId ? { utmTerm: tracking.leadId } : {}),
    };
  }

  async _ensureCalendlyAssets() {
    if (window.Calendly?.initInlineWidget) return;
    if (this._calendlyAssetPromise) {
      await this._calendlyAssetPromise;
      return;
    }

    this._calendlyAssetPromise = new Promise((resolve, reject) => {
      if (!document.getElementById('witzo-calendly-widget-css')) {
        const cssLink = document.createElement('link');
        cssLink.id = 'witzo-calendly-widget-css';
        cssLink.rel = 'stylesheet';
        cssLink.href = 'https://assets.calendly.com/assets/external/widget.css';
        document.head.appendChild(cssLink);
      }

      const existingScript = document.getElementById('witzo-calendly-widget-script');
      if (existingScript && window.Calendly?.initInlineWidget) {
        resolve();
        return;
      }

      const script = existingScript || document.createElement('script');
      if (!existingScript) {
        script.id = 'witzo-calendly-widget-script';
        script.src = 'https://assets.calendly.com/assets/external/widget.js';
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new Error('Failed to load Calendly widget assets')), { once: true });
    });

    try {
      await this._calendlyAssetPromise;
    } finally {
      this._calendlyAssetPromise = null;
    }
  }

  hideCalendlyEmbed() {
    if (!this.elements.calendlySlot) return;
    this._calendlyBookingActive = false;
    this.elements.calendlySlot.classList.add('hidden');
    this.elements.calendlySlot.innerHTML = '';
    this.elements.messagesContainer?.classList.remove('hidden');
    if (!this.elements.contactFormSlot?.classList.contains('hidden')) return;
    this.elements.chatInput?.classList.remove('hidden');
  }

  async showCalendlyEmbed(calendlyBooking) {
    if (!this.elements.calendlySlot || !calendlyBooking?.schedulingUrl) return;

    this._clearHopeBannerTimer();
    this._hideHopeBanner();
    this._calendlyBookingActive = true;
    this.elements.contactFormSlot?.classList.add('hidden');
    this.elements.conversationRatingSlot?.classList.add('hidden');
    this.elements.messagesContainer?.classList.add('hidden');
    this.elements.chatInput?.classList.add('hidden');
    this.elements.calendlySlot.classList.remove('hidden');
    this.elements.calendlySlot.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem;">
        <div>
          <h3 style="margin:0;">${calendlyBooking.bookingLabel || 'Book an appointment'}</h3>
          <p style="margin:0.25rem 0 0;">Choose a date and time that works for you.</p>
        </div>
        <button id="calendlyBackBtn" type="button" style="border:none;background:transparent;color:#475569;font-size:0.85rem;font-weight:600;cursor:pointer;padding:0;">Back to chat</button>
      </div>
      <div id="calendlyEmbedContainer" style="min-height:620px;border:1px solid #e2e8f0;border-radius:0.75rem;overflow:hidden;background:#fff;"></div>
    `;

    this.elements.calendlySlot.querySelector('#calendlyBackBtn')?.addEventListener('click', () => {
      this.hideCalendlyEmbed();
    });

    const container = this.elements.calendlySlot.querySelector('#calendlyEmbedContainer');
    if (!container) return;

    try {
      await this._ensureCalendlyAssets();
      if (window.Calendly?.initInlineWidget) {
        container.innerHTML = '';
        window.Calendly.initInlineWidget({
          url: calendlyBooking.schedulingUrl,
          parentElement: container,
          prefill: calendlyBooking.prefill || {},
          utm: this._buildCalendlyUtm(calendlyBooking.tracking || {}),
        });
        return;
      }
    } catch (_) { }

    container.innerHTML = `
      <iframe
        title="Calendly booking"
        src="${calendlyBooking.schedulingUrl}"
        style="width:100%;height:620px;border:0;"
        loading="lazy"
        referrerpolicy="strict-origin-when-cross-origin"
      ></iframe>
    `;
  }

  _lockSession() {
    // Prevent duplicate lock messages
    if (this._sessionLocked) return;
    this._sessionLocked = true;

    // Disable input and send button
    if (this.elements.input) this.elements.input.disabled = true;
    if (this.elements.sendBtn) this.elements.sendBtn.disabled = true;
    this.updateSendButtonState();

    // Cancel any pending idle timer and hide hope banner
    this._clearHopeBannerTimer();
    this._hideHopeBanner();

    // Append session-ended message as a bot bubble
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-message';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble-ai';
    bubble.innerHTML = `<div class="bot-message-row">${msg.getBotIconHtml(this.config.logoIcon)}<div class="md-content"><p>Your free chat session for today has come to an end. 🙏<br><br>Thank you for chatting with us! Please come back after <strong>24 hours</strong> to start a new conversation. We look forward to helping you again!</p></div></div>`;
    wrapper.appendChild(bubble);
    this.elements.messagesContainer?.appendChild(wrapper);
    if (this.elements.messagesContainer) {
      this.elements.messagesContainer.scrollTop = this.elements.messagesContainer.scrollHeight;
    }
  }

  updateSendButtonState() {
    if (!this.elements?.sendBtn || !this.elements?.input) return;
    const inputDisabled = this._sessionLocked;
    this.elements.input.disabled = inputDisabled;
    if (this.elements.langPillBtn) {
      this.elements.langPillBtn.style.pointerEvents = this.isAwaitingResponse ? 'none' : '';
      this.elements.langPillBtn.style.opacity = this.isAwaitingResponse ? '0.55' : '';
    }
    const hasValue = Boolean(this.elements.input.value.trim());
    const disabled = inputDisabled || (this.isAwaitingResponse && !this._hasVisibleStreamingResponse) || !hasValue;
    this.elements.sendBtn.disabled = disabled;
    this.elements.sendBtn.setAttribute('aria-disabled', String(disabled));
    this.elements.sendBtn.classList.toggle('is-active', !disabled);
  }
}
