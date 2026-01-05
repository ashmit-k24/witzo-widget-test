# Witzo AI Automation Chatbot - Authentication System

Production-grade email-based authentication system built with TypeScript, Express, and PostgreSQL. Features secure cookie-based JWT authentication with automatic token rotation and refresh.

## Features

- **Email-Based Authentication**: Passwordless login using verification codes
- **JWT Tokens**: Secure access and refresh tokens with automatic rotation
- **HTTP-Only Cookies**: Tokens stored in secure, HTTP-only cookies (no localStorage vulnerabilities)
- **Automatic Token Refresh**: Transparent token refresh when access token expires
- **Rate Limiting**: Protection against brute force attacks
- **Security Best Practices**: CORS, Helmet, input validation, SQL injection prevention
- **PostgreSQL Database**: Robust data persistence with proper indexing
- **Comprehensive Logging**: Winston-based logging for monitoring and debugging
- **TypeScript**: Full type safety throughout the application
- **Production Ready**: Error handling, graceful shutdown, and cleanup jobs

## Architecture

### Token Flow

```
1. User requests verification code → Email sent with 6-digit code
2. User verifies code → Server creates session with access & refresh tokens
3. Tokens stored in HTTP-only cookies → Client automatically sends cookies
4. Access token expires (15 min) → Middleware auto-refreshes using refresh token
5. Refresh token rotates → New refresh token issued on each refresh
6. User logs out → Session revoked, cookies cleared
```

### Security Features

- **Access Token**: Short-lived (15 minutes), JWT-like token with HMAC-SHA256 signature
- **Refresh Token**: Long-lived (7 days), hashed before storage in database
- **Token Rotation**: New refresh token issued on each refresh to prevent token replay attacks
- **Session Revocation**: Ability to invalidate sessions on logout or security breach
- **Cookie Security**: HTTP-only, Secure (in production), SameSite=Strict
- **Rate Limiting**: Configurable limits on authentication endpoints
- **Input Validation**: Email format validation and sanitization

## Prerequisites

- Node.js >= 16
- PostgreSQL >= 12
- npm or yarn

## Installation

1. **Clone the repository**
```bash
git clone <repository-url>
cd witzo-ai-automation-chatbot
```

2. **Install dependencies**
```bash
npm install
```

3. **Set up environment variables**

Create a `.env` file in the root directory:

```env
# Server
PORT=3000
NODE_ENV=development

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=auth_db
DB_USER=postgres
DB_PASSWORD=your_password
DB_MAX_CONNECTIONS=20

# Email Configuration (SMTP)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM=noreply@yourapp.com

# Security
VERIFICATION_CODE_EXPIRY_MINUTES=10
MAX_VERIFICATION_ATTEMPTS=5
ACCESS_TOKEN_EXPIRY_MINUTES=15
REFRESH_TOKEN_EXPIRY_DAYS=7

# JWT Secrets (CHANGE THESE IN PRODUCTION!)
JWT_SECRET=your-super-secret-jwt-key-min-32-chars
JWT_REFRESH_SECRET=your-super-secret-refresh-key-min-32-chars
COOKIE_SECRET=your-super-secret-cookie-key-min-32-chars

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# CORS
CORS_ORIGIN=http://localhost:3000
```

4. **Set up the database**

Create a PostgreSQL database:
```bash
createdb auth_db
```

Run migrations:
```bash
npm run migrate
```

5. **Start the development server**
```bash
npm run dev
```

The server will start on `http://localhost:3000`

## API Endpoints

### Authentication Endpoints

#### 1. Request Verification Code

**POST** `/api/auth/request-code`

Request a 6-digit verification code sent to the user's email.

**Request Body:**
```json
{
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Verification code sent to your email",
  "expiresIn": 600
}
```

**Rate Limit:** 5 requests per 15 minutes per IP

---

#### 2. Verify Code & Login

**POST** `/api/auth/verify`

Verify the code and establish an authenticated session. Sets access and refresh tokens as HTTP-only cookies.

**Request Body:**
```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

**Success Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "isVerified": true
  }
}
```

**Cookies Set:**
- `access_token`: HTTP-only, expires in 15 minutes
- `refresh_token`: HTTP-only, expires in 7 days

**Rate Limit:** 10 requests per 15 minutes per IP

---

#### 3. Refresh Access Token

**POST** `/api/auth/refresh`

Manually refresh the access token using the refresh token from cookies. Note: The authentication middleware handles this automatically.

**Request:** No body required, uses refresh token from cookie

**Response:**
```json
{
  "success": true,
  "message": "Token refreshed successfully",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "isVerified": true
  }
}
```

**Cookies Updated:**
- New `access_token` (15 minutes)
- New `refresh_token` (7 days) - rotated for security

---

#### 4. Logout

**POST** `/api/auth/logout`

Revoke the current session and clear authentication cookies.

**Headers:**
```
Cookie: access_token=...; refresh_token=...
```

**Response:**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

#### 5. Get Current User

**GET** `/api/auth/me`

Get the currently authenticated user's information.

**Headers:**
```
Cookie: access_token=...; refresh_token=...
```

**Response:**
```json
{
  "success": true,
  "user": {
    "id": 1,
    "email": "user@example.com",
    "isVerified": true
  }
}
```

---

#### 6. Validate Session

**GET** `/api/auth/validate`

Check if the current session is valid.

**Headers:**
```
Cookie: access_token=...; refresh_token=...
```

**Response:**
```json
{
  "success": true,
  "message": "Session is valid",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "isVerified": true
  }
}
```

---

### Error Responses

All endpoints return standardized error responses:

```json
{
  "success": false,
  "message": "Error description",
  "code": "ERROR_CODE"
}
```

**Common Error Codes:**
- `NO_TOKEN`: No authentication token provided
- `TOKEN_EXPIRED`: Access token has expired
- `REFRESH_FAILED`: Refresh token is invalid or expired
- `RATE_LIMIT_EXCEEDED`: Too many requests
- `NO_SESSION`: No active session found

**HTTP Status Codes:**
- `200`: Success
- `401`: Unauthorized (invalid/expired token)
- `429`: Rate limit exceeded
- `500`: Server error

## Usage Examples

### Frontend Integration (JavaScript/TypeScript)

```typescript
// 1. Request verification code
async function requestCode(email: string) {
  const response = await fetch('http://localhost:3000/api/auth/request-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return response.json();
}

// 2. Verify code and login
async function login(email: string, code: string) {
  const response = await fetch('http://localhost:3000/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // Important: Include cookies
    body: JSON.stringify({ email, code }),
  });
  return response.json();
}

// 3. Make authenticated requests
async function getCurrentUser() {
  const response = await fetch('http://localhost:3000/api/auth/me', {
    credentials: 'include', // Important: Send cookies automatically
  });
  return response.json();
}

// 4. Logout
async function logout() {
  const response = await fetch('http://localhost:3000/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
  });
  return response.json();
}
```

### cURL Examples

```bash
# Request verification code
curl -X POST http://localhost:3000/api/auth/request-code \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'

# Verify code and login (save cookies)
curl -X POST http://localhost:3000/api/auth/verify \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"email":"user@example.com","code":"123456"}'

# Get current user (send cookies)
curl -X GET http://localhost:3000/api/auth/me \
  -b cookies.txt

# Logout
curl -X POST http://localhost:3000/api/auth/logout \
  -b cookies.txt
```

## Project Structure

```
src/
├── config/
│   ├── database.ts          # PostgreSQL connection pool
│   └── env.ts               # Environment configuration
├── database/
│   └── migrate.ts           # Database migrations
├── middleware/
│   ├── auth.ts              # Authentication middleware with auto-refresh
│   ├── errorHandler.ts      # Global error handling
│   └── validator.ts         # Input validation
├── routes/
│   └── auth.ts              # Authentication routes
├── services/
│   ├── authService.ts       # Core authentication logic
│   └── emailService.ts      # Email sending service
├── types/
│   └── index.ts             # TypeScript type definitions
├── utils/
│   ├── logger.ts            # Winston logger
│   └── token.ts             # JWT token utilities
└── server.ts                # Express app setup
```

## Database Schema

### Users Table
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  is_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP
);
```

### Verification Codes Table
```sql
CREATE TABLE verification_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  code VARCHAR(6) NOT NULL,
  attempts INTEGER DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  is_used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Sessions Table
```sql
CREATE TABLE sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token VARCHAR(64) NOT NULL,
  access_token_expires_at TIMESTAMP NOT NULL,
  refresh_token_expires_at TIMESTAMP NOT NULL,
  is_revoked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ip_address VARCHAR(45),
  user_agent TEXT
);
```

## Security Considerations

### Production Deployment Checklist

- [ ] Change all secrets in `.env` (JWT_SECRET, JWT_REFRESH_SECRET, COOKIE_SECRET)
- [ ] Use strong, random secrets (minimum 32 characters)
- [ ] Set `NODE_ENV=production`
- [ ] Enable HTTPS (required for secure cookies)
- [ ] Configure proper CORS_ORIGIN (don't use wildcards)
- [ ] Use environment-specific email credentials
- [ ] Set up database connection pooling limits
- [ ] Configure rate limiting based on your needs
- [ ] Set up monitoring and alerting
- [ ] Regular security audits with `npm audit`
- [ ] Keep dependencies updated
- [ ] Implement backup strategy for database
- [ ] Set up log rotation and monitoring

### Best Practices

1. **Never expose tokens in URLs or localStorage**
   - Tokens are stored in HTTP-only cookies to prevent XSS attacks

2. **Implement CSRF protection** (if using forms)
   - Consider adding CSRF tokens for state-changing operations

3. **Monitor for suspicious activity**
   - Log all authentication attempts
   - Alert on multiple failed attempts

4. **Regular cleanup**
   - Expired sessions are cleaned every hour automatically
   - Consider more frequent cleanup in high-traffic scenarios

## Scripts

```json
{
  "dev": "ts-node-dev --respawn --transpile-only src/server.ts",
  "build": "tsc",
  "start": "node dist/server.js",
  "migrate": "ts-node src/database/migrate.ts",
  "lint": "eslint . --ext .ts",
  "format": "prettier --write \"src/**/*.ts\""
}
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3000 | Server port |
| `NODE_ENV` | No | development | Environment (development/production) |
| `DB_HOST` | Yes | localhost | PostgreSQL host |
| `DB_PORT` | No | 5432 | PostgreSQL port |
| `DB_NAME` | Yes | auth_db | Database name |
| `DB_USER` | Yes | postgres | Database user |
| `DB_PASSWORD` | Yes | - | Database password |
| `EMAIL_HOST` | Yes | - | SMTP host |
| `EMAIL_PORT` | Yes | 587 | SMTP port |
| `EMAIL_USER` | Yes | - | SMTP username |
| `EMAIL_PASSWORD` | Yes | - | SMTP password |
| `EMAIL_FROM` | Yes | - | From email address |
| `VERIFICATION_CODE_EXPIRY_MINUTES` | No | 10 | Verification code TTL |
| `MAX_VERIFICATION_ATTEMPTS` | No | 5 | Max code attempts |
| `ACCESS_TOKEN_EXPIRY_MINUTES` | No | 15 | Access token TTL |
| `REFRESH_TOKEN_EXPIRY_DAYS` | No | 7 | Refresh token TTL |
| `JWT_SECRET` | Yes | - | Access token secret (32+ chars) |
| `JWT_REFRESH_SECRET` | Yes | - | Refresh token secret (32+ chars) |
| `COOKIE_SECRET` | Yes | - | Cookie signing secret (32+ chars) |
| `CORS_ORIGIN` | No | * | Allowed CORS origin |
| `RATE_LIMIT_WINDOW_MS` | No | 900000 | Rate limit window (ms) |
| `RATE_LIMIT_MAX_REQUESTS` | No | 100 | Max requests per window |

## Troubleshooting

### Common Issues

**1. Database connection errors**
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```
- Ensure PostgreSQL is running
- Check database credentials in `.env`
- Verify database exists: `psql -l`

**2. Email not sending**
```
Error: Invalid login: 535-5.7.8 Username and Password not accepted
```
- For Gmail, use App Passwords (not your regular password)
- Enable "Less secure app access" or use OAuth2
- Check EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASSWORD

**3. Cookies not being set**
- Ensure `credentials: 'include'` in fetch requests
- Check CORS configuration (credentials must be enabled)
- In production, ensure HTTPS is enabled for secure cookies

**4. Token refresh not working**
- Check that refresh_token cookie exists
- Verify JWT_REFRESH_SECRET matches
- Check database session hasn't been revoked

## License

MIT

## Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Run linting and formatting
5. Submit a pull request

## Support

For issues and questions:
- Open an issue on GitHub
- Email: support@yourapp.com
