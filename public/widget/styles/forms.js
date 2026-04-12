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
    padding: clamp(1rem, 3vw, 1.5rem);
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
    width: min(100%, 29rem);
    padding: clamp(0.95rem, 2vw, 1.15rem);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    border-radius: 1.35rem;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(250, 250, 252, 0.96) 100%);
    border: 1px solid rgba(255, 255, 255, 0.84);
    box-shadow:
      0 30px 70px rgba(15, 23, 42, 0.18),
      0 10px 30px rgba(15, 23, 42, 0.08);
  }
  .contact-form-copy {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    text-align: center;
  }
  .contact-form-kicker {
    align-self: center;
    padding: 0.24rem 0.55rem;
    border-radius: 999px;
    font-size: 0.64rem;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-primary, #fc0e3f);
    background: color-mix(in srgb, var(--color-primary, #fc0e3f) 12%, white);
  }
  .contact-form h3 { margin: 0; font-size: 18px; font-weight: 800; color: #111827; line-height: 1.1; }
  .contact-form p  { margin: 0; font-size: 13px; color: #161616; line-height: 1.45;font-weight:600 }
  .contact-form-fields {
    display: grid;
    gap: 0.6rem;
  }
  .contact-form input, .contact-form textarea {
    width: 100%;
    border: 1px solid #D3D3D3;
    border-radius: 0.9rem;
    padding: 13px;
    font-size: 13px;
    font-weight: 600;
    color: #0f172a;
    background: rgba(255, 255, 255, 0.96);
    outline: none;
    font-family: inherit;
    box-sizing: border-box;
    transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
  }
  .contact-form input::placeholder, .contact-form textarea::placeholder {
    color: #818181;
    font-weight: 500;
  }
  .contact-form input:focus, .contact-form textarea:focus {
    border-color: color-mix(in srgb, var(--color-primary, #fc0e3f) 45%, white);
  }

  /* --- Country Custom Select --- */
  .cf-country-wrapper { position: relative; width: 100%; text-align: left; }
  .cf-country-trigger {
    display: flex; align-items: center; justify-content: space-between;
    width: 100%; border: 1px solid #D3D3D3; border-radius: 0.9rem;
    padding: 2px 13px 2px 10px; background: rgba(255, 255, 255, 0.96);
    cursor: pointer; transition: border-color 0.18s ease;
  }
  .cf-country-trigger:hover, .cf-country-wrapper:focus-within .cf-country-trigger {
    border-color: color-mix(in srgb, var(--color-primary, #fc0e3f) 45%, white);
  }
  .cf-country-flag { font-size: 1.25rem; margin-right: 6px; }
  .cf-country-trigger input {
    flex: 1; border: none; background: transparent; padding: 11px 0;
    font-size: 13px; font-weight: 600; color: #0f172a; outline: none; cursor: pointer;
    box-shadow: none; border-radius: 0;
  }
  .cf-country-trigger input:focus { border: none; }
  .cf-country-trigger input::placeholder { color: #818181; font-weight: 500; }
  .cf-country-chevron { color: #818181; flex-shrink: 0; }
  .cf-country-menu {
    position: absolute; bottom: calc(100% + 4px); left: 0; right: 0;
    background: #fff; border: 1px solid #e2e8f0; border-radius: 0.75rem;
    box-shadow: 0 10px 25px rgba(0,0,0,0.08); z-index: 50;
    overflow: hidden; display: flex; flex-direction: column;
  }
  .cf-country-menu.hidden { display: none; }
  .cf-country-search { padding: 8px; border-bottom: 1px solid #f1f5f9; background: #fafafa; }
  .cf-country-search input {
    width: 100%; border: 1px solid #e2e8f0; border-radius: 0.5rem;
    padding: 6px 10px; font-size: 12px; outline: none; background: #fff;
  }
  .cf-country-search input:focus { border-color: rgba(0,0,0,0.1); }
  .cf-country-list { max-height: 180px; overflow-y: auto; }
  .cf-country-item {
    padding: 8px 12px; display: flex; align-items: center; gap: 8px;
    cursor: pointer; font-size: 13px; color: #334155; font-weight: 600;
    text-align: left;
  }
  .cf-country-item:hover { background: #f1f5f9; color: #0f172a; }
  .cf-country-list-flag { font-size: 1.15rem; }
  .chat-widget:has(#contactFormSlot:not(.hidden)) .chat-footer {
  	display: none;
	}
  .contact-form textarea { min-height: 110px; resize: vertical; }
  .contact-form-submit {
    background: linear-gradient(90deg, color-mix(in srgb, var(--color-primary, #fc0e3f) 82%, #7c3aed) 0%, var(--color-primary, #fc0e3f) 100%);
    color: #fff;
    border: none;
    border-radius: 999px;
    padding: 12px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    width: 100%;
    font-family: inherit;
    transition: transform 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease;
  }
  .contact-form-submit:active { transform: translateY(0); }
  .contact-form-submit:disabled { opacity: 0.6; cursor: not-allowed; }
  .contact-form-note {
    text-align: center;
    font-size: 13px;
    line-height: 1.4;
    color: #818181;
		font-weight: 600;
  }
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
    padding: clamp(1rem, 3vw, 1.5rem);
    border-top: none;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  .contact-form.lead-form-gate .contact-form-shell { align-items: center; }
  .contact-form.lead-form-gate .contact-form-card {
    width: min(100%, 29rem);
    max-width: 29rem;
    border-radius: 1.35rem;
    padding: clamp(0.95rem, 2vw, 1.15rem);
    gap: 0.75rem;
    box-shadow:
      0 30px 70px rgba(15, 23, 42, 0.18),
      0 10px 30px rgba(15, 23, 42, 0.08);
  }
  .contact-form.lead-form-gate .contact-form-copy { text-align: center; }
  .contact-form.lead-form-gate .contact-form-kicker { align-self: center; }
  .contact-form.lead-form-gate .contact-form-note { text-align: center; }
  .chat-messages.lead-form-open {
    flex: 1 1 52%;
    min-height: 42%;
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
