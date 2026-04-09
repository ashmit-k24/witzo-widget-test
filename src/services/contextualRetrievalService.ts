import OpenAI from "openai";
import { config } from "../config/env";
import { RagChunk } from "../types";
import logger from "../utils/logger";

const openai = new OpenAI({
	apiKey: config.OPENAI_API_KEY,
});

const CONTEXT_CONCURRENCY = 10;
const CONTEXT_MAX_TOKENS = 128;
const CONTEXT_TIMEOUT_MS = 15000;

function truncateAtSentence(
	text: string,
	maxChars: number,
): string {
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

// generateChunkContext generates a short contextual summary that situates a chunk
// within the full page content, following Anthropic's Contextual Retrieval approach.
async function generateChunkContext(
	chunkText: string,
	fullPageContent: string,
	pageTitle: string,
): Promise<string> {
	const docPreview = truncateAtSentence(fullPageContent, 6000);
	const chunkPreview = truncateAtSentence(chunkText, 1500);

	const prompt = `<document>
<title>${pageTitle}</title>
${docPreview}
</document>
Here is the chunk we want to situate within the whole document:
<chunk>
${chunkPreview}
</chunk>
Please give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk. Answer only with the succinct context and nothing else.`;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			CONTEXT_TIMEOUT_MS,
		);
		try {
			const completion =
				await openai.chat.completions.create(
					{
						model: "gpt-4o-mini",
						messages: [
							{ role: "user", content: prompt },
						],
						temperature: 0,
						max_tokens: CONTEXT_MAX_TOKENS,
					},
					{ signal: controller.signal as any },
				);
			return (
				completion.choices[0]?.message?.content?.trim() ?? ""
			);
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		logger.warn("contextualRetrieval: context generation failed for chunk", {
			pageTitle,
			chunkPreview: chunkText.slice(0, 80),
			error: error instanceof Error ? error.message : String(error),
		});
		return "";
	}
}

// enrichChunksWithContext prepends contextual summaries to each chunk's childText
// to improve retrieval accuracy. This replaces the old HyPE synthetic question approach.
// Modifies chunks in-place and returns the same array.
export async function enrichChunksWithContext(
	chunks: RagChunk[],
	pageContentByUrl: Map<string, { content: string; title: string }>,
): Promise<RagChunk[]> {
	if (chunks.length === 0) return chunks;

	const startedAt = Date.now();
	let enriched = 0;

	// Process in batches with concurrency
	for (let i = 0; i < chunks.length; i += CONTEXT_CONCURRENCY) {
		const batch = chunks.slice(i, i + CONTEXT_CONCURRENCY);
		const results = await Promise.allSettled(
			batch.map(async (chunk) => {
				const page = pageContentByUrl.get(chunk.url);
				if (!page || !page.content.trim()) return;

				const context = await generateChunkContext(
					chunk.childText,
					page.content,
					page.title || chunk.pageTitle,
				);

				if (context) {
					chunk.childText = `${context}\n\n${chunk.childText}`;
					enriched += 1;
				}
			}),
		);

		for (const result of results) {
			if (result.status === "rejected") {
				logger.warn("contextualRetrieval: batch item failed", {
					error: result.reason instanceof Error
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
