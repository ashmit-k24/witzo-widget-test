/* Uses CSS vars: --color-banner-bg, --color-banner-text */
export const headerCSS = `
  .chat-header {
    background: var(--color-banner-bg, #120b14);
    padding: 0 1rem; height: 60px;
    margin: 10px; margin-bottom: 0;
    border-radius: 10px;
    display: flex; align-items: center; justify-content: space-between;
    flex-shrink: 0; position: relative; z-index: 1;
  }
  .chat-header-left {
    display: flex; align-items: center; gap: 0.75rem; width: auto;
  }
  .chat-icon {
    width: auto; border-radius: 0.75rem;
    display: flex; align-items: center; justify-content: center;
  }
  .bot-msg-chat-icon {
    width: 40px; height: 40px; border-radius: 50%;
    padding: 4px; margin-right: 6px;
    display: flex; align-items: center; justify-content: center;
    background: #f1f5f9; flex-shrink: 0;
  }
  .bot-msg-chat-icon img {
    width: 100%; height: 100%; object-fit: contain; border-radius: 50%;
    box-shadow: 0px 2.4px 4.8px 0px #00000033;
  }
  #logoIcon { width: 40px; height: 40px; border-radius: 8px; object-fit: contain; }
  .chat-title { color: #fff; font-size: 20px; font-weight: 500; margin: 0; }
  .chat-header-right { display: flex; align-items: center; }
  .chat-action-btn {
    border: none; background: transparent; border-radius: 0.5rem;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; margin-left: 0.5rem; padding: 0;
  }
`;
