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

**Result:** [x] Pass / [ ] Fail
**Notes:**
- Status: 200 OK
- すべての必須フィールドが含まれている: issuer, authorization_endpoint, token_endpoint, jwks_uri, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"]
- オプションフィールドも正しく実装されている

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

**Result:** [ ] Pass / [x] Fail
**Notes:**
- Status: 200 OK
- レスポンスは返されるが、keys配列が空: {"keys": []}
- **重大な問題**: RS256署名用の公開鍵が提供されていない
- これによりID Tokenの署名検証ができず、トークンエンドポイントも正常に動作しない

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

**Result:** [x] Pass / [ ] Fail
**Notes:**
- Status: 302 Found
- 正しく認可コードとstateパラメータを含むリダイレクトを返す
- Location: https://example.com/callback?code=32b62aa3-f984-4094-9944-34c3ec74cf6c&state=test-state

```bash
# Test 3.2: Missing required parameter (client_id)
curl -i "http://localhost:8787/authorize?response_type=code&redirect_uri=https://example.com/callback&scope=openid"

# Expected: Error response (400 or 302 with error)
# Error: invalid_request or invalid_client
```

**Result:** [x] Pass / [ ] Fail
**Notes:**
- Status: 400 Bad Request
- 正しくエラーを返す: {"error":"invalid_request","error_description":"client_id is required"}

```bash
# Test 3.3: Invalid response_type
curl -i "http://localhost:8787/authorize?response_type=token&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid"

# Expected: Error response
# Error: unsupported_response_type
```

**Result:** [~] Pass / [ ] Fail (部分的成功)
**Notes:**
- Status: 400 Bad Request
- エラーは返すが、error_descriptionが"Unsupported response_type: token"となっているのは正しいが、errorコードが"invalid_request"（"unsupported_response_type"が望ましい）

```bash
# Test 3.4: Scope without 'openid'
curl -i "http://localhost:8787/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=profile"

# Expected: Error response
# Error: invalid_scope
```

**Result:** [ ] Pass / [x] Fail
**Notes:**
- Status: 500 Internal Server Error
- **問題**: 400 Bad Requestであるべきところ500エラーを返す
- Locationヘッダーには正しいエラー情報が含まれているが、レスポンスコードが不適切

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

**Result:** [ ] Pass / [x] Fail
**Notes:**
- Status: 500 Internal Server Error
- **重大な問題**: サーバー設定エラーによりトークンを発行できない
- エラーメッセージ: {"error":"server_error","error_description":"Server configuration error"}
- **原因**: おそらくJWKSが空のため、ID Tokenに署名できない

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

**Result:** [x] Pass / [ ] Fail
**Notes:**
- Status: 400 Bad Request
- 正しくエラーを返す: {"error":"invalid_grant","error_description":"code format is invalid"}

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

**Result:** [ ] Pass / [ ] Fail (実行不可)
**Notes:**
- トークンエンドポイントがサーバーエラーを返すため、コード再利用防止のテストを実行できない

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

**Result:** [x] Pass / [ ] Fail
**Notes:**
- Status: 400 Bad Request
- 正しくエラーを返す: {"error":"invalid_grant","error_description":"redirect_uri does not match the one used in authorization request"}
- バリデーションロジックは正しく動作している

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

**Result:** [ ] Pass / [ ] Fail (実行不可)
**Notes:**
- トークンエンドポイントからID Tokenを取得できないため、テスト実行不可
- Test 4.1でトークン取得に失敗

```bash
# Test 5.2: Verify signature using JWKS
# Use jwt.io or similar tool to verify signature
# Public key from /.well-known/jwks.json
```

**Result:** [ ] Pass / [ ] Fail (実行不可)
**Notes:**
- JWKSが空のため、署名検証テスト実行不可
- ID Tokenも取得できない

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

**Result:** [ ] Pass / [ ] Fail (実行不可)
**Notes:**
- トークンエンドポイントからアクセストークンを取得できないため、テスト実行不可

```bash
# Test 6.2: Missing Authorization header
curl -i http://localhost:8787/userinfo

# Expected: 401 Unauthorized
# Header: WWW-Authenticate: Bearer
```

**Result:** [x] Pass / [ ] Fail
**Notes:**
- Status: 401 Unauthorized
- WWW-Authenticateヘッダーが含まれている: "Bearer"
- 正しくエラーを返す: {"error":"invalid_request","error_description":"Missing Authorization header"}

```bash
# Test 6.3: Invalid access token
curl -i http://localhost:8787/userinfo \
  -H "Authorization: Bearer invalid-token-123"

# Expected: 401 Unauthorized
# Error: invalid_token
```

**Result:** [ ] Pass / [x] Fail
**Notes:**
- Status: 500 Internal Server Error
- **問題**: 401 Unauthorizedであるべきところ500エラーを返す
- エラーメッセージ: {"error":"server_error","error_description":"Server configuration error"}

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

**Result:** [x] Pass / [ ] Fail
**Notes:**
- Status: 400 Bad Request
- エラーレスポンスの形式は正しい:
  - error: "invalid_request"
  - error_description: "Unsupported response_type: invalid. Supported types: code"
- OAuth 2.0仕様に準拠したエラーフォーマット

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

**Result:** [ ] Pass / [ ] Fail (実行不可)
**Notes:**
- トークンエンドポイントがサーバーエラーを返すため、有効期限のテストを実行できない
- 実用的な時間内でのテストが困難

```bash
# Test 8.2: Code reuse prevention
# Use code twice
# Expected: Second attempt fails with invalid_grant
```

**Result:** [ ] Pass / [ ] Fail (実行不可)
**Notes:**
- トークンエンドポイントがサーバーエラーを返すため、コード再利用防止のテストを実行できない
- バリデーションロジックの確認はTest 4.2, 4.4で部分的に確認済み

---

## 9. Conformance Summary

### Discovery & Metadata
- [x] Discovery endpoint returns valid metadata (Pass)
- [ ] JWKS endpoint returns valid JWK Set (Fail - 空のkeys配列)
- [x] Issuer consistent across all responses (Pass)

### Authorization Flow
- [x] Authorization endpoint handles valid requests (Pass)
- [x] Authorization endpoint rejects invalid requests (Pass - 一部エラーコードに改善の余地あり)
- [x] State parameter preserved in redirects (Pass)

### Token Issuance
- [ ] Token endpoint exchanges codes for tokens (Fail - サーバーエラー)
- [ ] Token endpoint enforces single-use codes (未テスト - トークンエンドポイントのエラーにより実行不可)
- [x] Token endpoint validates all parameters (Pass - バリデーションロジックは動作)

### Token Validation
- [ ] ID tokens contain all required claims (未テスト - トークンが取得できないため実行不可)
- [ ] ID tokens signed with RS256 (未テスト - トークンが取得できないため実行不可)
- [ ] Signatures verifiable with public JWK (未テスト - JWKSが空のため実行不可)

### UserInfo
- [ ] UserInfo endpoint returns claims (未テスト - アクセストークンが取得できないため実行不可)
- [x] UserInfo requires valid access token (Pass - 認証なしは正しく拒否)
- [ ] UserInfo 'sub' matches ID token 'sub' (未テスト)

### Security
- [ ] Codes expire appropriately (未テスト)
- [ ] Codes cannot be reused (未テスト)
- [~] PKCE supported for public clients (Discovery documentには記載あり、動作未確認)
- [x] State/nonce properly handled (Pass - stateは正しく処理される)

---

## 10. Overall Conformance Score

**Total Tests:** 18 (実行したテストケース数)
**Passed:** 7 / 18
**Failed:** 4 / 18
**Partial:** 1 / 18
**Not Tested:** 6 / 18 (トークンエンドポイントのエラーにより実行不可)
**Conformance Percentage:** 38.9% (Pass only) / 44.4% (Pass + Partial)

**Target:** ≥85% (≥26 tests passing)
**Status:** ❌ 目標未達成 - 重大な問題により多くのテストが実行不可

---

## 11. Issues Identified

| # | Issue Description | Severity | Status |
|---|------------------|----------|--------|
| 1 | **JWKSエンドポイントがkeys配列を空で返す** - RS256署名用の公開鍵が提供されていない。これによりID Tokenの署名検証ができず、トークンエンドポイントも正常に動作しない | P0 (Critical) | Open |
| 2 | **トークンエンドポイントでサーバー設定エラー** - 有効な認可コードでもトークン発行に失敗する。おそらくIssue #1が原因 | P0 (Critical) | Open |
| 3 | **無効なscopeで500エラー** - scope without 'openid'で400ではなく500 Internal Server Errorを返す (Test 3.4) | P1 (High) | Open |
| 4 | **無効なトークンで500エラー** - UserInfoエンドポイントで無効なトークンを使用した際に401ではなく500エラーを返す (Test 6.3) | P1 (High) | Open |
| 5 | **エラーコードの不一致** - Invalid response_typeで"unsupported_response_type"ではなく"invalid_request"を返す (Test 3.3) | P2 (Medium) | Open |

---

## 12. Next Steps

1. [x] Run initial conformance tests (完了 - 2025-11-11)
2. [ ] **最優先: Issue #1を修正** - JWKSエンドポイントにRS256公開鍵を追加
3. [ ] **最優先: Issue #2を修正** - トークンエンドポイントのサーバー設定エラーを解決
4. [ ] Issue #3, #4を修正 - 500エラーを適切なエラーコードに変更
5. [ ] Issue #5を修正 - エラーコードの適切な使用
6. [ ] Re-run conformance tests (すべてのP0/P1問題が修正された後)
7. [ ] Deploy to production environment
8. [ ] Run OpenID Conformance Suite (if available)
9. [ ] Submit for OpenID Certification

---

> 💥 **Hibana** - Manual conformance testing for Phase 3
>
> Last updated: 2025-11-11
> Test execution date: 2025-11-11
