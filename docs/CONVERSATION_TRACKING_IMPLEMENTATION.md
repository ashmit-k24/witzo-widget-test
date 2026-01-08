# Conversation Tracking & Subscription Model Implementation

## Overview
This document describes the conversation tracking and subscription model implementation for the Free and Basic pricing plans.

**Status**: ✅ **COMPLETED**

**Completion Date**: January 8, 2026

---

## What Was Implemented

### 1. Database Schema ✅

#### Updated `users` Table
Added the following columns to track subscriptions and usage:

```sql
-- Plan and usage tracking
plan_type VARCHAR(20) DEFAULT 'free'  -- 'free' or 'basic'
conversations_used INTEGER DEFAULT 0
conversations_limit INTEGER DEFAULT 20  -- Free: 20, Basic: 500
plan_reset_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
plan_expires_at TIMESTAMP

-- Stripe integration fields
stripe_customer_id VARCHAR(255)
subscription_id VARCHAR(255)
subscription_status VARCHAR(50)
```

#### Created `subscriptions` Table
Tracks user subscriptions with Stripe:

```sql
CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
  stripe_customer_id VARCHAR(255) NOT NULL,
  plan_type VARCHAR(20) NOT NULL,
  status VARCHAR(50) NOT NULL,
  current_period_start TIMESTAMP NOT NULL,
  current_period_end TIMESTAMP NOT NULL,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### Created `payment_history` Table
Tracks all payments:

```sql
CREATE TABLE payment_history (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_payment_id VARCHAR(255) NOT NULL,
  amount INTEGER NOT NULL,
  currency VARCHAR(10) DEFAULT 'usd',
  status VARCHAR(50) NOT NULL,
  plan_type VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Migration Files Created**:
- `src/database/migrate.ts` - Updated with pricing fields
- `src/database/createSubscriptionTables.ts` - Subscription tables

---

### 2. Usage Tracking Service ✅

**File**: `src/services/usageTrackingService.ts`

#### Methods Implemented:

1. **`getUserUsage(userId: string): Promise<UsageStats>`**
   - Returns complete usage statistics for a user
   - Includes: plan type, used/limit/remaining conversations, reset date, warnings

2. **`trackConversation(userId: string): Promise<void>`**
   - Increments conversation counter
   - Called automatically after each successful chat

3. **`canUserChat(userId: string): Promise<boolean>`**
   - Checks if user has remaining conversations
   - Returns true if under limit, false if at/over limit

4. **`getRemainingConversations(userId: string): Promise<number>`**
   - Returns number of conversations left

5. **`isApproachingLimit(userId: string): Promise<boolean>`**
   - Returns true if user has used ≥90% of limit

6. **`resetMonthlyUsage(): Promise<void>`**
   - Resets all users' conversation counters
   - Intended for monthly cron job

7. **`upgradeUserPlan(userId, stripeCustomerId, subscriptionId): Promise<void>`**
   - Upgrades user from free to basic plan
   - Sets limit to 500 conversations

8. **`downgradeUserPlan(userId: string): Promise<void>`**
   - Downgrades user to free plan
   - Sets limit back to 20 conversations

9. **`updateSubscriptionStatus(userId, status): Promise<void>`**
   - Updates subscription status (active, canceled, past_due, etc.)

---

### 3. Middleware Implementation ✅

**File**: `src/middleware/usageLimit.ts`

#### Three Middlewares Created:

1. **`checkConversationLimit`** - Pre-request validation
   - Runs **before** chat processing
   - Checks if user has remaining conversations
   - **Blocks request** with 403 error if limit reached
   - Returns helpful message with upgrade URL

2. **`trackConversation`** - Post-request tracking
   - Runs **after** chat response sent
   - Increments usage counter on successful responses (200)
   - Logs warning if user approaching limit (≥90%)
   - Non-blocking - errors don't affect user experience

3. **`addUsageToResponse`** - Response enrichment
   - Adds usage statistics to `res.locals`
   - Controller uses this to include usage info in response
   - Provides real-time feedback to users

---

### 4. Chat Route Integration ✅

**File**: `src/routes/routes.ts`

Updated chat route with middleware chain:

```typescript
router.post(
  "/chat",
  checkConversationLimit,    // ← Block if at limit
  trackConversation,          // ← Count after success
  addUsageToResponse,         // ← Add stats to response
  chatController.chat
);
```

**Flow**:
1. Request comes in → `checkConversationLimit` verifies user can chat
2. If blocked → Return 403 with limit message
3. If allowed → Process chat request
4. After response → `trackConversation` increments counter
5. Response includes usage stats from `addUsageToResponse`

---

### 5. Chat Controller Updates ✅

**File**: `src/controllers/chatController.ts`

Enhanced response to include usage information:

```typescript
{
  "success": true,
  "sessionId": "abc123",
  "response": "AI response here...",
  "sources": [...],
  "usage": {
    "conversationsRemaining": 15,
    "resetDate": "2026-02-01T00:00:00Z"
  },
  "warning": "You're approaching your monthly conversation limit"  // Only if ≥90%
}
```

---

### 6. Usage API Endpoints ✅

**File**: `src/controllers/usageController.ts`

**File**: `src/routes/routes.ts` (routes added)

#### Endpoints Created:

1. **GET /api/auth/usage** (Protected)
   - Get current authenticated user's usage stats
   - Requires JWT authentication
   - Returns full `UsageStats` object

2. **POST /api/auth/usage/check** (Public)
   - Check usage for any user by userId
   - Used by public chat API
   - Body: `{ "userId": "user-uuid" }`

**Response Format**:
```json
{
  "success": true,
  "data": {
    "planType": "free",
    "conversationsUsed": 18,
    "conversationsLimit": 20,
    "conversationsRemaining": 2,
    "resetDate": "2026-02-01T00:00:00Z",
    "isApproachingLimit": true,
    "isAtLimit": false
  }
}
```

---

### 7. TypeScript Types ✅

**File**: `src/types/index.ts`

Added new types:

```typescript
// Updated User interface with pricing fields
interface User {
  // ... existing fields
  plan_type: 'free' | 'basic';
  conversations_used: number;
  conversations_limit: number;
  plan_reset_date: Date;
  plan_expires_at: Date | null;
  stripe_customer_id: string | null;
  subscription_id: string | null;
  subscription_status: string | null;
}

// Usage statistics
interface UsageStats {
  planType: 'free' | 'basic';
  conversationsUsed: number;
  conversationsLimit: number;
  conversationsRemaining: number;
  resetDate: Date;
  isApproachingLimit: boolean;
  isAtLimit: boolean;
}

// Subscription tracking
interface Subscription {
  id: number;
  user_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  plan_type: 'free' | 'basic';
  status: string;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  created_at: Date;
  updated_at: Date;
}

// Payment history
interface PaymentHistory {
  id: number;
  user_id: string;
  stripe_payment_id: string;
  amount: number;
  currency: string;
  status: string;
  plan_type: 'free' | 'basic';
  created_at: Date;
}
```

---

## How It Works

### User Journey: Free Plan User

1. **New User Signs Up**
   - Default: `plan_type = 'free'`
   - Default: `conversations_limit = 20`
   - Default: `conversations_used = 0`

2. **User Chats (1-19 conversations)**
   - ✅ Request passes `checkConversationLimit`
   - ✅ Chat processed normally
   - ✅ `trackConversation` increments counter
   - ✅ Response includes remaining count

3. **User Approaches Limit (18+ conversations)**
   - ⚠️ Response includes warning message
   - ⚠️ Usage shows `isApproachingLimit: true`

4. **User Hits Limit (20 conversations)**
   - ❌ Request blocked by `checkConversationLimit`
   - ❌ Returns 403 error with upgrade message
   - ❌ Chat not processed

5. **Monthly Reset**
   - 🔄 Cron job runs on 1st of month
   - 🔄 `conversations_used` reset to 0
   - 🔄 User can chat again

### User Journey: Basic Plan User

1. **User Upgrades**
   - `plan_type` → 'basic'
   - `conversations_limit` → 500
   - Stripe customer and subscription IDs stored

2. **User Chats (1-500 conversations)**
   - Same flow as free user
   - Much higher limit (500 vs 20)

3. **Subscription Management**
   - Active: User can chat up to 500/month
   - Canceled: Downgraded to free at period end
   - Past Due: Grace period or immediate downgrade

---

## Testing the Implementation

### Test 1: Check Initial Usage

```bash
curl -X POST http://localhost:3000/api/auth/usage/check \
  -H "Content-Type: application/json" \
  -d '{"userId": "your-user-id"}'
```

**Expected Response**:
```json
{
  "success": true,
  "data": {
    "planType": "free",
    "conversationsUsed": 0,
    "conversationsLimit": 20,
    "conversationsRemaining": 20,
    "resetDate": "2026-01-08T...",
    "isApproachingLimit": false,
    "isAtLimit": false
  }
}
```

### Test 2: Send Chat Message

```bash
curl -X POST http://localhost:3000/api/auth/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "your-user-id",
    "message": "Hello, how are you?"
  }'
```

**Expected Response**:
```json
{
  "success": true,
  "sessionId": "...",
  "response": "...",
  "sources": [],
  "usage": {
    "conversationsRemaining": 19,
    "resetDate": "2026-02-08T..."
  }
}
```

### Test 3: Verify Counter Incremented

Re-run Test 1 and verify:
- `conversationsUsed` increased from 0 to 1
- `conversationsRemaining` decreased from 20 to 19

### Test 4: Simulate Reaching Limit

Update database manually:
```sql
UPDATE users
SET conversations_used = 20
WHERE id = 'your-user-id';
```

Then try to chat - should get 403 error:
```json
{
  "success": false,
  "message": "You've reached your conversation limit for this month",
  "data": {
    "planType": "free",
    "conversationsUsed": 20,
    "conversationsLimit": 20,
    "resetDate": "...",
    "upgradeUrl": "/api/auth/upgrade"
  }
}
```

---

## Database Queries

### Check All Users' Usage
```sql
SELECT
  id,
  email,
  plan_type,
  conversations_used,
  conversations_limit,
  conversations_used::float / conversations_limit * 100 as usage_percentage,
  plan_reset_date
FROM users
ORDER BY conversations_used DESC;
```

### Find Users Approaching Limit
```sql
SELECT
  email,
  plan_type,
  conversations_used,
  conversations_limit,
  conversations_limit - conversations_used as remaining
FROM users
WHERE (conversations_used::float / conversations_limit) >= 0.9
  AND conversations_used < conversations_limit;
```

### Find Users At Limit
```sql
SELECT
  email,
  plan_type,
  conversations_used,
  plan_reset_date
FROM users
WHERE conversations_used >= conversations_limit;
```

### Manually Reset a User
```sql
UPDATE users
SET conversations_used = 0,
    plan_reset_date = CURRENT_TIMESTAMP
WHERE id = 'user-id';
```

### Manually Upgrade User to Basic
```sql
UPDATE users
SET plan_type = 'basic',
    conversations_limit = 500,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'user-id';
```

---

## Error Handling

### Limit Reached (403)
```json
{
  "success": false,
  "message": "You've reached your conversation limit for this month",
  "data": {
    "planType": "free",
    "conversationsUsed": 20,
    "conversationsLimit": 20,
    "resetDate": "2026-02-01T00:00:00Z",
    "upgradeUrl": "/api/auth/upgrade"
  }
}
```

### User Not Found (500)
```json
{
  "success": false,
  "message": "Failed to check usage",
  "error": "User not found"
}
```

### Database Error (500)
```json
{
  "success": false,
  "message": "Internal server error while checking conversation limit"
}
```

---

## Next Steps (Not Yet Implemented)

The following features are planned but not yet implemented:

### 1. Stripe Payment Integration
- Create Stripe service
- Implement checkout session creation
- Handle payment webhooks
- Process successful payments

### 2. Subscription Management
- Upgrade flow (free → basic)
- Downgrade flow (basic → free)
- Cancellation handling
- Payment failure handling

### 3. Monthly Reset Cron Job
- Schedule job for 1st of each month
- Reset all users' conversation counters
- Handle timezone issues
- Log reset operations

### 4. Billing API Endpoints
- GET /api/auth/billing - View billing info
- POST /api/auth/upgrade - Upgrade to basic
- POST /api/auth/cancel - Cancel subscription
- GET /api/auth/invoices - View payment history

### 5. Admin Dashboard
- View all users and their usage
- Manually adjust limits
- View revenue metrics
- Handle customer support issues

---

## Files Modified/Created

### Created Files
1. ✅ `src/services/usageTrackingService.ts` - Usage tracking logic
2. ✅ `src/middleware/usageLimit.ts` - Conversation limit middleware
3. ✅ `src/controllers/usageController.ts` - Usage API endpoints
4. ✅ `src/database/createSubscriptionTables.ts` - Subscription tables migration
5. ✅ `docs/CONVERSATION_TRACKING_IMPLEMENTATION.md` - This file

### Modified Files
1. ✅ `src/database/migrate.ts` - Added pricing fields to users table
2. ✅ `src/types/index.ts` - Added UsageStats, Subscription, PaymentHistory types
3. ✅ `src/routes/routes.ts` - Added middleware to /chat route, added usage routes
4. ✅ `src/controllers/chatController.ts` - Added usage info to chat response

---

## Summary

✅ **Database schema updated** with plan tracking fields
✅ **Usage tracking service** implemented with all core methods
✅ **Middleware chain** protecting chat endpoint
✅ **API endpoints** for checking usage
✅ **Chat responses** now include usage statistics
✅ **Free plan (20 conversations)** fully enforced
✅ **Basic plan (500 conversations)** ready for Stripe integration
✅ **TypeScript types** defined for all new interfaces
✅ **Error handling** implemented for limit scenarios

**Result**: Users on the free plan are now limited to 20 conversations per month, and the system tracks usage in real-time. The infrastructure is ready for Stripe payment integration to enable upgrades to the basic plan.
