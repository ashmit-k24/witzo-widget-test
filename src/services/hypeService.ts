import crypto from "crypto";
import OpenAI from "openai";
import { config } from "../config/env";
import { hypeQueue } from "../config/hypeQueue";
import { RagChunk } from "../types";
import logger from "../utils/logger";

export interface HypeJobPayload {
	userId: string;
	rawChunks: RagChunk[];
	websiteName?: string;
	repairLockKey?: string;
}

const openai = new OpenAI({
	apiKey: config.OPENAI_API_KEY,
});

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

// generateHypeQuestions generates N hypothetical questions that a chunk answers.
async function generateHypeQuestions(
	chunkText: string,
	n: number,
	websiteName?: string,
): Promise<string[]> {
	if (n <= 0) return [];
	const truncated = truncateAtSentence(
		chunkText,
		1200,
	);
	const companyNote = websiteName
		? `The content is from a company called "${websiteName}". Where relevant, include the company name in the question so it sounds specific.\n`
		: "";
	const prompt = `You are generating search questions for a website chatbot.\n${companyNote}Given the passage below, generate exactly ${n} distinct questions that a website visitor might type into a chat widget to get this information. Keep each question short, natural, and conversational — the way a real person would ask it.\nOutput ONLY the questions, one per line, no numbering, no extra text.\n\nPassage:\n${truncated}\n\nQuestions:`;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			15000,
		);
		try {
			const completion =
				await openai.chat.completions.create(
					{
						model: "gpt-4o-mini",
						messages: [
							{ role: "user", content: prompt },
						],
						temperature: 0.7,
						max_tokens: 200,
					},
					{ signal: controller.signal as any },
				);
			const lines = (
				completion.choices[0]?.message?.content ??
				""
			)
				.trim()
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
			const result = lines.slice(0, n);
			console.log("[HyPE] Generated questions:", {
				chunkPreview: truncated.slice(0, 120) + "...",
				questions: result,
			});
			return result;
		} finally {
			clearTimeout(timeout);
		}
	} catch {
		return [];
	}
}

export function stableVectorIdForChunk(
	chunk: RagChunk,
): string {
	const input = `${chunk.userId}|${chunk.sourceType}|${chunk.sourceKey}|${chunk.url}|${chunk.chunkIndex}`;
	return (
		"pc_" +
		crypto
			.createHash("sha256")
			.update(input)
			.digest("hex")
			.slice(0, 32)
	);
}

const HYPE_BATCH_CONCURRENCY = 15;

async function processInBatches<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	for (
		let i = 0;
		i < items.length;
		i += concurrency
	) {
		const batch = items.slice(i, i + concurrency);
		const batchResults = await Promise.all(
			batch.map(fn),
		);
		results.push(...batchResults);
	}
	return results;
}

// processHypeChunks generates HyPE question vectors and upserts them to Pinecone.
// Called by hypeWorker directly.
export async function processHypeChunks(
	userId: string,
	rawChunks: RagChunk[],
	upsertChunksFn: (
		userId: string,
		chunks: RagChunk[],
	) => Promise<void>,
	websiteName?: string,
): Promise<void> {
	const n = config.HYPE_QUESTIONS_PER_CHUNK ?? 0;
	if (n <= 0 || rawChunks.length === 0) return;

	const startedAt = Date.now();
	logger.info("hypeService: generation started", {
		userId,
		sourceChunks: rawChunks.length,
		questionsPerChunk: n,
		concurrency: HYPE_BATCH_CONCURRENCY,
	});

	const chunkResults = await processInBatches(
		rawChunks,
		HYPE_BATCH_CONCURRENCY,
		async (chunk) => {
			const parentId =
				stableVectorIdForChunk(chunk);
			const questions =
				await generateHypeQuestions(
					chunk.childText,
					n,
					websiteName,
				);
			logger.info(
				"[HyPE] Generated questions for chunk",
				{
					url: chunk.url,
					chunkIndex: chunk.chunkIndex,
					questions,
				},
			);
			return questions.map(
				(q, qi) =>
					({
						userId: chunk.userId,
						url: chunk.url,
						pageTitle: chunk.pageTitle,
						childText: q,
						parentText: chunk.parentText,
						chunkIndex:
							chunk.chunkIndex * 100 + qi + 1,
						sourceType: chunk.sourceType,
						sourceKey: chunk.sourceKey,
						isHype: true,
						hypeParent: parentId,
						pageType: chunk.pageType,
						clientName: chunk.clientName,
						industry: chunk.industry,
						services: chunk.services,
					}) as RagChunk,
			);
		},
	);

	const hypeChunks = chunkResults.flat();

	if (hypeChunks.length === 0) {
		logger.info(
			"hypeService: no HyPE questions generated",
			{
				userId,
				sourceChunks: rawChunks.length,
				durationMs: Date.now() - startedAt,
			},
		);
		return;
	}

	logger.info(
		"hypeService: upserting generated HyPE chunks",
		{
			userId,
			sourceChunks: rawChunks.length,
			hypeChunks: hypeChunks.length,
			durationMs: Date.now() - startedAt,
		},
	);
	await upsertChunksFn(userId, hypeChunks);
	logger.info(
		"hypeService: generation completed",
		{
			userId,
			sourceChunks: rawChunks.length,
			hypeChunks: hypeChunks.length,
			durationMs: Date.now() - startedAt,
		},
	);
}

// enqueueAsync pushes a HyPE generation job to the BullMQ queue so it
// survives server restarts and runs outside the scraping process.
export async function enqueueAsync(
	userId: string,
	rawChunks: RagChunk[],
	websiteName?: string,
): Promise<void> {
	const n = config.HYPE_QUESTIONS_PER_CHUNK ?? 0;
	if (n <= 0 || rawChunks.length === 0) return;

	const payload: HypeJobPayload = {
		userId,
		rawChunks,
		websiteName,
	};
	await hypeQueue.add("generate", payload, {
		jobId: `hype:${userId}:${Date.now()}`,
	});
	logger.info("hypeService: job enqueued", {
		userId,
		sourceChunks: rawChunks.length,
	});
}

export async function enqueueRepairAsync(
	userId: string,
	rawChunks: RagChunk[],
	websiteName?: string,
	repairLockKey?: string,
): Promise<void> {
	const n = config.HYPE_QUESTIONS_PER_CHUNK ?? 0;
	if (n <= 0 || rawChunks.length === 0) return;

	const sourceKey = rawChunks[0]?.sourceKey || "unknown";
	const payload: HypeJobPayload = {
		userId,
		rawChunks,
		websiteName,
		repairLockKey,
	};
	await hypeQueue.add("repair", payload, {
		jobId: `hype-repair:${userId}:${crypto.createHash("sha1").update(sourceKey).digest("hex").slice(0, 16)}`,
	});
	logger.info("hypeService: repair job enqueued", {
		userId,
		sourceKey,
		sourceChunks: rawChunks.length,
	});
}
