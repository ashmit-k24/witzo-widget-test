import OpenAI from "openai";
import { config } from "../config/env";
import { RagChunk } from "../types";
import logger from "../utils/logger";
import { pineconeService } from "./pineconeService";

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

function parseQuestions(raw: string): string[] {
	return raw
		.split(/\r?\n/)
		.map((line) =>
			line
				.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "")
				.trim(),
		)
		.filter((line) => line.length >= 10)
		.slice(0, config.HYPE_QUESTIONS_PER_CHUNK);
}

async function generateQuestions(
	chunk: RagChunk,
): Promise<string[]> {
	const text = chunk.parentText.slice(0, 2200);
	const completion =
		await openai.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [
				{
					role: "system",
					content:
						"Generate likely user search questions answered by the provided website content. Return one question per line, no numbering required.",
				},
				{
					role: "user",
					content: `Title: ${chunk.pageTitle}\nURL: ${chunk.url}\n\nContent:\n${text}`,
				},
			],
			temperature: 0.2,
			max_tokens: 120,
		});
	return parseQuestions(
		completion.choices[0]?.message?.content ?? "",
	);
}

export async function upsertHypeAsync(
	userId: string,
	sourceUrl: string,
	chunks: RagChunk[],
): Promise<void> {
	if (!config.OPENAI_API_KEY?.trim() || chunks.length === 0) {
		return;
	}

	const sourceChunks = chunks
		.filter(
			(chunk) =>
				!chunk.isHype &&
				chunk.parentText.trim().split(/\s+/).length >= 25,
		)
		.slice(0, config.HYPE_SOURCE_LIMIT);
	if (sourceChunks.length === 0) {
		return;
	}

	const startedAt = Date.now();
	const hypeChunks: RagChunk[] = [];
	const hypeSourceKey = `${sourceUrl}#hype`;
	logger.info("hypeService: background generation started", {
		userId,
		sourceUrl,
		sourceChunks: sourceChunks.length,
	});

	for (let index = 0; index < sourceChunks.length; index += 1) {
		const chunk = sourceChunks[index];
		try {
			const questions = await generateQuestions(chunk);
			for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
				hypeChunks.push({
					...chunk,
					childText: questions[questionIndex],
					parentText: chunk.parentText,
					chunkIndex:
						1_000_000 +
						index * config.HYPE_QUESTIONS_PER_CHUNK +
						questionIndex,
					sourceKey: hypeSourceKey,
					isHype: true,
					hypeParent: chunk.parentText,
					vectorId: undefined,
				});
			}
		} catch (error) {
			logger.warn("hypeService: question generation failed", {
				userId,
				sourceUrl,
				url: chunk.url,
				error:
					error instanceof Error
						? error.message
						: String(error),
			});
		}
	}

	if (hypeChunks.length === 0) {
		logger.info("hypeService: no HyPE questions generated", {
			userId,
			sourceUrl,
		});
		return;
	}

	await pineconeService.deleteHypeVectorsForSource(
		userId,
		hypeSourceKey,
	);
	await pineconeService.upsertChunks(
		userId,
		hypeChunks,
		{
			sourceRoot: sourceUrl,
			sourceRootTitle: sourceChunks[0]?.pageTitle || sourceUrl,
			scrapedAt: new Date().toISOString(),
			skipStaleCleanup: true,
			skipSourcePageSync: true,
		},
	);
	logger.info("hypeService: background generation completed", {
		userId,
		sourceUrl,
		hypeChunks: hypeChunks.length,
		durationMs: Date.now() - startedAt,
	});
}
