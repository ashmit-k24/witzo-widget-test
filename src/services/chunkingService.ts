export interface ChunkResult {
	childText: string;  // ~200 words, heading-prefixed → used for embedding
	parentText: string; // up to 600 words → sent to LLM for answer
}

export interface SparseVector {
	indices: number[];
	values: number[];
}

interface MarkdownSection {
	heading: string;
	body: string;
}

function isMarkdown(text: string): boolean {
	return (
		text.includes("\n## ") ||
		text.startsWith("## ") ||
		text.includes("\n### ") ||
		text.startsWith("### ")
	);
}

function splitMarkdownSections(text: string): MarkdownSection[] {
	const lines = text.split("\n");
	const sections: MarkdownSection[] = [];
	let currentHeading = "";
	let currentBodyLines: string[] = [];

	function flush() {
		const body = currentBodyLines.join("\n").trim();
		if (body) {
			sections.push({ heading: currentHeading, body });
		}
		currentBodyLines = [];
	}

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("### ")) {
			flush();
			currentHeading = trimmed.slice(4).trim();
		} else if (trimmed.startsWith("## ")) {
			flush();
			currentHeading = trimmed.slice(3).trim();
		} else {
			currentBodyLines.push(line);
		}
	}
	flush();

	return sections;
}

function mergeTinySections(sections: MarkdownSection[], minWords = 50): MarkdownSection[] {
	if (sections.length === 0) return [];
	const merged: MarkdownSection[] = [sections[0]];

	for (let i = 1; i < sections.length; i++) {
		const curr = sections[i];
		const last = merged[merged.length - 1];
		const currWordCount = curr.body.split(/\s+/).filter(Boolean).length;
		const lastWordCount = last.body.split(/\s+/).filter(Boolean).length;

		if (currWordCount < minWords || lastWordCount < minWords) {
			if (curr.heading) {
				last.body = last.body + "\n\n" + curr.heading + ":\n" + curr.body;
			} else {
				last.body = last.body + "\n\n" + curr.body;
			}
		} else {
			merged.push(curr);
		}
	}
	return merged;
}

// chunkPlainText splits plain text into word-count chunks with overlap.
// chunkSize=800 words, overlap=120 words
function chunkPlainText(raw: string, chunkSize = 800, overlap = 120): string[] {
	const words = raw.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	if (chunkSize <= 0) chunkSize = 500;
	if (overlap < 0 || overlap >= chunkSize) overlap = 75;

	const step = chunkSize - overlap;
	const out: string[] = [];

	for (let start = 0; start < words.length; start += step) {
		const end = Math.min(start + chunkSize, words.length);
		out.push(words.slice(start, end).join(" "));
		if (end === words.length) break;
	}
	return out;
}

// chunkMarkdown is the main entry point.
// Returns ChunkResult[] with small childText (for embedding) and larger parentText (for LLM).
export function chunkMarkdown(text: string, pageTitle: string): ChunkResult[] {
	if (!isMarkdown(text)) {
		const plain = chunkPlainText(text, 800, 120);
		return plain.map((c) => ({ childText: c, parentText: c }));
	}

	let sections = splitMarkdownSections(text);
	sections = mergeTinySections(sections, 50);

	const results: ChunkResult[] = [];

	for (const sec of sections) {
		const bodyWords = sec.body.split(/\s+/).filter(Boolean);
		if (bodyWords.length === 0) continue;

		const headingPrefix = sec.heading
			? sec.heading + ": "
			: pageTitle
				? pageTitle + ": "
				: "";

		// Parent text: full section up to 600 words (for LLM)
		const parentWords = bodyWords.slice(0, 600);
		const parentText = parentWords.join(" ");

		if (bodyWords.length <= 200) {
			// Small section → single chunk
			const childText = headingPrefix + bodyWords.join(" ");
			results.push({ childText, parentText });
		} else {
			// Large section → sub-split into 200-word child chunks, all sharing same parent
			const childSize = 200;
			const childOverlap = 40;
			const step = childSize - childOverlap;

			for (let start = 0; start < bodyWords.length; start += step) {
				const end = Math.min(start + childSize, bodyWords.length);
				const childText = headingPrefix + bodyWords.slice(start, end).join(" ");
				results.push({ childText, parentText });
				if (end === bodyWords.length) break;
			}
		}
	}

	if (results.length === 0) {
		// Fallback if parsing produced nothing
		const plain = chunkPlainText(text, 800, 120);
		return plain.map((c) => ({ childText: c, parentText: c }));
	}

	return results;
}

// fnv32a computes FNV-32a hash of a string. Stable across runs.
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

// bm25SparseVector builds a BM25-inspired sparse vector from text.
// Uses TF with log-normalization. Token indices are stable FNV-32a hashes.
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
