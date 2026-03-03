export const baseCSS = `
  *, ::after, ::before { box-sizing: border-box; }
  :host { font-family: Inter, "Inter Fallback", system-ui, sans-serif; font-weight: 600; display: block; }
  :host, :host * { font-family: Inter, "Inter Fallback", system-ui, sans-serif; }
  .hidden { display: none !important; }

  #textChatWidget {
    position: fixed;
    bottom: 6em; right: 2em;
    z-index: 9999;
    width: 27rem; height: 100%;
    max-width: 90vw; max-height: 70vh;
    display: flex; flex-direction: column;
    border-radius: 15px; overflow: hidden;
    background: #fff;
    transition: width 0.4s ease-in-out, max-width 0.4s ease-in-out, max-height 0.4s ease-in-out;
  }

  #textChatWidget.intro-mode {
    background: #FEFEFE;
  }

  .chat-widget {
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
    opacity: 0;
    transform: scale(0.08) translateY(16px);
    animation: widgetOpen 0.65s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    transform-origin: right bottom;
    position: relative;
  }
  .chat-widget.minimizing {
    opacity: 1; transform: scale(1) translateY(0);
    animation: widgetClose 0.45s cubic-bezier(0.4, 0, 0.6, 0) forwards;
  }
`;
