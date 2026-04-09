import {
	NextFunction,
	Request,
	Response,
} from "express";
import { config } from "../config/env";
import logger from "../utils/logger";

// Custom error class
export class AppError extends Error {
	statusCode: number;
	isOperational: boolean;

	constructor(
		message: string,
		statusCode: number,
	) {
		super(message);
		this.statusCode = statusCode;
		this.isOperational = true;

		Error.captureStackTrace(
			this,
			this.constructor,
		);
	}
}

// Global error handler
export const errorHandler = (
	err: Error | AppError,
	req: Request,
	res: Response,
	_next: NextFunction,
): void => {
	const statusCode =
		"statusCode" in err ? err.statusCode : 500;

	logger.error("Unhandled error", {
		error: err.message,
		stack: err.stack,
		path: req.path,
		method: req.method,
		ip: req.ip,
	});

	// Don't leak error details in production
	const message =
		config.NODE_ENV === "production"
			? statusCode >= 500
				? "An unexpected error occurred"
				: err.message
			: err.message;

	res.status(statusCode).json({
		success: false,
		message,
		...(config.NODE_ENV !== "production" && {
			stack: err.stack,
		}),
	});
};

// 404 handler
export const notFoundHandler = (
	_req: Request,
	res: Response,
): void => {
	res.status(404).json({
		success: false,
		message: "Route not found",
	});
};
