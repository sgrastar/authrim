# Hybrid Flow - OIDC Core 3.3

## Overview

Authrim fully supports the Hybrid Flow defined in Section 3.3 of the OpenID Connect Core 1.0 specification. Hybrid Flow combines the benefits of Authorization Code Flow and Implicit Flow, supporting the following three response_types:

1. **`code id_token`** - Returns Authorization Code and ID Token
2. **`code token`** - Returns Authorization Code and Access Token
3. **`code id_token token`** - Returns Authorization Code, ID Token, and Access Token

## Specification Compliance

- **OIDC Core 3.3**: Hybrid Flow
- **OIDC Core 3.3.2.11**: ID Token validation (c_hash, at_hash)
- **OAuth 2.0 Multiple Response Type Encoding Practices**: Fragment encoding

## Usage

### Basic Hybrid Flow Request

```http
GET /authorize?
  response_type=code%20id_token&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://example.com/callback&
  scope=openid%20profile%20email&
  state=xyz&
  nonce=abc123
```

### Response

In Hybrid Flow, responses are returned to the redirect URI using fragment encoding by default:

```
https://example.com/callback#
  code=SplxlOBeZQQYbYS6WxSbIA&
  id_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...&
  state=xyz
```

## Response Type Details

### 1. `code id_token`

Returns both Authorization Code and ID Token.

**Request Example:**
```http
GET /authorize?
  response_type=code%20id_token&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://example.com/callback&
  scope=openid%20profile&
  state=xyz&
  nonce=abc123
```

**Response Example:**
```
https://example.com/callback#
  code=SplxlOBeZQQYbYS6WxSbIA&
  id_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...&
  state=xyz
```

**ID Token Claims:**
```json
{
  "iss": "https://your-issuer.com",
  "sub": "user123",
  "aud": "YOUR_CLIENT_ID",
  "exp": 1516239022,
  "iat": 1516235422,
  "auth_time": 1516235400,
  "nonce": "abc123",
  "c_hash": "LDktKdoQak3Pk0cnXxCltA"
}
```

`c_hash` is the hash value of the Authorization Code, used to verify that the ID Token and code are from the same issuer.

**Use Cases:**
- When you want to display user information immediately on the frontend
- When you need to obtain access tokens and refresh tokens on the backend

### 2. `code token`

Returns both Authorization Code and Access Token.

**Request Example:**
```http
GET /authorize?
  response_type=code%20token&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://example.com/callback&
  scope=openid%20profile&
  state=xyz&
  nonce=abc123
```

**Response Example:**
```
https://example.com/callback#
  code=SplxlOBeZQQYbYS6WxSbIA&
  access_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...&
  token_type=Bearer&
  expires_in=3600&
  state=xyz
```

**Use Cases:**
- When you want to access APIs immediately from the frontend
- When long-term access (refresh token) is needed on the backend

### 3. `code id_token token`

Returns all: Authorization Code, ID Token, and Access Token.

**Request Example:**
```http
GET /authorize?
  response_type=code%20id_token%20token&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://example.com/callback&
  scope=openid%20profile&
  state=xyz&
  nonce=abc123
```

**Response Example:**
```
https://example.com/callback#
  code=SplxlOBeZQQYbYS6WxSbIA&
  id_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...&
  access_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...&
  token_type=Bearer&
  expires_in=3600&
  state=xyz
```

**ID Token Claims:**
```json
{
  "iss": "https://your-issuer.com",
  "sub": "user123",
  "aud": "YOUR_CLIENT_ID",
  "exp": 1516239022,
  "iat": 1516235422,
  "auth_time": 1516235400,
  "nonce": "abc123",
  "c_hash": "LDktKdoQak3Pk0cnXxCltA",
  "at_hash": "77QmUPtjPfzWtF2AnpK9RQ"
}
```

`at_hash` is the hash value of the Access Token, used to verify that the ID Token and Access Token are from the same issuer.

**Use Cases:**
- When you want to display user information and access APIs from the frontend
- When long-term access is needed on the backend
- The most comprehensive Hybrid Flow

## Response Mode

Hybrid Flow supports the following response_modes:

### Fragment (Default)

By default, Hybrid Flow includes response parameters in the URL fragment using fragment encoding.

```
https://example.com/callback#
  code=...&
  id_token=...&
  state=xyz
```

### Form Post

Specifying `response_mode=form_post` sends response parameters to the client via POST request.

**Request Example:**
```http
GET /authorize?
  response_type=code%20id_token&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://example.com/callback&
  scope=openid&
  state=xyz&
  nonce=abc123&
  response_mode=form_post
```

**Response:**
An HTML form containing the following parameters is automatically POSTed to the client's redirect_uri:

```html
<form method="post" action="https://example.com/callback">
  <input type="hidden" name="code" value="..." />
  <input type="hidden" name="id_token" value="..." />
  <input type="hidden" name="state" value="xyz" />
</form>
```

### Query (Not Recommended)

`response_mode=query` is not recommended for Hybrid Flow. For security reasons, tokens should not be included in URL query parameters.

## Nonce Validation

**Important**: The `nonce` parameter is **required** for Hybrid Flow and Implicit Flow.

```http
GET /authorize?
  response_type=code%20id_token&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://example.com/callback&
  scope=openid&
  state=xyz&
  nonce=abc123  ← Required
```

The nonce is used to prevent replay attacks. Clients must generate a random value and include it in the request. Verify that the nonce claim in the ID Token matches the nonce in the request.

### Generating Nonce

```javascript
// Generate random nonce
const nonce = crypto.randomUUID() + '-' + Date.now();

// Include in authorization request
const authUrl = `https://your-issuer.com/authorize?` +
  `response_type=code+id_token&` +
  `client_id=${clientId}&` +
  `redirect_uri=${redirectUri}&` +
  `scope=openid&` +
  `state=${state}&` +
  `nonce=${nonce}`;

// Save nonce in session
sessionStorage.setItem('oauth_nonce', nonce);
```

### Validating Nonce

```javascript
// Validate nonce in callback
const idToken = parseJwt(params.id_token);
const savedNonce = sessionStorage.getItem('oauth_nonce');

if (idToken.nonce !== savedNonce) {
  throw new Error('Nonce mismatch');
}

// Remove nonce after validation
sessionStorage.removeItem('oauth_nonce');
```

## Hash Claim Validation

### c_hash (Code Hash)

`c_hash` is the hash value of the Authorization Code included in the ID Token. It is included in the following cases:
- `response_type=code id_token`
- `response_type=code id_token token`

**Validation Method:**

```javascript
import { createHash } from 'crypto';

function verifyCHash(code, cHash) {
  // Hash code with SHA-256
  const hash = createHash('sha256').update(code).digest();

  // Get left half
  const leftHalf = hash.slice(0, hash.length / 2);

  // Base64url encode
  const computed = base64UrlEncode(leftHalf);

  return computed === cHash;
}
```

### at_hash (Access Token Hash)

`at_hash` is the hash value of the Access Token included in the ID Token. It is included in the following cases:
- `response_type=id_token token` (Implicit Flow)
- `response_type=code id_token token` (Hybrid Flow)

**Validation Method:**

```javascript
function verifyAtHash(accessToken, atHash) {
  // Hash token with SHA-256
  const hash = createHash('sha256').update(accessToken).digest();

  // Get left half
  const leftHalf = hash.slice(0, hash.length / 2);

  // Base64url encode
  const computed = base64UrlEncode(leftHalf);

  return computed === atHash;
}
```

## Token Exchange

The Authorization Code obtained in Hybrid Flow can be exchanged at the Token Endpoint to obtain access tokens and refresh tokens.

**Request Example:**

```http
POST /token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic BASE64(client_id:client_secret)

grant_type=authorization_code&
code=SplxlOBeZQQYbYS6WxSbIA&
redirect_uri=https://example.com/callback
```

**Response Example:**

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "tGzv3JOkF0XG5Qx2TlKWIA",
  "id_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

These tokens may differ from the tokens obtained at the Authorization Endpoint, but are issued for the same user.

## Security Considerations

### 1. Nonce Usage

Nonce is required for Hybrid Flow and Implicit Flow. This prevents replay attacks.

### 2. State Parameter

Always use the `state` parameter to prevent CSRF attacks.

### 3. Hash Claim Validation

Validate `c_hash` and `at_hash` to verify that the ID Token and other tokens are from the same issuer.

### 4. HTTPS Required

Always use HTTPS in production environments. Since tokens are included in URL fragments, protection by TLS is important.

### 5. Token Storage

- **ID Token**: Can be stored in local storage or session storage
- **Access Token**: Store in memory or session storage (for as short a time as possible)
- **Refresh Token**: Store in secure HTTP-only cookies or server-side

### 6. Token Expiration

- Access Tokens issued at the Authorization Endpoint are short-lived (1 hour)
- For long-term access, obtain refresh tokens at the Token Endpoint

## Client Implementation Example

### JavaScript/TypeScript

```typescript
// Authorization request
function initiateHybridFlow() {
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();

  // Save state and nonce
  sessionStorage.setItem('oauth_state', state);
  sessionStorage.setItem('oauth_nonce', nonce);

  const params = new URLSearchParams({
    response_type: 'code id_token token',
    client_id: 'YOUR_CLIENT_ID',
    redirect_uri: 'https://example.com/callback',
    scope: 'openid profile email',
    state,
    nonce,
  });

  window.location.href = `https://your-issuer.com/authorize?${params}`;
}

// Callback handler
function handleCallback() {
  // Parse fragment
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);

  const code = params.get('code');
  const idToken = params.get('id_token');
  const accessToken = params.get('access_token');
  const state = params.get('state');

  // Validate state
  const savedState = sessionStorage.getItem('oauth_state');
  if (state !== savedState) {
    throw new Error('State mismatch');
  }

  // Validate nonce
  const idTokenPayload = parseJwt(idToken);
  const savedNonce = sessionStorage.getItem('oauth_nonce');
  if (idTokenPayload.nonce !== savedNonce) {
    throw new Error('Nonce mismatch');
  }

  // Validate c_hash
  if (!verifyCHash(code, idTokenPayload.c_hash)) {
    throw new Error('c_hash validation failed');
  }

  // Validate at_hash
  if (accessToken && !verifyAtHash(accessToken, idTokenPayload.at_hash)) {
    throw new Error('at_hash validation failed');
  }

  // Clean up
  sessionStorage.removeItem('oauth_state');
  sessionStorage.removeItem('oauth_nonce');

  // Exchange code for tokens
  exchangeCode(code);
}

// Token exchange
async function exchangeCode(code) {
  const response = await fetch('https://your-issuer.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa('CLIENT_ID:CLIENT_SECRET')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://example.com/callback',
    }),
  });

  const tokens = await response.json();
  // Store tokens securely
  return tokens;
}

// Helper functions
function parseJwt(token) {
  const base64Url = token.split('.')[1];
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const jsonPayload = decodeURIComponent(
    atob(base64)
      .split('')
      .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
      .join('')
  );
  return JSON.parse(jsonPayload);
}
```

## Troubleshooting

### Error: "nonce is required for implicit and hybrid flows"

**Cause**: The `nonce` parameter is not included in the Hybrid Flow or Implicit Flow request.

**Solution**: Add the `nonce` parameter to the request.

```http
GET /authorize?
  response_type=code%20id_token&
  ...
  nonce=YOUR_RANDOM_NONCE
```

### Error: "Unsupported response_type"

**Cause**: An unsupported `response_type` is specified.

**Solution**: Use one of the following:
- `code`
- `id_token`
- `id_token token`
- `code id_token`
- `code token`
- `code id_token token`

Note: `response_type` values are space-separated. When URL-encoded, they become `+` or `%20`.

### c_hash/at_hash Validation Failure

**Cause**: Hash claim calculation is incorrect.

**Check:**
1. Are you using the SHA-256 algorithm?
2. Are you getting the left half (16 bytes) of the hash?
3. Are you using Base64url encoding (without padding)?

## References

- [OpenID Connect Core 1.0 - Section 3.3: Hybrid Flow](https://openid.net/specs/openid-connect-core-1_0.html#HybridFlowAuth)
- [OAuth 2.0 Multiple Response Type Encoding Practices](https://openid.net/specs/oauth-v2-multiple-response-types-1_0.html)
- [OpenID Connect Core 1.0 - Section 3.3.2.11: ID Token Validation](https://openid.net/specs/openid-connect-core-1_0.html#HybridIDToken)

## Summary

Authrim's Hybrid Flow implementation fully complies with the OIDC Core 1.0 specification and provides the following features:

✅ 3 Hybrid Flow response_types (`code id_token`, `code token`, `code id_token token`)
✅ Fragment encoding (default)
✅ Form Post response mode
✅ Nonce validation (required)
✅ c_hash and at_hash generation and validation
✅ Secure token issuance
✅ Comprehensive test coverage

By using Hybrid Flow, you can achieve both immediate display of user information on the frontend and secure token exchange on the backend.
