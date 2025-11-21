# Trusted Client機能仕様

## 概要

Trusted Client機能により、First-Partyクライアント（同一組織が所有・運営するクライアント）のユーザー体験を最適化します。Trusted Clientとして登録されたクライアントは、初回アクセス時のConsent画面をスキップできます。

## 目的

1. **UXの最適化**: First-Partyクライアントで不要なConsent画面を削減
2. **セキュリティの維持**: Third-Partyクライアントは引き続きConsent必須
3. **柔軟性**: クライアントごとにTrusted/Untrustedを設定可能
4. **OIDC Conformance Suite対応**: テスト用ドメインをTrusted扱い

---

## 用語定義

### First-Party Client（Trusted Client）
- 同一組織が所有・運営するクライアントアプリケーション
- 例: 自社サービス、社内ツール、開発/テスト環境

### Third-Party Client（Untrusted Client）
- 外部開発者/組織が作成したクライアントアプリケーション
- 例: サードパーティアプリ、パートナー連携

---

## Trusted判定ロジック

### 1. redirect_uriのドメインによる自動判定

Dynamic Client Registration時に、`redirect_uris`の最初のURLからドメインを抽出し、以下の条件でTrusted判定を行います：

```typescript
const redirectDomain = new URL(redirect_uris[0]).hostname;
const issuerDomain = new URL(env.ISSUER_URL).hostname;
const trustedDomains = env.TRUSTED_DOMAINS?.split(',') || [];

const isTrusted =
  redirectDomain === issuerDomain ||           // 同一ドメイン
  trustedDomains.includes(redirectDomain);     // ホワイトリスト
```

#### 判定条件

| 条件 | 判定 | 例 |
|------|------|-----|
| redirect_uriのドメイン == ISSUER_URLのドメイン | ✅ Trusted | `authrim.sgrastar.workers.dev` |
| redirect_uriのドメイン ∈ TRUSTED_DOMAINS | ✅ Trusted | `www.certification.openid.net` |
| 上記以外 | ❌ Untrusted | `example.com` |

### 2. 環境変数設定

**TRUSTED_DOMAINS** (カンマ区切り)

```bash
# .dev.vars または wrangler.toml
TRUSTED_DOMAINS=www.certification.openid.net,localhost,127.0.0.1
```

**デフォルト値**: 空（ISSUER_URLのドメインのみTrusted）

---

## データベーススキーマ

### oauth_clients テーブル拡張

```sql
-- Migration: 004_add_client_trust_settings.sql
ALTER TABLE oauth_clients ADD COLUMN is_trusted INTEGER DEFAULT 0;
ALTER TABLE oauth_clients ADD COLUMN skip_consent INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_clients_trusted ON oauth_clients(is_trusted);
```

#### カラム定義

| カラム | 型 | デフォルト | 説明 |
|--------|-----|-----------|------|
| `is_trusted` | INTEGER | 0 | 1=Trusted Client, 0=Third-Party Client |
| `skip_consent` | INTEGER | 0 | 1=Consent画面スキップ, 0=Consent必須 |

#### 設定パターン

| is_trusted | skip_consent | 動作 |
|-----------|--------------|------|
| 0 | 0 | Third-Party Client（初回Consent必須） |
| 1 | 0 | Trusted Clientだが、Consent表示 |
| 1 | 1 | **Trusted Client（Consentスキップ）** ← 推奨 |
| 0 | 1 | ❌ 無効な組み合わせ |

---

## Consent処理フロー

### Trusted Client（skip_consent=1）

```
1. /authorize リクエスト
   ↓
2. クライアント情報取得
   is_trusted=1 && skip_consent=1 && prompt≠"consent"
   ↓
3. 既存Consentをチェック（D1）
   ├─ Consent存在 → スキップ
   └─ Consent不在 → 自動付与（D1に保存）
   ↓
4. Consent画面スキップ
   ↓
5. 認可コード発行
```

### Third-Party Client（skip_consent=0）

```
1. /authorize リクエスト
   ↓
2. クライアント情報取得
   is_trusted=0 または skip_consent=0
   ↓
3. 既存Consentをチェック（D1）
   ├─ Consent存在 → スコープカバー確認
   │   ├─ カバー済み → スキップ
   │   └─ 不足 → Consent画面表示
   └─ Consent不在 → Consent画面表示
   ↓
4. ユーザー承認/拒否
   ↓
5. D1に保存 / エラーリダイレクト
```

### prompt=consent の場合

```
常にConsent画面を表示
（is_trusted, skip_consentの値に関係なく）
```

---

## 実装詳細

### 1. Dynamic Client Registration

**ファイル**: `packages/op-dcr/src/register.ts`

**修正箇所**: クライアント登録時にTrusted判定

```typescript
// redirect_uriからドメイン抽出
const redirectDomain = new URL(redirect_uris[0]).hostname;
const issuerDomain = new URL(c.env.ISSUER_URL).hostname;
const trustedDomains = c.env.TRUSTED_DOMAINS?.split(',').map(d => d.trim()) || [];

// Trusted判定
const isTrusted =
  redirectDomain === issuerDomain ||
  trustedDomains.includes(redirectDomain);

console.log(`[DCR] Client registration: domain=${redirectDomain}, trusted=${isTrusted}`);

// INSERT時にis_trusted, skip_consentを設定
await c.env.DB.prepare(`
  INSERT INTO oauth_clients (
    client_id, client_secret, client_name, redirect_uris,
    grant_types, response_types, token_endpoint_auth_method, jwks,
    is_trusted, skip_consent,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`).bind(
  clientId, hashedSecret, client_name, redirectUrisJson,
  grantTypesJson, responseTypesJson, token_endpoint_auth_method, jwksJson,
  isTrusted ? 1 : 0,  // is_trusted
  isTrusted ? 1 : 0,  // skip_consent
).run();
```

### 2. Authorization Endpoint

**ファイル**: `packages/op-auth/src/authorize.ts`

**修正箇所**: Consent判定ロジック（行1082-1187付近）

```typescript
// Check if consent is required (unless already confirmed)
const _consent_confirmed = c.req.query('_consent_confirmed') || ...;

if (_consent_confirmed !== 'true') {
  // クライアント情報取得
  const client = await getClient(c.env, validClientId);

  // Trusted clientでskip_consentが有効、かつprompt≠consentの場合
  if (client.is_trusted && client.skip_consent && !prompt?.includes('consent')) {
    // 既存Consentをチェック
    const existingConsent = await c.env.DB.prepare(
      'SELECT id FROM oauth_client_consents WHERE user_id = ? AND client_id = ?'
    ).bind(sub, validClientId).first();

    if (!existingConsent) {
      // Consentを自動付与（D1に保存）
      const consentId = crypto.randomUUID();
      const now = Date.now();

      await c.env.DB.prepare(`
        INSERT INTO oauth_client_consents
        (id, user_id, client_id, scope, granted_at, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).bind(consentId, sub, validClientId, scope, now, null).run();

      console.log(`[CONSENT] Auto-granted for trusted client: client_id=${validClientId}, user_id=${sub}`);
    }

    // Consent画面をスキップ
    consentRequired = false;
  } else {
    // 既存のConsent判定ロジック（Third-Party Client）
    let consentRequired = false;
    try {
      const existingConsent = await c.env.DB.prepare(...).bind(...).first();

      if (!existingConsent) {
        consentRequired = true;
      } else {
        // スコープカバー確認、有効期限確認
        ...
      }

      // prompt=consentは常にConsent表示
      if (prompt?.includes('consent')) {
        consentRequired = true;
      }
    } catch (error) {
      console.error('Failed to check consent:', error);
      consentRequired = true;
    }
  }

  if (consentRequired) {
    // Consent画面へリダイレクト
    ...
  }
}
```

### 3. Client Utility拡張

**ファイル**: `packages/shared/src/utils/client.ts`

**修正箇所**: getClient関数とClientMetadata型

```typescript
export interface ClientMetadata {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  jwks?: unknown;
  is_trusted?: boolean;     // 追加
  skip_consent?: boolean;   // 追加
  // ...
}

export async function getClient(env: Env, clientId: string): Promise<ClientMetadata | null> {
  const client = await env.DB.prepare(`
    SELECT
      client_id, client_secret, client_name, redirect_uris,
      grant_types, response_types, token_endpoint_auth_method, jwks,
      is_trusted, skip_consent
    FROM oauth_clients
    WHERE client_id = ?
  `).bind(clientId).first();

  if (!client) return null;

  return {
    client_id: client.client_id as string,
    client_secret: client.client_secret as string | undefined,
    client_name: client.client_name as string | undefined,
    redirect_uris: JSON.parse(client.redirect_uris as string),
    grant_types: client.grant_types ? JSON.parse(client.grant_types as string) : undefined,
    response_types: client.response_types ? JSON.parse(client.response_types as string) : undefined,
    token_endpoint_auth_method: client.token_endpoint_auth_method as string | undefined,
    jwks: client.jwks ? JSON.parse(client.jwks as string) : undefined,
    is_trusted: client.is_trusted === 1,       // 追加
    skip_consent: client.skip_consent === 1,   // 追加
  };
}
```

### 4. 環境変数型定義

**ファイル**: `packages/shared/src/types/env.ts`

```typescript
export interface Env {
  // ...existing fields...

  // Trusted Client domains (comma-separated)
  TRUSTED_DOMAINS?: string;
}
```

---

## セキュリティ考慮事項

### 1. ドメイン検証

- redirect_uriのドメイン抽出時に、URLパースエラーを適切にハンドリング
- ワイルドカードドメインは**サポートしない**（例: `*.example.com`）
- サブドメインは個別に指定する必要がある

### 2. Trusted設定の変更

- **Dynamic Registrationのみ**でTrusted判定を実施
- 既存クライアントのTrusted設定は**管理APIでのみ変更可能**（将来実装）
- Trustedフラグの変更は監査ログに記録（将来実装）

### 3. prompt=consentの尊重

- **prompt=consentが指定された場合、is_trustedに関係なく常にConsent画面を表示**
- これはOIDC仕様の要件

### 4. Third-Party Clientへの影響

- Trusted判定に該当しないクライアントは、従来通りConsent必須
- 既存のConsent機能に影響を与えない

---

## テストケース

### 1. Trusted Client（Conformance Suite）

**前提条件**:
- TRUSTED_DOMAINS=`www.certification.openid.net`
- Dynamic Registration: redirect_uri=`https://www.certification.openid.net/test/a/Authrim-basic-test/callback`

**期待動作**:
```
1. DCR → is_trusted=1, skip_consent=1
2. /authorize (初回) → Consent自動付与、画面スキップ
3. /authorize (2回目) → Consent画面スキップ
4. /authorize + prompt=consent → Consent画面表示
```

### 2. Trusted Client（同一ドメイン）

**前提条件**:
- ISSUER_URL=`https://authrim.sgrastar.workers.dev`
- redirect_uri=`https://authrim.sgrastar.workers.dev/callback`

**期待動作**:
```
1. DCR → is_trusted=1, skip_consent=1
2. 以降、Consent画面スキップ（prompt=consent除く）
```

### 3. Third-Party Client

**前提条件**:
- redirect_uri=`https://example.com/callback`

**期待動作**:
```
1. DCR → is_trusted=0, skip_consent=0
2. /authorize (初回) → Consent画面表示
3. ユーザー承認 → D1に保存
4. /authorize (2回目) → Consent画面スキップ
5. Scope変更 → Consent画面表示
```

### 4. prompt=consent（Trusted Client）

**前提条件**:
- is_trusted=1, skip_consent=1
- prompt=consent

**期待動作**:
```
1. /authorize + prompt=consent → 常にConsent画面表示
2. Trustedフラグは無視される
```

---

## マイグレーション手順

```bash
# 1. マイグレーション実行
wrangler d1 execute authrim-prod --file=migrations/004_add_client_trust_settings.sql

# 2. 環境変数設定
# wrangler.toml または Cloudflare Dashboardで設定
TRUSTED_DOMAINS=www.certification.openid.net

# 3. デプロイ
pnpm run build
pnpm run deploy
```

---

## 将来の拡張

### 1. Admin API

```typescript
// PATCH /api/admin/clients/:client_id
// Body: { is_trusted: true, skip_consent: true }
```

### 2. Audit Logging

```typescript
// Trusted設定変更の監査ログ
await logAudit({
  event: 'client.trust.updated',
  client_id: clientId,
  old_value: { is_trusted: false },
  new_value: { is_trusted: true },
  changed_by: adminUserId,
});
```

### 3. User Consent Management

```typescript
// GET /api/user/consents - 自分のConsent一覧
// DELETE /api/user/consents/:client_id - Consent取り消し
```

### 4. Granular Consent

```typescript
// ユーザーが個別scopeを承認/拒否
// 例: profileは承認、emailは拒否
```

---

## 参考資料

- [OAuth 2.0 RFC 6749](https://tools.ietf.org/html/rfc6749)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [OAuth 2.0 Security Best Current Practice](https://tools.ietf.org/html/draft-ietf-oauth-security-topics)
- [GDPR - Consent Requirements](https://gdpr.eu/consent/)
