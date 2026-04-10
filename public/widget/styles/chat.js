/* Uses CSS vars: --color-user-bubble */
export const chatCSS = `
  .chat-messages {
    --chat-messages-pad-top: 30px;
    --chat-messages-pad-side: 16px;
    --chat-messages-pad-bottom: 16px;
    --chat-messages-fade-size: 34px;
    padding: var(--chat-messages-pad-top) var(--chat-messages-pad-side) var(--chat-messages-pad-bottom);
    background: #fff;
    flex: 1;
    overflow-y: auto; display: flex; flex-direction: column; gap: 1rem;
    scrollbar-width: thin; scrollbar-color: #888 #f5f5f5;
    transition: all 0.6s ease-in-out;
  }
  .chat-message { display: flex; align-items: flex-start; gap: 0.75rem; }
  .chat-message.mt-space { margin-top: 46px; transition: all 0.7s ease-in 0.3s; }
  .chat-message.user { flex-direction: row; justify-content: flex-end; gap: 0.5em; }

  .chat-bubble-ai  { padding: 0; max-width: min(420px, calc(100vw - 110px)); color: #0f172a; font-size: 0.875rem; line-height: 1.45; }
  .chat-bubble-user {
    	border: solid 1px #D3D3D3;
			padding:10px 16px;
            max-width: 280px;
            font-size: 14px;
            line-height: 1.3;
			    border-top-left-radius: 16px;
    		border-top-right-radius: 16px;
    		border-bottom-right-radius: 2px;
    		border-bottom-left-radius: 16px;
            position: relative;
            z-index: 2;
  }

  .bot-message-row { display: flex; flex-direction: row; align-items: flex-start; gap: 0.5rem; position: relative; z-index: 2; }
  .bot-response-block { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; position: relative; }
  .message-feedback-row {
    display: flex;
    align-items: center;
    gap: 11px;
    margin-left: 56px;
    position: relative;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease, visibility 0.2s ease;
    margin-top: 3px;
  }
  .bot-response-block:hover .message-feedback-row,
  .message-feedback:hover .message-feedback-row,
  .message-feedback:focus-within .message-feedback-row {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transform: translateY(0);
  }

  .md-content { line-height: 1.65; word-break: break-word; }
  .md-content strong { font-weight: 600; }
  .md-content h2,
  .md-content h3,
  .md-content h4 {
    margin: 0 0 0.55rem 0; color: #0f172a; line-height: 1.35; font-weight: 700;
  }
  .md-content h2 { font-size: 1rem; margin-top: 0.9rem; }
  .md-content h3 { font-size: 0.94rem; margin-top: 0.8rem; }
  .md-content h4 { font-size: 0.9rem; }
  .md-content p { margin: 0; }
  .md-content > :first-child { margin-top: 0; }
  .md-content p + p,
  .md-content p + ul,
  .md-content p + ol,
  .md-content h2 + p,
  .md-content h2 + ul,
  .md-content h3 + p,
  .md-content h3 + ul,
  .md-content h4 + p,
  .md-content h4 + ul,
  .md-content h4 + ol,
  .md-content ul + h2,
  .md-content ul + h3,
  .md-content ul + h4,
  .md-content ol + h2,
  .md-content ol + h3,
  .md-content ol + h4 { margin-top: 0.55rem; }
  .md-content ul, .md-content ol { padding-left: 20px; margin: 0.45rem 0; }
  .md-content li { margin: 0.28rem 0; }
  .md-content a { color: #007bff; text-decoration: none; }
  .md-content a:hover { text-decoration: underline; }

  .typing-container {
    background-color: #F1F1F1;
    padding: 0 16px;
    border-top-left-radius: 2px;
    border-top-right-radius: 16px;
    border-bottom-right-radius: 16px;
    border-bottom-left-radius: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    position: relative;
    height: 40px;
    min-width: 72px;
  }
  .typing-indicator {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .typing-status-text {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.25;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    row-gap: 2px;
    column-gap: 0;
  }
  .typing-status-char {
    display: inline-block;
    background: linear-gradient(90deg, #820DEF 0%, #ED4355 100%);
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    opacity: 0.38;
    transform: translateY(1px) scale(0.98);
    filter: blur(0.4px);
    animation: typingStatusChar 2.8s cubic-bezier(0.22, 1, 0.36, 1) infinite;
    animation-delay: calc(var(--char-index, 0) * 0.035s);
    will-change: transform, opacity, filter, background-position;
  }
  .typing-status-char.space {
    width: 3px;
    background: none;
    opacity: 1;
    filter: none;
    transform: none;
    animation: none;
  }
  .typing-dots-text {
    width: 6px;
    height: 6px;
    animation: typingBounce 2.2s infinite;
    opacity: 0.55;
    display: block;
    background: #111111;
    border-radius: 50%;
  }
  .typing-dots-text:nth-child(1) { animation-delay: 0s; }
  .typing-dots-text:nth-child(2) { animation-delay: 0.5s; }
  .typing-dots-text:nth-child(3) { animation-delay: 1s; }
  @keyframes typingStatusChar {
    0%, 100% { opacity: 0.34; transform: translateY(1px) scale(0.98); filter: blur(0.45px); background-position: 0% 50%; }
    45% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); background-position: 100% 50%; }
    60% { opacity: 0.96; transform: translateY(0) scale(1); filter: blur(0); background-position: 100% 50%; }
  }
`;
