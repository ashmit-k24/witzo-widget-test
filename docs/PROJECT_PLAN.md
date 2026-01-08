# Project Implementation Plan
## Pricing & Usage Tracking System

**Deadline**: January 30, 2026
**Start Date**: January 7, 2026
**Duration**: 23 days

---

## Overview

Implement a complete pricing system with:
- Free Plan (20 conversations/month)
- Basic Plan ($9.99/month, 500 conversations)
- Usage tracking and limits
- Stripe payment integration
- Subscription management
- Billing dashboard

---

## Timeline Breakdown

### Week 1: January 7-13 (Database & Core Infrastructure)
**Goal**: Set up database schema and core usage tracking

#### Day 1-2 (Jan 7-8): Database Schema
- [ ] Design complete database schema
- [ ] Create users table migrations (add plan fields)
- [ ] Create usage_tracking table
- [ ] Create subscriptions table
- [ ] Test migrations on development database

**Files to create/modify**:
- `src/database/migrations/003_add_pricing_fields.sql`
- `src/database/migrations/004_create_subscriptions.sql`
- `src/types/index.ts` (add Plan types)

#### Day 3-4 (Jan 9-10): Usage Tracking Service
- [ ] Create `usageTrackingService.ts`
- [ ] Implement conversation counter
- [ ] Implement limit checker
- [ ] Add usage reset functionality
- [ ] Write unit tests

**Files to create**:
- `src/services/usageTrackingService.ts`
- `src/tests/usageTracking.test.ts`

#### Day 5-7 (Jan 11-13): Middleware & Integration
- [ ] Create `checkConversationLimit` middleware
- [ ] Create `trackConversation` middleware
- [ ] Integrate with chat endpoint
- [ ] Add usage warnings (90% limit)
- [ ] Test with different user scenarios

**Files to create/modify**:
- `src/middleware/usageLimit.ts`
- `src/routes/routes.ts` (add middleware to chat route)
- `src/controllers/chatController.ts` (update to track usage)

---

### Week 2: January 14-20 (Stripe & Payment System)
**Goal**: Implement payment processing and subscription management

#### Day 8-10 (Jan 14-16): Stripe Integration
- [ ] Set up Stripe account (if not done)
- [ ] Install Stripe SDK (`npm install stripe`)
- [ ] Create Stripe service wrapper
- [ ] Implement checkout session creation
- [ ] Implement customer creation
- [ ] Set up webhook endpoint
- [ ] Test with Stripe test mode

**Files to create**:
- `src/services/stripeService.ts`
- `src/config/stripe.ts`
- `src/controllers/paymentController.ts`
- `.env` (add STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET)

#### Day 11-12 (Jan 17-18): Subscription Management
- [ ] Create subscription service
- [ ] Implement upgrade flow (free → basic)
- [ ] Implement downgrade flow (basic → free)
- [ ] Implement cancellation flow
- [ ] Handle payment failures
- [ ] Implement grace period logic

**Files to create/modify**:
- `src/services/subscriptionService.ts`
- `src/controllers/subscriptionController.ts`

#### Day 13-14 (Jan 19-20): Webhook Handlers
- [ ] Create Stripe webhook handler
- [ ] Handle `checkout.session.completed`
- [ ] Handle `customer.subscription.updated`
- [ ] Handle `customer.subscription.deleted`
- [ ] Handle `invoice.payment_failed`
- [ ] Test webhook events

**Files to create/modify**:
- `src/controllers/webhookController.ts`
- `src/routes/routes.ts` (add webhook route)

---

### Week 3: January 21-27 (API Endpoints & Dashboard)
**Goal**: Complete user-facing features and testing

#### Day 15-17 (Jan 21-23): API Endpoints
- [ ] **GET /api/auth/usage** - Get current usage stats
- [ ] **POST /api/auth/upgrade** - Upgrade to basic plan
- [ ] **POST /api/auth/cancel** - Cancel subscription
- [ ] **GET /api/auth/billing** - Get billing info
- [ ] **GET /api/auth/invoice/:id** - Get invoice
- [ ] Add validation and error handling
- [ ] Write API documentation

**Files to create/modify**:
- `src/controllers/billingController.ts`
- `src/routes/routes.ts` (add new routes)
- `docs/BILLING_API.md` (API documentation)

#### Day 18-19 (Jan 24-25): Cron Jobs & Automation
- [ ] Install node-cron (`npm install node-cron @types/node-cron`)
- [ ] Create monthly usage reset job
- [ ] Create subscription renewal reminder job
- [ ] Create expired subscription cleanup job
- [ ] Test cron jobs with different timezones

**Files to create**:
- `src/jobs/usageResetJob.ts`
- `src/jobs/subscriptionJobs.ts`
- `src/config/cron.ts`

#### Day 20-21 (Jan 26-27): Testing & Bug Fixes
- [ ] Integration testing (full user flow)
- [ ] Test free plan limits
- [ ] Test basic plan limits
- [ ] Test upgrade/downgrade flows
- [ ] Test payment failures
- [ ] Test webhook scenarios
- [ ] Fix any bugs found
- [ ] Performance testing

---

### Week 4: January 28-30 (Deployment & Documentation)
**Goal**: Deploy to production and finalize documentation

#### Day 22 (Jan 28): Pre-Deployment
- [ ] Environment variable setup (production)
- [ ] Database migration on staging
- [ ] Stripe production mode setup
- [ ] Security audit (API endpoints)
- [ ] Rate limiting review
- [ ] CORS configuration check

#### Day 23 (Jan 29): Deployment
- [ ] Deploy to production
- [ ] Run database migrations
- [ ] Verify Stripe webhooks
- [ ] Monitor logs for errors
- [ ] Test with real payments (small amount)
- [ ] Verify cron jobs are running

#### Day 24 (Jan 30): Documentation & Handoff
- [ ] Complete API documentation
- [ ] Write admin guide
- [ ] Create user guide (how to upgrade)
- [ ] Document webhook testing process
- [ ] Create troubleshooting guide
- [ ] Final review and sign-off

---

## Detailed Task Breakdown

### Phase 1: Database Schema (Jan 7-8)

#### 1.1 Users Table Updates
Add these fields to existing `users` table:

```sql
ALTER TABLE users ADD COLUMN plan_type VARCHAR(20) DEFAULT 'free';
ALTER TABLE users ADD COLUMN conversations_used INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN conversations_limit INTEGER DEFAULT 20;
ALTER TABLE users ADD COLUMN plan_reset_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE users ADD COLUMN plan_expires_at TIMESTAMP;
ALTER TABLE users ADD COLUMN stripe_customer_id VARCHAR(255);
ALTER TABLE users ADD COLUMN subscription_id VARCHAR(255);
ALTER TABLE users ADD COLUMN subscription_status VARCHAR(50);
```

#### 1.2 New Table: subscriptions
```sql
CREATE TABLE subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
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

#### 1.3 New Table: payment_history
```sql
CREATE TABLE payment_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    stripe_payment_id VARCHAR(255) NOT NULL,
    amount INTEGER NOT NULL,
    currency VARCHAR(10) DEFAULT 'usd',
    status VARCHAR(50) NOT NULL,
    plan_type VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

### Phase 2: Usage Tracking Service (Jan 9-10)

#### 2.1 Service Functions

```typescript
class UsageTrackingService {
    // Get user's current usage
    async getUserUsage(userId: string): Promise<UsageStats>

    // Increment conversation count
    async trackConversation(userId: string): Promise<void>

    // Check if user can chat (within limit)
    async canUserChat(userId: string): Promise<boolean>

    // Reset monthly usage (cron job)
    async resetMonthlyUsage(): Promise<void>

    // Get remaining conversations
    async getRemainingConversations(userId: string): Promise<number>

    // Check if approaching limit (90%)
    async isApproachingLimit(userId: string): Promise<boolean>
}
```

#### 2.2 Usage Stats Response
```typescript
interface UsageStats {
    planType: 'free' | 'basic';
    conversationsUsed: number;
    conversationsLimit: number;
    conversationsRemaining: number;
    resetDate: Date;
    isApproachingLimit: boolean; // 90% or more
    isAtLimit: boolean;
}
```

---

### Phase 3: Middleware Implementation (Jan 11-13)

#### 3.1 Conversation Limit Middleware
```typescript
// src/middleware/usageLimit.ts
export const checkConversationLimit = async (req, res, next) => {
    const userId = req.body.userId || req.user?.id;

    const canChat = await usageTrackingService.canUserChat(userId);

    if (!canChat) {
        return res.status(403).json({
            success: false,
            message: "You've reached your conversation limit",
            upgradeUrl: "/api/auth/upgrade"
        });
    }

    next();
};
```

#### 3.2 Track Conversation Middleware
```typescript
export const trackConversation = async (req, res, next) => {
    const userId = req.body.userId || req.user?.id;

    // Track after successful response
    res.on('finish', async () => {
        if (res.statusCode === 200) {
            await usageTrackingService.trackConversation(userId);
        }
    });

    next();
};
```

---

### Phase 4: Stripe Integration (Jan 14-16)

#### 4.1 Stripe Service
```typescript
class StripeService {
    // Create checkout session
    async createCheckoutSession(userId: string, planType: string): Promise<string>

    // Create customer
    async createCustomer(email: string, userId: string): Promise<string>

    // Get subscription
    async getSubscription(subscriptionId: string): Promise<Subscription>

    // Cancel subscription
    async cancelSubscription(subscriptionId: string): Promise<void>

    // Verify webhook signature
    verifyWebhookSignature(payload: string, signature: string): Event
}
```

#### 4.2 Stripe Configuration
- Free Plan: No Stripe product needed
- Basic Plan: $9.99/month recurring
  - Product ID: `prod_basic_plan`
  - Price ID: `price_9_99_monthly`

---

### Phase 5: API Endpoints (Jan 21-23)

#### 5.1 Usage Endpoint
**GET /api/auth/usage**

Response:
```json
{
    "success": true,
    "data": {
        "planType": "free",
        "conversationsUsed": 15,
        "conversationsLimit": 20,
        "conversationsRemaining": 5,
        "resetDate": "2026-02-01T00:00:00Z",
        "isApproachingLimit": false
    }
}
```

#### 5.2 Upgrade Endpoint
**POST /api/auth/upgrade**

Request:
```json
{
    "planType": "basic",
    "successUrl": "https://yourapp.com/success",
    "cancelUrl": "https://yourapp.com/cancel"
}
```

Response:
```json
{
    "success": true,
    "checkoutUrl": "https://checkout.stripe.com/..."
}
```

#### 5.3 Billing Endpoint
**GET /api/auth/billing**

Response:
```json
{
    "success": true,
    "data": {
        "planType": "basic",
        "subscriptionStatus": "active",
        "currentPeriodEnd": "2026-02-07T00:00:00Z",
        "cancelAtPeriodEnd": false,
        "paymentHistory": [
            {
                "id": "pi_xxx",
                "amount": 999,
                "status": "succeeded",
                "date": "2026-01-07T00:00:00Z"
            }
        ]
    }
}
```

---

### Phase 6: Cron Jobs (Jan 24-25)

#### 6.1 Monthly Usage Reset
```typescript
// Runs at 00:00 on the 1st of every month
cron.schedule('0 0 1 * *', async () => {
    await usageTrackingService.resetMonthlyUsage();
});
```

#### 6.2 Subscription Expiry Check
```typescript
// Runs daily at 03:00
cron.schedule('0 3 * * *', async () => {
    await subscriptionService.handleExpiredSubscriptions();
});
```

---

## Risk Management

### Potential Risks & Mitigation

1. **Risk**: Stripe integration delays
   - **Mitigation**: Start Stripe setup early (Day 8), use test mode extensively

2. **Risk**: Database migration issues
   - **Mitigation**: Test migrations on staging first, have rollback plan

3. **Risk**: Webhook reliability
   - **Mitigation**: Implement retry logic, log all webhook events

4. **Risk**: Timezone issues in cron jobs
   - **Mitigation**: Use UTC timestamps, test with different timezones

5. **Risk**: Race conditions in usage tracking
   - **Mitigation**: Use database transactions, implement proper locking

6. **Risk**: Payment failures not handled
   - **Mitigation**: Implement grace period, send email notifications

---

## Success Criteria

- [ ] Free users can only send 20 conversations/month
- [ ] Basic users can send 500 conversations/month
- [ ] Users can upgrade from free to basic via Stripe
- [ ] Payment processing works correctly
- [ ] Subscriptions auto-renew monthly
- [ ] Users can cancel subscriptions
- [ ] Usage resets on 1st of each month
- [ ] All API endpoints return correct responses
- [ ] Webhooks process successfully
- [ ] System handles payment failures gracefully
- [ ] Documentation is complete and accurate

---

## Dependencies & Prerequisites

### NPM Packages to Install
```bash
npm install stripe
npm install @types/stripe
npm install node-cron
npm install @types/node-cron
```

### Environment Variables Needed
```env
# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_BASIC_PLAN_PRICE_ID=price_...

# Application URLs
APP_URL=http://localhost:3000
SUCCESS_URL=http://localhost:3000/success
CANCEL_URL=http://localhost:3000/cancel
```

### External Services
- Stripe Account (with test & production API keys)
- Email service (for payment notifications)
- Cron job scheduler (server)

---

## Testing Checklist

### Unit Tests
- [ ] Usage tracking service tests
- [ ] Subscription service tests
- [ ] Stripe service tests
- [ ] Middleware tests

### Integration Tests
- [ ] Complete user signup → upgrade flow
- [ ] Conversation limit enforcement
- [ ] Payment success flow
- [ ] Payment failure flow
- [ ] Subscription cancellation
- [ ] Usage reset cron job

### Manual Testing Scenarios
1. Free user reaches 20 conversations → blocked
2. Free user upgrades to basic → can chat again
3. Basic user reaches 500 conversations → blocked
4. Payment fails → user gets grace period
5. User cancels → downgraded at period end
6. Monthly reset → all counters reset to 0

---

## Deployment Steps

### Pre-Deployment
1. Backup production database
2. Set environment variables on production server
3. Configure Stripe webhook URL (production)
4. Test payment flow in Stripe test mode
5. Review security settings (CORS, rate limits)

### Deployment
1. Pull latest code to production server
2. Run `npm install` for new dependencies
3. Run database migrations:
   ```bash
   npm run migrate
   ```
4. Restart application server
5. Verify cron jobs are scheduled
6. Test Stripe webhook endpoint
7. Monitor logs for errors

### Post-Deployment
1. Test payment with real credit card (refund after)
2. Verify webhooks in Stripe dashboard
3. Check cron jobs are running
4. Monitor error logs for 24 hours
5. Create rollback plan if issues arise

---

## Documentation to Create

1. **API Documentation** (`docs/BILLING_API.md`)
   - All billing endpoints with examples
   - Error codes and responses
   - Authentication requirements

2. **Admin Guide** (`docs/ADMIN_GUIDE.md`)
   - How to manage subscriptions
   - How to handle payment issues
   - Database queries for support

3. **User Guide** (`docs/USER_GUIDE.md`)
   - How to upgrade account
   - How to manage billing
   - How to cancel subscription

4. **Webhook Guide** (`docs/WEBHOOK_GUIDE.md`)
   - Webhook event types
   - Testing webhooks locally
   - Troubleshooting webhook failures

---

## Daily Progress Tracking

### Week 1 Goals
- ✅ Database schema complete
- ✅ Usage tracking service working
- ✅ Middleware integrated with chat

### Week 2 Goals
- ✅ Stripe integration complete
- ✅ Payment flow working
- ✅ Webhooks handling all events

### Week 3 Goals
- ✅ All API endpoints live
- ✅ Cron jobs scheduled
- ✅ Testing complete

### Week 4 Goals
- ✅ Production deployment
- ✅ Documentation complete
- ✅ System stable

---

## Team Communication

**Daily Standup Questions**:
1. What did you complete yesterday?
2. What will you work on today?
3. Any blockers or issues?

**Weekly Review** (Every Friday):
- Review completed tasks
- Adjust timeline if needed
- Address any technical debt
- Plan next week's priorities

---

## Contingency Plan

If behind schedule:

1. **Priority 1 (Must Have)**:
   - Database schema
   - Usage tracking
   - Basic Stripe integration
   - Conversation limits

2. **Priority 2 (Should Have)**:
   - Complete webhook handlers
   - Billing dashboard
   - Cron jobs

3. **Priority 3 (Nice to Have)**:
   - Advanced error handling
   - Email notifications
   - Analytics dashboard

If critical issues arise, defer Priority 3 items to post-launch.

---

## Launch Checklist (Jan 30)

- [ ] All database migrations applied
- [ ] Stripe in production mode
- [ ] Webhooks verified working
- [ ] Cron jobs scheduled
- [ ] API endpoints tested
- [ ] Documentation complete
- [ ] Security audit passed
- [ ] Performance testing passed
- [ ] Error monitoring active
- [ ] Backup procedures in place

---

## Post-Launch Tasks (After Jan 30)

1. Monitor system for 1 week
2. Collect user feedback
3. Fix any critical bugs
4. Optimize performance
5. Add analytics/reporting
6. Consider Pro tier ($29.99/month)

---

**Project Owner**: Your Name
**Start Date**: January 7, 2026
**Target Completion**: January 30, 2026
**Status**: In Progress
