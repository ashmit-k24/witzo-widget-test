import { DEFAULT_CONFIG, SUPPORTED_LANGUAGES, ATTR_LIST } from './config.js';
import * as session  from './session.js';
import * as api      from './api.js';
import * as stream   from './stream.js';
import * as msg      from './messages.js';
import * as events   from './events.js';
import { buildTemplate } from './template.js';
import { buildCSS }      from '../styles/index.js';

export class WitzoChatWidget extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    // Instance state
    this.apiUrl        = '';
    this.apiBaseUrl    = '';
    this.widgetKey     = '';
    this.sessionId     = '';
    this.isOpen        = false;
    this.date          = new Date();
    this._cfBound      = false;
    this.elements      = {};

    // Counters
    this.successfulChatCount  = 0;
    this.userMessageCount     = 0;
    this.botMessageCount      = 0;

    // Rating state
    this.pendingEndIntentRating = false;
    this.ratingShown            = false;
    this.ratingSubmitted        = false;

    // Hope banner state
    this._wasEndIntent = false;
    this._idleTimer    = null;

    // Auto-open timer (cleared on first manual interaction)
    this._autoOpenTimer = null;

    // Daily session limit state
    this._sessionLocked = false;

    this.selectedLanguage = 'en';
    this.config           = { ...DEFAULT_CONFIG };
  }

  connectedCallback() {
    // 1. Read HTML attributes into config
    this.apiUrl     = this.getAttribute('api-url')      || '';
    this.apiBaseUrl = this.getAttribute('api-base-url') || this.apiUrl.replace('/api/v1/webhook', '');
    this.widgetKey  = this.getAttribute('widget-key')   || '';

    ATTR_LIST.forEach(attr => {
      const val = this.getAttribute(attr);
      if (val === null) return;
      const key = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.config[key] = val === 'true' ? true : val === 'false' ? false : val;
    });

    // 2. Init session
    const sess = session.initSession();
    this.date                 = sess.date;
    this.successfulChatCount  = sess.count;
    this.sessionId            = sess.sessionId;
    this.ratingShown          = session.getRatingShown(this.sessionId);
    this.ratingSubmitted      = session.getRatingSubmitted(this.sessionId);

    // 3. Init language preference
    const langKey        = session.getLanguageKey(this.widgetKey);
    const configuredLang = session.normalizeLanguage(this.config.defaultLanguage, SUPPORTED_LANGUAGES) || 'en';
    const storedLang     = session.normalizeLanguage(sessionStorage.getItem(langKey), SUPPORTED_LANGUAGES);
    this.selectedLanguage       = this.getAttribute('default-language') !== null ? configuredLang : (storedLang || configuredLang);
    this.config.defaultLanguage = this.selectedLanguage;
    sessionStorage.setItem(langKey, this.selectedLanguage);

    // 3b. Default logo icon → witzo.png served from the same origin as the API
    if (!this.config.logoIcon) {
      this.config.logoIcon = `${this.apiBaseUrl}/assets/images/witzo.png`;
    }
    // Preload bot icon so it's cached before first message typing indicator
    if (this.config.logoIcon) {
      const _preload = new Image();
      _preload.src = this.config.logoIcon;
    }

    // 4. Load Plus Jakarta Sans into the document head (fonts are shared into shadow DOM)
    if (!document.getElementById('witzo-font-pjs')) {
      const link = document.createElement('link');
      link.id   = 'witzo-font-pjs';
      link.rel  = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,200..800;1,200..800&display=swap';
      document.head.appendChild(link);
    }

    // 5. Render shadow DOM
    this.shadowRoot.innerHTML = `
      <style>${buildCSS(this.config)}</style>
      ${buildTemplate(this.config, this.selectedLanguage, SUPPORTED_LANGUAGES)}
    `;

    // 6. Cache DOM references
    this.elements = {
      widget:                  this.shadowRoot.getElementById('textChatWidget'),
      floatingBtn:             this.shadowRoot.getElementById('floating-btn'),
      closeBtn:                this.shadowRoot.getElementById('closeTextChat'),
      messagesContainer:       this.shadowRoot.getElementById('textMessagesArea'),
      input:                   this.shadowRoot.getElementById('textMessageInput'),
      sendBtn:                 this.shadowRoot.getElementById('textSendButton'),
      contactFormSlot:         this.shadowRoot.getElementById('contactFormSlot'),
      cfName:                  this.shadowRoot.getElementById('cf-name'),
      cfEmail:                 this.shadowRoot.getElementById('cf-email'),
      cfMessage:               this.shadowRoot.getElementById('cf-message'),
      cfSubmit:                this.shadowRoot.getElementById('cf-submit'),
      chatInput:               this.shadowRoot.querySelector('.chat-input'),
      conversationRatingSlot:  this.shadowRoot.getElementById('conversationRatingSlot'),
      hopeBanner:              this.shadowRoot.getElementById('hopeBanner'),
      hopeBannerUp:            this.shadowRoot.getElementById('hopeBannerUp'),
      hopeBannerDown:          this.shadowRoot.getElementById('hopeBannerDown'),
      langPillBtn:             this.shadowRoot.getElementById('langPillBtn'),
      langDropdown:            this.shadowRoot.getElementById('langDropdown'),
      langItems:               this.shadowRoot.querySelectorAll('.lang-dropdown-item'),
    };

    // 6. Wire events
    events.bindEvents(this);

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

    // 9. Reveal floating button after 2 s with entrance animation
    setTimeout(() => {
      const btn = this.elements.floatingBtn;
      if (!btn) return;
      btn.classList.remove('hidden');
      btn.classList.add('entering');
      setTimeout(() => btn.classList.remove('entering'), 550);
    }, 2000);
  }

  // ── Delegated to events.js ──────────────────────────────────────
  toggleChat()                     { events.toggleChat(this); }
  handleLanguageSelect(code)       { events.handleLanguageSelect(this, code); }

  // ── Core send flow ───────────────────────────────────────────────
  async handleSend() {
    const text = this.elements.input.value.trim();
    if (!text) return;

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
      this.botMessageCount  = 0;
      this._resetRatingState();
    }

    // Clear idle timer and hide hope banner when user sends a new message
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
    if (this.elements.hopeBanner) this.elements.hopeBanner.classList.add('hidden');

    msg.appendMessage(text, 'user', this.elements.messagesContainer);
    this.userMessageCount++;
    this._wasEndIntent          = msg.isConversationEndMessage(text);
    this.pendingEndIntentRating = this.config.planType === 'basic'
      && this._wasEndIntent
      && !this.ratingShown && !this.ratingSubmitted;
    this.elements.input.value = '';

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
          msg.updateBubble(typingEl, assembled, this.config.logoIcon);
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
        this.appendBotReply(typingEl, result.assembled);
        return;
      }

      // — JSON path —
      const rawText = await response.text();
      let content   = "Sorry, didn't get that.";

      if (response.ok) {
        try {
          const result = JSON.parse(rawText);
          content = result.response || result.output || result.message || content;
          if (result.sessionId) this._updateSession(result.sessionId);
        } catch (_) {}
        this.successfulChatCount = session.incrementChatCount(this.successfulChatCount);
        this.appendBotReply(typingEl, content);
        return;
      }

      // — Error response —
      try {
        const err = JSON.parse(rawText);
        if (err.limitReached && err.data?.planType === 'basic') {
          msg.updateBubble(typingEl, "You've reached the conversation limit. Please use the form below to get in touch.", this.config.logoIcon);
          this.pendingEndIntentRating = false;
          this.showContactForm();
          return;
        }
        content = err.message || content;
      } catch (_) {}

      msg.updateBubble(typingEl, content, this.config.logoIcon);
      this.pendingEndIntentRating = false;

    } catch (error) {
      msg.updateBubble(typingEl, "Sorry, a network error occurred.", this.config.logoIcon);
      this.pendingEndIntentRating = false;
    }
  }

  // ── Bot reply + optional rating ──────────────────────────────────
  appendBotReply(typingEl, text) {
    msg.updateBubble(typingEl, text, this.config.logoIcon);
    this.botMessageCount++;

    // Increment daily message count and lock session if limit reached
    const dailyCount = session.incrementDailyCount(this.widgetKey);
    if (session.isDailyLimitReached(this.widgetKey)) {
      setTimeout(() => this._lockSession(), 800);
    }

    const shouldRate = this.config.planType === 'basic'
      && this.pendingEndIntentRating
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

    // Show hope banner: immediately for end-intent messages, after 20s idle otherwise
    if (this._wasEndIntent) {
      this._showHopeBanner();
    } else {
      clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(() => this._showHopeBanner(), 20000);
    }
    this._wasEndIntent = false;
  }

  // ── Rating submission ────────────────────────────────────────────
  async doSubmitRating(rating) {
    try {
      await api.submitRating({ apiBaseUrl: this.apiBaseUrl, widgetKey: this.widgetKey, sessionId: this.sessionId, rating });
      session.setRatingSubmitted(this.sessionId, true);
      this.ratingSubmitted = true;
      this.elements.conversationRatingSlot?.classList.add('hidden');
    } catch (_) {}
  }

  // ── Contact form ─────────────────────────────────────────────────
  showContactForm() {
    if (!this.elements.contactFormSlot) return;
    this.elements.messagesContainer.classList.add('hidden');
    this.elements.chatInput?.classList.add('hidden');
    this.elements.contactFormSlot.classList.remove('hidden');
    if (!this._cfBound) {
      this._cfBound = true;
      this.elements.cfSubmit.addEventListener('click', () => this.submitContactForm());
    }
  }

  async submitContactForm() {
    const email = this.elements.cfEmail?.value.trim();
    if (!email) { if (this.elements.cfEmail) this.elements.cfEmail.style.borderColor = '#ef4444'; return; }

    if (this.elements.cfSubmit) { this.elements.cfSubmit.disabled = true; this.elements.cfSubmit.textContent = 'Sending…'; }

    try {
      const resp = await api.submitContact({
        apiBaseUrl: this.apiBaseUrl, widgetKey: this.widgetKey, sessionId: this.sessionId,
        name:    this.elements.cfName?.value.trim()    || null,
        email,
        message: this.elements.cfMessage?.value.trim() || null,
      });
      if (resp.ok) {
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
    bubble.innerHTML = `<div class="bot-message-row">${msg.getBotIconHtml(this.config.logoIcon)}<div class="md-content">${msg.parseMarkdown(this.config.primaryText)}</div></div>`;
    wrapper.appendChild(bubble);
    this.elements.messagesContainer.appendChild(wrapper);
  }

  // ── Private helpers ──────────────────────────────────────────────
  _updateSession(id) {
    this.sessionId = id;
    session.updateSessionId(id);
    this.ratingShown     = session.getRatingShown(id);
    this.ratingSubmitted = session.getRatingSubmitted(id);
  }

  _resetRatingState() {
    this.pendingEndIntentRating = false;
    this.ratingShown            = false;
    this.ratingSubmitted        = false;
    session.setRatingShown(this.sessionId, false);
    session.setRatingSubmitted(this.sessionId, false);
    if (this.elements?.conversationRatingSlot) {
      this.elements.conversationRatingSlot.innerHTML = '';
      this.elements.conversationRatingSlot.classList.add('hidden');
    }
  }

  _resetCfBtn() {
    if (this.elements.cfSubmit) { this.elements.cfSubmit.disabled = false; this.elements.cfSubmit.textContent = 'Send Message'; }
  }

  _showHopeBanner() {
    if (this.elements.hopeBanner) {
      this.elements.hopeBanner.classList.remove('hidden');
      this.elements.messagesContainer?.querySelector('.chat-message')?.classList.add('mt-space');
    }
  }

  _lockSession() {
    // Prevent duplicate lock messages
    if (this._sessionLocked) return;
    this._sessionLocked = true;

    // Disable input and send button
    if (this.elements.input)   this.elements.input.disabled   = true;
    if (this.elements.sendBtn) this.elements.sendBtn.disabled = true;

    // Cancel any pending idle timer and hide hope banner
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
    if (this.elements.hopeBanner) this.elements.hopeBanner.classList.add('hidden');

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
}
