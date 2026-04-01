import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import crypto from "crypto";
import {
	getPlanCapabilities,
	PlanType,
} from "../config/planConfig";
import { config } from "../config/env";
import pool from "../config/database";
import {
	SALESFORCE_DEFAULT_SCOPES,
	SALESFORCE_SYNC_BACKOFF_BASE_MS,
	SALESFORCE_SYNC_BACKOFF_MAX_MS,
	SALESFORCE_SYNC_DELIVERY_TIMEOUT_MS,
	SALESFORCE_SYNC_MAX_ATTEMPTS,
	SALESFORCE_SYNC_PROCESS_BATCH_SIZE,
} from "../constants";
import logger from "../utils/logger";

type SalesforceSyncEventStatus =
	| "pending"
	| "processing"
	| "retrying"
	| "delivered"
	| "dead";

type SalesforceIntegrationRow = {
	id: string;
	user_id: string;
	organization_id: string | null;
	organization_name: string | null;
	instance_url: string | null;
	auth_base_url: string | null;
	access_token: string;
	refresh_token: string;
	scope: string | null;
	token_expires_at: Date;
	is_active: boolean;
	lead_sync_enabled: boolean;
	task_sync_enabled: boolean;
	last_synced_at: Date | null;
	last_error: string | null;
	created_at: Date;
	updated_at: Date;
};

type SalesforceSyncEventRow = {
	id: string;
	user_id: string;
	lead_id: string | null;
	integration_id: string;
	event_type: string;
	payload: Record<string, unknown>;
	status: SalesforceSyncEventStatus;
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

type LeadContext = {
	leadId: string | null;
	sessionId: string | null;
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
};

type ParsedStatePayload = {
	userId: string;
	returnTo: string;
	exp: number;
	nonce: string;
	codeVerifier: string;
};

type SalesforceOauthTokenResponse = {
	access_token?: string;
	refresh_token?: string;
	instance_url?: string;
	id?: string;
	scope?: string;
};

type SalesforceDescribeResponse = {
	fields?: Array<{
		name?: string;
		createable?: boolean;
		updateable?: boolean;
	}>;
};

type SalesforceQueryResponse<T> = {
	records?: T[];
};

export type SalesforceIntegrationConfigResponse = {
	connected: boolean;
	isActive: boolean;
	organizationId: string | null;
	organizationName: string | null;
	instanceUrl: string | null;
	authBaseUrl: string | null;
	scope: string | null;
	leadSyncEnabled: boolean;
	taskSyncEnabled: boolean;
	lastSyncedAt: Date | null;
	lastError: string | null;
	createdAt: Date | null;
	updatedAt: Date | null;
};

export type SalesforceSyncEventResponse = {
	id: string;
	leadId: string | null;
	eventType: string;
	status: SalesforceSyncEventStatus;
	attempts: number;
	maxAttempts: number;
	nextAttemptAt: Date;
	lastError: string | null;
	responseStatus: number | null;
	lastAttemptAt: Date | null;
	deliveredAt: Date | null;
	createdAt: Date;
};

const SALESFORCE_STATE_TTL_MS = 10 * 60 * 1000;
const SALESFORCE_DEFAULT_RETURN_TO = "/dashboard/salesforce";
const SALESFORCE_API_VERSION = "v61.0";
const SALESFORCE_STATE_VERSION = "v1";

class SalesforceIntegrationService {
	private readonly leadFieldCache = new Map<string, Set<string>>();

	private maskValue(value?: string | null, visiblePrefix = 6, visibleSuffix = 4): string | null {
		if (!value) return null;
		if (value.length <= visiblePrefix + visibleSuffix) return value;
		return `${value.slice(0, visiblePrefix)}...${value.slice(-visibleSuffix)}`;
	}

	private normalizeScopes(raw: string): string {
		const parsed = raw.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
		return Array.from(new Set(parsed.length > 0 ? parsed : [...SALESFORCE_DEFAULT_SCOPES])).join(" ");
	}

	private normalizeAuthBaseUrl(value?: string | null): string {
		return (value || config.SALESFORCE_AUTH_BASE_URL).trim().replace(/\/+$/, "");
	}

	private ensureConfigured(): void {
		if (!config.SALESFORCE_CLIENT_ID || !config.SALESFORCE_CLIENT_SECRET || !config.SALESFORCE_REDIRECT_URI) {
			throw new Error("Salesforce CRM integration is not configured. Please set SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET, and SALESFORCE_REDIRECT_URI.");
		}
	}

	private async getUserPlanType(userId: string): Promise<PlanType | null> {
		const result = await pool.query<{ plan_type: PlanType }>(`SELECT plan_type FROM users WHERE id = $1 LIMIT 1`, [userId]);
		return result.rows[0]?.plan_type ?? null;
	}

	private async ensureCrmAccess(userId: string): Promise<void> {
		const planType = await this.getUserPlanType(userId);
		if (!getPlanCapabilities(planType).crmIntegration) {
			throw new Error("This feature is available on the Basic, Standard, and Enterprise plans");
		}
	}

	private sanitizeReturnPath(value?: string): string {
		if (!value) return SALESFORCE_DEFAULT_RETURN_TO;
		const normalized = value.trim();
		if (normalized.length === 0 || normalized.length > 256 || !normalized.startsWith("/") || normalized.startsWith("//") || !normalized.startsWith("/dashboard")) {
			return SALESFORCE_DEFAULT_RETURN_TO;
		}
		return normalized;
	}

	private getStateEncryptionKey(): Buffer {
		return crypto
			.createHash("sha256")
			.update(config.COOKIE_SECRET)
			.digest();
	}

	private generatePkceCodeVerifier(): string {
		return crypto.randomBytes(64).toString("base64url");
	}

	private createPkceCodeChallenge(
		codeVerifier: string,
	): string {
		return crypto
			.createHash("sha256")
			.update(codeVerifier)
			.digest("base64url");
	}

	private createOauthState(userId: string, returnTo?: string): string {
		const payload: ParsedStatePayload = {
			userId,
			returnTo: this.sanitizeReturnPath(returnTo),
			exp: Date.now() + SALESFORCE_STATE_TTL_MS,
			nonce: crypto.randomBytes(16).toString("hex"),
			codeVerifier: this.generatePkceCodeVerifier(),
		};
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv(
			"aes-256-gcm",
			this.getStateEncryptionKey(),
			iv,
		);
		const ciphertext = Buffer.concat([
			cipher.update(JSON.stringify(payload), "utf8"),
			cipher.final(),
		]);
		const authTag = cipher.getAuthTag();

		return [
			SALESFORCE_STATE_VERSION,
			iv.toString("base64url"),
			authTag.toString("base64url"),
			ciphertext.toString("base64url"),
		].join(".");
	}

	private parseOauthState(state: string): ParsedStatePayload {
		const [version, ivRaw, authTagRaw, ciphertextRaw] =
			state.split(".");
		if (
			version !== SALESFORCE_STATE_VERSION ||
			!ivRaw ||
			!authTagRaw ||
			!ciphertextRaw
		) {
			throw new Error("Invalid Salesforce OAuth state payload");
		}

		let payload: ParsedStatePayload;
		try {
			const decipher = crypto.createDecipheriv(
				"aes-256-gcm",
				this.getStateEncryptionKey(),
				Buffer.from(ivRaw, "base64url"),
			);
			decipher.setAuthTag(
				Buffer.from(authTagRaw, "base64url"),
			);
			const decrypted = Buffer.concat([
				decipher.update(
					Buffer.from(ciphertextRaw, "base64url"),
				),
				decipher.final(),
			]);
			payload = JSON.parse(
				decrypted.toString("utf8"),
			) as ParsedStatePayload;
		} catch {
			throw new Error("Invalid Salesforce OAuth state payload");
		}

		if (
			typeof payload.userId !== "string" ||
			typeof payload.returnTo !== "string" ||
			typeof payload.exp !== "number" ||
			typeof payload.nonce !== "string" ||
			typeof payload.codeVerifier !== "string" ||
			payload.codeVerifier.length < 43 ||
			payload.codeVerifier.length > 128 ||
			payload.exp < Date.now()
		) {
			throw new Error("Salesforce OAuth state has expired or is invalid. Please reconnect.");
		}
		const sanitizedPayload = {
			...payload,
			returnTo: this.sanitizeReturnPath(payload.returnTo),
		};
		logger.info("Salesforce OAuth state parsed", {
			userId: sanitizedPayload.userId,
			returnTo: sanitizedPayload.returnTo,
			version,
			hasCodeVerifier: Boolean(sanitizedPayload.codeVerifier),
			codeVerifierLength: sanitizedPayload.codeVerifier.length,
			stateLength: state.length,
		});
		return sanitizedPayload;
	}

	private mapIntegration(row: SalesforceIntegrationRow | null): SalesforceIntegrationConfigResponse {
		if (!row) {
			return { connected: false, isActive: false, organizationId: null, organizationName: null, instanceUrl: null, authBaseUrl: null, scope: null, leadSyncEnabled: true, taskSyncEnabled: true, lastSyncedAt: null, lastError: null, createdAt: null, updatedAt: null };
		}
		return {
			connected: true,
			isActive: row.is_active,
			organizationId: row.organization_id,
			organizationName: row.organization_name,
			instanceUrl: row.instance_url,
			authBaseUrl: row.auth_base_url,
			scope: row.scope,
			leadSyncEnabled: row.lead_sync_enabled,
			taskSyncEnabled: row.task_sync_enabled,
			lastSyncedAt: row.last_synced_at,
			lastError: row.last_error,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private mapEvent(row: SalesforceSyncEventRow): SalesforceSyncEventResponse {
		return { id: row.id, leadId: row.lead_id, eventType: row.event_type, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts, nextAttemptAt: row.next_attempt_at, lastError: row.last_error, responseStatus: row.response_status, lastAttemptAt: row.last_attempt_at, deliveredAt: row.delivered_at, createdAt: row.created_at };
	}

	private async getIntegrationRowByUser(userId: string): Promise<SalesforceIntegrationRow | null> {
		const result = await pool.query<SalesforceIntegrationRow>(`SELECT * FROM salesforce_integrations WHERE user_id = $1 LIMIT 1`, [userId]);
		return result.rows[0] ?? null;
	}

	private async getActiveIntegrationByUser(userId: string): Promise<SalesforceIntegrationRow | null> {
		const result = await pool.query<SalesforceIntegrationRow>(`SELECT * FROM salesforce_integrations WHERE user_id = $1 AND is_active = TRUE LIMIT 1`, [userId]);
		return result.rows[0] ?? null;
	}

	private async getIntegrationById(id: string): Promise<SalesforceIntegrationRow | null> {
		const result = await pool.query<SalesforceIntegrationRow>(`SELECT * FROM salesforce_integrations WHERE id = $1 LIMIT 1`, [id]);
		return result.rows[0] ?? null;
	}

	private async exchangeAuthorizationCode(
		code: string,
		codeVerifier: string,
	): Promise<SalesforceOauthTokenResponse> {
		const tokenUrl = `${this.normalizeAuthBaseUrl()}/services/oauth2/token`;
		logger.info("Salesforce OAuth token exchange starting", {
			tokenUrl,
			redirectUri: config.SALESFORCE_REDIRECT_URI,
			clientId: this.maskValue(config.SALESFORCE_CLIENT_ID),
			codePresent: Boolean(code),
			codeLength: code.length,
			codeVerifierLength: codeVerifier.length,
		});
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: config.SALESFORCE_CLIENT_ID,
			client_secret: config.SALESFORCE_CLIENT_SECRET,
			redirect_uri: config.SALESFORCE_REDIRECT_URI,
			code,
			code_verifier: codeVerifier,
		});
		try {
			const response = await axios.post<SalesforceOauthTokenResponse>(tokenUrl, body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: SALESFORCE_SYNC_DELIVERY_TIMEOUT_MS });
			logger.info("Salesforce OAuth token exchange completed", {
				tokenUrl,
				instanceUrl: response.data.instance_url ?? null,
				scope: response.data.scope ?? null,
				hasAccessToken: Boolean(response.data.access_token),
				hasRefreshToken: Boolean(response.data.refresh_token),
			});
			return response.data;
		} catch (error) {
			if (axios.isAxiosError(error)) {
				logger.error("Salesforce OAuth token exchange failed", {
					tokenUrl,
					redirectUri: config.SALESFORCE_REDIRECT_URI,
					clientId: this.maskValue(config.SALESFORCE_CLIENT_ID),
					status: error.response?.status ?? null,
					data: error.response?.data ?? null,
					message: error.message,
				});
			} else {
				logger.error("Salesforce OAuth token exchange failed", {
					tokenUrl,
					redirectUri: config.SALESFORCE_REDIRECT_URI,
					clientId: this.maskValue(config.SALESFORCE_CLIENT_ID),
					error,
				});
			}
			throw error;
		}
	}

	private async refreshAccessToken(integration: SalesforceIntegrationRow): Promise<SalesforceIntegrationRow> {
		const body = new URLSearchParams({ grant_type: "refresh_token", client_id: config.SALESFORCE_CLIENT_ID, client_secret: config.SALESFORCE_CLIENT_SECRET, refresh_token: integration.refresh_token });
		const response = await axios.post<SalesforceOauthTokenResponse>(`${this.normalizeAuthBaseUrl(integration.auth_base_url)}/services/oauth2/token`, body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: SALESFORCE_SYNC_DELIVERY_TIMEOUT_MS });
		const result = await pool.query<SalesforceIntegrationRow>(`UPDATE salesforce_integrations SET access_token = $2, refresh_token = COALESCE($3, refresh_token), instance_url = COALESCE($4, instance_url), scope = COALESCE($5, scope), token_expires_at = CURRENT_TIMESTAMP + interval '105 minutes', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [integration.id, response.data.access_token ?? integration.access_token, response.data.refresh_token ?? null, response.data.instance_url ?? null, response.data.scope ?? null]);
		if (!result.rows[0]) throw new Error("Failed to refresh Salesforce access token");
		return result.rows[0];
	}

	private async requestSalesforce<T>(integration: SalesforceIntegrationRow, requestConfig: AxiosRequestConfig, retryOnUnauthorized = true): Promise<AxiosResponse<T>> {
		const response = await axios.request<T>({ ...requestConfig, baseURL: integration.instance_url ?? undefined, timeout: SALESFORCE_SYNC_DELIVERY_TIMEOUT_MS, headers: { Authorization: `Bearer ${integration.access_token}`, "Content-Type": "application/json", ...(requestConfig.headers ?? {}) }, validateStatus: () => true });
		if (response.status === 401 && retryOnUnauthorized) {
			const refreshed = await this.refreshAccessToken(integration);
			integration.access_token = refreshed.access_token;
			integration.refresh_token = refreshed.refresh_token;
			integration.instance_url = refreshed.instance_url;
			return this.requestSalesforce<T>(integration, requestConfig, false);
		}
		if (response.status >= 400) throw new Error(`Salesforce API ${requestConfig.method ?? "GET"} ${requestConfig.url} failed with ${response.status}: ${JSON.stringify(response.data)}`);
		return response;
	}

	private async loadLeadSnapshot(userId: string, leadId: string): Promise<LeadSnapshot | null> {
		const result = await pool.query<LeadSnapshot>(`SELECT id, session_id, widget_key_id, name, email, phone, country, company, chat_summary, status, source_url, message_count, follow_up_sent_at, created_at, updated_at FROM leads WHERE id = $1 AND user_id = $2 LIMIT 1`, [leadId, userId]);
		return result.rows[0] ?? null;
	}

	private toNullableString(value: unknown): string | null {
		if (typeof value !== "string") return null;
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	private toNullableNumber(value: unknown): number | null {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	}
	private buildLeadContext(event: SalesforceSyncEventRow, leadSnapshot: LeadSnapshot | null): LeadContext {
		const payload = event.payload ?? {};
		const contact = typeof payload.contact === "object" && payload.contact !== null ? (payload.contact as Record<string, unknown>) : {};
		const metadata = typeof payload.metadata === "object" && payload.metadata !== null ? (payload.metadata as Record<string, unknown>) : {};
		return {
			leadId: leadSnapshot?.id ?? event.lead_id,
			sessionId: leadSnapshot?.session_id ?? this.toNullableString(payload.sessionId),
			name: leadSnapshot?.name ?? this.toNullableString(contact.name),
			email: leadSnapshot?.email ?? this.toNullableString(contact.email),
			phone: leadSnapshot?.phone ?? this.toNullableString(contact.phone),
			country: leadSnapshot?.country ?? this.toNullableString(contact.country),
			company: leadSnapshot?.company ?? this.toNullableString(contact.company),
			chatSummary: leadSnapshot?.chat_summary ?? this.toNullableString(contact.summary),
			status: leadSnapshot?.status ?? this.toNullableString(payload.status),
			sourceUrl: leadSnapshot?.source_url ?? this.toNullableString(metadata.sourceUrl),
			messageCount: leadSnapshot?.message_count ?? this.toNullableNumber(payload.messageCount),
			followUpSentAt: leadSnapshot?.follow_up_sent_at ?? null,
		};
	}

	private parseName(fullName?: string | null): { firstName: string | null; lastName: string } {
		const normalized = (fullName || "").trim();
		if (!normalized) return { firstName: null, lastName: "Visitor" };
		const parts = normalized.split(/\s+/).filter(Boolean);
		if (parts.length === 1) return { firstName: null, lastName: parts[0] };
		return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] || "Visitor" };
	}

	private normalizeWebsite(value?: string | null): string | null {
		if (!value) return null;
		try {
			const parsed = new URL(value);
			return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null;
		} catch {
			return null;
		}
	}

	private escapeSoqlValue(value: string): string {
		return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
	}

	private async getLeadFieldSet(integration: SalesforceIntegrationRow): Promise<Set<string>> {
		const cacheKey = integration.organization_id ?? integration.user_id;
		const cached = this.leadFieldCache.get(cacheKey);
		if (cached) return cached;
		const fallback = new Set<string>(["FirstName", "LastName", "Email", "Phone", "Company", "Country", "Description", "Website", "LeadSource"]);
		try {
			const response = await this.requestSalesforce<SalesforceDescribeResponse>(integration, { method: "GET", url: `/services/data/${SALESFORCE_API_VERSION}/sobjects/Lead/describe` });
			const fields = new Set<string>((response.data.fields ?? []).filter((field) => field.name && (field.createable || field.updateable)).map((field) => field.name as string));
			const finalSet = fields.size > 0 ? fields : fallback;
			this.leadFieldCache.set(cacheKey, finalSet);
			return finalSet;
		} catch {
			this.leadFieldCache.set(cacheKey, fallback);
			return fallback;
		}
	}

	private buildLeadDescription(lead: LeadContext, eventType: string): string {
		return [`Witzo Event: ${eventType}`, lead.status ? `Witzo Status: ${lead.status}` : null, lead.sourceUrl ? `Source URL: ${lead.sourceUrl}` : null, lead.sessionId ? `Session ID: ${lead.sessionId}` : null, lead.messageCount !== null ? `Message Count: ${lead.messageCount}` : null, "", lead.chatSummary ?? "No summary provided."].filter((value): value is string => value !== null).join("\n").slice(0, 32000);
	}

	private async findExistingLeadId(integration: SalesforceIntegrationRow, lead: LeadContext): Promise<string | null> {
		const clauses: string[] = [];
		if (lead.email) clauses.push(`Email = '${this.escapeSoqlValue(lead.email)}'`);
		if (lead.phone) clauses.push(`Phone = '${this.escapeSoqlValue(lead.phone)}'`);
		if (clauses.length === 0) return null;
		const soql = `SELECT Id FROM Lead WHERE ${clauses.join(" OR ")} ORDER BY LastModifiedDate DESC LIMIT 1`;
		const response = await this.requestSalesforce<SalesforceQueryResponse<{ Id?: string }>>(integration, { method: "GET", url: `/services/data/${SALESFORCE_API_VERSION}/query`, params: { q: soql } });
		return response.data.records?.[0]?.Id ?? null;
	}

	private async upsertLead(integration: SalesforceIntegrationRow, lead: LeadContext, eventType: string): Promise<string | null> {
		if (!lead.name && !lead.email && !lead.phone) return null;
		const fields = await this.getLeadFieldSet(integration);
		const { firstName, lastName } = this.parseName(lead.name);
		const payload: Record<string, unknown> = {};
		if (fields.has("LastName")) payload.LastName = lastName;
		if (firstName && fields.has("FirstName")) payload.FirstName = firstName;
		if (lead.email && fields.has("Email")) payload.Email = lead.email;
		if (lead.phone && fields.has("Phone")) payload.Phone = lead.phone;
		if (fields.has("Company")) payload.Company = lead.company?.trim() || "Website Lead";
		if (lead.country && fields.has("Country")) payload.Country = lead.country;
		if (fields.has("Description")) payload.Description = this.buildLeadDescription(lead, eventType);
		if (fields.has("LeadSource")) payload.LeadSource = "Witzo";
		const website = this.normalizeWebsite(lead.sourceUrl);
		if (website && fields.has("Website")) payload.Website = website;
		const existingId = await this.findExistingLeadId(integration, lead);
		if (existingId) {
			await this.requestSalesforce(integration, { method: "PATCH", url: `/services/data/${SALESFORCE_API_VERSION}/sobjects/Lead/${existingId}`, data: payload });
			return existingId;
		}
		const response = await this.requestSalesforce<{ id?: string }>(integration, { method: "POST", url: `/services/data/${SALESFORCE_API_VERSION}/sobjects/Lead`, data: payload });
		return response.data.id ?? null;
	}

	private async createTask(integration: SalesforceIntegrationRow, salesforceLeadId: string, lead: LeadContext, eventType: string): Promise<void> {
		const description = [`Witzo Event: ${eventType}`, lead.status ? `Lead Status: ${lead.status}` : null, lead.sourceUrl ? `Source URL: ${lead.sourceUrl}` : null, lead.sessionId ? `Session ID: ${lead.sessionId}` : null, lead.messageCount !== null ? `Message Count: ${lead.messageCount}` : null, lead.followUpSentAt ? `Follow-up Sent At: ${lead.followUpSentAt.toISOString()}` : null, "", lead.chatSummary ?? "No summary provided."].filter((value): value is string => value !== null).join("\n").slice(0, 32000);
		await this.requestSalesforce(integration, { method: "POST", url: `/services/data/${SALESFORCE_API_VERSION}/sobjects/Task`, data: { WhoId: salesforceLeadId, Subject: `Witzo ${eventType}`, Description: description, ActivityDate: new Date().toISOString().slice(0, 10) } });
	}

	private async syncLeadEventToSalesforce(event: SalesforceSyncEventRow, integration: SalesforceIntegrationRow): Promise<void> {
		if (event.event_type === "lead.test") return;
		const leadSnapshot = event.lead_id ? await this.loadLeadSnapshot(event.user_id, event.lead_id) : null;
		const lead = this.buildLeadContext(event, leadSnapshot);
		let salesforceLeadId: string | null = null;
		if (integration.lead_sync_enabled) {
			salesforceLeadId = await this.upsertLead(integration, lead, event.event_type);
		}
		if (integration.task_sync_enabled && salesforceLeadId) {
			await this.createTask(integration, salesforceLeadId, lead, event.event_type);
		}
	}
	private async markDeliverySuccess(eventId: string): Promise<void> {
		await pool.query(`UPDATE salesforce_sync_events SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP, response_status = 200, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [eventId]);
	}

	private async markDeliveryFailure(event: SalesforceSyncEventRow, errorMessage: string): Promise<void> {
		const exhausted = event.attempts >= event.max_attempts;
		const nextDelayMs = Math.min(SALESFORCE_SYNC_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, event.attempts - 1)), SALESFORCE_SYNC_BACKOFF_MAX_MS);
		await pool.query(`UPDATE salesforce_sync_events SET status = $2::varchar(20), last_error = $3::text, response_status = 500, next_attempt_at = CASE WHEN $2::varchar(20) = 'dead' THEN next_attempt_at ELSE CURRENT_TIMESTAMP + ($4::text || ' milliseconds')::interval END, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [event.id, exhausted ? "dead" : "retrying", errorMessage, nextDelayMs]);
		await pool.query(`UPDATE salesforce_integrations SET last_error = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [event.integration_id, errorMessage]);
	}

	async getConfig(userId: string): Promise<SalesforceIntegrationConfigResponse> {
		await this.ensureCrmAccess(userId);
		return this.mapIntegration(await this.getIntegrationRowByUser(userId));
	}

	async getConnectUrl(userId: string, returnTo?: string): Promise<{ authUrl: string }> {
		await this.ensureCrmAccess(userId);
		this.ensureConfigured();
		const normalizedScopes = this.normalizeScopes(
			config.SALESFORCE_OAUTH_SCOPES,
		);
		const normalizedAuthBaseUrl = this.normalizeAuthBaseUrl();
		const sanitizedReturnTo = this.sanitizeReturnPath(returnTo);
		logger.info("Salesforce connect requested", {
			userId,
			returnTo: sanitizedReturnTo,
			clientId: this.maskValue(config.SALESFORCE_CLIENT_ID),
			redirectUri: config.SALESFORCE_REDIRECT_URI,
			authBaseUrl: normalizedAuthBaseUrl,
			scopes: normalizedScopes,
		});
		const state = this.createOauthState(userId, returnTo);
		const parsedState = this.parseOauthState(state);
		const codeChallenge = this.createPkceCodeChallenge(
			parsedState.codeVerifier,
		);
		const params = new URLSearchParams({
			response_type: "code",
			client_id: config.SALESFORCE_CLIENT_ID,
			scope: normalizedScopes,
			redirect_uri: config.SALESFORCE_REDIRECT_URI,
			state,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		const authUrl = `${normalizedAuthBaseUrl}/services/oauth2/authorize?${params.toString()}`;
		logger.info("Salesforce OAuth auth URL generated", {
			userId,
			clientId: this.maskValue(config.SALESFORCE_CLIENT_ID),
			redirectUri: config.SALESFORCE_REDIRECT_URI,
			authBaseUrl: normalizedAuthBaseUrl,
			scopes: normalizedScopes,
			stateLength: state.length,
			codeChallengeLength: codeChallenge.length,
			authUrlPreview: authUrl.slice(0, 250),
		});
		return { authUrl };
	}

	async handleOauthCallback(input: { code: string; state: string }): Promise<{ redirectTo: string }> {
		this.ensureConfigured();
		logger.info("Salesforce OAuth callback handling started", {
			redirectUri: config.SALESFORCE_REDIRECT_URI,
			authBaseUrl: this.normalizeAuthBaseUrl(),
			codePresent: Boolean(input.code),
			codeLength: input.code.length,
			statePresent: Boolean(input.state),
			stateLength: input.state.length,
		});
		const parsedState = this.parseOauthState(input.state);
		const tokenData = await this.exchangeAuthorizationCode(
			input.code,
			parsedState.codeVerifier,
		);
		if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.instance_url) {
			throw new Error("Salesforce token exchange failed");
		}
		await pool.query(`INSERT INTO salesforce_integrations (user_id, organization_id, organization_name, instance_url, auth_base_url, access_token, refresh_token, scope, token_expires_at, is_active, lead_sync_enabled, task_sync_enabled, last_error) VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP + interval '105 minutes', TRUE, TRUE, TRUE, NULL) ON CONFLICT (user_id) DO UPDATE SET instance_url = EXCLUDED.instance_url, auth_base_url = EXCLUDED.auth_base_url, access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, scope = EXCLUDED.scope, token_expires_at = EXCLUDED.token_expires_at, is_active = TRUE, last_error = NULL, updated_at = CURRENT_TIMESTAMP`, [parsedState.userId, tokenData.instance_url, this.normalizeAuthBaseUrl(), tokenData.access_token, tokenData.refresh_token, tokenData.scope ?? null]);
		const redirectTo = `${config.FRONTEND_URL}${parsedState.returnTo}?salesforce=connected`;
		logger.info("Salesforce OAuth callback completed", {
			userId: parsedState.userId,
			instanceUrl: tokenData.instance_url,
			scope: tokenData.scope ?? null,
			redirectTo,
		});
		return { redirectTo };
	}

	async updateSettings(userId: string, payload: { isActive?: boolean; leadSyncEnabled?: boolean; taskSyncEnabled?: boolean }): Promise<SalesforceIntegrationConfigResponse> {
		await this.ensureCrmAccess(userId);
		const result = await pool.query<SalesforceIntegrationRow>(`UPDATE salesforce_integrations SET is_active = COALESCE($2, is_active), lead_sync_enabled = COALESCE($3, lead_sync_enabled), task_sync_enabled = COALESCE($4, task_sync_enabled), updated_at = CURRENT_TIMESTAMP WHERE user_id = $1 RETURNING *`, [userId, typeof payload.isActive === "boolean" ? payload.isActive : null, typeof payload.leadSyncEnabled === "boolean" ? payload.leadSyncEnabled : null, typeof payload.taskSyncEnabled === "boolean" ? payload.taskSyncEnabled : null]);
		if (!result.rows[0]) throw new Error("Salesforce CRM is not connected yet.");
		return this.mapIntegration(result.rows[0]);
	}

	async disconnect(userId: string): Promise<void> {
		await this.ensureCrmAccess(userId);
		await pool.query(`DELETE FROM salesforce_integrations WHERE user_id = $1`, [userId]);
	}

	async getEvents(userId: string, limit = 50): Promise<SalesforceSyncEventResponse[]> {
		await this.ensureCrmAccess(userId);
		const result = await pool.query<SalesforceSyncEventRow>(`SELECT * FROM salesforce_sync_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, Math.max(1, Math.min(100, limit))]);
		return result.rows.map((row) => this.mapEvent(row));
	}

	async retryEvent(userId: string, eventId: string): Promise<void> {
		await this.ensureCrmAccess(userId);
		const result = await pool.query<SalesforceSyncEventRow>(`UPDATE salesforce_sync_events SET status = 'pending', attempts = 0, next_attempt_at = CURRENT_TIMESTAMP, last_error = NULL, response_status = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 RETURNING *`, [eventId, userId]);
		if (!result.rows[0]) throw new Error("Salesforce sync event not found");
		void this.deliverEventById(eventId).catch((error) => {
			logger.error("Salesforce sync retry dispatch failed", { eventId, error });
		});
	}

	async sendTestEvent(userId: string): Promise<void> {
		await this.ensureCrmAccess(userId);
		const integration = await this.getActiveIntegrationByUser(userId);
		if (!integration) throw new Error("Active Salesforce CRM integration not found. Connect and enable Salesforce first.");
		await this.queueLeadEvent(userId, "lead.test", { eventType: "lead.test", message: "This is a test sync event from Witzo to Salesforce CRM.", emittedAt: new Date().toISOString() }, null);
	}

	async queueLeadEvent(userId: string, eventType: string, payload: Record<string, unknown>, leadId?: string | null): Promise<void> {
		const planType = await this.getUserPlanType(userId);
		if (!getPlanCapabilities(planType).crmIntegration) return;
		const integration = await this.getActiveIntegrationByUser(userId);
		if (!integration) return;
		const insert = await pool.query<{ id: string }>(`INSERT INTO salesforce_sync_events (user_id, lead_id, integration_id, event_type, payload, status, max_attempts) VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6) RETURNING id`, [userId, leadId ?? null, integration.id, eventType, JSON.stringify(payload), SALESFORCE_SYNC_MAX_ATTEMPTS]);
		const eventId = insert.rows[0]?.id;
		if (eventId) {
			void this.deliverEventById(eventId).catch((error) => {
				logger.error("Immediate Salesforce sync dispatch failed", { eventId, error });
			});
		}
	}
	async deliverEventById(eventId: string): Promise<void> {
		const claim = await pool.query<SalesforceSyncEventRow>(`UPDATE salesforce_sync_events SET status = 'processing', attempts = attempts + 1, last_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status IN ('pending', 'retrying') AND next_attempt_at <= CURRENT_TIMESTAMP RETURNING *`, [eventId]);
		const event = claim.rows[0];
		if (!event) return;
		const integration = await this.getIntegrationById(event.integration_id);
		if (!integration || !integration.is_active) {
			await this.markDeliveryFailure(event, "Active Salesforce integration not found");
			return;
		}
		try {
			await this.syncLeadEventToSalesforce(event, integration);
			await this.markDeliverySuccess(event.id);
			await pool.query(`UPDATE salesforce_integrations SET last_synced_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [integration.id]);
		} catch (error) {
			await this.markDeliveryFailure(event, error instanceof Error ? error.message : String(error));
		}
	}

	async processPendingEvents(limit = SALESFORCE_SYNC_PROCESS_BATCH_SIZE): Promise<void> {
		const result = await pool.query<{ id: string }>(`SELECT id FROM salesforce_sync_events WHERE status IN ('pending', 'retrying') AND next_attempt_at <= CURRENT_TIMESTAMP ORDER BY created_at ASC LIMIT $1`, [Math.max(1, limit)]);
		for (const row of result.rows) {
			try {
				await this.deliverEventById(row.id);
			} catch (error) {
				logger.error("Error processing pending Salesforce sync event", { eventId: row.id, error });
			}
		}
	}
}

export const salesforceIntegrationService = new SalesforceIntegrationService();
