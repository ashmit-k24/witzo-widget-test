import { NextFunction, Request, Response } from "express";

const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function sanitizeString(value: string): string {
	return value.replace(CONTROL_CHARS_REGEX, "").trim();
}

function sanitizeValue(value: unknown): unknown {
	if (typeof value === "string") {
		return sanitizeString(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(item));
	}
	if (value && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [key, nestedValue] of Object.entries(
			value as Record<string, unknown>,
		)) {
			output[key] = sanitizeValue(nestedValue);
		}
		return output;
	}
	return value;
}

export const sanitizeRequestInput = (
	req: Request,
	_res: Response,
	next: NextFunction,
): void => {
	req.body = sanitizeValue(req.body);
	req.query = sanitizeValue(req.query) as Request["query"];
	req.params = sanitizeValue(req.params) as Request["params"];
	next();
};
