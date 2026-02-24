import crypto from "crypto";
import { Request, Response } from "express";
import pool from "../config/database";
import { coercePlanType } from "../config/planConfig";
import { config } from "../config/env";
import logger from "../utils/logger";
import { createAdminToken } from "../utils/adminToken";

type NullableNumber = number | null;

const safeEqual = (
	a: string,
	b: string,
): boolean => {
	const aBuffer = Buffer.from(a);
	const bBuffer = Buffer.from(b);
	if (aBuffer.length !== bBuffer.length) {
		return false;
	}
	return crypto.timingSafeEqual(aBuffer, bBuffer);
};

const parseLimit = (
	value: unknown,
	fallback: number,
	max: number,
): number => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.max(1, Math.min(max, Math.floor(parsed)));
};

export const adminLogin = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const email =
			typeof req.body?.email === "string"
				? req.body.email.trim().toLowerCase()
				: "";
		const password =
			typeof req.body?.password === "string"
				? req.body.password
				: "";

		if (!email || !password) {
			res.status(400).json({
				success: false,
				message: "email and password are required",
			});
			return;
		}

		const isEmailValid = safeEqual(
			email,
			config.ADMIN_EMAIL.toLowerCase(),
		);
		const isPasswordValid = safeEqual(
			password,
			config.ADMIN_PASSWORD,
		);

		if (!isEmailValid || !isPasswordValid) {
			res.status(401).json({
				success: false,
				message: "Invalid admin credentials",
			});
			return;
		}

		const token = createAdminToken(email);
		res.status(200).json({
			success: true,
			token,
			expiresInHours: config.ADMIN_TOKEN_EXPIRY_HOURS,
			admin: {
				email,
				role: "admin",
			},
		});
	} catch (error) {
		logger.error("Admin login failed", {
			error:
				error instanceof Error
					? error.message
					: String(error),
		});
		res.status(500).json({
			success: false,
			message: "Failed to login as admin",
		});
	}
};

export const getAdminDashboard = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const recentUsersLimit = parseLimit(
			req.query.recentUsersLimit,
			10,
			100,
		);
		const topUsersLimit = parseLimit(
			req.query.topUsersLimit,
			10,
			100,
		);

		const [
			overviewResult,
			planBreakdownResult,
			leadStatusResult,
			chatDailyResult,
			signupsDailyResult,
			recentUsersResult,
			topUsersResult,
		] = await Promise.all([
			pool.query<{
				total_users: number;
				verified_users: number;
				active_users_30d: number;
				total_conversations: number;
				total_messages: number;
				total_leads: number;
				total_widgets: number;
				active_widgets: number;
				conversations_this_month: number;
				leads_this_month: number;
			}>(`
				WITH users_agg AS (
					SELECT
						COUNT(*)::int AS total_users,
						COUNT(*) FILTER (WHERE is_verified = TRUE)::int AS verified_users,
						COUNT(*) FILTER (
							WHERE last_login >= NOW() - INTERVAL '30 days'
						)::int AS active_users_30d
					FROM users
				),
				conversations_agg AS (
					SELECT
						COUNT(*) FILTER (WHERE is_deleted = FALSE)::int AS total_conversations,
						COUNT(*) FILTER (
							WHERE is_deleted = FALSE
							AND created_at >= date_trunc('month', NOW())
						)::int AS conversations_this_month
					FROM chat_conversations
				),
				messages_agg AS (
					SELECT COUNT(*)::int AS total_messages
					FROM chat_messages
				),
				leads_agg AS (
					SELECT
						COUNT(*)::int AS total_leads,
						COUNT(*) FILTER (
							WHERE created_at >= date_trunc('month', NOW())
						)::int AS leads_this_month
					FROM leads
				),
				widgets_agg AS (
					SELECT
						COUNT(*)::int AS total_widgets,
						COUNT(*) FILTER (WHERE is_active = TRUE)::int AS active_widgets
					FROM widget_keys
				)
				SELECT
					users_agg.total_users,
					users_agg.verified_users,
					users_agg.active_users_30d,
					conversations_agg.total_conversations,
					messages_agg.total_messages,
					leads_agg.total_leads,
					widgets_agg.total_widgets,
					widgets_agg.active_widgets,
					conversations_agg.conversations_this_month,
					leads_agg.leads_this_month
				FROM users_agg, conversations_agg, messages_agg, leads_agg, widgets_agg
			`),
			pool.query<{
				plan_type: string;
				users: number;
			}>(`
				SELECT plan_type, COUNT(*)::int AS users
				FROM users
				GROUP BY plan_type
				ORDER BY users DESC
			`),
			pool.query<{
				status: string;
				total: number;
			}>(`
				SELECT status, COUNT(*)::int AS total
				FROM leads
				GROUP BY status
				ORDER BY total DESC
			`),
			pool.query<{
				date: string;
				total: number;
			}>(`
				SELECT
					to_char(created_at::date, 'YYYY-MM-DD') AS date,
					COUNT(*)::int AS total
				FROM chat_conversations
				WHERE is_deleted = FALSE
					AND created_at >= NOW() - INTERVAL '30 days'
				GROUP BY created_at::date
				ORDER BY created_at::date ASC
			`),
			pool.query<{
				date: string;
				total: number;
			}>(`
				SELECT
					to_char(created_at::date, 'YYYY-MM-DD') AS date,
					COUNT(*)::int AS total
				FROM users
				WHERE created_at >= NOW() - INTERVAL '30 days'
				GROUP BY created_at::date
				ORDER BY created_at::date ASC
			`),
			pool.query<{
				id: string;
				email: string;
				plan_type: string;
				is_verified: boolean;
				created_at: Date;
				last_login: Date | null;
				conversations_used: NullableNumber;
			}>(
				`
				SELECT
					id,
					email,
					plan_type,
					is_verified,
					created_at,
					last_login,
					conversations_used
				FROM users
				ORDER BY created_at DESC
				LIMIT $1
			`,
				[recentUsersLimit],
			),
			pool.query<{
				id: string;
				email: string;
				plan_type: string;
				conversations_used: NullableNumber;
				message_count: number;
			}>(
				`
				SELECT
					u.id,
					u.email,
					u.plan_type,
					u.conversations_used,
					COALESCE(SUM(cc.message_count), 0)::int AS message_count
				FROM users u
				LEFT JOIN chat_conversations cc
					ON cc.user_id = u.id
					AND cc.is_deleted = FALSE
				GROUP BY u.id
				ORDER BY u.conversations_used DESC NULLS LAST, message_count DESC
				LIMIT $1
			`,
				[topUsersLimit],
			),
		]);

		res.status(200).json({
			success: true,
			data: {
				overview: overviewResult.rows[0],
				planBreakdown: planBreakdownResult.rows,
				leadStatusBreakdown: leadStatusResult.rows,
				chatsByDay: chatDailyResult.rows,
				signupsByDay: signupsDailyResult.rows,
				recentUsers: recentUsersResult.rows,
				topUsers: topUsersResult.rows,
				generatedAt: new Date().toISOString(),
			},
		});
	} catch (error) {
		logger.error("Failed to fetch admin dashboard data", {
			error:
				error instanceof Error
					? error.message
					: String(error),
			adminEmail: req.admin?.email,
		});
		res.status(500).json({
			success: false,
			message: "Failed to fetch admin dashboard data",
		});
	}
};

export const getAdminUsers = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const limit = parseLimit(req.query.limit, 50, 200);
		const offset = Math.max(
			0,
			Number(req.query.offset) || 0,
		);
		const search =
			typeof req.query.search === "string"
				? req.query.search.trim().toLowerCase()
				: "";
		const plan =
			typeof req.query.plan === "string"
				? req.query.plan.trim().toLowerCase()
				: "";

		const params: Array<string | number> = [];
		let where = "WHERE 1=1";

		if (search) {
			params.push(`%${search}%`);
			where += ` AND LOWER(u.email) LIKE $${params.length}`;
		}

		if (plan) {
			params.push(plan);
			where += ` AND u.plan_type = $${params.length}`;
		}

		params.push(limit);
		const limitParam = params.length;
		params.push(offset);
		const offsetParam = params.length;

		const listQuery = `
			SELECT
				u.id,
				u.email,
				u.plan_type,
				u.is_verified,
				u.created_at,
				u.last_login,
				u.conversations_used,
				u.conversations_limit,
				COALESCE(SUM(cc.message_count), 0)::int AS message_count
			FROM users u
			LEFT JOIN chat_conversations cc
				ON cc.user_id = u.id
				AND cc.is_deleted = FALSE
			${where}
			GROUP BY u.id
			ORDER BY u.created_at DESC
			LIMIT $${limitParam}
			OFFSET $${offsetParam}
		`;

		const countQuery = `
			SELECT COUNT(*)::int AS total
			FROM users u
			${where}
		`;

		const [listResult, countResult] = await Promise.all([
			pool.query(listQuery, params),
			pool.query(countQuery, params.slice(0, -2)),
		]);

		res.status(200).json({
			success: true,
			data: {
				users: listResult.rows,
				total: countResult.rows[0]?.total ?? 0,
				limit,
				offset,
			},
		});
	} catch (error) {
		logger.error("Failed to fetch admin users", {
			error:
				error instanceof Error
					? error.message
					: String(error),
			adminEmail: req.admin?.email,
		});
		res.status(500).json({
			success: false,
			message: "Failed to fetch admin users",
		});
	}
};

export const getAdminInsights = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const [
			revenueResult,
			tokenResult,
			qualityResult,
			funnelResult,
			securityResult,
			opsResult,
			ragResult,
			feedbackResult,
			webhookResult,
		] = await Promise.all([
			pool.query<{
				paying_users: number;
				active_subscriptions: number;
				mrr_estimate_usd: number;
				revenue_30d_usd: number;
				failed_payments_30d: number;
				churn_risk_subscriptions: number;
			}>(`
				WITH active_subs AS (
					SELECT *
					FROM subscriptions
					WHERE status IN ('active', 'trialing')
				),
				rev_30d AS (
					SELECT COALESCE(SUM(amount), 0)::numeric / 100.0 AS revenue_30d_usd
					FROM payment_history
					WHERE created_at >= NOW() - INTERVAL '30 days'
					  AND status = 'succeeded'
				),
				failed_30d AS (
					SELECT COUNT(*)::int AS failed_payments_30d
					FROM payment_history
					WHERE created_at >= NOW() - INTERVAL '30 days'
					  AND status != 'succeeded'
				)
				SELECT
					COUNT(DISTINCT s.user_id)::int AS paying_users,
					COUNT(*)::int AS active_subscriptions,
					(COUNT(*) * 18)::numeric AS mrr_estimate_usd,
					(SELECT revenue_30d_usd FROM rev_30d) AS revenue_30d_usd,
					(SELECT failed_payments_30d FROM failed_30d) AS failed_payments_30d,
					COUNT(*) FILTER (WHERE s.cancel_at_period_end = TRUE)::int AS churn_risk_subscriptions
				FROM active_subs s
			`),
			pool.query<{
				prompt_tokens_estimated_30d: number;
				completion_tokens_estimated_30d: number;
				total_tokens_estimated_30d: number;
				estimated_llm_cost_30d_usd: number;
			}>(`
				WITH msg AS (
					SELECT
						role,
						content
					FROM chat_messages
					WHERE created_at >= NOW() - INTERVAL '30 days'
				),
				est AS (
					SELECT
						SUM(CASE WHEN role = 'user' THEN GREATEST(1, LENGTH(content) / 4) ELSE 0 END)::bigint AS prompt_tokens,
						SUM(CASE WHEN role = 'assistant' THEN GREATEST(1, LENGTH(content) / 4) ELSE 0 END)::bigint AS completion_tokens
					FROM msg
				)
				SELECT
					COALESCE(prompt_tokens, 0)::bigint AS prompt_tokens_estimated_30d,
					COALESCE(completion_tokens, 0)::bigint AS completion_tokens_estimated_30d,
					COALESCE(prompt_tokens, 0)::bigint + COALESCE(completion_tokens, 0)::bigint AS total_tokens_estimated_30d,
					ROUND(
						(
							(COALESCE(prompt_tokens, 0)::numeric / 1000000.0) * 0.40
							+ (COALESCE(completion_tokens, 0)::numeric / 1000000.0) * 1.60
						),
						4
					) AS estimated_llm_cost_30d_usd
				FROM est
			`),
			pool.query<{
				total_ratings: number;
				positive_ratings: number;
				negative_ratings: number;
				rating_positive_pct: number;
				fallback_reply_count_30d: number;
				avg_response_chars_30d: number;
			}>(`
				WITH ratings AS (
					SELECT
						COUNT(*)::int AS total_ratings,
						COUNT(*) FILTER (WHERE rating = 'up')::int AS positive_ratings,
						COUNT(*) FILTER (WHERE rating = 'down')::int AS negative_ratings
					FROM chat_ratings
				),
				reply AS (
					SELECT
						COUNT(*) FILTER (
							WHERE role = 'assistant'
							  AND created_at >= NOW() - INTERVAL '30 days'
							  AND (
								LOWER(content) LIKE '%sorry%'
								OR LOWER(content) LIKE '%temporary delay%'
							  )
						)::int AS fallback_reply_count_30d,
						COALESCE(
							AVG(
								CASE
									WHEN role = 'assistant'
									 AND created_at >= NOW() - INTERVAL '30 days'
									THEN LENGTH(content)
								END
							),
							0
						)::numeric(12,2) AS avg_response_chars_30d
					FROM chat_messages
				)
				SELECT
					r.total_ratings,
					r.positive_ratings,
					r.negative_ratings,
					CASE
						WHEN r.total_ratings = 0 THEN 0
						ELSE ROUND((r.positive_ratings::numeric / r.total_ratings::numeric) * 100.0, 2)
					END AS rating_positive_pct,
					reply.fallback_reply_count_30d,
					reply.avg_response_chars_30d
				FROM ratings r, reply
			`),
			pool.query<{
				widget_loads_30d: number;
				conversations_30d: number;
				leads_30d: number;
				qualified_leads_30d: number;
				converted_leads_30d: number;
			}>(`
				WITH loads AS (
					SELECT COUNT(*)::int AS widget_loads_30d
					FROM widget_analytics
					WHERE event_type = 'widget_loaded'
					  AND created_at >= NOW() - INTERVAL '30 days'
				),
				convos AS (
					SELECT COUNT(*)::int AS conversations_30d
					FROM chat_conversations
					WHERE is_deleted = FALSE
					  AND created_at >= NOW() - INTERVAL '30 days'
				),
				lead_stats AS (
					SELECT
						COUNT(*)::int AS leads_30d,
						COUNT(*) FILTER (WHERE status = 'qualified')::int AS qualified_leads_30d,
						COUNT(*) FILTER (WHERE status = 'converted')::int AS converted_leads_30d
					FROM leads
					WHERE created_at >= NOW() - INTERVAL '30 days'
				)
				SELECT
					loads.widget_loads_30d,
					convos.conversations_30d,
					lead_stats.leads_30d,
					lead_stats.qualified_leads_30d,
					lead_stats.converted_leads_30d
				FROM loads, convos, lead_stats
			`),
			pool.query<{
				suspicious_ip_count_24h: number;
				top_suspicious_ip: string | null;
				top_suspicious_ip_events: number;
			}>(`
				WITH ip_events AS (
					SELECT
						COALESCE(ip_address, 'unknown') AS ip,
						COUNT(*)::int AS events
					FROM widget_analytics
					WHERE created_at >= NOW() - INTERVAL '24 hours'
					GROUP BY COALESCE(ip_address, 'unknown')
				),
				suspicious AS (
					SELECT *
					FROM ip_events
					WHERE events >= 200
				),
				top_ip AS (
					SELECT ip, events
					FROM ip_events
					ORDER BY events DESC
					LIMIT 1
				)
				SELECT
					(SELECT COUNT(*)::int FROM suspicious) AS suspicious_ip_count_24h,
					(SELECT ip FROM top_ip) AS top_suspicious_ip,
					(SELECT events FROM top_ip) AS top_suspicious_ip_events
			`),
			pool.query<{
				db_active_connections: number;
				chat_messages_24h: number;
				pending_webhook_events: number;
				dead_webhook_events: number;
			}>(`
				WITH db_conn AS (
					SELECT COUNT(*)::int AS db_active_connections
					FROM pg_stat_activity
					WHERE datname = current_database()
				),
				msg_24h AS (
					SELECT COUNT(*)::int AS chat_messages_24h
					FROM chat_messages
					WHERE created_at >= NOW() - INTERVAL '24 hours'
				),
				webhook AS (
					SELECT
						COUNT(*) FILTER (WHERE status IN ('pending', 'retrying', 'processing'))::int AS pending_webhook_events,
						COUNT(*) FILTER (WHERE status = 'dead')::int AS dead_webhook_events
					FROM lead_webhook_events
				)
				SELECT
					db_conn.db_active_connections,
					msg_24h.chat_messages_24h,
					webhook.pending_webhook_events,
					webhook.dead_webhook_events
				FROM db_conn, msg_24h, webhook
			`),
			pool.query<{
				document_chunks_indexed: number;
				website_chunks_indexed: number;
				avg_sources_per_reply_30d: number;
			}>(`
				WITH chunks AS (
					SELECT
						COUNT(*) FILTER (
							WHERE metadata ? 'url'
							  AND (metadata->>'url') LIKE 'document://%'
						)::int AS document_chunks_indexed,
						COUNT(*) FILTER (
							WHERE metadata ? 'url'
							  AND (metadata->>'url') NOT LIKE 'document://%'
						)::int AS website_chunks_indexed
					FROM pinecone_data
				),
				source_avg AS (
					SELECT
						COALESCE(
							AVG(
								CASE
									WHEN metadata ? 'sourcesCount' THEN (metadata->>'sourcesCount')::numeric
									ELSE NULL
								END
							),
							0
						)::numeric(12,2) AS avg_sources_per_reply_30d
					FROM chat_messages
					WHERE role = 'assistant'
					  AND created_at >= NOW() - INTERVAL '30 days'
				)
				SELECT
					chunks.document_chunks_indexed,
					chunks.website_chunks_indexed,
					source_avg.avg_sources_per_reply_30d
				FROM chunks, source_avg
			`).catch(async () =>
				pool.query<{
					document_chunks_indexed: number;
					website_chunks_indexed: number;
					avg_sources_per_reply_30d: number;
				}>(`
					WITH source_avg AS (
						SELECT
							COALESCE(
								AVG(
									CASE
										WHEN metadata ? 'sourcesCount' THEN (metadata->>'sourcesCount')::numeric
										ELSE NULL
									END
								),
								0
							)::numeric(12,2) AS avg_sources_per_reply_30d
						FROM chat_messages
						WHERE role = 'assistant'
						  AND created_at >= NOW() - INTERVAL '30 days'
					)
					SELECT
						0::int AS document_chunks_indexed,
						0::int AS website_chunks_indexed,
						source_avg.avg_sources_per_reply_30d
					FROM source_avg
				`),
			),
			pool.query<{
				feedback_count_30d: number;
				suggestion_count_30d: number;
			}>(`
				SELECT
					COUNT(*) FILTER (WHERE type = 'feedback')::int AS feedback_count_30d,
					COUNT(*) FILTER (WHERE type = 'suggestion')::int AS suggestion_count_30d
				FROM feedback_suggestions
				WHERE created_at >= NOW() - INTERVAL '30 days'
			`),
			pool.query<{
				webhook_configs_active: number;
				webhook_delivery_success_30d: number;
				webhook_delivery_dead_30d: number;
			}>(`
				WITH configs AS (
					SELECT COUNT(*) FILTER (WHERE is_active = TRUE)::int AS webhook_configs_active
					FROM lead_webhook_configs
				),
				deliveries AS (
					SELECT
						COUNT(*) FILTER (WHERE status = 'delivered')::int AS webhook_delivery_success_30d,
						COUNT(*) FILTER (WHERE status = 'dead')::int AS webhook_delivery_dead_30d
					FROM lead_webhook_events
					WHERE created_at >= NOW() - INTERVAL '30 days'
				)
				SELECT
					configs.webhook_configs_active,
					deliveries.webhook_delivery_success_30d,
					deliveries.webhook_delivery_dead_30d
				FROM configs, deliveries
			`),
		]);

		res.status(200).json({
			success: true,
			data: {
				revenue: revenueResult.rows[0],
				tokens: tokenResult.rows[0],
				quality: qualityResult.rows[0],
				funnel: funnelResult.rows[0],
				security: securityResult.rows[0],
				operations: opsResult.rows[0],
				ragHealth: ragResult.rows[0],
				feedback: feedbackResult.rows[0],
				webhooks: webhookResult.rows[0],
				featureFlags: {
					totalFlags: 0,
					activeFlags: 0,
				},
				compliance: {
					openRequests: 0,
					completedRequests30d: 0,
				},
				generatedAt: new Date().toISOString(),
			},
		});
	} catch (error) {
		logger.error("Failed to fetch admin insights", {
			error:
				error instanceof Error
					? error.message
					: String(error),
			adminEmail: req.admin?.email,
		});
		res.status(500).json({
			success: false,
			message: "Failed to fetch admin insights",
		});
	}
};

export const resetUserUsage = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId =
			typeof req.body?.userId === "string"
				? req.body.userId
				: "";
		if (!userId) {
			res.status(400).json({
				success: false,
				message: "userId is required",
			});
			return;
		}

		await pool.query(
			`UPDATE users
			 SET conversations_used = 0,
				 plan_reset_date = CURRENT_TIMESTAMP,
				 updated_at = CURRENT_TIMESTAMP
			 WHERE id = $1`,
			[userId],
		);

		res.status(200).json({
			success: true,
			message: "User usage reset successfully",
		});
	} catch (error) {
		logger.error("Failed to reset user usage", {
			error:
				error instanceof Error
					? error.message
					: String(error),
			adminEmail: req.admin?.email,
		});
		res.status(500).json({
			success: false,
			message: "Failed to reset user usage",
		});
	}
};

export const forceLogoutUserSessions = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId =
			typeof req.body?.userId === "string"
				? req.body.userId
				: "";
		if (!userId) {
			res.status(400).json({
				success: false,
				message: "userId is required",
			});
			return;
		}

		const result = await pool.query(
			`UPDATE sessions
			 SET is_revoked = TRUE,
				 updated_at = CURRENT_TIMESTAMP
			 WHERE user_id = $1
			   AND is_revoked = FALSE`,
			[userId],
		);

		res.status(200).json({
			success: true,
			message: "User sessions revoked",
			revokedSessions: result.rowCount ?? 0,
		});
	} catch (error) {
		logger.error("Failed to force logout sessions", {
			error:
				error instanceof Error
					? error.message
					: String(error),
			adminEmail: req.admin?.email,
		});
		res.status(500).json({
			success: false,
			message: "Failed to force logout sessions",
		});
	}
};

export const setUserPlan = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId =
			typeof req.body?.userId === "string"
				? req.body.userId
				: "";
		const planType = coercePlanType(req.body?.planType);

		if (!userId) {
			res.status(400).json({
				success: false,
				message: "userId is required",
			});
			return;
		}

		const limit =
			planType === "enterprise"
				? null
				: planType === "basic"
					? 1500
					: 100;

		await pool.query(
			`UPDATE users
			 SET plan_type = $2,
				 conversations_limit = $3,
				 updated_at = CURRENT_TIMESTAMP
			 WHERE id = $1`,
			[userId, planType, limit],
		);

		res.status(200).json({
			success: true,
			message: "User plan updated",
			data: {
				userId,
				planType,
				conversationsLimit: limit,
			},
		});
	} catch (error) {
		logger.error("Failed to set user plan", {
			error:
				error instanceof Error
					? error.message
					: String(error),
			adminEmail: req.admin?.email,
		});
		res.status(500).json({
			success: false,
			message: "Failed to set user plan",
		});
	}
};
