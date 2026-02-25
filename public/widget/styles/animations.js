export const animationsCSS = `
  @keyframes widgetOpen {
    0%   { opacity: 0; transform: scale(0.08) translateY(16px); filter: blur(3px); }
    35%  { opacity: 1; filter: blur(0); }
    100% { opacity: 1; filter: blur(0); transform: scale(1) translateY(0); }
  }
  @keyframes widgetClose {
    0%   { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); }
    100% { opacity: 0; transform: scale(0.08) translateY(16px); filter: blur(3px); }
  }
  @keyframes floatingBtnIn {
    0%   { opacity: 0; transform: scale(0.3); }
    60%  { opacity: 1; transform: scale(1.18); }
    80%  { transform: scale(0.95); }
    100% { opacity: 1; transform: scale(1); }
  }
  @keyframes float {
    0%, 100% { transform: translateY(0px); }
    50%       { transform: translateY(-5px); }
  }
  @keyframes typingBounce {
    0%, 60%, 100% { transform: translateY(0) scale(1);    opacity: 0.35; }
    30%           { transform: translateY(-6px) scale(1.2); opacity: 1; }
  }
  @keyframes hopeBannerSlideIn {
    0%   { opacity: 0; transform: translateY(-15px) scaleY(0.95); }
    40%  { opacity: 1; }
    65%  { transform: translateY(0) scaleY(1); }
    85%  { transform: translateY(-4px) scaleY(0.85); }
    100% { opacity: 1; transform: translateY(0) scaleY(1); }
  }
  @keyframes textFadeInExpand {
    0%   { opacity: 0; min-width: 0; margin-right: 0; }
    50%  { opacity: 0; min-width: 0; margin-right: 0; }
    100% { opacity: 1; min-width: 125px; margin-right: 20px; }
  }
`;
