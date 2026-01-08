# Conversation Limit Fix - 100 Conversations for Free Plan

## Problem
New users were being created with a conversation limit of 20 instead of the desired 100 conversations.

## Root Cause
The database column `conversations_limit` had a DEFAULT value of 20 set at the database level, even though the migration script (line 204) specified DEFAULT 100. This happened because:

1. The column was created initially with DEFAULT 20
2. The migration only updates the default when adding the column to an existing table
3. Once the column exists, the old DEFAULT (20) remained in the database schema

## Solution Applied

### 1. Updated Existing Users ✅
```sql
UPDATE users
SET conversations_limit = 100
WHERE plan_type = 'free';
```
**Result**: Updated 3 existing users from various limits (20, 6, 5) to 100 conversations.

### 2. Changed Database Default ✅
```sql
ALTER TABLE users
ALTER COLUMN conversations_limit
SET DEFAULT 100;
```
**Result**: All new users will now get 100 conversations by default.

### 3. Updated Migration Script ✅
**File**: [src/database/migrate.ts](../src/database/migrate.ts#L225-L233)

Added logic to ensure the default is always set to 100 when the migration runs:

```typescript
} else {
  logger.info("Pricing fields already exist in users table");

  // Ensure the default is set to 100 (in case it was 20 before)
  await client.query(`
    ALTER TABLE users ALTER COLUMN conversations_limit SET DEFAULT 100;
  `);
  logger.info("Updated conversations_limit default to 100");
}
```

## Verification

Tested creating a new user:
```typescript
INSERT INTO users (id, email) VALUES (uuid, 'test@example.com')
```

**Result**:
```json
{
  "id": "0843cc63-74ec-41c3-a2c2-91e1202c574a",
  "email": "test1767851777915@example.com",
  "conversations_limit": 100,  // ✅ Correct!
  "plan_type": "free"
}
```

## Current Configuration

### Free Plan Users
- **Default Limit**: 100 conversations/month
- **Set at**: Database level (DEFAULT 100)
- **Applied to**: All new user registrations

### Basic Plan Users
- **Limit**: 500 conversations/month
- **Set at**: Application level in [src/services/usageTrackingService.ts:217](../src/services/usageTrackingService.ts#L217)
- **Applied to**: When user upgrades via Stripe

## Files Modified

1. **Database Schema** (via direct SQL)
   - Changed `conversations_limit` DEFAULT from 20 to 100

2. **[src/database/migrate.ts](../src/database/migrate.ts)**
   - Line 204: Already had DEFAULT 100 for new column creation
   - Lines 225-233: Added ALTER DEFAULT 100 for existing columns

## Summary

✅ **All existing free users** updated to 100 conversations
✅ **All new users** will get 100 conversations by default
✅ **Migration script** ensures default is always 100
✅ **Tested and verified** with new user creation

**Status**: Issue completely resolved. Free plan users now have 100 conversations/month as intended.
