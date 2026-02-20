// User types
export interface User {
	id: string;
	email: string;
	is_verified: boolean;
	created_at: Date;
	updated_at: Date;
	last_login: Date | null;
	plan_type: "free" | "basic";
	conversations_used: number;
	conversations_limit: number;
	plan_reset_date: Date;
	plan_expires_at: Date | null;
	stripe_customer_id: string | null;
	subscription_id: string | null;
	subscription_status: string | null;
}

export interface UserResponse {
	id: string;
	email: string;
	isVerified: boolean;
	plan_type?: "free" | "basic";
	sessionId?: number;
}

// Verification Code types
export interface VerificationCode {
	id: number;
	user_id: string;
	code: string;
	attempts: number;
	expires_at: Date;
	is_used: boolean;
	created_at: Date;
}

// Session types
export interface Session {
	id: number;
	user_id: string;
	access_token: string;
	refresh_token: string;
	access_token_expires_at: Date;
	refresh_token_expires_at: Date;
	created_at: Date;
	updated_at: Date;
	ip_address: string | null;
	user_agent: string | null;
	is_revoked: boolean;
}

// API Response types
export interface ApiResponse<T = any> {
	success: boolean;
	message?: string;
	data?: T;
	errors?: string[];
}

export interface RequestCodeResponse {
	success: boolean;
	message: string;
	expiresIn: number;
}

export interface VerifyCodeResponse {
	success: boolean;
	message: string;
	user?: UserResponse;
	remainingAttempts?: number;
}

export interface RefreshTokenResponse {
	success: boolean;
	message: string;
	user?: UserResponse;
}

export interface ValidationResponse {
	valid: boolean;
	message?: string;
	user?: UserResponse;
}

export interface LogoutResponse {
	success: boolean;
	message: string;
}

export interface CleanupResult {
	sessionsDeleted: number;
	codesDeleted: number;
}

// Email types
export interface EmailResult {
	success: boolean;
	messageId: string;
}

// Request types
export interface RequestCodeBody {
	email: string;
}

export interface VerifyCodeBody {
	email: string;
	code: string;
}

// Database query result types
export interface QueryResult<T> {
	rows: T[];
	rowCount: number;
}

// Logger types
export interface LoggerMeta {
	[key: string]: any;
}

// Token payload
export interface TokenPayload {
	userId: string;
	email: string;
	sessionId: number;
	type: "access" | "refresh";
}

// Environment variables
export interface EnvConfig {
	PORT: number;
	NODE_ENV: string;
	DB_HOST: string;
	DB_PORT: number;
	DB_NAME: string;
	DB_USER: string;
	DB_PASSWORD: string;
	DB_MAX_CONNECTIONS: number;
	DB_MIN_CONNECTIONS: number;
	EMAIL_HOST: string;
	EMAIL_PORT: number;
	EMAIL_SECURE: boolean;
	EMAIL_USER: string;
	EMAIL_PASSWORD: string;
	// Resolved from EMAIL_FROM or EMAIL_FROM_ADDRESS
	EMAIL_FROM: string;
	VERIFICATION_CODE_EXPIRY_MINUTES: number;
	MAX_VERIFICATION_ATTEMPTS: number;
	ACCESS_TOKEN_EXPIRY_MINUTES: number;
	REFRESH_TOKEN_EXPIRY_DAYS: number;
	RATE_LIMIT_WINDOW_MS: number;
	RATE_LIMIT_MAX_REQUESTS: number;
	CORS_ORIGIN?: string;
	JWT_SECRET: string;
	JWT_REFRESH_SECRET: string;
	COOKIE_SECRET: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	GOOGLE_CALLBACK_URL: string;
	FRONTEND_URL: string;
	PINECONE_API_KEY: string;
	PINECONE_ENVIRONMENT: string;
	PINECONE_INDEX_NAME: string;
	OPENAI_API_KEY: string;
	OPENAI_MODEL: string;

	// Redis
	REDIS_HOST: string;
	REDIS_PORT: number;
	REDIS_PASSWORD?: string;

	// Separate Redis Instances
	REDIS_CACHE_HOST: string;
	REDIS_CACHE_PORT: number;
	REDIS_CACHE_PASSWORD?: string;

	REDIS_QUEUE_HOST: string;
	REDIS_QUEUE_PORT: number;
	REDIS_QUEUE_PASSWORD?: string;

	REDIS_ANALYTICS_HOST: string;
	REDIS_ANALYTICS_PORT: number;
	REDIS_ANALYTICS_PASSWORD?: string;

	// Scraper Configuration
	SCRAPER_CONCURRENCY: number;

	// Analytics Configuration
	ANALYTICS_BUFFER_SIZE: number;
	ANALYTICS_FLUSH_INTERVAL_MS: number;
}

// Web Scraper types
export interface ScrapedPage {
	url: string;
	title: string;
	content: string;
	links: string[];
	metadata?: {
		description?: string;
		keywords?: string;
		author?: string;
		[key: string]: any;
	};
}

export interface ScrapeRequest {
	url: string;
	maxDepth?: number;
	maxPages?: number;
}

export interface ScrapeJobStatus {
	jobId: string;
	status:
		| "pending"
		| "in_progress"
		| "completed"
		| "failed";
	progress: {
		totalPages: number;
		scrapedPages: number;
		storedPages: number;
	};
	startedAt: Date;
	completedAt?: Date;
	error?: string;
}

export interface PineconeMetadata {
	url: string;
	title: string;
	description?: string;
	scrapedAt: string;
	chunkIndex: number;
	totalChunks: number;
	userId: string;
}

// Chat types
export interface ChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: Date;
}

export interface ChatSession {
	sessionId: string;
	userId: string;
	messages: ChatMessage[];
	createdAt: Date;
	updatedAt: Date;
}

export interface ChatRequest {
	userId?: string;
	sessionId?: string;
	message: string;
}

export interface ChatResponse {
	success: boolean;
	sessionId: string;
	response: string;
	sources?: Array<{
		url: string;
		title: string;
		relevanceScore: number;
	}>;
	message?: string;
}

// Document Upload types
export interface DocumentUploadResponse {
	success: boolean;
	message: string;
	data?: {
		filename: string;
		fileType: string;
		size: number;
		chunks: number;
		processedAt: string;
	};
	error?: string;
}

export interface ParsedDocument {
	filename: string;
	content: string;
	metadata: {
		fileType: string;
		size: number;
		uploadedAt: string;
		[key: string]: any;
	};
}

// Usage Tracking types
export interface UsageStats {
	planType: "free" | "basic";
	conversationsUsed: number;
	conversationsLimit: number;
	conversationsRemaining: number;
	resetDate: Date;
	isApproachingLimit: boolean;
	isAtLimit: boolean;
}

// Scraper Page Limits by plan type
export const SCRAPER_PAGE_LIMITS: Record<
	"free" | "basic",
	number
> = {
	free: 15,
	basic: 30,
};

// Document Limits by plan type
export const DOCUMENT_LIMITS: Record<
	"free" | "basic",
	number
> = {
	free: 5,
	basic: 10,
};

// Scraper Usage Stats
export interface ScraperUsageStats {
	planType: "free" | "basic";
	pagesUsed: number;
	pagesLimit: number;
	pagesRemaining: number;
	isAtLimit: boolean;
}

// Document Usage Stats
export interface DocumentUsageStats {
	planType: "free" | "basic";
	documentsUsed: number;
	documentsLimit: number;
	documentsRemaining: number;
	isAtLimit: boolean;
}

// Subscription types
export interface Subscription {
	id: number;
	user_id: string;
	stripe_subscription_id: string;
	stripe_customer_id: string;
	plan_type: "free" | "basic";
	status: string;
	current_period_start: Date;
	current_period_end: Date;
	cancel_at_period_end: boolean;
	created_at: Date;
	updated_at: Date;
}

// Payment History types
export interface PaymentHistory {
	id: number;
	user_id: string;
	stripe_payment_id: string;
	amount: number;
	currency: string;
	status: string;
	plan_type: "free" | "basic";
	created_at: Date;
}
