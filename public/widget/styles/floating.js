/* Uses CSS vars: --color-floating-btn, --color-primary */
export const floatingCSS = `
  #floatingBtn {
    position: fixed;
    bottom: 20px;
    right: 24px;
    z-index: 9999;
    animation: float 3s ease-in-out infinite;
  }

  .floating-launcher {
    border: 0;
    cursor: pointer;
    display: flex;
    font-family: inherit;
    transition: transform 0.25s ease, box-shadow 0.25s ease;
  }
  .floating-launcher:hover { transform: translateY(-2px); }
  .floating-launcher:focus-visible {
    outline: 2px solid var(--color-primary, #fc0e3f);
    outline-offset: 2px;
  }

  .floating-orb {
    width: 54px;
    height: 54px;
    border-radius: 9999px;
    background: linear-gradient(135deg, var(--color-floating-btn, #fc0e3f) 0%, #7c3aed 100%);
    padding: 3px;
    box-shadow: 0 10px 24px rgba(0,0,0,0.22);
    flex-shrink: 0;
    display: flex;
  }
  .floating-orb-inner {
    width: 100%;
    height: 100%;
    border-radius: inherit;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #111827;
  }
  .floating-orb-inner svg {
    width: 28px;
    height: 28px;
  }

  .floating-launcher-small {
    background: transparent;
    padding: 0;
  }

  .floating-launcher-compact {
    align-items: center;
    gap: 12px;
    border-radius: 9999px;
    background: #fff;
    color: #111827;
    box-shadow: 0 14px 34px rgba(0,0,0,0.2);
    padding: 7px 16px 7px 7px;
  }
  .floating-compact-label {
    font-size: 16px;
    line-height: 1.1;
    font-weight: 700;
    white-space: nowrap;
    text-align: left;
  }

  .floating-launcher-full {
    width: 270px;
    border-radius: 18px;
    background: #fff;
    box-shadow: 0 18px 40px rgba(0,0,0,0.24);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    text-align: left;
  }
  .floating-full-message {
    color: #0f172a;
    font-size: 18px;
    font-weight: 600;
    line-height: 1.25;
  }
  .floating-full-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .floating-full-row .floating-orb {
    width: 46px;
    height: 46px;
  }
  .floating-full-row .floating-orb-inner svg {
    width: 24px;
    height: 24px;
  }
  .floating-full-cta {
    flex: 1;
    text-align: center;
    border-radius: 10px;
    padding: 10px 14px;
    background: linear-gradient(90deg, #6d28d9 0%, var(--color-floating-btn, #fc0e3f) 100%);
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.2px;
  }

  .floating-launcher.entering {
    animation: floatingBtnIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards !important;
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
