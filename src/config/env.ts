import dotenv from "dotenv";
import { EnvConfig } from "../types";

dotenv.config();

const getEnvNumber = (key: string, defaultValue: number): number => {
     const value = process.env[key];
     return value ? parseInt(value, 10) : defaultValue;
};

const getEnvBoolean = (key: string, defaultValue: boolean): boolean => {
     const value = process.env[key];
     return value ? value === "true" : defaultValue;
};

export const config: EnvConfig = {
     PORT: getEnvNumber("PORT", 3000),
     NODE_ENV: process.env.NODE_ENV || "development",

     // Database
     DB_HOST: process.env.DB_HOST || "localhost",
     DB_PORT: getEnvNumber("DB_PORT", 5432),
     DB_NAME: process.env.DB_NAME || "auth_db",
     DB_USER: process.env.DB_USER || "postgres",
     DB_PASSWORD: process.env.DB_PASSWORD || "postgres",
     DB_MAX_CONNECTIONS: getEnvNumber("DB_MAX_CONNECTIONS", 20),

     // Email
     EMAIL_HOST: process.env.EMAIL_HOST || "smtp.gmail.com",
     EMAIL_PORT: getEnvNumber("EMAIL_PORT", 587),
     EMAIL_SECURE: getEnvBoolean("EMAIL_SECURE", false),
     EMAIL_USER: process.env.EMAIL_USER || "",
     EMAIL_PASSWORD: process.env.EMAIL_PASSWORD || "",
     EMAIL_FROM: process.env.EMAIL_FROM || "noreply@yourapp.com",

     // Security
     VERIFICATION_CODE_EXPIRY_MINUTES: getEnvNumber("VERIFICATION_CODE_EXPIRY_MINUTES", 10),
     MAX_VERIFICATION_ATTEMPTS: getEnvNumber("MAX_VERIFICATION_ATTEMPTS", 5),
     ACCESS_TOKEN_EXPIRY_MINUTES: getEnvNumber("ACCESS_TOKEN_EXPIRY_MINUTES", 15),
     REFRESH_TOKEN_EXPIRY_DAYS: getEnvNumber("REFRESH_TOKEN_EXPIRY_DAYS", 7),
     JWT_SECRET: process.env.JWT_SECRET || "dsfkljdshlj984392374kj23bjk2343209432^&(&^&&#jndkjsfnjdsb932nk",
     JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || "dsfkljdshlj984392374kj23bjk2343209432^&(&^&&#jndkjsfnjdsb932nk",
     COOKIE_SECRET: process.env.COOKIE_SECRET || "dsfkljdshlj984392374kj23bjk2343209432^&(&^&&#jndkjsfnjdsb932nk",

     // Rate Limiting
     RATE_LIMIT_WINDOW_MS: getEnvNumber("RATE_LIMIT_WINDOW_MS", 900000),
     RATE_LIMIT_MAX_REQUESTS: getEnvNumber("RATE_LIMIT_MAX_REQUESTS", 100),

     // CORS
     CORS_ORIGIN: process.env.CORS_ORIGIN,

     // Google OAuth
     GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
     GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",
     GOOGLE_CALLBACK_URL: process.env.GOOGLE_CALLBACK_URL || "http://localhost:3000/api/auth/google/callback",
     FRONTEND_URL: process.env.FRONTEND_URL || "http://localhost:3001",

     // Pinecone
     PINECONE_API_KEY: process.env.PINECONE_API_KEY || "",
     PINECONE_ENVIRONMENT: process.env.PINECONE_ENVIRONMENT || "us-east-1-aws",
     PINECONE_INDEX_NAME: process.env.PINECONE_INDEX_NAME || "website-scraper",

     // OpenAI
     OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
     OPENAI_MODEL: process.env.OPENAI_MODEL || "text-embedding-3-small",

     // Redis
     REDIS_HOST: process.env.REDIS_HOST || "localhost",
     REDIS_PORT: getEnvNumber("REDIS_PORT", 6379),
     REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
};

export default config;
