export type PlanType =
	| "free"
	| "basic"
	| "standard"
	| "enterprise";

export type LimitValue = number | null;

export type SupportTier =
	| "email"
	| "priority_email"
	| "priority"
	| "dedicated";

export type WidgetCustomizationTier =
	| "basic"
	| "standard"
	| "advanced";

export type AnalyticsTier =
	| "basic"
	| "standard"
	| "advanced";

export const SCRAPER_PAGE_LIMIT = 600;

export interface PlanCapabilities {
	documentLimit: LimitValue;
	chatHistoryLimit: LimitValue;
	leadStorageLimit: LimitValue;
	supportedWebsitesLimit: LimitValue;
	widgetInstancesLimit: LimitValue;
	teamMembersLimit: LimitValue;
	fallbackLeadForm: boolean;
	chatRating: boolean;
	autoFollowUpEmail: boolean;
	crmIntegration: boolean;
	multiLanguageSupport: boolean;
	apiAccess: boolean;
	customAiBehavior: boolean;
	whiteLabel: boolean;
	onboardingAssistance: boolean;
	widgetCustomizationTier: WidgetCustomizationTier;
	analyticsTier: AnalyticsTier;
	supportTier: SupportTier;
}

export const PLAN_CAPABILITIES: Record<
	PlanType,
	PlanCapabilities
> = {
	free: {
		documentLimit: 4,
		chatHistoryLimit: 3,
		leadStorageLimit: 3,
		supportedWebsitesLimit: 1,
		widgetInstancesLimit: 1,
		teamMembersLimit: 1,
		fallbackLeadForm: false,
		chatRating: true,
		autoFollowUpEmail: false,
		crmIntegration: false,
		multiLanguageSupport: false,
		apiAccess: false,
		customAiBehavior: false,
		whiteLabel: false,
		onboardingAssistance: false,
		widgetCustomizationTier: "basic",
		analyticsTier: "basic",
		supportTier: "email",
	},
	basic: {
		documentLimit: 10,
		chatHistoryLimit: 10,
		leadStorageLimit: 10,
		supportedWebsitesLimit: 1,
		widgetInstancesLimit: 1,
		teamMembersLimit: 2,
		fallbackLeadForm: true,
		chatRating: true,
		autoFollowUpEmail: true,
		crmIntegration: true,
		multiLanguageSupport: false,
		apiAccess: false,
		customAiBehavior: false,
		whiteLabel: false,
		onboardingAssistance: false,
		widgetCustomizationTier: "standard",
		analyticsTier: "standard",
		supportTier: "priority_email",
	},
	standard: {
		documentLimit: 50,
		chatHistoryLimit: null,
		leadStorageLimit: null,
		supportedWebsitesLimit: 3,
		widgetInstancesLimit: 3,
		teamMembersLimit: 5,
		fallbackLeadForm: true,
		chatRating: true,
		autoFollowUpEmail: true,
		crmIntegration: true,
		multiLanguageSupport: true,
		apiAccess: false,
		customAiBehavior: false,
		whiteLabel: false,
		onboardingAssistance: true,
		widgetCustomizationTier: "advanced",
		analyticsTier: "advanced",
		supportTier: "priority_email",
	},
	enterprise: {
		documentLimit: null,
		chatHistoryLimit: null,
		leadStorageLimit: null,
		supportedWebsitesLimit: null,
		widgetInstancesLimit: null,
		teamMembersLimit: null,
		fallbackLeadForm: true,
		chatRating: true,
		autoFollowUpEmail: true,
		crmIntegration: true,
		multiLanguageSupport: true,
		apiAccess: true,
		customAiBehavior: true,
		whiteLabel: true,
		onboardingAssistance: true,
		widgetCustomizationTier: "advanced",
		analyticsTier: "advanced",
		supportTier: "dedicated",
	},
};

export const PLAN_CONVERSATION_DEFAULT_LIMITS: Record<
	PlanType,
	LimitValue
> = {
	free: 100,
	basic: 1000,
	standard: 5000,
	enterprise: null,
};

export function coercePlanType(
	value: unknown,
): PlanType {
	if (
		value === "free" ||
		value === "basic" ||
		value === "standard" ||
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
