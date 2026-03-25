import { PoolClient } from "pg";
import { Paddle, Environment, EventName } from "@paddle/paddle-node-sdk";
import {
	PLAN_CONVERSATION_DEFAULT_LIMITS,
	PlanType,
	SCRAPER_PAGE_LIMIT,
} from "../config/planConfig";
import { config } from "../config/env";
import pool from "../config/database";
import logger from "../utils/logger";

export type BillingCycle = "monthly" | "yearly";

type PlanRow = {
	id: number;
	name: string;
	description: string | null;
	monthly_price: number;
	yearly_price: number;
	paddle_monthly_price_id: string | null;
	paddle_yearly_price_id: string | null;
	features: unknown;
	is_active: boolean;
	created_at: Date;
	updated_at: Date;
};

type SubscriptionRow = {
	id: string;
	user_id: string;
	plan_id: number;
	billing_cycle: BillingCycle;
	paddle_subscription_id: string | null;
	paddle_customer_id: string | null;
	status: string;
	start_date: Date | null;
	end_date: Date | null;
	next_billing_date: Date | null;
	auto_renew: boolean;
	cancel_at_cycle_end: boolean;
	metadata: unknown;
	created_at: Date;
	updated_at: Date;
};

type SubscriptionWithPlanRow = SubscriptionRow & {
	plan_name: string;
	plan_description: string | null;
	monthly_price: number;
	yearly_price: number;
	paddle_monthly_price_id: string | null;
	paddle_yearly_price_id: string | null;
	features: unknown;
	is_active: boolean;
};

export interface BillingPlan {
	id: number;
	name: string;
	description: string | null;
	monthlyPrice: number;
	yearlyPrice: number;
	paddleMonthlyPriceId: string | null;
	paddleYearlyPriceId: string | null;
	features: unknown;
	isActive: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface SubscriptionSummary {
	id: string;
	planId: number;
	planName: string;
	planDescription: string | null;
	billingCycle: BillingCycle;
	paddleSubscriptionId: string | null;
	paddleCustomerId: string | null;
	status: string;
	startDate: string | null;
	endDate: string | null;
	nextBillingDate: string | null;
	autoRenew: boolean;
	cancelAtCycleEnd: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface CurrentSubscriptionResponse {
	currentPlan: BillingPlan | null;
	subscription: SubscriptionSummary | null;
}

export interface GetCheckoutInfoInput {
	planId?: number;
	planName?: string;
	billingCycle: BillingCycle;
}

export interface GetCheckoutInfoResponse {
	priceId: string;
	billingCycle: BillingCycle;
	amount: number;
	currency: string;
	planName: string;
	description: string;
	transactionId: string;
}

export interface PaddleRuntimeConfigResponse {
	clientToken: string;
	environment: "sandbox" | "production";
}

export interface PaymentRecord {
	id: string;
	paddle_transaction_id: string | null;
	plan_id: number | null;
	amount: number;
	currency: string;
	payment_status: string;
	created_at: string;
	raw_payload: Record<string, unknown> | null;
}

export interface PaymentStatusResponse {
	transactionId: string;
	transactionStatus: string;
	paymentStatus: "success" | "pending" | "failed";
	planName: string | null;
	billingCycle: BillingCycle | null;
	amount: number | null;
	currency: string | null;
	subscriptionStatus: string | null;
	nextBillingDate: string | null;
	invoiceUrl: string | null;
}

export interface CancelSubscriptionInput {
	cancelAtCycleEnd?: boolean;
}

export interface UpgradeSubscriptionInput {
	planId?: number;
	planName?: string;
	billingCycle: BillingCycle;
}

export interface UpsertPlanInput {
	name: string;
	description?: string | null;
	monthlyPrice: number;
	yearlyPrice: number;
	paddleMonthlyPriceId?: string | null;
	paddleYearlyPriceId?: string | null;
	features?: unknown;
	isActive?: boolean;
}

const ENTITLED_SUBSCRIPTION_STATUSES = ["active", "trialing"];

const KNOWN_PLAN_NAMES: PlanType[] = [
	"free",
	"basic",
	"standard",
	"enterprise",
];

class SubscriptionService {
	private readonly paddle: Paddle | null;

	constructor() {
		if (config.PADDLE_API_KEY) {
			const isProd =
				config.PADDLE_ENVIRONMENT === "production";
			this.paddle = new Paddle(config.PADDLE_API_KEY, {
				environment: isProd
					? Environment.production
					: Environment.sandbox,
			});
		} else {
			this.paddle = null;
			logger.warn(
				"Paddle is not configured. Set PADDLE_API_KEY to enable billing.",
			);
		}
	}

	private getPaddleClient(): Paddle {
		if (!this.paddle) {
			throw new Error(
				"Paddle is not configured. Missing PADDLE_API_KEY.",
			);
		}
		return this.paddle;
	}

	private formatDate(value: Date | null): string | null {
		return value ? value.toISOString() : null;
	}

	private mapPlan(row: PlanRow): BillingPlan {
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			monthlyPrice: row.monthly_price,
			yearlyPrice: row.yearly_price,
			paddleMonthlyPriceId: row.paddle_monthly_price_id,
			paddleYearlyPriceId: row.paddle_yearly_price_id,
			features: row.features,
			isActive: row.is_active,
			createdAt: row.created_at.toISOString(),
			updatedAt: row.updated_at.toISOString(),
		};
	}

	private mapPlanFromSubscription(
		row: SubscriptionWithPlanRow,
	): BillingPlan {
		return {
			id: row.plan_id,
			name: row.plan_name,
			description: row.plan_description,
			monthlyPrice: row.monthly_price,
			yearlyPrice: row.yearly_price,
			paddleMonthlyPriceId: row.paddle_monthly_price_id,
			paddleYearlyPriceId: row.paddle_yearly_price_id,
			features: row.features,
			isActive: row.is_active,
			createdAt: row.created_at.toISOString(),
			updatedAt: row.updated_at.toISOString(),
		};
	}

	private mapSubscription(
		row: SubscriptionWithPlanRow,
	): SubscriptionSummary {
		return {
			id: row.id,
			planId: row.plan_id,
			planName: row.plan_name,
			planDescription: row.plan_description,
			billingCycle: row.billing_cycle,
			paddleSubscriptionId: row.paddle_subscription_id,
			paddleCustomerId: row.paddle_customer_id,
			status: row.status,
			startDate: this.formatDate(row.start_date),
			endDate: this.formatDate(row.end_date),
			nextBillingDate: this.formatDate(
				row.next_billing_date,
			),
			autoRenew: row.auto_renew,
			cancelAtCycleEnd: row.cancel_at_cycle_end,
			createdAt: row.created_at.toISOString(),
			updatedAt: row.updated_at.toISOString(),
		};
	}

	private normalizePlanName(name: string): PlanType {
		const normalized = name.trim().toLowerCase();
		if (
			normalized === "free" ||
			normalized === "basic" ||
			normalized === "standard" ||
			normalized === "enterprise"
		) {
			return normalized;
		}
		throw new Error(
			"Plan name must be one of: free, basic, standard, enterprise.",
		);
	}

	private normalizeFeatures(features: unknown): unknown {
		if (features === undefined) {
			return [];
		}
		if (
			Array.isArray(features) ||
			(features !== null && typeof features === "object")
		) {
			return features;
		}
		throw new Error("features must be a JSON array or object");
	}

	private mergePlanFeatures(features: unknown): unknown {
		const normalizedFeatures = this.normalizeFeatures(features);
		if (Array.isArray(normalizedFeatures)) {
			return { items: normalizedFeatures };
		}
		return { ...(normalizedFeatures as Record<string, unknown>) };
	}

	private normalizePriceId(
		value: string | null | undefined,
	): string | null {
		if (typeof value !== "string") return null;
		const t = value.trim();
		return t.length > 0 ? t : null;
	}

	private getPaddleRuntimeConfig(): PaddleRuntimeConfigResponse {
		const environment =
			config.PADDLE_ENVIRONMENT === "production"
				? "production"
				: "sandbox";
		const clientToken = config.PADDLE_CLIENT_TOKEN.trim();
		if (!clientToken) {
			throw new Error(
				"Paddle client token is not configured. Set PADDLE_CLIENT_TOKEN on the backend.",
			);
		}

		return {
			clientToken,
			environment,
		};
	}

	private async applyUserPlan(
		client: PoolClient,
		userId: string,
		planName: string,
	): Promise<void> {
		if (!KNOWN_PLAN_NAMES.includes(planName as PlanType)) {
			logger.warn(
				"Skipping users.plan_type update for unknown plan",
				{ userId, planName },
			);
			return;
		}
		const normalizedPlan = planName as PlanType;
		await client.query(
			`UPDATE users
       SET plan_type = $2,
           conversations_limit = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
			[
				userId,
				normalizedPlan,
				PLAN_CONVERSATION_DEFAULT_LIMITS[normalizedPlan],
			],
		);
	}

	private async findPlanByNameOrId(input: {
		planId?: number;
		planName?: string;
		includeInactive?: boolean;
	}): Promise<PlanRow> {
		const { planId, planName, includeInactive } = input;
		if (!planId && !planName) {
			throw new Error(
				"Either planId or planName is required.",
			);
		}

		const params: Array<number | string | boolean> = [];
		let index = 1;
		const filters: string[] = [];

		if (planId) {
			filters.push(`id = $${index}`);
			params.push(planId);
			index++;
		}
		if (planName) {
			filters.push(`name = $${index}`);
			params.push(planName.trim().toLowerCase());
			index++;
		}
		if (!includeInactive) {
			filters.push("is_active = TRUE");
		}

		const query = `
      SELECT *
      FROM plans
      WHERE ${filters.join(" AND ")}
      LIMIT 1
    `;

		const result = await pool.query<PlanRow>(query, params);
		const row = result.rows[0];
		if (!row) throw new Error("Plan not found.");
		return row;
	}

	private async getCurrentSubscriptionRow(
		userId: string,
	): Promise<SubscriptionWithPlanRow | null> {
		const result =
			await pool.query<SubscriptionWithPlanRow>(
				`SELECT
         s.*,
         p.name AS plan_name,
         p.description AS plan_description,
         p.monthly_price,
         p.yearly_price,
         p.paddle_monthly_price_id,
         p.paddle_yearly_price_id,
         p.features,
         p.is_active
       FROM subscriptions s
       INNER JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = $1
       ORDER BY
         CASE
           WHEN s.status = ANY($2::text[]) THEN 0
           ELSE 1
         END,
         s.created_at DESC
       LIMIT 1`,
				[userId, ENTITLED_SUBSCRIPTION_STATUSES],
			);
		return result.rows[0] ?? null;
	}

	private async getActiveSubscriptionRow(
		userId: string,
	): Promise<SubscriptionWithPlanRow | null> {
		const result =
			await pool.query<SubscriptionWithPlanRow>(
				`SELECT
         s.*,
         p.name AS plan_name,
         p.description AS plan_description,
         p.monthly_price,
         p.yearly_price,
         p.paddle_monthly_price_id,
         p.paddle_yearly_price_id,
         p.features,
         p.is_active
       FROM subscriptions s
       INNER JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = $1
         AND s.status = ANY($2::text[])
       ORDER BY s.created_at DESC
       LIMIT 1`,
				[userId, ENTITLED_SUBSCRIPTION_STATUSES],
			);
		return result.rows[0] ?? null;
	}

	private getPlanRank(planName: string): number {
		const ranks: Record<string, number> = {
			free: 0,
			basic: 1,
			standard: 2,
			enterprise: 3,
		};
		return ranks[planName] ?? 0;
	}

	private assertBillingCycleTransitionAllowed(
		current: SubscriptionWithPlanRow,
		targetCycle: BillingCycle,
	): void {
		if (
			current.billing_cycle === "yearly" &&
			targetCycle === "monthly"
		) {
			throw new Error(
				"Yearly subscriptions can only move to yearly plans. Choose a yearly plan to continue.",
			);
		}
	}

	private async downgradeIfNoActiveSubscription(
		client: PoolClient,
		userId: string,
	): Promise<void> {
		const result = await client.query<{ total: string }>(
			`SELECT COUNT(*) AS total
       FROM subscriptions
       WHERE user_id = $1
         AND status = ANY($2::text[])`,
			[userId, ENTITLED_SUBSCRIPTION_STATUSES],
		);
		const total = Number(result.rows[0]?.total ?? 0);
		if (total === 0) {
			await this.applyUserPlan(client, userId, "free");
		}
	}

	// ── Public API ────────────────────────────────────────────────────────────

	async listPlans(includeInactive = false): Promise<BillingPlan[]> {
		const result = await pool.query<PlanRow>(
			`SELECT *
       FROM plans
       ${includeInactive ? "" : "WHERE is_active = TRUE"}
       ORDER BY
         CASE name
           WHEN 'free' THEN 1
           WHEN 'basic' THEN 2
           WHEN 'standard' THEN 3
           WHEN 'enterprise' THEN 4
           ELSE 5
         END,
         id ASC`,
		);
		return result.rows.map((row) => this.mapPlan(row));
	}

	async getWebsitePagesLimitForPlan(
		planType: PlanType,
	): Promise<number | null> {
		void planType;
		return SCRAPER_PAGE_LIMIT;
	}

	async createPlan(input: UpsertPlanInput): Promise<BillingPlan> {
		const normalizedName = this.normalizePlanName(input.name);
		const normalizedFeatures = this.mergePlanFeatures(
			input.features,
		);
		const result = await pool.query<PlanRow>(
			`INSERT INTO plans (
         name,
         description,
         monthly_price,
         yearly_price,
         paddle_monthly_price_id,
         paddle_yearly_price_id,
         features,
         is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING *`,
			[
				normalizedName,
				input.description ?? null,
				Math.max(0, input.monthlyPrice),
				Math.max(0, input.yearlyPrice),
				this.normalizePriceId(input.paddleMonthlyPriceId),
				this.normalizePriceId(input.paddleYearlyPriceId),
				JSON.stringify(normalizedFeatures),
				input.isActive ?? true,
			],
		);
		return this.mapPlan(result.rows[0]);
	}

	async updatePlan(
		planId: number,
		input: UpsertPlanInput,
	): Promise<BillingPlan> {
		const normalizedName = this.normalizePlanName(input.name);
		const normalizedFeatures = this.mergePlanFeatures(
			input.features,
		);
		const result = await pool.query<PlanRow>(
			`UPDATE plans
       SET
         name = $2,
         description = $3,
         monthly_price = $4,
         yearly_price = $5,
         paddle_monthly_price_id = $6,
         paddle_yearly_price_id = $7,
         features = $8::jsonb,
         is_active = $9,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
			[
				planId,
				normalizedName,
				input.description ?? null,
				Math.max(0, input.monthlyPrice),
				Math.max(0, input.yearlyPrice),
				this.normalizePriceId(input.paddleMonthlyPriceId),
				this.normalizePriceId(input.paddleYearlyPriceId),
				JSON.stringify(normalizedFeatures),
				input.isActive ?? true,
			],
		);
		if (!result.rows[0]) throw new Error("Plan not found.");
		return this.mapPlan(result.rows[0]);
	}

	async getCurrentSubscription(
		userId: string,
	): Promise<CurrentSubscriptionResponse> {
		const current =
			await this.getCurrentSubscriptionRow(userId);

		if (current) {
			const isActive =
				ENTITLED_SUBSCRIPTION_STATUSES.includes(
					current.status,
				);
			if (isActive) {
				return {
					currentPlan:
						this.mapPlanFromSubscription(current),
					subscription: this.mapSubscription(current),
				};
			}

			const userResult = await pool.query<{
				plan_type: string;
			}>(
				`SELECT plan_type FROM users WHERE id = $1 LIMIT 1`,
				[userId],
			);
			const fallbackPlanName =
				userResult.rows[0]?.plan_type ?? "free";
			const fallbackPlan = await this.findPlanByNameOrId({
				planName: fallbackPlanName,
				includeInactive: true,
			}).catch(async () =>
				this.findPlanByNameOrId({
					planName: "free",
					includeInactive: true,
				}),
			);
			return {
				currentPlan: this.mapPlan(fallbackPlan),
				subscription: this.mapSubscription(current),
			};
		}

		const userResult = await pool.query<{
			plan_type: string;
		}>(
			`SELECT plan_type FROM users WHERE id = $1 LIMIT 1`,
			[userId],
		);
		const fallbackPlanName =
			userResult.rows[0]?.plan_type ?? "free";
		const fallbackPlan = await this.findPlanByNameOrId({
			planName: fallbackPlanName,
			includeInactive: true,
		}).catch(async () =>
			this.findPlanByNameOrId({
				planName: "free",
				includeInactive: true,
			}),
		);

		return { currentPlan: this.mapPlan(fallbackPlan), subscription: null };
	}

	/**
	 * Returns the Paddle price ID for the selected plan/billing cycle.
	 * The frontend uses this to open Paddle.js Overlay Checkout directly.
	 * No subscription is created in our DB here — that happens via webhook.
	 */
	async getCheckoutInfo(
		userId: string,
		input: GetCheckoutInfoInput,
		userEmail?: string | null,
	): Promise<GetCheckoutInfoResponse> {
		this.getPaddleRuntimeConfig();
		const paddle = this.getPaddleClient();

		const plan = await this.findPlanByNameOrId({
			planId: input.planId,
			planName: input.planName,
			includeInactive: false,
		});

		if (plan.name === "free") {
			throw new Error(
				"Free plan does not require subscription checkout.",
			);
		}

		if (
			input.billingCycle !== "monthly" &&
			input.billingCycle !== "yearly"
		) {
			throw new Error(
				"billingCycle must be monthly or yearly.",
			);
		}

		const priceId = this.normalizePriceId(
			input.billingCycle === "monthly"
				? plan.paddle_monthly_price_id
				: plan.paddle_yearly_price_id,
		);

		if (!priceId) {
			throw new Error(
				`Paddle ${input.billingCycle} price ID is not configured for the ${plan.name} plan.`,
			);
		}

		const currentSubscription =
			await this.getActiveSubscriptionRow(userId);
		if (currentSubscription) {
			this.assertBillingCycleTransitionAllowed(
				currentSubscription,
				input.billingCycle,
			);
		}

		const transactionPromise = paddle.transactions.create({
			items: [{ priceId, quantity: 1 }],
			collectionMode: "automatic",
			customerId:
				currentSubscription?.paddle_customer_id ??
				undefined,
			customData: {
				user_id: userId,
				user_email: userEmail ?? null,
				plan_id: plan.id,
				plan_name: plan.name,
				billing_cycle: input.billingCycle,
			},
		});
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(
				() =>
					reject(
						new Error(
							"Paddle API timed out. Please check your API key and network, then try again.",
						),
					),
				15000,
			),
		);
		const transaction = await Promise.race([
			transactionPromise,
			timeoutPromise,
		]);

		logger.info("Paddle transaction created", {
			transactionId: transaction.id,
			checkoutUrl: transaction.checkout?.url,
			status: transaction.status,
		});

		if (!transaction.id) {
			throw new Error(
				"Paddle did not return a transaction ID. Please try again.",
			);
		}

		return {
			priceId,
			billingCycle: input.billingCycle,
			amount:
				input.billingCycle === "monthly"
					? plan.monthly_price
					: plan.yearly_price,
			currency: "USD",
			planName: plan.name,
			description: plan.description ?? `${plan.name} plan`,
			transactionId: transaction.id,
		};
	}

	getPublicPaddleRuntimeConfig(): PaddleRuntimeConfigResponse {
		return this.getPaddleRuntimeConfig();
	}

	async cancelSubscription(
		userId: string,
		input: CancelSubscriptionInput,
	): Promise<CurrentSubscriptionResponse> {
		const current = await this.getActiveSubscriptionRow(userId);
		if (!current) {
			throw new Error("No active subscription found.");
		}

		const cancelAtCycleEnd = input.cancelAtCycleEnd ?? true;
		const paddle = this.getPaddleClient();

		if (current.paddle_subscription_id) {
			try {
				await paddle.subscriptions.cancel(
					current.paddle_subscription_id,
					{
						effectiveFrom: cancelAtCycleEnd
							? "next_billing_period"
							: "immediately",
					},
				);
			} catch (error) {
				logger.warn("Paddle cancellation call failed", {
					userId,
					paddleSubscriptionId:
						current.paddle_subscription_id,
					error:
						error instanceof Error
							? error.message
							: String(error),
				});
				// Proceed to update local state anyway.
			}
		}

		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				`UPDATE subscriptions
         SET
           status = $2,
           auto_renew = FALSE,
           cancel_at_cycle_end = $3,
           end_date = CASE
             WHEN $3 = FALSE THEN CURRENT_TIMESTAMP
             ELSE end_date
           END,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
				[
					current.id,
					cancelAtCycleEnd ? current.status : "cancelled",
					cancelAtCycleEnd,
				],
			);

			if (!cancelAtCycleEnd) {
				await this.applyUserPlan(client, userId, "free");
			}
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}

		return this.getCurrentSubscription(userId);
	}

	/**
	 * Resolves plan by Paddle price ID (used in webhook handler).
	 */
	private async resolvePlanFromPriceId(priceId: string): Promise<{
		planId: number;
		planName: string;
		billingCycle: BillingCycle;
	} | null> {
		const result = await pool.query<{
			plan_id: number;
			plan_name: string;
			billing_cycle: BillingCycle;
		}>(
			`SELECT
         id AS plan_id,
         name AS plan_name,
         CASE
           WHEN paddle_monthly_price_id = $1 THEN 'monthly'
           ELSE 'yearly'
         END AS billing_cycle
       FROM plans
       WHERE paddle_monthly_price_id = $1
          OR paddle_yearly_price_id = $1
       LIMIT 1`,
			[priceId],
		);
		const row = result.rows[0];
		if (!row) return null;
		return {
			planId: row.plan_id,
			planName: row.plan_name,
			billingCycle: row.billing_cycle,
		};
	}

	/**
	 * Process a Paddle webhook event.
	 * Signature verification is done before calling this method (in the controller).
	 */
	async processWebhook(
		rawBody: string,
		signature: string,
	): Promise<{ processed: boolean; eventType: string }> {
		const paddle = this.getPaddleClient();

		let event: ReturnType<
			typeof paddle.webhooks.unmarshal
		> extends Promise<infer T> ? T : never;
		try {
			event = await paddle.webhooks.unmarshal(
				rawBody,
				config.PADDLE_WEBHOOK_SECRET,
				signature,
			);
		} catch (error) {
			logger.warn("Paddle webhook signature verification failed", {
				error:
					error instanceof Error
						? error.message
						: String(error),
			});
			throw new Error("Invalid Paddle webhook signature.");
		}

		if (!event) {
			throw new Error("Invalid Paddle webhook payload.");
		}

		const eventType = event.eventType as string;
		logger.info("Processing Paddle webhook", { eventType });

		switch (event.eventType) {
			case EventName.SubscriptionActivated:
			case EventName.SubscriptionCreated:
			case EventName.SubscriptionUpdated:
			case EventName.SubscriptionResumed:
			case EventName.SubscriptionTrialing: {
				const sub = event.data as {
					id: string;
					customerId: string;
					status: string;
					startedAt?: string | null;
					nextBilledAt?: string | null;
					currentBillingPeriod?: {
						startsAt?: string;
						endsAt?: string;
					} | null;
					canceledAt?: string | null;
					scheduledChange?: {
						action?: string;
						resumeAt?: string | null;
					} | null;
					items?: Array<{ price?: { id?: string; unitPrice?: { amount?: string } } }>;
					customData?: Record<string, unknown> | null;
				};

				const paddleSubId = sub.id;
				const paddleCustomerId = sub.customerId;
				const status = sub.status;
				const startDate = sub.startedAt
					? new Date(sub.startedAt)
					: null;
				const nextBilledAt = sub.nextBilledAt
					? new Date(sub.nextBilledAt)
					: null;
				const endDate = sub.currentBillingPeriod?.endsAt
					? new Date(sub.currentBillingPeriod.endsAt)
					: null;
				const cancelAtCycleEnd =
					sub.scheduledChange?.action === "cancel";

				// Try to resolve plan from price ID in the subscription items
				const priceId =
					sub.items?.[0]?.price?.id ?? null;
				const resolvedPlan = priceId
					? await this.resolvePlanFromPriceId(priceId)
					: null;

				// Find existing subscription row
				const existingResult =
					await pool.query<SubscriptionRow>(
						`SELECT * FROM subscriptions
             WHERE paddle_subscription_id = $1
             LIMIT 1`,
						[paddleSubId],
					);
				const existing = existingResult.rows[0] ?? null;

				// Resolve userId from custom_data or existing row
				const customData =
					(sub.customData as Record<string, unknown>) ?? {};
				const userIdFromData =
					typeof customData.user_id === "string"
						? customData.user_id
						: null;
				const userId =
					existing?.user_id ??
					userIdFromData ??
					(await this.resolveUserIdFromCustomer(
						paddleCustomerId,
					));

				if (!userId) {
					logger.warn(
						"Paddle webhook: could not resolve user_id for subscription",
						{ paddleSubId, paddleCustomerId },
					);
					break;
				}

				const planId =
					resolvedPlan?.planId ??
					existing?.plan_id ??
					null;
				const billingCycle: BillingCycle =
					resolvedPlan?.billingCycle ??
					existing?.billing_cycle ??
					"monthly";

				const client = await pool.connect();
				try {
					await client.query("BEGIN");

					if (!existing) {
						if (!planId) {
							logger.warn(
								"Paddle webhook: cannot insert subscription without planId",
								{ paddleSubId, priceId },
							);
							await client.query("COMMIT");
							break;
						}
						await client.query(
							`INSERT INTO subscriptions (
                 user_id, plan_id, billing_cycle,
                 paddle_subscription_id, paddle_customer_id,
                 status, start_date, end_date, next_billing_date,
                 auto_renew, cancel_at_cycle_end, metadata, amount_minor
               )
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
               ON CONFLICT DO NOTHING`,
							[
								userId,
								planId,
								billingCycle,
								paddleSubId,
								paddleCustomerId,
								status,
								startDate,
								endDate,
								nextBilledAt,
								!cancelAtCycleEnd &&
									status !== "canceled",
								cancelAtCycleEnd,
								JSON.stringify(sub),
								parseInt(sub.items?.[0]?.price?.unitPrice?.amount ?? "0", 10),
							],
						);
					} else {
						await client.query(
							`UPDATE subscriptions
               SET
                 plan_id = COALESCE($2, plan_id),
                 billing_cycle = COALESCE($3, billing_cycle),
                 paddle_customer_id = COALESCE($4, paddle_customer_id),
                 status = $5,
                 start_date = COALESCE(start_date, $6),
                 end_date = COALESCE($7, end_date),
                 next_billing_date = COALESCE($8, next_billing_date),
                 auto_renew = $9,
                 cancel_at_cycle_end = $10,
                 metadata = COALESCE(metadata, '{}'::jsonb) || $11::jsonb,
                 updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
							[
								existing.id,
								planId ?? null,
								billingCycle,
								paddleCustomerId,
								status,
								startDate,
								endDate,
								nextBilledAt,
								!cancelAtCycleEnd && status !== "canceled",
								cancelAtCycleEnd,
								JSON.stringify({ paddleWebhook: sub }),
							],
						);
					}

					// Upgrade user's plan if subscription is active
					if (
						ENTITLED_SUBSCRIPTION_STATUSES.includes(status)
					) {
						const planRow = planId
							? await this.findPlanByNameOrId({
									planId,
									includeInactive: true,
								}).catch(() => null)
							: null;
						if (planRow) {
							await this.applyUserPlan(
								client,
								userId,
								planRow.name,
							);
						}
					}

					await client.query("COMMIT");
				} catch (err) {
					await client.query("ROLLBACK");
					throw err;
				} finally {
					client.release();
				}
				break;
			}

			case EventName.SubscriptionCanceled: {
				const sub = event.data as {
					id: string;
					customerId: string;
					status: string;
					canceledAt?: string | null;
				};

				const existingResult =
					await pool.query<SubscriptionRow>(
						`SELECT * FROM subscriptions
             WHERE paddle_subscription_id = $1
             LIMIT 1`,
						[sub.id],
					);
				const existing = existingResult.rows[0] ?? null;
				if (!existing) break;

				const client = await pool.connect();
				try {
					await client.query("BEGIN");
					await client.query(
						`UPDATE subscriptions
             SET
               status = 'cancelled',
               auto_renew = FALSE,
               cancel_at_cycle_end = FALSE,
               end_date = COALESCE($2, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
						[
							existing.id,
							sub.canceledAt
								? new Date(sub.canceledAt)
								: null,
						],
					);
					await this.downgradeIfNoActiveSubscription(
						client,
						existing.user_id,
					);
					await client.query("COMMIT");
				} catch (err) {
					await client.query("ROLLBACK");
					throw err;
				} finally {
					client.release();
				}
				break;
			}

			case EventName.TransactionCompleted: {
				const tx = event.data as {
					id: string;
					customerId: string;
					subscriptionId?: string | null;
					billedAt?: string | null;
					billingPeriod?: {
						startsAt?: string;
						endsAt?: string;
					} | null;
					details?: {
						totals?: {
							total?: string;
							currencyCode?: string;
						};
					};
					items?: Array<{ price?: { id?: string } }>;
					customData?: Record<string, unknown> | null;
				};

				const priceId = tx.items?.[0]?.price?.id ?? null;
				const resolvedPlan = priceId
					? await this.resolvePlanFromPriceId(priceId)
					: null;

				// Extract user/plan info from custom_data set at transaction creation
				const txCustomData = (tx.customData ?? {}) as Record<string, unknown>;
				const userIdFromCustomData =
					typeof txCustomData.user_id === "string"
						? txCustomData.user_id
						: null;
				const planIdFromCustomData =
					typeof txCustomData.plan_id === "number"
						? txCustomData.plan_id
						: null;
				const billingCycleFromCustomData: BillingCycle | null =
					txCustomData.billing_cycle === "monthly" ||
					txCustomData.billing_cycle === "yearly"
						? (txCustomData.billing_cycle as BillingCycle)
						: null;

				const subResult = tx.subscriptionId
					? await pool.query<SubscriptionRow>(
							`SELECT * FROM subscriptions
               WHERE paddle_subscription_id = $1 LIMIT 1`,
							[tx.subscriptionId],
						)
					: null;
				const subRow = subResult?.rows[0] ?? null;

				const userId =
					subRow?.user_id ??
					userIdFromCustomData ??
					(await this.resolveUserIdFromCustomer(tx.customerId));
				if (!userId) break;

				const planId =
					resolvedPlan?.planId ??
					subRow?.plan_id ??
					planIdFromCustomData ??
					null;
				const billingCycle: BillingCycle =
					resolvedPlan?.billingCycle ??
					subRow?.billing_cycle ??
					billingCycleFromCustomData ??
					"monthly";

				const totalStr = tx.details?.totals?.total ?? "0";
				const amount = Math.round(parseFloat(totalStr));
				const currency = tx.details?.totals?.currencyCode ?? "USD";

				// If subscription.created was missed, create the row now and apply plan
				let effectiveSubRow = subRow;
				if (!subRow && tx.subscriptionId && planId) {
					const client = await pool.connect();
					try {
						await client.query("BEGIN");
						await client.query(
							`INSERT INTO subscriptions (
                   user_id, plan_id, billing_cycle,
                   paddle_subscription_id, paddle_customer_id,
                   status, start_date, end_date,
                   auto_renew, cancel_at_cycle_end, metadata, amount_minor
                 )
                 VALUES ($1,$2,$3,$4,$5,'active',$6,$7,TRUE,FALSE,$8::jsonb,$9)
                 ON CONFLICT DO NOTHING`,
							[
								userId,
								planId,
								billingCycle,
								tx.subscriptionId,
								tx.customerId,
								tx.billedAt ? new Date(tx.billedAt) : null,
								tx.billingPeriod?.endsAt
									? new Date(tx.billingPeriod.endsAt)
									: null,
								JSON.stringify(tx),
								amount,
							],
						);
						const inserted = await client.query<SubscriptionRow>(
							`SELECT * FROM subscriptions
                 WHERE paddle_subscription_id = $1 LIMIT 1`,
							[tx.subscriptionId],
						);
						effectiveSubRow = inserted.rows[0] ?? null;
						const planRow = await this.findPlanByNameOrId({
							planId,
							includeInactive: true,
						}).catch(() => null);
						if (planRow) {
							await this.applyUserPlan(client, userId, planRow.name);
						}
						await client.query("COMMIT");
						logger.info(
							"Paddle webhook: created subscription from transaction.completed",
							{ userId, subscriptionId: tx.subscriptionId, planId },
						);
					} catch (err) {
						await client.query("ROLLBACK");
						logger.warn(
							"Paddle webhook: failed to create subscription from transaction",
							{
								txId: tx.id,
								error:
									err instanceof Error
										? err.message
										: String(err),
							},
						);
					} finally {
						client.release();
					}
				} else if (subRow && planId) {
					// Subscription row exists — ensure user plan is up to date
					const client = await pool.connect();
					try {
						await client.query("BEGIN");
						const planRow = await this.findPlanByNameOrId({
							planId,
							includeInactive: true,
						}).catch(() => null);
						if (planRow) {
							await this.applyUserPlan(client, userId, planRow.name);
						}
						await client.query("COMMIT");
					} catch (err) {
						await client.query("ROLLBACK");
						logger.warn(
							"Paddle webhook: failed to apply plan on transaction.completed",
							{
								error:
									err instanceof Error
										? err.message
										: String(err),
							},
						);
					} finally {
						client.release();
					}
				}

				try {
					await pool.query(
						`INSERT INTO payments (
               user_id,
               subscription_id,
               plan_id,
               paddle_transaction_id,
               paddle_customer_id,
               paddle_event_id,
               amount,
               amount_minor,
               currency,
               payment_status,
               raw_payload
             )
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed',$10::jsonb)
             ON CONFLICT (paddle_transaction_id) DO UPDATE
               SET payment_status = 'completed',
                   raw_payload = EXCLUDED.raw_payload`,
						[
							userId,
							effectiveSubRow?.id ?? null,
							planId ?? effectiveSubRow?.plan_id ?? null,
							tx.id,
							tx.customerId,
							event.eventId ?? null,
							amount,
							amount,
							currency,
							JSON.stringify(tx),
						],
					);
				} catch (err) {
					logger.warn(
						"Paddle webhook: failed to record transaction",
						{
							txId: tx.id,
							error:
								err instanceof Error
									? err.message
									: String(err),
						},
					);
				}
				break;
			}

			default:
				logger.info(
					`Paddle webhook event ${eventType} received but not handled`,
				);
		}

		return { processed: true, eventType };
	}

	async upgradeSubscription(
		userId: string,
		input: UpgradeSubscriptionInput,
	): Promise<CurrentSubscriptionResponse> {
		const paddle = this.getPaddleClient();

		// Get current active subscription
		const current = await this.getActiveSubscriptionRow(userId);
		if (!current) {
			throw new Error(
				"No active subscription found. Use checkout to start a new subscription.",
			);
		}
		if (!current.paddle_subscription_id) {
			throw new Error(
				"Subscription is not managed by Paddle. Please contact support.",
			);
		}

		// Resolve target plan
		const targetPlan = await this.findPlanByNameOrId({
			planId: input.planId,
			planName: input.planName,
			includeInactive: false,
		});

		if (targetPlan.name === "free") {
			throw new Error(
				"To move to free plan, cancel your current subscription.",
			);
		}
		if (targetPlan.name === "enterprise") {
			throw new Error(
				"Contact sales to switch to the enterprise plan.",
			);
		}

		// Reject no-op changes
		if (
			current.plan_id === targetPlan.id &&
			current.billing_cycle === input.billingCycle
		) {
			throw new Error(
				"You are already on this plan and billing cycle.",
			);
		}

		this.assertBillingCycleTransitionAllowed(
			current,
			input.billingCycle,
		);

		// Get new Paddle price ID
		const newPriceId = this.normalizePriceId(
			input.billingCycle === "monthly"
				? targetPlan.paddle_monthly_price_id
				: targetPlan.paddle_yearly_price_id,
		);
		if (!newPriceId) {
			throw new Error(
				`No Paddle price configured for ${targetPlan.name} ${input.billingCycle} billing.`,
			);
		}

		// Determine upgrade vs downgrade for proration mode
		const currentRank = this.getPlanRank(
			current.plan_name,
		);
		const targetRank = this.getPlanRank(
			targetPlan.name,
		);
		const isUpgrade =
			targetRank > currentRank ||
			(targetRank === currentRank &&
				input.billingCycle === "yearly" &&
				current.billing_cycle === "monthly");

		// prorated_immediately for upgrades, prorated_next_billing_period for downgrades
		const prorationBillingMode = isUpgrade
			? "prorated_immediately"
			: "prorated_next_billing_period";

		// Call Paddle to update the subscription
		try {
			await paddle.subscriptions.update(
				current.paddle_subscription_id,
				{
					items: [{ priceId: newPriceId, quantity: 1 }],
					prorationBillingMode,
				},
			);
		} catch (err) {
			logger.error("Paddle subscriptions.update failed", {
				userId,
				paddleSubId: current.paddle_subscription_id,
				targetPlan: targetPlan.name,
				billingCycle: input.billingCycle,
				error:
					err instanceof Error
						? err.message
						: String(err),
			});
			throw new Error(
				err instanceof Error
					? err.message
					: "Failed to update subscription with Paddle.",
			);
		}

		// Optimistically update local DB (webhook will confirm)
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				`UPDATE subscriptions
         SET plan_id = $2,
             billing_cycle = $3,
             cancel_at_cycle_end = FALSE,
             auto_renew = TRUE,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
				[current.id, targetPlan.id, input.billingCycle],
			);
			// Apply new plan immediately for upgrades
			if (isUpgrade) {
				await this.applyUserPlan(
					client,
					userId,
					targetPlan.name,
				);
			}
			await client.query("COMMIT");
			logger.info("Subscription upgrade applied", {
				userId,
				fromPlan: current.plan_name,
				fromCycle: current.billing_cycle,
				toPlan: targetPlan.name,
				toCycle: input.billingCycle,
				prorationBillingMode,
			});
		} catch (err) {
			await client.query("ROLLBACK");
			// Paddle update succeeded but local DB failed — webhook will reconcile
			logger.error(
				"Local DB update failed after Paddle subscription update",
				{
					userId,
					paddleSubId: current.paddle_subscription_id,
					error:
						err instanceof Error
							? err.message
							: String(err),
				},
			);
			throw err;
		} finally {
			client.release();
		}

		return this.getCurrentSubscription(userId);
	}

	/**
	 * Looks up a user by their Paddle customer ID stored in subscriptions table.
	 */
	async getPaymentHistory(userId: string): Promise<PaymentRecord[]> {
		const result = await pool.query<PaymentRecord>(
			`SELECT
				id,
				paddle_transaction_id,
				plan_id,
				amount,
				currency,
				payment_status,
				created_at,
				raw_payload
			FROM payments
			WHERE user_id = $1
			ORDER BY created_at DESC
			LIMIT 50`,
			[userId],
		);

		const pickInvoiceUrl = (payload: any): string | null => {
			if (!payload || typeof payload !== "object") return null;
			const candidates = [
				payload.invoice_url,
				payload.invoiceUrl,
				payload.receipt_url,
				payload.receiptUrl,
				payload.statement_url,
				payload.statementUrl,
				payload?.links?.invoice,
				payload?.links?.receipt,
				payload?.urls?.invoice,
				payload?.urls?.receipt,
				payload?.checkout?.invoiceUrl,
			];
			const found = candidates.find(
				(url) => typeof url === "string" && url.trim().length > 0,
			);
			return found ? String(found) : null;
		};

		// Enrich with a live Paddle invoice PDF URL when missing.
		// Paddle exposes this via a dedicated endpoint rather than the main transaction payload.
		const rows = result.rows;
		for (const row of rows) {
			const existingUrl = pickInvoiceUrl(row.raw_payload);
			if (existingUrl) continue;

			if (!row.paddle_transaction_id || !this.paddle) continue;

			try {
				const invoicePdf =
					await this.paddle.transactions.getInvoicePDF(
						row.paddle_transaction_id,
					);
				let invoiceUrl =
					invoicePdf?.url && invoicePdf.url.trim()
						? invoicePdf.url
						: null;

				if (!invoiceUrl) {
					const tx = await this.paddle.transactions.get(
						row.paddle_transaction_id,
					);
					invoiceUrl = pickInvoiceUrl(tx);
				}

				if (invoiceUrl) {
					row.raw_payload = {
						...(row.raw_payload ?? {}),
						invoice_url: invoiceUrl,
					};

					await pool.query(
						`UPDATE payments
						 SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
						 WHERE id = $1`,
						[
							row.id,
							JSON.stringify({
								invoice_url: invoiceUrl,
							}),
						],
					);
				}
			} catch (err) {
				logger.warn("Paddle: failed to fetch transaction for invoice URL", {
					txId: row.paddle_transaction_id,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return rows;
	}

	async getPaymentInvoiceUrl(
		userId: string,
		transactionId: string,
	): Promise<string> {
		const paymentResult = await pool.query<{
			paddle_transaction_id: string | null;
			raw_payload: Record<string, unknown> | null;
		}>(
			`SELECT paddle_transaction_id, raw_payload
			 FROM payments
			 WHERE user_id = $1
			   AND paddle_transaction_id = $2
			 LIMIT 1`,
			[userId, transactionId],
		);

		const payment = paymentResult.rows[0];
		if (!payment?.paddle_transaction_id) {
			throw new Error("Invoice not found.");
		}
		if (!this.paddle) {
			throw new Error("Paddle is not configured.");
		}

		const fromPayload = [
			payment.raw_payload?.invoice_url,
			payment.raw_payload?.invoiceUrl,
			payment.raw_payload?.receipt_url,
			payment.raw_payload?.receiptUrl,
		].find(
			(value) =>
				typeof value === "string" &&
				value.trim().length > 0,
		);
		if (fromPayload) {
			return String(fromPayload);
		}

		try {
			const invoicePdf =
				await this.paddle.transactions.getInvoicePDF(
					transactionId,
				);
			if (
				invoicePdf?.url &&
				invoicePdf.url.trim().length > 0
			) {
				return invoicePdf.url;
			}
		} catch (err) {
			logger.warn(
				"Paddle: getInvoicePDF failed for payment invoice download",
				{
					txId: transactionId,
					error:
						err instanceof Error
							? err.message
							: String(err),
				},
			);
		}

		const tx = await this.paddle.transactions.get(
			transactionId,
		);
		const fallbackUrl = [
			(tx as unknown as { invoiceUrl?: string })
				.invoiceUrl,
			(tx as unknown as { receiptUrl?: string })
				.receiptUrl,
		].find(
			(value) =>
				typeof value === "string" &&
				value.trim().length > 0,
		);

		if (fallbackUrl) {
			return String(fallbackUrl);
		}

		throw new Error(
			"Invoice PDF is not available for this transaction.",
		);
	}

	async getPaymentStatus(
		userId: string,
		transactionId: string,
	): Promise<PaymentStatusResponse> {
		const paymentResult = await pool.query<{
			payment_status: string;
			amount: number;
			currency: string;
			raw_payload: Record<string, unknown> | null;
			plan_name: string | null;
			billing_cycle: BillingCycle | null;
			next_billing_date: Date | null;
			subscription_status: string | null;
		}>(
			`SELECT
				p.payment_status,
				p.amount,
				p.currency,
				p.raw_payload,
				pl.name AS plan_name,
				s.billing_cycle,
				s.next_billing_date,
				s.status AS subscription_status
			 FROM payments p
			 LEFT JOIN subscriptions s ON s.id = p.subscription_id
			 LEFT JOIN plans pl ON pl.id = COALESCE(p.plan_id, s.plan_id)
			 WHERE p.user_id = $1
			   AND p.paddle_transaction_id = $2
			 LIMIT 1`,
			[userId, transactionId],
		);

		const existing = paymentResult.rows[0];
		const existingInvoiceUrl =
			typeof existing?.raw_payload?.invoice_url === "string"
				? existing.raw_payload.invoice_url
				: typeof existing?.raw_payload?.receipt_url ===
					  "string"
					? existing.raw_payload.receipt_url
					: null;

		if (existing) {
			return {
				transactionId,
				transactionStatus: existing.payment_status,
				paymentStatus:
					existing.payment_status === "completed"
						? "success"
						: existing.payment_status === "pending"
							? "pending"
							: "failed",
				planName: existing.plan_name,
				billingCycle: existing.billing_cycle,
				amount: existing.amount,
				currency: existing.currency,
				subscriptionStatus:
					existing.subscription_status,
				nextBillingDate: this.formatDate(
					existing.next_billing_date,
				),
				invoiceUrl: existingInvoiceUrl,
			};
		}

		if (!this.paddle) {
			throw new Error("Payment details are unavailable.");
		}

		const tx = await this.paddle.transactions.get(
			transactionId,
		);
		const txCustomData =
			(tx.customData ?? {}) as Record<string, unknown>;
		const txUserId =
			typeof txCustomData.user_id === "string"
				? txCustomData.user_id
				: null;
		if (txUserId && txUserId !== userId) {
			throw new Error("Payment not found.");
		}

		let paymentStatus: "success" | "pending" | "failed" =
			"pending";
		if (
			tx.status === "paid" ||
			tx.status === "completed"
		) {
			paymentStatus = "success";
		} else if (tx.status === "canceled") {
			paymentStatus = "failed";
		}

		let invoiceUrl: string | null = null;
		try {
			const invoicePdf =
				await this.paddle.transactions.getInvoicePDF(
					transactionId,
				);
			if (
				invoicePdf?.url &&
				invoicePdf.url.trim().length > 0
			) {
				invoiceUrl = invoicePdf.url;
			}
		} catch {
			invoiceUrl = null;
		}

		return {
			transactionId,
			transactionStatus: tx.status,
			paymentStatus,
			planName:
				typeof txCustomData.plan_name === "string"
					? txCustomData.plan_name
					: null,
			billingCycle:
				txCustomData.billing_cycle === "monthly" ||
				txCustomData.billing_cycle === "yearly"
					? (txCustomData.billing_cycle as BillingCycle)
					: null,
			amount: tx.details?.totals?.total
				? Math.round(
						parseFloat(tx.details.totals.total),
					)
				: null,
			currency:
				tx.details?.totals?.currencyCode ?? null,
			subscriptionStatus: null,
			nextBillingDate: null,
			invoiceUrl,
		};
	}

	private async resolveUserIdFromCustomer(
		paddleCustomerId: string,
	): Promise<string | null> {
		const result = await pool.query<{ user_id: string }>(
			`SELECT user_id FROM subscriptions
       WHERE paddle_customer_id = $1
       ORDER BY created_at DESC LIMIT 1`,
			[paddleCustomerId],
		);
		return result.rows[0]?.user_id ?? null;
	}
}

export const subscriptionService = new SubscriptionService();
