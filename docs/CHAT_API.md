# Chat API with RAG (Retrieval Augmented Generation)

## Overview

The Chat API allows users to interact with an AI assistant that answers questions based **ONLY** on their scraped website data stored in Pinecone. The AI will not answer questions outside of the scraped content.

## Features

- ✅ **RAG-based responses**: Only uses data from user's scraped websites
- ✅ **Session management**: Maintains conversation history per session
- ✅ **Source attribution**: Returns which sources were used for answers
- ✅ **Public API**: No authentication required (userId acts as unique key)
- ✅ **User isolation**: Each userId has separate data and chat sessions

---

## API Endpoints

### 1. **POST /api/auth/chat** - Send Message

Chat with AI using your scraped data.

**Request:**
```json
{
  "userId": "user-unique-id",
  "sessionId": "optional-session-id",
  "message": "What are your product features?"
}
```

**Response:**
```json
{
  "success": true,
  "sessionId": "123e4567-e89b-12d3-a456-426614174000",
  "response": "Based on the scraped content, our product features include...",
  "sources": [
    {
      "url": "https://example.com/features",
      "title": "Product Features",
      "relevanceScore": 0.89
    }
  ]
}
```

**CURL Example:**
```bash
curl -X POST http://localhost:3000/api/auth/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user123",
    "message": "What are your main features?"
  }'
```

---

### 2. **GET /api/auth/chat/session/:sessionId** - Get Session History

Retrieve conversation history for a session.

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "123e4567-e89b-12d3-a456-426614174000",
    "userId": "user123",
    "messageCount": 6,
    "createdAt": "2026-01-06T10:00:00.000Z",
    "updatedAt": "2026-01-06T10:05:00.000Z",
    "messages": [
      {
        "role": "user",
        "content": "What are your features?",
        "timestamp": "2026-01-06T10:00:00.000Z"
      },
      {
        "role": "assistant",
        "content": "Our features include...",
        "timestamp": "2026-01-06T10:00:02.000Z"
      }
    ]
  }
}
```

**CURL Example:**
```bash
curl -X GET http://localhost:3000/api/auth/chat/session/123e4567-e89b-12d3-a456-426614174000
```

---

### 3. **DELETE /api/auth/chat/session/:sessionId** - Clear Session

Delete a specific chat session.

**Response:**
```json
{
  "success": true,
  "message": "Session cleared successfully"
}
```

**CURL Example:**
```bash
curl -X DELETE http://localhost:3000/api/auth/chat/session/123e4567-e89b-12d3-a456-426614174000
```

---

### 4. **POST /api/auth/chat/clear-user-sessions** - Clear All User Sessions

Clear all sessions for a specific user.

**Request:**
```json
{
  "userId": "user123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Cleared 3 session(s)",
  "clearedCount": 3
}
```

**CURL Example:**
```bash
curl -X POST http://localhost:3000/api/auth/chat/clear-user-sessions \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user123"
  }'
```

---

## How It Works

### RAG (Retrieval Augmented Generation) Flow

1. **User sends message** with their `userId`
2. **System retrieves relevant context** from Pinecone (top 5 most relevant chunks)
3. **AI generates response** using ONLY the retrieved context
4. **Sources are returned** showing which URLs were used

```
User Question
      ↓
Query Pinecone (user's namespace)
      ↓
Retrieve Top 5 Relevant Chunks
      ↓
Send to OpenAI with Context
      ↓
AI Responds (only using context)
      ↓
Return Response + Sources
```

### Session Management

- **First message**: System creates a new session with unique `sessionId`
- **Subsequent messages**: Include the `sessionId` to continue conversation
- **Session memory**: Keeps last 10 messages for context
- **Isolation**: Each `userId` has separate sessions and data

---

## Usage Examples

### Example 1: Start New Conversation

```bash
# First message (no sessionId)
curl -X POST http://localhost:3000/api/auth/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user123",
    "message": "What is your pricing?"
  }'

# Response includes sessionId
{
  "success": true,
  "sessionId": "abc-123-def-456",
  "response": "Based on our pricing page, we offer three tiers...",
  "sources": [...]
}
```

### Example 2: Continue Conversation

```bash
# Use the sessionId from previous response
curl -X POST http://localhost:3000/api/auth/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user123",
    "sessionId": "abc-123-def-456",
    "message": "What about the enterprise plan?"
  }'
```

### Example 3: Question Outside Scraped Data

```bash
curl -X POST http://localhost:3000/api/auth/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user123",
    "message": "What is the weather today?"
  }'

# Response:
{
  "success": true,
  "sessionId": "abc-123-def-456",
  "response": "I don't have data related to your question in the scraped content.",
  "sources": []
}
```

---

## AI Behavior Rules

The AI assistant follows strict rules:

1. ✅ **Only answers from scraped data** - Will not use external knowledge
2. ✅ **Cites sources** - Shows which URL the answer came from
3. ✅ **Honest about limitations** - Says "I don't have data" when content is missing
4. ✅ **Concise and accurate** - Direct answers, no fluff
5. ✅ **Context-aware** - Remembers conversation history (last 10 messages)

---

## Integration with Scraper

### Workflow

1. **Scrape websites** using `/api/auth/scraper/scrape`
2. **Data is stored** in Pinecone with user's namespace
3. **Chat API queries** the same namespace to answer questions
4. **AI responds** using only that user's scraped content

### Example Full Workflow

```bash
# Step 1: Scrape a website (requires authentication)
curl -X POST http://localhost:3000/api/auth/scraper/scrape \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "maxDepth": 2,
    "maxPages": 20
  }'

# Step 2: Chat with the scraped data (public, no auth)
curl -X POST http://localhost:3000/api/auth/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "03393750-36fd-419f-a553-b1b1995d359d",
    "message": "What products do you offer?"
  }'
```

---

## Error Responses

### Invalid Request
```json
{
  "success": false,
  "message": "userId is required"
}
```

### Empty Message
```json
{
  "success": false,
  "message": "message is required and cannot be empty"
}
```

### Session Not Found
```json
{
  "success": false,
  "message": "Session not found"
}
```

### Server Error
```json
{
  "success": false,
  "message": "Internal server error while processing chat",
  "error": "Error details here"
}
```

---

## Technical Details

### OpenAI Model
- **Model**: `gpt-4o-mini`
- **Temperature**: 0.3 (low randomness for accuracy)
- **Max Tokens**: 500 (concise responses)

### Context Retrieval
- **Top K**: 5 most relevant chunks
- **Source**: User's Pinecone namespace
- **Method**: Vector similarity search

### Session Storage
- **Storage**: In-memory (Map)
- **Persistence**: Resets on server restart
- **Optimization**: Keeps last 10 messages per session

---

## Best Practices

1. **Use consistent userId** - Same userId across scraping and chatting
2. **Maintain sessionId** - Keep the sessionId for conversation continuity
3. **Clear old sessions** - Use clear endpoints to manage memory
4. **Handle no-data responses** - UI should handle "I don't have data" gracefully
5. **Show sources** - Display source URLs to users for transparency

---

## Notes

- **Public API**: No authentication required (userId is the key)
- **User Isolation**: Each userId can only access their own scraped data
- **Real-time**: No caching, always queries fresh from Pinecone
- **Stateful**: Sessions maintained in server memory (not persisted to DB)
