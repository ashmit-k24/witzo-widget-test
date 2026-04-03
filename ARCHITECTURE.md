# witzo-core — Complete System Architecture

> End-to-end data flow: **Scraping → Chunking → Embedding → Storage → Chat (RAG)**

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Phase 1 — Scraping](#2-phase-1--scraping)
3. [Phase 2 — Chunking](#3-phase-2--chunking)
4. [Phase 3 — Embedding & Pinecone Storage](#4-phase-3--embedding--pinecone-storage)
5. [Phase 4 — HyPE Enrichment](#5-phase-4--hype-enrichment-async)
6. [Phase 5 — Chat & RAG Retrieval](#6-phase-5--chat--rag-retrieval)
7. [Infrastructure Reference](#7-infrastructure-reference)
8. [Key Design Decisions](#8-key-design-decisions)

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         witzo-core Pipeline                             │
│                                                                         │
│  USER submits URL                                                       │
│       │                                                                 │
│       ▼                                                                 │
│  ┌──────────┐   BullMQ   ┌──────────────┐   Embed    ┌──────────────┐  │
│  │ Scraper  │ ─────────► │   Chunking   │ ─────────► │  Pinecone    │  │
│  │ (crawl)  │            │  (200 words) │            │  user_{id}   │  │
│  └──────────┘            └──────────────┘            └──────┬───────┘  │
│                                                             │           │
│                          BullMQ (async)                     │           │
│  ┌──────────────────────────────────────────────────────────┤           │
│  │  HyPE Worker                                             │           │
│  │  gpt-4o-mini generates hypothetical questions            │           │
│  │  → embedded → upserted into same namespace               │           │
│  └──────────────────────────────────────────────────────────┘           │
│                                                             │           │
│  USER sends chat message                                    │           │
│       │                                                     │           │
│       ▼                                                     ▼           │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Chat Service                                                    │   │
│  │  query rewrite → Pinecone search → Cohere rerank → GPT-4o → SSE │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Phase 1 — Scraping

### Entry Point

| Item | Detail |
|------|--------|
| **Route** | `POST /api/auth/scraper/scrape` |
| **Controller** | `src/controllers/scraperController.ts` → `scrapeWebsite()` |
| **Middleware** | `verifyCsrfToken` → `authenticateToken` → `checkScraperLimit` |
| **Response** | HTTP 202 `{ jobId }` — returns immediately, job runs in background |

### Request Body

```typescript
{
  url:       string;   // Required — target root URL
  maxDepth?: number;   // 0–10, default 3
  maxPages?: number;   // Optional plan-based cap
}
```

### Controller Flow

```
scraperController.scrapeWebsite()
  ├─ Validate URL format
  ├─ Check domain policy (disallowed domains list)
  ├─ pineconeService.getScraperUsageStats()   → enforce plan page limits
  ├─ scraperStatusService.startJob()          → Redis: scraper:job:{jobId}  TTL 24h
  ├─ Return HTTP 202 { jobId }
  └─ enqueueScrapeJob()                       → BullMQ "scraper-queue"
```

### BullMQ Worker

```
scraperWorker.ts  (src/workers/scraperWorker.ts)
  Concurrency: config.SCRAPER_CONCURRENCY
  Queue:       scraper-queue  (Redis-backed)
  │
  └─ processScrapeJob()
       └─ runScrapeJob()  [scrapeJobService.ts]
            └─ scraperService.scrapeWebsite(userId, url, options)
```

### Crawl Logic

```
scraperService.scrapeWebsite()   [src/services/scraperService.ts]
  │
  ├─ 1. Fetch /robots.txt  →  buildRobotsPolicy()
  │         Respects Disallow rules per path
  │
  ├─ 2. Seed URL discovery
  │         buildPrioritySeedUrls()  →  /, /blog, /about, /contact, /services …
  │         discoverSitemapUrls()    →  parse sitemap.xml if found
  │
  ├─ 3. BFS Crawl  (respects maxDepth and maxPages)
  │     For each URL in queue:
  │       fetchPageContent()
  │         ├─ Axios  timeout: 20s,  retries: 2
  │         ├─ Max redirects: 10
  │         └─ User-Agent: Mozilla/5.0 (Windows NT 10.0…)
  │
  │       isValidInternalUrl()
  │         ├─ Same hostname only
  │         └─ Skip: /api/  /admin  /cart  /checkout  images/media
  │
  │       shouldSkipCrawlPath()
  │         └─ Skip extensions: .pdf .zip .js .css and other static files
  │
  │       [Optional] firecrawlCrawlWebsite()
  │         └─ Firecrawl-based extraction if FIRECRAWL_API_KEY configured
  │
  ├─ 4. HTML → Markdown conversion
  │         Returns: ScrapedPage[] { url, title, content }
  │
  └─ 5. Progress update → "scraping_pages" (45%)
              ↓
         persistScrapedPages()   ← Phase 2 begins
```

### Progress Milestones

| Milestone Key | Label | % |
|---|---|---|
| `queued` | Job queued | 0% |
| `scraping_pages` | Scraping pages | 45% |
| `pinecone_upsert_started` | Pinecone upsert started | 55% |
| `pinecone_embeddings_prepared` | Embeddings prepared | 70% |
| `pinecone_stale_chunk_cleanup_completed` | Stale chunks removed | 80% |
| `pinecone_upsert_completed` | Upsert complete | 90% |
| `scraper_primary_pinecone_upsert_completed` | Primary complete | 95% |
| `hype_generation_started` | HyPE enrichment started | 100% |

Progress is polled via:
- `GET /api/auth/scraper/status` — latest job
- `GET /api/auth/scraper/progress` — detailed milestones
- `GET /api/auth/scraper/status/:jobId` — specific job
- `GET /api/auth/scraper/progress/:jobId` — specific job milestones

---

## 3. Phase 2 — Chunking

**File:** `src/services/chunkingService.ts`  
**Function:** `chunkMarkdown(content, pageTitle)`

### Strategy

```
Input: raw HTML/Markdown content from scraped page

Is content Markdown? (contains ## or ### headers)
│
├─ YES — Header-aware chunking
│         Split content by ## / ### headings
│         Merge sections < 50 words into adjacent sections
│         Per section:
│           ≤ 200 words  →  1 chunk  (heading prefixed)
│           > 200 words  →  200-word chunks  (40-word overlap)
│         childText  = heading + ~200 words    ← used for embedding
│         parentText = first 600 words of section  ← sent to LLM
│
└─ NO  — Plain text chunking
          800-word chunks  (120-word overlap)
          childText = parentText = chunk
```

### Output Shape

```typescript
interface ChunkResult {
  childText:  string;  // ~200 words — embedded into vector
  parentText: string;  // ≤600 words — given to LLM as retrieved context
}
```

### Chunk Size Summary

| Type | childText | parentText | Overlap |
|------|-----------|------------|---------|
| Markdown section | ~200 words | ≤600 words | 40 words |
| Plain text | ~800 words | ~800 words | 120 words |

### RagChunk Structure

```typescript
interface RagChunk {
  userId:     string;
  url:        string;
  pageTitle:  string;
  childText:  string;       // embedding input
  parentText: string;       // LLM context
  chunkIndex: number;       // position within page
  sourceType: "website";
  sourceKey:  string;       // root URL
  isHype:     boolean;      // false for primary chunks
  hypeParent: string;       // "" for primary chunks
}
```

---

## 4. Phase 3 — Embedding & Pinecone Storage

**File:** `src/services/pineconeService.ts`  
**Function:** `upsertChunks(userId, ragChunks)`

### Step A — Generate Embeddings

```
Concurrency: 8 parallel chunks

For each chunk → generateEmbedding(chunk.childText)
  │
  ├─ Normalize text  →  SHA-1 hash
  ├─ Redis HIT?  →  return cached vector                  [emb:{sha1}  TTL 5min]
  └─ Redis MISS? →  OpenAI API
                      Model:      text-embedding-3-large
                      Dimensions: 1024
                      Wrapped in: openAICircuitBreaker + retryOnRateLimit()
                    →  cache in Redis 5min
```

### Step B — Build Vector IDs

```
buildVectorId(userId, url, chunkIndex, sourceType, sourceKey)

Deterministic ID → re-scraping the same page upserts (overwrites), never duplicates
```

### Step C — Build Metadata

```typescript
{
  url:             string,
  title:           string,
  description:     string,
  scrapedAt:       ISO timestamp,
  chunkIndex:      number,
  totalChunks:     number,
  userId:          string,
  text:            string,   // childText  truncated to 4KB
  parentText:      string,   // parentText truncated to 8KB
  sourceType:      "website",
  sourceKey:       string,
  sourceRoot:      string,
  sourceRootTitle: string,
  isHype:          false,
  hypeParent:      "",
  pageType:        string,   // auto-guessed: home | blog | service | contact | case_study …
}
```

### Step D — BM25 Sparse Vectors (optional)

```
bm25SparseVector(childText)
  FNV-32a hash per word → term indices
  TF log-normalization  → term weights
  Enables hybrid dense + keyword search
```

### Step E — Stale Chunk Cleanup

```
deleteStaleChunksForUrls()
  Remove old vectors from Pinecone for the same URL set
  Prevents stale/outdated content from surfacing in chat
  Progress: 80%
```

### Step F — Upsert to Pinecone

```
Batch size: 100 vectors per request
Namespace:  user_{userId}  (per-user isolation)
Index:      cosine (dense-only)  OR  dotproduct (hybrid)
Wrapped in: pineconeCircuitBreaker + retryWithBackoff()  (3 retries)
Progress:   90%
```

### Step G — Sync Metadata to PostgreSQL

```sql
-- Table: rag_source_pages
INSERT INTO rag_source_pages
  (user_id, source_type, source_root, source_url, title, chunks, scraped_at)
VALUES (...)
ON CONFLICT (user_id, source_url)
DO UPDATE SET title = ..., chunks = ..., scraped_at = ...;

Concurrency: 12 parallel upserts
Progress:    95%
```

**Table Schema:**

```sql
CREATE TABLE rag_source_pages (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type VARCHAR(20) CHECK (source_type IN ('document', 'website')),
  source_root TEXT,
  source_url  TEXT      NOT NULL,
  title       TEXT,
  chunks      INTEGER   NOT NULL DEFAULT 0,
  scraped_at  TIMESTAMP,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, source_url)
);
```

---

## 5. Phase 4 — HyPE Enrichment (async)

> **HyPE** = Hypothetical Prompt Embeddings.  
> For each content chunk, an LLM generates hypothetical questions a visitor might ask.  
> Those questions are embedded and stored — so during chat, user queries match questions,  
> not raw document text. This dramatically improves retrieval accuracy.

**Files:**  
- `src/services/hypeService.ts`  
- `src/workers/hypeWorker.ts`  
- `src/services/hypeRepairService.ts`

### Why HyPE Works

```
Scrape time:
  Content: "We offer 24/7 support via email and phone."
  ↓
  HyPE generates:
    Q1: "Do you have 24/7 support?"
    Q2: "How can I contact support?"
    Q3: "What support channels are available?"

Chat time (user asks: "can I reach you at night?"):
  Embedding of user query ≈ embedding of "Do you have 24/7 support?"
  → HyPE chunk matched
  → parentText (original sentence) retrieved
  → LLM answers accurately
```

### HyPE Generation Flow

```
After primary upsert completes (95%):
  enqueueHypeAsync(userId, primaryChunks)  →  BullMQ "hype-queue"
  (non-blocking, scrape job marked complete at 100%)

HYPE WORKER  hypeWorker.ts
  └─ processHypeChunks()   [hypeService.ts]
       │
       ├─ For each primary chunk  (15 parallel)
       │     generateHypeQuestions(childText, websiteName)
       │       Model:  gpt-4o-mini
       │       N:      HYPE_QUESTIONS_PER_CHUNK  (e.g. 2–4 per chunk)
       │       Prompt: "Generate exactly {N} questions a website visitor might
       │                type into a chat widget to get this information…"
       │       Returns: string[]  (hypothetical questions)
       │
       ├─ For each question → create HyPE RagChunk
       │     {
       │       childText:  question,              ← embedded
       │       parentText: parent.parentText,     ← original context reused
       │       isHype:     true,
       │       hypeParent: SHA-256(userId|sourceType|sourceKey|url|chunkIndex),
       │       chunkIndex: parentIdx * 100 + questionIdx
       │     }
       │
       └─ pineconeService.upsertChunks(userId, hypeChunks)
               Same embedding + upsert pipeline
               Stored in same Pinecone namespace  user_{userId}
```

### HyPE Repair Service

Runs on a periodic background timer (`server.ts`):

```
hypeRepairService.processPendingRepairs()
  │
  ├─ For each user with website sources:
  │     pineconeService.getWebsiteHypeCoverage()
  │       Compare: primary chunk count  vs  expected HyPE child count
  │       Detect:  orphaned HyPE vectors (parent deleted)
  │
  ├─ deleteStaleHypeVectors()
  │     Remove HyPE vectors whose parent no longer exists
  │
  └─ enqueueRepairAsync()
        Acquire Redis lock per source: hype:repair-lock:{userId}:{srcHash}
        Re-generate missing HyPE chunks for affected sources
```

---

## 6. Phase 5 — Chat & RAG Retrieval

### Entry Point

| Item | Detail |
|------|--------|
| **Route** | `POST /api/auth/chat` |
| **Controller** | `src/controllers/chatController.ts` → `chat()` |
| **Middleware** | `verifyCsrfToken` → `authenticateToken` → `checkConversationLimit` → `addUsageToResponse` |
| **Streaming** | `?stream=1` or `Accept: text/event-stream` → SSE |

### Middleware Detail

```
checkConversationLimit   [src/middleware/usageLimit.ts]
  Single atomic DB UPDATE:
    UPDATE users
    SET conversations_used = conversations_used + 1
    WHERE id = $1
      AND conversations_used < conversations_limit
    RETURNING ...
  → 403 if limit exceeded  (eliminates race conditions)

addUsageToResponse
  Populates res.locals.usage:
  { conversationsRemaining, isApproachingLimit, resetDate }
```

### Chat Service Pipeline

**File:** `src/services/chatService.ts` → `chatStream()`

---

#### Step 1 — Session Management

```
getOrCreateSession(userId, sessionId)
  │
  ├─ Redis HIT  →  chat:session:{sessionId}               TTL 3600s
  └─ Redis MISS →  SELECT chat_conversations WHERE id=$1
                   SELECT chat_messages ORDER BY created_at DESC LIMIT N
                   → saveCachedSession()  warm Redis
```

---

#### Step 2 — Persist User Message

```sql
WITH inserted AS (
  INSERT INTO chat_messages (conversation_id, user_id, role, content, metadata, token_count)
  VALUES ($1, $2, 'user', $3, $4::jsonb, $5)
  RETURNING created_at
)
UPDATE chat_conversations
SET message_count    = message_count + 1,
    last_message_at  = (SELECT created_at FROM inserted),
    last_message_preview = $3,
    updated_at       = CURRENT_TIMESTAMP
WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE
```

---

#### Step 3 — Appointment Lead Detection (optional)

```
handleAppointmentLeadCapture()
  Detection: Regex patterns  OR  gpt-4o-mini classifier
  State machine (multi-turn):  name → email → phone → country
  Validates:  email regex,  phone digit count,  name patterns
  Integrates: Calendly (if configured)
  State:      Redis  chat:appointment-lead:{sessionId}  TTL 24h
```

---

#### Step 4 — RAG Retrieval

```
retrieveRelevantContext(query)
  │
  ├─ Redis HIT?  →  chat:retrieval:{userId}:{sessionId}:{queryHash}   TTL 300s
  │                  Return cached context — skip Pinecone entirely
  │
  └─ Redis MISS:

       A. Query Rewriting  [gpt-4o-mini]
          ┌────────────────────────────────────────────────────────┐
          │ stepBackRewrite(query, conversationHistory)            │
          │ Expands short/context-dependent queries                │
          │ e.g. "what about pricing?" → "What are the pricing     │
          │       plans and costs for Witzo?"                      │
          │ Falls back to original query if rewrite fails          │
          └────────────────────────────────────────────────────────┘
          generateEmbedding(rewrittenQuery)
          generateEmbedding(originalQuery)  if different

       B. Intent Classification  [queryService.ts]
          ┌────────────────────────────────────────────────────────┐
          │ buildPineconeFilter(query)                             │
          │                                                        │
          │ contact intent   → pageType: {$in: [contact,          │
          │                               about, home]}            │
          │ case study       → pageType: case_study                │
          │ services         → pageType: {$in: [service, home,     │
          │                               about, pricing]}         │
          │ general query    → null filter (search everything)     │
          └────────────────────────────────────────────────────────┘

       C. Dual Vector Search
          Pinecone query  topK: up to 50
          Namespace:      user_{userId}
          Dense search    (always)
          Sparse BM25     (if hybrid enabled)
          → Merge & deduplicate results

       D. Query Variations  (if HyPE enabled)
          Generate 3 paraphrases of user query
          Embed + search each variation
          Merge into combined result set
          ← HyPE chunks surface here (question embeddings match user query)

       E. Fallback Retry
          If zero matches AND filter was active:
          → Retry with null filter for broader coverage

       F. Cohere Reranking
          cohereRerank(originalQuery, matches, topK)
          Reorders results by true semantic relevance
          Final top-K extracted

       → Cache result in Redis  TTL 300s
```

---

#### Step 5 — Build Prompt

```
buildChatMessages()
  ├─ System message:   user's custom prompt  OR  defaultGeneratedSystemPrompt()
  ├─ Style block:      tone / language instruction based on query intent
  ├─ Context blocks:   top RAG matches
  │                    parentText per match  (≤2600 chars)
  │                    prefixed with: title, pageType, source URL
  ├─ History:          last 8 messages from cached session
  └─ User message:     with knowledge boundary instructions
```

---

#### Step 6 — LLM Call

```
openAICircuitBreaker.fire()
  retryOnRateLimit()  (up to 2 retries, exponential backoff)
    openai.chat.completions.create({
      model:          CHAT_COMPLETION_MODEL,   // gpt-4o or configured
      temperature:    CHAT_COMPLETION_TEMPERATURE,
      max_tokens:     CHAT_COMPLETION_MAX_TOKENS,
      stream:         true,
      stream_options: { include_usage: true }
    })
    → Each chunk: onToken(chunk) callback
    → Final chunk: extract prompt_tokens / completion_tokens / total_tokens
```

---

#### Step 7 — Format Response

```
formatAssistantResponse()
  ├─ Normalize markdown lists (sequential numbering)
  ├─ Normalize company voice  ("CompanyName does" → "We do")
  └─ Fix sentence endings / punctuation
```

---

#### Step 8 — Email Lead Capture (optional)

```
getEmailLeadState()  →  Redis  chat:email-lead:{sessionId}  TTL 7 days
  ├─ Extract email address if user typed one
  └─ Append email-ask suffix on:
       - No-data / fallback responses
       - After 3+ conversation turns without email captured
```

---

#### Step 9 — Persist Assistant Message

```sql
-- Same atomic CTE as user message
INSERT INTO chat_messages (conversation_id, user_id, role, content, metadata, token_count)
VALUES ($1, $2, 'assistant', $3,
  jsonb_build_object(
    'sourcesCount',            $4,
    'language',                $5,
    'isFallback',              $6,
    'tokenUsage',              $7,
    'appointmentLeadCapture',  $8
  ), $9)
```

---

#### Step 10 — Update Session Cache

```
saveCachedSession()
  Redis: chat:session:{sessionId}   TTL 3600s
  Stores last N messages (sliding window)
```

---

### Response Format

**Streaming (SSE):**

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive

data: {"type":"token","token":"Hello"}\n\n
data: {"type":"token","token":" there"}\n\n
...
data: {"type":"done","sessionId":"...","usage":{"conversationsRemaining":47,"resetDate":"..."}}\n\n

# On error:
data: {"type":"error","message":"..."}\n\n
```

**Non-Streaming (JSON):**

```json
{
  "success":   true,
  "sessionId": "uuid",
  "response":  "The full answer text...",
  "language":  "en",
  "usage": {
    "conversationsRemaining": 47,
    "resetDate": "2026-05-01T00:00:00.000Z",
    "warning": null
  }
}
```

> `compression()` middleware is disabled for `text/event-stream` responses  
> to prevent SSE chunks from being buffered.

---

## 7. Infrastructure Reference

### Redis Key Spaces

| Key Pattern | Purpose | TTL |
|---|---|---|
| `scraper:job:{jobId}` | Job status + milestones | 24 hours |
| `scraper:user:{userId}:latest` | Pointer to latest job | 24 hours |
| `emb:{sha1}` | Embedding vector cache | 5 minutes |
| `chat:session:{sessionId}` | Cached session + last N messages | 1 hour |
| `chat:retrieval:{userId}:{sId}:{qHash}` | RAG retrieval cache | 5 minutes |
| `chat:appointment-lead:{sessionId}` | Appointment collection state | 24 hours |
| `chat:email-lead:{sessionId}` | Email capture state | 7 days |
| `hype:repair-lock:{userId}:{srcHash}` | Mutex preventing concurrent repair | short TTL |

### Redis Instances

| Instance | Used For |
|---|---|
| `redisCache` | Sessions, retrieval cache, lead state |
| `redisQueue` | BullMQ job queues (`maxRetriesPerRequest: null`) |
| `redisAnalytics` | Analytics event buffer |

### BullMQ Queues

| Queue | Worker File | Purpose |
|---|---|---|
| `scraper-queue` | `src/workers/scraperWorker.ts` | Website crawl jobs |
| `hype-queue` | `src/workers/hypeWorker.ts` | HyPE question generation |

**Job retry config:** 3 attempts, exponential backoff (2s base delay)  
**Completed job retention:** 1 hour or last 100  
**Failed job retention:** 24 hours

### Background Timers (server.ts)

| Interval | Task |
|---|---|
| ~1 hour | `authService.cleanupExpired()` |
| ~30 seconds | `leadWebhookService.processPendingEvents()` |
| ~30 seconds | `hypeRepairService.processPendingRepairs()` |
| configurable | `widgetService.flushAnalytics()` |
| configurable | CRM sync (HubSpot / Zoho / Salesforce) |

### PostgreSQL Tables

| Table | Purpose |
|---|---|
| `users` | Accounts, `plan_type`, `conversations_used/limit`, custom system prompt |
| `rag_source_pages` | Scraped URL metadata, chunk counts, `scraped_at` |
| `chat_conversations` | One row per chat session, soft-delete, `message_count` |
| `chat_messages` | All messages, range-partitioned by month |

**`chat_messages` Indexes:**
- `(conversation_id, created_at DESC)` — load history
- `(user_id, created_at DESC)` — admin/analytics queries

### Pinecone Index

| Property | Value |
|---|---|
| Dimensions | 1024 |
| Embedding model | `text-embedding-3-large` |
| Metric | `cosine` (dense) or `dotproduct` (hybrid) |
| Namespace | `user_{userId}` — per-user isolation |
| Primary chunks | `isHype: false` |
| HyPE chunks | `isHype: true`, `hypeParent: {sha256-id}` |

---

## 8. Key Design Decisions

### Atomic Usage Limiting
`checkConversationLimit` uses a single `UPDATE ... WHERE conversations_used < limit RETURNING` statement.  
This eliminates race conditions from concurrent requests at zero cost (no locks, no transactions needed).

### Parent-Child Chunking
Embedding uses a small **childText** (~200 words) for high-precision retrieval.  
The LLM receives the larger **parentText** (≤600 words) for richer context.  
This avoids the "embedding a wall of text" problem without losing context.

### HyPE for Conversational Queries
User queries are conversational questions, not keyword searches.  
HyPE pre-generates questions at scrape time and embeds them — so query embeddings align with stored embeddings naturally.

### Retrieval Cache
Same query within 5 minutes skips Pinecone entirely.  
Critical for multi-turn conversations where follow-up questions often share context.

### Hybrid Search
Combines dense semantic vectors with BM25 sparse vectors.  
Dense catches meaning; sparse catches exact terminology (product names, technical terms, acronyms).

### Circuit Breakers
`openAICircuitBreaker` and `pineconeCircuitBreaker` prevent cascade failures.  
If OpenAI is degraded, graceful fallback responses are returned rather than hanging requests.

### Non-blocking HyPE
HyPE runs after the primary upsert in a separate BullMQ queue.  
The scrape job returns "complete" at 95% to the user, HyPE enriches silently in background.  
The repair service catches any HyPE that failed to generate.

---

*Generated: 2026-04-03*
