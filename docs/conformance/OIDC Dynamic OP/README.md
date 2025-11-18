# enrai – OpenID Connect Dynamic OP Conformance

## Vision & Objectives

**OIDC Dynamic OP プロファイル**は、OpenID Connect Dynamic Client Registration 1.0 仕様に準拠した動的クライアント登録機能を検証する認証プロファイルです。

### 目的
- ✅ クライアントの動的登録をサポート
- ✅ クライアントメタデータの検証と保存
- ✅ セキュアな `client_id` と `client_secret` の生成
- ✅ Subject Type（`public`, `pairwise`）のサポート
- ✅ `sector_identifier_uri` の検証（pairwise用）

---

## Required Features & Behavior

### 1. Dynamic Client Registration (RFC 7591 / OIDC Registration 1.0)

| 要件 | 説明 | 仕様参照 |
|:--|:--|:--|
| **Registration Endpoint** | `POST /register` でクライアントメタデータを受け付ける | RFC 7591 Section 3 |
| **Client ID Issuance** | セキュアでユニークな `client_id` を生成 | RFC 7591 Section 3.2.1 |
| **Client Secret Issuance** | セキュアな `client_secret` を生成（Confidential Client用） | RFC 7591 Section 3.2.1 |
| **Metadata Validation** | クライアントメタデータの検証 | OIDC Registration 3 |
| **Metadata Storage** | 登録情報をKVに永続化 | - |
| **Response Format** | RFC 7591準拠のJSONレスポンス | RFC 7591 Section 3.2 |

### 2. Client Metadata Fields

**Supported Fields:**
- `redirect_uris` **(required)** - リダイレクトURI配列
- `token_endpoint_auth_method` - 認証方式（`client_secret_post`, `client_secret_basic`, `none`）
- `grant_types` - グラントタイプ（`authorization_code`, `refresh_token`）
- `response_types` - レスポンスタイプ（`code`, `id_token`, `code id_token`）
- `client_name` - クライアント名
- `client_uri` - クライアントのホームページURL
- `logo_uri` - ロゴ画像URL
- `scope` - 要求するスコープ
- `contacts` - 管理者連絡先
- `tos_uri` - 利用規約URL
- `policy_uri` - プライバシーポリシーURL
- `jwks_uri` - クライアントのJWKS URI
- `jwks` - インラインJWK Set
- `subject_type` - Subject Type（`public`, `pairwise`）
- `sector_identifier_uri` - Sector Identifier URI（pairwise用）
- `id_token_signed_response_alg` - ID Token署名アルゴリズム
- `userinfo_signed_response_alg` - UserInfo署名アルゴリズム

### 3. Validation Rules

| 検証項目 | ルール | 仕様参照 |
|:--|:--|:--|
| **redirect_uris** | 必須、HTTPS必須（localhost例外） | OIDC Registration 2 |
| **token_endpoint_auth_method** | サポートする方式のみ許可 | RFC 7591 Section 2 |
| **grant_types/response_types** | 整合性チェック | RFC 7591 Section 2 |
| **subject_type** | `public` または `pairwise` のみ | OIDC Core 8 |
| **sector_identifier_uri** | pairwise時にHTTPS URLを検証 | OIDC Core 8.1 |
| **jwks/jwks_uri** | 両方指定された場合はエラー | OIDC Registration 2 |

### 4. Subject Type Support

| Subject Type | 説明 | Implementation |
|:--|:--|:--|
| **public** | すべてのRPに同じ `sub` 値を返す | ✅ Default |
| **pairwise** | RP毎に異なる `sub` 値を返す | ✅ `sector_identifier_uri` 検証実装 |

---

## Enrai Implementation Status

### Registration Endpoint (/register)

| 機能 | Status | Implementation |
|:--|:--|:--|
| POST /register | ✅ | `op-management` Worker |
| Client ID generation | ✅ | Secure random generation |
| Client Secret generation | ✅ | Secure random generation |
| Metadata validation | ✅ | Comprehensive validation |
| KV storage | ✅ | `CLIENTS` KV Namespace |
| Error handling | ✅ | RFC 7591 compliant errors |

### Client Metadata Support

| Field | Status | Notes |
|:--|:--|:--|
| `redirect_uris` | ✅ | Required, HTTPS validation |
| `token_endpoint_auth_method` | ✅ | `client_secret_post`, `client_secret_basic`, `none` |
| `grant_types` | ✅ | `authorization_code`, `refresh_token` |
| `response_types` | ✅ | `code`, `id_token`, `code id_token` |
| `client_name` | ✅ | Optional |
| `client_uri` | ✅ | Optional, URL validation |
| `logo_uri` | ✅ | Optional, URL validation |
| `scope` | ✅ | Optional |
| `contacts` | ✅ | Optional |
| `tos_uri` | ✅ | Optional, URL validation |
| `policy_uri` | ✅ | Optional, URL validation |
| `jwks_uri` | ✅ | Optional, URL validation |
| `jwks` | ✅ | Optional, JWK Set validation |
| `subject_type` | ✅ | `public`, `pairwise` |
| `sector_identifier_uri` | ✅ | Required for pairwise, HTTPS validation |
| `id_token_signed_response_alg` | ✅ | Default: RS256 |
| `userinfo_signed_response_alg` | ✅ | Default: RS256 |

### Security Features

| 機能 | Status | Implementation |
|:--|:--|:--|
| Secure client_id generation | ✅ | Crypto.randomUUID() |
| Secure client_secret generation | ✅ | Base64url random bytes |
| HTTPS enforcement | ✅ | redirect_uris validation |
| sector_identifier_uri validation | ✅ | Fetch + JSON parsing |
| jwks/jwks_uri mutual exclusion | ✅ | Validation logic |
| grant_types/response_types consistency | ✅ | Cross-validation |

### Implementation Details

**Phase 4: Dynamic Client Registration** (Completed)
- ✅ `op-management` Worker
- ✅ `/register` endpoint
- ✅ Comprehensive metadata validation
- ✅ Subject type support (`public`, `pairwise`)
- ✅ `sector_identifier_uri` validation
- ✅ Error handling (RFC 7591 compliant)

**Worker:** `packages/op-management/src/index.ts`
**Endpoint:** `POST /register`
**KV Namespace:** `CLIENTS`

**Test Coverage:**
- ✅ 56 unit tests (Phase 4)
- ✅ Registration validation tests
- ✅ Subject type tests
- ✅ Error handling tests

---

## Related Specifications

| Specification | Title | Status |
|:--|:--|:--|
| **OIDC Registration 1.0** | OpenID Connect Dynamic Client Registration 1.0 | ✅ Core Standard |
| **RFC 7591** | OAuth 2.0 Dynamic Client Registration Protocol | ✅ Core Standard |
| **OIDC Core 8** | Subject Identifier Types | ✅ Core Standard |

**Primary References:**
- [OIDC Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)
- [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591)

---

## Testing Plan

### OpenID Conformance Suite

**Test Profile:**
- **Name:** OpenID Connect Dynamic OP
- **Purpose:** Verify Dynamic Client Registration functionality

**Test URL:**
https://www.certification.openid.net/

**Configuration:**
```bash
# Test Configuration
Issuer: https://enrai.YOUR_SUBDOMAIN.workers.dev
Discovery URL: https://enrai.YOUR_SUBDOMAIN.workers.dev/.well-known/openid-configuration
Registration Endpoint: https://enrai.YOUR_SUBDOMAIN.workers.dev/register

# Dynamic Registration will auto-configure test clients
```

### Test Procedure

1. **Deploy Enrai**
   ```bash
   pnpm run deploy
   ```

2. **Verify Registration Endpoint**
   ```bash
   curl -X POST https://enrai.YOUR_SUBDOMAIN.workers.dev/register \
     -H "Content-Type: application/json" \
     -d '{
       "redirect_uris": ["https://example.com/callback"],
       "client_name": "Test Client",
       "grant_types": ["authorization_code"],
       "response_types": ["code"]
     }' | jq
   ```

3. **Verify Subject Type Support**
   ```bash
   # Test pairwise subject type
   curl -X POST https://enrai.YOUR_SUBDOMAIN.workers.dev/register \
     -H "Content-Type: application/json" \
     -d '{
       "redirect_uris": ["https://example.com/callback"],
       "subject_type": "pairwise",
       "sector_identifier_uri": "https://example.com/sector.json"
     }' | jq
   ```

4. **Run Conformance Tests**
   - Access OpenID Conformance Suite
   - Create test plan: **OpenID Connect Provider → Dynamic OP**
   - Configure Issuer URL
   - Enable Dynamic Client Registration
   - Execute all tests

### Expected Test Coverage

| Test Category | Description | Expected |
|:--|:--|:--|
| Registration Success | Valid metadata registration | ✅ Pass |
| Client ID Issuance | Unique client_id generation | ✅ Pass |
| Client Secret Issuance | Secure client_secret generation | ✅ Pass |
| Metadata Validation | Invalid metadata rejection | ✅ Pass |
| Subject Type - Public | Public subject type support | ✅ Pass |
| Subject Type - Pairwise | Pairwise subject type support | ✅ Pass |
| sector_identifier_uri | Validation for pairwise | ✅ Pass |
| Error Responses | RFC 7591 compliant errors | ✅ Pass |

**Note:** Specific test results will be recorded after individual testing.

---

## Certification Roadmap

### Current Status
- ✅ **Phase 4 Complete**: Dynamic Client Registration implemented (56 tests)
- ✅ **Ready for Testing**: All required features implemented

### Next Steps
1. **Individual Testing**: Run OpenID Dynamic OP conformance tests
2. **Record Results**: Document test outcomes in this README
3. **Address Issues**: Fix any discovered issues
4. **Certification**: Submit for OpenID Certified™ Dynamic OP

---

## Related Documents

- [OIDC Basic OP](../OIDC%20Basic%20OP/README.md) - Basic OP profile conformance
- [OIDC Config OP](../OIDC%20Config%20OP/README.md) - Discovery configuration conformance
- [Test Plan](../OIDC%20Basic%20OP/test-plan.md) - Overall conformance testing strategy
- [Project README](../../README.md) - Enrai project overview

---

> **Status:** ✅ Implementation Complete – Ready for Individual Testing
> **Last Updated:** 2025-11-18
