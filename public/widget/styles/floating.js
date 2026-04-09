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
    border: 0;
    cursor: pointer;
    display: flex;
    font-family: inherit;
    transition: transform 0.25s ease, box-shadow 0.25s ease;
  }
  .floating-launcher.widget-open {
    pointer-events: auto;
  }
  .floating-launcher:hover { transform: translateY(-2px); }
  .floating-launcher:focus-visible {
    outline: 2px solid var(--color-primary, #fc0e3f);
    outline-offset: 2px;
  }

  .floating-orb {
    width: 58px;
    height: 58px;
    border-radius: 9999px;
    padding: 3px;
    box-shadow: 0 10px 24px rgba(0,0,0,0.22);
    flex-shrink: 0;
    display: flex;
    perspective: 600px;
  }
  .floating-orb-inner {
    width: 100%;
    height: 100%;
    border-radius: inherit;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    transform-style: preserve-3d;
    transition: transform 0.45s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .floating-launcher.widget-open .floating-orb-inner {
    transform: rotateY(180deg);
  }
  .floating-orb-inner svg {
    width: 20px;
    height: 20px;
  }

  /* Flip animation: chat icon (front face) ↔ close icon (back face) */
  .floating-icon-chat,
  .floating-icon-close {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
  }
  .floating-icon-close {
    transform: rotateY(180deg);
    background: #161616;
    border-radius: 50%;
  }
  }
  .floating-icon-close svg {
    width: 30% !important;
    height: 30% !important;
  }

  /* Collapse text labels when widget is open */
  .floating-launcher.widget-open .floating-compact-label { display: none; }
  .floating-launcher-compact.widget-open { background: transparent; box-shadow: none; padding: 0; }
  .floating-launcher.widget-open .floating-full-message,
  .floating-launcher.widget-open .floating-full-cta { display: none; }
  .floating-launcher-full.widget-open { width: auto; border-radius: 9999px; background: transparent; box-shadow: none; padding: 0; }

  .floating-launcher-small {
    background: transparent;
    padding: 0;
  }

  .floating-launcher-compact {
    align-items: center;
    gap: 16px;
    border-radius: 9999px;
    background: #fff;
    color: #111827;
    box-shadow: 0 14px 34px rgba(0,0,0,0.2);
    padding: 4px 20px 4px 4px;
  }
  .floating-compact-label {
    font-size: 14px;
    line-height: 1.1;
    font-weight: 600;
    white-space: nowrap;
    text-align: left;
  }

  .floating-launcher-full {
    width: 214px;
    border-radius: 17px;
    background: #fff;
    box-shadow: 0 18px 40px rgba(0,0,0,0.24);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    text-align: left;
  }
  .floating-full-message {
    color: #0f172a;
    font-size: 14px;
    font-weight: 600;
    line-height: 141%;
  }
  .floating-full-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .floating-full-row .floating-orb {
    width: 34px;
    height: 34px;
  }
  .floating-full-row .floating-orb-inner svg {
    width: 24px;
    height: 24px;
  }
  .floating-full-cta {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 7px;
    padding: 10px 26px;
    background: linear-gradient(135deg, var(--color-send, #fc0e3f) 0%, var(--color-banner, #120b14) 100%);
    color: #fff;
    font-size: 14px;
    font-weight: 500;
    letter-spacing: 0.2px;
    text-wrap: nowrap;
  }
  .floating-full-cta svg {
    width: 18px;
    height: 17px;
    flex-shrink: 0;
  }

  .floating-launcher.entering {
    animation: floatingBtnIn 0.8s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards !important;
  }

  @media (max-width: 640px) {
    #floatingBtn {
      right: 14px;
      bottom: 14px;
    }
    .floating-launcher-full {
      width: 230px;
    }
    .floating-full-message {
      font-size: 16px;
    }
    .floating-compact-label {
      font-size: 14px;
    }
  }
`;
