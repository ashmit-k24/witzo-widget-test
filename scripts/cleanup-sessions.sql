-- Script to clean up old sessions before migration
-- Run this if you have existing data and want to preserve users

-- Option 1: Delete all existing sessions (users will need to re-login)
-- This is the safest option for migration
DELETE FROM sessions;

-- Option 2: If you want to see what will be deleted first
-- SELECT * FROM sessions;
