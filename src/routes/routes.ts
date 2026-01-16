import { Router } from "express";
import passport from "../config/passport";
import {
	authLimiter,
	verifyLimiter,
} from "../config/rateLimiters";
import * as authController from "../controllers/authController";
import * as chatController from "../controllers/chatController";
import * as csrfController from "../controllers/csrfController";
import * as documentController from "../controllers/documentController";
import * as scraperController from "../controllers/scraperController";
import * as usageController from "../controllers/usageController";
import * as widgetController from "../controllers/widgetController";
import { authenticateToken } from "../middleware/auth";
import {
	setCsrfToken,
	verifyCsrfToken,
} from "../middleware/csrf";
import { upload } from "../middleware/upload";
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

const router = Router();

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

/**
 * @route   POST /api/auth/usage/check
 * @desc    Check usage statistics for the authenticated user
 * @access  Protected
 */
router.post(
	"/usage/check",
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
	checkScraperLimit,
	scraperController.scrapeWebsite,
);

router.post(
	"/scraper/query",
	verifyCsrfToken,
	authenticateToken,
	scraperController.queryDocuments,
);

router.delete(
	"/scraper/delete",
	verifyCsrfToken,
	authenticateToken,
	scraperController.deleteDocuments,
);

router.delete(
	"/scraper/delete-all",
	verifyCsrfToken,
	authenticateToken,
	scraperController.deleteAllDocuments,
);

router.get(
	"/scraper/stats",
	authenticateToken,
	scraperController.getStats,
);

router.get(
	"/scraper/progress",
	authenticateToken,
	scraperController.getProgress,
);

router.get(
	"/scraper/sources",
	authenticateToken,
	scraperController.getAllSources,
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
	authenticateToken,
	checkConversationLimit,
	trackConversation,
	addUsageToResponse,
	chatController.chat,
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
	authenticateToken,
	chatController.clearChatSession,
);

/**
 * @route   POST /api/auth/chat/clear-user-sessions
 * @desc    Clear all sessions for the authenticated user
 * @access  Protected
 */
router.post(
	"/chat/clear-user-sessions",
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
	passport.authenticate("google", {
		session: false,
	}),
);

/**
 * @route   GET /api/auth/google/callback
 * @desc    Google OAuth callback URL
 * @access  Public
 */
router.get(
	"/google/callback",
	passport.authenticate("google", {
		session: false,
		failureRedirect: "/login",
	}),
	authController.googleCallback,
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
	widgetController.updateWidgetKey,
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
	widgetController.getWidgetAnalytics,
);

export default router;
