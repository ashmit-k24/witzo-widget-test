import { COUNTRIES } from './countries.js';

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

  // Open / close
  elements.floatingBtn.addEventListener('click', () => toggleChat(widget));
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
