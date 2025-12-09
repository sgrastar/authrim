# Authrim 破壊的変更チェックリスト

> **目的**: 本ドキュメントはAuthrimの設計決定において、変更すると破壊的影響が生じる項目を一覧化したものです。
> 新機能開発やリファクタリング時に参照し、互換性を維持してください。

---

## 1. API 命名・URL構造

**影響**: 全クライアント・SDKが破壊的変更になる

### OIDC Core エンドポイント（変更不可）

| メソッド | エンドポイント | 仕様 |
|---------|--------------|------|
| `GET` | `/.well-known/openid-configuration` | OIDC Discovery 1.0 |
| `GET` | `/.well-known/jwks.json` | RFC 7517 |
| `GET/POST` | `/authorize` | OIDC Core 3.1.2 |
| `POST` | `/token` | OIDC Core 3.1.3 |
| `GET/POST` | `/userinfo` | OIDC Core 5.3 |
| `GET` | `/logout` | OIDC RP-Initiated Logout |
| `POST` | `/logout/backchannel` | OIDC Back-Channel Logout |
| `POST` | `/introspect` | RFC 7662 |
| `POST` | `/revoke` | RFC 7009 |
| `POST` | `/register` | RFC 7591 (DCR) |

### OAuth 2.0 拡張エンドポイント

| メソッド | エンドポイント | 仕様 |
|---------|--------------|------|
| `POST` | `/as/par` | RFC 9126 (PAR) |
| `POST` | `/device_authorization` | RFC 8628 |
| `GET/POST` | `/device` | RFC 8628 |
| `POST` | `/bc-authorize` | OIDC CIBA |

### Session Management

| メソッド | エンドポイント | 仕様 |
|---------|--------------|------|
| `GET/POST` | `/session/check` | OIDC Session Management 1.0 |
| `GET/POST` | `/authorize/confirm` | Re-authentication |
| `GET/POST` | `/authorize/login` | Session-less Auth |

### 認証API（内部）

| メソッド | エンドポイント | 用途 |
|---------|--------------|------|
| `POST` | `/api/auth/passkey/register/options` | WebAuthn登録オプション |
| `POST` | `/api/auth/passkey/register/verify` | WebAuthn登録検証 |
| `POST` | `/api/auth/passkey/login/options` | WebAuthnログインオプション |
| `POST` | `/api/auth/passkey/login/verify` | WebAuthnログイン検証 |
| `POST` | `/api/auth/email-code/send` | Email OTP送信 |
| `POST` | `/api/auth/email-code/verify` | Email OTP検証 |
| `GET/POST` | `/api/auth/consent` | OAuth同意画面 |

### Admin API

| メソッド | エンドポイント | 用途 |
|---------|--------------|------|
| `GET/POST/PUT/DELETE` | `/api/admin/users/*` | ユーザー管理 |
| `GET/POST/PUT/DELETE` | `/api/admin/clients/*` | クライアント管理 |
| `GET/DELETE` | `/api/admin/sessions/*` | セッション管理 |
| `GET` | `/api/admin/audit-log/*` | 監査ログ |
| `GET/PUT` | `/api/admin/settings/*` | 設定管理 |
| `GET/POST` | `/api/admin/signing-keys/*` | 署名キー管理 |
| `ALL` | `/scim/v2/*` | SCIM 2.0 (RFC 7643/7644) |

---

## 2. ID 形式

**影響**: データ全再発行レベル

### 現在のID形式一覧

| ID種別 | 形式 | 例 | 生成ロジック |
|--------|------|-----|-------------|
| **ユーザーID** | UUID v4 | `550e8400-e29b-41d4-a716-446655440000` | `crypto.randomUUID()` |
| **クライアントID** | 長い一意識別子 (~135文字) またはカスタム | `b42bdc5e-7183-46ef-859c-fd21d4589cd6` | `generateSecureRandomString()` + Base64URL |
| **セッションID** | `{shardIndex}_session_{uuid}` | `7_session_550e8400-...` | FNV-1a hash → shard routing |
| **認可コード** | `{shardIndex}_{randomCode}` | `23_eyJhbGciOi...` | FNV-1a(userId:clientId) % shardCount |
| **Refresh Token JTI** | `v{gen}_{shard}_{randomPart}` | `v1_7_rt_550e8400-...` | SHA-256(userId:clientId) % shardCount |
| **Refresh Token JTI (レガシー)** | `rt_{uuid}` | `rt_550e8400-...` | generation=0 扱い |

### Subject (sub) クレーム

| 種別 | 形式 | 説明 |
|------|------|------|
| **public** | ユーザーID (UUID) | 全クライアント共通 |
| **pairwise** | ハッシュ値 | `hash(userId + clientId + salt)` |

### 関連ファイル

- `packages/shared/src/utils/id.ts` - ID生成
- `packages/shared/src/utils/session-helper.ts` - セッションID
- `packages/shared/src/utils/tenant-context.ts` - 認可コードシャーディング
- `packages/shared/src/utils/refresh-token-sharding.ts` - RTシャーディング
- `packages/shared/src/utils/pairwise.ts` - Pairwise Subject

---

## 3. セッションモデル

**影響**: 認証根本の作り直し

### セッション構造

```typescript
interface Session {
  id: string;           // "{shardIndex}_session_{uuid}"
  userId: string;       // ユーザーID (UUID)
  expiresAt: number;    // 有効期限（ミリ秒タイムスタンプ）
  createdAt: number;    // 作成時刻（ミリ秒タイムスタンプ）
  data?: SessionData;   // 追加メタデータ
}

interface SessionData {
  amr?: string[];       // Authentication Methods References
  acr?: string;         // Authentication Context Class Reference
  deviceName?: string;
  ipAddress?: string;
  userAgent?: string;
  [key: string]: unknown;
}
```

### ストレージアーキテクチャ（3層）

| 層 | 用途 | アクセス速度 |
|----|------|-------------|
| **メモリキャッシュ** (Hot) | SessionStore DO内 Map | サブミリ秒 |
| **Durable Storage** (Warm) | SessionStore DO永続化 | O(1) |
| **D1 Database** (Cold) | バックアップ・監査 | 100ms タイムアウト |

### シャーディング設定

| 項目 | 値 |
|------|-----|
| デフォルトシャード数 | 32 |
| DO名パターン | `tenant:default:session:shard-{index}` |
| 設定キー | `AUTHRIM_SESSION_SHARDS` (KV/環境変数) |
| クリーンアップ間隔 | 5分 |

### 関連ファイル

- `packages/shared/src/durable-objects/SessionStore.ts`

---

## 4. Refresh Token モデル

**影響**: 全ユーザー強制再ログイン

### トークン構造 (JWT)

```typescript
interface RefreshTokenClaims {
  iss: string;   // Issuer
  sub: string;   // Subject (ユーザーID)
  aud: string;   // Audience (クライアントID)
  exp: number;   // Expiration Time
  iat: number;   // Issued At
  jti: string;   // JWT ID (一意識別子)
  rtv: number;   // Refresh Token Version (ローテーション世代)
}
```

### Token Family 構造

```typescript
interface TokenFamilyV2 {
  version: number;        // ローテーション世代（単調増加）
  last_jti: string;       // 最後に発行されたJWT ID
  last_used_at: number;   // 最後の使用時刻（ミリ秒）
  expires_at: number;     // 絶対有効期限（ミリ秒）
  user_id: string;        // ユーザーID
  client_id: string;      // クライアントID
  allowed_scope: string;  // 初期スコープ（拡大防止）
}
```

### ローテーション戦略 (Version-Based Theft Detection)

| イベント | 動作 |
|---------|------|
| `incomingVersion < currentVersion` | **盗難検出** → Family全体失効 |
| `incomingVersion == currentVersion` かつ `jti一致` | 新バージョン発行 |
| `jti不一致` | **改ざん検出** → Family全体失効 |
| スコープ拡大リクエスト | **拒否** (invalid_scope) |

### シャーディング

| 項目 | 値 |
|------|-----|
| デフォルトシャード数 | 8 |
| JTI形式 (新) | `v{generation}_{shardIndex}_{randomPart}` |
| JTI形式 (レガシー) | `rt_{uuid}` (generation=0) |
| DO名パターン | `tenant:default:refresh-rotator:{clientId}:v{gen}:shard-{index}` |

### 関連ファイル

- `packages/shared/src/durable-objects/RefreshTokenRotator.ts`
- `packages/shared/src/utils/refresh-token-sharding.ts`
- `packages/shared/src/utils/jwt.ts`

---

## 5. OIDC クレーム構造

**影響**: 全RPが動かなくなる

### ID Token クレーム

#### 必須クレーム (OIDC Core)

| クレーム | 型 | 説明 |
|---------|-----|------|
| `iss` | string | Issuer URL |
| `sub` | string | Subject (ユーザー識別子) |
| `aud` | string | Audience (client_id) |
| `exp` | number | 有効期限 (UNIX秒) |
| `iat` | number | 発行時刻 (UNIX秒) |

#### 認証コンテキストクレーム

| クレーム | 型 | 説明 |
|---------|-----|------|
| `auth_time` | number | 認証実行時刻 |
| `nonce` | string | リプレイ攻撃防止 |
| `acr` | string | Authentication Context Class Reference |
| `amr` | string[] | Authentication Methods References |
| `azp` | string | Authorized Party |

#### トークンハッシュ

| クレーム | 用途 |
|---------|------|
| `at_hash` | Access Token Hash (code flow) |
| `c_hash` | Code Hash (hybrid flow) |

#### セッション管理

| クレーム | 用途 |
|---------|------|
| `sid` | Session ID (RP-Initiated Logout用) |

#### RBAC クレーム (Authrim拡張)

| クレーム | 型 | 説明 |
|---------|-----|------|
| `authrim_roles` | string[] | 有効なロール |
| `authrim_user_type` | string | ユーザータイプ |
| `authrim_org_id` | string | プライマリ組織ID |
| `authrim_plan` | string | 組織プラン |
| `authrim_org_type` | string | 組織タイプ |

### スコープベースクレーム (UserInfo)

| スコープ | クレーム |
|---------|---------|
| `profile` | name, family_name, given_name, middle_name, nickname, preferred_username, profile, picture, website, gender, birthdate, zoneinfo, locale, updated_at |
| `email` | email, email_verified |
| `phone` | phone_number, phone_number_verified |
| `address` | address (nested object) |

### Access Token クレーム

| クレーム | 型 | 説明 |
|---------|-----|------|
| `iss` | string | Issuer |
| `sub` | string | Subject |
| `aud` | string | Audience (リソースサーバー) |
| `exp` | number | 有効期限 |
| `iat` | number | 発行時刻 |
| `jti` | string | JWT ID (失効管理用) |
| `scope` | string | 付与されたスコープ |
| `client_id` | string | クライアントID |
| `cnf` | object | DPoP確認 (`{ jkt: string }`) |
| `authrim_permissions` | string[] | Phase 2 Policy Embedding |

### 関連ファイル

- `packages/shared/src/types/oidc.ts`
- `packages/shared/src/utils/jwt.ts`
- `packages/op-token/src/token.ts`
- `packages/op-userinfo/src/userinfo.ts`

---

## 6. データモデル

**影響**: マイグレーション地獄

### コアエンティティ

#### users テーブル

| カラム | 型 | 説明 |
|--------|-----|------|
| `id` | TEXT PRIMARY KEY | UUID v4 |
| `email` | TEXT UNIQUE | メールアドレス |
| `email_verified` | INTEGER | 検証済みフラグ |
| `password_hash` | TEXT | パスワードハッシュ |
| `name`, `given_name`, `family_name` | TEXT | OIDC標準クレーム |
| `nickname`, `profile`, `picture` | TEXT | OIDC標準クレーム |
| `created_at`, `updated_at` | INTEGER | UNIX秒 |

#### oauth_clients テーブル

| カラム | 型 | 説明 |
|--------|-----|------|
| `client_id` | TEXT PRIMARY KEY | クライアントID |
| `client_secret` | TEXT | クライアントシークレット |
| `redirect_uris` | TEXT | JSON配列 |
| `grant_types` | TEXT | JSON配列 |
| `response_types` | TEXT | JSON配列 |
| `token_endpoint_auth_method` | TEXT | 認証方式 |
| `subject_type` | TEXT | public/pairwise |

#### sessions テーブル

| カラム | 型 | 説明 |
|--------|-----|------|
| `id` | TEXT PRIMARY KEY | セッションID |
| `user_id` | TEXT | ユーザーID (FK) |
| `expires_at` | INTEGER | 有効期限 (UNIX秒) |
| `created_at` | INTEGER | 作成時刻 (UNIX秒) |

### RBAC Phase 1 エンティティ

#### organizations テーブル

| カラム | 型 | 説明 |
|--------|-----|------|
| `id` | TEXT PRIMARY KEY | 組織ID |
| `tenant_id` | TEXT | テナントID |
| `name` | TEXT | 組織名 |
| `org_type` | TEXT | distributor/enterprise/department |
| `parent_org_id` | TEXT | 親組織ID (階層構造) |
| `plan` | TEXT | free/starter/professional/enterprise |
| `is_active` | INTEGER | アクティブフラグ |

#### roles テーブル

| カラム | 型 | 説明 |
|--------|-----|------|
| `id` | TEXT PRIMARY KEY | ロールID |
| `name` | TEXT | ロール名 |
| `permissions_json` | TEXT | 権限JSON配列 |
| `role_type` | TEXT | system/builtin/custom |
| `hierarchy_level` | INTEGER | 0-100 (高いほど特権) |
| `parent_role_id` | TEXT | 親ロールID (継承) |

#### role_assignments テーブル

| カラム | 型 | 説明 |
|--------|-----|------|
| `id` | TEXT PRIMARY KEY | 割当ID |
| `subject_id` | TEXT | ユーザーID |
| `role_id` | TEXT | ロールID |
| `scope_type` | TEXT | global/org/resource |
| `scope_target` | TEXT | スコープ対象 |
| `expires_at` | INTEGER | 有効期限 (オプション) |

### 関連ファイル

- `migrations/001_initial_schema.sql` - 初期スキーマ
- `migrations/009-012_rbac_phase1_*.sql` - RBAC Phase 1

---

## 7. /authorize & /token の構造

**影響**: OIDC的に変更不可能

### /authorize パラメータ

#### 必須パラメータ

| パラメータ | 説明 |
|-----------|------|
| `response_type` | `code`, `id_token`, `token`, `code id_token`, etc. |
| `client_id` | 登録済みクライアントID |
| `redirect_uri` | 登録済みリダイレクトURI |
| `scope` | `openid` 必須 + 追加スコープ |

#### 推奨/任意パラメータ

| パラメータ | 説明 |
|-----------|------|
| `state` | CSRF保護 |
| `nonce` | ID Token binding |
| `code_challenge` | PKCE (S256) |
| `code_challenge_method` | `S256` のみ |
| `prompt` | `login`, `consent`, `select_account`, `none` |
| `max_age` | 最大認証経過時間 |
| `claims` | クレームリクエスト (JSON) |
| `response_mode` | `query`, `fragment`, `form_post`, `query.jwt` |
| `request` | JAR (RFC 9101) |
| `request_uri` | PAR (RFC 9126) |

### /authorize レスポンス

| response_mode | 形式 |
|---------------|------|
| `query` | `?code=...&state=...&iss=...` |
| `fragment` | `#access_token=...&id_token=...&state=...` |
| `form_post` | HTML form auto-submit |
| `*.jwt` (JARM) | `?response=eyJ...` |

### /token Grant Types

| Grant Type | 仕様 |
|------------|------|
| `authorization_code` | RFC 6749 §4.1 |
| `refresh_token` | RFC 6749 §6 |
| `urn:ietf:params:oauth:grant-type:jwt-bearer` | RFC 7523 |
| `urn:ietf:params:oauth:grant-type:device_code` | RFC 8628 |
| `urn:openid:params:grant-type:ciba` | OIDC CIBA |

### /token レスポンス

```json
{
  "access_token": "2YotnFZFEjr1zCsicMWpAA",
  "token_type": "Bearer",
  "expires_in": 3600,
  "id_token": "eyJhbGciOiJSUzI1NiIs...",
  "refresh_token": "tGzv3JOkF0XG5Qx2TlKWIQ",
  "scope": "openid profile email",
  "iss": "https://provider.example.com"
}
```

### クライアント認証方式

| 方式 | 説明 |
|------|------|
| `client_secret_basic` | HTTP Basic Auth |
| `client_secret_post` | Form parameter |
| `client_secret_jwt` | JWT Bearer (symmetric) |
| `private_key_jwt` | JWT Bearer (asymmetric) |
| `none` | Public clients |

### 関連ファイル

- `packages/op-auth/src/authorize.ts`
- `packages/op-token/src/token.ts`

---

## 8. RBAC/ABAC 評価順序

**影響**: 許可/拒否結果が変わり炎上

### 評価フロー

```
1. Authentication 確認
   └─ 失敗 → 401 Unauthorized

2. ロールメンバーシップ確認
   └─ requireRole(role) → 単一ロール必須
   └─ requireAnyRole([roles]) → いずれか必須 (OR)
   └─ requireAllRoles([roles]) → 全て必須 (AND)
   └─ requireAdmin() → system_admin|distributor_admin|org_admin|admin
   └─ requireSystemAdmin() → system_admin のみ

3. アクセス判定
   └─ 許可 → 処理続行
   └─ 拒否 → 403 Forbidden
```

### デフォルトロール階層

| ロール | hierarchy_level | 説明 |
|--------|-----------------|------|
| `system_admin` | 100 | 最高権限 |
| `distributor_admin` | 50 | ディストリビューター管理者 |
| `org_admin` | 30 | 組織管理者 |
| `end_user` | 0 | 一般ユーザー |

### RBAC クレーム解決順序

```
1. キャッシュ確認 (KV RBAC_CACHE - TTL 5分)
2. キャッシュミス時:
   a. resolveEffectiveRoles (DB)
   b. resolveOrganizationInfo (DB)
   c. resolveUserType (DB)
   d. resolveScopedRoles (Phase 2)
   e. resolveAllOrganizations (Phase 2)
   f. resolveRelationshipsSummary (Phase 2)
3. 環境変数 RBAC_ID_TOKEN_CLAIMS でフィルタリング
4. キャッシュに保存 (Fire-and-forget)
```

### 関連ファイル

- `packages/shared/src/middleware/rbac.ts`
- `packages/shared/src/utils/rbac-claims.ts`
- `packages/shared/src/types/rbac.ts`

---

## 9. Audit Log スキーマ

**影響**: 過去ログ読めなくなる

### テーブル構造

```sql
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
```

### 型定義

```typescript
interface AuditLogEntry {
  id: string;
  tenantId: string;
  userId: string;
  action: string;           // e.g., 'signing_keys.rotate.emergency'
  resource: string;         // e.g., 'signing_keys'
  resourceId: string;
  ipAddress: string;
  userAgent: string;
  metadata: string;         // JSON文字列
  severity: 'info' | 'warning' | 'critical';
  createdAt: number;        // UNIXミリ秒
}
```

### アクション命名規則

```
{resource}.{action}.{detail}

例:
- signing_keys.rotate.emergency
- signing_keys.rotate.normal
- signing_keys.revoke
- user.create
- user.update
- user.delete
- client.create
- session.revoke
```

### インデックス

| インデックス | カラム |
|-------------|--------|
| `idx_audit_log_user_id` | user_id |
| `idx_audit_log_created_at` | created_at |
| `idx_audit_log_action` | action |
| `idx_audit_log_resource` | resource_type, resource_id |

### 関連ファイル

- `migrations/001_initial_schema.sql`
- `packages/shared/src/utils/audit-log.ts`
- `packages/shared/src/types/admin.ts`

---

## 10. エラーコード体系

**影響**: SDKが壊れる

### OAuth 2.0 標準エラー (RFC 6749)

| エラーコード | HTTP | 説明 |
|-------------|------|------|
| `invalid_request` | 400 | パラメータ不正 |
| `invalid_client` | 401 | クライアント認証失敗 |
| `invalid_grant` | 400 | 認可グラント無効 |
| `unauthorized_client` | 400 | クライアント権限なし |
| `unsupported_grant_type` | 400 | 未サポートGrant Type |
| `invalid_scope` | 400 | スコープ無効 |
| `access_denied` | 403 | アクセス拒否 |
| `unsupported_response_type` | 400 | 未サポートResponse Type |
| `server_error` | 500 | サーバーエラー |
| `temporarily_unavailable` | 503 | 一時的に利用不可 |

### OIDC 固有エラー

| エラーコード | 説明 |
|-------------|------|
| `interaction_required` | ユーザー操作必要 |
| `login_required` | ログイン必要 |
| `account_selection_required` | アカウント選択必要 |
| `consent_required` | 同意必要 |
| `invalid_request_uri` | request_uri無効 |
| `invalid_request_object` | Request Object無効 |
| `request_not_supported` | request未サポート |
| `request_uri_not_supported` | request_uri未サポート |
| `registration_not_supported` | 登録未サポート |

### Resource Server エラー

| エラーコード | HTTP | 説明 |
|-------------|------|------|
| `invalid_token` | 401 | トークン無効 |
| `insufficient_scope` | 403 | スコープ不足 |

### エラーレスポンス形式

```json
{
  "error": "invalid_request",
  "error_description": "The request is missing a required parameter",
  "error_uri": "https://example.com/errors/invalid_request"
}
```

### RBAC エラー拡張

```json
{
  "error": "access_denied",
  "error_description": "Missing required roles: system_admin",
  "required_roles": ["system_admin", "org_admin"],
  "missing_roles": ["system_admin"]
}
```

### 関連ファイル

- `packages/shared/src/constants.ts` - エラーコード定義
- `packages/shared/src/utils/errors.ts` - OIDCError クラス

---

## 変更時の影響度マトリクス

| 項目 | 影響度 | 影響範囲 | 移行難易度 |
|------|--------|---------|-----------|
| API URL構造 | 🔴 Critical | 全クライアント/SDK | 高 |
| ID形式 | 🔴 Critical | 全データ再発行 | 最高 |
| セッションモデル | 🔴 Critical | 認証基盤 | 高 |
| Refresh Token | 🔴 Critical | 全ユーザー再ログイン | 高 |
| OIDCクレーム | 🔴 Critical | 全RP | 高 |
| データモデル | 🟠 High | マイグレーション必須 | 中〜高 |
| /authorize /token | 🔴 Critical | OIDC仕様準拠 | 変更不可 |
| RBAC評価順序 | 🟠 High | 権限判定結果 | 中 |
| Audit Log | 🟡 Medium | 過去ログ互換性 | 中 |
| エラーコード | 🟠 High | SDK/クライアント | 中 |

---

## 変更前チェックリスト

変更を行う前に以下を確認してください：

- [ ] 本ドキュメントの該当項目を確認した
- [ ] 破壊的変更の場合、移行計画を策定した
- [ ] 影響を受けるクライアント/SDKをリストアップした
- [ ] 後方互換性を維持する代替案を検討した
- [ ] OIDC/OAuth 2.0仕様への準拠を確認した
- [ ] テスト環境で影響範囲を検証した
- [ ] ドキュメント更新計画を作成した

---

*最終更新: 2025-12-09*
