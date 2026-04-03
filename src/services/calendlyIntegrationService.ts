import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import crypto from "crypto";
import { config } from "../config/env";
import pool from "../config/database";
import {
	CALENDLY_DEFAULT_SCOPES,
	CALENDLY_DELIVERY_TIMEOUT_MS,
	CALENDLY_WEBHOOK_EVENTS,
} from "../constants";
import logger from "../utils/logger";

type CalendlyIntegrationRow = {
	id: string;
	user_id: string;
	calendly_user_uri: string | null;
	calendly_user_name: string | null;
	calendly_user_email: string | null;
	organization_uri: string | null;
	scheduling_url: string | null;
	access_token: string;
	refresh_token: string;
	scope: string | null;
	token_expires_at: Date | null;
	webhook_subscription_uri: string | null;
	is_active: boolean;
	widget_booking_enabled: boolean;
	booking_intent_enabled: boolean;
	booking_label: string | null;
	selected_event_type_uri: string | null;
	selected_event_type_name: string | null;
	selected_scheduling_url: string | null;
	last_synced_at: Date | null;
	last_error: string | null;
	created_at: Date;
	updated_at: Date;
};

type CalendlyAppointmentRow = {
	id: string;
	user_id: string;
	integration_id: string;
	lead_id: string | null;
	session_id: string | null;
	widget_key_id: number | null;
	event_type_uri: string | null;
	scheduled_event_uri: string;
	scheduled_event_name: string | null;
	invitee_uri: string | null;
	invitee_name: string | null;
	invitee_email: string | null;
	invitee_timezone: string | null;
	status: string;
	start_time: Date | null;
	end_time: Date | null;
	cancel_url: string | null;
	reschedule_url: string | null;
	tracking_json: Record<string, unknown>;
	payload: Record<string, unknown>;
	source: string;
	canceled_at: Date | null;
	created_at: Date;
	updated_at: Date;
};

type ParsedStatePayload = {
	userId: string;
	returnTo: string;
	exp: number;
	nonce: string;
};

type CalendlyOauthTokenResponse = {
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	scope?: string;
	created_at?: number;
	expires_in?: number;
};

type CalendlyUserResource = {
	uri?: string;
	name?: string;
	email?: string;
	scheduling_url?: string;
	current_organization?: string;
	timezone?: string;
};

type CalendlyEventTypeResource = {
	uri?: string;
	name?: string;
	active?: boolean;
	scheduling_url?: string;
	duration?: number;
	kind?: string;
};

type CalendlyCurrentUserResponse = {
	resource?: CalendlyUserResource;
};

type CalendlyCollectionResponse<T> = {
	collection?: T[];
};

type CalendlyWebhookCreateResponse = {
	resource?: {
		uri?: string;
	};
};

type CalendlyInviteeResponse = {
	resource?: {
		uri?: string;
		name?: string;
		email?: string;
		timezone?: string;
		cancel_url?: string;
		reschedule_url?: string;
		event?: string;
		tracking?: Record<string, unknown>;
	};
};

type CalendlyScheduledEventResponse = {
	resource?: {
		uri?: string;
		name?: string;
		start_time?: string;
		end_time?: string;
		event_type?: string;
		status?: string;
	};
};

type CalendlyWebhookPayload = {
	event?: string;
	payload?: {
		event?: string;
		invitee?: string;
	};
};

export type CalendlyEventTypeOption = {
	uri: string;
	name: string;
	schedulingUrl: string;
	durationMinutes: number | null;
	kind: string | null;
};

export type CalendlyIntegrationConfigResponse = {
	connected: boolean;
	isActive: boolean;
	widgetBookingEnabled: boolean;
	bookingIntentEnabled: boolean;
	bookingLabel: string | null;
	calendlyUserName: string | null;
	calendlyUserEmail: string | null;
	calendlyUserUri: string | null;
	organizationUri: string | null;
	scope: string | null;
	selectedEventTypeUri: string | null;
	selectedEventTypeName: string | null;
	selectedSchedulingUrl: string | null;
	webhookActive: boolean;
	lastSyncedAt: Date | null;
	lastError: string | null;
	createdAt: Date | null;
	updatedAt: Date | null;
	eventTypes: CalendlyEventTypeOption[];
};

export type CalendlyAppointmentResponse = {
	id: string;
	leadId: string | null;
	sessionId: string | null;
	scheduledEventName: string | null;
	inviteeName: string | null;
	inviteeEmail: string | null;
	status: string;
	startTime: Date | null;
	endTime: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

export type CalendlyWidgetBookingAction = {
	schedulingUrl: string;
	bookingLabel: string;
	prefill: {
		name?: string;
		email?: string;
	};
	tracking: {
		sessionId: string;
		leadId?: string | null;
	};
};

const CALENDLY_STATE_TTL_MS = 10 * 60 * 1000;
const CALENDLY_DEFAULT_RETURN_TO = "/dashboard/calendly";
const CALENDLY_STATE_VERSION = "v1";

class CalendlyIntegrationService {
	private maskValue(value?: string | null, visiblePrefix = 6, visibleSuffix = 4): string | null {
		if (!value) return null;
		if (value.length <= visiblePrefix + visibleSuffix) return value;
		return `${value.slice(0, visiblePrefix)}...${value.slice(-visibleSuffix)}`;
	}

	private normalizeScopes(raw: string): string {
		const parsed = raw.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
		return Array.from(new Set(parsed.length > 0 ? parsed : [...CALENDLY_DEFAULT_SCOPES])).join(" ");
	}

	private normalizeBaseUrl(value?: string | null): string {
		return (value || "").trim().replace(/\/+$/, "");
	}

	private sanitizeReturnPath(value?: string): string {
		if (!value) return CALENDLY_DEFAULT_RETURN_TO;
		const normalized = value.trim();
		if (normalized.length === 0 || normalized.length > 256 || !normalized.startsWith("/") || normalized.startsWith("//") || !normalized.startsWith("/dashboard")) {
			return CALENDLY_DEFAULT_RETURN_TO;
		}
		return normalized;
	}

	private ensureConfigured(): void {
		if (!config.CALENDLY_CLIENT_ID || !config.CALENDLY_CLIENT_SECRET || !config.CALENDLY_REDIRECT_URI) {
			throw new Error("Calendly integration is not configured. Please set CALENDLY_CLIENT_ID, CALENDLY_CLIENT_SECRET, and CALENDLY_REDIRECT_URI.");
		}
	}

	private getStateEncryptionKey(): Buffer {
		return crypto.createHash("sha256").update(config.COOKIE_SECRET).digest();
	}

	private createOauthState(userId: string, returnTo?: string): string {
		const payload: ParsedStatePayload = {
			userId,
			returnTo: this.sanitizeReturnPath(returnTo),
			exp: Date.now() + CALENDLY_STATE_TTL_MS,
			nonce: crypto.randomBytes(16).toString("hex"),
		};
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv("aes-256-gcm", this.getStateEncryptionKey(), iv);
		const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
		const authTag = cipher.getAuthTag();
		return [CALENDLY_STATE_VERSION, iv.toString("base64url"), authTag.toString("base64url"), ciphertext.toString("base64url")].join(".");
	}

	private parseOauthState(state: string): ParsedStatePayload {
		const [version, ivRaw, authTagRaw, ciphertextRaw] = state.split(".");
		if (version !== CALENDLY_STATE_VERSION || !ivRaw || !authTagRaw || !ciphertextRaw) {
			throw new Error("Invalid Calendly OAuth state payload");
		}

		let payload: ParsedStatePayload;
		try {
			const decipher = crypto.createDecipheriv("aes-256-gcm", this.getStateEncryptionKey(), Buffer.from(ivRaw, "base64url"));
			decipher.setAuthTag(Buffer.from(authTagRaw, "base64url"));
			const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]);
			payload = JSON.parse(decrypted.toString("utf8")) as ParsedStatePayload;
		} catch {
			throw new Error("Invalid Calendly OAuth state payload");
		}

		if (typeof payload.userId !== "string" || typeof payload.returnTo !== "string" || typeof payload.exp !== "number" || typeof payload.nonce !== "string" || payload.exp < Date.now()) {
			throw new Error("Calendly OAuth state has expired or is invalid. Please reconnect.");
		}

		return {
			...payload,
			returnTo: this.sanitizeReturnPath(payload.returnTo),
		};
	}

	private getAuthBaseUrl(): string {
		return this.normalizeBaseUrl(config.CALENDLY_AUTH_BASE_URL || "https://auth.calendly.com");
	}

	private getApiBaseUrl(): string {
		return this.normalizeBaseUrl(config.CALENDLY_API_BASE_URL || "https://api.calendly.com");
	}

	private getWebhookBaseUrl(): string {
		return this.normalizeBaseUrl(config.WIDGET_API_URL || "http://localhost:3000");
	}

	private getWebhookTargetUrl(integrationId: string): string {
		return `${this.getWebhookBaseUrl()}/api/v1/calendly/webhook/${integrationId}`;
	}

	private buildTokenExpiry(expiresIn?: number | null): Date {
		const safeSeconds = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200;
		return new Date(Date.now() + safeSeconds * 1000);
	}

	private async getIntegrationRowByUser(userId: string): Promise<CalendlyIntegrationRow | null> {
		const result = await pool.query<CalendlyIntegrationRow>(`SELECT * FROM calendly_integrations WHERE user_id = $1 LIMIT 1`, [userId]);
		return result.rows[0] ?? null;
	}

	private async getActiveIntegrationByUser(userId: string): Promise<CalendlyIntegrationRow | null> {
		const result = await pool.query<CalendlyIntegrationRow>(`SELECT * FROM calendly_integrations WHERE user_id = $1 AND is_active = TRUE LIMIT 1`, [userId]);
		return result.rows[0] ?? null;
	}

	private async getIntegrationById(id: string): Promise<CalendlyIntegrationRow | null> {
		const result = await pool.query<CalendlyIntegrationRow>(`SELECT * FROM calendly_integrations WHERE id = $1 LIMIT 1`, [id]);
		return result.rows[0] ?? null;
	}

	private mapAppointment(row: CalendlyAppointmentRow): CalendlyAppointmentResponse {
		return {
			id: row.id,
			leadId: row.lead_id,
			sessionId: row.session_id,
			scheduledEventName: row.scheduled_event_name,
			inviteeName: row.invitee_name,
			inviteeEmail: row.invitee_email,
			status: row.status,
			startTime: row.start_time,
			endTime: row.end_time,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private async requestCalendlyWithToken<T>(accessToken: string, requestConfig: AxiosRequestConfig): Promise<AxiosResponse<T>> {
		return axios.request<T>({
			...requestConfig,
			baseURL: this.getApiBaseUrl(),
			timeout: CALENDLY_DELIVERY_TIMEOUT_MS,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				...(requestConfig.headers ?? {}),
			},
		});
	}

	private async exchangeAuthorizationCode(code: string): Promise<CalendlyOauthTokenResponse> {
		const tokenUrl = `${this.getAuthBaseUrl()}/oauth/token`;
		logger.info("Calendly OAuth token exchange starting", {
			tokenUrl,
			redirectUri: config.CALENDLY_REDIRECT_URI,
			clientId: this.maskValue(config.CALENDLY_CLIENT_ID),
			codePresent: Boolean(code),
		});

		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: config.CALENDLY_CLIENT_ID,
			client_secret: config.CALENDLY_CLIENT_SECRET,
			redirect_uri: config.CALENDLY_REDIRECT_URI,
		});

		try {
			const response = await axios.post<CalendlyOauthTokenResponse>(tokenUrl, body.toString(), {
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				timeout: CALENDLY_DELIVERY_TIMEOUT_MS,
			});
			return response.data;
		} catch (error) {
			logger.error("Calendly OAuth token exchange failed", {
				tokenUrl,
				redirectUri: config.CALENDLY_REDIRECT_URI,
				clientId: this.maskValue(config.CALENDLY_CLIENT_ID),
				error: axios.isAxiosError(error) ? { status: error.response?.status ?? null, data: error.response?.data ?? null, message: error.message } : error,
			});
			throw error;
		}
	}

	private async refreshAccessToken(integration: CalendlyIntegrationRow): Promise<CalendlyIntegrationRow> {
		const tokenUrl = `${this.getAuthBaseUrl()}/oauth/token`;
		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: integration.refresh_token,
			client_id: config.CALENDLY_CLIENT_ID,
			client_secret: config.CALENDLY_CLIENT_SECRET,
		});
		const response = await axios.post<CalendlyOauthTokenResponse>(tokenUrl, body.toString(), {
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			timeout: CALENDLY_DELIVERY_TIMEOUT_MS,
		});
		const result = await pool.query<CalendlyIntegrationRow>(
			`UPDATE calendly_integrations
			 SET access_token = $2,
			     refresh_token = COALESCE($3, refresh_token),
			     scope = COALESCE($4, scope),
			     token_expires_at = $5,
			     last_error = NULL,
			     updated_at = CURRENT_TIMESTAMP
			 WHERE id = $1
			 RETURNING *`,
			[integration.id, response.data.access_token ?? integration.access_token, response.data.refresh_token ?? null, response.data.scope ?? null, this.buildTokenExpiry(response.data.expires_in ?? null)],
		);
		if (!result.rows[0]) throw new Error("Failed to refresh Calendly access token");
		return result.rows[0];
	}

	private async ensureValidIntegration(integration: CalendlyIntegrationRow): Promise<CalendlyIntegrationRow> {
		if (!integration.token_expires_at || integration.token_expires_at.getTime() <= Date.now() + 60_000) {
			return this.refreshAccessToken(integration);
		}
		return integration;
	}

	private async requestCalendly<T>(integration: CalendlyIntegrationRow, requestConfig: AxiosRequestConfig, retryOnUnauthorized = true): Promise<AxiosResponse<T>> {
		const activeIntegration = await this.ensureValidIntegration(integration);
		const response = await axios.request<T>({
			...requestConfig,
			baseURL: this.getApiBaseUrl(),
			timeout: CALENDLY_DELIVERY_TIMEOUT_MS,
			headers: {
				Authorization: `Bearer ${activeIntegration.access_token}`,
				"Content-Type": "application/json",
				...(requestConfig.headers ?? {}),
			},
			validateStatus: () => true,
		});

		if (response.status === 401 && retryOnUnauthorized) {
			const refreshed = await this.refreshAccessToken(activeIntegration);
			return this.requestCalendly<T>(refreshed, requestConfig, false);
		}

		if (response.status >= 400) {
			throw new Error(`Calendly API ${requestConfig.method ?? "GET"} ${requestConfig.url} failed with ${response.status}: ${JSON.stringify(response.data)}`);
		}

		return response;
	}

	private async fetchCurrentUser(accessToken: string): Promise<CalendlyUserResource> {
		const response = await this.requestCalendlyWithToken<CalendlyCurrentUserResponse>(accessToken, {
			method: "GET",
			url: "/users/me",
		});
		return response.data.resource ?? {};
	}

	private async listEventTypes(integration: CalendlyIntegrationRow): Promise<CalendlyEventTypeOption[]> {
		if (!integration.calendly_user_uri) return [];
		const response = await this.requestCalendly<CalendlyCollectionResponse<CalendlyEventTypeResource>>(integration, {
			method: "GET",
			url: "/event_types",
			params: {
				user: integration.calendly_user_uri,
				active: true,
				count: 100,
			},
		});
		return (response.data.collection ?? [])
			.filter((item) => item.uri && item.scheduling_url && item.name)
			.map((item) => ({
				uri: item.uri as string,
				name: item.name as string,
				schedulingUrl: item.scheduling_url as string,
				durationMinutes: typeof item.duration === "number" ? item.duration : null,
				kind: typeof item.kind === "string" ? item.kind : null,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private async createWebhookSubscription(integration: CalendlyIntegrationRow): Promise<string | null> {
		if (!integration.calendly_user_uri) return null;
		const targetUrl = this.getWebhookTargetUrl(integration.id);
		try {
			const response = await this.requestCalendly<CalendlyWebhookCreateResponse>(integration, {
				method: "POST",
				url: "/webhook_subscriptions",
				data: {
					url: targetUrl,
					events: [...CALENDLY_WEBHOOK_EVENTS],
					scope: "user",
					user: integration.calendly_user_uri,
				},
			});
			return response.data.resource?.uri ?? null;
		} catch (error) {
			logger.warn("Failed to create Calendly webhook subscription", {
				integrationId: integration.id,
				targetUrl,
				error: error instanceof Error ? error.message : error,
			});
			return null;
		}
	}

	private async deleteWebhookSubscription(integration: CalendlyIntegrationRow): Promise<void> {
		if (!integration.webhook_subscription_uri) return;
		const webhookPath = integration.webhook_subscription_uri.startsWith("http") ? integration.webhook_subscription_uri.replace(this.getApiBaseUrl(), "") : integration.webhook_subscription_uri;
		try {
			await this.requestCalendly(integration, { method: "DELETE", url: webhookPath });
		} catch (error) {
			logger.warn("Failed to delete Calendly webhook subscription", {
				integrationId: integration.id,
				webhookSubscriptionUri: integration.webhook_subscription_uri,
				error: error instanceof Error ? error.message : error,
			});
		}
	}

	private async loadLeadContext(userId: string, sessionId: string): Promise<{ leadId: string | null; name: string | null; email: string | null }> {
		const result = await pool.query<{ id: string; name: string | null; email: string | null }>(
			`SELECT id, name, email
			 FROM leads
			 WHERE user_id = $1 AND session_id = $2
			 ORDER BY updated_at DESC
			 LIMIT 1`,
			[userId, sessionId],
		);
		return {
			leadId: result.rows[0]?.id ?? null,
			name: result.rows[0]?.name ?? null,
			email: result.rows[0]?.email ?? null,
		};
	}

	private buildTrackingInfo(sessionId: string, leadId?: string | null): { sessionId: string; leadId?: string | null } {
		return {
			sessionId,
			...(leadId ? { leadId } : {}),
		};
	}

	private mapConfig(row: CalendlyIntegrationRow | null, eventTypes: CalendlyEventTypeOption[] = []): CalendlyIntegrationConfigResponse {
		if (!row) {
			return {
				connected: false,
				isActive: false,
				widgetBookingEnabled: true,
				bookingIntentEnabled: true,
				bookingLabel: "Book an appointment",
				calendlyUserName: null,
				calendlyUserEmail: null,
				calendlyUserUri: null,
				organizationUri: null,
				scope: null,
				selectedEventTypeUri: null,
				selectedEventTypeName: null,
				selectedSchedulingUrl: null,
				webhookActive: false,
				lastSyncedAt: null,
				lastError: null,
				createdAt: null,
				updatedAt: null,
				eventTypes,
			};
		}

		return {
			connected: true,
			isActive: row.is_active,
			widgetBookingEnabled: row.widget_booking_enabled,
			bookingIntentEnabled: row.booking_intent_enabled,
			bookingLabel: row.booking_label,
			calendlyUserName: row.calendly_user_name,
			calendlyUserEmail: row.calendly_user_email,
			calendlyUserUri: row.calendly_user_uri,
			organizationUri: row.organization_uri,
			scope: row.scope,
			selectedEventTypeUri: row.selected_event_type_uri,
			selectedEventTypeName: row.selected_event_type_name,
			selectedSchedulingUrl: row.selected_scheduling_url,
			webhookActive: Boolean(row.webhook_subscription_uri),
			lastSyncedAt: row.last_synced_at,
			lastError: row.last_error,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			eventTypes,
		};
	}

	private verifyWebhookSignature(rawBody: string, signatureHeader?: string | null): boolean {
		if (!config.CALENDLY_WEBHOOK_SIGNING_KEY) return true;
		if (!signatureHeader) return false;
		const parts = signatureHeader.split(",").reduce<Record<string, string>>((acc, part) => {
			const [key, value] = part.split("=").map((item) => item.trim());
			if (key && value) acc[key] = value;
			return acc;
		}, {});
		const timestamp = parts.t;
		const providedSignature = parts.v1;
		if (!timestamp || !providedSignature) return false;
		const expectedSignature = crypto
			.createHmac("sha256", config.CALENDLY_WEBHOOK_SIGNING_KEY)
			.update(`${timestamp}.${rawBody}`)
			.digest("hex");
		try {
			return crypto.timingSafeEqual(Buffer.from(expectedSignature, "hex"), Buffer.from(providedSignature, "hex"));
		} catch {
			return false;
		}
	}

	private async resolveLeadAndWidget(userId: string, sessionId: string | null, widgetKey: string | null): Promise<{ leadId: string | null; widgetKeyId: number | null }> {
		let leadId: string | null = null;
		let widgetKeyId: number | null = null;

		if (sessionId) {
			const leadResult = await pool.query<{ id: string }>(
				`SELECT id
				 FROM leads
				 WHERE user_id = $1 AND session_id = $2
				 ORDER BY updated_at DESC
				 LIMIT 1`,
				[userId, sessionId],
			);
			leadId = leadResult.rows[0]?.id ?? null;
		}

		if (widgetKey) {
			const widgetResult = await pool.query<{ id: number }>(
				`SELECT id
				 FROM widget_keys
				 WHERE user_id = $1 AND widget_key = $2
				 LIMIT 1`,
				[userId, widgetKey],
			);
			widgetKeyId = widgetResult.rows[0]?.id ?? null;
		}

		return { leadId, widgetKeyId };
	}

	async getConfig(userId: string): Promise<CalendlyIntegrationConfigResponse> {
		this.ensureConfigured();
		const row = await this.getIntegrationRowByUser(userId);
		if (!row) return this.mapConfig(null, []);

		try {
			const eventTypes = row.is_active ? await this.listEventTypes(row) : [];
			return this.mapConfig(row, eventTypes);
		} catch (error) {
			logger.warn("Failed to fetch Calendly event types for config", {
				userId,
				error: error instanceof Error ? error.message : error,
			});
			return this.mapConfig(row, []);
		}
	}

	async getConnectUrl(userId: string, returnTo?: string): Promise<{ authUrl: string }> {
		this.ensureConfigured();
		const state = this.createOauthState(userId, returnTo);
		const normalizedScopes = this.normalizeScopes(config.CALENDLY_OAUTH_SCOPES);
		const params = new URLSearchParams({
			client_id: config.CALENDLY_CLIENT_ID,
			response_type: "code",
			redirect_uri: config.CALENDLY_REDIRECT_URI,
			scope: normalizedScopes,
			state,
		});
		const authUrl = `${this.getAuthBaseUrl()}/oauth/authorize?${params.toString()}`;
		logger.info("Calendly OAuth auth URL generated", {
			userId,
			clientId: this.maskValue(config.CALENDLY_CLIENT_ID),
			redirectUri: config.CALENDLY_REDIRECT_URI,
			authBaseUrl: this.getAuthBaseUrl(),
			scopes: normalizedScopes,
		});
		return { authUrl };
	}

	async handleOauthCallback(input: { code: string; state: string }): Promise<{ redirectTo: string }> {
		this.ensureConfigured();
		const parsedState = this.parseOauthState(input.state);
		const tokenData = await this.exchangeAuthorizationCode(input.code);
		if (!tokenData.access_token || !tokenData.refresh_token) {
			throw new Error("Calendly token exchange failed");
		}

		const currentUser = await this.fetchCurrentUser(tokenData.access_token);
		const result = await pool.query<CalendlyIntegrationRow>(
			`INSERT INTO calendly_integrations (
				user_id,
				calendly_user_uri,
				calendly_user_name,
				calendly_user_email,
				organization_uri,
				scheduling_url,
				access_token,
				refresh_token,
				scope,
				token_expires_at,
				is_active,
				widget_booking_enabled,
				booking_intent_enabled,
				booking_label,
				last_error
			) VALUES (
				$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, TRUE, TRUE, 'Book an appointment', NULL
			)
			ON CONFLICT (user_id) DO UPDATE SET
				calendly_user_uri = EXCLUDED.calendly_user_uri,
				calendly_user_name = EXCLUDED.calendly_user_name,
				calendly_user_email = EXCLUDED.calendly_user_email,
				organization_uri = EXCLUDED.organization_uri,
				scheduling_url = EXCLUDED.scheduling_url,
				access_token = EXCLUDED.access_token,
				refresh_token = EXCLUDED.refresh_token,
				scope = EXCLUDED.scope,
				token_expires_at = EXCLUDED.token_expires_at,
				is_active = TRUE,
				last_error = NULL,
				updated_at = CURRENT_TIMESTAMP
			RETURNING *`,
			[
				parsedState.userId,
				currentUser.uri ?? null,
				currentUser.name ?? null,
				currentUser.email ?? null,
				currentUser.current_organization ?? null,
				currentUser.scheduling_url ?? null,
				tokenData.access_token,
				tokenData.refresh_token,
				tokenData.scope ?? null,
				this.buildTokenExpiry(tokenData.expires_in ?? null),
			],
		);

		let integration = result.rows[0];
		if (!integration) {
			throw new Error("Failed to save Calendly integration");
		}

		const eventTypes = await this.listEventTypes(integration);
		if (!integration.selected_event_type_uri && eventTypes[0]) {
			const updated = await pool.query<CalendlyIntegrationRow>(
				`UPDATE calendly_integrations
				 SET selected_event_type_uri = $2,
				     selected_event_type_name = $3,
				     selected_scheduling_url = $4,
				     updated_at = CURRENT_TIMESTAMP
				 WHERE id = $1
				 RETURNING *`,
				[integration.id, eventTypes[0].uri, eventTypes[0].name, eventTypes[0].schedulingUrl],
			);
			integration = updated.rows[0] ?? integration;
		}

		const webhookSubscriptionUri = await this.createWebhookSubscription(integration);
		if (webhookSubscriptionUri) {
			const updated = await pool.query<CalendlyIntegrationRow>(
				`UPDATE calendly_integrations
				 SET webhook_subscription_uri = $2,
				     last_error = NULL,
				     updated_at = CURRENT_TIMESTAMP
				 WHERE id = $1
				 RETURNING *`,
				[integration.id, webhookSubscriptionUri],
			);
			integration = updated.rows[0] ?? integration;
		}

		const redirectTo = `${config.FRONTEND_URL}${parsedState.returnTo}?calendly=connected`;
		logger.info("Calendly OAuth callback completed", {
			userId: parsedState.userId,
			calendlyUserUri: integration.calendly_user_uri,
			selectedEventTypeUri: integration.selected_event_type_uri,
			webhookActive: Boolean(integration.webhook_subscription_uri),
			redirectTo,
		});
		return { redirectTo };
	}

	async updateSettings(
		userId: string,
		payload: {
			isActive?: boolean;
			widgetBookingEnabled?: boolean;
			bookingIntentEnabled?: boolean;
			bookingLabel?: string;
			selectedEventTypeUri?: string | null;
		},
	): Promise<CalendlyIntegrationConfigResponse> {
		this.ensureConfigured();
		const existing = await this.getIntegrationRowByUser(userId);
		if (!existing) {
			throw new Error("Calendly is not connected yet.");
		}

		let selectedEventTypeUri = existing.selected_event_type_uri;
		let selectedEventTypeName = existing.selected_event_type_name;
		let selectedSchedulingUrl = existing.selected_scheduling_url;

		if (payload.selectedEventTypeUri !== undefined) {
			if (!payload.selectedEventTypeUri) {
				selectedEventTypeUri = null;
				selectedEventTypeName = null;
				selectedSchedulingUrl = null;
			} else {
				const eventTypes = await this.listEventTypes(existing);
				const matchedEventType = eventTypes.find((item) => item.uri === payload.selectedEventTypeUri);
				if (!matchedEventType) {
					throw new Error("Selected Calendly event type was not found.");
				}
				selectedEventTypeUri = matchedEventType.uri;
				selectedEventTypeName = matchedEventType.name;
				selectedSchedulingUrl = matchedEventType.schedulingUrl;
			}
		}

		const result = await pool.query<CalendlyIntegrationRow>(
			`UPDATE calendly_integrations
			 SET is_active = COALESCE($2, is_active),
			     widget_booking_enabled = COALESCE($3, widget_booking_enabled),
			     booking_intent_enabled = COALESCE($4, booking_intent_enabled),
			     booking_label = COALESCE($5, booking_label),
			     selected_event_type_uri = $6,
			     selected_event_type_name = $7,
			     selected_scheduling_url = $8,
			     updated_at = CURRENT_TIMESTAMP
			 WHERE user_id = $1
			 RETURNING *`,
			[
				userId,
				typeof payload.isActive === "boolean" ? payload.isActive : null,
				typeof payload.widgetBookingEnabled === "boolean" ? payload.widgetBookingEnabled : null,
				typeof payload.bookingIntentEnabled === "boolean" ? payload.bookingIntentEnabled : null,
				typeof payload.bookingLabel === "string" ? payload.bookingLabel.trim().slice(0, 120) : null,
				selectedEventTypeUri,
				selectedEventTypeName,
				selectedSchedulingUrl,
			],
		);

		const updated = result.rows[0];
		if (!updated) {
			throw new Error("Failed to update Calendly settings");
		}

		const eventTypes = await this.listEventTypes(updated);
		return this.mapConfig(updated, eventTypes);
	}

	async disconnect(userId: string): Promise<void> {
		const integration = await this.getIntegrationRowByUser(userId);
		if (integration) {
			await this.deleteWebhookSubscription(integration);
		}
		await pool.query(`DELETE FROM calendly_integrations WHERE user_id = $1`, [userId]);
	}

	async listAppointments(userId: string, limit = 50): Promise<CalendlyAppointmentResponse[]> {
		const result = await pool.query<CalendlyAppointmentRow>(
			`SELECT *
			 FROM calendly_appointments
			 WHERE user_id = $1
			 ORDER BY created_at DESC
			 LIMIT $2`,
			[userId, Math.max(1, Math.min(100, limit))],
		);
		return result.rows.map((row) => this.mapAppointment(row));
	}

	async getWidgetBookingAction(userId: string, sessionId: string): Promise<CalendlyWidgetBookingAction | null> {
		const integration = await this.getActiveIntegrationByUser(userId);
		if (!integration || !integration.widget_booking_enabled || !integration.booking_intent_enabled || !integration.selected_scheduling_url) {
			return null;
		}

		const leadContext = await this.loadLeadContext(userId, sessionId);
		return {
			schedulingUrl: integration.selected_scheduling_url,
			bookingLabel: integration.booking_label?.trim() || "Book an appointment",
			prefill: {
				...(leadContext.name ? { name: leadContext.name } : {}),
				...(leadContext.email ? { email: leadContext.email } : {}),
			},
			tracking: this.buildTrackingInfo(sessionId, leadContext.leadId),
		};
	}

	async processWebhook(
		integrationId: string,
		rawBody: string,
		signatureHeader: string | null | undefined,
		body: CalendlyWebhookPayload,
	): Promise<void> {
		if (!this.verifyWebhookSignature(rawBody, signatureHeader)) {
			throw new Error("Invalid Calendly webhook signature");
		}

		const integration = await this.getIntegrationById(integrationId);
		if (!integration) {
			throw new Error("Calendly integration not found");
		}

		const eventName = body.event ?? "";
		if (!["invitee.created", "invitee.canceled"].includes(eventName)) {
			return;
		}

		const inviteeUri = body.payload?.invitee;
		const scheduledEventUri = body.payload?.event;
		if (!inviteeUri || !scheduledEventUri) {
			throw new Error("Calendly webhook payload is missing invitee or event URI");
		}

		const inviteeResponse = await this.requestCalendly<CalendlyInviteeResponse>(integration, {
			method: "GET",
			url: inviteeUri.replace(this.getApiBaseUrl(), ""),
		});
		const scheduledEventResponse = await this.requestCalendly<CalendlyScheduledEventResponse>(integration, {
			method: "GET",
			url: scheduledEventUri.replace(this.getApiBaseUrl(), ""),
		});

		const tracking = (inviteeResponse.data.resource?.tracking ?? {}) as Record<string, unknown>;
		const sessionId = typeof tracking.utm_content === "string" && tracking.utm_content.trim() ? tracking.utm_content.trim() : null;
		const widgetKey = typeof tracking.utm_source === "string" && tracking.utm_source.trim() ? tracking.utm_source.trim() : null;
		const fallbackLeadId = typeof tracking.utm_term === "string" && tracking.utm_term.trim() ? tracking.utm_term.trim() : null;
		const resolvedIds = await this.resolveLeadAndWidget(integration.user_id, sessionId, widgetKey);
		const leadId = resolvedIds.leadId ?? fallbackLeadId;

		await pool.query(
			`INSERT INTO calendly_appointments (
				user_id, integration_id, lead_id, session_id, widget_key_id, event_type_uri,
				scheduled_event_uri, scheduled_event_name, invitee_uri, invitee_name, invitee_email,
				invitee_timezone, status, start_time, end_time, cancel_url, reschedule_url,
				tracking_json, payload, source, canceled_at
			) VALUES (
				$1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
				$11, $12, $13, $14, $15, $16, $17, $18::jsonb,
				$19::jsonb, 'webhook', $20
			)
			ON CONFLICT (scheduled_event_uri) DO UPDATE SET
				lead_id = EXCLUDED.lead_id,
				session_id = EXCLUDED.session_id,
				widget_key_id = EXCLUDED.widget_key_id,
				event_type_uri = EXCLUDED.event_type_uri,
				scheduled_event_name = EXCLUDED.scheduled_event_name,
				invitee_uri = EXCLUDED.invitee_uri,
				invitee_name = EXCLUDED.invitee_name,
				invitee_email = EXCLUDED.invitee_email,
				invitee_timezone = EXCLUDED.invitee_timezone,
				status = EXCLUDED.status,
				start_time = EXCLUDED.start_time,
				end_time = EXCLUDED.end_time,
				cancel_url = EXCLUDED.cancel_url,
				reschedule_url = EXCLUDED.reschedule_url,
				tracking_json = EXCLUDED.tracking_json,
				payload = EXCLUDED.payload,
				canceled_at = EXCLUDED.canceled_at,
				updated_at = CURRENT_TIMESTAMP`,
			[
				integration.user_id,
				integration.id,
				leadId,
				sessionId,
				resolvedIds.widgetKeyId,
				scheduledEventResponse.data.resource?.event_type ?? null,
				scheduledEventUri,
				scheduledEventResponse.data.resource?.name ?? null,
				inviteeUri,
				inviteeResponse.data.resource?.name ?? null,
				inviteeResponse.data.resource?.email ?? null,
				inviteeResponse.data.resource?.timezone ?? null,
				eventName === "invitee.canceled" ? "canceled" : "scheduled",
				scheduledEventResponse.data.resource?.start_time ?? null,
				scheduledEventResponse.data.resource?.end_time ?? null,
				inviteeResponse.data.resource?.cancel_url ?? null,
				inviteeResponse.data.resource?.reschedule_url ?? null,
				JSON.stringify(tracking),
				JSON.stringify({
					webhook: body,
					invitee: inviteeResponse.data.resource ?? null,
					scheduledEvent: scheduledEventResponse.data.resource ?? null,
				}),
				eventName === "invitee.canceled" ? new Date().toISOString() : null,
			],
		);

		await pool.query(
			`UPDATE calendly_integrations
			 SET last_synced_at = CURRENT_TIMESTAMP,
			     last_error = NULL,
			     updated_at = CURRENT_TIMESTAMP
			 WHERE id = $1`,
			[integration.id],
		);

		logger.info("Calendly webhook processed", {
			integrationId,
			event: eventName,
			sessionId,
			leadId,
			scheduledEventUri,
		});
	}
}

export const calendlyIntegrationService = new CalendlyIntegrationService();
