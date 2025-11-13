# Enrai API Documentation 🚀

**最終更新**: 2025-11-13
**API Version**: v1.0 (Phase 5)
**Base URL**: `https://your-domain.com`

---

## 📋 目次

1. [概要](#概要)
2. [API Categories](#api-categories)
3. [認証方式](#認証方式)
4. [レート制限](#レート制限)
5. [エラーハンドリング](#エラーハンドリング)
6. [OpenAPI仕様](#openapi仕様)
7. [クイックスタート](#クイックスタート)

---

## 概要

Enrai OIDC OPは、39以上のAPIエンドポイントを提供します：

| カテゴリ | エンドポイント数 | ステータス |
|---------|----------------|-----------|
| **OIDC Core** | 7 | ✅ Phase 2完了 |
| **OIDC 拡張** | 4 | ✅ Phase 4完了 |
| **認証UI** | 6 | 📝 Phase 5計画 |
| **管理者API** | 9 | 📝 Phase 5計画 |
| **セッション管理** | 6 | 📝 Phase 5計画 |
| **Logout** | 2 | 📝 Phase 5計画 |
| **トークン交換** | 2+ | 🔄 検討中 |
| **合計** | **39+** | - |

---

## API Categories

### 1. OIDC Core APIs ✅ 実装済み

標準的なOIDC OPの基本機能：

- `GET /.well-known/openid-configuration` - Discovery
- `GET /.well-known/jwks.json` - JSON Web Key Set
- `GET/POST /authorize` - Authorization Endpoint
- `POST /token` - Token Endpoint
- `GET/POST /userinfo` - UserInfo Endpoint

**準拠規格**: OpenID Connect Core 1.0, RFC 6749

### 2. OIDC 拡張機能 ✅ 実装済み

エンタープライズグレードのセキュリティ機能：

- `POST /register` - Dynamic Client Registration (RFC 7591)
- `POST /as/par` - Pushed Authorization Requests (RFC 9126)
- `POST /introspect` - Token Introspection (RFC 7662)
- `POST /revoke` - Token Revocation (RFC 7009)

**追加機能**:
- DPoP (RFC 9449) - トークンバインディング
- Pairwise Subject Identifiers - プライバシー保護
- Refresh Token Rotation

### 3. 認証UI関連 API 📝 Phase 5

パスワードレス認証のための新しいエンドポイント：

- `POST /auth/passkey/register` - Passkey登録
- `POST /auth/passkey/verify` - Passkey検証
- `POST /auth/magic-link/send` - Magic Link送信
- `POST /auth/magic-link/verify` - Magic Link検証
- `GET /auth/consent` - 同意画面データ取得
- `POST /auth/consent` - 同意確定

**目標**: Auth0/Clerkを超えるUX

### 4. 管理者API 📝 Phase 5

ユーザー・クライアント管理のための管理者専用API：

#### ユーザー管理
- `GET /admin/users` - ユーザー一覧・検索
- `POST /admin/users` - ユーザー作成
- `PUT /admin/users/:id` - ユーザー更新
- `DELETE /admin/users/:id` - ユーザー削除

#### クライアント管理
- `GET /admin/clients` - クライアント一覧
- `POST /admin/clients` - クライアント作成
- `PUT /admin/clients/:id` - クライアント更新
- `DELETE /admin/clients/:id` - クライアント削除

#### 統計
- `GET /admin/stats` - 統計情報

**認証**: Bearer Token (管理者権限必須)

### 5. セッション管理API 📝 Phase 5

ITP対応のクロスドメインSSO：

- `POST /auth/session/token` - 短命トークン発行（5分TTL）
- `POST /auth/session/verify` - 短命トークン検証
- `GET /session/status` - セッション有効性確認
- `POST /session/refresh` - セッション延命
- `GET /admin/sessions` - セッション一覧（管理者用）
- `POST /admin/sessions/:id/revoke` - セッション無効化（管理者用）

**特徴**: サードパーティCookie不使用

### 6. Logout API 📝 Phase 5

標準的なログアウト機能：

- `GET /logout` - Front-channel Logout
- `POST /logout/backchannel` - Back-channel Logout (RFC推奨)

---

## 認証方式

### 1. OAuth 2.0 Bearer Token

**対象**: `/userinfo`, `/introspect`, `/revoke`, `/admin/*`

```http
Authorization: Bearer {access_token}
```

### 2. Client Authentication

**対象**: `/token`, `/introspect`, `/revoke`

**サポートされる方式**:
- `client_secret_basic` - Basic認証 (デフォルト)
- `client_secret_post` - POSTパラメータ
- `client_secret_jwt` - JWT (RFC 7523)
- `private_key_jwt` - 秘密鍵JWT

### 3. Cookie + CSRF Token

**対象**: 管理者セッション、同意画面

```http
Cookie: session_id={session_id}
X-CSRF-Token: {csrf_token}
```

### 4. DPoP (RFC 9449)

**対象**: 全トークンエンドポイント（オプション）

```http
DPoP: {dpop_proof_jwt}
```

---

## レート制限

| エンドポイント | 制限 | 期間 | 単位 |
|--------------|------|------|------|
| `/login` | 5 | 1分 | IP |
| `/register` | 3 | 1分 | IP |
| `/auth/magic-link/send` | 3 | 15分 | email |
| `/token` | 10 | 1分 | client_id |
| `/admin/*` | 100 | 1分 | session |
| その他 | 60 | 1分 | IP |

**レート制限超過時**:
```json
{
  "error": "rate_limit_exceeded",
  "error_description": "Too many requests. Please try again later.",
  "retry_after": 60
}
```

**ヘッダー**:
```http
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 2
X-RateLimit-Reset: 1678901234
```

---

## エラーハンドリング

### 標準エラーレスポンス

```json
{
  "error": "invalid_request",
  "error_description": "The request is missing a required parameter",
  "error_uri": "https://docs.enrai.org/errors/invalid_request"
}
```

### エラーコード一覧

#### OAuth 2.0 Standard Errors (RFC 6749)

| エラーコード | HTTP Status | 説明 |
|-------------|-------------|------|
| `invalid_request` | 400 | リクエストパラメータが不正 |
| `invalid_client` | 401 | クライアント認証失敗 |
| `invalid_grant` | 400 | 認可コード/リフレッシュトークンが不正 |
| `unauthorized_client` | 400 | クライアントが認可されていない |
| `unsupported_grant_type` | 400 | グラントタイプがサポートされていない |
| `invalid_scope` | 400 | スコープが不正 |
| `access_denied` | 403 | ユーザーが同意を拒否 |
| `server_error` | 500 | サーバー内部エラー |
| `temporarily_unavailable` | 503 | 一時的に利用不可 |

#### OIDC Errors

| エラーコード | HTTP Status | 説明 |
|-------------|-------------|------|
| `interaction_required` | 400 | ユーザー操作が必要 |
| `login_required` | 400 | ログインが必要 |
| `consent_required` | 400 | 同意が必要 |
| `invalid_request_uri` | 400 | request_uriが不正 |
| `invalid_request_object` | 400 | request JWTが不正 |

#### Enrai独自エラー

| エラーコード | HTTP Status | 説明 |
|-------------|-------------|------|
| `passkey_not_supported` | 400 | Passkeyがサポートされていない |
| `magic_link_expired` | 400 | Magic Linkの有効期限切れ |
| `session_expired` | 401 | セッションの有効期限切れ |
| `rate_limit_exceeded` | 429 | レート制限超過 |
| `insufficient_permissions` | 403 | 権限不足（管理者API） |

---

## OpenAPI仕様

詳細なAPI仕様は OpenAPI 3.1 形式で提供されています：

📄 **[openapi.yaml](./openapi.yaml)** - 完全なAPI仕様

### 仕様の使い方

#### Swagger UIで表示

```bash
# ローカルでSwagger UIを起動
npx swagger-ui-watcher docs/api/openapi.yaml
```

ブラウザで `http://localhost:8080` を開く

#### コード生成

```bash
# TypeScript SDK生成
npx openapi-generator-cli generate \
  -i docs/api/openapi.yaml \
  -g typescript-fetch \
  -o ./sdk/typescript

# Python SDK生成
npx openapi-generator-cli generate \
  -i docs/api/openapi.yaml \
  -g python \
  -o ./sdk/python
```

---

## クイックスタート

### 1. 基本的なOIDC認証フロー

```bash
# 1. Discovery
curl https://your-domain.com/.well-known/openid-configuration

# 2. Authorization Request
https://your-domain.com/authorize?
  response_type=code&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://yourapp.com/callback&
  scope=openid profile email&
  state=RANDOM_STATE

# 3. Token Request
curl -X POST https://your-domain.com/token \
  -u "CLIENT_ID:CLIENT_SECRET" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "redirect_uri=https://yourapp.com/callback"

# 4. UserInfo Request
curl https://your-domain.com/userinfo \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

### 2. Passkey登録フロー

```bash
# 1. Passkey登録開始
curl -X POST https://your-domain.com/auth/passkey/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "name": "John Doe"
  }'

# 2. ブラウザでWebAuthn API実行
# navigator.credentials.create()

# 3. Passkey検証
curl -X POST https://your-domain.com/auth/passkey/verify \
  -H "Content-Type: application/json" \
  -d '{
    "credential": {...}
  }'
```

### 3. Magic Link送信

```bash
curl -X POST https://your-domain.com/auth/magic-link/send \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com"
  }'
```

### 4. 管理者API - ユーザー一覧取得

```bash
curl https://your-domain.com/admin/users?q=john&limit=50 \
  -H "Authorization: Bearer ADMIN_ACCESS_TOKEN"
```

---

## SDK & ライブラリ

### 公式SDK（Phase 6で提供予定）

- **TypeScript/JavaScript SDK** - npm: `@enrai/sdk`
- **Python SDK** - PyPI: `enrai-sdk`
- **Go SDK** - `github.com/enrai/go-sdk`
- **Rust SDK** - Crates.io: `enrai-sdk`

### コミュニティSDK

- **Ruby** - `enrai-ruby` (community-maintained)
- **PHP** - `enrai-php` (community-maintained)

---

## API バージョニング

### 現在のバージョン

- **API Version**: v1.0
- **OpenAPI Version**: 3.1.0
- **OIDC Version**: 1.0
- **OAuth Version**: 2.0, 2.1

### バージョン管理ポリシー

- **メジャーバージョン変更**: 破壊的変更（例: v1 → v2）
- **マイナーバージョン変更**: 後方互換性のある新機能
- **パッチバージョン変更**: バグフィックス

### 非推奨ポリシー

1. 非推奨の告知（6ヶ月前）
2. 警告ヘッダー付きで稼働継続
3. 完全削除

```http
Deprecation: true
Sunset: Sat, 1 Jan 2026 00:00:00 GMT
Link: <https://docs.enrai.org/migration/v2>; rel="sunset"
```

---

## サポート & フィードバック

### ドキュメント

- **メインドキュメント**: [README.md](../README.md)
- **Phase 5計画**: [PHASE5_PLANNING.md](../project-management/PHASE5_PLANNING.md)
- **APIインベントリ**: [API_INVENTORY.md](../project-management/API_INVENTORY.md)
- **データベーススキーマ**: [database-schema.md](../architecture/database-schema.md)

### Issue報告

GitHub Issues: https://github.com/sgrastar/enrai/issues

### コントリビューション

Pull Requests歓迎: https://github.com/sgrastar/enrai/pulls

---

## 変更履歴

- **2025-11-13**: 初版作成（Phase 5設計）
  - OIDC Core APIs (実装済み)
  - OIDC拡張機能 (実装済み)
  - Phase 5計画API追加
  - OpenAPI 3.1仕様書追加
