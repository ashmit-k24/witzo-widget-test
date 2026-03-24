import OpenAI from "openai";
import { config } from "../config/env";
import { ScrapedPage, RagChunk } from "../types";
import logger from "../utils/logger";

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

interface PageMetadata {
	pageType: string;
	clientName: string;
	industry: string;
	services: string;
}

async function extractPageMetadata(page: ScrapedPage): Promise<PageMetadata> {
	const content = page.content.slice(0, 1500);
	const prompt = `Classify this web page based on its title and content snippet.

Page title: ${page.title}
URL: ${page.url}
Content snippet: ${content}

Return JSON with these fields (use empty string if not applicable):
{
  "pageType": one of ["case_study","service","contact","about","blog","pricing","portfolio","home","other"],
  "clientName": "client or company name if this is a case study/portfolio page, else empty",
  "industry": "industry keyword if detectable (e.g. healthcare, retail, fintech), else empty",
  "services": "comma-separated list of services mentioned on this page, else empty"
}

Return ONLY the JSON object, no markdown, no explanation.`;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const completion = await openai.chat.completions.create(
				{
					model: "gpt-4o-mini",
					messages: [{ role: "user", content: prompt }],
					temperature: 0.0,
					max_tokens: 120,
				},
				{ signal: controller.signal as any },
			);
			let raw = (completion.choices[0]?.message?.content ?? "").trim();
			// Strip markdown code fences if present
			raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
			const parsed = JSON.parse(raw) as PageMetadata;
			return {
				pageType: String(parsed.pageType || "other"),
				clientName: String(parsed.clientName || ""),
				industry: String(parsed.industry || ""),
				services: String(parsed.services || ""),
			};
		} finally {
			clearTimeout(timeout);
		}
	} catch {
		return { pageType: "other", clientName: "", industry: "", services: "" };
	}
}

// extractAsync classifies pages and updates Pinecone vector metadata.
export async function extractAsync(
	pages: ScrapedPage[],
	chunks: RagChunk[],
	updateVectorMetadataFn: (userId: string, vectorId: string, metadata: Record<string, unknown>) => Promise<void>,
): Promise<void> {
	if (pages.length === 0 || chunks.length === 0) return;

	const startedAt = Date.now();
	let classifiedPages = 0;
	let updatedVectors = 0;
	logger.info("pageMetadataService: background extraction started", {
		pages: pages.length,
		chunks: chunks.length,
	});

	// Build map: pageUrl -> chunks[]
	const pageChunks = new Map<string, RagChunk[]>();
	for (const chunk of chunks) {
		if (chunk.isHype) continue;
		const list = pageChunks.get(chunk.url) ?? [];
		list.push(chunk);
		pageChunks.set(chunk.url, list);
	}

	for (const page of pages) {
		const pageUrl = page.url;
		const associated = pageChunks.get(pageUrl);
		if (!associated || associated.length === 0) continue;

		let metadata: PageMetadata;
		try {
			metadata = await extractPageMetadata(page);
		} catch {
			continue;
		}

		if (!metadata.pageType || metadata.pageType === "other") continue;
		classifiedPages += 1;

		for (const chunk of associated) {
			try {
				await updateVectorMetadataFn(chunk.userId, chunk.vectorId ?? "", {
					pageType: metadata.pageType,
					clientName: metadata.clientName,
					industry: metadata.industry,
					services: metadata.services,
				});
				updatedVectors += 1;
			} catch (err) {
				logger.warn("pageMetadataService: failed to update vector metadata", {
					url: pageUrl,
					err,
				});
			}
		}

		await new Promise((r) => setTimeout(r, 80));
	}

	logger.info("pageMetadataService: background extraction completed", {
		pages: pages.length,
		classifiedPages,
		updatedVectors,
		durationMs: Date.now() - startedAt,
	});
}
