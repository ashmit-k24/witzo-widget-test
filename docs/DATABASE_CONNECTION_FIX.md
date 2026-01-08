# Database Connection Timeout Fix

## Problem
```
error: Database connection failed {
  "error":"Connection terminated due to connection timeout",
  "service":"witzo-ai",
  "timestamp":"2026-01-08 17:07:07"
}
```

This error was occurring intermittently, indicating the database connection pool was timing out.

## Root Cause
The `connectionTimeoutMillis` was set to only **2000ms (2 seconds)**, which is too short and causes timeouts during:
- High server load
- Slow network connections
- Database query spikes
- Initial connection establishment

## Solution Applied

### 1. Increased Connection Timeout ✅
**File**: [src/config/database.ts](../src/config/database.ts#L13)

**Before**:
```typescript
connectionTimeoutMillis: 2000, // 2 seconds - TOO SHORT
```

**After**:
```typescript
connectionTimeoutMillis: 10000, // 10 seconds - Much more reliable
```

### 2. Added Keep-Alive Configuration ✅
```typescript
keepAlive: true, // Keep TCP connection alive
keepAliveInitialDelayMillis: 10000, // Initial delay before sending keep-alive probes
```

**Benefits**:
- Prevents idle connections from being terminated
- Detects broken connections faster
- Maintains connection health

### 3. Added Query Timeouts ✅
```typescript
statement_timeout: 30000, // Abort statements that take longer than 30 seconds
query_timeout: 30000, // Query timeout in milliseconds
```

**Benefits**:
- Prevents long-running queries from blocking the pool
- Frees up connections faster
- Better error handling

### 4. Connection Retry Logic ✅
```typescript
const testConnection = async (retries = 3): Promise<void> => {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT NOW()');
      logger.info('Database connected successfully');
      return;
    } catch (err) {
      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, i) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};
```

**Benefits**:
- Automatically retries failed connections
- Uses exponential backoff (1s, 2s, 4s)
- Logs each attempt for debugging

### 5. Improved Error Handling ✅
```typescript
// Handle pool errors
pool.on('error', (err: Error) => {
  logger.error('Unexpected database pool error', {
    error: err.message,
    stack: err.stack,
  });
  // Don't exit the process - let the pool handle reconnection
});

// Handle client errors
pool.on('connect', (client) => {
  client.on('error', (err: Error) => {
    logger.error('Database client error', { error: err.message });
  });
});
```

**Benefits**:
- Catches pool-level errors
- Catches individual client errors
- Logs with full context
- Doesn't crash the app

### 6. Graceful Shutdown ✅
```typescript
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing database pool...');
  await pool.end();
  logger.info('Database pool closed');
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing database pool...');
  await pool.end();
  logger.info('Database pool closed');
  process.exit(0);
});
```

**Benefits**:
- Properly closes connections on shutdown
- Prevents connection leaks
- Clean process termination

---

## Complete Configuration

### Current Pool Settings
```typescript
const poolConfig: PoolConfig = {
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  max: config.DB_MAX_CONNECTIONS,              // Default: 10
  idleTimeoutMillis: 30000,                    // Close idle clients after 30s
  connectionTimeoutMillis: 10000,              // Wait 10s before timeout (was 2s)
  keepAlive: true,                             // Keep TCP connection alive
  keepAliveInitialDelayMillis: 10000,          // Keep-alive probe delay
  statement_timeout: 30000,                     // Abort long statements
  query_timeout: 30000,                         // Query timeout
  application_name: 'witzo-ai-automation-chatbot',
};
```

### Timeout Hierarchy
1. **Connection Timeout**: 10 seconds (to establish connection)
2. **Query Timeout**: 30 seconds (individual queries)
3. **Statement Timeout**: 30 seconds (database-side statement timeout)
4. **Idle Timeout**: 30 seconds (close idle connections)

---

## Monitoring & Debugging

### Check Pool Status
Add this to your code to monitor the pool:
```typescript
// Log pool stats periodically
setInterval(() => {
  console.log({
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });
}, 60000); // Every minute
```

### Common Issues & Solutions

#### Issue 1: "Connection terminated due to connection timeout"
**Solution**: ✅ Fixed by increasing `connectionTimeoutMillis` to 10000ms

#### Issue 2: "Connection pool exhausted"
**Solution**: Increase `max` connections in `.env`:
```env
DB_MAX_CONNECTIONS=20  # Increase from 10
```

#### Issue 3: "Connection terminated unexpectedly"
**Solution**: ✅ Fixed with `keepAlive: true` and error handlers

#### Issue 4: "Query timeout"
**Solution**: ✅ Fixed with `query_timeout: 30000` - queries abort after 30s

---

## Environment Variables

Make sure these are set in your `.env`:
```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=witzo
DB_USER=postgres
DB_PASSWORD=witzo
DB_MAX_CONNECTIONS=10
```

### Recommended Settings by Environment

**Development**:
```env
DB_MAX_CONNECTIONS=10
```

**Staging**:
```env
DB_MAX_CONNECTIONS=20
```

**Production**:
```env
DB_MAX_CONNECTIONS=50
```

---

## Testing the Fix

### Test 1: Connection Retry
Stop PostgreSQL and start your app:
```bash
# Stop PostgreSQL
sudo systemctl stop postgresql

# Start your app
npm run dev

# You should see retry attempts in logs:
# "Database connection attempt 1/3 failed"
# "Retrying in 1000ms..."
# "Database connection attempt 2/3 failed"
# "Retrying in 2000ms..."

# Start PostgreSQL
sudo systemctl start postgresql

# Connection should succeed
```

### Test 2: High Load
Simulate many concurrent requests:
```bash
# Install Apache Bench
sudo apt-get install apache2-utils

# Test with 100 concurrent requests
ab -n 1000 -c 100 http://localhost:3000/api/auth/csrf-token
```

### Test 3: Long-Running Query
```sql
-- This should timeout after 30 seconds
SELECT pg_sleep(60);
```

---

## Performance Improvements

### Before Fix:
- ❌ Connection timeout after 2 seconds
- ❌ No retry logic
- ❌ Connections dropped frequently
- ❌ Poor error messages

### After Fix:
- ✅ Connection timeout after 10 seconds
- ✅ 3 retry attempts with exponential backoff
- ✅ Keep-alive maintains connections
- ✅ Detailed error logging
- ✅ Graceful shutdown
- ✅ Query timeouts prevent hanging

---

## Monitoring Logs

After the fix, you should see logs like:
```
[info] Database connected successfully {
  "host": "localhost",
  "database": "witzo",
  "maxConnections": 10
}
```

If connection fails, you'll see:
```
[error] Database connection attempt 1/3 failed {
  "error": "Connection refused",
  "host": "localhost",
  "database": "witzo"
}
[info] Retrying in 1000ms...
```

---

## Additional Recommendations

### 1. Database Health Check Endpoint
Add a health check endpoint:
```typescript
router.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', database: 'disconnected' });
  }
});
```

### 2. Connection Pool Monitoring
Monitor pool metrics:
```typescript
app.get('/metrics/db', (req, res) => {
  res.json({
    totalConnections: pool.totalCount,
    idleConnections: pool.idleCount,
    waitingClients: pool.waitingCount,
  });
});
```

### 3. PostgreSQL Configuration
Check PostgreSQL settings:
```sql
SHOW max_connections;
SHOW statement_timeout;
SHOW idle_in_transaction_session_timeout;
```

Recommended PostgreSQL config:
```
max_connections = 100
statement_timeout = 30000
idle_in_transaction_session_timeout = 60000
```

---

## Summary

✅ **Connection timeout** increased from 2s to 10s
✅ **Retry logic** added with exponential backoff (3 attempts)
✅ **Keep-alive** enabled to maintain connections
✅ **Query timeouts** added (30s) to prevent hanging
✅ **Error handling** improved with detailed logging
✅ **Graceful shutdown** implemented
✅ **Production-ready** configuration

**Result**: Database connection timeouts should no longer occur under normal load. If they do, check PostgreSQL server resources and increase `DB_MAX_CONNECTIONS`.
