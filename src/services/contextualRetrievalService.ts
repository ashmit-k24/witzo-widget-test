import OpenAI from "openai";
import { config } from "../config/env";
import { RagChunk } from "../types";
import logger from "../utils/logger";

const openai = new OpenAI({
	apiKey: config.OPENAI_API_KEY,
});

const CONTEXT_CONCURRENCY = 10;
const CONTEXT_TIMEOUT_MS = 12000;
const BATCH_SIZE = 5;



/**
 * Safe truncation
 */
function truncateAtSentence(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;

	const truncated = text.slice(0, maxChars);

	const lastPeriod = Math.max(
		truncated.lastIndexOf(". "),
		truncated.lastIndexOf("! "),
		truncated.lastIndexOf("? "),
	);

	return lastPeriod > maxChars / 2
		? truncated.slice(0, lastPeriod + 1)
		: truncated;
}

/**
 * Robust parser
 */
function extractContexts(content: string): string[] {
	try {
		const parsed = JSON.parse(content);

		if (Array.isArray(parsed)) return parsed;

		return (
			parsed.contexts ||
			parsed.context ||
			parsed.data ||
			parsed.items ||
			parsed.results ||
			[]
		);
	} catch {
		return [];
	}
}



const generateBatchEnrichPrompt = (items: {
	chunk: RagChunk;
	page: { content: string; title: string };
}[]) => {
	const prompt = items
		.map((item, i) => {
			const docPreview = truncateAtSentence(item.page.content, 1200);
			const chunkPreview = truncateAtSentence(item.chunk.childText, 500);

			return `Item ${i + 1}
<document>
<title>${item.page.title}</title>
${docPreview}
</document>

<chunk>
${chunkPreview}
</chunk>`;
		})
		.join("\n\n");

	return prompt
}



/**
 * Batch LLM call
 */
async function generateBatchContexts(
	items: {
		chunk: RagChunk;
		page: { content: string; title: string };
	}[],
): Promise<string[]> {
	const prompt=generateBatchEnrichPrompt(items)

	const fullPrompt = `You must return EXACTLY ${items.length} contexts.

Format strictly:
{
  "contexts": ["...", "..."]
}

Rules:
- Return exactly ${items.length} items
- Never skip items
- If unsure, return a short generic context
- No explanation
- Always valid JSON

${prompt}`;

	try {
		logger.info("contextualRetrieval: batch LLM input", {
			items: items.length,
			promptLength: fullPrompt.length,
		});


		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CONTEXT_TIMEOUT_MS);

		let content = "{}";

		try {
			const completion = await openai.chat.completions.create(
				{
					model: "gpt-4o-mini",
					messages: [{ role: "user", content: fullPrompt }],
					temperature: 0,
					max_tokens: Math.max(512, items.length * 150),
					response_format: { type: "json_object" },
				},
				{ signal: controller.signal as any },
			);

			content =
				completion.choices[0]?.message?.content?.trim() ?? "{}";
		} finally {
			clearTimeout(timeout);
		}


		logger.info("contextualRetrieval: batch LLM output", {
			responsePreview: content.slice(0, 200),
		});

		let contexts = extractContexts(content);


		//Ensure contexts length match with items send for enriching
		if (contexts.length !== items.length) {
			// writeDebugLog("LLM OUTPUT", `expected: ${items.length} && got: ${contexts.length}`);
			logger.warn("\n\n\n\n\n\n contextualRetrieval: context length mismatch", {
				expected: items.length,
				got: contexts.length,
				input:{
					items: items.length,
					promptLength: fullPrompt.length,
					fullPrompt:fullPrompt
				},
				output:{
					contexts:contexts
				}
			});

			contexts = Array.from({ length: items.length }).map(
				(_, i) =>
					contexts[i] ||
					`This section is part of ${items[i].page.title}`,
			);
		}

		return contexts;
	} catch (error) {
		logger.warn("contextualRetrieval: batch failed", {
			error: error instanceof Error ? error.message : String(error),
		});

		// 🔥 fallback full batch
		return items.map(
			(item) => `This section is part of ${item.page.title}`,
		);
	}
}










/**
 * Main enrichment
 */
export async function enrichChunksWithContext(
	chunks: RagChunk[],
	pageContentByUrl: Map<string, { content: string; title: string }>,
): Promise<RagChunk[]> {
	if (chunks.length === 0) return chunks;

	const startedAt = Date.now();
	let enriched = 0;

	for (let i = 0; i < chunks.length; i += CONTEXT_CONCURRENCY * BATCH_SIZE) {
		const group = chunks.slice(i, i + CONTEXT_CONCURRENCY * BATCH_SIZE);

		const results = await Promise.allSettled(
			Array.from({ length: CONTEXT_CONCURRENCY }).map(async (_, idx) => {
				const start = idx * BATCH_SIZE;
				const batch = group.slice(start, start + BATCH_SIZE);

				if (!batch.length) return;

				const items = batch
					.map((chunk) => {
						const page = pageContentByUrl.get(chunk.url);

						if (!page || !page.content.trim()) return null;

						// skip tiny chunks
						if (!chunk.childText || chunk.childText.length < 200)
							return null;

						return { chunk, page };
					})
					.filter(Boolean) as {
						chunk: RagChunk;
						page: { content: string; title: string };
					}[];

				if (!items.length) return;

				const contexts = await generateBatchContexts(items);

				// 🔥 SAFE MAPPING (NO LOSS)
				for (let i = 0; i < items.length; i++) {
					const ctx = contexts[i];

					items[i].chunk.childText =
						`${ctx}\n\n${items[i].chunk.childText}`;

					enriched += 1;
				}
			}),
		);

		for (const result of results) {
			if (result.status === "rejected") {
				logger.warn("contextualRetrieval: batch item failed", {
					error:
						result.reason instanceof Error
							? result.reason.message
							: String(result.reason),
				});
			}
		}
	}

	logger.info("contextualRetrieval: enrichment completed", {
		totalChunks: chunks.length,
		enrichedChunks: enriched,
		durationMs: Date.now() - startedAt,
	});

	return chunks;
}