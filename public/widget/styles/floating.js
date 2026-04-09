/* Uses CSS vars: --color-floating-btn, --color-primary */
export const floatingCSS = `
  #floatingBtn {
    position: fixed;
    bottom: 20px;
    right: 24px;
    z-index: 2147483647;
    animation: float 3s ease-in-out infinite;
  }

  .floating-launcher {
    display: flex;
    border: 0;
    font-family: inherit;
    transition: transform 0.25s ease, box-shadow 0.25s ease, opacity 0.25s ease;
  }
  .floating-launcher.widget-open {
    opacity: 1;
    pointer-events: auto;
  }

  .floating-launcher-prompt {
    position: relative;
    width: min(690px, calc(100vw - 48px));
    flex-direction: column;
    align-items: flex-end;
    gap: 12px;
    transition: width 0.35s ease, opacity 0.35s ease;
  }
  .floating-launcher-prompt.widget-open {
    width: auto;
  }
  .floating-launcher-prompt.widget-open .floating-help-pill {
    display: none;
  }
  .floating-launcher-prompt.is-collapsed {
    width: auto;
  }
  .floating-launcher-prompt.is-collapsed .floating-help-pill {
    display: none;
  }
  .floating-launcher-prompt.is-collapsed .floating-input-shell {
    max-width: 58px;
    min-height: 58px;
    gap: 0;
    padding: 0;
    background: transparent;
    box-shadow: none;
  }
  .floating-launcher-prompt.is-collapsed .floating-prompt-input {
    width: 0;
    opacity: 0;
    transform: translateX(18px);
    padding-left: 0;
    padding-right: 0;
    box-shadow: none;
  }
  .floating-launcher-prompt.is-collapsed .floating-prompt-send {
    margin: 0;
  }

  .floating-help-pill {
    border: none;
    background: #fff;
    border-radius: 999px 999px 0 999px;
    padding: 12px 22px;
    color: #111111;
    font-size: 16px;
    font-weight: 600;
    line-height: 1;
    box-shadow: 0 10px 26px rgba(0,0,0,0.14);
    cursor: pointer;
  }
  .floating-help-pill-text {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .floating-input-shell {
    width: 100%;
    max-width: 326px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0;
    border-radius: 999px;
    background: transparent;
    box-shadow: 0 0 28px rgba(139,39,251,0.18);
    height: 56px;
    overflow: hidden;
    transition: max-width 0.35s ease, padding 0.3s ease, gap 0.3s ease, background-color 0.3s ease, box-shadow 0.3s ease;
  }
  .floating-prompt-input {
    flex: 1;
    min-width: 0;
    border: none;
    background: #fff;
    border-radius: 999px;
    color: #000000;
    line-height: 1.35;
    padding: 18px 19px;
    font-weight: 500;
    font-size: 14px;
    letter-spacing: 0%;
    box-shadow: 0 12px 28px rgba(0,0,0,0.12);
    transition: opacity 0.28s ease, transform 0.28s ease, width 0.35s ease, padding 0.3s ease, background-color 0.3s ease, box-shadow 0.3s ease;
  }
  .floating-prompt-input::placeholder {
    color: #b7b7b7;
  }
  .floating-prompt-send {
    width: 58px;
    height: 58px;
    margin: -1px 0 0 0;
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
    transition: background-color 0.3s ease, box-shadow 0.3s ease, transform 0.25s ease;
  }
  .floating-prompt-send-icon {
    position: absolute;
    inset: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: opacity 0.2s ease, transform 0.2s ease;
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

  .floating-launcher-prompt.is-typing .floating-input-shell {
    gap: 0;
    padding: 0 0 0 12px;
    background: #fff;
  }
  .floating-launcher-prompt.is-typing .floating-prompt-input {
    background: transparent;
    box-shadow: none;
    padding-left: 8px;
  }

  .floating-launcher-prompt .floating-prompt-send-icon-arrow {
    opacity: 0;
    transform: scale(0.82);
  }
  .floating-launcher-prompt .floating-prompt-send-icon-arrow svg {
    width: 46%;
    height: 28%;
  }

  .floating-launcher-prompt.widget-open .floating-prompt-send {
    background: var(--color-send, #fc0e3f);
    box-shadow: 0 14px 30px rgba(244,69,105,0.3);
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
    max-width: 58px;
    gap: 0;
    padding: 0;
    background: transparent;
    box-shadow: none;
  }
  .floating-launcher-prompt.widget-open .floating-prompt-input {
    width: 0;
    opacity: 0;
    transform: translateX(18px);
    padding-left: 0;
    padding-right: 0;
    box-shadow: none;
  }

  .floating-launcher.entering {
    animation: floatingBtnIn 0.8s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards !important;
  }

  @media (max-width: 640px) {
    #floatingBtn {
      right: 14px;
      bottom: 14px;
    }
    .floating-launcher-prompt {
      width: min(92vw, 460px);
      gap: 10px;
    }
    .floating-help-pill {
      padding: 10px 18px;
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
  }
`;
