# authrim – OpenID Connect Config OP Conformance

## Vision & Objectives

**OIDC Config OP プロファイル**は、OpenID Connect Provider Discovery 1.0 仕様に準拠した設定エンドポイントの完全性を検証する認証プロファイルです。

### 目的
- ✅ `.well-known/openid-configuration` エンドポイントの完全準拠
- ✅ 必須メタデータフィールドの提供
- ✅ `issuer` の一貫性保証
- ✅ サポートする機能の正確な公開

---

## Required Features & Behavior

### 1. Discovery Endpoint (RFC 8414 / OIDC Discovery 1.0)

| 要件 | 説明 | 仕様参照 |
|:--|:--|:--|
| **Metadata Endpoint** | `/.well-known/openid-configuration` が有効なJSONを返す | OIDC Discovery 3 |
| **Issuer Consistency** | `issuer` フィールドがトークンの `iss` クレームと一致 | OIDC Discovery 3 |
| **Required Fields** | 必須フィールドをすべて含む | OIDC Discovery 3 |
| **Optional Fields** | サポートする機能を正確に公開 | OIDC Discovery 3 |
| **HTTPS Enforcement** | HTTPS URLのみを公開 | RFC 8414 Section 2 |

### 2. Required Metadata Fields

**MUST include:**
- `issuer` - OP の Issuer Identifier
- `authorization_endpoint` - 認可エンドポイントURL
- `token_endpoint` - トークンエンドポイントURL
- `jwks_uri` - JWK Set エンドポイントURL
- `response_types_supported` - サポートする `response_type` 値
- `subject_types_supported` - サポートする Subject Type (`public`, `pairwise`)
- `id_token_signing_alg_values_supported` - サポートする署名アルゴリズム

**SHOULD include:**
- `userinfo_endpoint` - UserInfo エンドポイントURL
- `registration_endpoint` - Dynamic Client Registration エンドポイントURL
- `scopes_supported` - サポートするスコープ
- `claims_supported` - サポートするクレーム
- `grant_types_supported` - サポートするグラントタイプ
- `token_endpoint_auth_methods_supported` - サポートする認証方式

### 3. JWKS Endpoint

| 要件 | 説明 | 仕様参照 |
|:--|:--|:--|
| **JWK Set Exposure** | `/.well-known/jwks.json` が有効な JWK Set を返す | RFC 7517 |
| **Key Format** | 正しい `kid`, `kty`, `alg`, `use` フィールド | RFC 7517 Section 4 |
| **RS256 Support** | RS256 署名用の公開鍵を公開 | OIDC Core 10.1 |
| **Base64url Encoding** | `n`, `e` が正しく base64url エンコード | RFC 7517 Section 6.3 |

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

| 要件 | Status | Implementation |
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
