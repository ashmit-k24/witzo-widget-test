import OpenAI from "openai";
import { config } from "../config/env";
import { RagChunk } from "../types";
import logger from "../utils/logger";
import { hypeVectorRegistryService } from "./hypeVectorRegistryService";
import { pineconeService } from "./pineconeService";
import { scraperSourceService } from "./scraperSourceService";
import websiteBrandingService from "./websiteBrandingService";

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
	companyName?: string,
): Promise<string[]> {
	const text = chunk.parentText.slice(0, 2200);
	const companyContext = companyName
		? ` about ${companyName}`
		: "";
	const completion = await openai.chat.completions.create({
		model: "gpt-4o-mini",
		messages: [
			{
				role: "system",
				content: `Generate likely user search questions${companyContext} answered by the provided website content. Include the company name "${companyName || "the company"}" in each question where natural (e.g. "Who is the CEO of ${companyName || "the company"}?"). Return one question per line, no numbering required.`,
			},
			{
				role: "user",
				content: `Title: ${chunk.pageTitle}\nURL: ${chunk.url}\n\nContent:\n${text}`,
			},
		],
		temperature: 0.2,
		max_tokens: 180,
	});
	return parseQuestions(
		completion.choices[0]?.message?.content ?? "",
	);
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await fn(items[index], index);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, worker),
	);
	return results;
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
	const hypeSourceKey = `${sourceUrl}#hype`;

	// Resolve company name once for the whole batch
	let companyName: string | undefined;
	try {
		const resolved = await websiteBrandingService.resolveUserWebsiteName(userId);
		if (resolved) companyName = resolved;
	} catch {
		// Non-fatal — proceed without company name
	}

	logger.info("hypeService: background generation started", {
		userId,
		sourceUrl,
		sourceChunks: sourceChunks.length,
		concurrency: config.HYPE_BATCH_CONCURRENCY,
		companyName,
	});

	// Parallel batch generation with configurable concurrency
	const questionResults = await mapWithConcurrency(
		sourceChunks,
		config.HYPE_BATCH_CONCURRENCY,
		async (chunk) => {
			try {
				return await generateQuestions(chunk, companyName);
			} catch (error) {
				logger.warn("hypeService: question generation failed", {
					userId,
					sourceUrl,
					url: chunk.url,
					error: error instanceof Error ? error.message : String(error),
				});
				return [] as string[];
			}
		},
	);

	const hypeChunks: RagChunk[] = [];
	for (let index = 0; index < sourceChunks.length; index++) {
		const chunk = sourceChunks[index];
		const questions = questionResults[index];
		for (let qi = 0; qi < questions.length; qi++) {
			hypeChunks.push({
				...chunk,
				childText: questions[qi],
				parentText: chunk.parentText,
				chunkIndex:
					1_000_000 +
					index * config.HYPE_QUESTIONS_PER_CHUNK +
					qi,
				sourceKey: hypeSourceKey,
				isHype: true,
				hypeParent: chunk.parentText,
				vectorId: undefined,
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

	// Guard: source may have been deleted while HyPE was generating
	const stillExists = await scraperSourceService.sourceExists(userId, sourceUrl);
	if (!stillExists) {
		logger.info(
			"hypeService: source deleted during generation, skipping upsert",
			{ userId, sourceUrl, hypeChunks: hypeChunks.length },
		);
		return;
	}

	await pineconeService.deleteHypeVectorsForSource(userId, hypeSourceKey);
	await pineconeService.upsertChunks(userId, hypeChunks, {
		sourceRoot: sourceUrl,
		sourceRootTitle: sourceChunks[0]?.pageTitle || sourceUrl,
		scrapedAt: new Date().toISOString(),
		skipStaleCleanup: true,
		skipSourcePageSync: true,
	});

	// Save vector IDs to registry so next run can delete by ID without namespace scan
	const generatedIds = hypeChunks
		.map((c) => c.vectorId)
		.filter((id): id is string => Boolean(id));
	await hypeVectorRegistryService.saveVectorIds(userId, sourceUrl, generatedIds);

	logger.info("hypeService: background generation completed", {
		userId,
		sourceUrl,
		hypeChunks: hypeChunks.length,
		durationMs: Date.now() - startedAt,
	});
}
