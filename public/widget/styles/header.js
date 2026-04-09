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
    margin-right: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-primary, #8B27FB);
  }
  .bot-msg-chat-icon img {
    width: 100%; height: 100%; object-fit: contain; border-radius: 50%;
    box-shadow: 0px 2.4px 4.8px 0px #00000033;
  }
  #logoIcon { width: 40px; height: 40px; border-radius: 8px; object-fit: contain; }
  .chat-title { 
    font-weight: 700;
	  font-style: Bold;
	  font-size: 15px;
	  letter-spacing: 0%;
	  vertical-align: middle;
    font-family: "Plus Jakarta Sans", sans-serif;
		margin: 0 !important;

  }
  .chat-header-right { display: flex; align-items: center;gap:10px }
  .chat-action-btn {
    border: none; background: transparent; border-radius: 0.5rem;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; margin-left: 0.5rem; padding: 0;
  }
`;
