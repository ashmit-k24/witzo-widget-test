import { NextFunction, Request, Response } from "express";
import pool from "../config/database";
import adminAuthService from "../services/adminAuthService";
import { signAdminToken } from "../middleware/adminAuth";
import logger from "../utils/logger";

// ─── Login ───────────────────────────────────────────────────────────────────

export const login = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { email, password } = req.body as {
			email?: string;
			password?: string;
		};

		if (!email || !password) {
			res.status(400).json({ message: "Email and password required" });
			return;
		}

		const loginResult =
			await adminAuthService.authenticateAdmin(
				email,
				password,
				{
					ipAddress: req.ip,
					userAgent:
						req.get("user-agent") ?? null,
				},
			);

		if (!loginResult.success) {
			logger.warn(
				"Failed admin login attempt",
				{ email, ip: req.ip },
			);
			res.status(loginResult.status).json({
				message: loginResult.message,
			});
			return;
		}

		const token = signAdminToken(
			loginResult.admin,
		);
		logger.info("Admin login successful", {
			adminId: loginResult.admin.id,
			email: loginResult.admin.email,
			role: loginResult.admin.role,
			ip: req.ip,
		});
		res.json({
			token,
			data: {
				admin: loginResult.admin,
			},
		});
	} catch (error) {
		next(error);
	}
};

export const getCurrentAdmin = async (
	req: Request,
	res: Response,
	_next: NextFunction,
): Promise<void> => {
	res.json({
		data: {
			admin: req.admin,
		},
	});
};

// ─── Dashboard ───────────────────────────────────────────────────────────────

export const getDashboard = async (
	_req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const client = await pool.connect();
		try {
			const [
				overviewResult,
				planBreakdownResult,
				leadStatusResult,
				chatsByDayResult,
				signupsByDayResult,
				recentUsersResult,
				topUsersResult,
			] = await Promise.all([
				client.query<{
					total_users: string;
					verified_users: string;
					active_users_30d: string;
					total_conversations: string;
					total_messages: string;
					total_leads: string;
					total_widgets: string;
					active_widgets: string;
					conversations_this_month: string;
					leads_this_month: string;
				}>(`
					SELECT
						(SELECT COUNT(*) FROM users) AS total_users,
						(SELECT COUNT(*) FROM users WHERE is_verified = TRUE) AS verified_users,
						(SELECT COUNT(DISTINCT user_id) FROM chat_conversations
							WHERE last_message_at >= NOW() - INTERVAL '30 days'
							AND is_deleted = FALSE) AS active_users_30d,
						(SELECT COUNT(*) FROM chat_conversations WHERE is_deleted = FALSE) AS total_conversations,
						(SELECT COALESCE(SUM(message_count), 0) FROM chat_conversations WHERE is_deleted = FALSE) AS total_messages,
						(SELECT COUNT(*) FROM leads) AS total_leads,
						(SELECT COUNT(*) FROM widget_keys) AS total_widgets,
						(SELECT COUNT(*) FROM widget_keys WHERE is_active = TRUE) AS active_widgets,
						(SELECT COUNT(*) FROM chat_conversations
							WHERE created_at >= DATE_TRUNC('month', NOW())
							AND is_deleted = FALSE) AS conversations_this_month,
						(SELECT COUNT(*) FROM leads
							WHERE created_at >= DATE_TRUNC('month', NOW())) AS leads_this_month
				`),
				client.query<{ plan_type: string; users: string }>(`
					SELECT plan_type, COUNT(*) AS users
					FROM users
					GROUP BY plan_type
					ORDER BY users DESC
				`),
				client.query<{ status: string; total: string }>(`
					SELECT status, COUNT(*) AS total
					FROM leads
					GROUP BY status
					ORDER BY total DESC
				`),
				client.query<{ date: string; total: string }>(`
					SELECT DATE(created_at) AS date, COUNT(*) AS total
					FROM chat_conversations
					WHERE created_at >= NOW() - INTERVAL '30 days'
					AND is_deleted = FALSE
					GROUP BY DATE(created_at)
					ORDER BY date
				`),
				client.query<{ date: string; total: string }>(`
					SELECT DATE(created_at) AS date, COUNT(*) AS total
					FROM users
					WHERE created_at >= NOW() - INTERVAL '30 days'
					GROUP BY DATE(created_at)
					ORDER BY date
				`),
				client.query<{
					id: string;
					email: string;
					plan_type: string;
					is_verified: boolean;
					created_at: string;
					last_login: string | null;
					conversations_used: number | null;
					conversations_limit: number | null;
				}>(`
					SELECT id, email, plan_type, is_verified, created_at, last_login,
					       conversations_used, conversations_limit
					FROM users
					ORDER BY created_at DESC
					LIMIT 10
				`),
				client.query<{
					id: string;
					email: string;
					plan_type: string;
					conversations_used: number | null;
					conversations_limit: number | null;
				}>(`
					SELECT id, email, plan_type, conversations_used, conversations_limit
					FROM users
					ORDER BY conversations_used DESC NULLS LAST
					LIMIT 10
				`),
			]);

			const overview = overviewResult.rows[0];

			res.json({
				data: {
					overview: {
						total_users: Number(overview.total_users),
						verified_users: Number(overview.verified_users),
						active_users_30d: Number(overview.active_users_30d),
						total_conversations: Number(overview.total_conversations),
						total_messages: Number(overview.total_messages),
						total_leads: Number(overview.total_leads),
						total_widgets: Number(overview.total_widgets),
						active_widgets: Number(overview.active_widgets),
						conversations_this_month: Number(
							overview.conversations_this_month,
						),
						leads_this_month: Number(overview.leads_this_month),
					},
					planBreakdown: planBreakdownResult.rows.map((r) => ({
						plan_type: r.plan_type,
						users: Number(r.users),
					})),
					leadStatusBreakdown: leadStatusResult.rows.map((r) => ({
						status: r.status,
						total: Number(r.total),
					})),
					chatsByDay: chatsByDayResult.rows.map((r) => ({
						date: r.date,
						total: Number(r.total),
					})),
					signupsByDay: signupsByDayResult.rows.map((r) => ({
						date: r.date,
						total: Number(r.total),
					})),
					recentUsers: recentUsersResult.rows,
					topUsers: topUsersResult.rows,
					generatedAt: new Date().toISOString(),
				},
			});
		} finally {
			client.release();
		}
	} catch (error) {
		next(error);
	}
};

// ─── Insights ────────────────────────────────────────────────────────────────

export const getInsights = async (
	_req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const client = await pool.connect();
		try {
			const [
				revenueResult,
				qualityResult,
				funnelResult,
				operationsResult,
				ragHealthResult,
				feedbackResult,
				webhookResult,
				featureFlagResult,
				complianceResult,
			] = await Promise.all([
				client.query<{
					paying_users: string;
					active_subscriptions: string;
					mrr_estimate_usd: string;
					revenue_30d_usd: string;
					failed_payments_30d: string;
					churn_risk_subscriptions: string;
				}>(`
					SELECT
						(SELECT COUNT(DISTINCT user_id) FROM subscriptions
							WHERE status = 'active') AS paying_users,
						(SELECT COUNT(*) FROM subscriptions WHERE status = 'active') AS active_subscriptions,
						(SELECT COALESCE(SUM(
							CASE plan_type
								WHEN 'basic' THEN 29
								WHEN 'enterprise' THEN 99
								ELSE 0
							END
						), 0) FROM subscriptions WHERE status = 'active') AS mrr_estimate_usd,
						(SELECT COALESCE(SUM(amount::numeric / 100), 0) FROM payment_history
							WHERE status = 'succeeded'
							AND created_at >= NOW() - INTERVAL '30 days') AS revenue_30d_usd,
						(SELECT COUNT(*) FROM payment_history
							WHERE status = 'failed'
							AND created_at >= NOW() - INTERVAL '30 days') AS failed_payments_30d,
						(SELECT COUNT(*) FROM subscriptions
							WHERE cancel_at_period_end = TRUE
							AND status = 'active') AS churn_risk_subscriptions
				`),
				client.query<{
					total_ratings: string;
					positive_ratings: string;
					negative_ratings: string;
					rating_positive_pct: string;
					fallback_reply_count_30d: string;
					avg_response_chars_30d: string;
				}>(`
					SELECT
						(SELECT COUNT(*) FROM chat_ratings) AS total_ratings,
						(SELECT COUNT(*) FROM chat_ratings WHERE rating = 'up') AS positive_ratings,
						(SELECT COUNT(*) FROM chat_ratings WHERE rating = 'down') AS negative_ratings,
						CASE WHEN (SELECT COUNT(*) FROM chat_ratings) > 0
							THEN ROUND(
								(SELECT COUNT(*) FROM chat_ratings WHERE rating = 'up')::numeric
								/ (SELECT COUNT(*) FROM chat_ratings)::numeric * 100, 1
							)
							ELSE 0
						END AS rating_positive_pct,
						0 AS fallback_reply_count_30d,
						0 AS avg_response_chars_30d
				`),
				client.query<{
					widget_loads_30d: string;
					conversations_30d: string;
					leads_30d: string;
					qualified_leads_30d: string;
					converted_leads_30d: string;
				}>(`
					SELECT
						(SELECT COUNT(*) FROM widget_analytics
							WHERE event_type = 'load'
							AND created_at >= NOW() - INTERVAL '30 days') AS widget_loads_30d,
						(SELECT COUNT(*) FROM chat_conversations
							WHERE created_at >= NOW() - INTERVAL '30 days'
							AND is_deleted = FALSE) AS conversations_30d,
						(SELECT COUNT(*) FROM leads
							WHERE created_at >= NOW() - INTERVAL '30 days') AS leads_30d,
						(SELECT COUNT(*) FROM leads
							WHERE created_at >= NOW() - INTERVAL '30 days'
							AND status IN ('qualified', 'converted')) AS qualified_leads_30d,
						(SELECT COUNT(*) FROM leads
							WHERE created_at >= NOW() - INTERVAL '30 days'
							AND status = 'converted') AS converted_leads_30d
				`),
				client.query<{
					db_active_connections: string;
					chat_messages_24h: string;
					pending_webhook_events: string;
					dead_webhook_events: string;
				}>(`
					SELECT
						(SELECT COUNT(*) FROM pg_stat_activity
							WHERE state = 'active') AS db_active_connections,
						(SELECT COALESCE(SUM(message_count), 0) FROM chat_conversations
							WHERE last_message_at >= NOW() - INTERVAL '24 hours'
							AND is_deleted = FALSE) AS chat_messages_24h,
						(SELECT COUNT(*) FROM lead_webhook_events
							WHERE status = 'pending') AS pending_webhook_events,
						(SELECT COUNT(*) FROM lead_webhook_events
							WHERE status = 'dead') AS dead_webhook_events
				`),
				client.query<{
					document_chunks_indexed: string;
					website_chunks_indexed: string;
					avg_sources_per_reply_30d: string;
				}>(`
					SELECT 0 AS document_chunks_indexed,
					       0 AS website_chunks_indexed,
					       0 AS avg_sources_per_reply_30d
				`),
				client.query<{
					feedback_count_30d: string;
					suggestion_count_30d: string;
				}>(`
					SELECT
						(SELECT COUNT(*) FROM feedback_suggestions
							WHERE type = 'feedback'
							AND created_at >= NOW() - INTERVAL '30 days') AS feedback_count_30d,
						(SELECT COUNT(*) FROM feedback_suggestions
							WHERE type = 'suggestion'
							AND created_at >= NOW() - INTERVAL '30 days') AS suggestion_count_30d
				`),
				client.query<{
					webhook_configs_active: string;
					webhook_delivery_success_30d: string;
					webhook_delivery_dead_30d: string;
				}>(`
					SELECT
						(SELECT COUNT(*) FROM lead_webhook_configs WHERE is_active = TRUE) AS webhook_configs_active,
						(SELECT COUNT(*) FROM lead_webhook_events
							WHERE status = 'delivered'
							AND created_at >= NOW() - INTERVAL '30 days') AS webhook_delivery_success_30d,
						(SELECT COUNT(*) FROM lead_webhook_events
							WHERE status = 'dead'
							AND created_at >= NOW() - INTERVAL '30 days') AS webhook_delivery_dead_30d
				`),
				// Feature flags: not implemented yet, return zeros
				Promise.resolve({ rows: [{ totalFlags: 0, activeFlags: 0 }] }),
				// Compliance: not implemented yet, return zeros
				Promise.resolve({ rows: [{ openRequests: 0, completedRequests30d: 0 }] }),
			]);

			const revenue = revenueResult.rows[0];
			const quality = qualityResult.rows[0];
			const funnel = funnelResult.rows[0];
			const ops = operationsResult.rows[0];
			const rag = ragHealthResult.rows[0];
			const feedback = feedbackResult.rows[0];
			const webhooks = webhookResult.rows[0];
			const flags = featureFlagResult.rows[0];
			const compliance = complianceResult.rows[0];

			res.json({
				data: {
					revenue: {
						paying_users: Number(revenue.paying_users),
						active_subscriptions: Number(revenue.active_subscriptions),
						mrr_estimate_usd: Number(revenue.mrr_estimate_usd),
						revenue_30d_usd: Number(revenue.revenue_30d_usd),
						failed_payments_30d: Number(revenue.failed_payments_30d),
						churn_risk_subscriptions: Number(revenue.churn_risk_subscriptions),
					},
					tokens: {
						prompt_tokens_estimated_30d: 0,
						completion_tokens_estimated_30d: 0,
						total_tokens_estimated_30d: 0,
						estimated_llm_cost_30d_usd: 0,
					},
					quality: {
						total_ratings: Number(quality.total_ratings),
						positive_ratings: Number(quality.positive_ratings),
						negative_ratings: Number(quality.negative_ratings),
						rating_positive_pct: Number(quality.rating_positive_pct),
						fallback_reply_count_30d: 0,
						avg_response_chars_30d: 0,
					},
					funnel: {
						widget_loads_30d: Number(funnel.widget_loads_30d),
						conversations_30d: Number(funnel.conversations_30d),
						leads_30d: Number(funnel.leads_30d),
						qualified_leads_30d: Number(funnel.qualified_leads_30d),
						converted_leads_30d: Number(funnel.converted_leads_30d),
					},
					security: {
						suspicious_ip_count_24h: 0,
						top_suspicious_ip: null,
						top_suspicious_ip_events: 0,
					},
					operations: {
						db_active_connections: Number(ops.db_active_connections),
						chat_messages_24h: Number(ops.chat_messages_24h),
						pending_webhook_events: Number(ops.pending_webhook_events),
						dead_webhook_events: Number(ops.dead_webhook_events),
					},
					ragHealth: {
						document_chunks_indexed: Number(rag.document_chunks_indexed),
						website_chunks_indexed: Number(rag.website_chunks_indexed),
						avg_sources_per_reply_30d: Number(rag.avg_sources_per_reply_30d),
					},
					feedback: {
						feedback_count_30d: Number(feedback.feedback_count_30d),
						suggestion_count_30d: Number(feedback.suggestion_count_30d),
					},
					webhooks: {
						webhook_configs_active: Number(webhooks.webhook_configs_active),
						webhook_delivery_success_30d: Number(
							webhooks.webhook_delivery_success_30d,
						),
						webhook_delivery_dead_30d: Number(webhooks.webhook_delivery_dead_30d),
					},
					featureFlags: {
						totalFlags: Number(flags.totalFlags),
						activeFlags: Number(flags.activeFlags),
					},
					compliance: {
						openRequests: Number(compliance.openRequests),
						completedRequests30d: Number(compliance.completedRequests30d),
					},
					generatedAt: new Date().toISOString(),
				},
			});
		} finally {
			client.release();
		}
	} catch (error) {
		next(error);
	}
};

// ─── Users list ───────────────────────────────────────────────────────────────

export const getUsers = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const limit = Math.min(Number(req.query.limit) || 50, 200);
		const offset = Number(req.query.offset) || 0;
		const search = (req.query.search as string | undefined) || "";
		const plan = (req.query.plan as string | undefined) || "";

		const conditions: string[] = [];
		const params: unknown[] = [];
		let paramIdx = 1;

		if (search) {
			conditions.push(
				`(email ILIKE $${paramIdx} OR id::text ILIKE $${paramIdx})`,
			);
			params.push(`%${search}%`);
			paramIdx++;
		}

		if (plan) {
			conditions.push(`plan_type = $${paramIdx}`);
			params.push(plan);
			paramIdx++;
		}

		const where =
			conditions.length > 0
				? `WHERE ${conditions.join(" AND ")}`
				: "";

		const client = await pool.connect();
		try {
			const [usersResult, countResult] = await Promise.all([
				client.query(
					`SELECT id, email, plan_type, is_verified, created_at, last_login,
					        conversations_used, conversations_limit
					 FROM users
					 ${where}
					 ORDER BY created_at DESC
					 LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
					[...params, limit, offset],
				),
				client.query(
					`SELECT COUNT(*) AS total FROM users ${where}`,
					params,
				),
			]);

			res.json({
				data: {
					users: usersResult.rows,
					total: Number(countResult.rows[0].total),
					limit,
					offset,
				},
			});
		} finally {
			client.release();
		}
	} catch (error) {
		next(error);
	}
};

// ─── Actions ─────────────────────────────────────────────────────────────────

export const resetUsage = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { userId } = req.body as { userId?: string };
		if (!userId) {
			res.status(400).json({ message: "userId required" });
			return;
		}

		await pool.query(
			"UPDATE users SET conversations_used = 0 WHERE id = $1",
			[userId],
		);

		await adminAuthService.recordAuditEvent({
			adminUserId: req.admin?.id,
			action: "admin.user.reset_usage",
			ipAddress: req.ip,
			userAgent: req.get("user-agent") ?? null,
			metadata: { userId },
		});
		logger.info("Admin: reset usage", {
			adminId: req.admin?.id,
			userId,
		});
		res.json({ data: { success: true } });
	} catch (error) {
		next(error);
	}
};

export const forceLogout = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { userId } = req.body as { userId?: string };
		if (!userId) {
			res.status(400).json({ message: "userId required" });
			return;
		}

		await pool.query(
			"UPDATE sessions SET is_revoked = TRUE WHERE user_id = $1",
			[userId],
		);

		await adminAuthService.recordAuditEvent({
			adminUserId: req.admin?.id,
			action: "admin.user.force_logout",
			ipAddress: req.ip,
			userAgent: req.get("user-agent") ?? null,
			metadata: { userId },
		});
		logger.info("Admin: force logout", {
			adminId: req.admin?.id,
			userId,
		});
		res.json({ data: { success: true } });
	} catch (error) {
		next(error);
	}
};

export const setUserPlan = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const { userId, planType } = req.body as {
			userId?: string;
			planType?: string;
		};

		if (!userId || !planType) {
			res.status(400).json({ message: "userId and planType required" });
			return;
		}

		const allowedPlans = ["free", "basic", "enterprise"];
		if (!allowedPlans.includes(planType)) {
			res
				.status(400)
				.json({ message: `planType must be one of: ${allowedPlans.join(", ")}` });
			return;
		}

		await pool.query(
			"UPDATE users SET plan_type = $1, updated_at = NOW() WHERE id = $2",
			[planType, userId],
		);

		await adminAuthService.recordAuditEvent({
			adminUserId: req.admin?.id,
			action: "admin.user.set_plan",
			ipAddress: req.ip,
			userAgent: req.get("user-agent") ?? null,
			metadata: { userId, planType },
		});
		logger.info("Admin: set user plan", {
			adminId: req.admin?.id,
			userId,
			planType,
		});
		res.json({ data: { success: true } });
	} catch (error) {
		next(error);
	}
};
