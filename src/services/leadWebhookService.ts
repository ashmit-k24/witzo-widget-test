import axios from "axios";
import crypto from "crypto";
import {
	getPlanCapabilities,
	PlanType,
} from "../config/planConfig";
import { config as appConfig } from "../config/env";
import pool from "../config/database";
import {
	WEBHOOK_BACKOFF_BASE_MS,
	WEBHOOK_BACKOFF_MAX_MS,
	WEBHOOK_DELIVERY_TIMEOUT_MS,
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_PROCESS_BATCH_SIZE,
} from "../constants";
import logger from "../utils/logger";
import { assertSafeOutgoingUrl } from "../utils/networkSafety";

type LeadWebhookEventStatus =
	| "pending"
	| "processing"
	| "retrying"
	| "delivered"
	| "dead";

type LeadWebhookConfigRow = {
	id: string;
	user_id: string;
	webhook_url: string;
	signing_secret: string;
	is_active: boolean;
	created_at: Date;
	updated_at: Date;
};

type LeadWebhookEventRow = {
	id: string;
	user_id: string;
	lead_id: string | null;
	config_id: string;
	event_type: string;
	payload: Record<string, unknown>;
	status: LeadWebhookEventStatus;
	attempts: number;
	max_attempts: number;
	next_attempt_at: Date;
	last_error: string | null;
	response_status: number | null;
	last_attempt_at: Date | null;
	delivered_at: Date | null;
	created_at: Date;
	updated_at: Date;
};

export type LeadWebhookConfigResponse = {
	id: string;
	webhookUrl: string;
	isActive: boolean;
	hasSigningSecret: boolean;
	createdAt: Date;
	updatedAt: Date;
};

export type LeadWebhookEventResponse = {
	id: string;
	leadId: string | null;
	eventType: string;
	status: LeadWebhookEventStatus;
	attempts: number;
	maxAttempts: number;
	nextAttemptAt: Date;
	lastError: string | null;
	responseStatus: number | null;
	lastAttemptAt: Date | null;
	deliveredAt: Date | null;
	createdAt: Date;
};

class LeadWebhookService {
	private normalizeWebhookUrl(url: string): string {
		const normalized = url.trim();
		if (!normalized) {
			throw new Error("webhookUrl is required");
		}
		const parsed = new URL(normalized);
		if (
			parsed.protocol !== "https:" &&
			parsed.protocol !== "http:"
		) {
			throw new Error("webhookUrl must be http or https");
		}
		return parsed.toString();
	}

	private async assertSafeWebhookUrl(
		url: string,
	): Promise<string> {
		const parsed = await assertSafeOutgoingUrl(url, {
			allowHttp:
				appConfig.NODE_ENV !==
				"production",
		});
		return parsed.toString();
	}

	private mapConfigRow(
		row: LeadWebhookConfigRow,
	): LeadWebhookConfigResponse {
		return {
			id: row.id,
			webhookUrl: row.webhook_url,
			isActive: row.is_active,
			hasSigningSecret: Boolean(row.signing_secret),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private mapEventRow(
		row: LeadWebhookEventRow,
	): LeadWebhookEventResponse {
		return {
			id: row.id,
			leadId: row.lead_id,
			eventType: row.event_type,
			status: row.status,
			attempts: row.attempts,
			maxAttempts: row.max_attempts,
			nextAttemptAt: row.next_attempt_at,
			lastError: row.last_error,
			responseStatus: row.response_status,
			lastAttemptAt: row.last_attempt_at,
			deliveredAt: row.delivered_at,
			createdAt: row.created_at,
		};
	}

	private createSigningSecret(): string {
		return crypto
			.randomBytes(32)
			.toString("hex");
	}

	private backoffDelayMs(attempt: number): number {
		const delay =
			WEBHOOK_BACKOFF_BASE_MS *
			Math.pow(2, Math.max(0, attempt - 1));
		return Math.min(delay, WEBHOOK_BACKOFF_MAX_MS);
	}

	private buildSignature(
		secret: string,
		timestamp: string,
		body: string,
	): string {
		const signedPayload = `${timestamp}.${body}`;
		return crypto
			.createHmac("sha256", secret)
			.update(signedPayload)
			.digest("hex");
	}

	private async getUserPlanType(
		userId: string,
	): Promise<PlanType | null> {
		const result = await pool.query<{
			plan_type: PlanType;
		}>(
			`SELECT plan_type FROM users WHERE id = $1 LIMIT 1`,
			[userId],
		);
		return result.rows[0]?.plan_type ?? null;
	}

	private async ensureCrmAccess(
		userId: string,
	): Promise<void> {
		const planType = await this.getUserPlanType(
			userId,
		);
		const capabilities =
			getPlanCapabilities(planType);
		if (!capabilities.crmIntegration) {
			throw new Error(
				"This feature is available on the Basic, Standard, and Enterprise plans",
			);
		}
	}

	async getConfig(
		userId: string,
	): Promise<LeadWebhookConfigResponse | null> {
		await this.ensureCrmAccess(userId);
		const result = await pool.query<LeadWebhookConfigRow>(
			`SELECT *
			 FROM lead_webhook_configs
			 WHERE user_id = $1
			 LIMIT 1`,
			[userId],
		);
		const row = result.rows[0];
		return row ? this.mapConfigRow(row) : null;
	}

	async upsertConfig(
		userId: string,
		payload: {
			webhookUrl?: string;
			isActive?: boolean;
			rotateSecret?: boolean;
		},
	): Promise<LeadWebhookConfigResponse> {
		await this.ensureCrmAccess(userId);
		const existing = await pool.query<LeadWebhookConfigRow>(
			`SELECT *
			 FROM lead_webhook_configs
			 WHERE user_id = $1
			 LIMIT 1`,
			[userId],
		);

		const current = existing.rows[0];
		const shouldActivate =
			payload.isActive ??
			current?.is_active ??
			true;
		const webhookUrl = payload.webhookUrl
			? await this.assertSafeWebhookUrl(
					this.normalizeWebhookUrl(
						payload.webhookUrl,
					),
				)
			: current?.webhook_url;
		if (!current && !webhookUrl) {
			throw new Error("webhookUrl is required");
		}
		if (shouldActivate && !webhookUrl) {
			throw new Error(
				"webhookUrl is required when enabling webhook",
			);
		}

		const signingSecret =
			current &&
			!payload.rotateSecret
				? current.signing_secret
				: this.createSigningSecret();

		let row: LeadWebhookConfigRow;
		if (current) {
			const result = await pool.query<LeadWebhookConfigRow>(
				`UPDATE lead_webhook_configs
				 SET webhook_url = $2,
					 is_active = $3,
					 signing_secret = $4,
					 updated_at = CURRENT_TIMESTAMP
				 WHERE user_id = $1
				 RETURNING *`,
				[
					userId,
					webhookUrl ?? current.webhook_url,
					shouldActivate,
					signingSecret,
				],
			);
			row = result.rows[0];
		} else {
			const result = await pool.query<LeadWebhookConfigRow>(
				`INSERT INTO lead_webhook_configs
					(user_id, webhook_url, signing_secret, is_active)
				 VALUES ($1, $2, $3, $4)
				 RETURNING *`,
				[
					userId,
					webhookUrl!,
					signingSecret,
					shouldActivate,
				],
			);
			row = result.rows[0];
		}

		return this.mapConfigRow(row);
	}

	private async getActiveConfigRow(
		userId: string,
	): Promise<LeadWebhookConfigRow | null> {
		const result = await pool.query<LeadWebhookConfigRow>(
			`SELECT *
			 FROM lead_webhook_configs
			 WHERE user_id = $1 AND is_active = TRUE
			 LIMIT 1`,
			[userId],
		);
		return result.rows[0] ?? null;
	}

	async getEvents(
		userId: string,
		limit = 50,
	): Promise<LeadWebhookEventResponse[]> {
		await this.ensureCrmAccess(userId);
		const boundedLimit = Math.max(
			1,
			Math.min(100, limit),
		);
		const result = await pool.query<LeadWebhookEventRow>(
			`SELECT *
			 FROM lead_webhook_events
			 WHERE user_id = $1
			 ORDER BY created_at DESC
			 LIMIT $2`,
			[userId, boundedLimit],
		);
		return result.rows.map((row) =>
			this.mapEventRow(row),
		);
	}

	async queueLeadEvent(
		userId: string,
		eventType: string,
		payload: Record<string, unknown>,
		leadId?: string | null,
	): Promise<void> {
		const planType = await this.getUserPlanType(
			userId,
		);
		if (
			!getPlanCapabilities(planType).crmIntegration
		) {
			return;
		}

		const config = await this.getActiveConfigRow(
			userId,
		);
		if (!config) return;

		const result = await pool.query<{ id: string }>(
			`INSERT INTO lead_webhook_events
				(user_id, lead_id, config_id, event_type, payload, status, max_attempts)
			 VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6)
			 RETURNING id`,
			[
				userId,
				leadId ?? null,
				config.id,
				eventType,
				JSON.stringify(payload),
				WEBHOOK_MAX_ATTEMPTS,
			],
		);

		const eventId = result.rows[0]?.id;
		if (eventId) {
			void this.deliverEventById(eventId).catch(
				(error) => {
					logger.error(
						"Immediate webhook dispatch failed",
						{ error, eventId },
					);
				},
			);
		}
	}

	async sendTestEvent(
		userId: string,
	): Promise<void> {
		await this.ensureCrmAccess(userId);
		const activeConfig =
			await this.getActiveConfigRow(userId);
		if (!activeConfig) {
			throw new Error(
				"Active webhook config not found. Save and enable a webhook URL first.",
			);
		}
		await this.queueLeadEvent(
			userId,
			"lead.test",
			{
				eventType: "lead.test",
				message:
					"This is a test webhook event from Witzo",
				emittedAt: new Date().toISOString(),
			},
			null,
		);
	}

	async retryEvent(
		userId: string,
		eventId: string,
	): Promise<void> {
		await this.ensureCrmAccess(userId);
		const result = await pool.query<LeadWebhookEventRow>(
			`UPDATE lead_webhook_events
			 SET status = 'pending',
				 attempts = 0,
				 next_attempt_at = CURRENT_TIMESTAMP,
				 last_error = NULL,
				 response_status = NULL,
				 updated_at = CURRENT_TIMESTAMP
			 WHERE id = $1 AND user_id = $2
			 RETURNING *`,
			[eventId, userId],
		);
		if (!result.rows[0]) {
			throw new Error("Webhook event not found");
		}
		void this.deliverEventById(eventId).catch(
			(error) => {
				logger.error(
					"Webhook retry dispatch failed",
					{ error, eventId },
				);
			},
		);
	}

	private async markDeliverySuccess(
		eventId: string,
		responseStatus: number,
	): Promise<void> {
		await pool.query(
			`UPDATE lead_webhook_events
			 SET status = 'delivered',
				 delivered_at = CURRENT_TIMESTAMP,
				 response_status = $2,
				 last_error = NULL,
				 updated_at = CURRENT_TIMESTAMP
			 WHERE id = $1`,
			[eventId, responseStatus],
		);
	}

	private async markDeliveryFailure(
		event: LeadWebhookEventRow,
		errorMessage: string,
		responseStatus?: number,
	): Promise<void> {
		const exhausted =
			event.attempts >= event.max_attempts;
		const nextDelayMs = this.backoffDelayMs(
			event.attempts,
		);
		await pool.query(
			`UPDATE lead_webhook_events
			 SET status = $2,
				 last_error = $3,
				 response_status = $4,
				 next_attempt_at = CASE
					 WHEN $2 = 'dead' THEN next_attempt_at
					 ELSE CURRENT_TIMESTAMP + ($5 || ' milliseconds')::interval
				 END,
				 updated_at = CURRENT_TIMESTAMP
			 WHERE id = $1`,
			[
				event.id,
				exhausted ? "dead" : "retrying",
				errorMessage,
				responseStatus ?? null,
				nextDelayMs,
			],
		);
	}

	async deliverEventById(
		eventId: string,
	): Promise<void> {
		const claim =
			await pool.query<LeadWebhookEventRow>(
				`UPDATE lead_webhook_events
				 SET status = 'processing',
					 attempts = attempts + 1,
					 last_attempt_at = CURRENT_TIMESTAMP,
					 updated_at = CURRENT_TIMESTAMP
				 WHERE id = $1
				   AND status IN ('pending', 'retrying')
				   AND next_attempt_at <= CURRENT_TIMESTAMP
				 RETURNING *`,
				[eventId],
			);
		const claimedEvent = claim.rows[0];
		if (!claimedEvent) return;

		const configResult =
			await pool.query<LeadWebhookConfigRow>(
				`SELECT *
				 FROM lead_webhook_configs
				 WHERE id = $1 AND is_active = TRUE
				 LIMIT 1`,
				[claimedEvent.config_id],
			);
		const config = configResult.rows[0];
		if (!config) {
			await this.markDeliveryFailure(
				claimedEvent,
				"Active webhook config not found",
			);
			return;
		}

		const body = JSON.stringify({
			id: claimedEvent.id,
			type: claimedEvent.event_type,
			occurredAt:
				claimedEvent.created_at.toISOString(),
			payload: claimedEvent.payload,
		});
		const timestamp = Math.floor(
			Date.now() / 1000,
		).toString();
		const signature = this.buildSignature(
			config.signing_secret,
			timestamp,
			body,
		);
		const safeWebhookUrl =
			await this.assertSafeWebhookUrl(
				config.webhook_url,
			);

		try {
			const response = await axios.post(
				safeWebhookUrl,
				JSON.parse(body),
				{
					timeout: WEBHOOK_DELIVERY_TIMEOUT_MS,
					headers: {
						"Content-Type":
							"application/json",
						"X-Witzo-Event-Id":
							claimedEvent.id,
						"X-Witzo-Event-Type":
							claimedEvent.event_type,
						"X-Witzo-Timestamp":
							timestamp,
						"X-Witzo-Signature":
							`sha256=${signature}`,
					},
					validateStatus: () => true,
				},
			);

			if (
				response.status >= 200 &&
				response.status < 300
			) {
				await this.markDeliverySuccess(
					claimedEvent.id,
					response.status,
				);
				return;
			}

			await this.markDeliveryFailure(
				claimedEvent,
				`Webhook responded with status ${response.status}`,
				response.status,
			);
		} catch (error) {
			await this.markDeliveryFailure(
				claimedEvent,
				error instanceof Error
					? error.message
					: String(error),
			);
		}
	}

	async processPendingEvents(
		limit = WEBHOOK_PROCESS_BATCH_SIZE,
	): Promise<void> {
		const result = await pool.query<{ id: string }>(
			`SELECT id
			 FROM lead_webhook_events
			 WHERE status IN ('pending', 'retrying')
			   AND next_attempt_at <= CURRENT_TIMESTAMP
			 ORDER BY created_at ASC
			 LIMIT $1`,
			[Math.max(1, limit)],
		);

		for (const row of result.rows) {
			try {
				await this.deliverEventById(row.id);
			} catch (error) {
				logger.error(
					"Error processing pending webhook event",
					{
						error,
						eventId: row.id,
					},
				);
			}
		}
	}
}

export const leadWebhookService =
	new LeadWebhookService();
