# authrim – OpenID Connect Config OP Conformance

## Vision & Objectives

**OIDC Config OP Profile** is a certification profile that verifies the completeness of configuration endpoints compliant with the OpenID Connect Provider Discovery 1.0 specification.

### Objectives
- ✅ Full compliance with `.well-known/openid-configuration` endpoint
- ✅ Provision of required metadata fields
- ✅ Guarantee of `issuer` consistency
- ✅ Accurate disclosure of supported features

---

## Required Features & Behavior

### 1. Discovery Endpoint (RFC 8414 / OIDC Discovery 1.0)

| Requirement | Description | Specification Reference |
|:--|:--|:--|
| **Metadata Endpoint** | `/.well-known/openid-configuration` returns valid JSON | OIDC Discovery 3 |
| **Issuer Consistency** | `issuer` field matches token `iss` claim | OIDC Discovery 3 |
| **Required Fields** | Includes all required fields | OIDC Discovery 3 |
| **Optional Fields** | Accurately publishes supported features | OIDC Discovery 3 |
| **HTTPS Enforcement** | Only publish HTTPS URLs | RFC 8414 Section 2 |

### 2. Required Metadata Fields

**MUST include:**
- `issuer` - OP's Issuer Identifier
- `authorization_endpoint` - Authorization endpoint URL
- `token_endpoint` - Token endpoint URL
- `jwks_uri` - JWK Set endpoint URL
- `response_types_supported` - Supported `response_type` values
- `subject_types_supported` - Supported Subject Types (`public`, `pairwise`)
- `id_token_signing_alg_values_supported` - Supported signing algorithms

**SHOULD include:**
- `userinfo_endpoint` - UserInfo endpoint URL
- `registration_endpoint` - Dynamic Client Registration endpoint URL
- `scopes_supported` - Supported scopes
- `claims_supported` - Supported claims
- `grant_types_supported` - Supported grant types
- `token_endpoint_auth_methods_supported` - Supported authentication methods

### 3. JWKS Endpoint

| Requirement | Description | Specification Reference |
|:--|:--|:--|
| **JWK Set Exposure** | `/.well-known/jwks.json` returns valid JWK Set | RFC 7517 |
| **Key Format** | Correct `kid`, `kty`, `alg`, `use` fields | RFC 7517 Section 4 |
| **RS256 Support** | Publish public key for RS256 signing | OIDC Core 10.1 |
| **Base64url Encoding** | `n`, `e` correctly base64url encoded | RFC 7517 Section 6.3 |

---

## Authrim Implementation Status

### Discovery Metadata (/.well-known/openid-configuration)

| Field | Status | Implementation |
|:--|:--|:--|
| `issuer` | ✅ | Cloudflare Workers URL |
| `authorization_endpoint` | ✅ | `/authorize` |
| `token_endpoint` | ✅ | `/token` |
| `userinfo_endpoint` | ✅ | `/userinfo` |
| `jwks_uri` | ✅ | `/.well-known/jwks.json` |
| `registration_endpoint` | ✅ | `/register` (Phase 4) |
| `scopes_supported` | ✅ | `openid`, `profile`, `email` |
| `response_types_supported` | ✅ | `code`, `code id_token`, `id_token` |
| `response_modes_supported` | ✅ | `query`, `fragment`, `form_post` |
| `grant_types_supported` | ✅ | `authorization_code`, `refresh_token` |
| `subject_types_supported` | ✅ | `public`, `pairwise` |
| `id_token_signing_alg_values_supported` | ✅ | `RS256` |
| `token_endpoint_auth_methods_supported` | ✅ | `client_secret_post`, `client_secret_basic` |
| `claims_supported` | ✅ | `sub`, `iss`, `aud`, `exp`, `iat`, `name`, `email` |
| `code_challenge_methods_supported` | ✅ | `S256` (PKCE) |

### JWKS Endpoint (/.well-known/jwks.json)

| Requirement | Status | Implementation |
|:--|:--|:--|
| JWK Set exposure | ✅ | `op-discovery` Worker |
| RS256 public key | ✅ | `kid: edge-key-1` |
| Base64url encoding | ✅ | JOSE library |
| Key rotation support | ⚙️ | Phase 8 (planned) |

### Implementation Details

**Phase 1-2: Discovery & JWKS** (Completed)
- ✅ `op-discovery` Worker
- ✅ Static metadata configuration
- ✅ JWKS endpoint with RS256 key
- ✅ Issuer consistency enforcement

**Worker:** `packages/op-discovery/src/index.ts`
**Endpoints:**
- `GET /.well-known/openid-configuration`
- `GET /.well-known/jwks.json`

---

## Related Specifications

| Specification | Title | Status |
|:--|:--|:--|
| **OIDC Discovery 1.0** | OpenID Connect Discovery 1.0 | ✅ Core Standard |
| **RFC 8414** | OAuth 2.0 Authorization Server Metadata | ✅ Core Standard |
| **RFC 7517** | JSON Web Key (JWK) | ✅ Core Standard |

**Primary Reference:**
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)

---

## Testing Plan

### OpenID Conformance Suite

**Test Profile:**
- **Name:** OpenID Connect Config OP
- **Purpose:** Verify Discovery metadata completeness and accuracy

**Test URL:**
https://www.certification.openid.net/

**Configuration:**
```bash
# Test Configuration
Issuer: https://authrim.YOUR_SUBDOMAIN.workers.dev
Discovery URL: https://authrim.YOUR_SUBDOMAIN.workers.dev/.well-known/openid-configuration
JWKS URL: https://authrim.YOUR_SUBDOMAIN.workers.dev/.well-known/jwks.json
```

### Test Procedure

1. **Deploy Authrim**
   ```bash
   pnpm run deploy
   ```

2. **Verify Discovery Endpoint**
   ```bash
   curl https://authrim.YOUR_SUBDOMAIN.workers.dev/.well-known/openid-configuration | jq
   ```

3. **Verify JWKS Endpoint**
   ```bash
   curl https://authrim.YOUR_SUBDOMAIN.workers.dev/.well-known/jwks.json | jq
   ```

4. **Run Conformance Tests**
   - Access OpenID Conformance Suite
   - Create test plan: **OpenID Connect Provider → Config OP**
   - Configure Issuer URL
   - Execute all tests

### Expected Test Coverage

| Test Category | Description | Expected |
|:--|:--|:--|
| Discovery Metadata | All required fields present | ✅ Pass |
| Field Validation | Correct data types and formats | ✅ Pass |
| Issuer Consistency | `issuer` matches token `iss` | ✅ Pass |
| HTTPS Enforcement | All URLs use HTTPS | ✅ Pass |
| JWKS Validation | Valid JWK Set with RS256 key | ✅ Pass |

**Note:** Specific test results will be recorded after individual testing.

---

## Certification Roadmap

### Current Status
- ✅ **Phase 1-2 Complete**: Discovery & JWKS endpoints implemented
- ✅ **Ready for Testing**: All required features implemented

### Next Steps
1. **Individual Testing**: Run OpenID Config OP conformance tests
2. **Record Results**: Document test outcomes in this README
3. **Address Issues**: Fix any discovered issues
4. **Certification**: Submit for OpenID Certified™ Config OP

---

## Related Documents

- [OIDC Basic OP](../OIDC%20Basic%20OP/README.md) - Basic OP profile conformance
- [Test Plan](../OIDC%20Basic%20OP/test-plan.md) - Overall conformance testing strategy
- [Project README](../../README.md) - Authrim project overview

---

> **Status:** ✅ Implementation Complete – Ready for Individual Testing
> **Last Updated:** 2025-11-18
