import {
	PLAN_CAPABILITIES,
	PlanType,
} from "../config/planConfig";

// User types
export interface User {
	id: string;
	email: string;
	is_verified: boolean;
	created_at: Date;
	updated_at: Date;
	last_login: Date | null;
	plan_type: PlanType;
	conversations_used: number;
	conversations_limit: number | null;
	plan_reset_date: Date;
	plan_expires_at: Date | null;
	login_count: number;
	full_name: string | null;
	company_name: string | null;
	phone_number: string | null;
	country: string | null;
	job_title: string | null;
	industry: string | null;
	company_website: string | null;
	profile_completed: boolean;
	profile_prompt_required_at: Date | null;
	profile_completed_at: Date | null;
	onboarding_step: number;
	onboarding_completed: boolean;
	onboarding_completed_at: Date | null;
	custom_system_message: string | null;
	use_default_system_message: boolean;
	system_message_configured: boolean;
	knowledge_boundary?: string | null;
}

export interface UserResponse {
	id: string;
	email: string;
	isVerified: boolean;
	plan_type?: PlanType;
	sessionId?: number;
	loginCount?: number;
	fullName?: string | null;
	companyName?: string | null;
	phoneNumber?: string | null;
	country?: string | null;
	jobTitle?: string | null;
	industry?: string | null;
	companyWebsite?: string | null;
	profileCompleted?: boolean;
	requiresProfileCompletion?: boolean;
	profilePromptRequiredAt?: Date | null;
	profileCompletedAt?: Date | null;
	onboardingStep?: number;
	onboardingCompleted?: boolean;
	useDefaultSystemMessage?: boolean;
	systemMessageConfigured?: boolean;
	knowledgeBoundary?: string | null;
}

export interface UpdateProfileBody {
	full_name: string;
	company_name: string;
	phone_number: string;
	country: string;
	job_title: string;
	industry: string;
	company_website: string;
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

export interface VerifyGoogleCodeBody {
	code: string;
	pendingToken?: string;
}

export interface RegisterBody {
	email: string;
	password: string;
}

export interface LoginPasswordBody {
	email: string;
	password: string;
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
	DB_SSL_MODE?: string;
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
	PADDLE_API_KEY: string;
	PADDLE_CLIENT_TOKEN: string;
	PADDLE_WEBHOOK_SECRET: string;
	PADDLE_ENVIRONMENT: string;
	LLM_PROMPT_COST_PER_1K_USD: number;
	LLM_COMPLETION_COST_PER_1K_USD: number;

	// Redis
	REDIS_HOST: string;
	REDIS_PORT: number;
	REDIS_USERNAME?: string;
	REDIS_PASSWORD?: string;
	REDIS_TLS_ENABLED: boolean;

	// Separate Redis Instances
	REDIS_CACHE_HOST: string;
	REDIS_CACHE_PORT: number;
	REDIS_CACHE_USERNAME?: string;
	REDIS_CACHE_PASSWORD?: string;

	REDIS_QUEUE_HOST: string;
	REDIS_QUEUE_PORT: number;
	REDIS_QUEUE_USERNAME?: string;
	REDIS_QUEUE_PASSWORD?: string;

	REDIS_ANALYTICS_HOST: string;
	REDIS_ANALYTICS_PORT: number;
	REDIS_ANALYTICS_USERNAME?: string;
	REDIS_ANALYTICS_PASSWORD?: string;

	// Scraper Configuration
	SCRAPER_CONCURRENCY: number;

	// Analytics Configuration
	ANALYTICS_BUFFER_SIZE: number;
	ANALYTICS_FLUSH_INTERVAL_MS: number;

	// Admin
	ADMIN_EMAIL: string;
	ADMIN_PASSWORD: string;
	ADMIN_JWT_SECRET: string;
	ADMIN_TOKEN_EXPIRY_HOURS: number;
	ADMIN_FRONTEND_URL?: string;
	S3_WIDGET_ICON_BUCKET?: string;
	S3_WIDGET_ICON_REGION?: string;
	S3_WIDGET_ICON_PUBLIC_BASE_URL?: string;
	AWS_ACCESS_KEY_ID?: string;
	AWS_SECRET_ACCESS_KEY?: string;
	AWS_SESSION_TOKEN?: string;

	// Email verification
	EMAIL_LIST_VERIFY_API_KEY?: string;

	// Firecrawl
	FIRECRAWL_API_KEY?: string;
	FIRECRAWL_API_URL?: string;
	SCRAPER_RENDER_SERVICE_URL?: string;
	SCRAPER_RENDER_SERVICE_TOKEN?: string;
	SCRAPER_RENDER_SERVICE_MODE?: string;

	// Cohere
	COHERE_API_KEY?: string;

	// RAG pipeline
	PINECONE_HYBRID: boolean;
	HYPE_QUESTIONS_PER_CHUNK: number;
	KNOWLEDGE_BOUNDARY: string;
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
	userId?: string;
	url?: string;
	mode?: "scrape" | "retrain";
	currentUrl?: string;
	maxDepth?: number;
	maxPages?: number;
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
	content?: string;
	text?: string;
	parentText?: string;
	sourceType?: "website" | "document";
	sourceKey?: string;
	sourceRoot?: string;
	sourceRootTitle?: string;
	isHype?: boolean;
	hypeParent?: string;
	pageType?: string;
	clientName?: string;
	industry?: string;
	services?: string;
	cohereScore?: number;
}

export interface RagChunk {
	userId: string;
	url: string;
	pageTitle: string;
	childText: string;  // ~200 words, for embedding
	parentText: string; // up to 600 words, for LLM
	chunkIndex: number;
	sourceType: "website" | "document";
	sourceKey: string;
	isHype: boolean;
	hypeParent: string;
	pageType?: string;
	clientName?: string;
	industry?: string;
	services?: string;
	vectorId?: string; // populated after upsert for metadata updates
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
	language?: string;
}

export interface ChatResponse {
	success: boolean;
	sessionId: string;
	response: string;
	language?: string;
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
	planType: PlanType;
	conversationsUsed: number;
	conversationsLimit: number | null;
	conversationsRemaining: number | null;
	resetDate: Date;
	isApproachingLimit: boolean;
	isAtLimit: boolean;
}

// Document Limits by plan type
export const DOCUMENT_LIMITS: Record<
	PlanType,
	number | null
> = {
	free: PLAN_CAPABILITIES.free.documentLimit,
	basic: PLAN_CAPABILITIES.basic.documentLimit,
	standard:
		PLAN_CAPABILITIES.standard.documentLimit,
	enterprise:
		PLAN_CAPABILITIES.enterprise.documentLimit,
};

// Scraper Usage Stats
export interface ScraperUsageStats {
	planType: PlanType;
	pagesUsed: number;
	pagesLimit: number | null;
	pagesRemaining: number | null;
	isAtLimit: boolean;
}

// Document Usage Stats
export interface DocumentUsageStats {
	planType: PlanType;
	documentsUsed: number;
	documentsLimit: number | null;
	documentsRemaining: number | null;
	isAtLimit: boolean;
}

