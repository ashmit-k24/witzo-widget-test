// hypeService.ts
// HyPE (Hypothetical Question Embeddings) - async background question generation.
// Ported from konvoqai-backend Go: controller/integrations.go generateHypeQuestions(), upsertHypeAsync()

import OpenAI from "openai";
import { config } from "../config/env";
import logger from "../utils/logger";
import { RagChunk } from "../types";

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

function truncateAtSentence(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncated = text.slice(0, maxChars);
	const lastPeriod = Math.max(
		truncated.lastIndexOf(". "),
		truncated.lastIndexOf("! "),
		truncated.lastIndexOf("? "),
	);
	return lastPeriod > maxChars / 2 ? truncated.slice(0, lastPeriod + 1) : truncated;
}

// generateHypeQuestions generates N hypothetical questions that a chunk answers.
async function generateHypeQuestions(chunkText: string, n: number): Promise<string[]> {
	if (n <= 0) return [];
	const truncated = truncateAtSentence(chunkText, 1200);
	const prompt = `Given the following text passage, generate exactly ${n} distinct questions that this passage directly answers. Output ONLY the questions, one per line, no numbering, no extra text.\n\nPassage:\n${truncated}\n\nQuestions:`;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15000);
		try {
			const completion = await openai.chat.completions.create(
				{
					model: "gpt-4o-mini",
					messages: [{ role: "user", content: prompt }],
					temperature: 0.7,
					max_tokens: 200,
				},
				{ signal: controller.signal as any },
			);
			const lines = (completion.choices[0]?.message?.content ?? "")
				.trim()
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
			return lines.slice(0, n);
		} finally {
			clearTimeout(timeout);
		}
	} catch {
		return [];
	}
}

// stableVectorIdForChunk is a simplified ID builder for HyPE parent references
function stableVectorIdForChunk(chunk: RagChunk): string {
	const { createHash } = require("crypto");
	const input = `${chunk.userId}|${chunk.sourceType}|${chunk.sourceKey}|${chunk.url}|${chunk.chunkIndex}`;
	return "pc_" + createHash("sha256").update(input).digest("hex").slice(0, 32);
}

// upsertAsync generates HyPE question vectors for rawChunks in the background and upserts to Pinecone.
// Fire-and-forget — never throws.
export function upsertAsync(
	userId: string,
	rawChunks: RagChunk[],
	upsertChunksFn: (userId: string, chunks: RagChunk[]) => Promise<void>,
): void {
	const n = config.HYPE_QUESTIONS_PER_CHUNK ?? 0;
	if (n <= 0 || rawChunks.length === 0) return;

	(async () => {
		const startedAt = Date.now();
		logger.info("hypeService: background generation started", {
			userId,
			sourceChunks: rawChunks.length,
			questionsPerChunk: n,
		});
		const hypeChunks: RagChunk[] = [];
		for (const chunk of rawChunks) {
			const parentId = stableVectorIdForChunk(chunk);
			const questions = await generateHypeQuestions(chunk.childText, n);
			for (let qi = 0; qi < questions.length; qi++) {
				hypeChunks.push({
					userId: chunk.userId,
					url: chunk.url,
					pageTitle: chunk.pageTitle,
					childText: questions[qi],
					parentText: chunk.parentText,
					chunkIndex: chunk.chunkIndex * 100 + qi + 1,
					sourceType: chunk.sourceType,
					sourceKey: chunk.sourceKey,
					isHype: true,
					hypeParent: parentId,
					pageType: chunk.pageType,
					clientName: chunk.clientName,
					industry: chunk.industry,
					services: chunk.services,
				});
			}
		}
		if (hypeChunks.length === 0) {
			logger.info("hypeService: no HyPE questions generated", {
				userId,
				sourceChunks: rawChunks.length,
				durationMs: Date.now() - startedAt,
			});
			return;
		}
		logger.info("hypeService: upserting generated HyPE chunks", {
			userId,
			sourceChunks: rawChunks.length,
			hypeChunks: hypeChunks.length,
			durationMs: Date.now() - startedAt,
		});
		await upsertChunksFn(userId, hypeChunks);
		logger.info("hypeService: background generation completed", {
			userId,
			sourceChunks: rawChunks.length,
			hypeChunks: hypeChunks.length,
			durationMs: Date.now() - startedAt,
		});
	})().catch((err) => {
		logger.warn("hypeService: async HyPE upsert failed", { userId, err });
	});
}
