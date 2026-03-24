/**
 * Lightweight BM25-style sparse vector generator for Pinecone hybrid search.
 *
 * No corpus is needed: we use smoothed TF (k1 normalisation without IDF so
 * that the same token consistently maps to the same dimension in both upserts
 * and queries).  The vocabulary is implicit — each unique token string is
 * hashed to a stable 32-bit bucket inside a 2^20 (≈1M) dimension space,
 * giving a very low collision rate for typical website content.
 *
 * Pinecone sparse-dense hybrid requirements:
 *   - The index metric MUST be "dotproduct" (not cosine).  Our index already
 *     uses dotproduct, so no schema change is needed.
 *   - Upsert: include `sparseValues: { indices, values }` on every record.
 *   - Query: include `sparseVector: { indices, values }` on every query call.
 */

const VOCAB_SIZE = 1 << 20; // 2^20 = 1 048 576 dimensions
const BM25_K1 = 1.5; // term-frequency saturation factor

// Common English stopwords — kept minimal to avoid filtering useful terms.
const STOPWORDS = new Set([
	"a", "an", "the", "and", "or", "but", "in", "on", "at", "to",
	"for", "of", "with", "by", "from", "is", "are", "was", "were",
	"be", "been", "have", "has", "had", "do", "does", "did", "will",
	"would", "could", "should", "may", "might", "can", "shall",
	"it", "its", "this", "that", "these", "those", "we", "our",
	"you", "your", "they", "their", "he", "she", "his", "her",
	"i", "my", "me", "us", "not", "no", "so", "if", "as",
]);

/**
 * Fast, deterministic 32-bit hash (FNV-1a) — no external dependency.
 */
function fnv1a32(str: string): number {
	let hash = 2166136261; // FNV offset basis
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		// 32-bit multiply: use bitwise tricks to stay within int32
		hash = (Math.imul(hash, 16777619) >>> 0);
	}
	return hash;
}

/**
 * Map a token string to a stable dimension index in [0, VOCAB_SIZE).
 */
function tokenToDimension(token: string): number {
	return fnv1a32(token) % VOCAB_SIZE;
}

/**
 * Tokenize text into normalised, filtered terms.
 */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export type SparseVector = {
	indices: number[];
	values: number[];
};

/**
 * Build a BM25-style sparse vector from `text`.
 *
 * Formula (IDF-free, smoothed TF):
 *   score(t) = tf(t,d) * (k1 + 1) / (tf(t,d) + k1)
 *
 * This saturates rapidly (high-frequency terms get diminishing returns) while
 * still giving unique terms a meaningful boost.
 */
export function buildSparseVector(text: string): SparseVector {
	const tokens = tokenize(text);
	if (tokens.length === 0) {
		return { indices: [], values: [] };
	}

	// Count raw term frequencies
	const tf = new Map<string, number>();
	for (const token of tokens) {
		tf.set(token, (tf.get(token) ?? 0) + 1);
	}

	// Aggregate scores per dimension (handle hash collisions gracefully)
	const dimScores = new Map<number, number>();
	for (const [token, count] of tf) {
		const score = (count * (BM25_K1 + 1)) / (count + BM25_K1);
		const dim = tokenToDimension(token);
		dimScores.set(dim, (dimScores.get(dim) ?? 0) + score);
	}

	const indices: number[] = [];
	const values: number[] = [];
	for (const [dim, score] of dimScores) {
		indices.push(dim);
		values.push(score);
	}

	return { indices, values };
}
