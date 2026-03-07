import pool from "../config/database";
import logger from "../utils/logger";

export interface ChatRating {
	id: string;
	user_id: string;
	session_id: string;
	widget_key_id: number | null;
	rating: "up" | "down";
	created_at: Date;
}

class ChatRatingService {
	/**
	 * Upsert a rating for a session.
	 * Visitors can change their rating — ON CONFLICT updates the rating.
	 */
	async upsertRating(
		userId: string,
		sessionId: string,
		widgetKeyId: number | null,
		rating: "up" | "down",
	): Promise<ChatRating> {
		try {
			const result = await pool.query(
				`INSERT INTO chat_ratings (user_id, session_id, widget_key_id, rating)
				 VALUES ($1, $2, $3, $4)
				 ON CONFLICT (user_id, session_id)
				 DO UPDATE SET rating = EXCLUDED.rating
				 RETURNING *`,
				[userId, sessionId, widgetKeyId, rating],
			);
			logger.info("Chat rating upserted", {
				userId,
				sessionId,
				rating,
			});
			return result.rows[0] as ChatRating;
		} catch (error) {
			const err = error as Error;
			logger.error("Error upserting chat rating", {
				userId,
				sessionId,
				error: err.message,
			});
			throw error;
		}
	}

	/**
	 * Get all ratings for a user (for dashboard display).
	 */
	async getRatingsForUser(
		userId: string,
		limit = 100,
	): Promise<ChatRating[]> {
		try {
			const result = await pool.query(
				`SELECT * FROM chat_ratings
				 WHERE user_id = $1
				 ORDER BY created_at DESC
				 LIMIT $2`,
				[userId, limit],
			);
			return result.rows as ChatRating[];
		} catch (error) {
			const err = error as Error;
			logger.error("Error fetching chat ratings", {
				userId,
				error: err.message,
			});
			throw error;
		}
	}
}

export const chatRatingService = new ChatRatingService();
