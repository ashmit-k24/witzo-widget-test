/**
 * Witzo Chat Widget - Standalone Version
 * Self-contained chat widget with widget-key authentication
 */
(function() {
  'use strict';

  // Define the custom element
  class WitzoChatWidget extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });

      // Properties
      this.apiUrl = '';
      this.widgetKey = '';
      this.sessionId = this.getOrCreateSessionId(); // Updated to use storage
      this.isOpen = false;
      this.messages = [];
      this.limitReached = false; // Flag to track limit status

      // Configuration with defaults
      this.config = {
        primaryText: '**Hey there!** How can I help you?',
        botColor: '#4F46E5',
        sendColor: '#4F46E5',
        floatingBtn: '#4F46E5',
        autoOpen: false,
        bannerText: 'Chat Support',
        bannerTextColor: '#FFFFFF',
        bannerColor: '#4F46E5',
        userChatColor: '#E5E7EB',
        closeButtonColor: '#6B7280',
        logoIcon: null
      };
    }

    // New method for session persistence
    getOrCreateSessionId() {
      const STORAGE_KEY = 'witzo_chat_session_id';
      let sid = localStorage.getItem(STORAGE_KEY);
      if (!sid) {
        sid = 'session_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
        localStorage.setItem(STORAGE_KEY, sid);
      }
      return sid;
    }

    connectedCallback() {
      // Read attributes
      this.apiUrl = this.getAttribute('api-url') || '';
      this.widgetKey = this.getAttribute('widget-key') || '';

      // Read configuration from attributes
      Object.keys(this.config).forEach(key => {
        const kebabKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
        const value = this.getAttribute(kebabKey);
        if (value !== null) {
          // Convert string booleans
          if (value === 'true') this.config[key] = true;
          else if (value === 'false') this.config[key] = false;
          else this.config[key] = value;
        }
      });

      this.render();
      this.attachEventListeners();

      // Auto-open if configured
      if (this.config.autoOpen) {
        setTimeout(() => this.openChat(), 500);
      }
    }

    // generateSessionId removed in favor of getOrCreateSessionId

    render() {
      this.shadowRoot.innerHTML = `
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          :host {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          }

          .chat-button {
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: ${this.config.floatingBtn};
            border: none;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            display: flex;
            align-items: center;
            justify-content: center;
            transition: transform 0.3s, box-shadow 0.3s;
          }

          .chat-button:hover {
            transform: scale(1.1);
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
          }

          .chat-button svg {
            width: 28px;
            height: 28px;
            fill: white;
          }

          .chat-window {
            position: fixed;
            bottom: 90px;
            right: 20px;
            width: 380px;
            height: 600px;
            max-height: calc(100vh - 120px);
            background: white;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
            display: none;
            flex-direction: column;
            overflow: hidden;
            animation: slideUp 0.3s ease-out;
          }

          .chat-window.open {
            display: flex;
          }

          @keyframes slideUp {
            from {
              opacity: 0;
              transform: translateY(20px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }

          .chat-header {
            background: ${this.config.bannerColor};
            color: ${this.config.bannerTextColor};
            padding: 16px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }

          .chat-header h3 {
            font-size: 16px;
            font-weight: 600;
            margin: 0;
          }

          .close-button {
            background: none;
            border: none;
            color: ${this.config.closeButtonColor};
            cursor: pointer;
            padding: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.8;
            transition: opacity 0.2s;
          }

          .close-button:hover {
            opacity: 1;
          }

          .close-button svg {
            width: 20px;
            height: 20px;
            fill: currentColor;
          }

          .chat-messages {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            background: #F9FAFB;
          }

          .message {
            margin-bottom: 16px;
            display: flex;
            flex-direction: column;
          }

          .message.bot {
            align-items: flex-start;
          }

          .message.user {
            align-items: flex-end;
          }

          .message-bubble {
            max-width: 80%;
            padding: 12px 16px;
            border-radius: 12px;
            word-wrap: break-word;
            line-height: 1.5;
            font-size: 14px;
          }

          .message.bot .message-bubble {
            background: ${this.config.botColor};
            color: white;
            border-bottom-left-radius: 4px;
          }

          .message.user .message-bubble {
            background: ${this.config.userChatColor};
            color: #1F2937;
            border-bottom-right-radius: 4px;
          }

          .message-sources {
            margin-top: 8px;
            font-size: 12px;
            color: #6B7280;
          }

          .message-sources a {
            color: ${this.config.botColor};
            text-decoration: none;
          }

          .message-sources a:hover {
            text-decoration: underline;
          }

          .typing-indicator {
            display: none;
            align-items: center;
            gap: 4px;
            padding: 12px 16px;
            background: ${this.config.botColor};
            color: white;
            border-radius: 12px;
            border-bottom-left-radius: 4px;
            max-width: 80px;
          }

          .typing-indicator.active {
            display: flex;
          }

          .typing-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: white;
            animation: typing 1.4s infinite;
          }

          .typing-dot:nth-child(2) {
            animation-delay: 0.2s;
          }

          .typing-dot:nth-child(3) {
            animation-delay: 0.4s;
          }

          @keyframes typing {
            0%, 60%, 100% {
              opacity: 0.3;
              transform: translateY(0);
            }
            30% {
              opacity: 1;
              transform: translateY(-10px);
            }
          }

          .chat-input {
            padding: 16px 20px;
            border-top: 1px solid #E5E7EB;
            background: white;
            display: flex;
            gap: 10px;
          }

          .chat-input input {
            flex: 1;
            border: 1px solid #E5E7EB;
            border-radius: 8px;
            padding: 10px 14px;
            font-size: 14px;
            outline: none;
            transition: border-color 0.2s;
          }

          .chat-input input:focus {
            border-color: ${this.config.botColor};
          }

          .send-button {
            background: ${this.config.sendColor};
            border: none;
            border-radius: 8px;
            padding: 10px 16px;
            color: white;
            cursor: pointer;
            transition: opacity 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
          }

          .send-button:hover {
            opacity: 0.9;
          }

          .send-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          .send-button svg {
            width: 20px;
            height: 20px;
            fill: white;
          }

          @media (max-width: 480px) {
            .chat-window {
              width: calc(100vw - 40px);
              height: calc(100vh - 120px);
              bottom: 90px;
              right: 20px;
            }
          }
        </style>

        <button class="chat-button" aria-label="Open chat">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
          </svg>
        </button>

        <div class="chat-window">
          <div class="chat-header">
            <h3>${this.config.bannerText}</h3>
            <button class="close-button" aria-label="Close chat">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
            </button>
          </div>
          <div class="chat-messages">
            <div class="typing-indicator">
              <div class="typing-dot"></div>
              <div class="typing-dot"></div>
              <div class="typing-dot"></div>
            </div>
          </div>
          <div class="chat-input">
            <input type="text" id="witzo-message" name="witzo-message" placeholder="Type your message..." aria-label="Message input" />
            <button class="send-button" aria-label="Send message">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
              </svg>
            </button>
          </div>
        </div>
      `;

      // Show welcome message if configured
      if (this.config.primaryText) {
        setTimeout(() => {
          this.addMessage(this.parseMarkdown(this.config.primaryText), 'bot');
        }, 500);
      }
    }

    attachEventListeners() {
      const chatButton = this.shadowRoot.querySelector('.chat-button');
      const closeButton = this.shadowRoot.querySelector('.close-button');
      const sendButton = this.shadowRoot.querySelector('.send-button');
      const input = this.shadowRoot.querySelector('.chat-input input');

      chatButton.addEventListener('click', () => this.toggleChat());
      closeButton.addEventListener('click', () => this.closeChat());
      sendButton.addEventListener('click', () => this.sendMessage());
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') this.sendMessage();
      });
    }

    toggleChat() {
      this.isOpen ? this.closeChat() : this.openChat();
    }

    openChat() {
      this.isOpen = true;
      const chatWindow = this.shadowRoot.querySelector('.chat-window');
      chatWindow.classList.add('open');

      // Focus input
      setTimeout(() => {
        this.shadowRoot.querySelector('.chat-input input').focus();
      }, 100);
    }

    closeChat() {
      this.isOpen = false;
      const chatWindow = this.shadowRoot.querySelector('.chat-window');
      chatWindow.classList.remove('open');
    }

    addMessage(content, type, sources = []) {
      const messagesContainer = this.shadowRoot.querySelector('.chat-messages');
      const messageDiv = document.createElement('div');
      messageDiv.className = `message ${type}`;

      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      bubble.innerHTML = content;

      messageDiv.appendChild(bubble);

      // Add sources if available
      if (sources && sources.length > 0) {
        const sourcesDiv = document.createElement('div');
        sourcesDiv.className = 'message-sources';
        sourcesDiv.innerHTML = '<strong>Sources:</strong><br>' +
          sources.map(s => `<a href="${s.url}" target="_blank">📄 ${s.title}</a>`).join('<br>');
        messageDiv.appendChild(sourcesDiv);
      }

      // Insert before typing indicator
      const typingIndicator = messagesContainer.querySelector('.typing-indicator');
      messagesContainer.insertBefore(messageDiv, typingIndicator);

      // Scroll to bottom
      messagesContainer.scrollTop = messagesContainer.scrollHeight;

      this.messages.push({ content, type, sources, timestamp: new Date() });
    }

    showTyping() {
      const typingIndicator = this.shadowRoot.querySelector('.typing-indicator');
      typingIndicator.classList.add('active');

      const messagesContainer = this.shadowRoot.querySelector('.chat-messages');
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    hideTyping() {
      const typingIndicator = this.shadowRoot.querySelector('.typing-indicator');
      typingIndicator.classList.remove('active');
    }

    async sendMessage() {
      const input = this.shadowRoot.querySelector('.chat-input input');
      const message = input.value.trim();

      if (!message) return;

      // Validate widget key
      if (!this.widgetKey) {
        console.error('Witzo Chat: widget-key attribute is required');
        this.addMessage('Error: Widget not configured properly', 'bot');
        return;
      }

      // Add user message
      this.addMessage(this.escapeHtml(message), 'user');
      input.value = '';

      // Show typing indicator
      this.showTyping();

      // Disable input
      const sendButton = this.shadowRoot.querySelector('.send-button');
      input.disabled = true;
      sendButton.disabled = true;

      try {
        const response = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            widgetKey: this.widgetKey,
            message: message,
            sessionId: this.sessionId
          })
        });

        const data = await response.json();

        this.hideTyping();

        // Handle conversation limit reached
        if (response.status === 403 && data.limitReached) {
          const limitMessage = `
            ${data.message || "You've reached your conversation limit."}

            Plan: ${data.data?.planType || 'Unknown'}
            Used: ${data.data?.conversationsUsed || 0}/${data.data?.conversationsLimit || 0}
            Resets: ${data.data?.resetDate ? new Date(data.data.resetDate).toLocaleDateString() : 'Unknown'}
          `;
          this.addMessage(limitMessage, 'bot');

          // Disable input checking flag
          this.limitReached = true;
          input.disabled = true;
          sendButton.disabled = true;
          input.placeholder = 'Conversation limit reached';
          return;
        }

        if (data.success && data.response) {
          this.addMessage(this.parseMarkdown(data.response), 'bot', data.sources || []);

          // Show usage warning if approaching limit
          if (data.warning) {
            console.warn('Witzo Widget:', data.warning);
            console.log('Usage:', data.usage);
          }
        } else {
          this.addMessage(data.message || 'Sorry, I couldn\'t process that. Please try again.', 'bot');
        }
      } catch (error) {
        this.hideTyping();
        console.error('Witzo Chat Error:', error);
        this.addMessage('Sorry, there was an error. Please try again.', 'bot');
      } finally {
        // Re-enable input (unless limit reached)
        if (!this.limitReached) {
          input.disabled = false;
          sendButton.disabled = false;
          input.focus();
        }
      }
    }

    parseMarkdown(text) {
      return text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/\n/g, '<br>');
    }

    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  }

  // Register the custom element
  if (!customElements.get('witzo-chat')) {
    customElements.define('witzo-chat', WitzoChatWidget);
  }
})();
