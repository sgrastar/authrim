# Hibana Manual Conformance Checklist 💥

**Purpose:** Manual verification checklist for OpenID Connect Basic OP Profile conformance
**Target:** Phase 3 - Testing & Validation
**Date:** 2025-11-11

---

## 1. Discovery Endpoint (`/.well-known/openid-configuration`)

### Required Metadata Fields

- [ ] `issuer` - Must match the issuer value in issued tokens
- [ ] `authorization_endpoint` - Full URL to `/authorize`
- [ ] `token_endpoint` - Full URL to `/token`
- [ ] `jwks_uri` - Full URL to `/.well-known/jwks.json`
- [ ] `response_types_supported` - Must include `["code"]`
- [ ] `subject_types_supported` - Must include `["public"]`
- [ ] `id_token_signing_alg_values_supported` - Must include `["RS256"]`

### Optional but Recommended Fields

- [ ] `userinfo_endpoint` - Full URL to `/userinfo`
- [ ] `scopes_supported` - List of supported scopes
- [ ] `claims_supported` - List of supported claims
- [ ] `grant_types_supported` - Should include `["authorization_code"]`
- [ ] `token_endpoint_auth_methods_supported` - Authentication methods

### Validation Tests

```bash
# Test 1: Fetch discovery document
curl http://localhost:8787/.well-known/openid-configuration | jq

# Expected: Valid JSON with all required fields
# Status: 200 OK
# Content-Type: application/json
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

---

## 2. JWKS Endpoint (`/.well-known/jwks.json`)

### Required JWK Fields

- [ ] `kty` - Must be "RSA"
- [ ] `use` - Must be "sig" (signature)
- [ ] `alg` - Must be "RS256"
- [ ] `kid` - Key ID matching tokens
- [ ] `n` - RSA modulus (base64url encoded)
- [ ] `e` - RSA exponent (base64url encoded)

### Validation Tests

```bash
# Test 2: Fetch JWKS
curl http://localhost:8787/.well-known/jwks.json | jq

# Expected: Valid JWK Set with RS256 key
# Status: 200 OK
# Content-Type: application/json
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

---

## 3. Authorization Endpoint (`/authorize`)

### Required Parameters

- [ ] `response_type` - Must be "code"
- [ ] `client_id` - Client identifier
- [ ] `redirect_uri` - Callback URL
- [ ] `scope` - Must include "openid"

### Optional Parameters

- [ ] `state` - CSRF protection (recommended)
- [ ] `nonce` - Replay protection (recommended)
- [ ] `code_challenge` - PKCE (required for public clients)
- [ ] `code_challenge_method` - Must be "S256"

### Validation Tests

```bash
# Test 3.1: Valid authorization request
curl -i "http://localhost:8787/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid%20profile&state=test-state&nonce=test-nonce"

# Expected: 302 redirect with code and state
# Location: https://example.com/callback?code=...&state=test-state
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

```bash
# Test 3.2: Missing required parameter (client_id)
curl -i "http://localhost:8787/authorize?response_type=code&redirect_uri=https://example.com/callback&scope=openid"

# Expected: Error response (400 or 302 with error)
# Error: invalid_request or invalid_client
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

```bash
# Test 3.3: Invalid response_type
curl -i "http://localhost:8787/authorize?response_type=token&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid"

# Expected: Error response
# Error: unsupported_response_type
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

```bash
# Test 3.4: Scope without 'openid'
curl -i "http://localhost:8787/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=profile"

# Expected: Error response
# Error: invalid_scope
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

---

## 4. Token Endpoint (`/token`)

### Required Parameters

- [ ] `grant_type` - Must be "authorization_code"
- [ ] `code` - Authorization code from `/authorize`
- [ ] `redirect_uri` - Must match authorization request
- [ ] `client_id` - Client identifier

### Optional Parameters

- [ ] `client_secret` - For confidential clients
- [ ] `code_verifier` - PKCE verifier

### Response Fields

- [ ] `access_token` - Access token (JWT or opaque)
- [ ] `token_type` - Must be "Bearer"
- [ ] `expires_in` - Token lifetime in seconds
- [ ] `id_token` - ID Token (JWT)
- [ ] `scope` - Granted scopes

### Validation Tests

```bash
# Test 4.1: Valid token exchange
# (First, get a code from /authorize)
CODE="..." # From previous test
curl -X POST http://localhost:8787/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=$CODE" \
  -d "client_id=test-client" \
  -d "redirect_uri=https://example.com/callback"

# Expected: 200 OK with tokens
# Response includes: access_token, token_type, expires_in, id_token
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

```bash
# Test 4.2: Invalid authorization code
curl -X POST http://localhost:8787/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=invalid-code-123" \
  -d "client_id=test-client" \
  -d "redirect_uri=https://example.com/callback"

# Expected: 400 Bad Request
# Error: invalid_grant
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

```bash
# Test 4.3: Reused authorization code
# (Use the same code from Test 4.1)
curl -X POST http://localhost:8787/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=$CODE" \
  -d "client_id=test-client" \
  -d "redirect_uri=https://example.com/callback"

# Expected: 400 Bad Request
# Error: invalid_grant (code already used)
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

```bash
# Test 4.4: Mismatched redirect_uri
curl -X POST http://localhost:8787/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=$CODE" \
  -d "client_id=test-client" \
  -d "redirect_uri=https://wrong.com/callback"

# Expected: 400 Bad Request
# Error: invalid_grant
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

---

## 5. ID Token Validation

### Required Claims

- [ ] `iss` - Issuer (must match discovery issuer)
- [ ] `sub` - Subject (user identifier)
- [ ] `aud` - Audience (must be client_id)
- [ ] `exp` - Expiration time (Unix timestamp)
- [ ] `iat` - Issued at time (Unix timestamp)

### Optional Claims

- [ ] `nonce` - Must match authorization request nonce
- [ ] `at_hash` - Access token hash (for code flow)
- [ ] `auth_time` - Authentication time

### Profile Claims (if scope includes "profile")

- [ ] `name` - Full name
- [ ] `preferred_username` - Username

### Email Claims (if scope includes "email")

- [ ] `email` - Email address
- [ ] `email_verified` - Email verification status

### Validation Tests

```bash
# Test 5.1: Decode and verify ID token
ID_TOKEN="..." # From Test 4.1

# Decode header
echo $ID_TOKEN | cut -d. -f1 | base64 -d | jq

# Expected: {"alg":"RS256","kid":"test-key","typ":"JWT"}

# Decode payload
echo $ID_TOKEN | cut -d. -f2 | base64 -d | jq

# Expected: Valid JSON with required claims
# Verify: iss, sub, aud, exp, iat present
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

```bash
# Test 5.2: Verify signature using JWKS
# Use jwt.io or similar tool to verify signature
# Public key from /.well-known/jwks.json
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

---

## 6. UserInfo Endpoint (`/userinfo`)

### Required Headers

- [ ] `Authorization: Bearer <access_token>`

### Response Claims

- [ ] `sub` - Subject (must match ID token sub)
- [ ] Additional claims based on scope

### Validation Tests

```bash
# Test 6.1: Valid UserInfo request
ACCESS_TOKEN="..." # From Test 4.1
curl http://localhost:8787/userinfo \
  -H "Authorization: Bearer $ACCESS_TOKEN"

# Expected: 200 OK
# Response: JSON with user claims including 'sub'
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

```bash
# Test 6.2: Missing Authorization header
curl -i http://localhost:8787/userinfo

# Expected: 401 Unauthorized
# Header: WWW-Authenticate: Bearer
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

```bash
# Test 6.3: Invalid access token
curl -i http://localhost:8787/userinfo \
  -H "Authorization: Bearer invalid-token-123"

# Expected: 401 Unauthorized
# Error: invalid_token
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

---

## 7. Error Handling

### OAuth 2.0 Errors

- [ ] `invalid_request` - Malformed request
- [ ] `invalid_client` - Invalid client_id
- [ ] `invalid_grant` - Invalid authorization code
- [ ] `unsupported_grant_type` - Unsupported grant type
- [ ] `invalid_scope` - Invalid or unsupported scope

### OIDC Errors

- [ ] `login_required` - User must authenticate
- [ ] `interaction_required` - User interaction needed
- [ ] `invalid_request_uri` - Invalid request URI
- [ ] `invalid_request_object` - Invalid request object

### Validation Tests

```bash
# Test 7.1: Verify error response format
curl -i http://localhost:8787/authorize?response_type=invalid

# Expected: Error response with:
# - error: error code
# - error_description: human-readable description
# - state: if provided in request
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

---

## 8. Security Requirements

### HTTPS Enforcement

- [ ] All endpoints require HTTPS in production
- [ ] HTTP allowed only for localhost development

### Token Security

- [ ] Authorization codes expire (default: 120 seconds)
- [ ] Authorization codes are single-use
- [ ] Tokens have reasonable expiration (default: 3600 seconds)

### PKCE Support

- [ ] Supports code_challenge parameter
- [ ] Supports S256 method
- [ ] Validates code_verifier

### State Parameter

- [ ] State parameter returned in redirect
- [ ] State parameter matches original request

### Nonce Parameter

- [ ] Nonce included in ID token if provided
- [ ] Nonce matches original request

### Validation Tests

```bash
# Test 8.1: Authorization code expiration
# Get code, wait 121 seconds, try to use it
# Expected: invalid_grant error
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

```bash
# Test 8.2: Code reuse prevention
# Use code twice
# Expected: Second attempt fails with invalid_grant
```

**Result:** [ ] Pass / [ ] Fail
**Notes:**

---

## 9. Conformance Summary

### Discovery & Metadata
- [ ] Discovery endpoint returns valid metadata
- [ ] JWKS endpoint returns valid JWK Set
- [ ] Issuer consistent across all responses

### Authorization Flow
- [ ] Authorization endpoint handles valid requests
- [ ] Authorization endpoint rejects invalid requests
- [ ] State parameter preserved in redirects

### Token Issuance
- [ ] Token endpoint exchanges codes for tokens
- [ ] Token endpoint enforces single-use codes
- [ ] Token endpoint validates all parameters

### Token Validation
- [ ] ID tokens contain all required claims
- [ ] ID tokens signed with RS256
- [ ] Signatures verifiable with public JWK

### UserInfo
- [ ] UserInfo endpoint returns claims
- [ ] UserInfo requires valid access token
- [ ] UserInfo 'sub' matches ID token 'sub'

### Security
- [ ] Codes expire appropriately
- [ ] Codes cannot be reused
- [ ] PKCE supported for public clients
- [ ] State/nonce properly handled

---

## 10. Overall Conformance Score

**Total Tests:** 30
**Passed:** ___ / 30
**Failed:** ___ / 30
**Conformance Percentage:** ____%

**Target:** ≥85% (≥26 tests passing)

---

## 11. Issues Identified

| # | Issue Description | Severity | Status |
|---|------------------|----------|--------|
| 1 | | | |
| 2 | | | |
| 3 | | | |

---

## 12. Next Steps

1. [ ] Fix all critical issues (P0)
2. [ ] Fix high-priority issues (P1)
3. [ ] Re-run conformance tests
4. [ ] Deploy to production environment
5. [ ] Run OpenID Conformance Suite (if available)
6. [ ] Submit for OpenID Certification

---

> 💥 **Hibana** - Manual conformance testing for Phase 3
>
> Last updated: 2025-11-11
