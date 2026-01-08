import { Request, Response } from "express";

/**
 * Get CSRF token
 * @route GET /api/auth/csrf-token
 */
export const getCsrfToken = (_req: Request, res: Response): void => {
     // The setCsrfToken middleware already set the token in the response header
     // Read it from the header that was set by the middleware
     const csrfToken = res.getHeader("X-CSRF-Token") as string;

     if (!csrfToken) {
          res.status(500).json({
               success: false,
               message: "CSRF token not found",
          });
          return;
     }
     // ✅ SET THE COOKIE - This is what was missing!
     res.cookie("csrf_token", csrfToken, {
          httpOnly: false, // MUST be false so JavaScript can read it
          secure: process.env.NODE_ENV === "production", // true only in production
          sameSite: "lax", // or 'strict'
          maxAge: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
          path: "/",
     });

     // Also return in JSON body
     res.status(200).json({
          success: true,
          csrfToken: csrfToken,
          message: "CSRF token retrieved successfully..",
     });
};
