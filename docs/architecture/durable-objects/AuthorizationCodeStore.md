# AuthorizationCodeStore Durable Object API

## Overview

The AuthorizationCodeStore Durable Object manages one-time authorization codes with strong consistency guarantees. It provides replay attack prevention and PKCE support for OAuth 2.0 flows.

**Security Features:**
- One-time use guarantee (CRITICAL for OAuth 2.0 security)
- Short TTL (60 seconds per OAuth 2.0 Security BCP)
- Atomic consume operation (Durable Object guarantees)
- PKCE validation (code_challenge/code_verifier)
- Replay attack detection and prevention
- DDoS protection (max 5 concurrent codes per user)

**OAuth 2.0 Security Best Current Practice (BCP) Compliance:**
- RFC 6749: Authorization Code Grant
- RFC 7636: Proof Key for Code Exchange (PKCE)
- OAuth 2.0 Security BCP: Draft 16

## Base URL

```
https://auth-code-store.{namespace}.workers.dev
```

## Endpoints

### 1. Store Authorization Code

Store a new authorization code for the OAuth 2.0 authorization code flow.

**Endpoint:** `POST /code`

**Request Body:**
```json
{
  "code": "auth_code_abc123xyz",
  "clientId": "client_1",
  "redirectUri": "https://app.example.com/callback",
  "userId": "user_123",
  "scope": "openid profile email",
  "codeChallenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "codeChallengeMethod": "S256",
  "nonce": "random_nonce_value",
  "state": "random_state_value"
}
```

**Request Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | Yes | Authorization code value |
| `clientId` | string | Yes | OAuth client ID |
| `redirectUri` | string | Yes | Redirect URI from authorization request |
| `userId` | string | Yes | User ID who authorized |
| `scope` | string | Yes | Requested scopes |
| `codeChallenge` | string | No | PKCE code challenge (base64url) |
| `codeChallengeMethod` | string | No | PKCE method: "S256" or "plain" |
| `nonce` | string | No | OpenID Connect nonce |
| `state` | string | No | OAuth state parameter |

**Response (201 Created):**
```json
{
  "success": true,
  "expiresAt": 1699561260000
}
```

**Response (400 Bad Request):**
```json
{
  "error": "invalid_request",
  "error_description": "Missing required fields"
}
```

**Response (500 Internal Server Error):**
```json
{
  "error": "server_error",
  "error_description": "Too many authorization codes for this user"
}
```

**Example:**
```bash
curl -X POST https://auth-code-store.example.workers.dev/code \
  -H "Content-Type: application/json" \
  -d '{
    "code": "auth_abc123",
    "clientId": "client_1",
    "redirectUri": "https://app.example.com/callback",
    "userId": "user_123",
    "scope": "openid profile",
    "codeChallenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    "codeChallengeMethod": "S256"
  }'
```

---

### 2. Consume Authorization Code

Consume an authorization code (one-time use, atomic operation).

**CRITICAL:** This operation marks the code as used. Subsequent attempts to use the same code will be rejected as replay attacks.

**Endpoint:** `POST /code/consume`

**Request Body:**
```json
{
  "code": "auth_code_abc123xyz",
  "clientId": "client_1",
  "codeVerifier": "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
}
```

**Request Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | Yes | Authorization code to consume |
| `clientId` | string | Yes | OAuth client ID (must match) |
| `codeVerifier` | string | Conditional | PKCE code verifier (required if code_challenge was used) |

**Response (200 OK):**
```json
{
  "userId": "user_123",
  "scope": "openid profile email",
  "redirectUri": "https://app.example.com/callback",
  "nonce": "random_nonce_value",
  "state": "random_state_value"
}
```

**Response (400 Bad Request - Code Not Found):**
```json
{
  "error": "invalid_grant",
  "error_description": "Authorization code not found or expired"
}
```

**Response (400 Bad Request - Replay Attack):**
```json
{
  "error": "invalid_grant",
  "error_description": "Authorization code already used (replay attack detected)"
}
```

**Response (400 Bad Request - Client Mismatch):**
```json
{
  "error": "invalid_grant",
  "error_description": "Client ID mismatch"
}
```

**Response (400 Bad Request - PKCE Failed):**
```json
{
  "error": "invalid_grant",
  "error_description": "Invalid code_verifier (PKCE validation failed)"
}
```

**Example (with PKCE):**
```bash
curl -X POST https://auth-code-store.example.workers.dev/code/consume \
  -H "Content-Type: application/json" \
  -d '{
    "code": "auth_abc123",
    "clientId": "client_1",
    "codeVerifier": "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  }'
```

**Example (without PKCE):**
```bash
curl -X POST https://auth-code-store.example.workers.dev/code/consume \
  -H "Content-Type: application/json" \
  -d '{
    "code": "auth_abc123",
    "clientId": "client_1"
  }'
```

---

### 3. Check Code Existence

Check if an authorization code exists and is valid (for testing/debugging).

**Endpoint:** `GET /code/:code/exists`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | Yes | Authorization code to check |

**Response (200 OK):**
```json
{
  "exists": true
}
```

**Example:**
```bash
curl https://auth-code-store.example.workers.dev/code/auth_abc123/exists
```

---

### 4. Delete Code

Manually delete an authorization code (cleanup).

**Endpoint:** `DELETE /code/:code`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | Yes | Authorization code to delete |

**Response (200 OK):**
```json
{
  "success": true,
  "deleted": "auth_abc123"
}
```

**Example:**
```bash
curl -X DELETE https://auth-code-store.example.workers.dev/code/auth_abc123
```

---

### 5. Health Check / Status

Get health status, statistics, and configuration.

**Endpoint:** `GET /status`

**Response (200 OK):**
```json
{
  "status": "ok",
  "codes": {
    "total": 15,
    "active": 12,
    "expired": 3
  },
  "config": {
    "ttl": 60,
    "maxCodesPerUser": 5
  },
  "timestamp": 1699561200000
}
```

**Example:**
```bash
curl https://auth-code-store.example.workers.dev/status
```

---

## Error Responses

All endpoints return standard OAuth 2.0 error responses where applicable:

### 400 Bad Request
```json
{
  "error": "invalid_request",
  "error_description": "Missing required fields"
}
```

```json
{
  "error": "invalid_grant",
  "error_description": "Authorization code expired"
}
```

### 500 Internal Server Error
```json
{
  "error": "server_error",
  "error_description": "Too many authorization codes for this user"
}
```

---

## Data Types

### AuthorizationCode Object
```typescript
interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  userId: string;
  scope: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain';
  nonce?: string;
  state?: string;
  used: boolean;
  expiresAt: number;
  createdAt: number;
}
```

---

## Security Features

### 1. One-Time Use Guarantee

**CRITICAL:** Authorization codes can only be consumed once. The Durable Object's strong consistency guarantees prevent race conditions.

```
Time    Thread A              Thread B
---     --------              --------
T1      consume(code_abc)
T2        → check if used=false ✓
T3        → mark used=true
T4        → return success
T5                             consume(code_abc)
T6                               → check if used=true ✗
T7                               → REJECT (replay attack)
```

### 2. PKCE Validation (RFC 7636)

**S256 Method:**
```
Client generates:
  verifier = random_string(43-128 chars)
  challenge = base64url(sha256(verifier))

Authorization request includes:
  code_challenge = challenge
  code_challenge_method = S256

Token request includes:
  code_verifier = verifier

Server validates:
  base64url(sha256(code_verifier)) === code_challenge
```

**Example PKCE values:**
```
verifier:  dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
challenge: E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
```

### 3. Short TTL (60 seconds)

Authorization codes expire after 60 seconds per OAuth 2.0 Security BCP recommendations.

### 4. DDoS Protection

Maximum 5 concurrent authorization codes per user to prevent abuse.

### 5. Replay Attack Detection

When a code is used twice, the system:
1. Logs a security warning
2. Returns `invalid_grant` error
3. Marks the attempt as a replay attack

---

## Implementation Notes

### Cleanup Process

- Automatic cleanup runs every 30 seconds
- Expired codes removed from memory
- Used codes kept until expiration for replay detection

### Concurrency

- Durable Objects guarantee atomic operations
- No race conditions on code consumption
- Strong consistency across all operations

---

## Usage Examples

### Complete OAuth 2.0 Authorization Code Flow

```bash
# 1. Authorization endpoint generates code and stores it
curl -X POST https://auth-code-store.example.workers.dev/code \
  -H "Content-Type: application/json" \
  -d '{
    "code": "auth_abc123",
    "clientId": "client_1",
    "redirectUri": "https://app.example.com/callback",
    "userId": "user_123",
    "scope": "openid profile email"
  }'

# 2. Client exchanges code for tokens
curl -X POST https://auth-code-store.example.workers.dev/code/consume \
  -H "Content-Type: application/json" \
  -d '{
    "code": "auth_abc123",
    "clientId": "client_1"
  }'

# Response includes user info for token creation:
# {
#   "userId": "user_123",
#   "scope": "openid profile email",
#   "redirectUri": "https://app.example.com/callback"
# }
```

### PKCE Flow (Public Clients)

```bash
# Client generates PKCE values
VERIFIER="dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
CHALLENGE="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

# 1. Store code with challenge
curl -X POST https://auth-code-store.example.workers.dev/code \
  -H "Content-Type: application/json" \
  -d '{
    "code": "auth_pkce_123",
    "clientId": "mobile_app",
    "redirectUri": "myapp://callback",
    "userId": "user_123",
    "scope": "openid profile",
    "codeChallenge": "'"$CHALLENGE"'",
    "codeChallengeMethod": "S256"
  }'

# 2. Consume code with verifier
curl -X POST https://auth-code-store.example.workers.dev/code/consume \
  -H "Content-Type: application/json" \
  -d '{
    "code": "auth_pkce_123",
    "clientId": "mobile_app",
    "codeVerifier": "'"$VERIFIER"'"
  }'
```

### Replay Attack Simulation

```bash
# 1. Store code
curl -X POST https://auth-code-store.example.workers.dev/code \
  -H "Content-Type: application/json" \
  -d '{
    "code": "auth_replay_test",
    "clientId": "client_1",
    "redirectUri": "https://app.example.com/callback",
    "userId": "user_123",
    "scope": "openid"
  }'

# 2. First consumption (succeeds)
curl -X POST https://auth-code-store.example.workers.dev/code/consume \
  -H "Content-Type: application/json" \
  -d '{
    "code": "auth_replay_test",
    "clientId": "client_1"
  }'
# Returns 200 OK

# 3. Second consumption (replay attack - fails)
curl -X POST https://auth-code-store.example.workers.dev/code/consume \
  -H "Content-Type: application/json" \
  -d '{
    "code": "auth_replay_test",
    "clientId": "client_1"
  }'
# Returns 400 Bad Request:
# {
#   "error": "invalid_grant",
#   "error_description": "Authorization code already used (replay attack detected)"
# }
```

---

## Best Practices

1. **Always use PKCE** for public clients (mobile apps, SPAs)
2. **Validate redirect_uri** matches the stored value
3. **Use short-lived codes** (default 60 seconds is recommended)
4. **Monitor for replay attacks** via error logs
5. **Revoke tokens** if replay attack detected (handle in token endpoint)
6. **Use nonce** for OpenID Connect flows to prevent token substitution
