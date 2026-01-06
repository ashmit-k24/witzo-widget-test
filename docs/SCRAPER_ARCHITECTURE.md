# Web Scraper Architecture

## Multi-Tenant Data Isolation Strategy

### Current Implementation: Pinecone Namespaces ✅

#### How It Works
- **Single Pinecone Index**: `website-scraper` (or your configured index name)
- **User Namespaces**: Each user gets `user_{userId}` namespace
- **Complete Isolation**: Users can only access their own namespace

#### Example
```
User A (id: 03393750-36fd-419f-a553-b1b1995d359d)
└── Namespace: user_03393750-36fd-419f-a553-b1b1995d359d
    ├── https://example.com_chunk_0
    ├── https://example.com_chunk_1
    └── https://about.com_chunk_0

User B (id: 12345678-1234-1234-1234-123456789abc)
└── Namespace: user_12345678-1234-1234-1234-123456789abc
    ├── https://mysite.com_chunk_0
    └── https://mysite.com_chunk_1
```

### Why This Approach?

#### ✅ Advantages
1. **Cost-Effective**: Single index = single cost
2. **Fast Queries**: Namespaces are optimized for isolation
3. **Scalable**: Supports up to 100,000 users per index
4. **Secure**: True data isolation at infrastructure level
5. **Easy Management**: One index to monitor
6. **Industry Standard**: Recommended by Pinecone

#### ⚠️ Limitations
- Maximum 100,000 namespaces per index (rarely an issue)
- All users share index quota/limits

### Optional Enhancement: Database Tracking

If you need analytics or additional metadata, add a PostgreSQL table:

```sql
CREATE TABLE scraped_websites (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    url VARCHAR(2048) NOT NULL,
    title TEXT,
    pages_scraped INTEGER DEFAULT 0,
    total_chunks INTEGER DEFAULT 0,
    scraped_at TIMESTAMP DEFAULT NOW(),
    last_updated TIMESTAMP DEFAULT NOW(),
    status VARCHAR(50) DEFAULT 'completed',
    UNIQUE(user_id, url)
);

CREATE INDEX idx_scraped_websites_user_id ON scraped_websites(user_id);
```

This allows you to:
- Track what each user has scraped
- Show scraping history in UI
- Display analytics (total pages, chunks, etc.)
- Implement rate limiting per user
- Easy cleanup/deletion tracking

### Alternative Approaches (NOT Recommended)

#### ❌ Metadata Filtering
Storing all users in one namespace and filtering by userId:
- Security risk (query errors could leak data)
- Slower performance (must scan then filter)
- No true isolation

#### ❌ Separate Indexes
Creating one index per user:
- Very expensive (each index costs money)
- Management nightmare (1000s of indexes)
- Not scalable (Pinecone limits total indexes)

### Best Practices

1. **Always use namespaces for user isolation**
2. **Sanitize vector IDs** (remove special characters)
3. **Use consistent namespace naming**: `user_{userId}`
4. **Include userId in metadata** for extra safety
5. **Log all operations** with userId for audit trail

### Query Performance

Namespace queries are very fast:
```typescript
// This only searches within user's namespace
const results = await index
  .namespace('user_03393750-36fd-419f-a553-b1b1995d359d')
  .query({
    vector: embedding,
    topK: 10
  });
```

No need to filter through other users' data!

### Security

The namespace approach provides:
- **Infrastructure-level isolation** (not just application logic)
- **No cross-namespace queries** (impossible to access other users)
- **Audit trail** (all operations logged with userId)
- **Easy deletion** (delete entire namespace at once)

## Conclusion

**Keep your current namespace-based implementation.** It's the right approach and follows industry best practices. Only add database tracking if you need analytics or UI features beyond vector search.
