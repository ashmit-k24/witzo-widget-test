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

// Markdown-aware parent splitter: large chunks for LLM context (~1200 words ≈ ~6000 chars)
// Uses markdown separators: splits at headings, code blocks, paragraphs first.
// Bumped from 3000 -> 6000 so a single chunk can cover a full section of a
// page (e.g., a pricing table + its surrounding copy) instead of carving the
// section into narrow slices that lose cross-reference context.
const parentSplitter = new MarkdownTextSplitter({
	chunkSize: 6000,
	chunkOverlap: 400,
});

// Child splitter: small chunks for embedding (~300 words ≈ ~1500 chars).
// Bumped from 1000 -> 1500 for richer embedding input without blowing past
// the 4000-char metadata text cap even after contextual enrichment.
const childSplitter = new RecursiveCharacterTextSplitter({
	chunkSize: 1500,
	chunkOverlap: 250,
});

// Plain text fallback splitter (~1000 words ≈ ~5000 chars, overlap ~150 words ≈ ~750 chars)
const plainTextSplitter = new RecursiveCharacterTextSplitter({
	chunkSize: 5000,
	chunkOverlap: 750,
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

	// Detect any level of ATX heading (# through ######). The previous
	// detection only recognised `## ` / `### `, so pages with only an H1
	// (or H4+) fell through to the plain-text splitter and lost their
	// heading-aware structure.
	const hasAtxHeading = /(^|\n)#{1,6}\s+\S/.test(text);
	// Also treat common markdown structural markers as "markdown enough"
	// to use the markdown splitter (lists, fenced code, horizontal rules,
	// blockquotes, tables).
	const hasMarkdownStructure =
		hasAtxHeading ||
		/\n\s*[-*+]\s+\S/.test(text) ||
		/\n\s*\d+\.\s+\S/.test(text) ||
		/\n```/.test(text) ||
		/\n\s*>\s+\S/.test(text) ||
		/\n\s*\|.+\|/.test(text) ||
		/\n\s*(?:---|\*\*\*|___)\s*\n/.test(text);

	if (!hasMarkdownStructure) {
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
