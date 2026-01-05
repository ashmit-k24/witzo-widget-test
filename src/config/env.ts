import dotenv from 'dotenv';
import { EnvConfig } from '../types';

dotenv.config();

const getEnvNumber = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
};

const getEnvBoolean = (key: string, defaultValue: boolean): boolean => {
  const value = process.env[key];
  return value ? value === 'true' : defaultValue;
};

export const config: EnvConfig = {
  PORT: getEnvNumber('PORT', 3000),
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // Database
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_PORT: getEnvNumber('DB_PORT', 5432),
  DB_NAME: process.env.DB_NAME || 'auth_db',
  DB_USER: process.env.DB_USER || 'postgres',
  DB_PASSWORD: process.env.DB_PASSWORD || 'postgres',
  DB_MAX_CONNECTIONS: getEnvNumber('DB_MAX_CONNECTIONS', 20),
  
  // Email
  EMAIL_HOST: process.env.EMAIL_HOST || 'smtp.gmail.com',
  EMAIL_PORT: getEnvNumber('EMAIL_PORT', 587),
  EMAIL_SECURE: getEnvBoolean('EMAIL_SECURE', false),
  EMAIL_USER: process.env.EMAIL_USER || '',
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD || '',
  EMAIL_FROM: process.env.EMAIL_FROM || 'noreply@yourapp.com',
  
  // Security
  VERIFICATION_CODE_EXPIRY_MINUTES: getEnvNumber('VERIFICATION_CODE_EXPIRY_MINUTES', 10),
  MAX_VERIFICATION_ATTEMPTS: getEnvNumber('MAX_VERIFICATION_ATTEMPTS', 5),
  ACCESS_TOKEN_EXPIRY_MINUTES: getEnvNumber('ACCESS_TOKEN_EXPIRY_MINUTES', 15),
  REFRESH_TOKEN_EXPIRY_DAYS: getEnvNumber('REFRESH_TOKEN_EXPIRY_DAYS', 7),
  JWT_SECRET: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'your-super-secret-refresh-key-change-in-production',
  COOKIE_SECRET: process.env.COOKIE_SECRET || 'your-super-secret-cookie-key-change-in-production',

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: getEnvNumber('RATE_LIMIT_WINDOW_MS', 900000),
  RATE_LIMIT_MAX_REQUESTS: getEnvNumber('RATE_LIMIT_MAX_REQUESTS', 100),

  // CORS
  CORS_ORIGIN: process.env.CORS_ORIGIN,
};

export default config;