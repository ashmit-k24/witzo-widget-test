/* Uses CSS vars: --color-primary, --color-banner-bg */
export const formsCSS = `
  /* --- Contact Form --- */
  .contact-form {
    padding: 1.25rem; display: flex; flex-direction: column;
    gap: 0.75rem; background: #fff; flex: 1; overflow-y: auto;
  }
  .contact-form h3 { margin: 0 0 0.25rem 0; font-size: 1rem; font-weight: 700; color: #0f172a; }
  .contact-form p  { margin: 0 0 0.5rem 0; font-size: 0.82rem; color: #64748b; line-height: 1.5; }
  .contact-form input, .contact-form textarea {
    width: 100%; border: 1px solid #e2e8f0; border-radius: 0.5rem;
    padding: 0.6rem 0.75rem; font-size: 0.875rem;
    outline: none; font-family: inherit; box-sizing: border-box;
  }
  .contact-form input:focus, .contact-form textarea:focus { border-color: #3b82f6; }
  .contact-form textarea { min-height: 70px; resize: vertical; }
  .contact-form-submit {
    background: #0f172a; color: #fff; border: none; border-radius: 0.5rem;
    padding: 0.65rem 1rem; font-size: 0.875rem; font-weight: 600;
    cursor: pointer; width: 100%; font-family: inherit;
  }
  .contact-form-submit:disabled { opacity: 0.6; cursor: not-allowed; }
  .contact-form-success { text-align: center; font-size: 0.9rem; color: #16a34a; padding: 2rem 0; }

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

  /* --- Hope Banner --- */
  .hope-banner {
    display: flex; align-items: center; justify-content: center; gap: 0;
    width: fit-content; left: 0; right: 0; top: 68px; margin: 0 auto;
    padding: 12px 24px; border-radius: 0 0 25px 25px; position: fixed;
    font-size: 0.9rem; font-weight: 500; color: #1a1a2e; flex-shrink: 0; z-index: 0;
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
