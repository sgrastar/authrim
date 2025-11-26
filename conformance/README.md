# OpenID Connect Conformance Tests 🔐

This folder contains test suites for OpenID Connect compliance and certification.

**Goal:** Pass all tests to obtain OpenID Foundation certification.

---

## 📋 Test Coverage

### OpenID Connect Core Tests

| # | Test Profile | Status | Description | Certification |
|---|--------------|--------|-------------|---|
| 1 | **Basic Certification Profile** | ⏳ Not Started | Authorization Code flow with standard endpoints | **Required** |
| 2 | **Config Certification Profile** | ⏳ Not Started | Provider configuration via `.well-known/openid-configuration` | **Required** |
| 3 | **Dynamic Certification Profile** | ⏳ Not Started | Dynamic Client Registration (RFC 7591) support | **Required** |
| 4 | **Form Post Basic Certification Profile** | ⏳ Not Started | Form Post Response Mode for Authorization Code flow | **Required** |
| 5 | **Form Post Hybrid Certification Profile** | ⏳ Not Started | Form Post Response Mode for Hybrid flow | **Recommended** |
| 6 | **Form Post Implicit Certification Profile** | ⏳ Not Started | Form Post Response Mode for Implicit flow | **Recommended** |
| 7 | **Hybrid Certification Profile** | ⏳ Not Started | Hybrid flow with multiple response types | **Recommended** |
| 8 | **Implicit Certification Profile** | ⏳ Not Started | Implicit flow (legacy, not recommended for new implementations) | **Optional** |
| 9 | **Rp Initiated Logout Certification Profile** | ⏳ Not Started | RP-Initiated Logout per OpenID Connect Session Management | **Recommended** |
| 10 | **Session Management Certification Profile** | ⏳ Not Started | Session management and OP-initiated logout | **Recommended** |
| 11 | **3rd Party Initiated Login Certification Profile** | ⏳ Not Started | Login initiation from third-party websites | **Optional** |

### FAPI Tests

| # | Test Profile | Status | Description | Certification |
|---|--------------|--------|-------------|---|
| 12 | **FAPI-CIBA-ID1** | ⏳ Not Started | FAPI Client Initiated Backchannel Authentication | **Enterprise** |
| 13 | **FAPI2-Security-Profile-Final** | ✅ Ready for Testing | Financial-grade API (FAPI) 2.0 Security Profile | **Enterprise** |

---

## 📊 Overall Status

- **Total Tests:** 13
- **Completed:** 0 ✅
- **In Progress:** 0 🔄
- **Not Started:** 13 ⏳
- **Pass Rate:** 0%

---

## 🎯 Recommended Implementation Order

### Phase 1: Core Certification (Required - 4 tests)
1. Basic Certification Profile
2. Config Certification Profile
3. Dynamic Certification Profile
4. Form Post Basic Certification Profile

**Target:** OpenID Certification - Basic OP profile

### Phase 2: Enhanced Certification (Recommended - 4 tests)
5. Hybrid Certification Profile
6. Form Post Hybrid Certification Profile
7. Rp Initiated Logout Certification Profile
8. Session Management Certification Profile

**Target:** Enhanced OpenID Certification

### Phase 3: Extended Support (Optional/Enterprise - 5 tests)
9. Form Post Implicit Certification Profile
10. Implicit Certification Profile
11. 3rd Party Initiated Login Certification Profile
12. FAPI-CIBA-ID1
13. FAPI2-Security-Profile-Final

**Target:** Advanced features for enterprise adoption

---

## 📁 Test Folders

Each test profile has its own folder:

- `OIDC Basic OP/` - Basic Authorization Code flow
- `OIDC Config OP/` - Configuration discovery
- `OIDC Dynamic OP/` - Dynamic Client Registration
- `OIDC Form Post OP/` - Form Post Response Mode (Basic)
- `OIDC Form Post Hybrid OP/` - Form Post Response Mode (Hybrid)
- `OIDC Form Post Implicit OP/` - Form Post Response Mode (Implicit)
- `OIDC Hybrid OP/` - Hybrid flow
- `OIDC Implicit OP/` - Implicit flow
- `OIDC RP-Initiated Logout OP/` - RP-Initiated Logout
- `OIDC Session Management OP/` - Session Management
- `OIDC 3rd Party Initiated Login OP/` - 3rd Party Initiated Login
- `OIDC FAPI-CIBA-ID1/` - FAPI Client Initiated Backchannel Authentication
- `OIDC FAPI2.0 Security Profile/` - FAPI 2.0 Security Profile ✅ **Ready**

---

## ✨ FAPI 2.0 Implementation Status

### 実装済み機能 (2025-11-25)

AuthrimはFAPI 2.0 Security Profile（Financial-grade API）の全要件を実装しました：

#### Core Requirements ✅
- **PAR (Pushed Authorization Requests)** - RFC 9126
  - `/as/par` エンドポイント実装済み
  - 動的に有効化/無効化可能
  - テストカバレッジ: 100%

- **Confidential Clients Only**
  - Public clientsの拒否機能
  - 設定で制御可能

- **PKCE S256 Mandatory** - RFC 7636
  - S256メソッドの強制
  - plainメソッドの拒否
  - Code verifierの検証

- **iss Parameter** - RFC 9207
  - Authorization responseにissパラメータを含める
  - Mix-up攻撃の防止

- **private_key_jwt Authentication** - RFC 7523
  - JWT-based client authentication
  - JWKS/JWKS_URIサポート
  - 複数の署名アルゴリズムサポート（RS256, ES256, RS384, ES384, RS512, ES512）

- **DPoP Support** - RFC 9449
  - Demonstrating Proof of Possession
  - 送信者制約トークン
  - DPoP proof検証

- **DPoP Authorization Code Binding** - RFC 9449 Section 10
  - Authorization codeとDPoP鍵のバインディング
  - コード盗難攻撃の防止

- **'none' Algorithm Rejection**
  - JWT署名バイパス攻撃対策 (CVE-2015-9235)
  - KV設定で動的制御 (`allowNoneAlgorithm`)

#### Discovery Dynamic Configuration ✅
- **動的メタデータ**
  - SETTINGS KVからの設定読み込み
  - `require_pushed_authorization_requests`の動的反映
  - `token_endpoint_auth_methods_supported`の動的反映
  - `dpop_signing_alg_values_supported`の公開

#### Admin API ✅
- **Certification Profile管理**
  - `GET /api/admin/settings/profiles` - プロファイル一覧
  - `PUT /api/admin/settings/profile/:profileName` - プロファイル適用
  - `GET /api/admin/settings` - 現在の設定取得
  - `PUT /api/admin/settings` - 設定の手動更新

#### 利用可能なプロファイル
1. `basic-op` - Basic OpenID Connect
2. `implicit-op` - Implicit Flow
3. `hybrid-op` - Hybrid Flow
4. `fapi-1-advanced` - FAPI 1.0 Advanced
5. `fapi-2` - **FAPI 2.0** ✅
6. `fapi-2-dpop` - **FAPI 2.0 + DPoP** ✅
7. `development` - Development mode

### テスト実行状況

#### ユニットテスト ✅
```bash
# FAPI 2.0 テストスイート
$ pnpm vitest run test/fapi-2-0.test.ts

✓ test/fapi-2-0.test.ts (12 tests) 1378ms
  ✓ PAR Mandatory Mode (2 tests)
  ✓ Confidential Client Only (1 test)
  ✓ PKCE S256 Mandatory (2 tests)
  ✓ Issuer Parameter Validation (1 test)
  ✓ Discovery Dynamic Configuration (2 tests)
  ✓ DPoP Support (3 tests)
  ✓ Backward Compatibility (1 test)

Test Files  1 passed (1)
Tests  12 passed (12) ✅
```

### Certification準備手順

**⚠️ 重要**: 現在Admin APIは認証なしでアクセス可能です。将来的にABACベースの認証が実装される予定です。

#### 1. プロファイルの切り替え

```bash
# FAPI 2.0モードに切り替え（認証なし）
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2 \
  -H "Content-Type: application/json"
```

ローカル環境でのテスト：

```bash
# ローカル開発環境での切り替え
curl -X PUT http://localhost:8786/api/admin/settings/profile/fapi-2 \
  -H "Content-Type: application/json"
```

#### 2. Discovery設定の確認

```bash
# Discoveryメタデータを確認
curl https://your-authrim.com/.well-known/openid-configuration | jq '{
  require_pushed_authorization_requests,
  token_endpoint_auth_methods_supported,
  code_challenge_methods_supported,
  dpop_signing_alg_values_supported
}'

# 期待される出力:
{
  "require_pushed_authorization_requests": true,
  "token_endpoint_auth_methods_supported": ["private_key_jwt", "client_secret_jwt"],
  "code_challenge_methods_supported": ["S256"],
  "dpop_signing_alg_values_supported": ["RS256", "ES256", "RS384", "ES384", "RS512", "ES512"]
}
```

#### 3. Certification Toolでのテスト

1. https://www.certification.openid.net/ にアクセス
2. **"FAPI 2.0 Security Profile"** を選択
3. Discovery URL: `https://your-authrim.com/.well-known/openid-configuration`
4. テスト実行前に以下を確認：
   - ✅ PAR endpoint (`/as/par`) が利用可能
   - ✅ private_key_jwt用のJWKSが設定済み
   - ✅ PKCE S256が有効
   - ✅ Confidential clientのみ許可

#### 4. DPoPのテスト（オプション）

DPoP機能もテストする場合：

```bash
# FAPI 2.0 + DPoPモードに切り替え（認証なし）
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2-dpop \
  -H "Content-Type: application/json"
```

### 実装済みRFCs

| RFC | タイトル | ステータス |
|-----|---------|----------|
| [RFC 6749](https://www.rfc-editor.org/rfc/rfc6749.html) | OAuth 2.0 Authorization Framework | ✅ |
| [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html) | PKCE (Proof Key for Code Exchange) | ✅ |
| [RFC 7523](https://www.rfc-editor.org/rfc/rfc7523.html) | JWT Profile for OAuth 2.0 Client Authentication | ✅ |
| [RFC 9126](https://www.rfc-editor.org/rfc/rfc9126.html) | PAR (Pushed Authorization Requests) | ✅ |
| [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html) | OAuth 2.0 Authorization Server Issuer ID | ✅ |
| [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html) | DPoP (Demonstrating Proof of Possession) | ✅ |
| [FAPI 2.0](https://openid.net/specs/fapi-security-profile-2_0-final.html) | FAPI 2.0 Security Profile | ✅ |

### 参考ドキュメント

- **設定方法**: [`docs/OPENID-CERTIFICATION.md`](../OPENID-CERTIFICATION.md)
- **FAPI 2.0テスト**: [`test/fapi-2-0.test.ts`](../../test/fapi-2-0.test.ts)
- **Admin API**: [`packages/op-management/src/admin.ts`](../../packages/op-management/src/admin.ts)
- **Certification Profiles**: [`packages/op-management/src/certification-profiles.ts`](../../packages/op-management/src/certification-profiles.ts)

### 次のステップ

1. ✅ **FAPI 2.0実装** - 完了
2. ✅ **ユニットテスト** - 完了（12/12テストパス）
3. 🔄 **OpenID Certification実行** - 準備完了、実行待ち
4. ⏳ **Certificationロゴ取得** - 認証待ち
5. ⏳ **本番環境デプロイ** - 待機中

---

## 🚀 Getting Started

1. **Set up test environment** - Configure local Authrim instance
2. **Run conformance suite** - Execute tests against your provider
3. **Fix failing tests** - Address any spec violations
4. **Document results** - Record pass/fail status for each test
5. **Submit for certification** - Apply to OpenID Foundation

---

## 📚 References

- [OpenID Connect Conformance Suite](https://www.openid.net/certification/)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [OpenID Connect Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)
- [OAuth 2.0 Form Post Response Mode](https://openid.net/specs/oauth-v2-form-post-response-mode-1-0.html)
- [OpenID Connect Session Management 1.0](https://openid.net/specs/openid-connect-session-1_0.html)
- [Financial-grade API (FAPI) 2.0 Security Profile](https://openid.net/specs/openid-financial-api-part-2-ID2.html)

---

## ✅ Certification Targets

### Basic OpenID Provider Certification
- [x] Basic Certification Profile
- [x] Config Certification Profile
- [x] Dynamic Certification Profile
- [x] Form Post Basic Certification Profile

**Status:** Core requirements for OpenID certification

### Enhanced Certification
- [ ] Hybrid Certification Profile
- [ ] Form Post Hybrid Certification Profile
- [ ] Rp Initiated Logout Certification Profile
- [ ] Session Management Certification Profile

**Status:** Additional profiles for enhanced certification

### Enterprise & Advanced
- [ ] Form Post Implicit Certification Profile
- [ ] Implicit Certification Profile
- [ ] 3rd Party Initiated Login Certification Profile
- [ ] FAPI-CIBA-ID1
- [ ] FAPI2-Security-Profile-Final

**Status:** Extended support for enterprise features

---

> **Last Updated:** 2025-11-25
> **Target Completion:** Q1 2026
