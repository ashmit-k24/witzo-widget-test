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
  const leadFields = (config.leadFormEnabled ? [
    config.leadFormNameEnabled !== false ? `
      <div class="cf-field-group">
        <input id="cf-name" type="text" />
        <label>Full name</label>
      </div>` : '',
    config.leadFormEmailEnabled !== false ? `
      <div class="cf-field-group">
        <input id="cf-email" type="email" />
        <label>Email address</label>
      </div>` : '',
    config.leadFormPhoneEnabled !== false ? `
      <div class="cf-field-group">
        <div class="cf-phone-wrapper">
          <div class="cf-phone-trigger" id="cf-phone-code-trigger">
            <span id="cf-phone-code" data-code="+91">+91</span>
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <div class="cf-fixed-dropdown hidden" id="cf-phone-dropdown"></div>
          </div>
          <div class="cf-input-wrap">
            <input id="cf-phone" type="tel" />
            <label>Phone number</label>
          </div>
        </div>
      </div>` : '',
    config.leadFormCountryEnabled !== false ? `
      <div class="cf-field-group">
        <div class="cf-country-wrapper" id="cf-country-trigger">
          <span id="cf-country-value">Select country</span>
          <svg class="cf-country-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          <div class="cf-fixed-dropdown hidden" id="cf-country-dropdown">
            <div class="cf-country-search"><input type="text" id="cf-country-search" /></div>
            <div class="cf-country-list" id="cf-country-list"></div>
          </div>
        </div>
        <input type="hidden" id="cf-country" />
      </div>` : '',
  ] : [
    `
    <div class="cf-field-group">
      <input id="cf-name" type="text" />
      <label>Full name</label>
    </div>`,
    `
    <div class="cf-field-group">
      <input id="cf-email" type="email" />
      <label>Email address</label>
    </div>`
  ]).filter(Boolean).join("");

  const floatingType = config.floatingType || 'small';
  const chatIconHtml = config.logoIcon
    ? `<img src="${config.logoIcon}" alt="Logo" style="width: 100%; height: 100%; border-radius: inherit;" />`
    : FLOATING_BTN_SVG;
  const floatingIcon = `<span class="floating-orb"><span class="floating-orb-inner"><span class="floating-icon-chat">${chatIconHtml}</span><span class="floating-icon-close">${CLOSE_ICON_SVG('white')}</span></span></span>`;
  const floatingMarkup = floatingType === 'full'
    ? `
      <button class="floating-launcher floating-launcher-full hidden" id="floating-btn" aria-label="Open chat">
        <span class="floating-full-message">Hey there! 😊 What brings you here today?</span>
        <span class="floating-full-row">
          ${floatingIcon}
          <span class="floating-full-cta">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="17" viewBox="0 0 20 19" fill="none">
          <path d="M18.7959 14.1541C19.2768 13.1559 19.5127 12.0572 19.4842 10.9493C19.4556 9.84143 19.1633 8.75638 18.6316 7.78427C18.0999 6.81217 17.3442 5.98107 16.4271 5.36001C15.5101 4.73896 14.4582 4.34588 13.3589 4.21342C12.9931 3.3622 12.4613 2.59258 11.7946 1.94964C11.1279 1.30669 10.3398 0.80334 9.47632 0.469059C8.61287 0.134778 7.69145 -0.0237135 6.76603 0.00286652C5.84061 0.0294465 4.92979 0.240563 4.08691 0.623854C3.24403 1.00714 2.48602 1.5549 1.85729 2.23506C1.22855 2.91521 0.741724 3.71409 0.425309 4.5849C0.108894 5.45571 -0.0307453 6.38096 0.014567 7.30646C0.0598793 8.23196 0.289233 9.13911 0.689197 9.97479L0.0567579 12.1263C-0.0139541 12.3665 -0.0186822 12.6213 0.0430709 12.8639C0.104824 13.1066 0.230776 13.3281 0.407674 13.5051C0.584573 13.6822 0.80588 13.8082 1.04831 13.87C1.29074 13.9318 1.54534 13.9271 1.78531 13.8563L3.9349 13.2233C4.62513 13.5553 5.36514 13.7715 6.12539 13.8633C6.49474 14.7295 7.03575 15.5117 7.71571 16.1626C8.39567 16.8136 9.20045 17.3198 10.0814 17.6506C10.9624 17.9815 11.9012 18.1301 12.8412 18.0875C13.7812 18.0448 14.7027 17.8119 15.5502 17.4027L17.6998 18.0357C17.9397 18.1064 18.1942 18.1111 18.4365 18.0493C18.6788 17.9875 18.9 17.8615 19.0769 17.6846C19.2538 17.5077 19.3797 17.2863 19.4416 17.0438C19.5034 16.8013 19.4989 16.5466 19.4284 16.3065L18.7959 14.1541ZM4.00102 11.7806C3.93451 11.7808 3.86835 11.7901 3.80441 11.8085L1.39123 12.5207L2.10196 10.1037C2.15251 9.92903 2.13284 9.74155 2.04716 9.58124C1.4176 8.40283 1.2321 7.03722 1.52447 5.73336C1.81685 4.42949 2.56763 3.2742 3.63995 2.47808C4.71227 1.68197 6.03473 1.29804 7.36624 1.39629C8.69776 1.49455 9.94966 2.06843 10.8937 3.01334C11.8378 3.95824 12.4112 5.21124 12.5094 6.54393C12.6075 7.87661 12.2239 9.20022 11.4285 10.2735C10.6331 11.3468 9.47883 12.0982 8.1761 12.3908C6.87338 12.6835 5.50897 12.4978 4.33159 11.8677C4.23035 11.8116 4.11673 11.7817 4.00102 11.7806ZM17.3797 14.2821L18.0939 16.7L15.679 15.9887C15.5045 15.9381 15.3172 15.9578 15.157 16.0435C13.8754 16.7284 12.3773 16.8853 10.9819 16.4806C9.58645 16.0759 8.40413 15.1418 7.68691 13.8772C8.63981 13.7777 9.56188 13.4821 10.3953 13.0091C11.2287 12.536 11.9554 11.8957 12.5298 11.1283C13.1043 10.3609 13.5141 9.48292 13.7336 8.5495C13.953 7.61608 13.9774 6.64734 13.8051 5.70405C14.6354 5.89992 15.4096 6.28412 16.0679 6.82698C16.7263 7.36984 17.2512 8.05685 17.6022 8.83499C17.9532 9.61312 18.1208 10.4616 18.0922 11.3148C18.0636 12.1681 17.8394 13.0034 17.4371 13.7562C17.3505 13.9175 17.3308 14.1064 17.3823 14.2821H17.3797Z" fill="white"/>
          </svg>
          Let&apos;s Chat
          </span>
        </span>
      </button>`
    : floatingType === 'compact'
      ? `
      <button class="floating-launcher floating-launcher-compact hidden" id="floating-btn" aria-label="Open chat">
        ${floatingIcon}
        <span class="floating-compact-label">Need<br/> Assistance ?</span>
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

      <!-- Contact Form (paid plan fallback) -->
      <div id="contactFormSlot" class="contact-form hidden">
        <div class="contact-form-backdrop"></div>
        <div class="contact-form-shell">
          <div class="contact-form-card">
            <div class="contact-form-copy">
              <h3>${config.leadFormEnabled ? "Just a few details so we can keep helping you 😊" : 'What can we improve?'}</h3>
              <p>${config.leadFormEnabled ? 'Share your details to continue the conversation with our team.' : "Thanks for helping us do better. Tell us what we can improve and we'll take it from there."}</p>
            </div>
            <div class="contact-form-fields">
              ${leadFields}
              ${config.leadFormEnabled ? '' : '<textarea id="cf-message" placeholder="Type your feedback..."></textarea>'}
            </div>
            <div class="cf-agreement">
              <label class="cf-checkbox-wrapper">
                <input type="checkbox" id="cf-agree" />
                <span class="cf-checkbox-custom"></span>
                <span class="cf-agreement-text">I agree to the <a href="#">Privacy Policy</a> and <a href="#">Terms & Conditions</a></span>
              </label>
            </div>
            <button id="cf-submit" class="contact-form-submit" disabled>${config.leadFormEnabled ? config.leadFormButtonText || 'Continue' : 'Continue'}</button>
            <div class="contact-form-note">${config.leadFormEnabled ? "We'll only use these details to follow up on your request." : 'Your feedback helps us refine the experience.'}</div>
          </div>
        </div>
      </div>

      <!-- Calendly booking slot -->
      <div id="calendlySlot" class="contact-form hidden"></div>

      <!-- Conversation rating slot (paid plans) -->
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
          <button class="chat-send-btn" id="textSendButton" disabled aria-disabled="true">
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
