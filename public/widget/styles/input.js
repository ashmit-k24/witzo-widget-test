/* Uses CSS vars: --color-primary */
export const inputCSS = `
  .chat-input {
    padding: 1rem; padding-bottom: 0.25rem;
    background: #fff; border-top: 1px solid #e2e8f0;
    display: flex; flex-direction: column; align-items: center;
    gap: 0.75rem; overflow: visible;
  }
  .chat-input-container {
    display: flex; width: 100%; gap: 0.5rem;
    align-items: center; justify-content: space-between; position: relative;
  }
  .chat-text-input {
    flex: 1; width: 100%; background: #fff; border-radius: 9999px;
    padding: 14px 24px; padding-right: 65px !important;
    font-size: 0.875rem; outline: none;
    border: 1px solid rgb(227, 227, 227);
    box-shadow: rgba(0,0,0,0.075) 0px 0.6px 2px -1.3px, rgba(0,0,0,0.067) 0px 2.3px 7.8px -2.7px, rgba(0,0,0,0.02) 0px 10px 34px -4px;
  }
  .chat-send-btn {
    width: 40px; height: 40px; border: none; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    color: #fff; cursor: pointer; overflow: hidden;
    background: transparent; padding: 0; transition: all 0.3s ease;
    opacity: 0.45;
  }
  .chat-send-btn:disabled { cursor: not-allowed; }
  .chat-send-btn.is-active { opacity: 1; }
  .chat-send-btn.is-active:hover { rotate: 90deg; box-shadow: rgba(100,100,111,0.2) 0px 7px 29px 0px; }
  .chat-send-icon {
    width: 3rem; height: 3rem; border-radius: 0.75rem;
    display: flex; align-items: center; justify-content: center;
    background: #d1d5db;
    transition: background 0.2s ease, transform 0.2s ease;
  }
  .chat-send-btn.is-active .chat-send-icon { background: var(--color-primary, #fc0e3f); }

  .chat-footer { padding-bottom: 10px; }
  .powered-by { text-align: center; font-size: 10px; font-weight: 500; color: #999; margin: 6px 0 0 0; opacity: 0.7; }
  .powered-by-brand { font-weight: 700; color: #666; text-decoration: none; cursor: pointer; }

  /* Language pill */
  .lang-pill {
    position: absolute; right: 56px; top: 50%; transform: translateY(-50%);
    display: flex; align-items: center; gap: 6px;
    background: #f1f3f5; border-radius: 9999px; padding: 5px 10px 5px 7px;
    cursor: pointer; font-size: 0.72rem; font-weight: 700;
    color: #1a1a2e; letter-spacing: 0.04em; user-select: none;
    transition: all 0.2s ease; z-index: 2;
  }
  .lang-pill:hover { background: #e2e8f0; }
  .lang-pill svg { flex-shrink: 0; }

  /* Language dropdown */
  .lang-dropdown {
    position: absolute; bottom: calc(100% + 10px); right: 0;
    min-width: 150px; background: #fff; border-radius: 0.75rem;
    border: 1px solid #e2e8f0;
    box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1);
    padding: 0.5rem; z-index: 1000; opacity: 0;
    transform: translateY(10px) scale(0.95); pointer-events: none;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    transform-origin: bottom right; max-height: 300px; overflow-y: auto;
    scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.1) transparent;
  }
  .lang-dropdown::-webkit-scrollbar { width: 3px; }
  .lang-dropdown::-webkit-scrollbar-track { background: transparent; }
  .lang-dropdown::-webkit-scrollbar-thumb { background-color: rgba(0,0,0,0.2); border-radius: 999px; }
  .lang-dropdown.show { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
  .lang-dropdown-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.5rem 0.75rem; font-size: 0.82rem; font-weight: 500;
    color: #0f172a; border-radius: 0.4rem; cursor: pointer; transition: background 0.15s;
  }
  .lang-dropdown-item:hover { background: #f1f5f9; }
  .lang-dropdown-item.active { color: var(--color-primary, #fc0e3f); background: #f8fafc; }
  .lang-check { width: 14px; height: 14px; color: var(--color-primary, #fc0e3f); opacity: 0; }
  .lang-dropdown-item.active .lang-check { opacity: 1; }
`;
