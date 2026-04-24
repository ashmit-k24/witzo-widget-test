import { COUNTRIES } from './countries.js';

// ─── Draggable floating widget ────────────────────────────────────────────────

const STORAGE_KEY = 'witzo_widget_pos';

/**
 * Initialises drag-and-drop on the #floatingBtn host element.
 * Supports mouse and touch, clamps to viewport, snaps to nearest edge,
 * persists position in localStorage, and guards click-vs-drag.
 */
export function initDrag(widget) {
  // The outer host element is the <witzo-chat> custom element itself, which
  // sits in the normal document. The #floatingBtn lives inside the shadow root.
  const host = widget;            // <witzo-chat> in the light DOM
  const shadow = widget.shadowRoot;
  const floatingBtn = shadow.getElementById('floatingBtn');
  if (!floatingBtn) return;

  // ── State ──────────────────────────────────────────────────────────────────
  let dragging   = false;
  let didDrag    = false;          // true when pointer moved > threshold
  let startX     = 0;
  let startY     = 0;
  let startLeft  = 0;
  let startTop   = 0;
  const DRAG_THRESHOLD = 6;        // px – minimum move before "drag" is declared

  // ── Helpers ────────────────────────────────────────────────────────────────
  function getRect() {
    return floatingBtn.getBoundingClientRect();
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Apply absolute positions to both the floating button and the chat widget.
   */
  function applyPosition(left, top, animate) {
    const transition = animate
      ? 'left 0.35s cubic-bezier(0.22,1,0.36,1), top 0.35s cubic-bezier(0.22,1,0.36,1), bottom 0.35s cubic-bezier(0.22,1,0.36,1), right 0.35s cubic-bezier(0.22,1,0.36,1)'
      : 'none';
    
    floatingBtn.style.transition = transition;
    floatingBtn.style.left = left + 'px';
    floatingBtn.style.top  = top  + 'px';
    floatingBtn.style.right  = 'auto';
    floatingBtn.style.bottom = 'auto';

    const chatWidget = shadow.getElementById('textChatWidget');
    if (chatWidget) {
      chatWidget.style.transition = transition;
      const rect = getRect();
      const vw = window.innerWidth;
      
      // Position chat widget above the button
      // We'll use bottom relative to the button's top
      const vh = window.innerHeight;
      const chatBottom = vh - top + 12; // 12px gap
      chatWidget.style.bottom = chatBottom + 'px';
      chatWidget.style.top = 'auto';

      // Horizontal alignment: 
      // If on the left half, align left edges. If on the right half, align right edges.
      if (left + rect.width / 2 < vw / 2) {
        chatWidget.style.left = left + 'px';
        chatWidget.style.right = 'auto';
        chatWidget.style.transformOrigin = 'left bottom';
      } else {
        chatWidget.style.right = (vw - (left + rect.width)) + 'px';
        chatWidget.style.left = 'auto';
        chatWidget.style.transformOrigin = 'right bottom';
      }
    }
  }

  /**
   * Snap widget to the nearest of the 4 screen corners.
   */
  function snapToCorner(animate) {
    const rect  = getRect();
    const vw    = window.innerWidth;
    const vh    = window.innerHeight;
    const midX  = rect.left + rect.width / 2;
    const midY  = rect.top + rect.height / 2;

    const EDGE_GAP = 16;
    let targetLeft = (midX < vw / 2) ? EDGE_GAP : vw - rect.width - EDGE_GAP;
    let targetTop  = (midY < vh / 2) ? EDGE_GAP : vh - rect.height - EDGE_GAP;

    applyPosition(targetLeft, targetTop, animate);
    savePosition(targetLeft, targetTop);
  }

  function savePosition(left, top) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ left, top }));
    } catch (_) {}
  }

  function loadPosition() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const { left, top } = JSON.parse(raw);
      if (typeof left === 'number' && typeof top === 'number') return { left, top };
    } catch (_) {}
    return null;
  }

  // ── Restore persisted position ─────────────────────────────────────────────
  function restorePosition() {
    const pos = loadPosition();
    
    // Small timeout so the element is fully rendered and has dimensions
    setTimeout(() => {
      const rect = getRect();
      const vw   = window.innerWidth;
      const vh   = window.innerHeight;
      const EDGE_GAP = 16;

      let left, top;
      if (pos) {
        left = clamp(pos.left, EDGE_GAP, vw - rect.width  - EDGE_GAP);
        top  = clamp(pos.top,  EDGE_GAP, vh - rect.height - EDGE_GAP);
      } else {
        // Default to bottom-right
        left = vw - rect.width - EDGE_GAP;
        top  = vh - rect.height - EDGE_GAP;
      }
      applyPosition(left, top, false);
    }, 50);
  }
  restorePosition();

  // ── Pointer event coordinates ──────────────────────────────────────────────
  function clientXY(e) {
    if (e.touches && e.touches.length) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    if (e.changedTouches && e.changedTouches.length) {
      return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
  }

  // ── Drag start ────────────────────────────────────────────────────────────
  function onPointerDown(e) {
    // Only primary button for mouse
    if (e.type === 'mousedown' && e.button !== 0) return;

    dragging  = true;
    didDrag   = false;

    const { x, y } = clientXY(e);
    startX = x;
    startY = y;

    const rect = getRect();
    startLeft  = rect.left;
    startTop   = rect.top;

    floatingBtn.style.transition = 'none';
    floatingBtn.classList.add('is-dragging');
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
  }

  // ── Drag move ─────────────────────────────────────────────────────────────
  function onPointerMove(e) {
    if (!dragging) return;
    e.preventDefault();

    const { x, y } = clientXY(e);
    const dx = x - startX;
    const dy = y - startY;

    if (!didDrag && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
      didDrag = true;
    }
    if (!didDrag) return;

    const rect = getRect();
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;
    const EDGE_GAP = 4;

    const left = clamp(startLeft + dx, EDGE_GAP, vw - rect.width  - EDGE_GAP);
    const top  = clamp(startTop  + dy, EDGE_GAP, vh - rect.height - EDGE_GAP);

    applyPosition(left, top, false);
  }

  // ── Drag end ──────────────────────────────────────────────────────────────
  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;

    floatingBtn.classList.remove('is-dragging');
    document.body.style.userSelect   = '';
    document.body.style.webkitUserSelect = '';

    if (didDrag) {
      // Snap to nearest corner with smooth animation
      snapToCorner(true);
      // Swallow the upcoming click so the chat doesn't toggle
      widget._dragJustEnded = true;
      setTimeout(() => { widget._dragJustEnded = false; }, 200);
    }
  }

  // ── Attach events ─────────────────────────────────────────────────────────
  floatingBtn.addEventListener('mousedown',  onPointerDown, { passive: true });
  floatingBtn.addEventListener('touchstart', onPointerDown, { passive: true });

  window.addEventListener('mousemove',  onPointerMove, { passive: false });
  window.addEventListener('touchmove',  onPointerMove, { passive: false });

  window.addEventListener('mouseup',  onPointerUp);
  window.addEventListener('touchend', onPointerUp);

  // Handle viewport resize: re-clamp position so widget stays on-screen
  window.addEventListener('resize', () => {
    if (!floatingBtn.style.left) return; // not yet positioned via drag
    snapToCorner(true);
  });
}

// ─── Event binding ────────────────────────────────────────────────────────────

/**
 * Bind all DOM event listeners to the widget instance.
 * Called once after render().
 */
export function bindEvents(widget) {
  const { elements } = widget;

  if (elements.cfCountryTrigger) {
    bindCountryDropdown(widget);
  }
  
  if (elements.cfPhoneDropdown) {
    elements.cfPhoneDropdown.innerHTML = `<div class="cf-phone-list">${COUNTRIES.map(c => `<div class="cf-phone-item" data-code="${c.p}" data-name="${c.n}">${c.n} (${c.p})</div>`).join('')}</div>`;
    
    // Set initial custom data attribute if needed, but textContent handles the display
    // elements.cfPhoneCode.textContent will be updated on click

    elements.cfPhoneDropdown.querySelectorAll('.cf-phone-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        elements.cfPhoneCode.textContent = item.getAttribute('data-code');
        elements.cfPhoneCode.setAttribute('data-code', item.getAttribute('data-code'));
        elements.cfPhoneDropdown.classList.add('hidden');
        widget.updateCfSubmitState();
      });
    });

    elements.cfPhoneCodeTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      elements.cfPhoneDropdown.classList.toggle('hidden');
      elements.cfCountryDropdown?.classList.add('hidden');
    });
  }

  // Open / close – skip click if it immediately follows a drag
  elements.floatingBtn.addEventListener('click', () => {
    if (widget._dragJustEnded) return;
    toggleChat(widget);
  });
  elements.closeBtn.addEventListener('click', () => toggleChat(widget));

  // Send message
  elements.sendBtn.addEventListener('click', () => widget.handleSend());
  elements.input.addEventListener('input', () => widget.updateSendButtonState());
  elements.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); widget.handleSend(); }
  });

  // Language pill toggle
  if (elements.langPillBtn) {
    elements.langPillBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      elements.langDropdown.classList.toggle('show');
    });
  }

  // Language item selection
  elements.langItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      handleLanguageSelect(widget, item.getAttribute('data-code'));
    });
  });

  // Shared delegated click handling for feedback menus and dropdown dismissal.
  widget.shadowRoot.addEventListener('click', (e) => {
    if (e.target.closest('.message-feedback')) {
      widget.handleMessageFeedbackClick?.(e);
    } else {
      widget.closeAllMessageFeedbackMenus?.();
    }

    elements.langDropdown?.classList.remove('show');
  });

  // Hope banner thumbs
  elements.hopeBannerUp?.addEventListener('click', () => {
    elements.hopeBannerUp.classList.add('active');
    elements.hopeBannerDown.classList.remove('active');
    widget.doSubmitRating('up');
  });

  elements.hopeBannerDown?.addEventListener('click', () => {
    elements.hopeBannerDown.classList.add('active');
    elements.hopeBannerUp.classList.remove('active');
    widget.doSubmitRating('down');
  });
}

/** Open or close the chat window */
export function toggleChat(widget) {
  // Cancel any pending auto-open on first manual interaction
  if (widget._autoOpenTimer) {
    clearTimeout(widget._autoOpenTimer);
    widget._autoOpenTimer = null;
  }

  if (!widget.isOpen) {
    widget.isOpen = true;
    widget.elements.widget.classList.remove('hidden', 'minimizing');
    widget.elements.floatingBtn.classList.add('widget-open');
    setTimeout(() => widget.elements.input.focus(), 100);
    widget.showPendingHopeBanner();
  } else {
    widget.isOpen = false;
    widget.elements.widget.classList.add('minimizing');
    setTimeout(() => {
      widget.elements.widget.classList.add('hidden');
      const btn = widget.elements.floatingBtn;
      btn.classList.remove('widget-open');
      btn.classList.add('entering');
      setTimeout(() => btn.classList.remove('entering'), 550);
    }, 480);
  }
}

/** Update selected language and refresh dropdown UI */
export function handleLanguageSelect(widget, code) {
  const lang = code || 'en';
  widget.selectedLanguage = lang;
  widget.config.defaultLanguage = lang;
  sessionStorage.setItem(`witzo_chat_language_${widget.widgetKey || 'default'}`, lang);

  const pillCode = widget.shadowRoot.getElementById('langPillCode');
  if (pillCode) pillCode.textContent = lang.slice(0, 2).toUpperCase();

  widget.elements.langItems.forEach(item => {
    item.classList.toggle('active', item.getAttribute('data-code') === lang);
  });

  widget.elements.langDropdown?.classList.remove('show');
}

/** Initialize and bind country dropdown logic */
export function bindCountryDropdown(widget) {
  const { cfCountryTrigger, cfCountryDropdown, cfCountrySearch, cfCountryList, cfCountry, cfCountryValue, cfPhoneDropdown } = widget.elements;
  if (!cfCountryTrigger || !cfCountryDropdown) return;

  function renderCountries(filterText = '') {
    const list = cfCountryList;
    if (!list) return;
    list.innerHTML = '';
    const filtered = COUNTRIES.filter(c => c.n.toLowerCase().includes(filterText.toLowerCase()));
    if (filtered.length === 0) {
      list.innerHTML = '<div class="cf-country-item" style="pointer-events:none;color:#666;">No results</div>';
      return;
    }
    filtered.forEach(country => {
      const el = document.createElement('div');
      el.className = 'cf-country-item';
      el.innerHTML = `<span class="cf-country-name">${country.n}</span>`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (cfCountry) {
          cfCountry.value = country.n;
          cfCountry.parentElement.classList.add('has-value');
        }
        if (cfCountryValue) {
          cfCountryValue.textContent = country.n;
          cfCountryTrigger.classList.add('has-value');
        }
        cfCountryDropdown.classList.add('hidden');
        widget.updateCfSubmitState();
      });
      list.appendChild(el);
    });
  }

  cfCountryTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = cfCountryDropdown.classList.contains('hidden');
    cfCountryDropdown.classList.toggle('hidden');
    cfPhoneDropdown?.classList.add('hidden');

    if (isHidden) {
      if (cfCountrySearch) {
        cfCountrySearch.value = '';
        setTimeout(() => cfCountrySearch.focus(), 50);
      }
      renderCountries('');
    }
  });

  if (cfCountrySearch) {
    cfCountrySearch.addEventListener('input', (e) => {
      renderCountries(e.target.value);
    });
    cfCountrySearch.addEventListener('click', e => e.stopPropagation());
  }

  // Close when clicking outside
  widget.shadowRoot.addEventListener('click', () => {
    cfCountryDropdown.classList.add('hidden');
    cfPhoneDropdown?.classList.add('hidden');
  });
}
