import pool from "../config/database";

export type FeedbackType = "feedback" | "suggestion";

export interface FeedbackSuggestion {
	id: string;
	user_id: string;
	type: FeedbackType;
	title: string | null;
	message: string;
	page_path: string | null;
	user_agent: string | null;
	created_at: Date;
}

export interface CreateFeedbackInput {
	userId: string;
	type: FeedbackType;
	title?: string;
	message: string;
	pagePath?: string;
	userAgent?: string;
}

class FeedbackService {
	async createFeedback(
		input: CreateFeedbackInput,
	): Promise<FeedbackSuggestion> {
		const result = await pool.query<FeedbackSuggestion>(
			`INSERT INTO feedback_suggestions
       (user_id, type, title, message, page_path, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
			[
				input.userId,
				input.type,
				input.title?.trim() || null,
				input.message.trim(),
				input.pagePath?.trim() || null,
				input.userAgent || null,
			],
		);

		return result.rows[0];
	}

	async listFeedbackByUser(
		userId: string,
		limit = 50,
	): Promise<FeedbackSuggestion[]> {
		const safeLimit = Math.max(1, Math.min(100, limit));
		const result = await pool.query<FeedbackSuggestion>(
			`SELECT *
       FROM feedback_suggestions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
			[userId, safeLimit],
		);

		return result.rows;
	}
}

export const feedbackService = new FeedbackService();
