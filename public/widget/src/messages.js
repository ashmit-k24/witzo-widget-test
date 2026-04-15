import { LOGO_DEFAULT_SVG } from './icons.js';

/** Sanitize a URL - only allow http/https/mailto/tel protocols */
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

function formatInlineMarkdown(text) {
  let html = escapeHtml(String(text || ''));

  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const safe = sanitizeURL(url);
    return safe
      ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : label;
  });

  html = html.replace(
    /(^|\s)(https?:\/\/[^\s<>")\]]+)/g,
    (_, before, url) => {
      const stripped = url.replace(/[.,;:!?]+$/, '');
      const trailing = url.slice(stripped.length);
      const safe = sanitizeURL(stripped);
      return safe
        ? `${before}<a href="${safe}" target="_blank" rel="noopener noreferrer">${stripped}</a>${trailing}`
        : `${before}${url}`;
    }
  );

  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return html;
}

function normalizeMarkdown(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n');

  return lines.map(rawLine => {
    let line = rawLine.replace(/\*{3,}/g, '**').replace(/\s+$/g, '');
    const boldMarkers = line.match(/\*\*/g) || [];
    if (boldMarkers.length % 2 !== 0) {
      const lastMarkerIndex = line.lastIndexOf('**');
      if (lastMarkerIndex >= 0) {
        line = line.slice(0, lastMarkerIndex) + line.slice(lastMarkerIndex + 2);
      }
    }
    return line;
  }).join('\n');
}

function flushParagraph(lines, blocks) {
  if (lines.length === 0) return;
  blocks.push(`<p>${lines.map(formatInlineMarkdown).join('<br>')}</p>`);
  lines.length = 0;
}

function flushList(type, items, blocks) {
  if (!type || items.length === 0) return;
  blocks.push(`<${type}>${items.map(item => `<li>${formatInlineMarkdown(item)}</li>`).join('')}</${type}>`);
  items.length = 0;
}

/** Minimal Markdown -> HTML: headings, bold, links, lists, paragraphs */
export function parseMarkdown(text) {
  if (!text) return '';

  const lines = normalizeMarkdown(text).split('\n');
  const blocks = [];
  const paragraphLines = [];
  const listItems = [];
  let currentListType = '';

  const flushAll = () => {
    flushParagraph(paragraphLines, blocks);
    flushList(currentListType, listItems, blocks);
    currentListType = '';
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushAll();
      continue;
    }

    const headingMatch = line.match(/^(#{2,4})\s+(.+)$/);
    if (headingMatch) {
      flushAll();
      const level = Math.min(4, headingMatch[1].length);
      blocks.push(`<h${level}>${formatInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    const strongHeadingMatch = line.match(/^\*\*(.+?)\*\*:?\s*$/);
    if (strongHeadingMatch) {
      flushAll();
      blocks.push(`<h3>${formatInlineMarkdown(strongHeadingMatch[1])}</h3>`);
      continue;
    }

    const unorderedMatch = line.match(/^[-*]\s+(.+)$/);
    if (unorderedMatch) {
      flushParagraph(paragraphLines, blocks);
      if (currentListType && currentListType !== 'ul') {
        flushList(currentListType, listItems, blocks);
      }
      currentListType = 'ul';
      listItems.push(unorderedMatch[1]);
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (orderedMatch) {
      flushParagraph(paragraphLines, blocks);
      if (currentListType && currentListType !== 'ol') {
        flushList(currentListType, listItems, blocks);
      }
      currentListType = 'ol';
      listItems.push(orderedMatch[1]);
      continue;
    }

    if (currentListType) {
      flushList(currentListType, listItems, blocks);
      currentListType = '';
    }

    paragraphLines.push(line);
  }

  flushAll();
  return blocks.join('');
}

/** Returns bot avatar HTML (logo image or default SVG) */
export function getBotIconHtml(logoIcon) {
  return `<div class="bot-msg-chat-icon">
   <svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 19 19" fill="none">
      <circle cx="9.5" cy="9.5" r="9" fill="white" stroke="url(#paint0_linear_2082_9533)"/>
      <path d="M9.34952 4.92014C9.37338 4.80273 9.62662 4.80273 9.65048 4.92014C9.84029 5.85394 10.2365 7.26553 10.9855 8.0145C11.7345 8.76347 13.1461 9.15971 14.0799 9.34952C14.1973 9.37338 14.1973 9.62662 14.0799 9.65048C13.1461 9.84029 11.7345 10.2365 10.9855 10.9855C10.2365 11.7345 9.84029 13.1461 9.65048 14.0799C9.62662 14.1973 9.37338 14.1973 9.34952 14.0799C9.15971 13.1461 8.76347 11.7345 8.0145 10.9855C7.26553 10.2365 5.85394 9.84029 4.92014 9.65048C4.80273 9.62662 4.80273 9.37338 4.92014 9.34952C5.85394 9.15971 7.26553 8.76347 8.0145 8.0145C8.76347 7.26553 9.15971 5.85394 9.34952 4.92014Z" fill="url(#paint1_linear_2082_9533)"/>
      <defs>
      <linearGradient id="paint0_linear_2082_9533" x1="9.5" y1="0" x2="9.5" y2="19" gradientUnits="userSpaceOnUse">
      <stop stop-color="#7E0AF4"/>
      <stop offset="1" stop-color="#F54749"/>
      </linearGradient>
      <linearGradient id="paint1_linear_2082_9533" x1="9.5" y1="4" x2="9.5" y2="15" gradientUnits="userSpaceOnUse">
      <stop stop-color="#7B09F8"/>
      <stop offset="1" stop-color="#F4464B"/>
      </linearGradient>
      </defs>
    </svg>
  </div>`;
}

/** Append a user or bot message bubble to the messages container */
export function appendMessage(text, type, container) {
  const wrapper = document.createElement('div');
  wrapper.className = `chat-message${type === 'user' ? ' user' : ''}`;

  const bubble = document.createElement('div');
  bubble.className = type === 'user' ? 'chat-bubble-user' : 'chat-bubble-ai';
  bubble.innerHTML = `<div class="md-content">${parseMarkdown(text)}</div>`;

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

function keepStreamingReplyVisible(wrapper) {
  const container = wrapper.parentElement;
  if (!container) return;
  if (wrapper.__streamScrollQueued) return;
  wrapper.__streamScrollQueued = true;

  requestAnimationFrame(() => {
    wrapper.__streamScrollQueued = false;
    const containerRect = container.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const overflow = wrapperRect.bottom - (containerRect.bottom - 12);

    if (overflow > 0) {
      container.scrollTop += overflow;
    }
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
export function updateStreamingBubble(wrapper, text, logoIcon, widget) {
  const bubble = wrapper.querySelector('.typing-indicator') || wrapper.querySelector('.chat-bubble-ai');
  if (!bubble) return;

  let streamTextNode = bubble.querySelector('.streaming-text');
  if (!streamTextNode) {
    bubble.classList.remove('typing-indicator');
    bubble.innerHTML = `<div class="bot-message-row">${getBotIconHtml(logoIcon)}<div class="md-content"><div class="streaming-text"></div></div></div>`;
    streamTextNode = bubble.querySelector('.streaming-text');
  }

  if (streamTextNode) {
    const normalizedText = normalizeStreamingMarkdown(text || '');
    streamTextNode.innerHTML = parseMarkdown(normalizedText);
    if (widget && !widget._hasVisibleStreamingResponse && normalizedText.trim()) {
      widget._hasVisibleStreamingResponse = true;
      widget.updateSendButtonState?.();
    }
  }
  keepStreamingReplyVisible(wrapper);
}

/** Replace a typing indicator (or existing bubble) with bot reply content */
export function updateBubble(wrapper, text, logoIcon) {
  const bubble = wrapper.querySelector('.typing-indicator') || wrapper.querySelector('.chat-bubble-ai');
  if (!bubble) return;
  bubble.classList.remove('typing-indicator');
  bubble.innerHTML = `<div class="bot-message-row">${getBotIconHtml(logoIcon)}<div class="md-content">${parseMarkdown(text)}</div></div>`;
  queueScrollToBottom(wrapper);
}

/**
 * Append a compact "Sources" block below a bot message wrapper.
 * sources: Array<{ url: string, title: string, relevanceScore?: number }>
 * Only shows unique http/https URLs, max 5, sorted by relevance score desc.
 */
export function appendSources(wrapper, sources) {
  if (!Array.isArray(sources) || sources.length === 0) return;

  const seen = new Set();
  const unique = [];
  for (const s of sources) {
    const url = sanitizeURL(String(s.url || '').trim());
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push({ url, title: String(s.title || url).trim() || url });
    if (unique.length >= 5) break;
  }
  if (unique.length === 0) return;

  const block = document.createElement('div');
  block.style.cssText = [
    'margin-top:5px',
    'padding:5px 10px',
    'font-size:11px',
    'line-height:1.7',
    'opacity:0.65',
    'border-top:1px solid rgba(128,128,128,0.2)',
  ].join(';');

  const label = document.createElement('span');
  label.textContent = 'Sources: ';
  label.style.fontWeight = '600';
  block.appendChild(label);

  unique.forEach((s, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.textContent = '  ·  ';
      block.appendChild(sep);
    }
    const a = document.createElement('a');
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = s.title;
    a.style.cssText = 'color:inherit;text-decoration:underline;text-underline-offset:2px;word-break:break-all;';
    block.appendChild(a);
  });

  wrapper.appendChild(block);
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
