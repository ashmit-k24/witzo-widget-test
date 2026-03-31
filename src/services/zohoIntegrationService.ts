import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import crypto from "crypto";
import {
	getPlanCapabilities,
	PlanType,
} from "../config/planConfig";
import { config } from "../config/env";
import pool from "../config/database";
import {
	ZOHO_DEFAULT_SCOPES,
	ZOHO_SYNC_BACKOFF_BASE_MS,
	ZOHO_SYNC_BACKOFF_MAX_MS,
	ZOHO_SYNC_DELIVERY_TIMEOUT_MS,
	ZOHO_SYNC_MAX_ATTEMPTS,
	ZOHO_SYNC_PROCESS_BATCH_SIZE,
} from "../constants";
import logger from "../utils/logger";

type ZohoSyncEventStatus =
	| "pending"
	| "processing"
	| "retrying"
	| "delivered"
	| "dead";

type ZohoIntegrationRow = {
	id: string;
	user_id: string;
	organization_id: string | null;
	organization_name: string | null;
	api_domain: string | null;
	accounts_server: string | null;
	access_token: string;
	refresh_token: string;
	scope: string | null;
	token_expires_at: Date;
	is_active: boolean;
	lead_sync_enabled: boolean;
	note_sync_enabled: boolean;
	last_synced_at: Date | null;
	last_error: string | null;
	created_at: Date;
	updated_at: Date;
};

type ZohoSyncEventRow = {
	id: string;
	user_id: string;
	lead_id: string | null;
	integration_id: string;
	event_type: string;
	payload: Record<string, unknown>;
	status: ZohoSyncEventStatus;
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

type ZohoOauthTokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	expires_in_sec?: number;
	api_domain?: string;
	token_type?: string;
	scope?: string;
};

type ZohoFieldMetadataResponse = {
	fields?: Array<{
		api_name?: string;
	}>;
};

type ZohoUpsertResponse = {
	data?: Array<{
		details?: {
			id?: string;
		};
	}>;
};

export type ZohoIntegrationConfigResponse = {
	connected: boolean;
	isActive: boolean;
	organizationId: string | null;
	organizationName: string | null;
	apiDomain: string | null;
	accountsServer: string | null;
	scope: string | null;
	leadSyncEnabled: boolean;
	noteSyncEnabled: boolean;
	lastSyncedAt: Date | null;
	lastError: string | null;
	createdAt: Date | null;
	updatedAt: Date | null;
};

export type ZohoSyncEventResponse = {
	id: string;
	leadId: string | null;
	eventType: string;
	status: ZohoSyncEventStatus;
	attempts: number;
	maxAttempts: number;
	nextAttemptAt: Date;
	lastError: string | null;
	responseStatus: number | null;
	lastAttemptAt: Date | null;
	deliveredAt: Date | null;
	createdAt: Date;
};

const ZOHO_STATE_TTL_MS = 10 * 60 * 1000;
const ZOHO_DEFAULT_RETURN_TO = "/dashboard/zoho";
const ZOHO_CRM_VERSION = "v8";
const ZOHO_GLOBAL_ACCOUNTS_SERVER =
	"https://accounts.zoho.com";
type ZohoDataCenter =
	| "US"
	| "EU"
	| "IN"
	| "AU"
	| "JP"
	| "CA"
	| "CN";

class ZohoIntegrationService {
	private readonly leadFieldCache =
		new Map<string, Set<string>>();

	private maskValue(
		value?: string | null,
	): string | null {
		if (!value) return null;
		const normalized = value.trim();
		if (normalized.length <= 8) {
			return "*".repeat(normalized.length);
		}
		return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
	}

	private getAxiosErrorMeta(error: unknown): Record<string, unknown> {
		if (!axios.isAxiosError(error)) {
			return {
				message:
					error instanceof Error
						? error.message
						: String(error),
			};
		}
		return {
			message: error.message,
			code: error.code ?? null,
			status: error.response?.status ?? null,
			data: error.response?.data ?? null,
		};
	}

	private normalizeScopes(rawScopes: string): string {
		const parsed = rawScopes
			.split(/[\s,]+/)
			.map((scope) => scope.trim())
			.filter(Boolean);
		if (parsed.length === 0) {
			return [...ZOHO_DEFAULT_SCOPES].join(",");
		}
		return Array.from(new Set(parsed)).join(",");
	}

	private normalizeAccountsServer(value?: string | null): string {
		return (value || config.ZOHO_ACCOUNTS_SERVER)
			.trim()
			.replace(/\/+$/, "");
	}

	private normalizeLocation(
		value?: string | null,
	): ZohoDataCenter | null {
		if (!value) return null;
		const normalized = value.trim().toUpperCase();
		const supported: ZohoDataCenter[] = [
			"US",
			"EU",
			"IN",
			"AU",
			"JP",
			"CA",
			"CN",
		];
		return supported.includes(
			normalized as ZohoDataCenter,
		)
			? (normalized as ZohoDataCenter)
			: null;
	}

	private inferLocationFromAccountsServer(
		accountsServer?: string | null,
	): ZohoDataCenter | null {
		const normalized = this.normalizeAccountsServer(
			accountsServer,
		).toLowerCase();
		if (normalized.includes("accounts.zoho.eu")) {
			return "EU";
		}
		if (normalized.includes("accounts.zoho.in")) {
			return "IN";
		}
		if (
			normalized.includes("accounts.zoho.com.au")
		) {
			return "AU";
		}
		if (normalized.includes("accounts.zoho.jp")) {
			return "JP";
		}
		if (
			normalized.includes("accounts.zohocloud.ca")
		) {
			return "CA";
		}
		if (
			normalized.includes("accounts.zoho.com.cn")
		) {
			return "CN";
		}
		if (normalized.includes("accounts.zoho.com")) {
			return "US";
		}
		return null;
	}

	private resolveDataCenter(input?: {
		accountsServer?: string | null;
		location?: string | null;
	}): ZohoDataCenter {
		return (
			this.normalizeLocation(input?.location) ??
			this.inferLocationFromAccountsServer(
				input?.accountsServer,
			) ??
			this.inferLocationFromAccountsServer(
				config.ZOHO_ACCOUNTS_SERVER,
			) ??
			"US"
		);
	}

	private getClientSecretForDataCenter(
		dataCenter: ZohoDataCenter,
	): string {
		switch (dataCenter) {
			case "EU":
				return config.ZOHO_CLIENT_SECRET_EU;
			case "IN":
				return config.ZOHO_CLIENT_SECRET_IN;
			case "AU":
				return config.ZOHO_CLIENT_SECRET_AU;
			case "JP":
				return config.ZOHO_CLIENT_SECRET_JP;
			case "CA":
				return config.ZOHO_CLIENT_SECRET_CA;
			case "CN":
				return config.ZOHO_CLIENT_SECRET_CN;
			case "US":
			default:
				return config.ZOHO_CLIENT_SECRET_US;
		}
	}

	private ensureZohoOAuthConfigured(): void {
		if (
			!config.ZOHO_CLIENT_ID ||
			!config.ZOHO_REDIRECT_URI
		) {
			throw new Error(
				"Zoho CRM integration is not configured. Please set ZOHO_CLIENT_ID and ZOHO_REDIRECT_URI.",
			);
		}
		const hasClientSecret = [
			config.ZOHO_CLIENT_SECRET,
			config.ZOHO_CLIENT_SECRET_US,
			config.ZOHO_CLIENT_SECRET_EU,
			config.ZOHO_CLIENT_SECRET_IN,
			config.ZOHO_CLIENT_SECRET_AU,
			config.ZOHO_CLIENT_SECRET_JP,
			config.ZOHO_CLIENT_SECRET_CA,
			config.ZOHO_CLIENT_SECRET_CN,
		].some(
			(secret) => secret.trim().length > 0,
		);
		if (!hasClientSecret) {
			throw new Error(
				"Zoho CRM integration is not configured. Please set ZOHO_CLIENT_SECRET or the region-specific Zoho client secret values.",
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
		if (
			!getPlanCapabilities(planType).crmIntegration
		) {
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
		if (!value) return ZOHO_DEFAULT_RETURN_TO;
		const normalized = value.trim();
		if (
			normalized.length === 0 ||
			normalized.length > 256 ||
			!normalized.startsWith("/") ||
			normalized.startsWith("//") ||
			!normalized.startsWith("/dashboard")
		) {
			return ZOHO_DEFAULT_RETURN_TO;
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
			exp: Date.now() + ZOHO_STATE_TTL_MS,
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
				"Invalid Zoho OAuth state payload",
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
				"Invalid Zoho OAuth state signature",
			);
		}

		const payload = JSON.parse(
			Buffer.from(
				encodedPayload,
				"base64url",
			).toString("utf8"),
		) as ParsedStatePayload;
		if (
			!payload.userId ||
			!payload.nonce ||
			typeof payload.exp !== "number"
		) {
			throw new Error(
				"Invalid Zoho OAuth state fields",
			);
		}
		if (payload.exp < Date.now()) {
			throw new Error(
				"Zoho OAuth state has expired. Please reconnect.",
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

	private buildZohoAuthUrl(state: string): string {
		const normalizedScopes = this.normalizeScopes(
			config.ZOHO_OAUTH_SCOPES,
		);
		const params = new URLSearchParams({
			response_type: "code",
			client_id: config.ZOHO_CLIENT_ID,
			scope: normalizedScopes,
			redirect_uri: config.ZOHO_REDIRECT_URI,
			access_type: "offline",
			prompt: "consent",
			state,
		});
		logger.info("Zoho OAuth auth URL generated", {
			authBaseUrl: ZOHO_GLOBAL_ACCOUNTS_SERVER,
			clientId: this.maskValue(
				config.ZOHO_CLIENT_ID,
			),
			redirectUri: config.ZOHO_REDIRECT_URI,
			scopes: normalizedScopes,
			stateLength: state.length,
		});
		return `${ZOHO_GLOBAL_ACCOUNTS_SERVER}/oauth/v2/auth?${params.toString()}`;
	}

	private mapIntegration(
		row: ZohoIntegrationRow | null,
	): ZohoIntegrationConfigResponse {
		if (!row) {
			return {
				connected: false,
				isActive: false,
				organizationId: null,
				organizationName: null,
				apiDomain: null,
				accountsServer: null,
				scope: null,
				leadSyncEnabled: true,
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
			organizationId: row.organization_id,
			organizationName: row.organization_name,
			apiDomain: row.api_domain,
			accountsServer: row.accounts_server,
			scope: row.scope,
			leadSyncEnabled: row.lead_sync_enabled,
			noteSyncEnabled: row.note_sync_enabled,
			lastSyncedAt: row.last_synced_at,
			lastError: row.last_error,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private mapEvent(
		row: ZohoSyncEventRow,
	): ZohoSyncEventResponse {
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
			ZOHO_SYNC_BACKOFF_BASE_MS *
			Math.pow(2, Math.max(0, attempt - 1));
		return Math.min(delay, ZOHO_SYNC_BACKOFF_MAX_MS);
	}

	private async getIntegrationRowByUser(
		userId: string,
	): Promise<ZohoIntegrationRow | null> {
		const result = await pool.query<ZohoIntegrationRow>(
			`SELECT * FROM zoho_integrations WHERE user_id = $1 LIMIT 1`,
			[userId],
		);
		return result.rows[0] ?? null;
	}

	private async getActiveIntegrationByUser(
		userId: string,
	): Promise<ZohoIntegrationRow | null> {
		const result = await pool.query<ZohoIntegrationRow>(
			`SELECT * FROM zoho_integrations WHERE user_id = $1 AND is_active = TRUE LIMIT 1`,
			[userId],
		);
		return result.rows[0] ?? null;
	}

	private async getIntegrationById(
		id: string,
	): Promise<ZohoIntegrationRow | null> {
		const result = await pool.query<ZohoIntegrationRow>(
			`SELECT * FROM zoho_integrations WHERE id = $1 LIMIT 1`,
			[id],
		);
		return result.rows[0] ?? null;
	}

	private async exchangeAuthorizationCode(
		code: string,
		options?: {
			accountsServer?: string | null;
			location?: string | null;
		},
	): Promise<ZohoOauthTokenResponse> {
		const accountsServer =
			this.normalizeAccountsServer(
				options?.accountsServer,
			);
		const dataCenter = this.resolveDataCenter({
			accountsServer,
			location: options?.location,
		});
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: config.ZOHO_CLIENT_ID,
			client_secret:
				this.getClientSecretForDataCenter(
					dataCenter,
				),
			redirect_uri: config.ZOHO_REDIRECT_URI,
			code,
		});
		const tokenUrl = `${accountsServer}/oauth/v2/token`;
		logger.info("Zoho OAuth token exchange starting", {
			tokenUrl,
			clientId: this.maskValue(
				config.ZOHO_CLIENT_ID,
			),
			redirectUri: config.ZOHO_REDIRECT_URI,
			dataCenter,
			callbackAccountsServer:
				options?.accountsServer ?? null,
			callbackLocation:
				options?.location ?? null,
			hasCode: code.trim().length > 0,
		});
		try {
			const response =
				await axios.post<ZohoOauthTokenResponse>(
					tokenUrl,
					body.toString(),
					{
						headers: {
							"Content-Type":
								"application/x-www-form-urlencoded",
						},
						timeout:
							ZOHO_SYNC_DELIVERY_TIMEOUT_MS,
					},
				);
			logger.info(
				"Zoho OAuth token exchange completed",
				{
					tokenUrl,
					dataCenter,
					apiDomain:
						response.data?.api_domain ??
						null,
					scope:
						response.data?.scope ?? null,
					hasRefreshToken: Boolean(
						response.data
							?.refresh_token,
					),
					hasAccessToken: Boolean(
						response.data
							?.access_token,
					),
				},
			);
			return response.data;
		} catch (error) {
			logger.error(
				"Zoho OAuth token exchange failed",
				{
					tokenUrl,
					clientId: this.maskValue(
						config.ZOHO_CLIENT_ID,
					),
					redirectUri:
						config.ZOHO_REDIRECT_URI,
					dataCenter,
					callbackAccountsServer:
						options?.accountsServer ?? null,
					callbackLocation:
						options?.location ?? null,
					error: this.getAxiosErrorMeta(
						error,
					),
				},
			);
			throw error;
		}
	}

	private async refreshAccessToken(
		integration: ZohoIntegrationRow,
	): Promise<ZohoIntegrationRow> {
		const accountsServer =
			this.normalizeAccountsServer(
				integration.accounts_server,
			);
		const dataCenter = this.resolveDataCenter({
			accountsServer,
		});
		const body = new URLSearchParams({
			grant_type: "refresh_token",
			client_id: config.ZOHO_CLIENT_ID,
			client_secret:
				this.getClientSecretForDataCenter(
					dataCenter,
				),
			refresh_token: integration.refresh_token,
		});
		const response = await axios.post<ZohoOauthTokenResponse>(
			`${accountsServer}/oauth/v2/token`,
			body.toString(),
			{
				headers: {
					"Content-Type":
						"application/x-www-form-urlencoded",
				},
				timeout: ZOHO_SYNC_DELIVERY_TIMEOUT_MS,
			},
		);
		const tokenData = response.data;
		const expiresIn =
			tokenData.expires_in_sec ??
			tokenData.expires_in ??
			3600;
		const nextExpiresAt = new Date(
			Date.now() +
				Math.max(30, expiresIn - 60) * 1000,
		);
		const updateResult =
			await pool.query<ZohoIntegrationRow>(
				`UPDATE zoho_integrations
         SET access_token = $2,
             refresh_token = COALESCE($3, refresh_token),
             api_domain = COALESCE($4, api_domain),
             token_expires_at = $5,
             scope = COALESCE($6, scope),
             last_error = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
				[
					integration.id,
					tokenData.access_token ??
						integration.access_token,
					tokenData.refresh_token ?? null,
					tokenData.api_domain ?? null,
					nextExpiresAt,
					tokenData.scope ?? null,
				],
			);
		const refreshed = updateResult.rows[0];
		if (!refreshed) {
			throw new Error(
				"Failed to refresh Zoho integration token",
			);
		}
		return refreshed;
	}

	private async ensureFreshAccessToken(
		integration: ZohoIntegrationRow,
	): Promise<ZohoIntegrationRow> {
		if (
			integration.token_expires_at >
			new Date(Date.now() + 60 * 1000)
		) {
			return integration;
		}
		return this.refreshAccessToken(integration);
	}

	private async requestZoho<T>(
		integration: ZohoIntegrationRow,
		requestConfig: AxiosRequestConfig,
		retryOnUnauthorized = true,
	): Promise<AxiosResponse<T>> {
		const response = await axios.request<T>({
			...requestConfig,
			baseURL:
				integration.api_domain ||
				config.ZOHO_API_DOMAIN,
			timeout: ZOHO_SYNC_DELIVERY_TIMEOUT_MS,
			headers: {
				Authorization: `Zoho-oauthtoken ${integration.access_token}`,
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
			integration.api_domain =
				refreshed.api_domain;
			integration.token_expires_at =
				refreshed.token_expires_at;
			integration.scope = refreshed.scope;
			return this.requestZoho<T>(
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
				`Zoho API ${requestConfig.method ?? "GET"} ${requestConfig.url} failed with ${response.status}: ${data}`,
			);
		}
		return response;
	}

	private async loadLeadSnapshot(
		userId: string,
		leadId: string,
	): Promise<LeadSnapshot | null> {
		const result = await pool.query<LeadSnapshot>(
			`SELECT id, session_id, widget_key_id, name, email, phone, country, company, chat_summary, status, source_url, message_count, follow_up_sent_at, created_at, updated_at
       FROM leads
       WHERE id = $1 AND user_id = $2
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
		event: ZohoSyncEventRow,
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

	private parseName(
		fullName?: string | null,
	): { firstName: string | null; lastName: string } {
		const normalized = (fullName || "").trim();
		if (!normalized) {
			return {
				firstName: null,
				lastName: "Visitor",
			};
		}
		const parts = normalized
			.split(/\s+/)
			.filter(Boolean);
		if (parts.length === 1) {
			return {
				firstName: null,
				lastName: parts[0],
			};
		}
		return {
			firstName: parts.slice(0, -1).join(" "),
			lastName: parts[parts.length - 1] || "Visitor",
		};
	}

	private extractDomainFromUrl(
		value?: string | null,
	): string | null {
		if (!value) return null;
		try {
			const parsed = new URL(value);
			const host =
				parsed.hostname.trim().toLowerCase();
			if (
				!host ||
				host === "localhost" ||
				host.endsWith(".localhost") ||
				/^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
				!host.includes(".")
			) {
				return null;
			}
			return host.startsWith("www.")
				? host.slice(4)
				: host;
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
			!domain ||
			domain === "localhost" ||
			domain.endsWith(".localhost") ||
			/^\d{1,3}(\.\d{1,3}){3}$/.test(domain) ||
			!domain.includes(".")
		) {
			return null;
		}
		return domain;
	}

	private normalizeWebsite(
		value?: string | null,
	): string | null {
		if (!value) return null;
		try {
			const parsed = new URL(value);
			if (
				!["http:", "https:"].includes(
					parsed.protocol,
				)
			) {
				return null;
			}
			if (!this.extractDomainFromUrl(value)) {
				return null;
			}
			return parsed.toString();
		} catch {
			return null;
		}
	}

	private deriveCompanyName(
		lead: LeadContext,
	): string {
		const explicit = lead.company?.trim();
		if (explicit) return explicit;
		return (
			this.extractDomainFromUrl(
				lead.sourceUrl,
			) ??
			this.extractDomainFromEmail(lead.email) ??
			"Website Lead"
		);
	}

	private hasScope(
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

	private async getLeadFieldSet(
		integration: ZohoIntegrationRow,
	): Promise<Set<string>> {
		const cacheKey =
			integration.organization_id ??
			integration.user_id;
		const cached =
			this.leadFieldCache.get(cacheKey);
		if (cached) return cached;

		const fallback = new Set<string>([
			"First_Name",
			"Last_Name",
			"Email",
			"Phone",
			"Company",
			"Country",
			"Description",
			"Lead_Source",
			"Website",
		]);
		if (
			!this.hasScope(
				integration.scope,
				"ZohoCRM.settings.fields.READ",
			)
		) {
			this.leadFieldCache.set(cacheKey, fallback);
			return fallback;
		}

		try {
			const response =
				await this.requestZoho<ZohoFieldMetadataResponse>(
					integration,
					{
						method: "GET",
						url: `/crm/${ZOHO_CRM_VERSION}/settings/fields`,
						params: { module: "Leads" },
					},
				);
			const fields = new Set<string>(
				(response.data?.fields ?? [])
					.map((field) => field.api_name)
					.filter(
						(name): name is string =>
							typeof name ===
								"string" &&
							name.length > 0,
					),
			);
			this.leadFieldCache.set(
				cacheKey,
				fields.size > 0 ? fields : fallback,
			);
			return fields.size > 0
				? fields
				: fallback;
		} catch (error) {
			logger.warn(
				"Failed to fetch Zoho lead field metadata; using fallback fields",
				{
					userId: integration.user_id,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
			this.leadFieldCache.set(cacheKey, fallback);
			return fallback;
		}
	}

	private buildLeadDescription(
		lead: LeadContext,
		eventType: string,
	): string {
		const lines = [
			`Witzo Event: ${eventType}`,
			lead.status
				? `Witzo Status: ${lead.status}`
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
			lead.chatSummary ??
				"No summary provided.",
		].filter(
			(value): value is string =>
				value !== null,
		);
		return lines.join("\n").slice(0, 32000);
	}

	private async upsertLead(
		integration: ZohoIntegrationRow,
		lead: LeadContext,
		eventType: string,
	): Promise<string | null> {
		if (
			!lead.name &&
			!lead.email &&
			!lead.phone
		) {
			return null;
		}
		const { firstName, lastName } =
			this.parseName(lead.name);
		const fieldSet = await this.getLeadFieldSet(
			integration,
		);
		const record: Record<string, unknown> = {};
		if (fieldSet.has("Last_Name")) {
			record.Last_Name = lastName;
		}
		if (firstName && fieldSet.has("First_Name")) {
			record.First_Name = firstName;
		}
		if (lead.email && fieldSet.has("Email")) {
			record.Email = lead.email;
		}
		if (lead.phone && fieldSet.has("Phone")) {
			record.Phone = lead.phone;
		}
		if (fieldSet.has("Company")) {
			record.Company =
				this.deriveCompanyName(lead);
		}
		if (
			lead.country &&
			fieldSet.has("Country")
		) {
			record.Country = lead.country;
		}
		if (fieldSet.has("Description")) {
			record.Description =
				this.buildLeadDescription(
					lead,
					eventType,
				);
		}
		if (fieldSet.has("Lead_Source")) {
			record.Lead_Source = "Witzo";
		}
		const website = this.normalizeWebsite(
			lead.sourceUrl,
		);
		if (website && fieldSet.has("Website")) {
			record.Website = website;
		}

		const duplicateCheckFields: string[] = [];
		if (lead.email && fieldSet.has("Email")) {
			duplicateCheckFields.push("Email");
		}
		if (
			lead.phone &&
			fieldSet.has("Phone") &&
			duplicateCheckFields.length === 0
		) {
			duplicateCheckFields.push("Phone");
		}

		const response =
			await this.requestZoho<ZohoUpsertResponse>(
				integration,
				{
					method: "POST",
					url: `/crm/${ZOHO_CRM_VERSION}/Leads/upsert`,
					data: {
						data: [record],
						duplicate_check_fields:
							duplicateCheckFields.length > 0
								? duplicateCheckFields
								: undefined,
						trigger: [],
					},
				},
			);

		return (
			response.data?.data?.[0]?.details?.id ??
			null
		);
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
			lead.followUpSentAt
				? `Follow-up Sent At: ${lead.followUpSentAt.toISOString()}`
				: null,
			"",
			"Summary:",
			lead.chatSummary ??
				"No summary provided.",
		].filter(
			(value): value is string =>
				value !== null,
		);
		return lines.join("\n").slice(0, 50000);
	}

	private async createLeadNote(
		integration: ZohoIntegrationRow,
		leadRecordId: string,
		lead: LeadContext,
		eventType: string,
	): Promise<void> {
		await this.requestZoho(
			integration,
			{
				method: "POST",
				url: `/crm/${ZOHO_CRM_VERSION}/Leads/${encodeURIComponent(leadRecordId)}/Notes`,
				data: {
					data: [
						{
							Note_Title: `Witzo ${eventType}`,
							Note_Content:
								this.buildNoteBody(
									lead,
									eventType,
								),
						},
					],
				},
			},
		);
	}

	private async syncLeadEventToZoho(
		event: ZohoSyncEventRow,
		integration: ZohoIntegrationRow,
	): Promise<void> {
		if (event.event_type === "lead.test") {
			return;
		}
		if (
			!integration.lead_sync_enabled &&
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
		const leadRecordId = await this.upsertLead(
			integration,
			leadContext,
			event.event_type,
		);
		if (
			integration.note_sync_enabled &&
			leadRecordId
		) {
			await this.createLeadNote(
				integration,
				leadRecordId,
				leadContext,
				event.event_type,
			);
		}
	}

	private async markDeliverySuccess(
		eventId: string,
	): Promise<void> {
		await pool.query(
			`UPDATE zoho_sync_events
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
		event: ZohoSyncEventRow,
		errorMessage: string,
	): Promise<void> {
		const exhausted =
			event.attempts >= event.max_attempts;
		const nextDelayMs = this.backoffDelayMs(
			event.attempts,
		);
		await pool.query(
			`UPDATE zoho_sync_events
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
			`UPDATE zoho_integrations
       SET last_error = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
			[event.integration_id, errorMessage],
		);
	}

	async getConfig(
		userId: string,
	): Promise<ZohoIntegrationConfigResponse> {
		await this.ensureCrmAccess(userId);
		return this.mapIntegration(
			await this.getIntegrationRowByUser(userId),
		);
	}

	async getConnectUrl(
		userId: string,
		returnTo?: string,
	): Promise<{ authUrl: string }> {
		await this.ensureCrmAccess(userId);
		this.ensureZohoOAuthConfigured();
		logger.info("Zoho connect requested", {
			userId,
			returnTo:
				this.sanitizeReturnPath(returnTo),
			clientId: this.maskValue(
				config.ZOHO_CLIENT_ID,
			),
			redirectUri: config.ZOHO_REDIRECT_URI,
			scopes: this.normalizeScopes(
				config.ZOHO_OAUTH_SCOPES,
			),
			fallbackAccountsServer:
				config.ZOHO_ACCOUNTS_SERVER,
		});
		return {
			authUrl: this.buildZohoAuthUrl(
				this.createOauthState(
					userId,
					returnTo,
				),
			),
		};
	}

	async handleOauthCallback(input: {
		code: string;
		state: string;
		accountsServer?: string | null;
		location?: string | null;
	}): Promise<{ redirectTo: string }> {
		this.ensureZohoOAuthConfigured();
		logger.info("Zoho OAuth callback received", {
			clientId: this.maskValue(
				config.ZOHO_CLIENT_ID,
			),
			redirectUri: config.ZOHO_REDIRECT_URI,
			callbackAccountsServer:
				input.accountsServer ?? null,
			callbackLocation:
				input.location ?? null,
			hasCode: input.code.trim().length > 0,
			stateLength: input.state.length,
		});
		const parsedState = this.parseOauthState(
			input.state,
		);
		const accountsServer =
			this.normalizeAccountsServer(
				input.accountsServer,
			);
		const tokenData =
			await this.exchangeAuthorizationCode(
				input.code,
				{
					accountsServer,
					location: input.location,
				},
			);
		if (
			!tokenData.access_token ||
			!tokenData.refresh_token
		) {
			throw new Error(
				"Zoho token exchange failed",
			);
		}
		const expiresIn =
			tokenData.expires_in_sec ??
			tokenData.expires_in ??
			3600;
		const tokenExpiresAt = new Date(
			Date.now() +
				Math.max(30, expiresIn - 60) * 1000,
		);
		await pool.query(
			`INSERT INTO zoho_integrations (
         user_id, organization_id, organization_name, api_domain, accounts_server,
         access_token, refresh_token, scope, token_expires_at, is_active,
         lead_sync_enabled, note_sync_enabled, last_error
       )
       VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, TRUE, TRUE, TRUE, NULL)
       ON CONFLICT (user_id) DO UPDATE SET
         api_domain = EXCLUDED.api_domain,
         accounts_server = EXCLUDED.accounts_server,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         scope = EXCLUDED.scope,
         token_expires_at = EXCLUDED.token_expires_at,
         is_active = TRUE,
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP`,
			[
				parsedState.userId,
				tokenData.api_domain ??
					config.ZOHO_API_DOMAIN,
				accountsServer,
				tokenData.access_token,
				tokenData.refresh_token,
				tokenData.scope ?? null,
				tokenExpiresAt,
			],
		);
		return {
			redirectTo: `${config.FRONTEND_URL}${parsedState.returnTo}?zoho=connected`,
		};
	}

	async updateSettings(
		userId: string,
		payload: {
			isActive?: boolean;
			leadSyncEnabled?: boolean;
			noteSyncEnabled?: boolean;
		},
	): Promise<ZohoIntegrationConfigResponse> {
		await this.ensureCrmAccess(userId);
		const current =
			await this.getIntegrationRowByUser(userId);
		if (!current) {
			throw new Error(
				"Zoho CRM is not connected yet.",
			);
		}
		const result =
			await pool.query<ZohoIntegrationRow>(
				`UPDATE zoho_integrations
         SET is_active = COALESCE($2, is_active),
             lead_sync_enabled = COALESCE($3, lead_sync_enabled),
             note_sync_enabled = COALESCE($4, note_sync_enabled),
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1
         RETURNING *`,
				[
					userId,
					typeof payload.isActive ===
					"boolean"
						? payload.isActive
						: null,
					typeof payload.leadSyncEnabled ===
					"boolean"
						? payload.leadSyncEnabled
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
			`DELETE FROM zoho_integrations WHERE user_id = $1`,
			[userId],
		);
	}

	async getEvents(
		userId: string,
		limit = 50,
	): Promise<ZohoSyncEventResponse[]> {
		await this.ensureCrmAccess(userId);
		const boundedLimit = Math.max(
			1,
			Math.min(100, limit),
		);
		const result = await pool.query<ZohoSyncEventRow>(
			`SELECT *
       FROM zoho_sync_events
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
		const result = await pool.query<ZohoSyncEventRow>(
			`UPDATE zoho_sync_events
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
				"Zoho sync event not found",
			);
		}
		void this.deliverEventById(eventId).catch(
			(error) => {
				logger.error(
					"Zoho sync retry dispatch failed",
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
				"Active Zoho CRM integration not found. Connect and enable Zoho first.",
			);
		}
		await this.queueLeadEvent(
			userId,
			"lead.test",
			{
				eventType: "lead.test",
				message:
					"This is a test sync event from Witzo to Zoho CRM.",
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
				`INSERT INTO zoho_sync_events
         (user_id, lead_id, integration_id, event_type, payload, status, max_attempts)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6)
         RETURNING id`,
				[
					userId,
					leadId ?? null,
					integration.id,
					eventType,
					JSON.stringify(payload),
					ZOHO_SYNC_MAX_ATTEMPTS,
				],
			);
		const eventId = insertResult.rows[0]?.id;
		if (eventId) {
			void this.deliverEventById(eventId).catch(
				(error) => {
					logger.error(
						"Immediate Zoho sync dispatch failed",
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
		const claim = await pool.query<ZohoSyncEventRow>(
			`UPDATE zoho_sync_events
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
				"Active Zoho integration not found",
			);
			return;
		}
		try {
			await this.syncLeadEventToZoho(
				event,
				integration,
			);
			await this.markDeliverySuccess(event.id);
			await pool.query(
				`UPDATE zoho_integrations
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
		limit = ZOHO_SYNC_PROCESS_BATCH_SIZE,
	): Promise<void> {
		const result = await pool.query<{ id: string }>(
			`SELECT id
       FROM zoho_sync_events
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
					"Error processing pending Zoho sync event",
					{
						eventId: row.id,
						error,
					},
				);
			}
		}
	}
}

export const zohoIntegrationService =
	new ZohoIntegrationService();
