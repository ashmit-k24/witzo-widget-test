/* Uses CSS vars: --color-floating-btn, --color-primary */
export const floatingCSS = `
  #floatingBtn {
    position: fixed;
    bottom: 20px;
    right: 24px;
    z-index: 0;
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

  .floating-launcher-prompt.widget-open {
    pointer-events: none;
  }

  .floating-launcher-prompt {
    --floating-help-pill-right-rest: 70px;
    --floating-help-pill-right-typing: 0px;
    --floating-close-btn-right-rest: calc(var(--floating-help-pill-right-rest) + 4px);
    --floating-close-btn-right-typing: calc(var(--floating-help-pill-right-typing) + 4px);
    --floating-help-pill-top-space: 66px;
    position: relative;
    width: fit-content;
    min-height: calc(56px + var(--floating-help-pill-top-space));
    flex-direction: column;
    align-items: flex-end;
    gap: 0;
    padding-top: var(--floating-help-pill-top-space);
    padding-right: 0;
    transition: width 0.35s ease, opacity 0.35s ease;
    transform-origin: right bottom;
  }
  .floating-launcher-prompt.widget-open {
    width: auto;
  }
  .floating-launcher-prompt.widget-open .floating-help-pill {
    display: none;
  }
  .floating-launcher-prompt.widget-open .floating-close-btn {
    display: none;
  }
  .floating-launcher-prompt.is-collapsed {
    width: auto;
    min-height: 58px;
    padding-top: 0;
  }
  .floating-launcher-prompt.is-collapsed .floating-help-pill {
    display: none;
  }
  .floating-launcher-prompt.is-collapsed .floating-close-btn {
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
  .floating-launcher-prompt.is-collapsed .floating-input-shell::before {
    transform: scaleX(0);
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

  .floating-close-btn {
    position: absolute;
    top: 0;
    right: var(--floating-close-btn-right-rest);
    width: 21px;
    height: 21px;
    padding: 0;
    border: none;
    background: transparent;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 3;
    transition: top 0.6s cubic-bezier(0.22, 1, 0.36, 1), right 0.6s cubic-bezier(0.22, 1, 0.36, 1), transform 0.6s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.6s cubic-bezier(0.22, 1, 0.36, 1);
    transform-origin: right bottom;
    will-change: transform, opacity;
  }
  .floating-close-btn svg {
    width: 21px;
    height: 21px;
    display: block;
  }
  .floating-help-pill {
    position: absolute;
    top: 28px;
    right: var(--floating-help-pill-right-rest);
    border: none;
    background: #fff;
    border-radius: 999px 999px 0 999px;
    padding: 8px 16px;
    color: #111111;
    font-size: 14px;
    font-weight: 600;
    line-height: 1;
    box-shadow: 0 10px 26px rgba(0,0,0,0.14);
    cursor: pointer;
    white-space: nowrap;
    z-index: 2;
    transition: top 0.6s cubic-bezier(0.22, 1, 0.36, 1), right 0.6s cubic-bezier(0.22, 1, 0.36, 1), transform 0.6s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.6s cubic-bezier(0.22, 1, 0.36, 1);
    transform-origin: right bottom;
    will-change: transform, opacity;
  }
  .floating-help-pill-text {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .floating-input-shell {
    width: 100%;
    max-width: 326px;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: end;
    gap: 12px;
    padding: 0;
    border-radius: 999px;
    background: transparent;
    height: 56px;
    transition: max-width 0.6s cubic-bezier(0.22, 1, 0.36, 1), padding 0.6s cubic-bezier(0.22, 1, 0.36, 1), gap 0.6s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.6s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.6s cubic-bezier(0.22, 1, 0.36, 1);
    transform-origin: right center;
    will-change: transform, opacity;
  }
  .floating-input-shell::before {
    content: "";
    position: absolute;
    top: 0; bottom: 0; left: 0; right: 70px;
    border-radius: inherit;
    background: #fff;
    transition: right 1.3s cubic-bezier(0.22, 1, 0.36, 1);
    will-change: right;
    pointer-events: none;
  }
  .floating-input-shell::after {
    content: "";
    position: absolute;
    top: 0; bottom: 0; left: 0; right: 70px;
    border-radius: inherit;
    border: 1px solid transparent;
    transition: right 1.3s cubic-bezier(0.22, 1, 0.36, 1), border-color 0.3s ease;
    will-change: right;
    pointer-events: none;
    z-index: 2;
  }
  .floating-input-shell:focus-within::after {
    border-color: var(--color-primary, #fc0e3f);
  }
  .floating-input-shell > * {
    position: relative;
    z-index: 1;
  }
  .floating-prompt-input-wrapper {
    flex: 1;
    display: flex;
    position: relative;
    border-radius: 999px;
    transition: all 0.3s ease;
    height: 100%;
    z-index: 1;
  }
  .floating-prompt-input-wrapper.is-glowing {
    box-shadow: 1px 0px 18px -11px var(--color-primary, #fc0e3f);
  }
  .floating-prompt-input-wrapper.is-glowing .chat-input-beam {
    opacity: 1;
  }
  .floating-prompt-input {
    flex: 1;
    min-width: 0;
    background: #fff;
    border: none;
    border-radius: 999px;
    color: #000000;
    line-height: 1.35;
    padding: 18px 19px;
    font-weight: 500;
			height: 100%;
    font-size: 14px;
    letter-spacing: 0%;
    box-shadow: 0 12px 28px rgba(0,0,0,0.12);
    transition: transform 0.75s cubic-bezier(0.22, 1, 0.36, 1), width 0.75s cubic-bezier(0.22, 1, 0.36, 1), padding 0.75s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.75s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.75s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .floating-prompt-input:focus,
  .floating-prompt-input:focus-visible {
    outline: none;
    box-shadow: 0 12px 28px rgba(0,0,0,0.12);
    border: none;
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
    transition: background-color 0.75s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.75s cubic-bezier(0.22, 1, 0.36, 1), transform 0.75s cubic-bezier(0.22, 1, 0.36, 1);
    will-change: transform, opacity;
  }
  .floating-prompt-send-icon {
    position: absolute;
    inset: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.75s cubic-bezier(0.22, 1, 0.36, 1);
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
    background: transparent;
  }
  .floating-launcher-prompt.is-typing {
    min-height: calc(56px + var(--floating-help-pill-top-space));
    padding-top: var(--floating-help-pill-top-space);
    padding-right: 0;
  }
  .floating-launcher-prompt.is-typing .floating-help-pill {
    top: 29px;
    right: var(--floating-help-pill-right-typing);
    transform: none;
  }
  .floating-launcher-prompt.is-typing .floating-close-btn {
    top: 0;
    right: var(--floating-close-btn-right-typing);
    transform: none;
  }
  .floating-launcher-prompt.is-typing .floating-input-shell::before {
    right: 0;
  }
  .floating-launcher-prompt.is-typing .floating-input-shell::after {
    right: 0;
    border-color: var(--color-primary, #fc0e3f);
  }
  .floating-launcher-prompt.is-typing .floating-prompt-input-wrapper {
    background: transparent;
    box-shadow: none;
  }
  .floating-launcher-prompt.is-typing .floating-prompt-input {
    background: transparent;
    box-shadow: none;
    padding-left: 8px;
    border: none;
  }

  .floating-launcher-prompt .floating-prompt-send-icon-arrow {
    opacity: 0;
    transform: scale(0.82);
  }
  .floating-launcher-prompt .floating-prompt-send-icon-arrow svg {
    width: 16px;
    height: 16px;
  }

  .floating-launcher-prompt.widget-open .floating-prompt-send {
    background: var(--color-primary, #471791);
    box-shadow: 0 14px 30px rgba(244,69,105,0.3);
    pointer-events: auto;
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
    background: transparent;
    box-shadow: none;
  }
  .floating-launcher-prompt.widget-open .floating-input-shell::before,
  .floating-launcher-prompt.widget-open .floating-input-shell::after {
    opacity: 0;
  }
  .floating-launcher-prompt.widget-open .floating-prompt-input-wrapper {
    opacity: 0;
    pointer-events: none;
  }

  .floating-launcher.entering {
    animation: floatingBtnIn 1.15s cubic-bezier(0.22, 1, 0.36, 1) both !important;
  }
  .floating-launcher-prompt.entering {
    pointer-events: none;
  }
  .floating-launcher-prompt.entering .floating-prompt-send {
    transform-origin: center center;
    animation: floatingOrbZoomIn 0.48s cubic-bezier(0.16, 1, 0.3, 1) 0.02s both;
  }
  .floating-launcher-prompt.entering .floating-prompt-send-icon-chat {
    transform-origin: center center;
    animation: floatingOrbIconIn 0.42s cubic-bezier(0.16, 1, 0.3, 1) 0.08s both;
  }
  .floating-launcher-prompt.entering .floating-input-shell {
    animation: none;
  }
  .floating-launcher-prompt.entering .floating-prompt-input-wrapper {
    animation: floatingFieldFrameIn 0.72s cubic-bezier(0.22, 1, 0.36, 1) 0.18s both;
  }
  .floating-launcher-prompt.entering .floating-input-shell::before {
    opacity: 0;
    animation: none;
    transition: none;
  }
  .floating-launcher-prompt.entering .floating-prompt-input {
    animation: floatingInputTextIn 0.66s cubic-bezier(0.22, 1, 0.36, 1) 0.34s both;
  }
  .floating-launcher-prompt.entering .floating-close-btn {
    animation: floatingCloseBtnIn 0.52s cubic-bezier(0.22, 1, 0.36, 1) 0.46s both;
  }
  .floating-launcher-prompt.entering .floating-help-pill {
    animation: floatingHelpPillIn 0.62s cubic-bezier(0.22, 1, 0.36, 1) 0.56s both;
  }

  @keyframes floatingBtnIn {
    0% {
      opacity: 0;
      transform: translate3d(0, 18px, 0) scale(0.985);
    }
    100% {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }
  @keyframes floatingOrbZoomIn {
    0% {
      opacity: 0;
      transform: scale(0.9);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }
  @keyframes floatingOrbIconIn {
    0% {
      opacity: 0;
      transform: scale(0.78);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }
  @keyframes floatingFieldFrameIn {
    0% {
      opacity: 0;
      transform: translate3d(28px, 0, 0) scaleX(0.94);
    }
    100% {
      opacity: 1;
      transform: translate3d(0, 0, 0) scaleX(1);
    }
  }
  @keyframes floatingInputTextIn {
    0% {
      opacity: 0;
      transform: translate3d(22px, 0, 0);
    }
    100% {
      opacity: 1;
      transform: translate3d(0, 0, 0);
    }
  }
  @keyframes floatingHelpPillIn {
    0% {
      opacity: 0;
      transform: translate3d(24px, 0, 0) scale(0.96);
      filter: blur(6px);
    }
    100% {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
      filter: blur(0);
    }
  }
  @keyframes floatingCloseBtnIn {
    0% {
      opacity: 0;
      transform: translate3d(18px, 0, 0) scale(0.9);
      filter: blur(6px);
    }
    100% {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
      filter: blur(0);
    }
  }

  @media (max-width: 640px) {
    #floatingBtn {
      right: 14px;
      bottom: 14px;
    }
      .contact-form-shell {
			    bottom: 30px;
			}
    .floating-launcher-prompt {
      width: fit-content;
      --floating-help-pill-right-rest: 70px;
      --floating-help-pill-right-typing: 0px;
      --floating-close-btn-right-rest: calc(var(--floating-help-pill-right-rest) + 4px);
      --floating-close-btn-right-typing: calc(var(--floating-help-pill-right-typing) + 4px);
      --floating-help-pill-top-space: 66px;
    }
    .floating-help-pill {
      padding: 10px 18px;
      font-size: 15px;
    }
    .floating-prompt-input-wrapper {
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
