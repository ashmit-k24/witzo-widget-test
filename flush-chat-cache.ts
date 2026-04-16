import { redisCache } from "./src/config/redis";
import logger from "./src/utils/logger";

/**
 * Flush the chat answer / retrieval caches so the next request hits the
 * LLM fresh with the latest system prompt.
 *
 * Usage:
 *   pnpm tsx flush-chat-cache.ts                # flush for ALL users
 *   pnpm tsx flush-chat-cache.ts <userId>       # flush for one user only
 *
 * Clears:
 *   - chat:semantic-answer:*     (12h cached LLM answers, keyed by userId)
 *   - chat:retrieval:*           (per-session Pinecone retrieval results)
 */

async function scanAndDelete(pattern: string): Promise<number> {
	let cursor = "0";
	let totalDeleted = 0;

	do {
		const [nextCursor, keys] = await redisCache.scan(
			cursor,
			"MATCH",
			pattern,
			"COUNT",
			500,
		);
		cursor = nextCursor;

		if (keys.length > 0) {
			await redisCache.del(...keys);
			totalDeleted += keys.length;
			logger.info(
				`flush-chat-cache: deleted ${keys.length} keys (pattern=${pattern})`,
			);
		}
	} while (cursor !== "0");

	return totalDeleted;
}

async function main(): Promise<void> {
	const userId = process.argv[2]?.trim();

	const patterns = userId
		? [
				`chat:semantic-answer:${userId}`,
				`chat:retrieval:${userId}:*`,
			]
		: [
				"chat:semantic-answer:*",
				"chat:retrieval:*",
			];

	logger.info("flush-chat-cache: starting", {
		scope: userId ? `user ${userId}` : "ALL users",
		patterns,
	});

	let total = 0;
	for (const pattern of patterns) {
		total += await scanAndDelete(pattern);
	}

	if (total === 0) {
		logger.info(
			"flush-chat-cache: chat cache was already empty — nothing deleted",
		);
	} else {
		logger.info(
			`flush-chat-cache: chat cache cleared — ${total} key(s) deleted`,
			{ totalKeysDeleted: total },
		);
	}
	process.exit(0);
}

main().catch((err) => {
	logger.error("flush-chat-cache: failed", { error: err });
	process.exit(1);
});
