/* Uses CSS vars: --color-primary, --color-banner-bg */
export const formsCSS = `
  /* --- Contact Form --- */
  .contact-form {
    position: absolute;
    inset: 0;
    z-index: 18;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    overflow-y: auto;
  }
  .contact-form-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(255, 255, 255, 0.18);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
  .contact-form-shell {
    position: relative;
    z-index: 1;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .contact-form-card {
    width: 100%;
    max-width: 100%;
    height: auto;
    min-height: 450px;
    padding: 1.25rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    border-radius: 1.75rem 1.75rem 0 0;
    background: #fff;
    box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.1);
    border: none;
    box-sizing: border-box;
    position: relative;
    margin-top: auto;
  }
  .contact-form-copy {
    text-align: left;
  }
  .contact-form h3 { 
    margin: 0; 
    font-size: 20px; 
    font-weight: 700; 
    color: #111827; 
    line-height: 1.3;
    text-align: left;
  }
  .contact-form-fields {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .cf-field-group {
    position: relative;
    width: 100%;
  }
  .cf-field-group label,
  .cf-input-wrap label {
    position: absolute;
    top: 50%;
    left: 14px;
    transform: translateY(-50%);
    font-size: 13px;
    font-weight: 500;
    color: #9CA3AF;
    z-index: 1;
    pointer-events: none;
    transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
    background: transparent;
    padding: 0;
  }
  .cf-field-group:focus-within label,
  .cf-field-group.has-value label,
  .cf-input-wrap:focus-within label,
  .cf-input-wrap.has-value label {
    top: 0;
    transform: translateY(-50%) scale(0.85);
    left: 5px;
    background: #fff;
    padding: 0 6px;
    color: var(--color-primary, #fc0e3f);
  }
  .contact-form input {
    width: 100%;
    height: 46px;
    border: 1px solid #E5E7EB;
    border-radius: 5px;
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 500;
    color: #111827;
    background: #fff !important;
    outline: none;
    font-family: inherit;
    box-sizing: border-box;
    transition: border-color 0.18s ease;
  }
  .contact-form textarea {
    width: 100%;
    border: 1px solid #E5E7EB;
    border-radius: 5px;
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 500;
    color: #111827;
    background: #fff !important;
    outline: none;
    font-family: inherit;
    box-sizing: border-box;
    transition: border-color 0.18s ease;
    min-height: 90px;
    resize: vertical;
    padding-top: 18px;
  }
  .contact-form input::placeholder, .contact-form textarea::placeholder {
    color: #9CA3AF;
  }
  .contact-form input:focus, .contact-form textarea:focus {
    border-color: var(--color-primary, #fc0e3f);
    background: #fff !important;
  }

  .cf-phone-wrapper {
    display: flex;
    align-items: center;
    border: 1px solid #E5E7EB;
    border-radius: 5px;
    background: #fff !important;
    transition: border-color 0.18s ease;
  }
  .cf-phone-wrapper:focus-within {
    border-color: var(--color-primary, #fc0e3f);
    background: #fff !important;
  }
  .cf-phone-trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    cursor: pointer;
    border-right: 1px solid #F3F4F6;
    font-size: 13px;
    font-weight: 600;
    color: #111827;
    user-select: none;
    position: relative;
    white-space: nowrap;
  }
  .cf-phone-trigger svg {
    color: #6B7280;
    flex-shrink: 0;
  }
  .cf-input-wrap {
    position: relative;
    flex: 1;
  }
  .cf-phone-wrapper input {
    border: none;
    border-radius: 0;
    padding: 10px 12px;
  }
  .cf-phone-wrapper label {
    left: 12px;
  }

  /* --- Fixed Dropdowns --- */
  .cf-fixed-dropdown {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    background: #fff;
    border: 1px solid #E5E7EB;
    border-radius: 0.8rem;
    box-shadow: 0 10px 25px rgba(0,0,0,0.1);
    z-index: 50;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: cfDropdownIn 0.2s ease;
  }
  @keyframes cfDropdownIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .cf-fixed-dropdown.hidden { display: none; }
  
  #cf-phone-dropdown { width: 230px; }
  #cf-country-dropdown { 
    width: 100%; 
    min-width: 200px; 
    top: auto;
    bottom: calc(100% + 8px);
    animation-name: cfDropdownUp;
  }
  @keyframes cfDropdownUp {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .cf-country-search { padding: 8px; border-bottom: 1px solid #F3F4F6; }
  .cf-country-search input {
    border-radius: 0.4rem; padding: 6px 10px; font-size: 12px;
  }
  .cf-country-list, .cf-phone-list {
    max-height: 200px; overflow-y: auto;
  }
  .cf-country-item, .cf-phone-item {
    padding: 8px 12px; font-size: 13px; color: #374151; cursor: pointer;
    display: flex; align-items: center; gap: 8px;
  }
  .cf-country-item:hover, .cf-phone-item:hover { background: #F9FAFB; color: #111827; }

  .cf-country-wrapper { position: relative; width: 100%; text-align: left; }
  .cf-country-trigger {
    display: flex; align-items: center; justify-content: space-between;
    width: 100%; border: 1px solid #E5E7EB; border-radius: 5px;
    padding: 10px 14px; background: #fff !important;
    cursor: pointer; transition: all 0.18s ease;
    font-size: 13px; color: #9CA3AF;
    height: 46px;
    box-sizing: border-box;
  }
  .cf-country-trigger.has-value { color: #111827; font-weight: 500; border-color: var(--color-primary, #fc0e3f); }
  .cf-country-trigger:hover { border-color: var(--color-primary, #fc0e3f); }
  .cf-country-chevron { color: #6B7280; flex-shrink: 0; stroke-width: 2px; width: 20px; height: 20px; }

  .chat-widget:has(#contactFormSlot:not(.hidden)) .chat-footer {
    display: none;
  }
  .contact-form textarea { min-height: 90px; resize: vertical; padding-top: 18px; }
  .contact-form-success {
    text-align: center;
    font-size: 0.88rem;
    font-weight: 700;
    color: #0f9f64;
    padding: 1.4rem 0;
  }
  .contact-form.lead-form-gate {
    position: absolute;
    inset: 0;
    max-height: none;
    padding: 0;
    border-top: none;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  .contact-form.lead-form-gate .contact-form-shell { align-items: flex-end; height: 100%; }
  .contact-form.lead-form-gate .contact-form-card {
    width: 100%;
    max-width: 100%;
    border-radius:30px 30px 0 0;
    padding: 45px 50px;
    gap: 1.25rem;
    box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.1);
  }
  .contact-form.lead-form-gate .contact-form-copy { text-align: left; }
  .chat-messages.lead-form-open {
    flex: 1 1 45%;
    min-height: 35%;
  }
  @media (max-width: 640px) {
    .contact-form {
      padding: 0.85rem;
      align-items: flex-end;
    }
      .contact-form-shell {
			    bottom: 30px;
			}
    .contact-form-card {
      width: 100%;
      border-radius: 1.2rem;
      padding: 0.9rem;
      gap: 0.7rem;
    }
    .contact-form h3 {
      font-size: 1.1rem;
    }
    .contact-form p {
      font-size: 13px;
    }
    .contact-form input,
    .contact-form textarea,
    .contact-form-submit {
      font-size: 14px;
    }
    .contact-form textarea {
      min-height: 84px;
    }
  }

  /* --- Conversation Rating --- */
  .rating-row {
    display: flex; align-items: center; justify-content: center; gap: 0.4rem;
    padding: 0.55rem 0.75rem; background: #f8fafc; border-top: 1px solid #e2e8f0;
  }
  .rating-btn {
    background: transparent; border: 1px solid #e2e8f0; border-radius: 0.4rem;
    padding: 2px 6px; font-size: 0.9rem; cursor: pointer; transition: background 0.15s; line-height: 1.2;
  }
  .rating-btn:hover  { background: #f1f5f9; }
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

  /* --- Hope Banner --- */
  .hope-banner {
    display: flex; align-items: center; justify-content: center; gap: 0;
    width: fit-content; left: 0; right: 0; top: 68px; margin: 0 auto;
    padding: 12px 24px; border-radius: 0 0 25px 25px; position: fixed;
    font-size: 0.9rem; font-weight: 500; color: #1a1a2e; flex-shrink: 0; z-index: 10;
    background: linear-gradient(135deg,
      color-mix(in srgb, var(--color-banner-bg, #120b14) 5%, white) 0%,
      color-mix(in srgb, var(--color-primary, #350535) 15%, white) 100%);
    border: 1.5px solid transparent; background-clip: padding-box;
    animation: hopeBannerSlideIn 1.6s cubic-bezier(0.68, -0.55, 0.265, 1.55) forwards;
    animation-delay: 0.3s; opacity: 0;
  }
  .hope-banner.hidden { animation: none; display: none; }
  .hope-banner::before {
    content: ''; position: absolute; inset: 0; border-radius: 0 0 25px 25px; padding: 1.5px;
    background: linear-gradient(135deg, var(--color-banner-bg, #120b14) 0%, var(--color-primary, #350535) 100%);
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor; mask-composite: exclude; pointer-events: none;
  }
  #hopeBannerUp, #hopeBannerDown { transition: transform 0.8s ease; }
  #hopeBannerDown { transform: translateY(2px); }
  .hope-banner-text {
    flex: 1; text-align: center; overflow: hidden; white-space: nowrap; width: 0;
    animation: textFadeInExpand 1s cubic-bezier(0.25, 0.46, 0.45, 0.94) 0.7s forwards;
  }
  .hope-banner-btns { display: flex; gap: 5px; }
  .hope-banner-btn {
    background: transparent; border: none; cursor: pointer;
    font-size: 1.1rem; padding: 0 2px; line-height: 1; transition: transform 0.15s; flex-shrink: 0;
  }
  .hope-banner-btn.active { filter: drop-shadow(0 0 4px var(--color-primary, #350535)); }
`;
