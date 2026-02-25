import { LOGO_DEFAULT_SVG } from './icons.js';

/** Sanitize a URL – only allow http/https/mailto/tel protocols */
export function sanitizeURL(url) {
  if (!url) return '';
  return /^(https?|mailto|tel):/i.test(url) ? url : '';
}

/** Escape HTML special characters to prevent XSS */
export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[m]));
}

/** Minimal Markdown → HTML: bold, links, newlines */
export function parseMarkdown(text) {
  if (!text) return '';
  let html = text;
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, url) =>
    `<a href="${sanitizeURL(url)}" target="_blank" rel="noopener noreferrer">${txt}</a>`
  );
  html = html.replace(/\n/g, '<br>');
  return html;
}

/** Returns bot avatar HTML (logo image or default SVG) */
export function getBotIconHtml(logoIcon) {
  return `<div class="bot-msg-chat-icon">
    ${logoIcon ? `<img src="${logoIcon}" alt="Logo" />` : LOGO_DEFAULT_SVG}
  </div>`;
}

/** Append a user or bot message bubble to the messages container */
export function appendMessage(text, type, container) {
  const wrapper = document.createElement('div');
  wrapper.className = `chat-message${type === 'user' ? ' user' : ''}`;

  const bubble = document.createElement('div');
  bubble.className = type === 'user' ? 'chat-bubble-user' : 'chat-bubble-ai';
  bubble.innerHTML = `<div class="md-content"><p>${parseMarkdown(escapeHtml(text))}</p></div>`;

  wrapper.appendChild(bubble);
  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;
  return wrapper;
}

/** Create and return a typing indicator element (not yet appended) */
export function createTypingIndicator(logoIcon) {
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-message';
  const bubble = document.createElement('div');
  bubble.className = 'typing-indicator chat-bubble-ai';
  bubble.innerHTML = `
    <div class="bot-message-row">
      ${getBotIconHtml(logoIcon)}
      <div class="typing-container">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>
    </div>`;
  wrapper.appendChild(bubble);
  return wrapper;
}

function queueScrollToBottom(wrapper) {
  const container = wrapper.parentElement;
  if (!container) return;
  if (wrapper.__scrollQueued) return;
  wrapper.__scrollQueued = true;
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
    wrapper.__scrollQueued = false;
  });
}

function normalizeStreamingMarkdown(text) {
  if (!text) return '';
  let normalized = text;
  const boldMarkerCount = (normalized.match(/\*\*/g) || []).length;
  if (boldMarkerCount % 2 !== 0) {
    const lastBoldMarkerIndex = normalized.lastIndexOf('**');
    if (lastBoldMarkerIndex >= 0) {
      normalized =
        normalized.slice(0, lastBoldMarkerIndex) +
        normalized.slice(lastBoldMarkerIndex + 2);
    }
  }
  return normalized;
}

/** Smooth streaming update: mutate text node only (no full HTML re-render). */
export function updateStreamingBubble(wrapper, text, logoIcon) {
  const bubble = wrapper.querySelector('.typing-indicator') || wrapper.querySelector('.chat-bubble-ai');
  if (!bubble) return;

  let streamTextNode = bubble.querySelector('.streaming-text');
  if (!streamTextNode) {
    bubble.classList.remove('typing-indicator');
    bubble.innerHTML = `<div class="bot-message-row">${getBotIconHtml(logoIcon)}<div class="md-content"><p class="streaming-text"></p></div></div>`;
    streamTextNode = bubble.querySelector('.streaming-text');
  }

  if (streamTextNode) {
    const normalizedText = normalizeStreamingMarkdown(text || '');
    streamTextNode.innerHTML = parseMarkdown(escapeHtml(normalizedText));
  }
  queueScrollToBottom(wrapper);
}

/** Replace a typing indicator (or existing bubble) with bot reply content */
export function updateBubble(wrapper, text, logoIcon) {
  const bubble = wrapper.querySelector('.typing-indicator') || wrapper.querySelector('.chat-bubble-ai');
  if (!bubble) return;
  bubble.classList.remove('typing-indicator');
  bubble.innerHTML = `<div class="bot-message-row">${getBotIconHtml(logoIcon)}<div class="md-content">${parseMarkdown(text)}</div></div>`;
  queueScrollToBottom(wrapper);
}

/** Check if user message signals end of conversation (for rating prompt) */
export function isConversationEndMessage(text) {
  if (!text) return false;
  const normalized = String(text).toLowerCase().trim();
  const patterns = [
    /\b(thanks|thank you|thankyou|thx)\b/,
    /\b(bye|goodbye|see you|see ya|take care)\b/,
    /\b(that'?s all|thats all|done|resolved|got it)\b/,
    /\b(no thanks|no thank you|i'?m good|im good)\b/,
  ];
  return patterns.some(p => p.test(normalized));
}
