import { animationsCSS } from './animations.js';
import { baseCSS }       from './base.js';
import { headerCSS }     from './header.js';
import { chatCSS }       from './chat.js';
import { inputCSS }      from './input.js';
import { formsCSS }      from './forms.js';
import { floatingCSS }   from './floating.js';

/**
 * Builds the full CSS string for the Shadow DOM.
 * Dynamic colors are injected as CSS Custom Properties on :host.
 */
export function buildCSS(config) {
  const vars = `
    :host {
      --color-primary:      ${config.sendColor      || '#fc0e3f'};
      --color-banner-bg:    ${config.bannerColor     || '#120b14'};
      --color-user-bubble:  ${config.userChatColor   || '#ffdde4'};
      --color-floating-btn: ${config.floatingBtn || config.floatingBtnColor || '#fc0e3f'};
      --color-send:         ${config.sendColor      || '#fc0e3f'};
      --color-banner:       ${config.bannerColor     || '#120b14'};
    }
  `;
  return vars + animationsCSS + baseCSS + headerCSS + chatCSS + inputCSS + formsCSS + floatingCSS;
}
