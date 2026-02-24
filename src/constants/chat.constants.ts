export const CHAT_RETRIEVAL_CACHE_TTL_SECONDS = 120;
export const CHAT_DEFAULT_TIMEOUT_MS = 25_000;
export const CHAT_SESSION_CACHE_TTL_SECONDS =
	60 * 30;
export const CHAT_SESSION_CACHE_MESSAGE_LIMIT = 20;
export const CHAT_HISTORY_WINDOW_MESSAGES =
	Number(
		process.env.CHAT_HISTORY_WINDOW_MESSAGES || 6,
	);
export const CHAT_COMPLETION_MODEL =
	process.env.OPENAI_CHAT_MODEL?.trim() ||
	"gpt-4.1-mini";
export const CHAT_COMPLETION_TEMPERATURE = 0.3;
export const CHAT_COMPLETION_MAX_TOKENS = Number(
	process.env.CHAT_COMPLETION_MAX_TOKENS || 350,
);

// Token/cost optimization controls (character-based guardrails).
export const CHAT_MAX_USER_MESSAGE_CHARS = Number(
	process.env.CHAT_MAX_USER_MESSAGE_CHARS || 1000,
);
export const CHAT_MAX_HISTORY_MESSAGE_CHARS =
	Number(
		process.env.CHAT_MAX_HISTORY_MESSAGE_CHARS ||
			350,
	);
export const CHAT_MAX_HISTORY_CHARS = Number(
	process.env.CHAT_MAX_HISTORY_CHARS || 2500,
);
export const CHAT_MAX_CONTEXT_SOURCES = Number(
	process.env.CHAT_MAX_CONTEXT_SOURCES || 4,
);
export const CHAT_MAX_CONTEXT_SOURCE_CHARS =
	Number(
		process.env.CHAT_MAX_CONTEXT_SOURCE_CHARS ||
			1200,
	);
export const CHAT_MAX_CONTEXT_CHARS = Number(
	process.env.CHAT_MAX_CONTEXT_CHARS || 4500,
);
export const CHAT_MAX_RETRIEVAL_QUERY_CHARS =
	Number(
		process.env.CHAT_MAX_RETRIEVAL_QUERY_CHARS ||
			500,
	);

export const UUID_V1_TO_V5_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CHAT_SUPPORTED_LANGUAGE_CODES = [
	"en",
	"es",
	"fr",
	"de",
	"hi",
	"ar",
	"pt",
	"ru",
	"ja",
	"zh",
	"it",
	"nl",
	"ko",
	"tr",
	"pl",
] as const;

export type SupportedChatLanguageCode =
	(typeof CHAT_SUPPORTED_LANGUAGE_CODES)[number];

export const CHAT_SUPPORTED_LANGUAGE_SET =
	new Set<string>(CHAT_SUPPORTED_LANGUAGE_CODES);

export const CHAT_LANGUAGE_LABELS: Record<
	SupportedChatLanguageCode,
	string
> = {
	en: "English",
	es: "Spanish",
	fr: "French",
	de: "German",
	hi: "Hindi",
	ar: "Arabic",
	pt: "Portuguese",
	ru: "Russian",
	ja: "Japanese",
	zh: "Chinese",
	it: "Italian",
	nl: "Dutch",
	ko: "Korean",
	tr: "Turkish",
	pl: "Polish",
};
