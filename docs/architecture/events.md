# Event Catalog

Authrim のイベント体系を定義するドキュメント。
Webhook、Auth Flow Designer、カスタムスクリプト実行基盤の設計指針として使用。

> **Note**: このドキュメントは実際のコードを確認して作成されています。
> Authrim はパスワードレス認証を採用しており、パスワード関連機能は存在しません。

## Overview

### Authrim の認証方法

| 方法 | 説明 |
|------|------|
| **Passkey** (WebAuthn) | Discoverable Credentials によるパスワードレス認証 |
| **メールコード** (OTP) | メールアドレスに送信されるワンタイムコード |
| **外部 IdP** | Google, GitHub, Microsoft, Apple, Facebook, LinkedIn, Twitter 等 |

### Authrim の主要機能

| 機能 | 説明 |
|------|------|
| **OAuth 2.0 / OIDC** | Authorization Code, PAR, PKCE |
| **CIBA** | Client Initiated Backchannel Authentication |
| **Device Code** | Device Authorization Grant (TV/IoT向け) |
| **SAML** | IdP および SP として動作 |
| **SCIM** | ユーザー/グループのプロビジョニング |
| **ReBAC** | Relationship-Based Access Control |
| **VC/DID** | Verifiable Credentials (Phase 9) |

---

## Event Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         Event Source                            │
│  (認証フロー、管理操作、システムイベント)                          │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Event Dispatcher                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ Pre-hooks   │  │ Core Logic  │  │ Post-hooks              │ │
│  │ (同期)      │  │             │  │ (同期/非同期)            │ │
│  │             │  │             │  │                         │ │
│  │ ・検証      │  │ ・処理実行  │  │ ・監査ログ              │ │
│  │ ・変換      │  │             │  │ ・Webhook送信           │ │
│  │ ・中断可能  │  │             │  │ ・カスタムスクリプト     │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Event Naming Convention

### 形式

```
{domain}.{resource}.{action}[.{modifier}]
```

### 例

| イベント名 | 説明 |
|-----------|------|
| `auth.passkey.login.succeeded` | Passkey ログイン成功 |
| `auth.email_code.verified` | メールコード検証成功 |
| `oauth.consent.granted` | OAuth 同意付与 |
| `admin.client.created` | 管理者によるクライアント作成 |

---

## Event Categories

### 1. Authentication Events (`auth.*`)

認証フローに関するイベント。Auth Flow Designer でフック可能。

#### 1.1 Passkey (WebAuthn) 認証

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `auth.passkey.login.started` | Pre | ❌ | ✅ | ❌ | Passkey ログイン開始 |
| `auth.passkey.login.challenge_created` | Pre | ❌ | ❌ | ❌ | WebAuthn チャレンジ生成 |
| `auth.passkey.login.succeeded` | Post | ❌ | ✅ | ✅ | Passkey ログイン成功 |
| `auth.passkey.login.failed` | Post | ❌ | ❌ | ✅ | Passkey ログイン失敗 |
| `auth.passkey.register.started` | Pre | ✅ | ✅ | ❌ | Passkey 登録開始（メール+名前入力）|
| `auth.passkey.register.succeeded` | Post | ✅ | ✅ | ✅ | Passkey 登録成功 |
| `auth.passkey.register.failed` | Post | ✅ | ❌ | ✅ | Passkey 登録失敗 |

#### 1.2 メールコード (OTP) 認証

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `auth.email_code.requested` | Pre | ✅ | ✅ | ❌ | メールコード送信要求 |
| `auth.email_code.sent` | Post | ✅ | ❌ | ❌ | メールコード送信完了 |
| `auth.email_code.verified` | Post | ✅ | ✅ | ✅ | メールコード検証成功（ログイン/サインアップ完了）|
| `auth.email_code.failed` | Post | ✅ | ❌ | ✅ | メールコード検証失敗 |
| `auth.email_code.expired` | Post | ✅ | ❌ | ❌ | メールコード期限切れ |

#### 1.3 外部 IdP 認証

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `auth.external_idp.started` | Pre | ❌ | ✅ | ❌ | 外部 IdP 認証開始（リダイレクト前）|
| `auth.external_idp.callback_received` | Pre | ✅ | ❌ | ❌ | コールバック受信 |
| `auth.external_idp.succeeded` | Post | ✅ | ✅ | ✅ | 外部 IdP 認証成功 |
| `auth.external_idp.failed` | Post | ❌ | ❌ | ✅ | 外部 IdP 認証失敗 |
| `auth.external_idp.linked` | Post | ✅ | ✅ | ✅ | アカウント連携成功 |
| `auth.external_idp.unlinked` | Post | ❌ | ❌ | ✅ | アカウント連携解除 |
| `auth.external_idp.jit_provisioned` | Post | ✅ | ✅ | ✅ | JIT プロビジョニング（新規ユーザー作成）|

#### 1.4 ログイン・ログアウト（共通）

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `auth.login.succeeded` | Post | ✅ | ✅ | ✅ | ログイン成功（全認証方法共通）|
| `auth.login.failed` | Post | ✅ | ✅ | ✅ | ログイン失敗（全認証方法共通）|
| `auth.logout.initiated` | Pre | ❌ | ✅ | ❌ | ログアウト開始（RP-Initiated）|
| `auth.logout.succeeded` | Post | ❌ | ❌ | ✅ | ログアウト完了 |
| `auth.logout.backchannel_sent` | Post | ❌ | ❌ | ✅ | Back-Channel Logout 送信 |
| `auth.logout.frontchannel_rendered` | Post | ❌ | ❌ | ❌ | Front-Channel Logout iframe 描画 |

#### 1.5 再認証 (Step-up Auth)

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `auth.reauth.required` | Pre | ❌ | ✅ | ❌ | 再認証要求（max_age 超過等）|
| `auth.reauth.succeeded` | Post | ❌ | ❌ | ❌ | 再認証成功 |
| `auth.reauth.failed` | Post | ❌ | ❌ | ✅ | 再認証失敗 |

---

### 2. OAuth/OIDC Events (`oauth.*`)

OAuth 2.0 / OpenID Connect フローに関するイベント。

#### 2.1 Authorization

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `oauth.authorize.started` | Pre | ❌ | ❌ | ❌ | 認可リクエスト受信 |
| `oauth.authorize.validated` | Pre | ❌ | ❌ | ❌ | パラメータ検証完了 |
| `oauth.authorize.code_issued` | Post | ❌ | ❌ | ❌ | 認可コード発行 |
| `oauth.authorize.failed` | Post | ❌ | ❌ | ❌ | 認可失敗 |

#### 2.2 PAR (Pushed Authorization Request)

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `oauth.par.created` | Post | ❌ | ❌ | ❌ | PAR リクエスト作成 |
| `oauth.par.consumed` | Post | ❌ | ❌ | ❌ | PAR リクエスト消費 |
| `oauth.par.expired` | Post | ❌ | ❌ | ❌ | PAR リクエスト期限切れ |

#### 2.3 Consent（同意）

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `oauth.consent.shown` | Pre | ❌ | ✅ | ❌ | 同意画面表示 |
| `oauth.consent.granted` | Post | ❌ | ✅ | ✅ | 同意付与 |
| `oauth.consent.denied` | Post | ❌ | ❌ | ❌ | 同意拒否 |
| `oauth.consent.revoked` | Post | ❌ | ❌ | ✅ | 同意取り消し |

---

### 3. CIBA Events (`ciba.*`)

Client Initiated Backchannel Authentication に関するイベント。

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `ciba.auth.requested` | Pre | ✅ | ❌ | ❌ | CIBA 認証リクエスト受信 |
| `ciba.auth.pending` | Post | ❌ | ❌ | ❌ | ユーザー承認待ち |
| `ciba.auth.approved` | Post | ✅ | ❌ | ✅ | ユーザー承認 |
| `ciba.auth.denied` | Post | ✅ | ❌ | ✅ | ユーザー拒否 |
| `ciba.auth.expired` | Post | ❌ | ❌ | ❌ | タイムアウト |
| `ciba.ping.sent` | Post | ❌ | ❌ | ❌ | Ping 通知送信 |
| `ciba.push.sent` | Post | ❌ | ❌ | ❌ | Push 通知送信 |

---

### 4. Device Code Events (`device.*`)

Device Authorization Grant に関するイベント。

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `device.code.created` | Post | ❌ | ❌ | ❌ | デバイスコード発行 |
| `device.code.verified` | Post | ✅ | ❌ | ❌ | ユーザーコード入力 |
| `device.auth.approved` | Post | ✅ | ❌ | ✅ | ユーザー承認 |
| `device.auth.denied` | Post | ✅ | ❌ | ✅ | ユーザー拒否 |
| `device.code.expired` | Post | ❌ | ❌ | ❌ | デバイスコード期限切れ |
| `device.token.issued` | Post | ❌ | ❌ | ❌ | トークン発行 |

---

### 5. Session Events (`session.*`)

セッションライフサイクルに関するイベント。

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `session.created` | Post | ❌ | ❌ | ❌ | セッション作成 |
| `session.extended` | Post | ❌ | ❌ | ❌ | セッション延長 |
| `session.expired` | Post | ❌ | ❌ | ❌ | セッション期限切れ（自動）|
| `session.revoked` | Post | ❌ | ❌ | ✅ | セッション失効（手動）|
| `session.revoked.logout` | Post | ❌ | ❌ | ✅ | ログアウトによる失効 |
| `session.revoked.admin` | Post | ❌ | ❌ | ✅ | 管理者による失効 |
| `session.revoked.security` | Post | ❌ | ❌ | ✅ | セキュリティ上の理由による失効 |

---

### 6. Token Events (`token.*`)

トークン発行・失効に関するイベント。

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `token.access.issued` | Post | ❌ | ❌ | ❌ | Access Token 発行 |
| `token.refresh.issued` | Post | ❌ | ❌ | ❌ | Refresh Token 発行 |
| `token.refresh.rotated` | Post | ❌ | ❌ | ❌ | Refresh Token ローテーション |
| `token.revoked` | Post | ❌ | ❌ | ✅ | トークン失効 |
| `token.introspected` | Post | ❌ | ❌ | ❌ | トークン検証（Introspection）|

---

### 7. User Events (`user.*`)

ユーザーライフサイクル・プロフィールに関するイベント。

> **Note**: パスワードレス認証のため、パスワード関連イベントは存在しない。

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `user.created` | Post | ✅ | ✅ | ✅ | ユーザー作成 |
| `user.updated` | Post | ✅ | ❌ | ✅ | ユーザー情報更新 |
| `user.deleted` | Post | ❌ | ❌ | ✅ | ユーザー削除（PII削除、UUID残存）|
| `user.suspended` | Post | ❌ | ❌ | ✅ | ユーザー停止 |
| `user.reactivated` | Post | ❌ | ❌ | ✅ | ユーザー再有効化 |
| `user.email.changed` | Post | ✅ | ✅ | ✅ | メールアドレス変更 |
| `user.email.verified` | Post | ✅ | ❌ | ✅ | メール確認完了 |
| `user.passkey.registered` | Post | ❌ | ❌ | ✅ | Passkey 登録 |
| `user.passkey.removed` | Post | ❌ | ❌ | ✅ | Passkey 削除 |
| `user.passkey.renamed` | Post | ❌ | ❌ | ❌ | Passkey 名前変更 |

---

### 8. Permission Events (`permission.*`)

認可・権限（ReBAC）に関するイベント。

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `permission.granted` | Post | ❌ | ❌ | ✅ | 権限付与 |
| `permission.revoked` | Post | ❌ | ❌ | ✅ | 権限剥奪 |
| `permission.checked` | Post | ❌ | ❌ | ❌ | 権限チェック実行 |
| `permission.changed` | Post | ❌ | ❌ | ✅ | 権限変更通知（リアルタイム）|
| `role.assigned` | Post | ❌ | ❌ | ✅ | ロール割り当て |
| `role.removed` | Post | ❌ | ❌ | ✅ | ロール削除 |

---

### 9. SAML Events (`saml.*`)

SAML IdP/SP に関するイベント。

#### 9.1 SAML IdP（Authrim が IdP として動作）

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `saml.idp.authn_request_received` | Pre | ❌ | ❌ | ❌ | AuthnRequest 受信 |
| `saml.idp.response_sent` | Post | ✅ | ❌ | ❌ | SAML Response 送信 |
| `saml.idp.logout_request_received` | Pre | ❌ | ❌ | ❌ | SLO Request 受信 |
| `saml.idp.logout_response_sent` | Post | ❌ | ❌ | ❌ | SLO Response 送信 |

#### 9.2 SAML SP（Authrim が SP として動作）

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `saml.sp.authn_request_sent` | Pre | ❌ | ❌ | ❌ | AuthnRequest 送信 |
| `saml.sp.response_received` | Post | ✅ | ✅ | ✅ | SAML Response 受信・検証 |
| `saml.sp.assertion_validated` | Post | ✅ | ❌ | ❌ | Assertion 検証成功 |
| `saml.sp.login_succeeded` | Post | ✅ | ✅ | ✅ | SAML ログイン成功 |
| `saml.sp.login_failed` | Post | ❌ | ❌ | ✅ | SAML ログイン失敗 |

---

### 10. SCIM Events (`scim.*`)

SCIM プロビジョニングに関するイベント。

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `scim.user.created` | Post | ✅ | ❌ | ✅ | SCIM ユーザー作成 |
| `scim.user.updated` | Post | ✅ | ❌ | ✅ | SCIM ユーザー更新 |
| `scim.user.deleted` | Post | ❌ | ❌ | ✅ | SCIM ユーザー削除 |
| `scim.group.created` | Post | ❌ | ❌ | ✅ | SCIM グループ作成 |
| `scim.group.updated` | Post | ❌ | ❌ | ✅ | SCIM グループ更新 |
| `scim.group.deleted` | Post | ❌ | ❌ | ✅ | SCIM グループ削除 |
| `scim.bulk.completed` | Post | ❌ | ❌ | ✅ | SCIM バルク操作完了 |

---

### 11. Admin Events (`admin.*`)

管理者操作に関するイベント（監査ログ対象）。

#### 11.1 クライアント管理

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `admin.client.created` | Post | ❌ | ❌ | ✅ | クライアント作成 |
| `admin.client.updated` | Post | ❌ | ❌ | ✅ | クライアント更新 |
| `admin.client.deleted` | Post | ❌ | ❌ | ✅ | クライアント削除 |
| `admin.client.secret_rotated` | Post | ❌ | ❌ | ✅ | シークレットローテーション |

#### 11.2 ユーザー管理

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `admin.user.created` | Post | ✅ | ❌ | ✅ | 管理者によるユーザー作成 |
| `admin.user.updated` | Post | ✅ | ❌ | ✅ | 管理者によるユーザー更新 |
| `admin.user.deleted` | Post | ❌ | ❌ | ✅ | 管理者によるユーザー削除 |
| `admin.user.suspended` | Post | ❌ | ❌ | ✅ | 管理者によるユーザー停止 |
| `admin.session.revoked` | Post | ❌ | ❌ | ✅ | 管理者によるセッション失効 |

#### 11.3 鍵管理

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `admin.signing_key.rotated` | Post | ❌ | ❌ | ✅ | 署名鍵ローテーション |
| `admin.signing_key.rotated.emergency` | Post | ❌ | ❌ | ✅ | 緊急鍵ローテーション |
| `admin.encryption_key.rotated` | Post | ❌ | ❌ | ✅ | 暗号化鍵ローテーション |

#### 11.4 設定変更

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `admin.settings.updated` | Post | ❌ | ❌ | ✅ | システム設定変更 |
| `admin.idp.created` | Post | ❌ | ❌ | ✅ | 外部 IdP 設定追加 |
| `admin.idp.updated` | Post | ❌ | ❌ | ✅ | 外部 IdP 設定更新 |
| `admin.idp.deleted` | Post | ❌ | ❌ | ✅ | 外部 IdP 設定削除 |

---

### 12. Security Events (`security.*`)

セキュリティ関連イベント（SIEM 連携対象）。

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `security.brute_force.detected` | Post | ✅ | ❌ | ✅ | ブルートフォース検知 |
| `security.account.locked` | Post | ✅ | ❌ | ✅ | アカウントロック |
| `security.account.unlocked` | Post | ❌ | ❌ | ✅ | アカウントロック解除 |
| `security.suspicious_login` | Post | ✅ | ❌ | ✅ | 不審なログイン検知 |
| `security.rate_limit.exceeded` | Post | ✅ | ❌ | ✅ | レート制限超過 |
| `security.replay_attack.detected` | Post | ❌ | ❌ | ✅ | リプレイ攻撃検知 |
| `security.token.replay_detected` | Post | ❌ | ❌ | ✅ | 認可コード再利用検知 |

---

### 13. VC/DID Events (`vc.*`) - Phase 9

Verifiable Credentials に関するイベント（開発中）。

#### 13.1 Credential Issuance

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `vc.credential.requested` | Pre | ✅ | ❌ | ❌ | Credential 発行リクエスト |
| `vc.credential.issued` | Post | ✅ | ❌ | ✅ | Credential 発行完了 |
| `vc.credential.revoked` | Post | ❌ | ❌ | ✅ | Credential 失効 |

#### 13.2 Presentation

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `vc.presentation.requested` | Pre | ❌ | ❌ | ❌ | Presentation リクエスト |
| `vc.presentation.verified` | Post | ✅ | ❌ | ✅ | Presentation 検証成功 |
| `vc.presentation.failed` | Post | ❌ | ❌ | ✅ | Presentation 検証失敗 |

---

### 14. System Events (`system.*`)

システムイベント（内部用）。

| Event | Phase | PII | Hookable | Webhook | Description |
|-------|-------|-----|----------|---------|-------------|
| `system.startup` | Post | ❌ | ❌ | ❌ | システム起動 |
| `system.config.reloaded` | Post | ❌ | ❌ | ❌ | 設定リロード |
| `system.key.rotated` | Post | ❌ | ❌ | ❌ | 内部鍵自動ローテーション |
| `system.cleanup.completed` | Post | ❌ | ❌ | ❌ | クリーンアップ完了 |
| `system.do.evicted` | Post | ❌ | ❌ | ❌ | Durable Object eviction |

---

## Event Payload Structure

### Base Payload

```typescript
interface BaseEventPayload {
  // メタデータ
  eventId: string;           // UUID v4
  eventName: string;         // e.g., "auth.passkey.login.succeeded"
  timestamp: number;         // Unix timestamp (ms)
  tenantId: string;          // テナントID

  // コンテキスト
  context: {
    requestId?: string;      // リクエストID
    sessionId?: string;      // セッションID（あれば）
    clientId?: string;       // OAuthクライアントID（あれば）
    ipAddress?: string;      // IPアドレス
    userAgent?: string;      // User-Agent
    geoLocation?: {          // 地理情報（あれば）
      country?: string;
      region?: string;
      city?: string;
    };
  };

  // アクター（誰が）
  actor?: {
    type: 'user' | 'admin' | 'system' | 'client' | 'scim';
    id: string;              // UUID
    // PII は含めない（必要なら PII DB を参照）
  };

  // 対象（何に対して）
  target?: {
    type: string;            // e.g., "user", "session", "client"
    id: string;              // UUID
  };

  // イベント固有データ
  data: Record<string, unknown>;
}
```

### Example: auth.passkey.login.succeeded

```json
{
  "eventId": "evt_abc123",
  "eventName": "auth.passkey.login.succeeded",
  "timestamp": 1703119856000,
  "tenantId": "default",
  "context": {
    "requestId": "req_xyz789",
    "sessionId": "ses_def456",
    "clientId": "my-app",
    "ipAddress": "203.0.113.1",
    "userAgent": "Mozilla/5.0...",
    "geoLocation": {
      "country": "JP",
      "region": "Tokyo"
    }
  },
  "actor": {
    "type": "user",
    "id": "usr_abc123"
  },
  "data": {
    "credentialId": "cred_xyz",
    "deviceName": "MacBook Pro",
    "isDiscoverableCredential": true
  }
}
```

---

## Audit Log vs Event Log

### 違い

| 観点 | Audit Log | Event Log |
|------|-----------|-----------|
| **目的** | コンプライアンス・法的証拠 | システム連携・自動化 |
| **保持期間** | 長期（90日〜永久） | 短期〜中期 |
| **PII** | 最小限（UUID のみ） | 含む場合あり（暗号化） |
| **変更可能性** | 不変（Append-only） | 削除可能 |
| **送信先** | D1 (Core DB) | Webhook、Queue |

### PII 分離の原則

```
ユーザー削除時:

1. PII DB から個人情報を削除
   - users_pii.email → 削除
   - users_pii.name → 削除

2. Core DB のユーザーレコードは Tombstone 化
   - users.id → 維持
   - users.status → 'deleted'
   - users.deleted_at → 削除日時

3. 監査ログは保持（PII なし）
   - audit_log.action → 'user.deleted'
   - audit_log.target_id → UUID（残す）
   - audit_log.metadata → PII 除去済み
```

---

## Implementation Status

| Category | Events Defined | Audit Log | Webhook | Hooks |
|----------|----------------|-----------|---------|-------|
| `auth.passkey.*` | ✅ | ❌ | ❌ | ❌ |
| `auth.email_code.*` | ✅ | ❌ | ❌ | ❌ |
| `auth.external_idp.*` | ✅ | △ 部分的 | ❌ | ❌ |
| `auth.logout.*` | ✅ | ❌ | ✅ (Back-Channel) | ❌ |
| `oauth.*` | ✅ | ❌ | ❌ | ❌ |
| `ciba.*` | ✅ | ❌ | ❌ | ❌ |
| `device.*` | ✅ | ❌ | ❌ | ❌ |
| `session.*` | ✅ | △ 部分的 | ✅ (Back-Channel) | ❌ |
| `token.*` | ✅ | ❌ | ❌ | ❌ |
| `user.*` | ✅ | △ 部分的 | ❌ | ❌ |
| `permission.*` | ✅ | ❌ | ❌ (Notifier あり) | ❌ |
| `saml.*` | ✅ | ❌ | ❌ | ❌ |
| `scim.*` | ✅ | ❌ | ❌ | ❌ |
| `admin.*` | ✅ | ✅ | ❌ | ❌ |
| `security.*` | ✅ | △ 部分的 | ❌ | ❌ |
| `vc.*` | ✅ | ❌ | ❌ | ❌ |
| `system.*` | ✅ | ❌ | ❌ | ❌ |

---

## References

- [CloudEvents Specification](https://cloudevents.io/)
- [OpenID RISC (Risk and Incident Sharing)](https://openid.net/specs/openid-risc-profile-specification-1_0.html)
- [OIDC Back-Channel Logout](https://openid.net/specs/openid-connect-backchannel-1_0.html)
- [SCIM 2.0](https://datatracker.ietf.org/doc/html/rfc7644)

---

**Last Updated**: 2025-12-20
**Status**: Draft - Event catalog defined based on actual codebase analysis
