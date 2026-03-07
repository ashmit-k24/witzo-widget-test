/* Uses CSS vars: --color-user-bubble */
export const chatCSS = `
  .chat-messages {
    padding: 1.25rem; background: #fff; flex: 1;
    overflow-y: auto; display: flex; flex-direction: column; gap: 1rem;
    scrollbar-width: thin; scrollbar-color: #888 #f5f5f5;
    transition: all 0.6s ease-in-out;
  }
  .chat-message { display: flex; align-items: flex-start; gap: 0.75rem; }
  .chat-message.mt-space { margin-top: 46px; transition: all 0.7s ease-in 0.3s; }
  .chat-message.user { flex-direction: row; justify-content: flex-end; gap: 0.5em; }

  .chat-bubble-ai  { padding: 0; max-width: 280px; color: #0f172a; font-size: 0.875rem; line-height: 1.3; }
  .chat-bubble-user {
    background: var(--color-user-bubble, #ffdde4);
    color: #fff; border-radius: 11px 0 11px 11px;
    padding: 10px 22px; max-width: 280px; font-size: 0.875rem; line-height: 1.3;
  }

  .bot-message-row { display: flex; flex-direction: row; align-items: flex-start; gap: 0.5rem; }

  .md-content p { margin: 0; }
  .md-content ul, .md-content ol { padding-left: 20px; margin: 5px 0; }
  .md-content a { color: #007bff; text-decoration: none; }
  .md-content a:hover { text-decoration: underline; }

  .typing-container {
    display: flex; align-items: center; gap: 5px; padding: 10px 2px;
  }
  .typing-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #94a3b8; display: inline-block;
    animation: typingBounce 1.4s ease-in-out infinite;
  }
  .typing-dot:nth-child(1) { animation-delay: 0s; }
  .typing-dot:nth-child(2) { animation-delay: 0.18s; }
  .typing-dot:nth-child(3) { animation-delay: 0.36s; }
`;
