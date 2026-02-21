export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";
export const CSRF_RESPONSE_HEADER_NAME = "X-CSRF-Token";
export const CSRF_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CSRF_SAFE_METHODS = ["GET", "HEAD", "OPTIONS"] as const;
