# CSRF Token API

## Overview
This document describes the CSRF token endpoint that provides CSRF tokens for client applications to use in protected requests.

## What is CSRF Protection?
CSRF (Cross-Site Request Forgery) protection prevents unauthorized commands from being transmitted from a user that the web application trusts. This application uses the **Double Submit Cookie** pattern for CSRF protection.

---

## Get CSRF Token

### Endpoint
```
GET /api/auth/csrf-token
```

### Description
Returns a CSRF token that must be included in all state-changing requests (POST, PUT, PATCH, DELETE).

### Access
**Public** - No authentication required

### Request
No request body or parameters needed.

```bash
curl -X GET http://localhost:3000/api/auth/csrf-token
```

### Response

#### Success Response (200 OK)
```json
{
  "success": true,
  "csrfToken": "b5ea060a3a12792f57e0d82fd3e214d08301cf98360e4f3dacb80ed3c0602b54",
  "message": "CSRF token retrieved successfully. Use this token in the X-CSRF-Token header for all POST/PUT/PATCH/DELETE requests."
}
```

#### Response Headers
The server also sets the CSRF token in:
1. **Response Cookie**: `csrf_token` (httpOnly: false, secure, sameSite: strict, maxAge: 24 hours)
2. **Response Header**: `X-CSRF-Token`

#### Error Response (500)
```json
{
  "success": false,
  "message": "CSRF token not found"
}
```

---

## How to Use CSRF Token

### Step 1: Get the Token
Call the CSRF endpoint to get a token:

```javascript
// JavaScript/Fetch example
const response = await fetch('http://localhost:3000/api/auth/csrf-token', {
  method: 'GET',
  credentials: 'include', // Important: Include cookies
});

const data = await response.json();
const csrfToken = data.csrfToken;
```

```python
# Python/Requests example
import requests

response = requests.get('http://localhost:3000/api/auth/csrf-token')
data = response.json()
csrf_token = data['csrfToken']
```

### Step 2: Include Token in Protected Requests
For all **POST, PUT, PATCH, DELETE** requests, include the token in the `X-CSRF-Token` header:

```javascript
// JavaScript/Fetch example
const response = await fetch('http://localhost:3000/api/auth/request-code', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken, // ← Include the token here
  },
  credentials: 'include', // Include cookies
  body: JSON.stringify({
    email: 'user@example.com',
  }),
});
```

```python
# Python/Requests example
response = requests.post(
    'http://localhost:3000/api/auth/request-code',
    json={'email': 'user@example.com'},
    headers={'X-CSRF-Token': csrf_token},  # ← Include the token here
    cookies=response.cookies  # Include cookies from CSRF request
)
```

```bash
# cURL example
# First, get the token and save cookies
curl -X GET http://localhost:3000/api/auth/csrf-token \
  -c cookies.txt \
  -o token.json

# Extract token (using jq)
CSRF_TOKEN=$(cat token.json | jq -r '.csrfToken')

# Use token in protected request
curl -X POST http://localhost:3000/api/auth/request-code \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF_TOKEN" \
  -b cookies.txt \
  -d '{"email": "user@example.com"}'
```

---

## Token Lifecycle

### Token Expiration
- **Cookie Lifespan**: 24 hours
- **Token Validity**: As long as the cookie exists
- **Automatic Refresh**: Token is automatically regenerated if missing

### When to Get a New Token
- On first page load / app initialization
- After 24 hours (token expired)
- If you receive a `CSRF_TOKEN_MISSING` or `CSRF_TOKEN_INVALID` error

---

## Error Handling

### Common Errors

#### 1. Missing CSRF Token (403)
```json
{
  "success": false,
  "message": "CSRF token missing",
  "code": "CSRF_TOKEN_MISSING"
}
```

**Solution**: Get a new token from `/api/auth/csrf-token` and include it in the request.

#### 2. Invalid CSRF Token (403)
```json
{
  "success": false,
  "message": "Invalid CSRF token",
  "code": "CSRF_TOKEN_INVALID"
}
```

**Solution**: The token doesn't match the cookie. Get a fresh token from `/api/auth/csrf-token`.

---

## Complete Example

### React Example

```javascript
import { useState, useEffect } from 'react';

function App() {
  const [csrfToken, setCsrfToken] = useState(null);

  // Get CSRF token on mount
  useEffect(() => {
    const fetchCsrfToken = async () => {
      try {
        const response = await fetch('http://localhost:3000/api/auth/csrf-token', {
          credentials: 'include',
        });
        const data = await response.json();
        setCsrfToken(data.csrfToken);
      } catch (error) {
        console.error('Failed to fetch CSRF token:', error);
      }
    };

    fetchCsrfToken();
  }, []);

  // Use token in API calls
  const sendRequest = async (email) => {
    if (!csrfToken) {
      console.error('CSRF token not available');
      return;
    }

    try {
      const response = await fetch('http://localhost:3000/api/auth/request-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });

      const data = await response.json();
      console.log('Success:', data);
    } catch (error) {
      console.error('Request failed:', error);
    }
  };

  return (
    <div>
      <button onClick={() => sendRequest('user@example.com')}>
        Send Request
      </button>
    </div>
  );
}
```

### Python FastAPI Client Example

```python
import requests

class APIClient:
    def __init__(self, base_url):
        self.base_url = base_url
        self.session = requests.Session()
        self.csrf_token = None

    def get_csrf_token(self):
        """Get CSRF token from server"""
        response = self.session.get(f'{self.base_url}/api/auth/csrf-token')
        response.raise_for_status()
        data = response.json()
        self.csrf_token = data['csrfToken']
        return self.csrf_token

    def request_code(self, email):
        """Request verification code with CSRF protection"""
        if not self.csrf_token:
            self.get_csrf_token()

        response = self.session.post(
            f'{self.base_url}/api/auth/request-code',
            json={'email': email},
            headers={'X-CSRF-Token': self.csrf_token}
        )
        return response.json()

# Usage
client = APIClient('http://localhost:3000')
result = client.request_code('user@example.com')
print(result)
```

---

## Important Notes

1. **Cookie Support Required**: Your client must support cookies (use `credentials: 'include'` in fetch)
2. **Same Origin**: The CSRF protection works best with same-origin requests
3. **HTTPS in Production**: In production, ensure HTTPS is enabled for secure cookies
4. **Token Persistence**: Store the token in memory or state, not localStorage (security)
5. **GET Requests**: GET, HEAD, and OPTIONS requests don't need CSRF tokens

---

## Security Considerations

### Double Submit Cookie Pattern
This implementation uses the **Double Submit Cookie** pattern:
1. Server sends token in both cookie and response body
2. Client must send token back in request header
3. Server verifies both cookie and header match
4. Protects against CSRF because attackers can't read cookies cross-origin

### Best Practices
- Always use HTTPS in production
- Don't store CSRF tokens in localStorage (XSS vulnerability)
- Refresh tokens regularly (24-hour expiry)
- Include credentials (cookies) in all requests
- Handle token expiration gracefully

---

## Troubleshooting

### Token Not Working?

1. **Check cookies are enabled** in your client
2. **Verify credentials: 'include'** is set in fetch requests
3. **Ensure token is sent in correct header**: `X-CSRF-Token` (case-insensitive)
4. **Check cookie domain** matches your request domain
5. **Look for CORS issues** if making cross-origin requests

### Still Having Issues?

Check server logs for detailed error messages:
```bash
# View server logs
npm run dev
```

Look for log entries containing:
- `CSRF token missing`
- `CSRF token mismatch`

---

## Related Endpoints

All endpoints that modify state require CSRF tokens:
- `POST /api/auth/request-code`
- `POST /api/auth/verify`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `POST /api/auth/chat`
- `POST /api/auth/scraper/scrape`
- `DELETE /api/auth/scraper/delete`
- All other POST/PUT/PATCH/DELETE endpoints

GET requests do NOT require CSRF tokens:
- `GET /api/auth/me`
- `GET /api/auth/validate`
- `GET /api/auth/usage`
- All other GET requests

---

## Summary

✅ **Endpoint**: `GET /api/auth/csrf-token`
✅ **Returns**: CSRF token in response body, cookie, and header
✅ **Use**: Include token in `X-CSRF-Token` header for all POST/PUT/PATCH/DELETE requests
✅ **Expiry**: 24 hours
✅ **Security**: Double Submit Cookie pattern

For questions or issues, check the troubleshooting section or server logs.
