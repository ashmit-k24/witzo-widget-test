import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import crypto from "crypto";
import {
	getPlanCapabilities,
	PlanType,
} from "../config/planConfig";
import { config } from "../config/env";
import pool from "../config/database";
import {
	HUBSPOT_DEFAULT_SCOPES,
	HUBSPOT_SYNC_BACKOFF_BASE_MS,
	HUBSPOT_SYNC_BACKOFF_MAX_MS,
	HUBSPOT_SYNC_DELIVERY_TIMEOUT_MS,
	HUBSPOT_SYNC_MAX_ATTEMPTS,
	HUBSPOT_SYNC_PROCESS_BATCH_SIZE,
} from "../constants";
import logger from "../utils/logger";

type HubspotSyncEventStatus =
	| "pending"
	| "processing"
	| "retrying"
	| "delivered"
	| "dead";

type HubspotIntegrationRow = {
	id: string;
	user_id: string;
	portal_id: string | null;
	hub_domain: string | null;
	access_token: string;
	refresh_token: string;
	scope: string | null;
	token_expires_at: Date;
	is_active: boolean;
	contact_sync_enabled: boolean;
	company_sync_enabled: boolean;
	note_sync_enabled: boolean;
	last_synced_at: Date | null;
	last_error: string | null;
	created_at: Date;
	updated_at: Date;
};

type HubspotSyncEventRow = {
	id: string;
	user_id: string;
	lead_id: string | null;
	integration_id: string;
	event_type: string;
	payload: Record<string, unknown>;
	status: HubspotSyncEventStatus;
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

type LeadSnapshot = {
	id: string;
	session_id: string;
	widget_key_id: number | null;
	name: string | null;
	email: string | null;
	phone: string | null;
	country: string | null;
	company: string | null;
	chat_summary: string | null;
	status: string | null;
	source_url: string | null;
	message_count: number | null;
	follow_up_sent_at: Date | null;
	created_at: Date;
	updated_at: Date;
};

type HubspotOauthTokenResponse = {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
	scope?: string;
};

type HubspotAccessTokenInfoResponse = {
	hub_id?: number;
	hub_domain?: string;
	scopes?: string[];
	user?: string;
};

type HubspotContactUpsertResult = {
	id: string;
};

type HubspotCompanyUpsertResult = {
	id: string;
};

type HubspotNoteCreateResult = {
	id: string;
};

type HubspotPropertyDefinition = {
	name: string;
	label: string;
	description: string;
	type: "string" | "number";
	fieldType: "text" | "textarea" | "number";
};

type ParsedStatePayload = {
	userId: string;
	returnTo: string;
	exp: number;
	nonce: string;
};

type LeadContext = {
	leadId: string | null;
	sessionId: string | null;
	widgetKeyId: number | null;
	name: string | null;
	email: string | null;
	phone: string | null;
	country: string | null;
	company: string | null;
	chatSummary: string | null;
	status: string | null;
	sourceUrl: string | null;
	messageCount: number | null;
	followUpSentAt: Date | null;
	createdAt: Date | null;
	updatedAt: Date | null;
};

export type HubspotIntegrationConfigResponse = {
	connected: boolean;
	isActive: boolean;
	portalId: string | null;
	hubDomain: string | null;
	scope: string | null;
	contactSyncEnabled: boolean;
	companySyncEnabled: boolean;
	noteSyncEnabled: boolean;
	lastSyncedAt: Date | null;
	lastError: string | null;
	createdAt: Date | null;
	updatedAt: Date | null;
};

export type HubspotSyncEventResponse = {
	id: string;
	leadId: string | null;
	eventType: string;
	status: HubspotSyncEventStatus;
	attempts: number;
	maxAttempts: number;
	nextAttemptAt: Date;
	lastError: string | null;
	responseStatus: number | null;
	lastAttemptAt: Date | null;
	deliveredAt: Date | null;
	createdAt: Date;
};

const HUBSPOT_API_BASE_URL = "https://api.hubapi.com";
const HUBSPOT_OAUTH_AUTHORIZE_URL =
	"https://app.hubspot.com/oauth/authorize";
const HUBSPOT_OAUTH_TOKEN_URL =
	"https://api.hubapi.com/oauth/v1/token";
const HUBSPOT_ACCESS_TOKEN_INFO_URL =
	"https://api.hubapi.com/oauth/v1/access-tokens";
const HUBSPOT_STATE_TTL_MS = 10 * 60 * 1000;
const HUBSPOT_DEFAULT_RETURN_TO = "/dashboard/hubspot";

const WITZO_CONTACT_PROPERTIES: HubspotPropertyDefinition[] =
	[
		{
			name: "witzo_lead_id",
			label: "Witzo Lead ID",
			description:
				"Unique lead id from Witzo.",
			type: "string",
			fieldType: "text",
		},
		{
			name: "witzo_session_id",
			label: "Witzo Session ID",
			description:
				"Visitor conversation session id from Witzo.",
			type: "string",
			fieldType: "text",
		},
		{
			name: "witzo_widget_key_id",
			label: "Witzo Widget Key ID",
			description:
				"Widget key identifier that captured the lead.",
			type: "number",
			fieldType: "number",
		},
		{
			name: "witzo_source_url",
			label: "Witzo Source URL",
			description:
				"Source URL where the lead originated.",
			type: "string",
			fieldType: "text",
		},
		{
			name: "witzo_lead_status",
			label: "Witzo Lead Status",
			description:
				"Lead status from Witzo pipeline.",
			type: "string",
			fieldType: "text",
		},
		{
			name: "witzo_message_count",
			label: "Witzo Message Count",
			description:
				"Message count observed before lead capture.",
			type: "number",
			fieldType: "number",
		},
		{
			name: "witzo_last_chat_summary",
			label: "Witzo Last Chat Summary",
			description:
				"Latest AI-generated lead summary from chat.",
			type: "string",
			fieldType: "textarea",
		},
		{
			name: "witzo_follow_up_sent_at",
			label: "Witzo Follow-up Sent At",
			description:
				"When Witzo follow-up email was sent.",
			type: "string",
			fieldType: "text",
		},
		{
			name: "witzo_first_seen_at",
			label: "Witzo First Seen At",
			description:
				"First time this lead was recorded in Witzo.",
			type: "string",
			fieldType: "text",
		},
		{
			name: "witzo_last_seen_at",
			label: "Witzo Last Seen At",
			description:
				"Most recent update time for this lead in Witzo.",
			type: "string",
			fieldType: "text",
		},
	];

class HubspotIntegrationService {
	private readonly ensuredPortalKeys = new Set<string>();

	private hasGrantedScope(
		scopeList: string | null | undefined,
		targetScope: string,
	): boolean {
		if (!scopeList) return false;
		return scopeList
			.split(/[\s,]+/)
			.map((scope) => scope.trim())
			.filter(Boolean)
			.includes(targetScope);
	}

	private normalizeScopes(rawScopes: string): string {
		const parsed = rawScopes
			.split(/[\s,]+/)
			.map((scope) => scope.trim())
			.filter(Boolean);
		if (parsed.length === 0) {
			return [...HUBSPOT_DEFAULT_SCOPES].join(" ");
		}
		return Array.from(new Set(parsed)).join(" ");
	}

	private ensureHubspotOAuthConfigured(): void {
		if (
			!config.HUBSPOT_CLIENT_ID ||
			!config.HUBSPOT_CLIENT_SECRET ||
			!config.HUBSPOT_REDIRECT_URI
		) {
			throw new Error(
				"HubSpot integration is not configured. Please set HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, and HUBSPOT_REDIRECT_URI.",
			);
		}
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

	private safeTimingEqual(
		left: string,
		right: string,
	): boolean {
		const leftBuffer = Buffer.from(left, "utf8");
		const rightBuffer = Buffer.from(
			right,
			"utf8",
		);
		if (leftBuffer.length !== rightBuffer.length) {
			return false;
		}
		return crypto.timingSafeEqual(
			leftBuffer,
			rightBuffer,
		);
	}

	private sanitizeReturnPath(
		value?: string,
	): string {
		if (!value) return HUBSPOT_DEFAULT_RETURN_TO;
		const normalized = value.trim();
		if (
			normalized.length === 0 ||
			normalized.length > 256
		) {
			return HUBSPOT_DEFAULT_RETURN_TO;
		}
		if (
			!normalized.startsWith("/") ||
			normalized.startsWith("//")
		) {
			return HUBSPOT_DEFAULT_RETURN_TO;
		}
		if (!normalized.startsWith("/dashboard")) {
			return HUBSPOT_DEFAULT_RETURN_TO;
		}
		return normalized;
	}

	private createOauthState(
		userId: string,
		returnTo?: string,
	): string {
		const payload: ParsedStatePayload = {
			userId,
			returnTo: this.sanitizeReturnPath(returnTo),
			exp: Date.now() + HUBSPOT_STATE_TTL_MS,
			nonce: crypto
				.randomBytes(12)
				.toString("hex"),
		};
		const encodedPayload = Buffer.from(
			JSON.stringify(payload),
			"utf8",
		).toString("base64url");
		const signature = crypto
			.createHmac("sha256", config.JWT_SECRET)
			.update(encodedPayload)
			.digest("base64url");
		return `${encodedPayload}.${signature}`;
	}

	private parseOauthState(
		state: string,
	): ParsedStatePayload {
		const [encodedPayload, signature] =
			state.split(".");
		if (!encodedPayload || !signature) {
			throw new Error(
				"Invalid HubSpot OAuth state payload",
			);
		}

		const expectedSignature = crypto
			.createHmac("sha256", config.JWT_SECRET)
			.update(encodedPayload)
			.digest("base64url");

		if (
			!this.safeTimingEqual(
				signature,
				expectedSignature,
			)
		) {
			throw new Error(
				"Invalid HubSpot OAuth state signature",
			);
		}

		let payload: ParsedStatePayload;
		try {
			payload = JSON.parse(
				Buffer.from(
					encodedPayload,
					"base64url",
				).toString("utf8"),
			) as ParsedStatePayload;
		} catch {
			throw new Error(
				"Invalid HubSpot OAuth state encoding",
			);
		}

		if (
			!payload.userId ||
			!payload.nonce ||
			typeof payload.exp !== "number"
		) {
			throw new Error(
				"Invalid HubSpot OAuth state fields",
			);
		}
		if (payload.exp < Date.now()) {
			throw new Error(
				"HubSpot OAuth state has expired. Please reconnect.",
			);
		}

		return {
			userId: payload.userId,
			returnTo: this.sanitizeReturnPath(
				payload.returnTo,
			),
			exp: payload.exp,
			nonce: payload.nonce,
		};
	}

	private buildHubspotAuthUrl(
		state: string,
	): string {
		const scopes = this.normalizeScopes(
			config.HUBSPOT_OAUTH_SCOPES,
		);
		const params = new URLSearchParams({
			client_id: config.HUBSPOT_CLIENT_ID,
			redirect_uri: config.HUBSPOT_REDIRECT_URI,
			scope: scopes,
			state,
		});
		return `${HUBSPOT_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
	}

	private mapIntegration(
		row: HubspotIntegrationRow | null,
	): HubspotIntegrationConfigResponse {
		if (!row) {
			return {
				connected: false,
				isActive: false,
				portalId: null,
				hubDomain: null,
				scope: null,
				contactSyncEnabled: true,
				companySyncEnabled: true,
				noteSyncEnabled: true,
				lastSyncedAt: null,
				lastError: null,
				createdAt: null,
				updatedAt: null,
			};
		}

		return {
			connected: true,
			isActive: row.is_active,
			portalId: row.portal_id,
			hubDomain: row.hub_domain,
			scope: row.scope,
			contactSyncEnabled:
				row.contact_sync_enabled,
			companySyncEnabled:
				row.company_sync_enabled,
			noteSyncEnabled: row.note_sync_enabled,
			lastSyncedAt: row.last_synced_at,
			lastError: row.last_error,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private mapEvent(
		row: HubspotSyncEventRow,
	): HubspotSyncEventResponse {
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

	private backoffDelayMs(attempt: number): number {
		const delay =
			HUBSPOT_SYNC_BACKOFF_BASE_MS *
			Math.pow(2, Math.max(0, attempt - 1));
		return Math.min(delay, HUBSPOT_SYNC_BACKOFF_MAX_MS);
	}

	private async getIntegrationRowByUser(
		userId: string,
	): Promise<HubspotIntegrationRow | null> {
		const result = await pool.query<HubspotIntegrationRow>(
			`SELECT *
       FROM hubspot_integrations
       WHERE user_id = $1
       LIMIT 1`,
			[userId],
		);
		return result.rows[0] ?? null;
	}

	private async getActiveIntegrationByUser(
		userId: string,
	): Promise<HubspotIntegrationRow | null> {
		const result = await pool.query<HubspotIntegrationRow>(
			`SELECT *
       FROM hubspot_integrations
       WHERE user_id = $1
         AND is_active = TRUE
       LIMIT 1`,
			[userId],
		);
		return result.rows[0] ?? null;
	}

	private async getIntegrationById(
		id: string,
	): Promise<HubspotIntegrationRow | null> {
		const result = await pool.query<HubspotIntegrationRow>(
			`SELECT *
       FROM hubspot_integrations
       WHERE id = $1
       LIMIT 1`,
			[id],
		);
		return result.rows[0] ?? null;
	}

	private async exchangeAuthorizationCode(
		code: string,
	): Promise<HubspotOauthTokenResponse> {
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: config.HUBSPOT_CLIENT_ID,
			client_secret: config.HUBSPOT_CLIENT_SECRET,
			redirect_uri: config.HUBSPOT_REDIRECT_URI,
			code,
		});

		const response = await axios.post<HubspotOauthTokenResponse>(
			HUBSPOT_OAUTH_TOKEN_URL,
			body.toString(),
			{
				headers: {
					"Content-Type":
						"application/x-www-form-urlencoded",
				},
				timeout: HUBSPOT_SYNC_DELIVERY_TIMEOUT_MS,
			},
		);

		return response.data;
	}

	private async refreshAccessToken(
		integration: HubspotIntegrationRow,
	): Promise<HubspotIntegrationRow> {
		const body = new URLSearchParams({
			grant_type: "refresh_token",
			client_id: config.HUBSPOT_CLIENT_ID,
			client_secret: config.HUBSPOT_CLIENT_SECRET,
			refresh_token: integration.refresh_token,
		});

		const response = await axios.post<HubspotOauthTokenResponse>(
			HUBSPOT_OAUTH_TOKEN_URL,
			body.toString(),
			{
				headers: {
					"Content-Type":
						"application/x-www-form-urlencoded",
				},
				timeout: HUBSPOT_SYNC_DELIVERY_TIMEOUT_MS,
			},
		);

		const tokenData = response.data;
		const nextExpiresAt = new Date(
			Date.now() +
				Math.max(30, tokenData.expires_in - 60) *
					1000,
		);

		const updateResult =
			await pool.query<HubspotIntegrationRow>(
				`UPDATE hubspot_integrations
         SET access_token = $2,
             refresh_token = COALESCE($3, refresh_token),
             token_expires_at = $4,
             scope = COALESCE($5, scope),
             last_error = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
				[
					integration.id,
					tokenData.access_token,
					tokenData.refresh_token || null,
					nextExpiresAt,
					tokenData.scope || null,
				],
			);

		const refreshed = updateResult.rows[0];
		if (!refreshed) {
			throw new Error(
				"Failed to refresh HubSpot integration token",
			);
		}

		return refreshed;
	}

	private async ensureFreshAccessToken(
		integration: HubspotIntegrationRow,
	): Promise<HubspotIntegrationRow> {
		const threshold = new Date(
			Date.now() + 60 * 1000,
		);
		if (integration.token_expires_at > threshold) {
			return integration;
		}

		return this.refreshAccessToken(integration);
	}

	private async requestHubspot<T>(
		integration: HubspotIntegrationRow,
		requestConfig: AxiosRequestConfig,
		retryOnUnauthorized = true,
	): Promise<AxiosResponse<T>> {
		const response = await axios.request<T>({
			...requestConfig,
			baseURL: HUBSPOT_API_BASE_URL,
			timeout: HUBSPOT_SYNC_DELIVERY_TIMEOUT_MS,
			headers: {
				Authorization: `Bearer ${integration.access_token}`,
				"Content-Type": "application/json",
				...(requestConfig.headers ?? {}),
			},
			validateStatus: () => true,
		});

		if (response.status === 401 && retryOnUnauthorized) {
			const refreshed =
				await this.refreshAccessToken(
					integration,
				);
			integration.access_token =
				refreshed.access_token;
			integration.refresh_token =
				refreshed.refresh_token;
			integration.token_expires_at =
				refreshed.token_expires_at;
			integration.scope = refreshed.scope;
			return this.requestHubspot<T>(
				integration,
				requestConfig,
				false,
			);
		}

		if (response.status >= 400) {
			const data =
				typeof response.data === "object" &&
				response.data !== null
					? JSON.stringify(response.data)
					: String(response.data ?? "");
			throw new Error(
				`HubSpot API ${requestConfig.method ?? "GET"} ${requestConfig.url} failed with ${response.status}: ${data}`,
			);
		}

		return response;
	}

	private async loadLeadSnapshot(
		userId: string,
		leadId: string,
	): Promise<LeadSnapshot | null> {
		const result = await pool.query<LeadSnapshot>(
			`SELECT
         id,
         session_id,
         widget_key_id,
         name,
         email,
         phone,
         country,
         company,
         chat_summary,
         status,
         source_url,
         message_count,
         follow_up_sent_at,
         created_at,
         updated_at
       FROM leads
       WHERE id = $1
         AND user_id = $2
       LIMIT 1`,
			[leadId, userId],
		);
		return result.rows[0] ?? null;
	}

	private toNullableString(
		value: unknown,
	): string | null {
		if (typeof value !== "string") {
			return null;
		}
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	private toNullableNumber(
		value: unknown,
	): number | null {
		if (
			typeof value === "number" &&
			Number.isFinite(value)
		) {
			return value;
		}
		if (typeof value === "string") {
			const parsed = Number(value);
			return Number.isFinite(parsed)
				? parsed
				: null;
		}
		return null;
	}

	private buildLeadContext(
		event: HubspotSyncEventRow,
		leadSnapshot: LeadSnapshot | null,
	): LeadContext {
		const payload = event.payload ?? {};
		const contactRaw =
			typeof payload.contact === "object" &&
			payload.contact !== null
				? (payload.contact as Record<
						string,
						unknown
					>)
				: {};
		const metadataRaw =
			typeof payload.metadata === "object" &&
			payload.metadata !== null
				? (payload.metadata as Record<
						string,
						unknown
					>)
				: {};

		return {
			leadId: leadSnapshot?.id ?? event.lead_id,
			sessionId:
				leadSnapshot?.session_id ??
				this.toNullableString(
					payload.sessionId,
				),
			widgetKeyId:
				leadSnapshot?.widget_key_id ??
				this.toNullableNumber(
					payload.widgetKeyId,
				),
			name:
				leadSnapshot?.name ??
				this.toNullableString(contactRaw.name),
			email:
				leadSnapshot?.email ??
				this.toNullableString(contactRaw.email),
			phone:
				leadSnapshot?.phone ??
				this.toNullableString(contactRaw.phone),
			country:
				leadSnapshot?.country ??
				this.toNullableString(
					contactRaw.country,
				),
			company:
				leadSnapshot?.company ??
				this.toNullableString(
					contactRaw.company,
				),
			chatSummary:
				leadSnapshot?.chat_summary ??
				this.toNullableString(
					contactRaw.summary,
				),
			status:
				leadSnapshot?.status ??
				this.toNullableString(payload.status),
			sourceUrl:
				leadSnapshot?.source_url ??
				this.toNullableString(
					metadataRaw.sourceUrl,
				),
			messageCount:
				leadSnapshot?.message_count ??
				this.toNullableNumber(
					payload.messageCount,
				),
			followUpSentAt:
				leadSnapshot?.follow_up_sent_at ??
				null,
			createdAt:
				leadSnapshot?.created_at ?? null,
			updatedAt:
				leadSnapshot?.updated_at ?? null,
		};
	}

	private splitName(name: string): {
		firstname: string;
		lastname?: string;
	} {
		const trimmed = name.trim();
		const parts = trimmed.split(/\s+/);
		if (parts.length <= 1) {
			return { firstname: trimmed };
		}
		return {
			firstname: parts[0],
			lastname: parts.slice(1).join(" "),
		};
	}

	private buildContactProperties(
		lead: LeadContext,
		includeCustomProperties: boolean,
	): Record<string, string | number> {
		const properties: Record<
			string,
			string | number | null
		> = {};

		if (lead.email) {
			properties.email = lead.email;
		}
		if (lead.phone) {
			properties.phone = lead.phone;
		}
		if (lead.country) {
			properties.country = lead.country;
		}
		if (lead.company) {
			properties.company = lead.company;
		}
		if (lead.name) {
			const split = this.splitName(lead.name);
			properties.firstname = split.firstname;
			if (split.lastname) {
				properties.lastname = split.lastname;
			}
		}

		if (includeCustomProperties) {
			if (lead.leadId) {
				properties.witzo_lead_id = lead.leadId;
			}
			if (lead.sessionId) {
				properties.witzo_session_id =
					lead.sessionId;
			}
			if (lead.widgetKeyId !== null) {
				properties.witzo_widget_key_id =
					lead.widgetKeyId;
			}
			if (lead.sourceUrl) {
				properties.witzo_source_url =
					lead.sourceUrl;
			}
			if (lead.status) {
				properties.witzo_lead_status =
					lead.status;
			}
			if (lead.messageCount !== null) {
				properties.witzo_message_count =
					lead.messageCount;
			}
			if (lead.chatSummary) {
				properties.witzo_last_chat_summary =
					lead.chatSummary.slice(0, 65000);
			}
			if (lead.followUpSentAt) {
				properties.witzo_follow_up_sent_at =
					lead.followUpSentAt.toISOString();
			}
			if (lead.createdAt) {
				properties.witzo_first_seen_at =
					lead.createdAt.toISOString();
			}
			if (lead.updatedAt) {
				properties.witzo_last_seen_at =
					lead.updatedAt.toISOString();
			}
		}

		const normalized: Record<
			string,
			string | number
		> = {};
		for (const [key, value] of Object.entries(
			properties,
		)) {
			if (
				value !== null &&
				value !== undefined &&
				value !== ""
			) {
				normalized[key] = value;
			}
		}
		return normalized;
	}

	private extractDomainFromUrl(
		value?: string | null,
	): string | null {
		if (!value) return null;
		try {
			const parsed = new URL(value);
			const host =
				parsed.hostname.trim().toLowerCase();
			if (!host) return null;
			const normalizedHost =
				host.startsWith("www.")
					? host.slice(4)
					: host;
			if (
				normalizedHost === "localhost" ||
				normalizedHost.endsWith(".localhost") ||
				/^\d{1,3}(\.\d{1,3}){3}$/.test(
					normalizedHost,
				) ||
				!normalizedHost.includes(".")
			) {
				return null;
			}
			return normalizedHost;
		} catch {
			return null;
		}
	}

	private extractDomainFromEmail(
		email?: string | null,
	): string | null {
		if (!email) return null;
		const parts = email.split("@");
		if (parts.length !== 2) return null;
		const domain = parts[1].trim().toLowerCase();
		if (
			domain.length === 0 ||
			domain === "localhost" ||
			domain.endsWith(".localhost") ||
			/^\d{1,3}(\.\d{1,3}){3}$/.test(domain) ||
			!domain.includes(".")
		) {
			return null;
		}
		return domain;
	}

	private async ensureContactProperties(
		integration: HubspotIntegrationRow,
	): Promise<boolean> {
		const key =
			integration.portal_id ??
			integration.user_id;
		if (this.ensuredPortalKeys.has(key)) {
			return true;
		}

		for (const property of WITZO_CONTACT_PROPERTIES) {
			try {
				await this.requestHubspot(
					integration,
					{
						method: "GET",
						url: `/crm/v3/properties/contacts/${property.name}`,
					},
				);
				continue;
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: String(error);
				if (
					!message.includes("failed with 404")
				) {
					logger.warn(
						"HubSpot property pre-check failed",
						{
							userId:
								integration.user_id,
							property:
								property.name,
							error: message,
						},
					);
					return false;
				}
			}

			try {
				await this.requestHubspot(
					integration,
					{
						method: "POST",
						url: "/crm/v3/properties/contacts",
						data: {
							name: property.name,
							label: property.label,
							description:
								property.description,
							type: property.type,
							fieldType:
								property.fieldType,
							groupName:
								"contactinformation",
						},
					},
				);
			} catch (error) {
				logger.warn(
					"HubSpot property creation failed; proceeding without custom properties",
					{
						userId: integration.user_id,
						property: property.name,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
				return false;
			}
		}

		this.ensuredPortalKeys.add(key);
		return true;
	}

	private async upsertContact(
		integration: HubspotIntegrationRow,
		properties: Record<string, string | number>,
	): Promise<string | null> {
		const email =
			typeof properties.email === "string"
				? properties.email
				: null;
		if (!email && !properties.phone) {
			return null;
		}

		if (email) {
			try {
				const updateResponse =
					await this.requestHubspot<HubspotContactUpsertResult>(
						integration,
						{
							method: "PATCH",
							url: `/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email`,
							data: { properties },
						},
					);
				return (
					updateResponse.data?.id ??
					null
				);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: String(error);
				if (
					!message.includes("failed with 404")
				) {
					throw error;
				}
			}
		}

		const createResponse =
			await this.requestHubspot<HubspotContactUpsertResult>(
				integration,
				{
					method: "POST",
					url: "/crm/v3/objects/contacts",
					data: { properties },
				},
			);
		return createResponse.data?.id ?? null;
	}

	private async upsertCompany(
		integration: HubspotIntegrationRow,
		lead: LeadContext,
	): Promise<string | null> {
		const domain =
			this.extractDomainFromUrl(
				lead.sourceUrl,
			) ??
			this.extractDomainFromEmail(lead.email);
		if (!domain) return null;

		const companyProperties: Record<
			string,
			string
		> = { domain };
		if (lead.company) {
			companyProperties.name = lead.company;
		}

		try {
			const updateResponse =
				await this.requestHubspot<HubspotCompanyUpsertResult>(
					integration,
					{
						method: "PATCH",
						url: `/crm/v3/objects/companies/${encodeURIComponent(domain)}?idProperty=domain`,
						data: {
							properties:
								companyProperties,
						},
					},
				);
			return (
				updateResponse.data?.id ?? null
			);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: String(error);
			if (!message.includes("failed with 404")) {
				throw error;
			}
		}

		const createResponse =
			await this.requestHubspot<HubspotCompanyUpsertResult>(
				integration,
				{
					method: "POST",
					url: "/crm/v3/objects/companies",
					data: {
						properties:
							companyProperties,
					},
				},
			);
		return createResponse.data?.id ?? null;
	}

	private async associateContactToCompany(
		integration: HubspotIntegrationRow,
		contactId: string,
		companyId: string,
	): Promise<void> {
		try {
			await this.requestHubspot(integration, {
				method: "PUT",
				url: `/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`,
			});
		} catch (error) {
			logger.warn(
				"HubSpot contact-company association failed",
				{
					userId: integration.user_id,
					contactId,
					companyId,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
		}
	}

	private buildNoteBody(
		lead: LeadContext,
		eventType: string,
	): string {
		const lines = [
			`Witzo Event: ${eventType}`,
			lead.status
				? `Lead Status: ${lead.status}`
				: null,
			lead.sourceUrl
				? `Source URL: ${lead.sourceUrl}`
				: null,
			lead.sessionId
				? `Session ID: ${lead.sessionId}`
				: null,
			lead.messageCount !== null
				? `Message Count: ${lead.messageCount}`
				: null,
			"",
			"Summary:",
			lead.chatSummary ??
				"No summary provided.",
		].filter(
			(value): value is string =>
				value !== null,
		);
		return lines.join("\n").slice(0, 65000);
	}

	private async createNote(
		integration: HubspotIntegrationRow,
		lead: LeadContext,
		eventType: string,
		contactId: string | null,
		companyId: string | null,
	): Promise<void> {
		const noteBody = this.buildNoteBody(
			lead,
			eventType,
		);
		const noteResponse =
			await this.requestHubspot<HubspotNoteCreateResult>(
				integration,
				{
					method: "POST",
					url: "/crm/v3/objects/notes",
					data: {
						properties: {
							hs_note_body: noteBody,
							hs_timestamp: `${Date.now()}`,
						},
					},
				},
			);
		const noteId =
			noteResponse.data?.id ?? null;
		if (!noteId) return;

		if (contactId) {
			try {
				await this.requestHubspot(
					integration,
					{
						method: "PUT",
						url: `/crm/v4/objects/notes/${noteId}/associations/default/contacts/${contactId}`,
					},
				);
			} catch (error) {
				logger.warn(
					"HubSpot note-contact association failed",
					{
						userId:
							integration.user_id,
						noteId,
						contactId,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}
		}

		if (companyId) {
			try {
				await this.requestHubspot(
					integration,
					{
						method: "PUT",
						url: `/crm/v4/objects/notes/${noteId}/associations/default/companies/${companyId}`,
					},
				);
			} catch (error) {
				logger.warn(
					"HubSpot note-company association failed",
					{
						userId:
							integration.user_id,
						noteId,
						companyId,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}
		}
	}

	private async syncLeadEventToHubspot(
		event: HubspotSyncEventRow,
		integration: HubspotIntegrationRow,
	): Promise<void> {
		if (event.event_type === "lead.test") {
			return;
		}
		if (
			!integration.contact_sync_enabled &&
			!integration.company_sync_enabled &&
			!integration.note_sync_enabled
		) {
			return;
		}

		const leadSnapshot = event.lead_id
			? await this.loadLeadSnapshot(
					event.user_id,
					event.lead_id,
				)
			: null;
		const leadContext = this.buildLeadContext(
			event,
			leadSnapshot,
		);

		integration =
			await this.ensureFreshAccessToken(
				integration,
			);

		let includeCustomProperties = false;
		if (
			integration.contact_sync_enabled &&
			this.hasGrantedScope(
				integration.scope,
				"crm.schemas.contacts.write",
			)
		) {
			includeCustomProperties =
				await this.ensureContactProperties(
					integration,
				);
		}

		let contactId: string | null = null;
		let companyId: string | null = null;

		if (integration.contact_sync_enabled) {
			const contactProperties =
				this.buildContactProperties(
					leadContext,
					includeCustomProperties,
				);
			contactId = await this.upsertContact(
				integration,
				contactProperties,
			);
		}

		if (
			integration.company_sync_enabled &&
			contactId
		) {
			companyId = await this.upsertCompany(
				integration,
				leadContext,
			);
			if (companyId) {
				await this.associateContactToCompany(
					integration,
					contactId,
					companyId,
				);
			}
		}

		if (integration.note_sync_enabled) {
			await this.createNote(
				integration,
				leadContext,
				event.event_type,
				contactId,
				companyId,
			);
		}
	}

	private async markDeliverySuccess(
		eventId: string,
	): Promise<void> {
		await pool.query(
			`UPDATE hubspot_sync_events
       SET status = 'delivered',
           delivered_at = CURRENT_TIMESTAMP,
           response_status = 200,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
			[eventId],
		);
	}

	private async markDeliveryFailure(
		event: HubspotSyncEventRow,
		errorMessage: string,
	): Promise<void> {
		const exhausted =
			event.attempts >= event.max_attempts;
		const nextDelayMs = this.backoffDelayMs(
			event.attempts,
		);

		await pool.query(
			`UPDATE hubspot_sync_events
       SET status = $2::varchar(20),
           last_error = $3::text,
           response_status = 500,
           next_attempt_at = CASE
             WHEN $2::varchar(20) = 'dead' THEN next_attempt_at
             ELSE CURRENT_TIMESTAMP + ($4::text || ' milliseconds')::interval
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
			[
				event.id,
				exhausted ? "dead" : "retrying",
				errorMessage,
				nextDelayMs,
			],
		);

		await pool.query(
			`UPDATE hubspot_integrations
       SET last_error = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
			[event.integration_id, errorMessage],
		);
	}

	async getConfig(
		userId: string,
	): Promise<HubspotIntegrationConfigResponse> {
		await this.ensureCrmAccess(userId);
		const row = await this.getIntegrationRowByUser(
			userId,
		);
		return this.mapIntegration(row);
	}

	async getConnectUrl(
		userId: string,
		returnTo?: string,
	): Promise<{ authUrl: string }> {
		await this.ensureCrmAccess(userId);
		this.ensureHubspotOAuthConfigured();
		const state = this.createOauthState(
			userId,
			returnTo,
		);
		return {
			authUrl: this.buildHubspotAuthUrl(state),
		};
	}

	async handleOauthCallback(input: {
		code: string;
		state: string;
	}): Promise<{ redirectTo: string }> {
		this.ensureHubspotOAuthConfigured();
		const parsedState = this.parseOauthState(
			input.state,
		);

		const tokenData =
			await this.exchangeAuthorizationCode(
				input.code,
			);
		if (
			!tokenData.access_token ||
			!tokenData.refresh_token
		) {
			throw new Error(
				"HubSpot token exchange failed",
			);
		}

		const tokenInfoResponse = await axios.get<HubspotAccessTokenInfoResponse>(
			`${HUBSPOT_ACCESS_TOKEN_INFO_URL}/${encodeURIComponent(tokenData.access_token)}`,
			{
				timeout: HUBSPOT_SYNC_DELIVERY_TIMEOUT_MS,
			},
		);
		const tokenInfo =
			tokenInfoResponse.data ?? {};
		const scopeFromTokenInfo = Array.isArray(
			tokenInfo.scopes,
		)
			? tokenInfo.scopes.join(" ")
			: null;

		const tokenExpiresAt = new Date(
			Date.now() +
				Math.max(30, tokenData.expires_in - 60) *
					1000,
		);

		await pool.query(
			`INSERT INTO hubspot_integrations (
         user_id,
         portal_id,
         hub_domain,
         access_token,
         refresh_token,
         scope,
         token_expires_at,
         is_active,
         contact_sync_enabled,
         company_sync_enabled,
         note_sync_enabled,
         last_error
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, TRUE, TRUE, TRUE, NULL)
       ON CONFLICT (user_id) DO UPDATE SET
         portal_id = EXCLUDED.portal_id,
         hub_domain = EXCLUDED.hub_domain,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         scope = EXCLUDED.scope,
         token_expires_at = EXCLUDED.token_expires_at,
         is_active = TRUE,
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP`,
			[
				parsedState.userId,
				tokenInfo.hub_id
					? String(tokenInfo.hub_id)
					: null,
				tokenInfo.hub_domain ?? null,
				tokenData.access_token,
				tokenData.refresh_token,
				scopeFromTokenInfo ??
					tokenData.scope ??
					null,
				tokenExpiresAt,
			],
		);

		return {
			redirectTo: `${config.FRONTEND_URL}${parsedState.returnTo}?hubspot=connected`,
		};
	}

	async updateSettings(
		userId: string,
		payload: {
			isActive?: boolean;
			contactSyncEnabled?: boolean;
			companySyncEnabled?: boolean;
			noteSyncEnabled?: boolean;
		},
	): Promise<HubspotIntegrationConfigResponse> {
		await this.ensureCrmAccess(userId);
		const current =
			await this.getIntegrationRowByUser(userId);
		if (!current) {
			throw new Error(
				"HubSpot is not connected yet.",
			);
		}

		const result =
			await pool.query<HubspotIntegrationRow>(
				`UPDATE hubspot_integrations
         SET is_active = COALESCE($2, is_active),
             contact_sync_enabled = COALESCE($3, contact_sync_enabled),
             company_sync_enabled = COALESCE($4, company_sync_enabled),
             note_sync_enabled = COALESCE($5, note_sync_enabled),
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1
         RETURNING *`,
				[
					userId,
					typeof payload.isActive ===
					"boolean"
						? payload.isActive
						: null,
					typeof payload.contactSyncEnabled ===
					"boolean"
						? payload.contactSyncEnabled
						: null,
					typeof payload.companySyncEnabled ===
					"boolean"
						? payload.companySyncEnabled
						: null,
					typeof payload.noteSyncEnabled ===
					"boolean"
						? payload.noteSyncEnabled
						: null,
				],
			);

		return this.mapIntegration(
			result.rows[0] ?? null,
		);
	}

	async disconnect(userId: string): Promise<void> {
		await this.ensureCrmAccess(userId);
		await pool.query(
			`DELETE FROM hubspot_integrations WHERE user_id = $1`,
			[userId],
		);
	}

	async getEvents(
		userId: string,
		limit = 50,
	): Promise<HubspotSyncEventResponse[]> {
		await this.ensureCrmAccess(userId);
		const boundedLimit = Math.max(
			1,
			Math.min(100, limit),
		);
		const result = await pool.query<HubspotSyncEventRow>(
			`SELECT *
       FROM hubspot_sync_events
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
			[userId, boundedLimit],
		);
		return result.rows.map((row) =>
			this.mapEvent(row),
		);
	}

	async retryEvent(
		userId: string,
		eventId: string,
	): Promise<void> {
		await this.ensureCrmAccess(userId);
		const result = await pool.query<HubspotSyncEventRow>(
			`UPDATE hubspot_sync_events
       SET status = 'pending',
           attempts = 0,
           next_attempt_at = CURRENT_TIMESTAMP,
           last_error = NULL,
           response_status = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND user_id = $2
       RETURNING *`,
			[eventId, userId],
		);
		if (!result.rows[0]) {
			throw new Error(
				"HubSpot sync event not found",
			);
		}
		void this.deliverEventById(eventId).catch(
			(error) => {
				logger.error(
					"HubSpot sync retry dispatch failed",
					{
						eventId,
						error,
					},
				);
			},
		);
	}

	async sendTestEvent(userId: string): Promise<void> {
		await this.ensureCrmAccess(userId);
		const integration =
			await this.getActiveIntegrationByUser(
				userId,
			);
		if (!integration) {
			throw new Error(
				"Active HubSpot integration not found. Connect and enable HubSpot first.",
			);
		}

		await this.queueLeadEvent(
			userId,
			"lead.test",
			{
				eventType: "lead.test",
				message:
					"This is a test sync event from Witzo to HubSpot.",
				emittedAt: new Date().toISOString(),
			},
			null,
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

		const integration =
			await this.getActiveIntegrationByUser(
				userId,
			);
		if (!integration) return;

		const insertResult =
			await pool.query<{ id: string }>(
				`INSERT INTO hubspot_sync_events
         (
           user_id,
           lead_id,
           integration_id,
           event_type,
           payload,
           status,
           max_attempts
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6)
         RETURNING id`,
				[
					userId,
					leadId ?? null,
					integration.id,
					eventType,
					JSON.stringify(payload),
					HUBSPOT_SYNC_MAX_ATTEMPTS,
				],
			);
		const eventId = insertResult.rows[0]?.id;
		if (eventId) {
			void this.deliverEventById(eventId).catch(
				(error) => {
					logger.error(
						"Immediate HubSpot sync dispatch failed",
						{
							eventId,
							error,
						},
					);
				},
			);
		}
	}

	async deliverEventById(
		eventId: string,
	): Promise<void> {
		const claim = await pool.query<HubspotSyncEventRow>(
			`UPDATE hubspot_sync_events
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
		const event = claim.rows[0];
		if (!event) return;

		const integration =
			await this.getIntegrationById(
				event.integration_id,
			);
		if (!integration || !integration.is_active) {
			await this.markDeliveryFailure(
				event,
				"Active HubSpot integration not found",
			);
			return;
		}

		try {
			await this.syncLeadEventToHubspot(
				event,
				integration,
			);
			await this.markDeliverySuccess(event.id);
			await pool.query(
				`UPDATE hubspot_integrations
         SET last_synced_at = CURRENT_TIMESTAMP,
             last_error = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
				[integration.id],
			);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: String(error);
			await this.markDeliveryFailure(
				event,
				message,
			);
		}
	}

	async processPendingEvents(
		limit = HUBSPOT_SYNC_PROCESS_BATCH_SIZE,
	): Promise<void> {
		const result = await pool.query<{ id: string }>(
			`SELECT id
       FROM hubspot_sync_events
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
					"Error processing pending HubSpot sync event",
					{
						eventId: row.id,
						error,
					},
				);
			}
		}
	}
}

export const hubspotIntegrationService =
	new HubspotIntegrationService();
