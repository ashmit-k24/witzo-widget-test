import { NextFunction, Request, Response } from "express";
import { config } from "../config/env";
import { clearCookies, setCookies } from "../middleware/auth";
import authService from "../services/authService";
import googleAuthService, { GoogleProfile } from "../services/googleAuthService";
import { RequestCodeBody, VerifyCodeBody } from "../types";
import logger from "../utils/logger";

/**
 * @route   POST /api/auth/request-code
 * @desc    Request verification code for email authentication
 * @access  Public
 */
export const requestCode = async (req: Request<{}, {}, RequestCodeBody>, res: Response, next: NextFunction): Promise<void> => {
     try {
          const { email } = req.body;

          logger.info("Verification code requested", {
               email,
               ip: req.ip,
               userAgent: req.get("user-agent"),
          });

          const result = await authService.requestVerificationCode(email);

          res.status(200).json(result);
     } catch (error) {
          next(error);
     }
};

/**
 * @route   POST /api/auth/verify
 * @desc    Verify code and login (sets authentication cookies)
 * @access  Public
 */
export const verifyCode = async (req: Request<{}, {}, VerifyCodeBody>, res: Response, next: NextFunction): Promise<void> => {
     try {
          const { email, code } = req.body;
          const ipAddress = req.ip;
          const userAgent = req.get("user-agent");

          logger.info("Verification attempt", {
               email,
               ip: ipAddress,
               userAgent,
          });

          const result = await authService.verifyCode(email, code, ipAddress, userAgent);

          if (result.success && result.accessToken && result.refreshToken) {
               // Set authentication cookies
               setCookies(res, result.accessToken, result.refreshToken);

               // Return success response without tokens (they're in cookies)
               // Include token expiry info for frontend to schedule refresh
               res.status(200).json({
                    success: true,
                    message: result.message,
                    user: result.user,
                    expiresIn: config.ACCESS_TOKEN_EXPIRY_MINUTES * 60, // in seconds
               });
          } else {
               const statusCode = result.success ? 200 : 401;
               res.status(statusCode).json({
                    success: result.success,
                    message: result.message,
                    remainingAttempts: result.remainingAttempts,
               });
          }
     } catch (error) {
          next(error);
     }
};

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token using refresh token from cookies
 * @access  Public (requires refresh token cookie)
 */
export const refreshToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
     try {
          const refreshToken = req.cookies?.refresh_token;

          if (!refreshToken) {
               res.status(401).json({
                    success: false,
                    message: "Refresh token not found",
                    code: "NO_REFRESH_TOKEN",
               });
               return;
          }

          logger.debug("Token refresh requested", {
               ip: req.ip,
          });

          const result = await authService.refreshAccessToken(refreshToken);

          if (result.success && result.accessToken && result.newRefreshToken) {
               // Set new authentication cookies
               setCookies(res, result.accessToken, result.newRefreshToken);

               res.status(200).json({
                    success: true,
                    message: result.message,
                    user: result.user,
                    expiresIn: config.ACCESS_TOKEN_EXPIRY_MINUTES * 60, // in seconds
               });
          } else {
               // Clear invalid cookies
               clearCookies(res);

               res.status(401).json({
                    success: false,
                    message: result.message,
                    code: "REFRESH_FAILED",
               });
          }
     } catch (error) {
          next(error);
     }
};

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user and clear authentication cookies
 * @access  Protected
 */
export const logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
     try {
          const accessToken = req.cookies?.access_token;

          if (!accessToken) {
               res.status(401).json({
                    success: false,
                    message: "No active session",
                    code: "NO_SESSION",
               });
               return;
          }

          logger.info("Logout requested", {
               userId: (req.user as any)?.id,
               email: (req.user as any)?.email,
          });

          const result = await authService.logout(accessToken);

          // Clear authentication cookies
          clearCookies(res);

          res.status(200).json(result);
     } catch (error) {
          next(error);
     }
};

/**
 * @route   GET /api/auth/me
 * @desc    Get current authenticated user information
 * @access  Protected
 */
export const getCurrentUser = async (req: Request, res: Response): Promise<void> => {
     res.status(200).json({
          success: true,
          user: req.user,
     });
};

/**
 * @route   GET /api/auth/validate
 * @desc    Validate current session
 * @access  Protected
 */
export const validateSession = async (req: Request, res: Response): Promise<void> => {
     res.status(200).json({
          success: true,
          message: "Session is valid",
          user: req.user,
     });
};

/**
 * @route   POST /api/auth/google/callback
 * @desc    Handle Google OAuth callback and login user
 * @access  Public
 */
export const googleCallback = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
     try {
          const profile = req.user as GoogleProfile;
          const ipAddress = req.ip;
          const userAgent = req.get("user-agent");

          if (!profile || !profile.email) {
               // Redirect to frontend with error
               const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";
               res.redirect(`${frontendUrl}/login?error=invalid_profile`);
               return;
          }

          logger.info("Google OAuth callback", {
               email: profile.email,
               ip: ipAddress,
               userAgent,
          });

          const result = await googleAuthService.authenticateWithGoogle(profile, ipAddress, userAgent);

          if (result.success && result.accessToken && result.refreshToken) {
               setCookies(res, result.accessToken, result.refreshToken);

               // Redirect to dashboard on success with expiry info in query param
               const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";
               const expiresIn = config.ACCESS_TOKEN_EXPIRY_MINUTES * 60;
               res.redirect(`${frontendUrl}/dashboard?expiresIn=${expiresIn}`);
          } else {
               // Redirect to login with error message
               const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";
               const errorMessage = encodeURIComponent(result.message || "Google authentication failed");
               res.redirect(`${frontendUrl}/login?error=${errorMessage}`);
          }
     } catch (error) {
          next(error);
     }
};
