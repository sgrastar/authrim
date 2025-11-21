# Authrim API Inventory 📋

**Last Updated**: 2025-11-12
**Status**: Phase 4 Complete, Phase 5 Planning

---

## 📊 Overview

This document records the current status and future plans for all API endpoints of the Authrim OIDC OP.

> 📄 **Detailed API Specifications**: [OpenAPI 3.1 Specification](../api/openapi.yaml) | [API Guide](../api/README.md)

### Statistics Summary

| Category | Implemented | Phase 5 Planned | Under Consideration | Total |
|---------|---------|------------|--------|------|
| **OIDC Core** | 7 | 0 | 0 | 7 |
| **OIDC Extensions** | 4 | 0 | 0 | 4 |
| **Auth UI** | 0 | 6 | 0 | 6 |
| **Admin API** | 0 | 9 | 0 | 9 |
| **Session Management** | 0 | 6 | 0 | 6 |
| **Logout** | 0 | 2 | 0 | 2 |
| **Token Exchange** | 2 | 0 | 3+ | 5+ |
| **Total** | **13** | **23** | **3+** | **39+** |

---

## ① OIDC Core APIs ✅ Implemented (Phase 2 Complete)

| Endpoint | Method | Status | Phase | RFC/Spec |
|----------|--------|--------|-------|----------|
| `/.well-known/openid-configuration` | GET | ✅ Implemented | Phase 2 | OIDC Discovery |
| `/.well-known/jwks.json` | GET | ✅ Implemented | Phase 2 | OIDC Core |
| `/authorize` | GET | ✅ Implemented | Phase 2 | OIDC Core 3.1.2 |
| `/authorize` | POST | ✅ Implemented | Phase 2 | OIDC Core 3.1.2.1 |
| `/token` | POST | ✅ Implemented | Phase 2 | OIDC Core 3.1.3 |
| `/userinfo` | GET | ✅ Implemented | Phase 2 | OIDC Core 5.3 |
| `/userinfo` | POST | ✅ Implemented | Phase 2 | OIDC Core 5.3.1 |

### Features
- **PKCE Support** (RFC 7636)
- **Claims Parameter Support** (OIDC Core 5.5)
- **All Standard Scopes Support** (openid, profile, email, address, phone)
- **Token Revocation on Code Reuse** (RFC 6749 Section 4.1.2)

---

## ② OIDC Extensions ✅ Implemented (Phase 4 Complete)

| Endpoint | Method | Status | Phase | RFC/Spec |
|----------|--------|--------|-------|----------|
| `/register` | POST | ✅ Implemented | Phase 4 | RFC 7591 (DCR) |
| `/as/par` | POST | ✅ Implemented | Phase 4 | RFC 9126 (PAR) |
| `/introspect` | POST | ✅ Implemented | Phase 4 | RFC 7662 |
| `/revoke` | POST | ✅ Implemented | Phase 4 | RFC 7009 |

### Additional Features (Phase 4)
- **DPoP Support** (RFC 9449) - Token Binding
- **Pairwise Subject Identifiers** (OIDC Core 8.1) - Privacy Protection
- **Refresh Token Flow** (RFC 6749 Section 6) - Token Rotation
- **Form Post Response Mode** (OAuth 2.0 Form Post) - Secure Response

---

## ③ Auth UI APIs 📝 Phase 5 Planned

| Endpoint | Method | Status | Phase | Purpose |
|----------|--------|--------|-------|------|
| `/auth/passkey/register` | POST | 📝 Phase 5 Planned | Phase 5 | Start Passkey registration |
| `/auth/passkey/verify` | POST | 📝 Phase 5 Planned | Phase 5 | Verify Passkey |
| `/auth/magic-link/send` | POST | 📝 Phase 5 Planned | Phase 5 | Send Magic Link |
| `/auth/magic-link/verify` | POST | 📝 Phase 5 Planned | Phase 5 | Verify Magic Link |
| `/auth/consent` | GET | 📝 Phase 5 Planned | Phase 5 | Get consent screen data |
| `/auth/consent` | POST | 📝 Phase 5 Planned | Phase 5 | Confirm consent |

### Goals
- **Passwordless First** - WebAuthn/Passkey + Magic Link
- **Intuitive & Fast UX** - Prioritize user experience

---

## ④ Admin API 📝 Phase 5 Planned

### User Management

| Endpoint | Method | Status | Phase | Purpose |
|----------|--------|--------|-------|------|
| `/admin/users` | GET | 📝 Phase 5 Planned | Phase 5 | List/Search users |
| `/admin/users` | POST | 📝 Phase 5 Planned | Phase 5 | Create user |
| `/admin/users/:id` | PUT | 📝 Phase 5 Planned | Phase 5 | Update user |
| `/admin/users/:id` | DELETE | 📝 Phase 5 Planned | Phase 5 | Delete user |

**Search Parameters**:
- `q`: Search query (email, name)
- `filter`: `verified`, `unverified`, `active`, `inactive`
- `sort`: `created_at`, `last_login_at`, `email`, `name`
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 50, max: 100)

### クライアント管理

| Endpoint | Method | Status | Phase | 目的 |
|----------|--------|--------|-------|------|
| `/admin/clients` | GET | 📝 Phase 5計画 | Phase 5 | クライアント一覧 |
| `/admin/clients` | POST | 📝 Phase 5計画 | Phase 5 | クライアント作成（DCR拡張） |
| `/admin/clients/:id` | PUT | 📝 Phase 5計画 | Phase 5 | クライアント更新 |
| `/admin/clients/:id` | DELETE | 📝 Phase 5計画 | Phase 5 | クライアント削除 |

### 統計・その他

| Endpoint | Method | Status | Phase | 目的 |
|----------|--------|--------|-------|------|
| `/admin/stats` | GET | 📝 Phase 5計画 | Phase 5 | 統計情報 |

---

## ⑤ セッション管理 API 📝 Phase 5計画（2025-11-12追加）

### ITP対応 クロスドメインSSO

| Endpoint | Method | Status | Phase | 目的 |
|----------|--------|--------|-------|------|
| `/auth/session/token` | POST | 📝 Phase 5計画 | Phase 5 | 短命トークン発行（5分TTL） |
| `/auth/session/verify` | POST | 📝 Phase 5計画 | Phase 5 | 短命トークン検証 & RPセッション確立 |
| `/session/status` | GET | 📝 Phase 5計画 | Phase 5 | IdPセッション有効性確認（iframe代替） |
| `/session/refresh` | POST | 📝 Phase 5計画 | Phase 5 | セッション延命（Active TTL型） |

**目的**: サードパーティCookie不使用のITP完全対応SSO

### 管理者セッション管理

| Endpoint | Method | Status | Phase | 目的 |
|----------|--------|--------|-------|------|
| `/admin/sessions` | GET | 📝 Phase 5計画 | Phase 5 | セッション一覧（User/Device別） |
| `/admin/sessions/:id/revoke` | POST | 📝 Phase 5計画 | Phase 5 | 個別セッション強制ログアウト |

---

## ⑥ Logout API 📝 Phase 5計画（2025-11-12追加）

| Endpoint | Method | Status | Phase | 目的 |
|----------|--------|--------|-------|------|
| `/logout` | GET | 📝 Phase 5計画 | Phase 5 | Front-channel Logout（ブラウザ→OP） |
| `/logout/backchannel` | POST | 📝 Phase 5計画 | Phase 5 | Back-channel Logout（OP→RP、RFC推奨） |

**注**: ITP環境ではiframe-based logoutは機能しないため、Back-channel Logoutが推奨

---

## ⑦ トークン交換系 API 🔄 検討中（2025-11-12追加）

### 現在実装済み

| Endpoint | grant_type | Status | RFC |
|----------|-----------|--------|-----|
| `/token` | `authorization_code` | ✅ 実装済み | RFC 6749 |
| `/token` | `refresh_token` | ✅ 実装済み | RFC 6749 Section 6 |

### 将来検討すべきトークン交換メカニズム

#### Option A: RFC 8693 Token Exchange（標準、最も柔軟）

```http
POST /token
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token={token}
&subject_token_type={type}
&requested_token_type={type}
```

**対応可能なトークンタイプ**:
- 標準: access_token, refresh_token, id_token, saml2, saml1, jwt
- Authrim独自:
  - `urn:authrim:params:oauth:token-type:session-token` - セッショントークン
  - `urn:authrim:params:oauth:token-type:magic-link-token` - Magic Linkトークン
  - `urn:authrim:params:oauth:token-type:passkey-assertion` - Passkey認証アサーション

**ユースケース**:
- セッショントークン → アクセストークン（ITP対応SSO）
- アクセストークン → アクセストークン（スコープ変更）
- IDトークン → アクセストークン（トークン変換）
- Delegation（ユーザーの代理でトークン発行）
- Impersonation（管理者なりすまし、デバッグ用）

#### Option B: 専用セッション交換API（シンプル、ITP対応SSO特化）

```http
POST /auth/session/exchange
{
  "session_token": "abc123",
  "client_id": "client1",
  "scope": "openid profile"
}
```

**メリット**: シンプル、初心者に優しい、ITP対応SSO専用

#### Option C: Hybrid アプローチ（両方サポート）

- RFC 8693（汎用・高度なユースケース）
- 専用API（シンプル・使いやすさ）

### 決定事項

- **ステータス**: 検討中
- **決定時期**: Phase 5実装時に要件整理
- **メモ**: `/auth/session/token` と `/auth/session/verify` は Token Exchange の一形態として実装可能

---

## 📈 将来の拡張（Phase 6以降）

### Phase 6: CLI & Automation
- 管理API（デプロイメント、設定管理）

### Phase 7: Enterprise Flows
- **Hybrid Flow** - `POST /authorize` (response_type=code id_token)
- **Device Flow** - `POST /device/code`, `POST /device/token`
- **JWT Bearer Flow** - `POST /token` (grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer)
- **CIBA** - Client Initiated Backchannel Authentication
- **Social Login APIs** - Google, GitHub, Microsoft, etc.
- **SAML Bridge** - OIDC ↔ SAML 2.0
- **SCIM 2.0** - User Provisioning API

### Phase 8: Next-Gen
- **OpenID4VP** - Verifiable Presentations API
- **OpenID4CI** - Credential Issuance API
- **OpenID Federation** - Trust Chain API
- **GraphQL API** - 統一API

### Phase 9: SaaS Platform
- **Multi-tenant APIs** - テナント管理、カスタムドメイン
- **Billing APIs** - 使用量メータリング、課金
- **Marketplace APIs** - プラグイン管理

---

## 🔗 参考資料

### 標準仕様
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [RFC 6749 - OAuth 2.0](https://tools.ietf.org/html/rfc6749)
- [RFC 7591 - Dynamic Client Registration](https://tools.ietf.org/html/rfc7591)
- [RFC 7662 - Token Introspection](https://tools.ietf.org/html/rfc7662)
- [RFC 7009 - Token Revocation](https://tools.ietf.org/html/rfc7009)
- [RFC 9126 - PAR](https://tools.ietf.org/html/rfc9126)
- [RFC 9449 - DPoP](https://tools.ietf.org/html/rfc9449)
- [RFC 8693 - Token Exchange](https://tools.ietf.org/html/rfc8693)

### 関連ドキュメント
- **API仕様書**
  - [openapi.yaml](../api/openapi.yaml) - OpenAPI 3.1仕様書
  - [API README](../api/README.md) - APIガイド・クイックスタート
- **設計ドキュメント**
  - [database-schema.md](../architecture/database-schema.md) - データベーススキーマ・ER図
  - [design-system.md](../design/design-system.md) - デザインシステム
  - [wireframes.md](../design/wireframes.md) - UI ワイヤーフレーム
  - [PHASE5_PLANNING.md](./PHASE5_PLANNING.md) - Phase 5詳細計画
- **プロジェクト情報**
  - [ROADMAP.md](../ROADMAP.md) - 全体ロードマップ
  - [technical-specs.md](../architecture/technical-specs.md) - 技術仕様

---

**変更履歴**:
- 2025-11-12: 初版作成、Phase 4完了状態を記録
- 2025-11-12: Phase 5計画API追加（セッション管理、Logout、管理者セッション管理）
- 2025-11-12: トークン交換系API検討事項追加
- 2025-11-13: OpenAPI 3.1仕様書とAPIガイドへのリンク追加
