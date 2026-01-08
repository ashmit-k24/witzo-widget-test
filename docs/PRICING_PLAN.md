# Pricing Plan Strategy

## Overview

This document outlines a two-tier pricing strategy with:
1. **Free Plan** - Limited conversations for user acquisition
2. **Basic Plan** - Paid tier with 35% profit margin over costs

---

## Cost Analysis

### Per Conversation Costs

#### GPT-4o API Costs (with caching):
- **First request** (no cache):
  - Input: 2,050 tokens × $2.50/1M = $0.005125
  - Output: 200 tokens × $10.00/1M = $0.002
  - Total: ~$0.007

- **Subsequent requests** (with cache):
  - Cached input: 2,000 tokens × $1.25/1M = $0.0025
  - New input: 50 tokens × $2.50/1M = $0.000125
  - Output: 200 tokens × $10.00/1M = $0.002
  - Total: ~$0.0046

- **Average per conversation**: ~$0.005 (assuming 70% cache hit rate)

#### OpenAI Embeddings Cost:
- Text-embedding-3-small: $0.02 per 1M tokens
- Per query: ~100 tokens × $0.02/1M = $0.000002
- **Negligible cost**: ~$0.000002

#### Pinecone Costs:
- Serverless pricing: $0.40 per 1M read units
- Per query (1 read unit): $0.40/1M = $0.0004
- **Per conversation**: ~$0.0004

#### Server Costs (AWS/DigitalOcean):
- Estimated: $50/month for 50,000 requests
- **Per conversation**: $0.001

### Total Cost Per Conversation:
**$0.005 (GPT) + $0.0004 (Pinecone) + $0.001 (Server) = $0.0064**

---

## Pricing Tiers

### Free Plan

**Price**: $0/month

**Features**:
- 20 conversations per month
- 1 website scraping slot
- 5 document uploads (max 10MB each)
- Basic RAG chatbot
- Email support (48hr response)
- Data retention: 30 days

**Cost to You**:
- 20 conversations × $0.0064 = $0.128/month per user
- Acceptable for user acquisition

**Purpose**: Lead generation and product validation

---

### Basic Plan

**Price**: $9.99/month

**Features**:
- 500 conversations per month
- 5 website scraping slots
- 50 document uploads (max 50MB each)
- Advanced RAG chatbot with GPT-4o
- Priority email support (24hr response)
- Data retention: 90 days
- API access
- Custom branding option

**Cost Breakdown**:
```
Direct Costs:
- 500 conversations × $0.0064 = $3.20
- Storage overhead (Pinecone): $0.50
- Server allocation: $1.00
- Support overhead: $0.50
Total Cost: $5.20

Pricing Calculation:
- Cost: $5.20
- Profit margin: 35%
- Target price: $5.20 × 1.35 = $7.02
- Market price: $9.99 (rounded for psychology)

Actual Profit:
- Revenue: $9.99
- Cost: $5.20
- Profit: $4.79
- Actual margin: 47.9% ✅
```

**Your Profit**: $4.79 per user per month (47.9% margin)

---

## Usage Limits Implementation

### Conversation Tracking

Track user conversations with these metrics:
- Total conversations this month
- Conversations remaining
- Reset date (1st of each month)

### Over-Limit Behavior

When user exceeds limit:
1. **Soft limit** (90% used): Warning notification
2. **Hard limit** (100% used):
   - Block new conversations
   - Show upgrade prompt
   - Allow viewing existing conversations

---

## Revenue Projections

### Scenario 1: Small Scale (Year 1)
- Free users: 500
- Basic users: 50
- Monthly revenue: $499.50
- Monthly costs: $260
- Monthly profit: $239.50
- Annual profit: $2,874

### Scenario 2: Medium Scale (Year 2)
- Free users: 2,000
- Basic users: 300
- Monthly revenue: $2,997
- Monthly costs: $1,816
- Monthly profit: $1,181
- Annual profit: $14,172

### Scenario 3: Growth Scale (Year 3)
- Free users: 10,000
- Basic users: 1,500
- Monthly revenue: $14,985
- Monthly costs: $9,080
- Monthly profit: $5,905
- Annual profit: $70,860

---

## Additional Monetization Opportunities

### Add-on Options:
1. **Extra Conversations Pack**: $4.99 for +200 conversations
2. **Priority Support**: $9.99/month addon
3. **White Label**: $29.99/month addon
4. **Team Plan**: $29.99/month for 5 users (2000 conversations)
5. **Enterprise**: Custom pricing (contact sales)

### Affiliate Program:
- Offer 20% recurring commission for referrals
- Still maintains 25%+ profit margin

---

## Competitive Analysis

### Market Comparison:
- **ChatGPT Plus**: $20/month (unlimited conversations)
- **Perplexity Pro**: $20/month (unlimited)
- **Custom RAG solutions**: $50-200/month

**Your positioning**:
- More affordable than custom solutions
- Specialized for RAG use cases
- Good value at $9.99 for 500 conversations
- Target: Small businesses, content creators, support teams

---

## Implementation Checklist

### Database Schema:
- [ ] Add `plan_type` field to users table (free/basic)
- [ ] Add `conversations_used` field
- [ ] Add `conversations_limit` field
- [ ] Add `plan_reset_date` field
- [ ] Add `plan_expires_at` field

### API Endpoints:
- [ ] GET `/api/auth/usage` - Get current usage stats
- [ ] POST `/api/auth/upgrade` - Upgrade to basic plan
- [ ] POST `/api/auth/cancel` - Cancel subscription
- [ ] GET `/api/auth/billing` - Get billing info

### Middleware:
- [ ] `checkConversationLimit` - Block if over limit
- [ ] `trackConversation` - Increment counter
- [ ] `resetMonthlyUsage` - Cron job for reset

### Payment Integration:
- [ ] Stripe integration for payments
- [ ] Webhook for subscription events
- [ ] Invoice generation
- [ ] Payment failure handling

---

## Next Steps

1. **Phase 1**: Implement usage tracking and limits
2. **Phase 2**: Add Stripe payment integration
3. **Phase 3**: Create upgrade/downgrade flows
4. **Phase 4**: Add billing dashboard
5. **Phase 5**: Launch with early bird discount (50% off for 3 months)

---

## Notes

- Consider offering annual plans (save 20%): $95.90/year
- Monitor actual costs and adjust pricing quarterly
- Consider introducing Pro tier ($29.99) with 2000 conversations
- Add usage analytics dashboard for users to see their consumption
