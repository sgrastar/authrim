# authrim – FAPI 2.0 Security Profile Conformance

## Vision & Objectives

**FAPI 2.0 Security Profile** is a certification profile that verifies OpenID Connect implementations meeting advanced security requirements for the financial industry. Financial-grade API (FAPI) provides the highest level of security required by banks, payment services, and financial institutions.

### Objectives
- 🔒 Meet financial-grade security requirements
- ✅ Support PAR (Pushed Authorization Request)
- ✅ Support DPoP (Demonstrating Proof-of-Possession)
- 🔐 Support MTLS (Mutual TLS) (planned)
- 🔐 Support JARM (JWT Secured Authorization Response Mode) (planned)
- 🔐 Implement advanced authentication and authorization flows

---

## Required Features & Behavior

### 1. PAR - Pushed Authorization Request (RFC 9126)

| Requirement | Description | Specification Reference |
|:--|:--|:--|
| **PAR Endpoint** | Pre-register authorization request with `POST /as/par` | RFC 9126 Section 2 |
| **request_uri Issuance** | Generate temporary `request_uri` | RFC 9126 Section 2.2 |
| **Request Validation** | Pre-validate authorization parameters | RFC 9126 Section 2.1 |
| **Short Lifetime** | `request_uri` is short-lived (60s recommended) | RFC 9126 Section 2.2 |
| **One-time Use** | `request_uri` can only be used once | RFC 9126 Section 2.3 |
| **Client Authentication** | Client authentication at PAR endpoint | RFC 9126 Section 2.1 |

### 2. DPoP - Demonstrating Proof-of-Possession (RFC 9449)

| Requirement | Description | Specification Reference |
|:--|:--|:--|
| **DPoP Header** | Validate `DPoP` HTTP header | RFC 9449 Section 4 |
| **DPoP Proof JWT** | Verify DPoP Proof JWT signature | RFC 9449 Section 4.2 |
| **Token Binding** | Bind access token to DPoP key | RFC 9449 Section 5 |
| **Replay Prevention** | Prevent replay attacks using `jti` and `iat` | RFC 9449 Section 4.3 |
| **HTTP Method Binding** | Verify HTTP method with `htm` claim | RFC 9449 Section 4.2 |
| **URI Binding** | Verify URI with `htu` claim | RFC 9449 Section 4.2 |
| **DPoP Token Type** | Use `DPoP` as token type | RFC 9449 Section 5 |

### 3. MTLS - Mutual TLS (RFC 8705) - Planned

| Requirement | Description | Specification Reference |
|:--|:--|:--|
| **Client Certificate** | Client certificate authentication | RFC 8705 Section 2 |
| **Certificate Validation** | Validate certificate chain | RFC 8705 Section 3 |
| **Token Binding** | Bind token to certificate | RFC 8705 Section 3 |
| **Sender Constraint** | Sender-constrained access tokens | RFC 8705 Section 3.1 |

### 4. JARM - JWT Secured Authorization Response Mode (JARM) - Planned

| Requirement | Description | Specification Reference |
|:--|:--|:--|
| **JWT Response** | Sign authorization response with JWT | JARM Section 2 |
| **Response Mode** | `response_mode=jwt`, `query.jwt`, `fragment.jwt`, `form_post.jwt` | JARM Section 2.1 |
| **Response Signing** | Sign response with OP private key | JARM Section 2.3 |
| **Response Encryption** | Encrypt response with client public key (optional) | JARM Section 2.4 |

### 5. FAPI 2.0 Core Requirements

| Requirement | Description | Specification Reference |
|:--|:--|:--|
| **Authorization Code Flow** | PKCE required | FAPI 2.0 Section 5.2.2 |
| **PAR Required** | Use PAR for all authorization requests | FAPI 2.0 Section 5.2.2.1 |
| **Short-lived Codes** | Authorization codes are short-lived (within 10 minutes) | FAPI 2.0 Section 5.2.2.2 |
| **Token Binding** | Token binding with DPoP or MTLS | FAPI 2.0 Section 5.2.2.4 |
| **Client Authentication** | `client_secret_post`, `client_secret_basic`, `private_key_jwt`, MTLS | FAPI 2.0 Section 5.2.2.5 |
| **ID Token Validation** | Strict ID Token validation | FAPI 2.0 Section 5.2.3 |

---

## Authrim Implementation Status

### ✅ Implemented Features (Phase 4-5)

#### PAR - Pushed Authorization Request

| Feature | Status | Implementation |
|:--|:--|:--|
| POST /as/par endpoint | ✅ | `op-auth` Worker |
| request_uri generation | ✅ | Secure random generation |
| Request validation | ✅ | Full parameter validation |
| Client authentication | ✅ | `client_secret_post`, `client_secret_basic` |
| KV storage | ✅ | `PAR_REQUESTS` KV Namespace |
| Expiration (60s) | ✅ | TTL-based expiration |
| One-time use | ✅ | KV delete after use |
| Error handling | ✅ | RFC 9126 compliant |

**Test Coverage:**
- ✅ 15 unit tests (Phase 4)

#### DPoP - Demonstrating Proof-of-Possession

| Feature | Status | Implementation |
|:--|:--|:--|
| DPoP header parsing | ✅ | Token & UserInfo endpoints |
| DPoP JWT verification | ✅ | Signature validation |
| jti replay prevention | ✅ | KV-based jti tracking |
| htm/htu validation | ✅ | Method & URI binding |
| Token binding | ✅ | `cnf` claim in access token |
| DPoP token type | ✅ | `token_type: DPoP` |
| Error handling | ✅ | RFC 9449 compliant |

**Test Coverage:**
- ✅ 12 unit tests (Phase 5)

### ⚙️ Partial Implementation

#### PKCE - Proof Key for Code Exchange

| Feature | Status | Implementation |
|:--|:--|:--|
| code_challenge support | ✅ | S256 method |
| code_verifier validation | ✅ | Token endpoint |
| PKCE enforcement | ⚙️ | Optional (should be required for FAPI) |

**Required for FAPI 2.0:**
- 🔧 Make PKCE mandatory for all clients

### ❌ Planned Features (Phase 6-8)

#### MTLS - Mutual TLS

| Feature | Status | Phase |
|:--|:--|:--|
| Client certificate authentication | ❌ | Phase 7 |
| Certificate validation | ❌ | Phase 7 |
| Certificate-bound tokens | ❌ | Phase 7 |
| `tls_client_auth` method | ❌ | Phase 7 |

**Blocker:**
- Cloudflare Workers mTLS support investigation required

#### JARM - JWT Secured Authorization Response Mode

| Feature | Status | Phase |
|:--|:--|:--|
| JWT response signing | ❌ | Phase 6 |
| response_mode=jwt | ❌ | Phase 6 |
| Response encryption | ❌ | Phase 7 |

#### Advanced Client Authentication

| Feature | Status | Phase |
|:--|:--|:--|
| `private_key_jwt` | ❌ | Phase 6 |
| `client_secret_jwt` | ❌ | Phase 6 |

### Implementation Details

**Phase 4: PAR Implementation**
- ✅ `op-auth` Worker
- ✅ `/as/par` endpoint
- ✅ request_uri generation and storage
- ✅ 15 unit tests

**Phase 5: DPoP Implementation**
- ✅ DPoP validation middleware
- ✅ Token binding with `cnf` claim
- ✅ Replay attack prevention
- ✅ 12 unit tests

**Workers:**
- `packages/op-auth/src/index.ts` - PAR endpoint
- `packages/op-token/src/index.ts` - DPoP token issuance
- `packages/op-userinfo/src/index.ts` - DPoP token validation

**KV Namespaces:**
- `PAR_REQUESTS` - PAR request_uri storage
- `DPOP_NONCES` - DPoP jti replay prevention

---

## Related Specifications

| Specification | Title | Status |
|:--|:--|:--|
| **FAPI 2.0 Security Profile** | Financial-grade API Security Profile 2.0 | ⚙️ Partial Implementation |
| **RFC 9126** | OAuth 2.0 Pushed Authorization Requests (PAR) | ✅ Implemented |
| **RFC 9449** | OAuth 2.0 Demonstrating Proof-of-Possession (DPoP) | ✅ Implemented |
| **RFC 8705** | OAuth 2.0 Mutual-TLS Client Authentication (MTLS) | ❌ Planned (Phase 7) |
| **JARM** | JWT Secured Authorization Response Mode | ❌ Planned (Phase 6) |
| **RFC 7636** | Proof Key for Code Exchange (PKCE) | ⚙️ Optional (should be mandatory) |

**Primary References:**
- [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-2_0-security-profile.html)
- [RFC 9126 - PAR](https://datatracker.ietf.org/doc/html/rfc9126)
- [RFC 9449 - DPoP](https://datatracker.ietf.org/doc/html/rfc9449)

---

## Testing Plan

### OpenID Conformance Suite

**Test Profile:**
- **Name:** FAPI 2.0 Security Profile
- **Purpose:** Verify financial-grade security requirements

**Test URL:**
https://www.certification.openid.net/

**Configuration:**
```bash
# Test Configuration
Issuer: https://authrim.YOUR_SUBDOMAIN.workers.dev
PAR Endpoint: https://authrim.YOUR_SUBDOMAIN.workers.dev/as/par
Token Endpoint: https://authrim.YOUR_SUBDOMAIN.workers.dev/token

# Enable features
PKCE: Required
PAR: Required
DPoP: Supported
```

### Test Procedure

1. **Deploy Authrim**
   ```bash
   pnpm run deploy
   ```

2. **Verify PAR Endpoint**
   ```bash
   curl -X POST https://authrim.YOUR_SUBDOMAIN.workers.dev/as/par \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -u "CLIENT_ID:CLIENT_SECRET" \
     -d "client_id=CLIENT_ID&response_type=code&redirect_uri=https://example.com/callback&scope=openid" | jq
   ```

3. **Test DPoP Flow**
   ```bash
   # 1. Generate DPoP key pair
   # 2. Create DPoP proof JWT
   # 3. Request token with DPoP header
   # 4. Access UserInfo with DPoP-bound token
   ```

4. **Run Conformance Tests**
   - Access OpenID Conformance Suite
   - Create test plan: **FAPI 2.0 Security Profile**
   - Configure Issuer URL and PAR endpoint
   - Enable PKCE and PAR
   - Execute available tests

### Expected Test Coverage

| Test Category | Description | Expected |
|:--|:--|:--|
| PAR - Endpoint | PAR endpoint availability | ✅ Pass |
| PAR - request_uri | request_uri generation | ✅ Pass |
| PAR - Validation | Parameter validation | ✅ Pass |
| PAR - Expiration | 60s TTL enforcement | ✅ Pass |
| PAR - One-time use | request_uri single use | ✅ Pass |
| DPoP - Proof Validation | DPoP JWT verification | ✅ Pass |
| DPoP - Token Binding | cnf claim in token | ✅ Pass |
| DPoP - Replay Prevention | jti uniqueness check | ✅ Pass |
| DPoP - Method Binding | htm claim validation | ✅ Pass |
| DPoP - URI Binding | htu claim validation | ✅ Pass |
| PKCE - Required | PKCE mandatory enforcement | ⚠️ Needs fix |
| MTLS - Client Auth | Client certificate auth | ❌ Not implemented |
| JARM - Response | JWT response signing | ❌ Not implemented |

**Note:** Specific test results will be recorded after individual testing.

### Known Limitations

1. **PKCE Enforcement**: Currently optional, should be mandatory for FAPI 2.0
2. **MTLS**: Not yet implemented (Cloudflare Workers limitation investigation needed)
3. **JARM**: Not yet implemented (planned for Phase 6)
4. **private_key_jwt**: Not yet implemented (planned for Phase 6)

---

## Certification Roadmap

### Current Status
- ✅ **Phase 4-5 Complete**: PAR (15 tests) + DPoP (12 tests)
- ⚙️ **Partial FAPI 2.0 Compliance**: Core security features implemented
- 🔧 **Improvements Needed**: PKCE enforcement, MTLS, JARM

### Next Steps

#### Phase 6: Advanced Features (Q1 2025)
- [ ] Implement JARM (JWT Secured Authorization Response Mode)
- [ ] Implement `private_key_jwt` client authentication
- [ ] Make PKCE mandatory for all authorization requests
- [ ] Run initial FAPI 2.0 conformance tests

#### Phase 7: Enterprise Security (Q2 2025)
- [ ] Investigate Cloudflare Workers MTLS support
- [ ] Implement MTLS client authentication (if possible)
- [ ] Implement certificate-bound tokens
- [ ] Complete FAPI 2.0 conformance testing

#### Phase 8: Certification Submission
- [ ] Address all conformance test failures
- [ ] Document FAPI 2.0 compliance
- [ ] Submit for OpenID Certified™ FAPI 2.0 Security Profile

---

## Related Documents

- [OIDC Basic OP](../OIDC%20Basic%20OP/README.md) - Basic OP profile conformance
- [OIDC Config OP](../OIDC%20Config%20OP/README.md) - Discovery configuration conformance
- [OIDC Dynamic OP](../OIDC%20Dynamic%20OP/README.md) - Dynamic Client Registration conformance
- [Test Plan](../OIDC%20Basic%20OP/test-plan.md) - Overall conformance testing strategy
- [Project README](../../README.md) - Authrim project overview

---

> **Status:** ⚙️ Partial Implementation – PAR & DPoP Complete, MTLS & JARM Pending
> **Last Updated:** 2025-11-18
