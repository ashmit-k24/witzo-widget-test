import { Request, Response } from "express";

/**
 * Get CSRF token
 * @route GET /api/auth/csrf-token
 */
export const getCsrfToken = (
	_req: Request,
	res: Response,
): void => {
	// The setCsrfToken middleware sets the token in response header/cookie.
	const csrfToken = res.getHeader(
		"X-CSRF-Token",
	) as string;

	if (!csrfToken) {
		res.status(500).json({
			success: false,
			message: "CSRF token not found",
		});
		return;
	}

	res.status(200).json({
		success: true,
		csrfToken,
		message:
			"CSRF token retrieved successfully.",
	});
};
