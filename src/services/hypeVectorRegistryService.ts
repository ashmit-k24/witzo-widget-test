import pool from "../config/database";
import logger from "../utils/logger";

export const hypeVectorRegistryService = {
	async saveVectorIds(
		userId: string,
		sourceUrl: string,
		vectorIds: string[],
	): Promise<void> {
		if (vectorIds.length === 0) return;
		try {
			await pool.query(
				`INSERT INTO hype_vector_registry (user_id, source_url, vector_ids, updated_at)
				 VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
				 ON CONFLICT (user_id, source_url)
				 DO UPDATE SET vector_ids = EXCLUDED.vector_ids,
				               updated_at = CURRENT_TIMESTAMP`,
				[userId, sourceUrl, vectorIds],
			);
		} catch (error) {
			logger.warn("hypeVectorRegistry: failed to save vector IDs", {
				userId,
				sourceUrl,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},

	async getVectorIds(
		userId: string,
		sourceUrl: string,
	): Promise<string[]> {
		try {
			const result = await pool.query<{ vector_ids: string[] }>(
				`SELECT vector_ids FROM hype_vector_registry
				 WHERE user_id = $1 AND source_url = $2`,
				[userId, sourceUrl],
			);
			return result.rows[0]?.vector_ids ?? [];
		} catch (error) {
			logger.warn("hypeVectorRegistry: failed to fetch vector IDs", {
				userId,
				sourceUrl,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	},

	async clearVectorIds(
		userId: string,
		sourceUrl: string,
	): Promise<void> {
		try {
			await pool.query(
				`DELETE FROM hype_vector_registry WHERE user_id = $1 AND source_url = $2`,
				[userId, sourceUrl],
			);
		} catch (error) {
			logger.warn("hypeVectorRegistry: failed to clear vector IDs", {
				userId,
				sourceUrl,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},

	async clearAllForUser(userId: string): Promise<void> {
		try {
			await pool.query(
				`DELETE FROM hype_vector_registry WHERE user_id = $1`,
				[userId],
			);
		} catch {
			// best-effort; main Pinecone deletion still runs
		}
	},
};
