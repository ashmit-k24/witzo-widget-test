import { Router } from "express";
import passport from "../config/passport";
import { authLimiter, verifyLimiter } from "../config/rateLimiters";
import * as authController from "../controllers/authController";
import * as scraperController from "../controllers/scraperController";
import { authenticateToken } from "../middleware/auth";
import { setCsrfToken, verifyCsrfToken } from "../middleware/csrf";
import { validate, validationRules } from "../middleware/validator";

const router = Router();

// Apply CSRF token setter to all routes (will set cookie on first request)
router.use(setCsrfToken);

/**
 * @route   POST /api/auth/request-code
 * @desc    Request verification code for email authentication
 * @access  Public
 */
router.post("/request-code", verifyCsrfToken, authLimiter, validationRules.requestCode, validate, authController.requestCode);

/**
 * @route   POST /api/auth/verify
 * @desc    Verify code and login (sets authentication cookies)
 * @access  Public
 */
router.post("/verify", verifyCsrfToken, verifyLimiter, validationRules.verifyCode, validate, authController.verifyCode);

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token using refresh token from cookies
 * @access  Public (requires refresh token cookie)
 */
router.post("/refresh", verifyCsrfToken, authController.refreshToken);

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user and clear authentication cookies
 * @access  Protected
 */
router.post("/logout", verifyCsrfToken, authenticateToken, authController.logout);

/**
 * @route   GET /api/auth/me
 * @desc    Get current authenticated user information
 * @access  Protected
 */
router.get("/me", authenticateToken, authController.getCurrentUser);

/**
 * @route   GET /api/auth/validate
 * @desc    Validate current session
 * @access  Protected
 */
router.get("/validate", authenticateToken, authController.validateSession);

/**
 * @route   GET /api/auth/google
 * @desc    Initiate Google OAuth login
 * @access  Public
 */
router.get("/google", authLimiter, passport.authenticate("google", { session: false }));

/**
 * @route   GET /api/auth/google/callback
 * @desc    Google OAuth callback URL
 * @access  Public
 */
router.get("/google/callback", passport.authenticate("google", { session: false, failureRedirect: "/login" }), authController.googleCallback);

// ============================================
// Scraper Routes
// ============================================

/**
 * @route   POST /api/auth/scraper/scrape
 * @desc    Scrape a website and store data in Pinecone
 * @access  Protected
 * @body    { url: string, maxDepth?: number, maxPages?: number }
 */
router.post("/scraper/scrape", verifyCsrfToken, authenticateToken, scraperController.scrapeWebsite);

/**
 * @route   POST /api/auth/scraper/query
 * @desc    Query scraped documents from Pinecone
 * @access  Protected
 * @body    { query: string, topK?: number }
 */
router.post("/scraper/query", verifyCsrfToken, authenticateToken, scraperController.queryDocuments);

/**
 * @route   DELETE /api/auth/scraper/delete
 * @desc    Delete all documents for a specific URL
 * @access  Protected
 * @body    { url: string }
 */
router.delete("/scraper/delete", verifyCsrfToken, authenticateToken, scraperController.deleteDocuments);

/**
 * @route   DELETE /api/auth/scraper/delete-all
 * @desc    Delete all documents for the current user
 * @access  Protected
 */
router.delete("/scraper/delete-all", verifyCsrfToken, authenticateToken, scraperController.deleteAllDocuments);

/**
 * @route   GET /api/auth/scraper/stats
 * @desc    Get Pinecone index statistics for current user
 * @access  Protected
 */
router.get("/scraper/stats", authenticateToken, scraperController.getStats);

/**
 * @route   GET /api/auth/scraper/progress
 * @desc    Get current scraping progress
 * @access  Protected
 */
router.get("/scraper/progress", authenticateToken, scraperController.getProgress);

export default router;
