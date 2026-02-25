export const animationsCSS = `
  @keyframes slideUp {
    0%   { transform: scale(0.15) translateY(40px); opacity: 1; }
    70%  { transform: scale(1) translateY(0); }
    100% { transform: scale(1) translateY(0); opacity: 1; }
  }
  @keyframes slideDown {
    0%   { transform: scale(1) translateY(0); opacity: 1; }
    100% { transform: scale(0.15) translateY(40px); opacity: 0; }
  }
  @keyframes overlayFade {
    0%   { opacity: 1; }
    70%  { opacity: 1; }
    100% { opacity: 0; pointer-events: none; }
  }
  @keyframes overlayMinimize {
    0%   { opacity: 1; pointer-events: auto; }
    100% { opacity: 1; pointer-events: auto; }
  }
  @keyframes float {
    0%, 100% { transform: translateY(0px); }
    50%       { transform: translateY(-5px); }
  }
  @keyframes typingBounce {
    0%, 100% { opacity: 0.5; transform: translateY(0); }
    50%       { opacity: 1;   transform: translateY(-3px); }
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
