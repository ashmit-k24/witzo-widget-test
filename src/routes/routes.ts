import { Router } from "express";
import { authLimiter, verifyLimiter } from "../config/rateLimiters";
import * as authController from "../controllers/authController";
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

export default router;
