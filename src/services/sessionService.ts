import pool from "../config/database";
import { Session } from "../types";
import logger from "../utils/logger";

export interface SessionInfo {
	id: number;
	ipAddress: string | null;
	userAgent: string | null;
	createdAt: Date;
	lastActivity: Date;
	isCurrent: boolean;
}

export interface SessionListResponse {
	success: boolean;
	sessions: SessionInfo[];
	totalSessions: number;
}

export interface RevokeSessionResponse {
	success: boolean;
	message: string;
}

class SessionService {
	/**
	 * Get all active sessions for a user
	 */
	async getUserSessions(
		userId: string,
		currentSessionId?: number,
	): Promise<SessionListResponse> {
		try {
			const result = await pool.query<Session>(
				`SELECT id, ip_address, user_agent, created_at, updated_at
				 FROM sessions
				 WHERE user_id = $1 AND is_revoked = FALSE
				 ORDER BY updated_at DESC`,
				[userId],
			);

			const sessions: SessionInfo[] =
				result.rows.map((session) => ({
					id: session.id,
					ipAddress: session.ip_address,
					userAgent: session.user_agent,
					createdAt: session.created_at,
					lastActivity: session.updated_at,
					isCurrent:
						session.id === currentSessionId,
				}));

			return {
				success: true,
				sessions,
				totalSessions: sessions.length,
			};
		} catch (error) {
			const err = error as Error;
			logger.error(
				"Error getting user sessions",
				{
					userId,
					error: err.message,
					stack: err.stack,
				},
			);
			throw new Error(
				"Failed to get user sessions",
			);
		}
	}

	/**
	 * Revoke a specific session
	 */
	async revokeSession(
		userId: string,
		sessionId: number,
		currentSessionId?: number,
	): Promise<RevokeSessionResponse> {
		try {
			// Prevent revoking current session through this method
			if (sessionId === currentSessionId) {
				return {
					success: false,
					message:
						"Cannot revoke current session. Use logout instead.",
				};
			}

			const result = await pool.query(
				`UPDATE sessions
				 SET is_revoked = TRUE, updated_at = CURRENT_TIMESTAMP
				 WHERE id = $1 AND user_id = $2 AND is_revoked = FALSE`,
				[sessionId, userId],
			);

			if (
				result.rowCount === null ||
				result.rowCount === 0
			) {
				return {
					success: false,
					message:
						"Session not found or already revoked",
				};
			}

			logger.info("Session revoked", {
				userId,
				sessionId,
			});

			return {
				success: true,
				message: "Session revoked successfully",
			};
		} catch (error) {
			const err = error as Error;
			logger.error("Error revoking session", {
				userId,
				sessionId,
				error: err.message,
				stack: err.stack,
			});
			throw new Error("Failed to revoke session");
		}
	}

	/**
	 * Revoke all sessions except the current one
	 */
	async revokeAllOtherSessions(
		userId: string,
		currentSessionId: number,
	): Promise<RevokeSessionResponse> {
		try {
			const result = await pool.query(
				`UPDATE sessions
				 SET is_revoked = TRUE, updated_at = CURRENT_TIMESTAMP
				 WHERE user_id = $1 AND id != $2 AND is_revoked = FALSE`,
				[userId, currentSessionId],
			);

			const revokedCount = result.rowCount || 0;

			logger.info(
				"All other sessions revoked",
				{
					userId,
					currentSessionId,
					revokedCount,
				},
			);

			return {
				success: true,
				message: `${revokedCount} session${revokedCount !== 1 ? "s" : ""} revoked successfully`,
			};
		} catch (error) {
			const err = error as Error;
			logger.error(
				"Error revoking all sessions",
				{
					userId,
					error: err.message,
					stack: err.stack,
				},
			);
			throw new Error(
				"Failed to revoke all sessions",
			);
		}
	}

	/**
	 * Revoke all sessions for a user (for logout everywhere)
	 */
	async revokeAllSessions(
		userId: string,
	): Promise<RevokeSessionResponse> {
		try {
			const result = await pool.query(
				`UPDATE sessions
				 SET is_revoked = TRUE, updated_at = CURRENT_TIMESTAMP
				 WHERE user_id = $1 AND is_revoked = FALSE`,
				[userId],
			);

			const revokedCount = result.rowCount || 0;

			logger.info("All sessions revoked", {
				userId,
				revokedCount,
			});

			return {
				success: true,
				message: `Logged out from all ${revokedCount} device${revokedCount !== 1 ? "s" : ""}`,
			};
		} catch (error) {
			const err = error as Error;
			logger.error(
				"Error revoking all sessions",
				{
					userId,
					error: err.message,
					stack: err.stack,
				},
			);
			throw new Error(
				"Failed to revoke all sessions",
			);
		}
	}
}

export default new SessionService();
