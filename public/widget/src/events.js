/**
 * Bind all DOM event listeners to the widget instance.
 * Called once after render().
 */
export function bindEvents(widget) {
  const { elements } = widget;

  // Open / close
  elements.floatingBtn.addEventListener('click', () => toggleChat(widget));
  elements.closeBtn.addEventListener('click',    () => toggleChat(widget));

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

  // Close dropdown on outside click
  widget.shadowRoot.addEventListener('click', () => {
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

