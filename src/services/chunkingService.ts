import {
	RecursiveCharacterTextSplitter,
	MarkdownTextSplitter,
} from "@langchain/textsplitters";

export interface ChunkResult {
	childText: string; // small chunk (~200 words) → used for embedding
	parentText: string; // larger context (~600 words) → sent to LLM for answer
}

export interface SparseVector {
	indices: number[];
	values: number[];
}

// ── LangChain splitter instances (created once, reused) ────────────

// Markdown-aware parent splitter: large chunks for LLM context (~600 words ≈ ~3000 chars)
// Uses markdown separators: splits at headings, code blocks, paragraphs first
const parentSplitter = new MarkdownTextSplitter({
	chunkSize: 3000,
	chunkOverlap: 200,
});

// Child splitter: small chunks for embedding (~200 words ≈ ~1000 chars)
const childSplitter = new RecursiveCharacterTextSplitter({
	chunkSize: 1000,
	chunkOverlap: 200,
});

// Plain text fallback splitter (~800 words ≈ ~4000 chars, overlap ~120 words ≈ ~600 chars)
const plainTextSplitter = new RecursiveCharacterTextSplitter({
	chunkSize: 4000,
	chunkOverlap: 600,
});

// ── Helpers ────────────────────────────────────────────────────────

function extractHeading(text: string): string {
	const match = text.match(/^#{1,3}\s+(.+)/m);
	return match ? match[1].trim() : "";
}

// ── Main entry point ───────────────────────────────────────────────

export async function chunkMarkdown(
	text: string,
	pageTitle: string,
): Promise<ChunkResult[]> {
	if (!text || !text.trim()) return [];

	const isMarkdown =
		text.includes("\n## ") ||
		text.startsWith("## ") ||
		text.includes("\n### ") ||
		text.startsWith("### ");

	if (!isMarkdown) {
		return chunkPlainText(text);
	}

	return chunkMarkdownContent(text, pageTitle);
}

// ── Markdown chunking (parent/child via LangChain) ────────────────

async function chunkMarkdownContent(
	text: string,
	pageTitle: string,
): Promise<ChunkResult[]> {
	// Step 1: split into parent chunks (markdown-aware, respects headings)
	const parentChunks = await parentSplitter.splitText(text);

	if (parentChunks.length === 0) {
		return chunkPlainText(text);
	}

	const results: ChunkResult[] = [];

	for (const parentText of parentChunks) {
		// Extract heading from this parent chunk for embedding prefix
		const heading = extractHeading(parentText) || pageTitle || "";
		const headingPrefix = heading ? `${heading}: ` : "";

		// Step 2: split parent into smaller child chunks for embedding
		const childChunks = await childSplitter.splitText(parentText);

		for (const childText of childChunks) {
			results.push({
				childText: headingPrefix + childText,
				parentText,
			});
		}
	}

	if (results.length === 0) {
		return chunkPlainText(text);
	}

	return results;
}

// ── Plain-text fallback ───────────────────────────────────────────

async function chunkPlainText(text: string): Promise<ChunkResult[]> {
	const chunks = await plainTextSplitter.splitText(text);
	return chunks.map((c) => ({ childText: c, parentText: c }));
}

// ── BM25 sparse vector (kept as-is — no LangChain equivalent) ────

function fnv32a(s: string): number {
	const offset32 = 0x811c9dc5;
	const prime32 = 0x01000193;
	let h = offset32 >>> 0;
	for (let i = 0; i < s.length; i++) {
		h = (h ^ s.charCodeAt(i)) >>> 0;
		h = Math.imul(h, prime32) >>> 0;
	}
	return h;
}

export function bm25SparseVector(text: string): SparseVector {
	const words = text.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return { indices: [], values: [] };

	const tf = new Map<number, number>();
	for (const w of words) {
		const idx = fnv32a(w);
		tf.set(idx, (tf.get(idx) ?? 0) + 1);
	}

	const indices: number[] = [];
	const values: number[] = [];
	const docLen = words.length;

	for (const [idx, count] of tf.entries()) {
		const score = (1.0 + Math.log(count)) / (1.0 + Math.log(docLen));
		indices.push(idx);
		values.push(score);
	}

	return { indices, values };
}
