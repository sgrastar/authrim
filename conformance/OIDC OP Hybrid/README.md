# authrim – OpenID Connect Hybrid OP Conformance

## Vision & Objectives

**OIDC Hybrid OP Profile** is a certification profile that verifies authorization flows compliant with the OpenID Connect Hybrid Flow specification. Hybrid Flow is an advanced authorization flow that combines the advantages of Authorization Code Flow and Implicit Flow.

### Objectives
- 🔧 Support Hybrid Flow (`code id_token`, `code token`, `code id_token token`)
- ⚡ Obtain ID Token immediately on frontend while securely obtaining Access Token on backend
- 🔒 Balance secure authentication and token acquisition
- ✅ Compatibility with enterprise applications

### Use Cases
- **Enterprise SPA**: Display user information immediately on frontend while accessing API on backend
- **Mobile Apps**: Obtain ID Token during initial authentication, securely obtain Access Token on backend
- **Gradual Permission Acquisition**: Obtain basic information during initial login, acquire additional permissions later

---

## Required Features & Behavior

### 1. Hybrid Flow Response Types (OIDC Core 3.3)

| Response Type | Description | Token Endpoint | Specification Reference |
|:--|:--|:--|:--|
| **code id_token** | Authorization code + ID Token | Obtain Access Token | OIDC Core 3.3.2.1 |
| **code token** | Authorization code + Access Token | Obtain ID Token | OIDC Core 3.3.2.2 |
| **code id_token token** | Authorization code + ID Token + Access Token | Obtain Refresh Token | OIDC Core 3.3.2.3 |

### 2. Response Mode Support

| Response Mode | Description | Specification Reference |
|:--|:--|:--|
| **fragment** | Response in URL fragment (default) | OIDC Core 3.3.2.5 |
| **form_post** | Response via HTML Form POST | Form Post Response Mode |
| **query** | Response in query parameters (code only case) | OAuth 2.0 Multiple Response Types |

### 3. Authorization Response Parameters

**Common Parameters:**
- `code` - Authorization code (required for all Hybrid Flows)
- `state` - State for CSRF protection (required)
- `iss` - Issuer Identifier (OIDC Core 3.1.2.5)

**response_type=code id_token:**
- `id_token` - ID Token (immediately verifiable on frontend)

**response_type=code token:**
- `access_token` - Access Token (for API calls)
- `token_type` - Token type (usually "Bearer")
- `expires_in` - Access Token expiration

**response_type=code id_token token:**
- `id_token` - ID Token
- `access_token` - Access Token
- `token_type` - Token type
- `expires_in` - Access Token expiration

### 4. ID Token Validation (OIDC Core 3.3.2.10)

ID Tokens in Hybrid Flow require the following additional validation:

| Requirement | Description | Specification Reference |
|:--|:--|:--|
| **c_hash claim** | Hash value of authorization code (`code id_token`, `code id_token token`) | OIDC Core 3.3.2.11 |
| **at_hash claim** | Hash value of Access Token (`code id_token token`) | OIDC Core 3.3.2.11 |
| **nonce validation** | Validation of nonce value (Replay attack prevention) | OIDC Core 3.3.2.10 |

**c_hash calculation:**
```
c_hash = base64url(left_half(hash(code, alg)))
```

**at_hash calculation:**
```
at_hash = base64url(left_half(hash(access_token, alg)))
```

### 5. Token Endpoint Behavior

| Response Type | Authorization Endpoint | Token Endpoint |
|:--|:--|:--|
| `code id_token` | code + id_token | access_token + (refresh_token) |
| `code token` | code + access_token | id_token + (refresh_token) |
| `code id_token token` | code + id_token + access_token | refresh_token |

### 6. Security Considerations

| Requirement | Description | Specification Reference |
|:--|:--|:--|
| **PKCE Support** | PKCE recommended for Hybrid Flow | RFC 7636 |
| **nonce Required** | nonce required for replay attack prevention | OIDC Core 3.3.2.10 |
| **c_hash/at_hash** | Validation of token binding | OIDC Core 3.3.2.11 |
| **HTTPS Enforcement** | redirect_uri must use HTTPS | OAuth 2.0 Security BCP |
| **State Validation** | CSRF attack prevention | RFC 6749 Section 10.12 |

---

## Authrim Implementation Status

### ❌ Hybrid Flow (Planned for Phase 6)

| Feature | Status | Phase | Notes |
|:--|:--|:--|:--|
| **Response Type Support** | ❌ | Phase 6 | - |
| `code id_token` | ❌ | Phase 6 | Code + ID Token in authorization response |
| `code token` | ❌ | Phase 6 | Code + Access Token in authorization response |
| `code id_token token` | ❌ | Phase 6 | Code + ID Token + Access Token |
| **ID Token Claims** | ❌ | Phase 6 | - |
| `c_hash` claim | ❌ | Phase 6 | Code hash in ID Token |
| `at_hash` claim | ❌ | Phase 6 | Access Token hash in ID Token |
| **Token Endpoint** | ❌ | Phase 6 | - |
| Hybrid flow token exchange | ❌ | Phase 6 | Different tokens based on response_type |
| **Security** | ❌ | Phase 6 | - |
| nonce validation | ⚙️ | Phase 3 | Basic support exists, needs Hybrid-specific validation |
| PKCE with Hybrid | ⚙️ | Phase 3 | PKCE exists, needs Hybrid integration |

### ✅ Related Features (Already Implemented)

| Feature | Status | Phase | Notes |
|:--|:--|:--|:--|
| Authorization Code Flow | ✅ | Phase 3 | Base for Hybrid Flow |
| Implicit Flow | ✅ | Phase 4 | Base for Hybrid Flow |
| Form Post Response Mode | ✅ | Phase 4 | Can be used with Hybrid |
| PKCE | ✅ | Phase 3 | Can be integrated with Hybrid |
| nonce support | ✅ | Phase 3 | Basic implementation exists |

### Implementation Plan (Phase 6)

**Required Changes:**

1. **Authorization Endpoint** (`packages/op-auth/src/index.ts`)
   - [ ] Add `code id_token` response type handler
   - [ ] Add `code token` response type handler
   - [ ] Add `code id_token token` response type handler
   - [ ] Generate ID Token at authorization endpoint (when needed)
   - [ ] Generate Access Token at authorization endpoint (when needed)
   - [ ] Calculate `c_hash` and `at_hash` claims
   - [ ] Return multiple tokens in fragment/form_post

2. **Token Endpoint** (`packages/op-token/src/index.ts`)
   - [ ] Detect Hybrid Flow from stored authorization request
   - [ ] Return appropriate tokens based on response_type:
     - `code id_token` → access_token + refresh_token
     - `code token` → id_token + refresh_token
     - `code id_token token` → refresh_token only
   - [ ] Validate that ID Token from authorization matches (if applicable)

3. **ID Token Generation** (`packages/shared/src/utils/token.ts`)
   - [ ] Add `c_hash` claim generator
   - [ ] Add `at_hash` claim generator
   - [ ] Hybrid-specific ID Token validation

4. **Testing**
   - [ ] Unit tests for each response type
   - [ ] Integration tests for Hybrid Flow
   - [ ] c_hash/at_hash validation tests
   - [ ] PKCE + Hybrid integration tests

**Estimated Test Coverage:** ~40-50 tests

---

## Related Specifications

| Specification | Title | Status |
|:--|:--|:--|
| **OIDC Core 3.3** | OpenID Connect Hybrid Flow | ❌ Planned (Phase 6) |
| **OAuth 2.0 Multiple Response Types** | OAuth 2.0 Multiple Response Type Encoding Practices | ❌ Planned (Phase 6) |
| **OIDC Core 3.3.2.11** | ID Token Validation (c_hash, at_hash) | ❌ Planned (Phase 6) |
| **RFC 7636** | Proof Key for Code Exchange (PKCE) | ✅ Implemented (Phase 3) |

**Primary References:**
- [OIDC Core 3.3 - Hybrid Flow](https://openid.net/specs/openid-connect-core-1_0.html#HybridFlowAuth)
- [OAuth 2.0 Multiple Response Types](https://openid.net/specs/oauth-v2-multiple-response-types-1_0.html)

---

## Testing Plan

### OpenID Conformance Suite

**Test Profile:**
- **Name:** OpenID Connect Hybrid OP
- **Purpose:** Verify Hybrid Flow functionality

**Test URL:**
https://www.certification.openid.net/

**Configuration:**
```bash
# Test Configuration (when implemented)
Issuer: https://authrim.YOUR_SUBDOMAIN.workers.dev
Authorization Endpoint: https://authrim.YOUR_SUBDOMAIN.workers.dev/authorize
Token Endpoint: https://authrim.YOUR_SUBDOMAIN.workers.dev/token

# Enable Hybrid Flow
response_types_supported: code id_token, code token, code id_token token
```

### Test Procedure (Future)

1. **Deploy Authrim** (Phase 6+)
   ```bash
   pnpm run deploy
   ```

2. **Verify Hybrid Flow - code id_token**
   ```bash
   # 1. Navigate to authorization endpoint
   https://authrim.YOUR_SUBDOMAIN.workers.dev/authorize?
     client_id=CLIENT_ID&
     redirect_uri=https://example.com/callback&
     response_type=code id_token&
     scope=openid&
     nonce=NONCE_VALUE&
     state=STATE_VALUE

   # 2. Verify fragment response contains code + id_token
   # 3. Validate c_hash in ID Token
   # 4. Exchange code at token endpoint for access_token
   ```

3. **Verify Hybrid Flow - code token**
   ```bash
   # Similar to above but with response_type=code token
   # Verify at_hash would be in ID Token from token endpoint
   ```

4. **Verify Hybrid Flow - code id_token token**
   ```bash
   # Similar to above but with response_type=code id_token token
   # Verify both c_hash and at_hash in ID Token
   ```

5. **Run Conformance Tests**
   - Access OpenID Conformance Suite
   - Create test plan: **OpenID Connect Provider → Hybrid OP**
   - Configure Issuer URL
   - Execute all tests

### Expected Test Coverage (Future)

| Test Category | Description | Expected |
|:--|:--|:--|
| Hybrid - code id_token | Code + ID Token response | ⏳ Pending |
| Hybrid - code token | Code + Access Token response | ⏳ Pending |
| Hybrid - code id_token token | All tokens in response | ⏳ Pending |
| c_hash Validation | Code hash in ID Token | ⏳ Pending |
| at_hash Validation | Access Token hash in ID Token | ⏳ Pending |
| nonce Validation | Replay attack prevention | ⏳ Pending |
| Token Endpoint Behavior | Correct token issuance | ⏳ Pending |
| Form Post + Hybrid | Hybrid with form_post mode | ⏳ Pending |
| PKCE + Hybrid | Hybrid with PKCE | ⏳ Pending |

**Note:** Implementation and testing scheduled for Phase 6.

---

## Certification Roadmap

### Current Status
- ❌ **Not Implemented**: Hybrid Flow planned for Phase 6
- ✅ **Prerequisites Complete**: Authorization Code Flow, Implicit Flow, Form Post

### Phase 6 Implementation Plan (Q1 2025)

#### Milestone 1: Core Hybrid Flow
- [ ] Implement `code id_token` response type
- [ ] Implement `code token` response type
- [ ] Implement `code id_token token` response type
- [ ] Add c_hash and at_hash claim generation
- [ ] Update token endpoint for Hybrid Flow

#### Milestone 2: Testing & Validation
- [ ] Write 40-50 unit tests for Hybrid Flow
- [ ] Integration testing with all response types
- [ ] Test with Form Post Response Mode
- [ ] Test with PKCE

#### Milestone 3: Conformance Testing
- [ ] Run OpenID Hybrid OP conformance tests
- [ ] Document test results
- [ ] Address any failures
- [ ] Submit for certification

**Estimated Completion:** Q2 2025

---

## Related Documents

- [OIDC Basic OP](../OIDC%20Basic%20OP/README.md) - Basic OP profile conformance
- [OIDC Form Post OP](../OIDC%20Form%20Post%20OP/README.md) - Form Post Response Mode (compatible with Hybrid)
- [Test Plan](../OIDC%20Basic%20OP/test-plan.md) - Overall conformance testing strategy
- [Project README](../../README.md) - Authrim project overview
- [ROADMAP](../../ROADMAP.md) - Authrim development roadmap

---

> **Status:** ❌ Not Implemented – Planned for Phase 6 (Q1 2025)
> **Last Updated:** 2025-11-18
