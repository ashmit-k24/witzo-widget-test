import { CLOSE_ICON_SVG, LOGO_DEFAULT_SVG, GLOBE_SVG, SEND_ARROW_SVG, FLOATING_BTN_SVG, THUMBS_UP_SVG, THUMBS_DOWN_SVG } from './icons.js';

/**
 * Builds the full Shadow DOM HTML structure.
 * Dynamic colors are handled via CSS custom properties (see styles/index.js).
 */
export function buildTemplate(config, selectedLanguage, supportedLanguages) {
  const logoHtml = config.logoIcon
    ? `<img id="logoIcon" src="${config.logoIcon}" alt="Logo" />`
    : LOGO_DEFAULT_SVG;

  const langItems = supportedLanguages.map(lang => `
    <div class="lang-dropdown-item ${lang.code === selectedLanguage ? 'active' : ''}" data-code="${lang.code}">
      <span>${lang.label}</span>
      <svg class="lang-check" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </div>`).join('');

  const floatingType = config.floatingType || 'small';
  const floatingIcon = `<span class="floating-orb"><span class="floating-orb-inner">${FLOATING_BTN_SVG}</span></span>`;
  const floatingMarkup = floatingType === 'full'
    ? `
      <button class="floating-launcher floating-launcher-full hidden" id="floating-btn" aria-label="Open chat">
        <span class="floating-full-message">Hey there! 😊 What brings you here today?</span>
        <span class="floating-full-row">
          ${floatingIcon}
          <span class="floating-full-cta">Let&apos;s Chat</span>
        </span>
      </button>`
    : floatingType === 'compact'
      ? `
      <button class="floating-launcher floating-launcher-compact hidden" id="floating-btn" aria-label="Open chat">
        ${floatingIcon}
        <span class="floating-compact-label">Need Assistance ?</span>
      </button>`
      : `
      <button class="floating-launcher floating-launcher-small hidden" id="floating-btn" aria-label="Open chat">
        ${floatingIcon}
      </button>`;

  return `
    <!-- ── Chat Window ── -->
    <div id="textChatWidget" class="chat-widget hidden">

      <!-- Header -->
      <div class="chat-header">
        <div class="chat-header-left">
          <div class="chat-icon">${logoHtml}</div>
          <h3 id="banner-text" class="chat-title" style="color:${config.bannerTextColor || '#fff'}">${config.bannerText}</h3>
        </div>
        <div class="chat-header-right">
          <button id="closeTextChat" class="chat-action-btn">
            ${CLOSE_ICON_SVG(config.closeButtonColor || 'white')}
          </button>
        </div>
      </div>

      <!-- Hope Banner (rating prompt after bot reply) -->
      <div id="hopeBanner" class="hope-banner hidden">
        <span class="hope-banner-text">Hope that helped!</span>
        <div class="hope-banner-btns">
          <button class="hope-banner-btn" id="hopeBannerUp"   title="Thumbs up">${THUMBS_UP_SVG}</button>
          <button class="hope-banner-btn" id="hopeBannerDown" title="Thumbs down">${THUMBS_DOWN_SVG}</button>
        </div>
      </div>

      <!-- Messages -->
      <div id="textMessagesArea" class="chat-messages"></div>

      <!-- Contact Form (basic plan fallback) -->
      <div id="contactFormSlot" class="contact-form hidden">
        <h3>Get in Touch</h3>
        <p>Our team will respond as soon as possible.</p>
        <input  id="cf-name"    type="text"  placeholder="Your name" />
        <input  id="cf-email"   type="email" placeholder="Your email *" />
        <textarea id="cf-message" placeholder="Your message"></textarea>
        <button id="cf-submit" class="contact-form-submit">Send Message</button>
      </div>

      <!-- Conversation rating slot (basic plan) -->
      <div id="conversationRatingSlot" class="hidden"></div>

      <!-- Input area -->
      <div class="chat-input">
        <div class="chat-input-container">
          <input id="textMessageInput" type="text" placeholder="Type your message…" class="chat-text-input" />

          <!-- Language pill + dropdown -->
          <div class="lang-pill" id="langPillBtn">
            ${GLOBE_SVG}
            <span id="langPillCode">${(selectedLanguage || 'en').slice(0, 2).toUpperCase()}</span>
            <div class="lang-dropdown" id="langDropdown">${langItems}</div>
          </div>

          <!-- Send button -->
          <button class="chat-send-btn" id="textSendButton">
            <div class="chat-send-icon">${SEND_ARROW_SVG}</div>
          </button>
        </div>
      </div>

      <!-- Footer -->
      <div class="chat-footer">
        <p class="powered-by">powered by
          <a href="https://witzo.ai/" target="_blank" rel="noopener noreferrer" class="powered-by-brand">witzo</a>
        </p>
      </div>
    </div>

    <!-- ── Floating Button ── -->
    <div id="floatingBtn" class="floating-${floatingType}">
      ${floatingMarkup}
    </div>`;
}
