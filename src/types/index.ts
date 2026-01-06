// User types
export interface User {
  id: string;
  email: string;
  is_verified: boolean;
  created_at: Date;
  updated_at: Date;
  last_login: Date | null;
}

export interface UserResponse {
  id: string;
  email: string;
  isVerified: boolean;
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
  type: 'access' | 'refresh';
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
  EMAIL_HOST: string;
  EMAIL_PORT: number;
  EMAIL_SECURE: boolean;
  EMAIL_USER: string;
  EMAIL_PASSWORD: string;
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
  PINECONE_API_KEY: string;
  PINECONE_ENVIRONMENT: string;
  PINECONE_INDEX_NAME: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
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
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
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