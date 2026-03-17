-- Migration: 20260317_028_user_password_hash
-- Add password_hash column to users for password-based authentication

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;
