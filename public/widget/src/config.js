/** Default widget configuration values */
export const DEFAULT_CONFIG = {
  primaryText:      null,
  sendColor:        '#fc0e3f',
  floatingBtnColor: '#fc0e3f',
  floatingBtn:      '#fc0e3f',
  floatingType:     'small',
  autoOpen:         false,
  bannerText:       'Text Chat',
  bannerTextColor:  '',
  bannerColor:      '#120b14',
  userChatColor:    '#d01137ff',
  closeButtonColor: '',
  logoIcon:         null,
  planType:         'free',
  defaultLanguage:  'en',
};

/** Supported languages for the language selector */
export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English'    },
  { code: 'es', label: 'Spanish'    },
  { code: 'fr', label: 'French'     },
  { code: 'de', label: 'German'     },
  { code: 'hi', label: 'Hindi'      },
  { code: 'ar', label: 'Arabic'     },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian'    },
  { code: 'ja', label: 'Japanese'   },
  { code: 'zh', label: 'Chinese'    },
  { code: 'it', label: 'Italian'    },
  { code: 'nl', label: 'Dutch'      },
  { code: 'ko', label: 'Korean'     },
  { code: 'tr', label: 'Turkish'    },
  { code: 'pl', label: 'Polish'     },
];

/** HTML attribute names that map to config keys (hyphen-case → camelCase) */
export const ATTR_LIST = [
  'primary-text', 'send-color', 'floating-btn-color', 'floating-btn',
  'floating-type',
  'auto-open', 'banner-text', 'banner-text-color', 'banner-color', 'user-chat-color',
  'close-button-color', 'logo-icon', 'plan-type', 'default-language',
];
