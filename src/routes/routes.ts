import { Router } from "express";
import { config } from "../config/env";
import passport from "../config/passport";
import {
	authLimiter,
	verifyLimiter,
} from "../config/rateLimiters";
import * as authController from "../controllers/authController";
import * as chatController from "../controllers/chatController";
import * as csrfController from "../controllers/csrfController";
import * as documentController from "../controllers/documentController";
import * as overviewController from "../controllers/overviewController";
import * as scraperController from "../controllers/scraperController";
import * as usageController from "../controllers/usageController";
import * as widgetController from "../controllers/widgetController";
import * as leadController from "../controllers/leadController";
import * as leadWebhookController from "../controllers/leadWebhookController";
import * as feedbackController from "../controllers/feedbackController";
import { authenticateToken } from "../middleware/auth";
import {
	setCsrfToken,
	verifyCsrfToken,
} from "../middleware/csrf";
import {
	imageUpload,
	upload,
} from "../middleware/upload";
import {
	addUsageToResponse,
	checkConversationLimit,
	checkScraperLimit,
	trackConversation,
} from "../middleware/usageLimit";
import {
	validate,
	validationRules,
} from "../middleware/validator";

const router: Router = Router();

// Apply CSRF token setter to all routes (will set cookie on first request)
router.use(setCsrfToken);

/**
 * @route   GET /api/auth/csrf-token
 * @desc    Get CSRF token for client-side requests
 * @access  Public
 * @returns CSRF token in response body, cookie, and header
 */
router.get(
	"/csrf-token",
	csrfController.getCsrfToken,
);

/**
 * @route   POST /api/auth/request-code
 * @desc    Request verification code for email authentication
 * @access  Public
 */
router.post(
	"/request-code",
	verifyCsrfToken,
	authLimiter,
	validationRules.requestCode,
	validate,
	authController.requestCode,
);

/**
 * @route   POST /api/auth/verify
 * @desc    Verify code and login (sets authentication cookies)
 * @access  Public
 */
router.post(
	"/verify",
	verifyCsrfToken,
	verifyLimiter,
	validationRules.verifyCode,
	validate,
	authController.verifyCode,
);

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token using refresh token from cookies
 * @access  Public (requires refresh token cookie)
 */
router.post(
	"/refresh",
	verifyCsrfToken,
	authController.refreshToken,
);

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user and clear authentication cookies
 * @access  Protected
 */
router.post(
	"/logout",
	verifyCsrfToken,
	authenticateToken,
	authController.logout,
);

/**
 * @route   GET /api/auth/me
 * @desc    Get current authenticated user information
 * @access  Protected
 */
router.get(
	"/me",
	authenticateToken,
	authController.getCurrentUser,
);

/**
 * @route   GET /api/auth/validate
 * @desc    Validate current session
 * @access  Protected
 */
router.get(
	"/validate",
	authenticateToken,
	authController.validateSession,
);

router.get(
	"/profile",
	authenticateToken,
	authController.getProfileStatus,
);

router.put(
	"/profile",
	verifyCsrfToken,
	authenticateToken,
	validationRules.updateProfile,
	validate,
	authController.updateProfile,
);

/**
 * @route   PUT /api/auth/onboarding
 * @desc    Mark an onboarding step as complete
 * @access  Protected
 */
router.put(
	"/onboarding",
	verifyCsrfToken,
	authenticateToken,
	validationRules.updateOnboarding,
	validate,
	authController.updateOnboarding,
);

// ============================================
// Session Management Routes
// ============================================

/**
 * @route   GET /api/auth/sessions
 * @desc    Get all active sessions for the current user
 * @access  Protected
 */
router.get(
	"/sessions",
	authenticateToken,
	authController.getSessions,
);

/**
 * @route   DELETE /api/auth/sessions/:sessionId
 * @desc    Revoke a specific session (logout from a device)
 * @access  Protected
 */
router.delete(
	"/sessions/:sessionId",
	verifyCsrfToken,
	authenticateToken,
	validationRules.revokeSession,
	validate,
	authController.revokeSession,
);

/**
 * @route   POST /api/auth/sessions/revoke-all
 * @desc    Revoke all sessions except current one
 * @access  Protected
 */
router.post(
	"/sessions/revoke-all",
	verifyCsrfToken,
	authenticateToken,
	authController.revokeAllOtherSessions,
);

/**
 * @route   POST /api/auth/logout-all
 * @desc    Logout from all devices (including current)
 * @access  Protected
 */
router.post(
	"/logout-all",
	verifyCsrfToken,
	authenticateToken,
	authController.logoutAll,
);

// ============================================
// Usage Tracking Routes
// ============================================

/**
 * @route   GET /api/auth/usage
 * @desc    Get current user's usage statistics
 * @access  Protected
 */
router.get(
	"/usage",
	authenticateToken,
	usageController.getUserUsage,
);

router.get(
	"/overview/analytics",
	authenticateToken,
	overviewController.getOverviewAnalytics,
);

/**
 * @route   POST /api/auth/usage/check
 * @desc    Check usage statistics for the authenticated user
 * @access  Protected
 */
router.post(
	"/usage/check",
	verifyCsrfToken,
	authenticateToken,
	usageController.checkUsage,
);

// ============================================
// Scraper Routes
// ============================================

router.post(
	"/scraper/scrape",
	verifyCsrfToken,
	authenticateToken,
	validationRules.urlWithOptions,
	validate,
	checkScraperLimit,
	scraperController.scrapeWebsite,
);

router.post(
	"/scraper/query",
	verifyCsrfToken,
	authenticateToken,
	validationRules.queryDocuments,
	validate,
	scraperController.queryDocuments,
);

router.delete(
	"/scraper/delete",
	verifyCsrfToken,
	authenticateToken,
	validationRules.deleteByUrl,
	validate,
	scraperController.deleteDocuments,
);

router.delete(
	"/scraper/delete-page",
	verifyCsrfToken,
	authenticateToken,
	validationRules.deleteByUrl,
	validate,
	scraperController.deletePage,
);

router.delete(
	"/scraper/delete-all",
	verifyCsrfToken,
	authenticateToken,
	scraperController.deleteAllDocuments,
);

router.post(
	"/scraper/retrain",
	verifyCsrfToken,
	authenticateToken,
	validationRules.urlWithOptions,
	validate,
	scraperController.retrainWebsite,
);

router.get(
	"/scraper/stats",
	authenticateToken,
	scraperController.getStats,
);

router.get(
	"/scraper/sources",
	authenticateToken,
	scraperController.getAllSources,
);

router.get(
	"/scraper/status",
	authenticateToken,
	scraperController.getLatestScrapeStatus,
);

router.get(
	"/scraper/status/:jobId",
	authenticateToken,
	scraperController.getScrapeStatusByJobId,
);

/**
 * @route   POST /api/auth/chat
 * @desc    Chat with AI using scraped data (RAG)
 * @access  Protected
 * @middleware checkConversationLimit - Verifies user hasn't exceeded plan limit
 * @middleware trackConversation - Increments usage counter after successful response
 * @middleware addUsageToResponse - Adds usage stats to response
 */
router.post(
	"/chat",
	verifyCsrfToken,
	authenticateToken,
	validationRules.chatRequest,
	validate,
	checkConversationLimit,
	trackConversation,
	addUsageToResponse,
	chatController.chat,
);

/**
 * @route   GET /api/auth/chat/sessions
 * @desc    List all chat sessions for the authenticated user
 * @access  Protected
 */
router.get(
	"/chat/sessions",
	authenticateToken,
	chatController.getUserChatSessions,
);

/**
 * @route   GET /api/auth/chat/session/:sessionId
 * @desc    Get chat session history
 * @access  Protected
 */
router.get(
	"/chat/session/:sessionId",
	authenticateToken,
	chatController.getChatSession,
);

/**
 * @route   DELETE /api/auth/chat/session/:sessionId
 * @desc    Clear a specific chat session
 * @access  Protected
 */
router.delete(
	"/chat/session/:sessionId",
	verifyCsrfToken,
	authenticateToken,
	validationRules.chatSessionParam,
	validate,
	chatController.clearChatSession,
);

/**
 * @route   POST /api/auth/chat/clear-user-sessions
 * @desc    Clear all sessions for the authenticated user
 * @access  Protected
 */
router.post(
	"/chat/clear-user-sessions",
	verifyCsrfToken,
	authenticateToken,
	chatController.clearUserSessions,
);

/**
 * @route   GET /api/auth/google
 * @desc    Initiate Google OAuth login
 * @access  Public
 */
router.get(
	"/google",
	authLimiter,
	authController.initiateGoogleAuth,
);

/**
 * @route   GET /api/auth/google/callback
 * @desc    Google OAuth callback URL
 * @access  Public
 */
router.get(
	"/google/callback",
	authController.validateGoogleOAuthState,
	passport.authenticate("google", {
		session: false,
		failureRedirect: `${config.FRONTEND_URL}/?error=google_auth_failed`,
	}),
	authController.googleCallback,
);

router.post(
	"/google/verify",
	verifyCsrfToken,
	verifyLimiter,
	validationRules.verifyGoogleCode,
	validate,
	authController.verifyGoogleCode,
);

// ============================================
// Document Upload Routes (Protected)
// ============================================

/**
 * @route   POST /api/auth/documents/upload
 * @desc    Upload a single document (PDF, Word, Excel, CSV, TXT)
 * @access  Protected
 * @body    multipart/form-data with 'document' field
 */
router.post(
	"/documents/upload",
	verifyCsrfToken,
	authenticateToken,
	upload.single("document"),
	documentController.uploadDocument,
);

/**
 * @route   POST /api/auth/documents/upload-multiple
 * @desc    Upload multiple documents at once
 * @access  Protected
 * @body    multipart/form-data with 'documents' field (array)
 */
router.post(
	"/documents/upload-multiple",
	verifyCsrfToken,
	authenticateToken,
	upload.array("documents", 10),
	documentController.uploadMultipleDocuments,
);

// ============================================
// Widget Management Routes (Protected)
// ============================================

/**
 * @route   POST /api/auth/widget/create
 * @desc    Create a new widget key for embedding chat
 * @access  Protected
 */
router.post(
	"/widget/create",
	verifyCsrfToken,
	authenticateToken,
	validationRules.widgetCreate,
	validate,
	widgetController.createWidgetKey,
);

/**
 * @route   GET /api/auth/widget/key
 * @desc    Get current user's widget key and config
 * @access  Protected
 */
router.get(
	"/widget/key",
	authenticateToken,
	widgetController.getWidgetKey,
);

/**
 * @route   PUT /api/auth/widget/update
 * @desc    Update widget configuration
 * @access  Protected
 */
router.put(
	"/widget/update",
	verifyCsrfToken,
	authenticateToken,
	validationRules.widgetUpdate,
	validate,
	widgetController.updateWidgetKey,
);

router.post(
	"/widget/icon/upload",
	verifyCsrfToken,
	authenticateToken,
	imageUpload.single("icon"),
	widgetController.uploadWidgetIcon,
);

/**
 * @route   POST /api/auth/widget/regenerate
 * @desc    Regenerate widget key (keeps config)
 * @access  Protected
 */
router.post(
	"/widget/regenerate",
	verifyCsrfToken,
	authenticateToken,
	widgetController.regenerateWidgetKey,
);

/**
 * @route   DELETE /api/auth/widget/delete
 * @desc    Delete widget key
 * @access  Protected
 */
router.delete(
	"/widget/delete",
	verifyCsrfToken,
	authenticateToken,
	widgetController.deleteWidgetKey,
);

/**
 * @route   GET /api/auth/widget/analytics
 * @desc    Get widget usage analytics
 * @access  Protected
 */
router.get(
	"/widget/analytics",
	authenticateToken,
	validationRules.widgetAnalyticsQuery,
	validate,
	widgetController.getWidgetAnalytics,
);

// ============================================
// Leads Routes (Protected)
// ============================================

router.get(
	"/leads",
	authenticateToken,
	leadController.listLeads,
);
router.get(
	"/leads/webhook",
	authenticateToken,
	leadWebhookController.getLeadWebhookConfig,
);

router.put(
	"/leads/webhook",
	verifyCsrfToken,
	authenticateToken,
	validationRules.leadWebhookUpsert,
	validate,
	leadWebhookController.upsertLeadWebhookConfig,
);

router.post(
	"/leads/webhook/test",
	verifyCsrfToken,
	authenticateToken,
	leadWebhookController.sendLeadWebhookTest,
);

router.get(
	"/leads/webhook/events",
	authenticateToken,
	validationRules.leadWebhookEventsQuery,
	validate,
	leadWebhookController.listLeadWebhookEvents,
);

router.post(
	"/leads/webhook/events/:eventId/retry",
	verifyCsrfToken,
	authenticateToken,
	validationRules.leadWebhookEventParam,
	validate,
	leadWebhookController.retryLeadWebhookEvent,
);

router.get(
	"/leads/:id",
	authenticateToken,
	leadController.getLead,
);

router.patch(
	"/leads/:id/status",
	verifyCsrfToken,
	authenticateToken,
	validationRules.leadUpdateStatus,
	validate,
	leadController.updateLeadStatus,
);

router.delete(
	"/leads/:id",
	verifyCsrfToken,
	authenticateToken,
	validationRules.leadDelete,
	validate,
	leadController.deleteLead,
);

// ============================================
// Feedback/Suggestion Routes (Protected)
// ============================================

router.get(
	"/feedback",
	authenticateToken,
	validationRules.feedbackList,
	validate,
	feedbackController.listFeedback,
);

router.post(
	"/feedback",
	verifyCsrfToken,
	authenticateToken,
	validationRules.feedbackCreate,
	validate,
	feedbackController.createFeedback,
);

export default router;
