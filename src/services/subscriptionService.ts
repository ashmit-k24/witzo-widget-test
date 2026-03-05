import crypto from "crypto";
import { PoolClient } from "pg";
import Razorpay from "razorpay";
import {
	PLAN_CONVERSATION_DEFAULT_LIMITS,
	PlanType,
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
	razorpay_monthly_plan_id: string | null;
	razorpay_yearly_plan_id: string | null;
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
	razorpay_subscription_id: string;
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
	razorpay_monthly_plan_id: string | null;
	razorpay_yearly_plan_id: string | null;
	features: unknown;
	is_active: boolean;
};

type PaymentRow = {
	id: string;
	user_id: string;
	subscription_id: string | null;
	plan_id: number | null;
	razorpay_order_id: string | null;
	razorpay_payment_id: string;
	razorpay_signature: string | null;
	amount: number;
	currency: string;
	payment_status: string;
	raw_payload: unknown;
	created_at: Date;
};

type WebhookPayload = {
	event?: string;
	payload?: {
		subscription?: { entity?: Record<string, unknown> };
		payment?: { entity?: Record<string, unknown> };
	};
};

export interface BillingPlan {
	id: number;
	name: string;
	description: string | null;
	monthlyPrice: number;
	yearlyPrice: number;
	razorpayMonthlyPlanId: string | null;
	razorpayYearlyPlanId: string | null;
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
	razorpaySubscriptionId: string;
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

export interface CreateSubscriptionInput {
	planId?: number;
	planName?: string;
	billingCycle: BillingCycle;
	cancelCurrent?: boolean;
}

export interface CreateSubscriptionResponse {
	currentPlan: BillingPlan;
	subscription: SubscriptionSummary;
	checkout: {
		keyId: string;
		subscriptionId: string;
		billingCycle: BillingCycle;
		amount: number;
		currency: string;
		planName: string;
		description: string;
	};
}

export interface VerifyPaymentInput {
	razorpay_subscription_id?: string;
	razorpay_order_id?: string;
	razorpay_payment_id: string;
	razorpay_signature: string;
}

export interface VerifyPaymentResponse {
	subscription: SubscriptionSummary;
	payment: {
		id: string;
		razorpayPaymentId: string;
		amount: number;
		currency: string;
		status: string;
		createdAt: string;
	};
}

export interface CancelSubscriptionInput {
	cancelAtCycleEnd?: boolean;
}

export interface UpsertPlanInput {
	name: string;
	description?: string | null;
	monthlyPrice: number;
	yearlyPrice: number;
	razorpayMonthlyPlanId?: string | null;
	razorpayYearlyPlanId?: string | null;
	features?: unknown;
	isActive?: boolean;
}

const ENTITLED_SUBSCRIPTION_STATUSES = [
	"active",
];

const CANCELLABLE_SUBSCRIPTION_STATUSES = [
	"created",
	"authenticated",
	"active",
	"pending",
];

const KNOWN_PLAN_NAMES: PlanType[] = [
	"free",
	"basic",
	"enterprise",
];

class SubscriptionService {
	private readonly razorpay: Razorpay | null;

	constructor() {
		this.razorpay =
			config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET
				? new Razorpay({
						key_id: config.RAZORPAY_KEY_ID,
						key_secret: config.RAZORPAY_KEY_SECRET,
					})
				: null;

		if (!this.razorpay) {
			logger.warn(
				"Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable billing.",
			);
		}
	}

	private getRazorpayClient(): Razorpay {
		if (!this.razorpay) {
			throw new Error(
				"Razorpay is not configured. Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET.",
			);
		}
		return this.razorpay;
	}

	private getWebhookSecret(): string {
		if (!config.RAZORPAY_WEBHOOK_SECRET) {
			throw new Error(
				"Razorpay webhook secret is not configured.",
			);
		}
		return config.RAZORPAY_WEBHOOK_SECRET;
	}

	private safeTimingEqual(
		left: string,
		right: string,
	): boolean {
		const leftBuffer = Buffer.from(left, "utf-8");
		const rightBuffer = Buffer.from(right, "utf-8");
		if (leftBuffer.length !== rightBuffer.length) {
			return false;
		}
		return crypto.timingSafeEqual(
			leftBuffer,
			rightBuffer,
		);
	}

	private getVerificationSecret(): string {
		if (!config.RAZORPAY_KEY_SECRET) {
			throw new Error(
				"Razorpay verification secret is not configured.",
			);
		}
		return config.RAZORPAY_KEY_SECRET;
	}

	private normalizeProviderStatus(
		status: string,
	): string {
		const normalized = status
			.trim()
			.toLowerCase();
		if (normalized === "authenticated") {
			return "active";
		}
		return normalized;
	}

	private isPaymentSuccessStatus(
		status: string,
	): boolean {
		return (
			status === "captured" ||
			status === "authorized" ||
			status === "paid" ||
			status === "success"
		);
	}

	private isSubscriptionActiveStatus(
		status: string,
	): boolean {
		return status === "active";
	}

	private buildVerificationCandidates(input: {
		orderId: string | null;
		subscriptionId: string | null;
		paymentId: string;
	}): string[] {
		const values = new Set<string>();
		if (input.orderId) {
			values.add(
				`${input.orderId}|${input.paymentId}`,
			);
		}
		if (input.subscriptionId) {
			// Razorpay subscription checkout signature formula: payment_id|subscription_id.
			values.add(
				`${input.paymentId}|${input.subscriptionId}`,
			);
			// Backward-compatible fallback for older payload interpretation.
			values.add(
				`${input.subscriptionId}|${input.paymentId}`,
			);
		}
		return Array.from(values);
	}

	private parseUnixTimestamp(
		value: unknown,
	): Date | null {
		if (typeof value === "number" && value > 0) {
			return new Date(value * 1000);
		}
		if (typeof value === "string") {
			const parsed = Number(value);
			if (Number.isFinite(parsed) && parsed > 0) {
				return new Date(parsed * 1000);
			}
		}
		return null;
	}

	private formatDate(
		value: Date | null,
	): string | null {
		return value ? value.toISOString() : null;
	}

	private mapPlan(row: PlanRow): BillingPlan {
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			monthlyPrice: row.monthly_price,
			yearlyPrice: row.yearly_price,
			razorpayMonthlyPlanId:
				row.razorpay_monthly_plan_id,
			razorpayYearlyPlanId:
				row.razorpay_yearly_plan_id,
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
			razorpayMonthlyPlanId:
				row.razorpay_monthly_plan_id,
			razorpayYearlyPlanId:
				row.razorpay_yearly_plan_id,
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
			razorpaySubscriptionId:
				row.razorpay_subscription_id,
			status: row.status,
			startDate: this.formatDate(row.start_date),
			endDate: this.formatDate(row.end_date),
			nextBillingDate:
				this.formatDate(row.next_billing_date),
			autoRenew: row.auto_renew,
			cancelAtCycleEnd:
				row.cancel_at_cycle_end,
			createdAt: row.created_at.toISOString(),
			updatedAt: row.updated_at.toISOString(),
		};
	}

	private normalizePlanName(
		name: string,
	): PlanType {
		const normalized = name
			.trim()
			.toLowerCase();
		if (
			normalized === "free" ||
			normalized === "basic" ||
			normalized === "enterprise"
		) {
			return normalized;
		}
		throw new Error(
			"Plan name must be one of: free, basic, enterprise.",
		);
	}

	private normalizeFeatures(features: unknown): unknown {
		if (features === undefined) {
			return [];
		}
		if (
			Array.isArray(features) ||
			(features !== null &&
				typeof features === "object")
		) {
			return features;
		}
		throw new Error(
			"features must be a JSON array or object",
		);
	}

	private toObject(
		value: unknown,
	): Record<string, unknown> {
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			return value as Record<string, unknown>;
		}
		return {};
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
				PLAN_CONVERSATION_DEFAULT_LIMITS[
					normalizedPlan
				],
			],
		);
	}

	private async findPlanByNameOrId(
		input: {
			planId?: number;
			planName?: string;
			includeInactive?: boolean;
		},
	): Promise<PlanRow> {
		const { planId, planName, includeInactive } =
			input;
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

		const result = await pool.query<PlanRow>(
			query,
			params,
		);

		const row = result.rows[0];
		if (!row) {
			throw new Error("Plan not found.");
		}

		return row;
	}

	private async getCurrentSubscriptionRow(
		userId: string,
	): Promise<SubscriptionWithPlanRow | null> {
		const result = await pool.query<SubscriptionWithPlanRow>(
			`SELECT
         s.*,
         p.name AS plan_name,
         p.description AS plan_description,
         p.monthly_price,
         p.yearly_price,
         p.razorpay_monthly_plan_id,
         p.razorpay_yearly_plan_id,
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
		const result = await pool.query<SubscriptionWithPlanRow>(
			`SELECT
         s.*,
         p.name AS plan_name,
         p.description AS plan_description,
         p.monthly_price,
         p.yearly_price,
         p.razorpay_monthly_plan_id,
         p.razorpay_yearly_plan_id,
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

	private async downgradeIfNoActiveSubscription(
		client: PoolClient,
		userId: string,
	): Promise<void> {
		const result = await client.query<{
			total: string;
		}>(
			`SELECT COUNT(*) AS total
       FROM subscriptions
       WHERE user_id = $1
         AND status = ANY($2::text[])`,
			[userId, ENTITLED_SUBSCRIPTION_STATUSES],
		);
		const total = Number(result.rows[0]?.total ?? 0);
		if (total === 0) {
			await this.applyUserPlan(
				client,
				userId,
				"free",
			);
		}
	}

	async listPlans(
		includeInactive = false,
	): Promise<BillingPlan[]> {
		const result = await pool.query<PlanRow>(
			`SELECT *
       FROM plans
       ${includeInactive ? "" : "WHERE is_active = TRUE"}
       ORDER BY
         CASE name
           WHEN 'free' THEN 1
           WHEN 'basic' THEN 2
           WHEN 'enterprise' THEN 3
           ELSE 4
         END,
         id ASC`,
		);
		return result.rows.map((row) =>
			this.mapPlan(row),
		);
	}

	async createPlan(
		input: UpsertPlanInput,
	): Promise<BillingPlan> {
		const normalizedName = this.normalizePlanName(
			input.name,
		);
		const normalizedFeatures =
			this.normalizeFeatures(input.features);
		const result = await pool.query<PlanRow>(
			`INSERT INTO plans (
         name,
         description,
         monthly_price,
         yearly_price,
         razorpay_monthly_plan_id,
         razorpay_yearly_plan_id,
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
				input.razorpayMonthlyPlanId ?? null,
				input.razorpayYearlyPlanId ?? null,
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
		const normalizedName = this.normalizePlanName(
			input.name,
		);
		const normalizedFeatures =
			this.normalizeFeatures(input.features);
		const result = await pool.query<PlanRow>(
			`UPDATE plans
       SET
         name = $2,
         description = $3,
         monthly_price = $4,
         yearly_price = $5,
         razorpay_monthly_plan_id = $6,
         razorpay_yearly_plan_id = $7,
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
				input.razorpayMonthlyPlanId ?? null,
				input.razorpayYearlyPlanId ?? null,
				JSON.stringify(normalizedFeatures),
				input.isActive ?? true,
			],
		);
		if (!result.rows[0]) {
			throw new Error("Plan not found.");
		}
		return this.mapPlan(result.rows[0]);
	}

	async getCurrentSubscription(
		userId: string,
	): Promise<CurrentSubscriptionResponse> {
		const current =
			await this.getCurrentSubscriptionRow(
				userId,
			);
		if (current) {
			const shouldTreatAsCurrentPlan =
				this.isSubscriptionActiveStatus(
					current.status,
				);
			if (shouldTreatAsCurrentPlan) {
				return {
					currentPlan:
						this.mapPlanFromSubscription(current),
					subscription:
						this.mapSubscription(current),
				};
			}

			const userResult = await pool.query<{
				plan_type: string;
			}>(
				`SELECT plan_type
         FROM users
         WHERE id = $1
         LIMIT 1`,
				[userId],
			);

			const fallbackPlanName =
				userResult.rows[0]?.plan_type ??
				"free";
			const fallbackPlan =
				await this.findPlanByNameOrId({
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
				subscription:
					this.mapSubscription(current),
			};
		}

		const userResult = await pool.query<{
			plan_type: string;
		}>(
			`SELECT plan_type
       FROM users
       WHERE id = $1
       LIMIT 1`,
			[userId],
		);

		const fallbackPlanName =
			userResult.rows[0]?.plan_type ??
			"free";
		const fallbackPlan =
			await this.findPlanByNameOrId({
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
			subscription: null,
		};
	}

	async createSubscription(
		userId: string,
		input: CreateSubscriptionInput,
	): Promise<CreateSubscriptionResponse> {
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

		const providerPlanId =
			input.billingCycle === "monthly"
				? plan.razorpay_monthly_plan_id
				: plan.razorpay_yearly_plan_id;

		if (!providerPlanId) {
			throw new Error(
				`Razorpay ${input.billingCycle} plan ID is not configured for ${plan.name}.`,
			);
		}

		const razorpay =
			this.getRazorpayClient();
		const shouldCancelCurrent =
			input.cancelCurrent !== false;

		const transaction =
			await pool.connect();
		try {
			await transaction.query("BEGIN");

			// Mark stale/unfinished checkout subscriptions as cancelled.
			await transaction.query(
				`UPDATE subscriptions
         SET
           status = 'cancelled',
           auto_renew = FALSE,
           cancel_at_cycle_end = FALSE,
           end_date = CURRENT_TIMESTAMP,
           metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
           updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1
           AND status = ANY($3::text[])`,
				[
					userId,
					JSON.stringify({
						cancelReason:
							"superseded_by_new_checkout",
						cancelledAt:
							new Date().toISOString(),
					}),
					["created", "authenticated", "pending"],
				],
			);

			const created =
				(await razorpay.subscriptions.create({
					plan_id: providerPlanId,
					customer_notify: 1,
					quantity: 1,
					total_count: 120,
					notes: {
						user_id: userId,
						plan_name: plan.name,
						billing_cycle: input.billingCycle,
						cancel_current:
							shouldCancelCurrent
								? "true"
								: "false",
					},
				})) as unknown as Record<
					string,
					unknown
				>;

			const razorpaySubscriptionId = String(
				created.id ?? "",
			);
			if (!razorpaySubscriptionId) {
				throw new Error(
					"Failed to create Razorpay subscription.",
				);
			}

			const startDate =
				this.parseUnixTimestamp(
					created.current_start,
				);
			const endDate =
				this.parseUnixTimestamp(
					created.current_end,
				);
			const nextBillingDate =
				this.parseUnixTimestamp(
					created.charge_at,
				) ?? endDate;
			const status = String(
				created.status ?? "created",
			);

			const insertResult =
				await transaction.query<SubscriptionWithPlanRow>(
					`INSERT INTO subscriptions (
             user_id,
             plan_id,
             billing_cycle,
             razorpay_subscription_id,
             status,
             start_date,
             end_date,
             next_billing_date,
             auto_renew,
             cancel_at_cycle_end,
             metadata
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, FALSE, $9::jsonb)
           RETURNING
             subscriptions.*,
             $10::text AS plan_name,
             $11::text AS plan_description,
             $12::int AS monthly_price,
             $13::int AS yearly_price,
             $14::text AS razorpay_monthly_plan_id,
             $15::text AS razorpay_yearly_plan_id,
             $16::jsonb AS features,
             $17::boolean AS is_active`,
					[
						userId,
						plan.id,
						input.billingCycle,
						razorpaySubscriptionId,
						status,
						startDate,
						endDate,
						nextBillingDate,
						JSON.stringify(created),
						plan.name,
						plan.description,
						plan.monthly_price,
						plan.yearly_price,
						plan.razorpay_monthly_plan_id,
						plan.razorpay_yearly_plan_id,
						JSON.stringify(plan.features),
						plan.is_active,
					],
				);

			await transaction.query("COMMIT");

			const createdSubscription =
				insertResult.rows[0];

			return {
				currentPlan: this.mapPlan(plan),
				subscription:
					this.mapSubscription(
						createdSubscription,
					),
				checkout: {
					keyId: config.RAZORPAY_KEY_ID,
					subscriptionId:
						razorpaySubscriptionId,
					billingCycle:
						input.billingCycle,
					amount:
						input.billingCycle ===
						"monthly"
							? plan.monthly_price
							: plan.yearly_price,
					currency: "INR",
					planName: plan.name,
					description:
						plan.description ??
						`${plan.name} plan`,
				},
			};
		} catch (error) {
			await transaction.query("ROLLBACK");
			throw error;
		} finally {
			transaction.release();
		}
	}

	async verifyPayment(
		userId: string,
		input: VerifyPaymentInput,
	): Promise<VerifyPaymentResponse> {
		const {
			razorpay_subscription_id:
				razorpaySubscriptionId,
			razorpay_order_id: razorpayOrderId,
			razorpay_payment_id: razorpayPaymentId,
			razorpay_signature: razorpaySignature,
		} = input;

		if (
			!razorpayPaymentId ||
			!razorpaySignature
		) {
			throw new Error(
				"razorpay_payment_id and razorpay_signature are required.",
			);
		}
		if (!razorpaySubscriptionId && !razorpayOrderId) {
			throw new Error(
				"razorpay_subscription_id or razorpay_order_id is required.",
			);
		}

		const secret =
			this.getVerificationSecret();
		const candidates =
			this.buildVerificationCandidates({
				orderId:
					razorpayOrderId?.trim() || null,
				subscriptionId:
					razorpaySubscriptionId?.trim() ||
					null,
				paymentId: razorpayPaymentId,
			});
		const hasValidSignature =
			candidates.some((candidate) => {
				const expectedSignature =
					crypto
						.createHmac("sha256", secret)
						.update(candidate)
						.digest("hex");
				return this.safeTimingEqual(
					expectedSignature,
					razorpaySignature,
				);
			});

		if (!hasValidSignature) {
			logger.warn(
				"Invalid Razorpay payment signature",
				{
					userId,
					razorpayPaymentId,
					razorpaySubscriptionId:
						razorpaySubscriptionId?.trim() ??
						null,
					razorpayOrderId:
						razorpayOrderId ?? null,
				},
			);
			throw new Error(
				"Invalid payment signature.",
			);
		}
		const normalizedSubscriptionId =
			razorpaySubscriptionId?.trim() || null;
		if (!normalizedSubscriptionId) {
			throw new Error(
				"razorpay_subscription_id is required for subscription verification.",
			);
		}

		const subscriptionResult =
			await pool.query<SubscriptionWithPlanRow>(
				`SELECT
           s.*,
           p.name AS plan_name,
           p.description AS plan_description,
           p.monthly_price,
           p.yearly_price,
           p.razorpay_monthly_plan_id,
           p.razorpay_yearly_plan_id,
           p.features,
           p.is_active
         FROM subscriptions s
         INNER JOIN plans p ON p.id = s.plan_id
         WHERE s.user_id = $1
           AND s.razorpay_subscription_id = $2
         LIMIT 1`,
				[userId, normalizedSubscriptionId],
			);

		const currentSubscription =
			subscriptionResult.rows[0];
		if (!currentSubscription) {
			throw new Error(
				"Subscription not found for user.",
			);
		}

		const razorpay =
			this.getRazorpayClient();

		let amount =
			currentSubscription.billing_cycle ===
			"monthly"
				? currentSubscription.monthly_price
				: currentSubscription.yearly_price;
		let currency = "INR";
		let paymentStatus = "failed";
		let orderId: string | null = null;
		let providerSubscriptionStatus =
			this.normalizeProviderStatus(
				currentSubscription.status,
			);
		let providerStartDate: Date | null = null;
		let providerEndDate: Date | null = null;
		let providerNextBillingDate:
			| Date
			| null = null;
		let paymentPayload: Record<
			string,
			unknown
		> = {};
		let subscriptionPayload: unknown = {};

		const paymentDetails =
			(await razorpay.payments.fetch(
				razorpayPaymentId,
			)) as unknown as Record<
				string,
				unknown
			>;
		paymentPayload = paymentDetails;
		if (
			typeof paymentDetails.amount ===
			"number"
		) {
			amount = paymentDetails.amount;
		}
		if (
			typeof paymentDetails.currency ===
			"string"
		) {
			currency = paymentDetails.currency;
		}
		if (
			typeof paymentDetails.status ===
			"string"
		) {
			paymentStatus = paymentDetails.status
				.trim()
				.toLowerCase();
		}
		if (
			typeof paymentDetails.order_id ===
			"string"
		) {
			orderId = paymentDetails.order_id;
		}
		if (
			razorpayOrderId &&
			orderId &&
			razorpayOrderId !== orderId
		) {
			throw new Error(
				"Payment verification failed due to order mismatch.",
			);
		}
		if (
			typeof paymentDetails.subscription_id ===
				"string" &&
			paymentDetails.subscription_id &&
			paymentDetails.subscription_id !==
				normalizedSubscriptionId
		) {
			throw new Error(
				"Payment verification failed due to subscription mismatch.",
			);
		}

		try {
			const subscriptionDetails =
				(await razorpay.subscriptions.fetch(
					normalizedSubscriptionId,
				)) as unknown as Record<
					string,
					unknown
				>;
			subscriptionPayload =
				subscriptionDetails;
			if (
				typeof subscriptionDetails.status ===
				"string"
			) {
				providerSubscriptionStatus =
					this.normalizeProviderStatus(
						subscriptionDetails.status,
					);
			}
			providerStartDate =
				this.parseUnixTimestamp(
					subscriptionDetails.current_start,
				);
			providerEndDate =
				this.parseUnixTimestamp(
					subscriptionDetails.current_end,
				);
			providerNextBillingDate =
				this.parseUnixTimestamp(
					subscriptionDetails.charge_at,
				) ?? providerEndDate;
		} catch (error) {
			logger.warn(
				"Unable to fetch Razorpay subscription details during verification",
				{
					userId,
					razorpaySubscriptionId,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
		}

		const client = await pool.connect();
		let hasCommitted = false;
		try {
			await client.query("BEGIN");

			const paymentResult =
				await client.query<PaymentRow>(
					`INSERT INTO payments (
             user_id,
             subscription_id,
             plan_id,
             razorpay_order_id,
             razorpay_payment_id,
             razorpay_signature,
             amount,
             currency,
             payment_status,
             raw_payload
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           ON CONFLICT (razorpay_payment_id) DO UPDATE
             SET
               payment_status = EXCLUDED.payment_status,
               raw_payload = EXCLUDED.raw_payload
           RETURNING *`,
					[
						userId,
						currentSubscription.id,
						currentSubscription.plan_id,
						orderId,
						razorpayPaymentId,
						razorpaySignature,
						amount,
						currency,
						paymentStatus,
						JSON.stringify({
							payment: paymentPayload,
							subscription:
								subscriptionPayload,
						}),
					],
				);
			const payment =
				paymentResult.rows[0];

			const isPaymentSuccess =
				this.isPaymentSuccessStatus(
					paymentStatus,
				);
			const isSubscriptionActive =
				this.isSubscriptionActiveStatus(
					providerSubscriptionStatus,
				);

			if (!isPaymentSuccess) {
				await client.query("COMMIT");
				hasCommitted = true;
				logger.warn(
					"Payment verification rejected due to unsuccessful payment status",
					{
						userId,
						razorpayPaymentId,
						paymentStatus,
					},
				);
				throw new Error(
					"Payment failed or was cancelled. Your plan has not been changed.",
				);
			}

			if (!isSubscriptionActive) {
				await client.query("COMMIT");
				hasCommitted = true;
				logger.warn(
					"Payment verification rejected because subscription is not active",
					{
						userId,
						razorpayPaymentId,
						subscriptionStatus:
							providerSubscriptionStatus,
					},
				);
				throw new Error(
					"Subscription is not active yet. Please wait a moment and retry verification.",
				);
			}

			const currentMetadata =
				this.toObject(
					currentSubscription.metadata,
				);
			if (
				currentMetadata.lastVerifiedPaymentId ===
					razorpayPaymentId &&
				this.isSubscriptionActiveStatus(
					currentSubscription.status,
				)
			) {
				await client.query("COMMIT");
				hasCommitted = true;
				return {
					subscription:
						this.mapSubscription(
							currentSubscription,
						),
					payment: {
						id: payment.id,
						razorpayPaymentId:
							payment.razorpay_payment_id,
						amount: payment.amount,
						currency: payment.currency,
						status:
							payment.payment_status,
						createdAt:
							payment.created_at.toISOString(),
					},
				};
			}

			const updatedSubscriptionResult =
				await client.query<SubscriptionWithPlanRow>(
					`UPDATE subscriptions
           SET
             status = $2,
             start_date = COALESCE(start_date, $3),
             end_date = COALESCE($4, end_date),
             next_billing_date = COALESCE($5, next_billing_date),
             auto_renew = TRUE,
             cancel_at_cycle_end = FALSE,
             metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING
             subscriptions.*,
             $7::text AS plan_name,
             $8::text AS plan_description,
             $9::int AS monthly_price,
             $10::int AS yearly_price,
             $11::text AS razorpay_monthly_plan_id,
             $12::text AS razorpay_yearly_plan_id,
             $13::jsonb AS features,
             $14::boolean AS is_active`,
					[
						currentSubscription.id,
						providerSubscriptionStatus,
						providerStartDate,
						providerEndDate,
						providerNextBillingDate,
						JSON.stringify({
							lastVerifiedAt:
								new Date().toISOString(),
							lastVerifiedPaymentId:
								razorpayPaymentId,
							lastVerifiedOrderId:
								orderId,
						}),
						currentSubscription.plan_name,
						currentSubscription.plan_description,
						currentSubscription.monthly_price,
						currentSubscription.yearly_price,
						currentSubscription.razorpay_monthly_plan_id,
						currentSubscription.razorpay_yearly_plan_id,
						JSON.stringify(
							currentSubscription.features,
						),
						currentSubscription.is_active,
					],
				);

			await this.applyUserPlan(
				client,
				userId,
				currentSubscription.plan_name,
			);

			const otherSubscriptions =
				await client.query<{
					id: string;
					razorpay_subscription_id: string;
				}>(
					`SELECT id, razorpay_subscription_id
         FROM subscriptions
         WHERE user_id = $1
           AND id <> $2
           AND status = ANY($3::text[])`,
					[
						userId,
						currentSubscription.id,
						CANCELLABLE_SUBSCRIPTION_STATUSES,
					],
				);

			for (const row of otherSubscriptions.rows) {
				try {
					await razorpay.subscriptions.cancel(
						row.razorpay_subscription_id,
						false,
					);
				} catch (error) {
					logger.warn(
						"Failed to cancel older Razorpay subscription during successful upgrade",
						{
							userId,
							razorpaySubscriptionId:
								row.razorpay_subscription_id,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
				}
			}

			await client.query(
				`UPDATE subscriptions
         SET
           status = 'cancelled',
           auto_renew = FALSE,
           cancel_at_cycle_end = FALSE,
           end_date = CURRENT_TIMESTAMP,
           metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
           updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1
           AND id <> $2
           AND status = ANY($4::text[])`,
				[
					userId,
					currentSubscription.id,
					JSON.stringify({
						cancelReason:
							"replaced_by_successful_upgrade",
						cancelledAt:
							new Date().toISOString(),
					}),
					CANCELLABLE_SUBSCRIPTION_STATUSES,
				],
			);

			await client.query("COMMIT");
			hasCommitted = true;

			const updatedSubscription =
				updatedSubscriptionResult.rows[0];

			return {
				subscription:
					this.mapSubscription(
						updatedSubscription,
					),
				payment: {
					id: payment.id,
					razorpayPaymentId:
						payment.razorpay_payment_id,
					amount: payment.amount,
					currency: payment.currency,
					status:
						payment.payment_status,
					createdAt:
						payment.created_at.toISOString(),
				},
			};
		} catch (error) {
			if (!hasCommitted) {
				await client.query("ROLLBACK");
			}
			throw error;
		} finally {
			client.release();
		}
	}

	async cancelSubscription(
		userId: string,
		input: CancelSubscriptionInput,
	): Promise<CurrentSubscriptionResponse> {
		const current =
			await this.getActiveSubscriptionRow(
				userId,
			);
		if (!current) {
			throw new Error(
				"No active subscription found.",
			);
		}

		const cancelAtCycleEnd =
			input.cancelAtCycleEnd ?? true;
		const providerStatus = cancelAtCycleEnd
			? current.status
			: "cancelled";
		const razorpay =
			this.getRazorpayClient();

		try {
			await razorpay.subscriptions.cancel(
				current.razorpay_subscription_id,
				cancelAtCycleEnd,
			);
		} catch (error) {
			logger.warn(
				"Razorpay cancellation call failed",
				{
					userId,
					razorpaySubscriptionId:
						current.razorpay_subscription_id,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
			);
			// Local subscription state is still updated below.
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
					providerStatus,
					cancelAtCycleEnd,
				],
			);

			if (!cancelAtCycleEnd) {
				await this.applyUserPlan(
					client,
					userId,
					"free",
				);
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

	private async resolvePlanFromProviderPlanId(
		providerPlanId: string,
	): Promise<{
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
           WHEN razorpay_monthly_plan_id = $1 THEN 'monthly'
           ELSE 'yearly'
         END AS billing_cycle
       FROM plans
       WHERE razorpay_monthly_plan_id = $1
          OR razorpay_yearly_plan_id = $1
	       LIMIT 1`,
			[providerPlanId],
		);
		const row = result.rows[0];
		if (!row) {
			return null;
		}
		return {
			planId: row.plan_id,
			planName: row.plan_name,
			billingCycle: row.billing_cycle,
		};
	}

	private async upsertSubscriptionFromWebhook(
		subscriptionEntity: Record<string, unknown>,
	): Promise<void> {
		const razorpaySubscriptionId = String(
			subscriptionEntity.id ?? "",
		);
		if (!razorpaySubscriptionId) {
			return;
		}

		const providerStatus = String(
			subscriptionEntity.status ?? "created",
		);
		const startDate =
			this.parseUnixTimestamp(
				subscriptionEntity.current_start,
			);
		const endDate = this.parseUnixTimestamp(
			subscriptionEntity.current_end,
		);
		const nextBillingDate =
			this.parseUnixTimestamp(
				subscriptionEntity.charge_at,
			) ?? endDate;
		const cancelAtCycleEnd = Boolean(
			subscriptionEntity.cancel_at_cycle_end,
		);
		const providerPlanId =
			typeof subscriptionEntity.plan_id ===
			"string"
				? subscriptionEntity.plan_id
				: "";
		const notes =
			(subscriptionEntity.notes as
				| Record<string, unknown>
				| undefined) ?? {};
		const userIdFromNotes =
			typeof notes.user_id === "string"
				? notes.user_id
				: null;

		const existingResult =
			await pool.query<SubscriptionRow>(
				`SELECT *
         FROM subscriptions
         WHERE razorpay_subscription_id = $1
         LIMIT 1`,
				[razorpaySubscriptionId],
			);

		const existing =
			existingResult.rows[0] ?? null;
		const resolvedPlan =
			providerPlanId
				? await this.resolvePlanFromProviderPlanId(
						providerPlanId,
					)
				: null;
		const billingCycleFromNotes =
			typeof notes.billing_cycle === "string" &&
			(notes.billing_cycle === "monthly" ||
				notes.billing_cycle === "yearly")
				? (notes.billing_cycle as BillingCycle)
				: null;

		const client = await pool.connect();
		try {
			await client.query("BEGIN");

			const userId: string | null =
				existing?.user_id ??
				userIdFromNotes;
			const planId: number | null =
				existing?.plan_id ??
				resolvedPlan?.planId ??
				null;
			const billingCycle: BillingCycle =
				existing?.billing_cycle ??
				resolvedPlan?.billingCycle ??
				billingCycleFromNotes ??
				"monthly";

			if (!existing) {
				if (!userId || !planId) {
					logger.warn(
						"Skipping webhook subscription upsert because user/plan resolution failed",
						{
							razorpaySubscriptionId,
						},
					);
					await client.query("COMMIT");
					return;
				}

				await client.query(
					`INSERT INTO subscriptions (
             user_id,
             plan_id,
             billing_cycle,
             razorpay_subscription_id,
             status,
             start_date,
             end_date,
             next_billing_date,
             auto_renew,
             cancel_at_cycle_end,
             metadata
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
					[
						userId,
						planId,
						billingCycle,
						razorpaySubscriptionId,
						providerStatus,
						startDate,
						endDate,
						nextBillingDate,
						!cancelAtCycleEnd &&
							providerStatus !==
								"cancelled",
						cancelAtCycleEnd,
						JSON.stringify(
							subscriptionEntity,
						),
					],
				);
			} else {
				await client.query(
					`UPDATE subscriptions
           SET
             status = $2,
             start_date = COALESCE($3, start_date),
             end_date = COALESCE($4, end_date),
             next_billing_date = COALESCE($5, next_billing_date),
             auto_renew = $6,
             cancel_at_cycle_end = $7,
             metadata = COALESCE(metadata, '{}'::jsonb) || $8::jsonb,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
					[
						existing.id,
						providerStatus,
						startDate,
						endDate,
						nextBillingDate,
						!cancelAtCycleEnd &&
							providerStatus !==
								"cancelled",
						cancelAtCycleEnd,
						JSON.stringify(
							subscriptionEntity,
						),
					],
				);
			}

			if (userId) {
				if (
					providerStatus === "active" &&
					planId !== null
				) {
					const planResult =
						await client.query<{
							name: string;
						}>(
							`SELECT name FROM plans WHERE id = $1 LIMIT 1`,
							[planId],
						);
					const planName =
						planResult.rows[0]?.name;
					if (planName) {
						await this.applyUserPlan(
							client,
							userId,
							planName,
						);
					}
				}

				if (
					["cancelled", "expired", "halted", "completed"].includes(
						providerStatus,
					)
				) {
					await this.downgradeIfNoActiveSubscription(
						client,
						userId,
					);
				}
			}

			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	private async upsertPaymentFromWebhook(
		paymentEntity: Record<string, unknown>,
		fallbackSubscriptionId?: string,
	): Promise<void> {
		const razorpayPaymentId = String(
			paymentEntity.id ?? "",
		);
		if (!razorpayPaymentId) {
			return;
		}

		const subscriptionIdFromPayload =
			typeof paymentEntity.subscription_id ===
			"string"
				? paymentEntity.subscription_id
				: fallbackSubscriptionId ?? null;
		if (!subscriptionIdFromPayload) {
			return;
		}

		const subscriptionResult =
			await pool.query<SubscriptionWithPlanRow>(
				`SELECT
           s.*,
           p.name AS plan_name,
           p.description AS plan_description,
           p.monthly_price,
           p.yearly_price,
           p.razorpay_monthly_plan_id,
           p.razorpay_yearly_plan_id,
           p.features,
           p.is_active
         FROM subscriptions s
         INNER JOIN plans p ON p.id = s.plan_id
         WHERE s.razorpay_subscription_id = $1
         LIMIT 1`,
				[subscriptionIdFromPayload],
			);
		const subscription =
			subscriptionResult.rows[0];
		if (!subscription) {
			return;
		}

		const amount =
			typeof paymentEntity.amount ===
			"number"
				? paymentEntity.amount
				: 0;
		const currency =
			typeof paymentEntity.currency ===
			"string"
				? paymentEntity.currency
				: "INR";
		const paymentStatus =
			typeof paymentEntity.status ===
			"string"
				? paymentEntity.status
				: "captured";
		const orderId =
			typeof paymentEntity.order_id ===
			"string"
				? paymentEntity.order_id
				: null;

		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				`INSERT INTO payments (
           user_id,
           subscription_id,
           plan_id,
           razorpay_order_id,
           razorpay_payment_id,
           amount,
           currency,
           payment_status,
           raw_payload
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (razorpay_payment_id) DO UPDATE
           SET
             payment_status = EXCLUDED.payment_status,
             raw_payload = EXCLUDED.raw_payload`,
				[
					subscription.user_id,
					subscription.id,
					subscription.plan_id,
					orderId,
					razorpayPaymentId,
					amount,
					currency,
					paymentStatus,
					JSON.stringify(paymentEntity),
				],
			);

			if (paymentStatus === "captured") {
				await this.applyUserPlan(
					client,
					subscription.user_id,
					subscription.plan_name,
				);
			}

			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async processWebhook(
		rawBody: string,
		signature: string,
	): Promise<{ processed: boolean; event: string }> {
		if (!rawBody) {
			throw new Error(
				"Webhook body is empty.",
			);
		}
		if (!signature) {
			throw new Error(
				"Missing Razorpay webhook signature.",
			);
		}

		const expected = crypto
			.createHmac(
				"sha256",
				this.getWebhookSecret(),
			)
			.update(rawBody)
			.digest("hex");
		if (!this.safeTimingEqual(expected, signature)) {
			logger.warn(
				"Invalid Razorpay webhook signature",
			);
			throw new Error(
				"Invalid Razorpay webhook signature.",
			);
		}

		const payload = JSON.parse(
			rawBody,
		) as WebhookPayload;
		const event =
			typeof payload.event === "string"
				? payload.event
				: "";
		const subscriptionEntity =
			payload.payload?.subscription?.entity;
		const paymentEntity =
			payload.payload?.payment?.entity;

		if (
			subscriptionEntity &&
			(event ===
				"subscription.activated" ||
				event ===
					"subscription.charged" ||
				event ===
					"subscription.cancelled")
		) {
			await this.upsertSubscriptionFromWebhook(
				subscriptionEntity,
			);
		}

		if (paymentEntity) {
			const fallbackSubscriptionId =
				subscriptionEntity &&
				typeof subscriptionEntity.id ===
					"string"
					? subscriptionEntity.id
					: undefined;
			if (
				event === "subscription.charged" ||
				event === "payment.captured"
			) {
				await this.upsertPaymentFromWebhook(
					paymentEntity,
					fallbackSubscriptionId,
				);
			}
		}

		logger.info(
			"Processed Razorpay webhook event",
			{ event },
		);
		return { processed: true, event };
	}
}

export const subscriptionService =
	new SubscriptionService();
