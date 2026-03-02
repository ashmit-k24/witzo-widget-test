import crypto from "crypto";
import dotenv from "dotenv";
import { EnvConfig } from "../types";

dotenv.config();

const normalizeEnvString = (
	value: string | undefined,
): string | undefined => {
	if (value === undefined) {
		return undefined;
	}

	const trimmedValue = value.trim();
	const isSingleQuoted =
		trimmedValue.startsWith("'") &&
		trimmedValue.endsWith("'");
	const isDoubleQuoted =
		trimmedValue.startsWith('"') &&
		trimmedValue.endsWith('"');

	if (
		trimmedValue.length >= 2 &&
		(isSingleQuoted || isDoubleQuoted)
	) {
		return trimmedValue.slice(1, -1);
	}

	return trimmedValue;
};

const getEnvString = (
	key: string,
	defaultValue: string,
): string => {
	const value = normalizeEnvString(
		process.env[key],
	);
	return value !== undefined && value !== ""
		? value
		: defaultValue;
};

const getOptionalEnvString = (
	key: string,
): string | undefined => {
	const value = normalizeEnvString(
		process.env[key],
	);
	return value !== undefined && value !== ""
		? value
		: undefined;
};

const getEnvStringFromKeys = (
	keys: string[],
	defaultValue: string,
): string => {
	for (const key of keys) {
		const value = normalizeEnvString(
			process.env[key],
		);
		if (value !== undefined && value !== "") {
			return value;
		}
	}
	return defaultValue;
};

const getEnvNumber = (
	key: string,
	defaultValue: number,
): number => {
	const value = normalizeEnvString(
		process.env[key],
	);
	if (!value) {
		return defaultValue;
	}

	const parsedValue = Number(value);
	return Number.isFinite(parsedValue)
		? parsedValue
		: defaultValue;
};

const getEnvBoolean = (
	key: string,
	defaultValue: boolean,
): boolean => {
	const value = normalizeEnvString(
		process.env[key],
	);
	if (!value) {
		return defaultValue;
	}

	const normalizedValue = value.toLowerCase();
	if (
		normalizedValue === "true" ||
		normalizedValue === "1" ||
		normalizedValue === "yes" ||
		normalizedValue === "on"
	) {
		return true;
	}

	if (
		normalizedValue === "false" ||
		normalizedValue === "0" ||
		normalizedValue === "no" ||
		normalizedValue === "off"
	) {
		return false;
	}

	return defaultValue;
};

const getRequiredSecret = (key: string): string => {
	const value = normalizeEnvString(process.env[key]);
	if (value !== undefined && value !== "") {
		return value;
	}

	if (process.env.NODE_ENV === "production") {
		throw new Error(
			`Missing required environment variable: ${key}`,
		);
	}

	const generatedSecret = crypto
		.randomBytes(48)
		.toString("hex");
	console.warn(
		`[env] ${key} is not set. Using an ephemeral development secret. Sessions will reset on restart.`,
	);
	return generatedSecret;
};

export const config: EnvConfig = {
	PORT: getEnvNumber("PORT", 3000),
	NODE_ENV: getEnvString(
		"NODE_ENV",
		"development",
	),

	// Database
	DB_HOST: getEnvString("DB_HOST", "localhost"),
	DB_PORT: getEnvNumber("DB_PORT", 5432),
	DB_NAME: getEnvString("DB_NAME", "auth_db"),
	DB_USER: getEnvString("DB_USER", "postgres"),
	DB_PASSWORD: getEnvString(
		"DB_PASSWORD",
		"postgres",
	),
	DB_MAX_CONNECTIONS: getEnvNumber(
		"DB_MAX_CONNECTIONS",
		20,
	),
	DB_MIN_CONNECTIONS: getEnvNumber(
		"DB_MIN_CONNECTIONS",
		2,
	),

	// Email
	EMAIL_HOST: getEnvString(
		"EMAIL_HOST",
		"smtp.gmail.com",
	),
	EMAIL_PORT: getEnvNumber("EMAIL_PORT", 587),
	EMAIL_SECURE: getEnvBoolean(
		"EMAIL_SECURE",
		false,
	),

	EMAIL_USER: getEnvString("EMAIL_USER", ""),
	EMAIL_PASSWORD: getEnvString(
		"EMAIL_PASSWORD",
		"",
	),
	EMAIL_FROM: getEnvStringFromKeys(
		["EMAIL_FROM", "EMAIL_FROM_ADDRESS"],
		"noreply@witzo.ai",
	),

	// Security
	VERIFICATION_CODE_EXPIRY_MINUTES: getEnvNumber(
		"VERIFICATION_CODE_EXPIRY_MINUTES",
		10,
	),
	MAX_VERIFICATION_ATTEMPTS: getEnvNumber(
		"MAX_VERIFICATION_ATTEMPTS",
		5,
	),
	ACCESS_TOKEN_EXPIRY_MINUTES: getEnvNumber(
		"ACCESS_TOKEN_EXPIRY_MINUTES",
		15,
	),
	REFRESH_TOKEN_EXPIRY_DAYS: getEnvNumber(
		"REFRESH_TOKEN_EXPIRY_DAYS",
		7,
	),
	JWT_SECRET: getRequiredSecret("JWT_SECRET"),
	JWT_REFRESH_SECRET: getRequiredSecret(
		"JWT_REFRESH_SECRET",
	),
	COOKIE_SECRET: getRequiredSecret("COOKIE_SECRET"),

	// Rate Limiting
	RATE_LIMIT_WINDOW_MS: getEnvNumber(
		"RATE_LIMIT_WINDOW_MS",
		900000,
	),
	RATE_LIMIT_MAX_REQUESTS: getEnvNumber(
		"RATE_LIMIT_MAX_REQUESTS",
		1000,
	),

	// Redis Instances (for separation of concerns)
	REDIS_CACHE_HOST: getEnvString(
		"REDIS_CACHE_HOST",
		getEnvString("REDIS_HOST", "localhost"),
	),
	REDIS_CACHE_PORT: getEnvNumber(
		"REDIS_CACHE_PORT",
		getEnvNumber("REDIS_PORT", 6379),
	),
	REDIS_CACHE_PASSWORD:
		getOptionalEnvString(
			"REDIS_CACHE_PASSWORD",
		) ?? getOptionalEnvString("REDIS_PASSWORD"),

	REDIS_QUEUE_HOST: getEnvString(
		"REDIS_QUEUE_HOST",
		getEnvString("REDIS_HOST", "localhost"),
	),
	REDIS_QUEUE_PORT: getEnvNumber(
		"REDIS_QUEUE_PORT",
		getEnvNumber("REDIS_PORT", 6379),
	),
	REDIS_QUEUE_PASSWORD:
		getOptionalEnvString(
			"REDIS_QUEUE_PASSWORD",
		) ?? getOptionalEnvString("REDIS_PASSWORD"),

	REDIS_ANALYTICS_HOST: getEnvString(
		"REDIS_ANALYTICS_HOST",
		getEnvString("REDIS_HOST", "localhost"),
	),
	REDIS_ANALYTICS_PORT: getEnvNumber(
		"REDIS_ANALYTICS_PORT",
		getEnvNumber("REDIS_PORT", 6379),
	),
	REDIS_ANALYTICS_PASSWORD:
		getOptionalEnvString(
			"REDIS_ANALYTICS_PASSWORD",
		) ?? getOptionalEnvString("REDIS_PASSWORD"),

	// Scraper Configuration
	SCRAPER_CONCURRENCY: getEnvNumber(
		"SCRAPER_CONCURRENCY",
		10,
	),

	// Analytics Configuration
	ANALYTICS_BUFFER_SIZE: getEnvNumber(
		"ANALYTICS_BUFFER_SIZE",
		5000,
	),
	ANALYTICS_FLUSH_INTERVAL_MS: getEnvNumber(
		"ANALYTICS_FLUSH_INTERVAL_MS",
		60000,
	),

	// CORS
	CORS_ORIGIN: getOptionalEnvString(
		"CORS_ORIGIN",
	),

	// Google OAuth
	GOOGLE_CLIENT_ID: getEnvString(
		"GOOGLE_CLIENT_ID",
		"",
	),
	GOOGLE_CLIENT_SECRET: getEnvString(
		"GOOGLE_CLIENT_SECRET",
		"",
	),
	GOOGLE_CALLBACK_URL: getEnvString(
		"GOOGLE_CALLBACK_URL",
		"http://localhost:3000/api/auth/google/callback",
	),
	FRONTEND_URL: getEnvString(
		"FRONTEND_URL",
		"http://localhost:3001",
	),

	// Pinecone
	PINECONE_API_KEY: getEnvString(
		"PINECONE_API_KEY",
		"",
	),
	PINECONE_ENVIRONMENT: getEnvString(
		"PINECONE_ENVIRONMENT",
		"us-east-1-aws",
	),
	PINECONE_INDEX_NAME: getEnvString(
		"PINECONE_INDEX_NAME",
		"website-scraper",
	),

	// OpenAI
	OPENAI_API_KEY: getEnvString(
		"OPENAI_API_KEY",
		"",
	),
	OPENAI_MODEL: getEnvString(
		"OPENAI_MODEL",
		"text-embedding-3-small",
	),

	// Redis
	REDIS_HOST: getEnvString(
		"REDIS_HOST",
		"localhost",
	),
	REDIS_PORT: getEnvNumber("REDIS_PORT", 6379),
	REDIS_PASSWORD: getOptionalEnvString(
		"REDIS_PASSWORD",
	),

	// Admin
	ADMIN_EMAIL: getEnvString("ADMIN_EMAIL", "admin@witzo.local"),
	ADMIN_PASSWORD: getEnvString("ADMIN_PASSWORD", ""),
	ADMIN_JWT_SECRET: getRequiredSecret("ADMIN_JWT_SECRET"),
	ADMIN_TOKEN_EXPIRY_HOURS: getEnvNumber("ADMIN_TOKEN_EXPIRY_HOURS", 24),
	ADMIN_FRONTEND_URL: getOptionalEnvString("ADMIN_FRONTEND_URL"),
	S3_WIDGET_ICON_BUCKET: getOptionalEnvString("S3_WIDGET_ICON_BUCKET"),
	S3_WIDGET_ICON_REGION: getOptionalEnvString("S3_WIDGET_ICON_REGION") || getOptionalEnvString("AWS_REGION"),
	S3_WIDGET_ICON_PUBLIC_BASE_URL: getOptionalEnvString("S3_WIDGET_ICON_PUBLIC_BASE_URL"),
	AWS_ACCESS_KEY_ID: getOptionalEnvString("AWS_ACCESS_KEY_ID"),
	AWS_SECRET_ACCESS_KEY: getOptionalEnvString("AWS_SECRET_ACCESS_KEY"),
	AWS_SESSION_TOKEN: getOptionalEnvString("AWS_SESSION_TOKEN"),
};

export default config;
