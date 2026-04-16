import {
	NextFunction,
	Request,
	Response,
} from "express";
import {
	body,
	param,
	query,
	ValidationChain,
	validationResult,
} from "express-validator";
import {
	CHAT_SUPPORTED_LANGUAGE_CODES,
	SYSTEM_MESSAGE_MAX_LENGTH,
} from "../constants";
import { SCRAPER_PAGE_LIMIT } from "../config/planConfig";
import logger from "../utils/logger";

const WIDGET_KEY_REGEX = /^wk_[a-f0-9]{32}$/i;
const WIDGET_PERSONA_KEYS = [
	"sales",
	"customer_support",
	"ecommerce",
	"website_information",
	"general_information",
] as const;
const SESSION_STATUS_VALUES = [
	"new",
	"contacted",
	"qualified",
	"converted",
] as const;
const SUPPORTED_LANGUAGE_LIST =
	CHAT_SUPPORTED_LANGUAGE_CODES.join(", ");

// Validation rules
export const validationRules: Record<
	string,
	ValidationChain[]
> = {
	requestCode: [
		body("email")
			.trim()
			.isEmail()
			.withMessage("Valid email is required")
			.normalizeEmail()
			.toLowerCase(),
	],

	verifyCode: [
		body("email")
			.trim()
			.isEmail()
			.withMessage("Valid email is required")
			.normalizeEmail()
			.toLowerCase(),
		body("code")
			.trim()
			.isLength({ min: 6, max: 6 })
			.withMessage(
				"Verification code must be 6 digits",
			)
			.isNumeric()
			.withMessage(
				"Verification code must contain only numbers",
			),
	],

	register: [
		body("email")
			.trim()
			.isEmail()
			.withMessage("Valid email is required")
			.normalizeEmail()
			.toLowerCase(),
		body("password")
			.isLength({ min: 8 })
			.withMessage("Password must be at least 8 characters"),
	],

	loginWithPassword: [
		body("email")
			.trim()
			.isEmail()
			.withMessage("Valid email is required")
			.normalizeEmail()
			.toLowerCase(),
		body("password")
			.notEmpty()
			.withMessage("Password is required"),
	],

	forgotPassword: [
		body("email")
			.trim()
			.isEmail()
			.withMessage("Valid email is required")
			.normalizeEmail()
			.toLowerCase(),
	],

	resetPassword: [
		body("token")
			.trim()
			.matches(/^[a-f0-9]{64}$/i)
			.withMessage("token must be a valid reset token"),
		body("password")
			.isString()
			.withMessage("password is required")
			.isLength({ min: 8, max: 256 })
			.withMessage("password must be 8-256 characters"),
	],

	verifyGoogleCode: [
		body("code")
			.trim()
			.isLength({ min: 6, max: 6 })
			.withMessage(
				"Verification code must be 6 digits",
			)
			.isNumeric()
			.withMessage(
				"Verification code must contain only numbers",
			),
		body("pendingToken")
			.optional()
			.isString()
			.withMessage(
				"Pending token must be a string",
			)
			.trim(),
	],

	adminLogin: [
		body("email")
			.trim()
			.isEmail()
			.withMessage("Valid admin email is required")
			.normalizeEmail()
			.toLowerCase(),
		body("password")
			.isString()
			.withMessage("password is required")
			.isLength({ min: 8, max: 256 })
			.withMessage(
				"password must be 8-256 characters",
			),
	],

	updateProfile: [
		body("full_name")
			.isString()
			.isLength({ min: 2, max: 150 })
			.withMessage("full_name must be 2-150 characters"),
		body("company_name")
			.isString()
			.isLength({ min: 2, max: 150 })
			.withMessage("company_name must be 2-150 characters"),
		body("phone_number")
			.isString()
			.isLength({ min: 7, max: 30 })
			.withMessage("phone_number must be 7-30 characters"),
		body("country")
			.isString()
			.isLength({ min: 2, max: 100 })
			.withMessage("country must be 2-100 characters"),
		body("job_title")
			.isString()
			.isLength({ min: 2, max: 120 })
			.withMessage("job_title must be 2-120 characters"),
		body("industry")
			.isString()
			.isLength({ min: 2, max: 120 })
			.withMessage("industry must be 2-120 characters"),
		body("company_website")
			.isString()
			.isLength({ min: 3, max: 255 })
			.withMessage("company_website is required")
			.customSanitizer((value) =>
				typeof value === "string" &&
				!/^https?:\/\//i.test(value)
					? `https://${value}`
					: value,
			)
			.isURL({
				protocols: ["http", "https"],
				require_protocol: true,
			})
			.withMessage("company_website must be a valid URL"),
	],

	changePassword: [
		body("currentPassword")
			.optional({ nullable: true })
			.isString()
			.withMessage("currentPassword must be a string")
			.isLength({ min: 0, max: 256 })
			.withMessage("currentPassword must be 0-256 characters"),
		body("newPassword")
			.isString()
			.withMessage("newPassword is required")
			.isLength({ min: 8, max: 256 })
			.withMessage("newPassword must be 8-256 characters"),
	],

	deleteAccount: [
		body("confirmationText")
			.isString()
			.withMessage("confirmationText is required")
			.custom((value) => String(value).trim() === "DELETE")
			.withMessage('confirmationText must be "DELETE"'),
		body("currentPassword")
			.optional({ nullable: true })
			.isString()
			.withMessage("currentPassword must be a string")
			.isLength({ min: 0, max: 256 })
			.withMessage("currentPassword must be 0-256 characters"),
	],

	updateOnboarding: [
		body("step")
			.isInt({ min: 1, max: 4 })
			.withMessage("step must be an integer between 1 and 4"),
	],

	systemMessageCustomUpdate: [
		body("systemMessage")
			.isString()
			.withMessage("systemMessage must be a string")
			.trim()
			.isLength({
				min: 1,
				max: SYSTEM_MESSAGE_MAX_LENGTH,
			})
			.withMessage(
				`systemMessage must be between 1 and ${SYSTEM_MESSAGE_MAX_LENGTH} characters`,
			),
		body("completeOnboarding")
			.optional()
			.isBoolean()
			.withMessage(
				"completeOnboarding must be boolean",
			),
		body("knowledgeBoundary")
			.optional()
			.isIn([
				"workspace_only",
				"workspace_prefer",
				"general_allowed",
			])
			.withMessage(
				"knowledgeBoundary must be one of workspace_only, workspace_prefer, or general_allowed",
			),
	],

	systemMessageDefaultUpdate: [
		body("completeOnboarding")
			.optional()
			.isBoolean()
			.withMessage(
				"completeOnboarding must be boolean",
			),
		body("knowledgeBoundary")
			.optional()
			.isIn([
				"workspace_only",
				"workspace_prefer",
				"general_allowed",
			])
			.withMessage(
				"knowledgeBoundary must be one of workspace_only, workspace_prefer, or general_allowed",
			),
	],

	widgetPersonaSelect: [
		body("personaKey")
			.isIn([...WIDGET_PERSONA_KEYS])
			.withMessage("personaKey is invalid"),
	],

	revokeSession: [
		param("sessionId")
			.isInt({ min: 1 })
			.withMessage("sessionId must be a positive integer"),
	],

	urlWithOptions: [
		body("url")
			.isString()
			.withMessage("url is required")
			.isLength({ min: 10, max: 2048 })
			.withMessage("url length is invalid")
			.isURL({
				protocols: ["http", "https"],
				require_protocol: true,
			})
			.withMessage("url must be a valid http/https URL"),
		body("maxDepth")
			.optional({ values: "falsy" })
			.isInt({ min: 0, max: 10 })
			.withMessage("maxDepth must be between 0 and 10"),
		body("maxPages")
			.optional({ values: "falsy" })
			.isInt({ min: 1, max: SCRAPER_PAGE_LIMIT })
			.withMessage(`maxPages must be between 1 and ${SCRAPER_PAGE_LIMIT}`),
	],

	deleteByUrl: [
		body("url")
			.isString()
			.withMessage("url is required")
			.isLength({ min: 10, max: 2048 })
			.withMessage("url length is invalid")
			.isURL({
				protocols: ["http", "https"],
				require_protocol: true,
			})
			.withMessage("url must be a valid http/https URL"),
	],

	deleteSourceByUrl: [
		body("url")
			.isString()
			.withMessage("url is required")
			.isLength({ min: 10, max: 2048 })
			.withMessage("url length is invalid")
			.custom((value) => {
				if (typeof value !== "string") {
					return false;
				}

				if (value.startsWith("document://")) {
					return true;
				}

				try {
					const parsedUrl = new URL(value);
					return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
				} catch {
					return false;
				}
			})
			.withMessage("url must be a valid http/https URL or document source"),
	],

	queryDocuments: [
		body("query")
			.isString()
			.isLength({ min: 1, max: 2000 })
			.withMessage("query must be 1-2000 characters"),
		body("topK")
			.optional()
			.isInt({ min: 1, max: 50 })
			.withMessage("topK must be between 1 and 50"),
	],

	chatRequest: [
		body("message")
			.isString()
			.isLength({ min: 1, max: 4000 })
			.withMessage("message must be 1-4000 characters"),
		body("sessionId")
			.optional({ values: "falsy" })
			.isUUID()
			.withMessage("sessionId must be a valid UUID"),
		body("language")
			.optional({ values: "falsy" })
			.isString()
			.withMessage("language must be a string")
			.trim()
			.toLowerCase()
			.isIn([...CHAT_SUPPORTED_LANGUAGE_CODES])
			.withMessage(
				`language must be one of: ${SUPPORTED_LANGUAGE_LIST}`,
			),
	],

	chatSessionParam: [
		param("sessionId")
			.isUUID()
			.withMessage("sessionId must be a valid UUID"),
	],

	widgetCreate: [
		body("widgetName")
			.optional()
			.isString()
			.isLength({ min: 1, max: 100 })
			.withMessage("widgetName must be 1-100 characters"),
		body("allowedDomains")
			.optional()
			.isArray({ max: 100 })
			.withMessage("allowedDomains must be an array"),
		body("allowedDomains.*")
			.optional()
			.isString()
			.isLength({ min: 1, max: 255 })
			.withMessage("each domain must be 1-255 characters"),
		body("widgetConfig")
			.optional()
			.isObject()
			.withMessage("widgetConfig must be an object"),
	],

	widgetUpdate: [
		body("widgetName")
			.optional()
			.isString()
			.isLength({ min: 1, max: 100 })
			.withMessage("widgetName must be 1-100 characters"),
		body("isActive")
			.optional()
			.isBoolean()
			.withMessage("isActive must be boolean"),
		body("allowedDomains")
			.optional()
			.isArray({ max: 100 })
			.withMessage("allowedDomains must be an array"),
		body("allowedDomains.*")
			.optional()
			.isString()
			.isLength({ min: 1, max: 255 })
			.withMessage("each domain must be 1-255 characters"),
		body("widgetConfig")
			.optional()
			.isObject()
			.withMessage("widgetConfig must be an object"),
	],

	widgetAnalyticsQuery: [
		query("limit")
			.optional()
			.isInt({ min: 1, max: 1000 })
			.withMessage("limit must be between 1 and 1000"),
	],

	leadUpdateStatus: [
		param("id")
			.isUUID()
			.withMessage("id must be a valid UUID"),
		body("status")
			.isIn([...SESSION_STATUS_VALUES])
			.withMessage(
				"status must be one of new, contacted, qualified, converted",
			),
	],

	leadDelete: [
		param("id")
			.isUUID()
			.withMessage("id must be a valid UUID"),
	],

	leadWebhookUpsert: [
		body("webhookUrl")
			.optional({ values: "falsy" })
			.isString()
			.withMessage("webhookUrl must be a string")
			.isLength({ max: 2048 })
			.withMessage("webhookUrl must be <= 2048 characters")
			.isURL({
				protocols: ["http", "https"],
				require_protocol: true,
			})
			.withMessage("webhookUrl must be a valid http/https URL"),
		body("isActive")
			.optional()
			.isBoolean()
			.withMessage("isActive must be boolean"),
		body("rotateSecret")
			.optional()
			.isBoolean()
			.withMessage("rotateSecret must be boolean"),
		body()
			.custom((payload) => {
				if (
					payload?.isActive === true &&
					!payload?.webhookUrl
				) {
					throw new Error(
						"webhookUrl is required when isActive is true",
					);
				}
				return true;
			}),
	],

	leadWebhookEventsQuery: [
		query("limit")
			.optional()
			.isInt({ min: 1, max: 100 })
			.withMessage("limit must be between 1 and 100"),
	],

	leadWebhookEventParam: [
		param("eventId")
			.isUUID()
			.withMessage("eventId must be a valid UUID"),
	],

	hubspotConnect: [
		body("returnTo")
			.optional({ values: "falsy" })
			.isString()
			.withMessage("returnTo must be a string")
			.isLength({ max: 256 })
			.withMessage("returnTo must be <= 256 characters")
			.custom((value) => {
				if (
					!value.startsWith("/") ||
					value.startsWith("//")
				) {
					throw new Error(
						"returnTo must be a relative dashboard path",
					);
				}
				return true;
			}),
	],

	hubspotSettings: [
		body("isActive")
			.optional()
			.isBoolean()
			.withMessage("isActive must be boolean"),
		body("contactSyncEnabled")
			.optional()
			.isBoolean()
			.withMessage(
				"contactSyncEnabled must be boolean",
			),
		body("companySyncEnabled")
			.optional()
			.isBoolean()
			.withMessage(
				"companySyncEnabled must be boolean",
			),
		body("noteSyncEnabled")
			.optional()
			.isBoolean()
			.withMessage(
				"noteSyncEnabled must be boolean",
			),
		body().custom((payload) => {
			if (
				typeof payload?.isActive !== "boolean" &&
				typeof payload?.contactSyncEnabled !==
					"boolean" &&
				typeof payload?.companySyncEnabled !==
					"boolean" &&
				typeof payload?.noteSyncEnabled !==
					"boolean"
			) {
				throw new Error(
					"At least one HubSpot setting field is required",
				);
			}
			return true;
		}),
	],

	hubspotEventsQuery: [
		query("limit")
			.optional()
			.isInt({ min: 1, max: 100 })
			.withMessage("limit must be between 1 and 100"),
	],

	hubspotEventParam: [
		param("eventId")
			.isUUID()
			.withMessage("eventId must be a valid UUID"),
	],

	zohoConnect: [
		body("returnTo")
			.optional({ values: "falsy" })
			.isString()
			.withMessage("returnTo must be a string")
			.isLength({ max: 256 })
			.withMessage("returnTo must be <= 256 characters")
			.custom((value) => {
				if (
					!value.startsWith("/") ||
					value.startsWith("//")
				) {
					throw new Error(
						"returnTo must be a relative dashboard path",
					);
				}
				return true;
			}),
	],

	zohoSettings: [
		body("isActive")
			.optional()
			.isBoolean()
			.withMessage("isActive must be boolean"),
		body("leadSyncEnabled")
			.optional()
			.isBoolean()
			.withMessage(
				"leadSyncEnabled must be boolean",
			),
		body("noteSyncEnabled")
			.optional()
			.isBoolean()
			.withMessage(
				"noteSyncEnabled must be boolean",
			),
		body().custom((payload) => {
			if (
				typeof payload?.isActive !== "boolean" &&
				typeof payload?.leadSyncEnabled !==
					"boolean" &&
				typeof payload?.noteSyncEnabled !==
					"boolean"
			) {
				throw new Error(
					"At least one Zoho setting field is required",
				);
			}
			return true;
		}),
	],

	zohoEventsQuery: [
		query("limit")
			.optional()
			.isInt({ min: 1, max: 100 })
			.withMessage("limit must be between 1 and 100"),
	],

	zohoEventParam: [
		param("eventId")
			.isUUID()
			.withMessage("eventId must be a valid UUID"),
	],

	salesforceConnect: [
		body("returnTo")
			.optional({ values: "falsy" })
			.isString()
			.withMessage("returnTo must be a string")
			.isLength({ max: 256 })
			.withMessage("returnTo must be <= 256 characters")
			.custom((value) => {
				if (
					!value.startsWith("/") ||
					value.startsWith("//")
				) {
					throw new Error(
						"returnTo must be a relative dashboard path",
					);
				}
				return true;
			}),
	],

	salesforceSettings: [
		body("isActive")
			.optional()
			.isBoolean()
			.withMessage("isActive must be boolean"),
		body("leadSyncEnabled")
			.optional()
			.isBoolean()
			.withMessage(
				"leadSyncEnabled must be boolean",
			),
		body("taskSyncEnabled")
			.optional()
			.isBoolean()
			.withMessage(
				"taskSyncEnabled must be boolean",
			),
		body().custom((payload) => {
			if (
				typeof payload?.isActive !== "boolean" &&
				typeof payload?.leadSyncEnabled !==
					"boolean" &&
				typeof payload?.taskSyncEnabled !==
					"boolean"
			) {
				throw new Error(
					"At least one Salesforce setting field is required",
				);
			}
			return true;
		}),
	],

	salesforceEventsQuery: [
		query("limit")
			.optional()
			.isInt({ min: 1, max: 100 })
			.withMessage("limit must be between 1 and 100"),
	],

	salesforceEventParam: [
		param("eventId")
			.isUUID()
			.withMessage("eventId must be a valid UUID"),
	],

	calendlyConnect: [
		body("returnTo")
			.optional({ values: "falsy" })
			.isString()
			.withMessage("returnTo must be a string")
			.isLength({ max: 256 })
			.withMessage("returnTo must be <= 256 characters")
			.custom((value) => {
				if (!value.startsWith("/") || value.startsWith("//")) {
					throw new Error("returnTo must be a relative dashboard path");
				}
				return true;
			}),
	],

	calendlySettings: [
		body("isActive")
			.optional()
			.isBoolean()
			.withMessage("isActive must be boolean"),
		body("widgetBookingEnabled")
			.optional()
			.isBoolean()
			.withMessage("widgetBookingEnabled must be boolean"),
		body("bookingIntentEnabled")
			.optional()
			.isBoolean()
			.withMessage("bookingIntentEnabled must be boolean"),
		body("bookingLabel")
			.optional({ nullable: true })
			.isString()
			.withMessage("bookingLabel must be a string")
			.isLength({ min: 1, max: 120 })
			.withMessage("bookingLabel must be 1-120 characters"),
		body("selectedEventTypeUri")
			.optional({ nullable: true })
			.isString()
			.withMessage("selectedEventTypeUri must be a string")
			.isLength({ min: 1, max: 255 })
			.withMessage("selectedEventTypeUri must be 1-255 characters"),
		body().custom((payload) => {
			if (
				typeof payload?.isActive !== "boolean" &&
				typeof payload?.widgetBookingEnabled !== "boolean" &&
				typeof payload?.bookingIntentEnabled !== "boolean" &&
				typeof payload?.bookingLabel !== "string" &&
				typeof payload?.selectedEventTypeUri !== "string" &&
				payload?.selectedEventTypeUri !== null
			) {
				throw new Error("At least one Calendly setting field is required");
			}
			return true;
		}),
	],

	calendlyAppointmentsQuery: [
		query("limit")
			.optional()
			.isInt({ min: 1, max: 100 })
			.withMessage("limit must be between 1 and 100"),
	],

	calendlyWebhookParam: [
		param("integrationId")
			.isUUID()
			.withMessage("integrationId must be a valid UUID"),
	],

	feedbackCreate: [
		body("type")
			.isIn(["feedback", "suggestion"])
			.withMessage(
				'type must be either "feedback" or "suggestion"',
			),
		body("title")
			.optional({ values: "falsy" })
			.isString()
			.isLength({ min: 3, max: 150 })
			.withMessage("title must be 3-150 characters"),
		body("message")
			.isString()
			.isLength({ min: 10, max: 5000 })
			.withMessage("message must be 10-5000 characters"),
		body("pagePath")
			.optional({ values: "falsy" })
			.isString()
			.isLength({ max: 500 })
			.withMessage("pagePath must be <= 500 characters"),
	],

	feedbackList: [
		query("limit")
			.optional()
			.isInt({ min: 1, max: 100 })
			.withMessage("limit must be between 1 and 100"),
	],

	subscriptionCreate: [
		body("planId")
			.optional()
			.isInt({ min: 1 })
			.withMessage("planId must be a positive integer"),
		body("planName")
			.optional()
			.isString()
			.isLength({ min: 2, max: 50 })
			.withMessage("planName must be 2-50 characters"),
		body("billingCycle")
			.isIn(["monthly", "yearly"])
			.withMessage(
				'billingCycle must be either "monthly" or "yearly"',
			),
		body("cancelCurrent")
			.optional()
			.isBoolean()
			.withMessage("cancelCurrent must be boolean"),
		body()
			.custom((payload) => {
				if (
					!payload?.planId &&
					!payload?.planName
				) {
					throw new Error(
						"Either planId or planName is required",
					);
				}
				return true;
			}),
	],

	subscriptionCancel: [
		body("cancelAtCycleEnd")
			.optional()
			.isBoolean()
			.withMessage(
				"cancelAtCycleEnd must be boolean",
			),
	],

	subscriptionUpgrade: [
		body("planId")
			.optional()
			.isInt({ min: 1 })
			.withMessage("planId must be a positive integer"),
		body("planName")
			.optional()
			.isString()
			.isLength({ min: 2, max: 50 })
			.withMessage("planName must be 2-50 characters"),
		body("billingCycle")
			.isIn(["monthly", "yearly"])
			.withMessage(
				'billingCycle must be either "monthly" or "yearly"',
			),
		body().custom((payload) => {
			if (!payload?.planId && !payload?.planName) {
				throw new Error(
					"Either planId or planName is required",
				);
			}
			return true;
		}),
	],

	adminPlanIdParam: [
		param("id")
			.isInt({ min: 1 })
			.withMessage("id must be a positive integer"),
	],

	adminPlanUpsert: [
		body("name")
			.isString()
			.isLength({ min: 2, max: 50 })
			.withMessage("name must be 2-50 characters"),
		body("monthlyPrice")
			.isInt({ min: 0 })
			.withMessage(
				"monthlyPrice must be a non-negative integer",
			),
		body("yearlyPrice")
			.isInt({ min: 0 })
			.withMessage(
				"yearlyPrice must be a non-negative integer",
			),
		body("paddleMonthlyPriceId")
			.optional({ values: "falsy" })
			.isString()
			.isLength({ max: 255 })
			.withMessage(
				"paddleMonthlyPriceId must be <= 255 characters",
			),
		body("paddleYearlyPriceId")
			.optional({ values: "falsy" })
			.isString()
			.isLength({ max: 255 })
			.withMessage(
				"paddleYearlyPriceId must be <= 255 characters",
			),
		body("isActive")
			.optional()
			.isBoolean()
			.withMessage("isActive must be boolean"),
	],

	adminUserIdParam: [
		param("id")
			.isUUID()
			.withMessage("id must be a valid UUID"),
	],

	adminUserCreate: [
		body("email")
			.trim()
			.isEmail()
			.withMessage("Valid admin email is required")
			.normalizeEmail()
			.toLowerCase(),
		body("password")
			.isString()
			.withMessage("password is required")
			.isLength({ min: 8, max: 256 })
			.withMessage("password must be 8-256 characters"),
		body("role")
			.isIn(["super_admin", "ops_admin", "support_admin"])
			.withMessage("role must be a supported admin role"),
		body("isActive")
			.optional()
			.isBoolean()
			.withMessage("isActive must be boolean"),
		body("permissionKeys")
			.optional({ nullable: true })
			.isArray()
			.withMessage("permissionKeys must be an array"),
		body("permissionKeys.*")
			.optional()
			.isString()
			.withMessage("permissionKeys entries must be strings"),
	],

	adminUserUpdate: [
		body("email")
			.trim()
			.isEmail()
			.withMessage("Valid admin email is required")
			.normalizeEmail()
			.toLowerCase(),
		body("password")
			.optional({ values: "falsy" })
			.isString()
			.withMessage("password must be a string")
			.isLength({ min: 8, max: 256 })
			.withMessage("password must be 8-256 characters"),
		body("role")
			.isIn(["super_admin", "ops_admin", "support_admin"])
			.withMessage("role must be a supported admin role"),
		body("isActive")
			.optional()
			.isBoolean()
			.withMessage("isActive must be boolean"),
		body("permissionKeys")
			.optional({ nullable: true })
			.isArray()
			.withMessage("permissionKeys must be an array"),
		body("permissionKeys.*")
			.optional()
			.isString()
			.withMessage("permissionKeys entries must be strings"),
	],

	adminDisallowedDomainsUpdate: [
		body("domains")
			.isArray({ max: 500 })
			.withMessage("domains must be an array"),
		body("domains.*")
			.isString()
			.isLength({ min: 1, max: 255 })
			.withMessage("each domain must be 1-255 characters"),
	],

	adminPersonaParam: [
		param("personaKey")
			.isIn([...WIDGET_PERSONA_KEYS])
			.withMessage("personaKey is invalid"),
	],

	adminPersonaUpdate: [
		body("label")
			.optional()
			.isString()
			.isLength({ min: 1, max: 120 })
			.withMessage("label must be 1-120 characters"),
		body("description")
			.optional()
			.isString()
			.isLength({ max: 1000 })
			.withMessage("description must be <= 1000 characters"),
		body("systemPrompt")
			.isString()
			.isLength({ min: 1, max: SYSTEM_MESSAGE_MAX_LENGTH })
			.withMessage(
				`systemPrompt must be 1-${SYSTEM_MESSAGE_MAX_LENGTH} characters`,
			),
		body("isActive")
			.optional()
			.isBoolean()
			.withMessage("isActive must be boolean"),
	],

	publicWebhook: [
		body("widgetKey")
			.matches(WIDGET_KEY_REGEX)
			.withMessage("widgetKey is invalid"),
		body("message")
			.isString()
			.isLength({ min: 1, max: 4000 })
			.withMessage("message must be 1-4000 characters"),
		body("sessionId")
			.optional({ values: "falsy" })
			.isUUID()
			.withMessage("sessionId must be a valid UUID"),
		body("language")
			.optional({ values: "falsy" })
			.isString()
			.withMessage("language must be a string")
			.trim()
			.toLowerCase()
			.isIn([...CHAT_SUPPORTED_LANGUAGE_CODES])
			.withMessage(
				`language must be one of: ${SUPPORTED_LANGUAGE_LIST}`,
			),
	],

	publicWidgetContact: [
		body("widgetKey")
			.matches(WIDGET_KEY_REGEX)
			.withMessage("widgetKey is invalid"),
		body("sessionId")
			.isUUID()
			.withMessage("sessionId must be a valid UUID"),
		body("email")
			.optional({ values: "falsy" })
			.isEmail()
			.withMessage("email must be valid")
			.normalizeEmail()
			.toLowerCase(),
		body("name")
			.optional({ values: "falsy" })
			.isString()
			.isLength({ max: 150 })
			.withMessage("name must be <= 150 characters"),
		body("message")
			.optional({ values: "falsy" })
			.isString()
			.isLength({ max: 3000 })
			.withMessage("message must be <= 3000 characters"),
		body("phone")
			.optional({ values: "falsy" })
			.isString()
			.isLength({ max: 50 })
			.withMessage("phone must be <= 50 characters"),
		body("country")
			.optional({ values: "falsy" })
			.isString()
			.isLength({ max: 100 })
			.withMessage("country must be <= 100 characters"),
	],

	publicWidgetLeadStatus: [
		body("widgetKey")
			.matches(WIDGET_KEY_REGEX)
			.withMessage("widgetKey is invalid"),
		body("sessionId")
			.isUUID()
			.withMessage("sessionId must be a valid UUID"),
	],
	publicWidgetLeadFinalize: [
		body("widgetKey")
			.matches(WIDGET_KEY_REGEX)
			.withMessage("widgetKey is invalid"),
		body("sessionId")
			.isUUID()
			.withMessage("sessionId must be a valid UUID"),
	],

	publicWidgetRating: [
		body("widgetKey")
			.matches(WIDGET_KEY_REGEX)
			.withMessage("widgetKey is invalid"),
		body("sessionId")
			.isUUID()
			.withMessage("sessionId must be a valid UUID"),
		body("rating")
			.isIn(["up", "down"])
			.withMessage('rating must be "up" or "down"'),
	],
	publicWidgetMessageFeedback: [
		body("widgetKey")
			.matches(WIDGET_KEY_REGEX)
			.withMessage("widgetKey is invalid"),
		body("sessionId")
			.isUUID()
			.withMessage("sessionId must be a valid UUID"),
		body("messageId")
			.isInt({ gt: 0 })
			.withMessage("messageId must be a positive integer"),
		body("feedbackType")
			.isIn(["up", "down"])
			.withMessage('feedbackType must be "up" or "down"'),
		body("feedbackReason")
			.optional({ values: "falsy" })
			.isIn(["Incorrect", "Not helpful"])
			.withMessage('feedbackReason must be "Incorrect" or "Not helpful"'),
	],
};

// Middleware to handle validation errors
export const validate = (
	req: Request,
	res: Response,
	next: NextFunction,
): void => {
	const errors = validationResult(req);

	if (!errors.isEmpty()) {
		const errorMessages = errors
			.array()
			.map((error) => error.msg);

		logger.warn("Validation failed", {
			errors: errorMessages,
			path: req.path,
			ip: req.ip,
		});

		res.status(400).json({
			success: false,
			message: "Validation failed",
			errors: errorMessages,
		});
		return;
	}

	next();
};
