export const CHAT_RETRIEVAL_CACHE_TTL_SECONDS = 300; // 5 min (was 2 min)
export const CHAT_DEFAULT_TIMEOUT_MS = 25_000;
export const CHAT_SESSION_CACHE_TTL_SECONDS = 60 * 30;

// Retrieval quality
export const CHAT_RETRIEVAL_SCORE_THRESHOLD = 0.40; // filter out chunks below this cosine score
export const CHAT_CONTACT_SCORE_THRESHOLD = 0.25;   // lower bar for contact/location queries — offices often score low

// Hybrid Pinecone search — top K fetch count
export const CHAT_RETRIEVAL_TOP_K = 50;

// Chunking
export const CHUNK_MAX_WORDS = Number(
	process.env.SCRAPER_CHUNK_WORDS ?? 800,
);
export const CHUNK_OVERLAP_WORDS = Number(
	process.env.SCRAPER_CHUNK_OVERLAP_WORDS ?? 120,
);

// Reranking
export const CHAT_RERANK_TOP_N = 20; // after reranking, keep this many chunks

// MMR/dedup
export const CHAT_MMR_MAX_CHUNKS = 14;   // final chunks sent to OpenAI
export const CHAT_MAX_CHUNKS_PER_URL = 5; // MMR diversity cap (contact pages need 4-5 chunks for multiple offices)

// Contact/location queries — use higher limits so all offices/emails are included
export const CHAT_CONTACT_MMR_MAX_CHUNKS = 20;
export const CHAT_CONTACT_MAX_CHUNKS_PER_URL = 10;

// Memory summarization
export const CHAT_SUMMARY_TRIGGER_MESSAGES = 10; // summarize when history exceeds this
export const CHAT_SUMMARY_KEEP_RECENT = 6;        // always keep this many recent messages verbatim
export const CHAT_SUMMARY_CACHE_TTL_SECONDS = 60 * 60; // 1 hour

// Intent-specific word limits
export const CHAT_WORD_LIMIT_FACTUAL = 120;
export const CHAT_WORD_LIMIT_LIST = 420;
export const CHAT_WORD_LIMIT_EXPLANATION = 320;
export const CHAT_WORD_LIMIT_COMPARISON = 360;
export const CHAT_WORD_LIMIT_DEFAULT = 260;

// Agentic RAG
export const CHAT_AGENTIC_MAX_SUB_QUERIES = 3;
export const CHAT_AGENTIC_TIMEOUT_MS = 8_000; // per sub-query LLM call

const parseBoundedInt = (
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number => {
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return fallback;
	const value = Math.trunc(parsed);
	return Math.min(Math.max(value, min), max);
};

export const CHAT_HISTORY_WINDOW_MESSAGES = parseBoundedInt(
	process.env.CHAT_HISTORY_WINDOW_MESSAGES,
	30,
	10,
	50,
);

export const CHAT_SESSION_CACHE_MESSAGE_LIMIT = parseBoundedInt(
	process.env.CHAT_SESSION_CACHE_MESSAGE_LIMIT,
	Math.max(CHAT_HISTORY_WINDOW_MESSAGES + 10, 40),
	CHAT_HISTORY_WINDOW_MESSAGES,
	100,
);

export const CHAT_COMPLETION_MODEL =
	process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-4o";
export const CHAT_COMPLETION_TEMPERATURE = Number(
	process.env.OPENAI_CHAT_TEMPERATURE ?? 0.3,
);
export const CHAT_COMPLETION_MAX_TOKENS = Number(
	process.env.OPENAI_CHAT_MAX_TOKENS ?? 1500,
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
