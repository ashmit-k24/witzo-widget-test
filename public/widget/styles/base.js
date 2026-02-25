export const baseCSS = `
  *, ::after, ::before { box-sizing: border-box; }
  :host { font-family: "Plus Jakarta Sans", system-ui, sans-serif; display: block; }
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

  .chat-widget {
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
    backdrop-filter: blur(10px);
    transform: scale(0.15) translateY(40px); opacity: 0;
    animation: slideUp 1s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
    transform-origin: right bottom;
    position: relative;
  }
  .chat-widget.minimizing {
    opacity: 1; transform: scale(1) translateY(0);
    animation: slideDown 0.7s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
  }
  .chat-widget::before {
    content: ''; position: absolute; inset: 0;
    background: #fff; border-radius: 15px;
    animation: overlayFade 1.2s ease-out forwards;
    pointer-events: none; z-index: 10;
  }
  .chat-widget.minimizing::before {
    animation: overlayMinimize 1.2s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
  }
`;
