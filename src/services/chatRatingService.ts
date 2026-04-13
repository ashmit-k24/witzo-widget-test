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

export interface ChatMessageFeedback {
	id: string;
	user_id: string;
	session_id: string;
	widget_key_id: number | null;
	message_id: string;
	feedback_type: "up" | "down";
	feedback_reason: string | null;
	created_at: Date;
	updated_at: Date;
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

	async upsertMessageFeedback(
		userId: string,
		sessionId: string,
		messageId: number,
		widgetKeyId: number | null,
		feedbackType: "up" | "down",
		feedbackReason?: string | null,
	): Promise<ChatMessageFeedback> {
		try {
			const result = await pool.query(
				`INSERT INTO chat_message_feedback (
					user_id,
					session_id,
					widget_key_id,
					message_id,
					feedback_type,
					feedback_reason
				)
				VALUES ($1, $2, $3, $4, $5, $6)
				ON CONFLICT (user_id, session_id, message_id)
				DO UPDATE SET
					widget_key_id = EXCLUDED.widget_key_id,
					feedback_type = EXCLUDED.feedback_type,
					feedback_reason = EXCLUDED.feedback_reason,
					updated_at = CURRENT_TIMESTAMP
				RETURNING *`,
				[
					userId,
					sessionId,
					widgetKeyId,
					messageId,
					feedbackType,
					feedbackReason ?? null,
				],
			);
			logger.info("Chat message feedback upserted", {
				userId,
				sessionId,
				messageId,
				feedbackType,
			});
			return result.rows[0] as ChatMessageFeedback;
		} catch (error) {
			const err = error as Error;
			logger.error("Error upserting chat message feedback", {
				userId,
				sessionId,
				messageId,
				error: err.message,
			});
			throw error;
		}
	}
}

export const chatRatingService = new ChatRatingService();
