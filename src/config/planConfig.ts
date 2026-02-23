export type PlanType = "free" | "basic" | "enterprise";

export type LimitValue = number | null;

export type SupportTier =
	| "email"
	| "priority_email"
	| "dedicated";

export interface PlanCapabilities {
	websitePagesLimit: LimitValue;
	documentLimit: LimitValue;
	chatHistoryLimit: LimitValue;
	leadStorageLimit: LimitValue;
	fallbackLeadForm: boolean;
	chatRating: boolean;
	autoFollowUpEmail: boolean;
	crmIntegration: boolean;
	whiteLabel: boolean;
	supportTier: SupportTier;
}

export const PLAN_CAPABILITIES: Record<
	PlanType,
	PlanCapabilities
> = {
	free: {
		websitePagesLimit: 15,
		documentLimit: null,
		chatHistoryLimit: 3,
		leadStorageLimit: 3,
		fallbackLeadForm: false,
		chatRating: false,
		autoFollowUpEmail: false,
		crmIntegration: false,
		whiteLabel: false,
		supportTier: "email",
	},
	basic: {
		websitePagesLimit: 30,
		documentLimit: null,
		chatHistoryLimit: 10,
		leadStorageLimit: 10,
		fallbackLeadForm: true,
		chatRating: true,
		autoFollowUpEmail: true,
		crmIntegration: false,
		whiteLabel: false,
		supportTier: "priority_email",
	},
	enterprise: {
		websitePagesLimit: 300,
		documentLimit: null,
		chatHistoryLimit: null,
		leadStorageLimit: null,
		fallbackLeadForm: true,
		chatRating: true,
		autoFollowUpEmail: true,
		crmIntegration: true,
		whiteLabel: true,
		supportTier: "dedicated",
	},
};

export const PLAN_CONVERSATION_DEFAULT_LIMITS: Record<
	PlanType,
	number
> = {
	free: 100,
	basic: 1000,
	enterprise: 1000,
};

export function coercePlanType(
	value: unknown,
): PlanType {
	if (
		value === "free" ||
		value === "basic" ||
		value === "enterprise"
	) {
		return value;
	}
	return "free";
}

export function getPlanCapabilities(
	planType: unknown,
): PlanCapabilities {
	return PLAN_CAPABILITIES[coercePlanType(planType)];
}

export function isUnlimited(
	limit: LimitValue,
): boolean {
	return limit === null;
}
