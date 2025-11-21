# Authrim データベース・ストレージ使用状況分析レポート

**作成日**: 2025-11-20
**対象**: 1000万MAU規模での安全性とレイテンシ評価

---

## エグゼクティブサマリー

Authrimは、Cloudflareの4つのストレージサービス（D1、R2、Durable Objects、KV）を適切に使い分けた設計です。

**現状評価**:
- ✅ 100万MAUまで: 問題なく対応可能
- ⚠️ 500万MAU: 一部最適化が必要
- 🔴 1000万MAU: シャーディング実装が必須

**推定レイテンシ**: 平均50-100ms（許容範囲内）
**推定コスト**: 約$12,600/月（1ユーザーあたり$0.0013/月）

---

## 1. D1データベース（SQLite）

### 概要
- **バインディング名**: `DB`
- **データベース名**: `authrim-{env}` (例: `authrim-dev`, `authrim-prod`)
- **セットアップ**: `scripts/setup-d1.sh`

### テーブル構成（計13テーブル）

#### ユーザー管理系（4テーブル）
| テーブル | 用途 | 主要カラム |
|---------|------|-----------|
| `users` | ユーザー基本情報 | id, email, name, picture, password_hash |
| `user_custom_fields` | 検索可能カスタム属性 | user_id, field_name, field_value |
| `passkeys` | WebAuthn認証情報 | credential_id, public_key, counter |
| `password_reset_tokens` | パスワードリセット | token_hash, expires_at |

#### OAuth/認証系（5テーブル）
| テーブル | 用途 | 主要カラム |
|---------|------|-----------|
| `oauth_clients` | OAuthクライアント情報 | client_id, redirect_uris, grant_types |
| `oauth_client_consents` | ユーザー同意履歴 | user_id, client_id, scope, granted_at |
| `sessions` | セッション情報（Cold） | id, user_id, expires_at |
| `roles` | RBAC役割定義 | id, name, permissions_json |
| `user_roles` | ユーザー-役割紐付け | user_id, role_id |

#### システム管理系（4テーブル）
| テーブル | 用途 | 主要カラム |
|---------|------|-----------|
| `scope_mappings` | スコープ-クレームマッピング | scope, claim_name, source_table |
| `branding_settings` | UIカスタマイズ | custom_css, logo_url, primary_color |
| `identity_providers` | 外部IDプロバイダー | provider_type, config_json |
| `audit_log` | 監査ログ | user_id, action, resource_type, created_at |

**インデックス数**: 23個（検索性能最適化済み）

### 使用箇所

```typescript
// packages/shared/src/types/env.ts
DB: D1Database;
```

- **op-auth**: ユーザー認証、セッション作成
- **op-token**: トークン発行時のユーザー情報取得
- **op-userinfo**: UserInfo API
- **op-management**: 管理機能（ユーザー/クライアント一覧、統計）

### データ例

```sql
-- usersテーブル
INSERT INTO users (id, email, name, picture, created_at, updated_at)
VALUES ('usr_abc123', 'user@example.com', 'John Doe',
        'https://authrim.example.com/avatars/usr_abc123.jpg',
        1705123456789, 1705123456789);

-- sessionsテーブル
INSERT INTO sessions (id, user_id, expires_at, created_at)
VALUES ('ses_xyz789', 'usr_abc123', 1705209856, 1705123456);
```

### スケーラビリティ分析

#### 単位とシャーディング
- **単位**: アカウント単位（環境ごとに1つのD1データベース）
- **シャーディング**: ❌ **なし**（D1自体が非対応）
- **レプリケーション**: ✅ Cloudflareが自動的にグローバルレプリカを作成

#### レイテンシ特性
- **Read**: 5-20ms（エッジキャッシュ利用時）
- **Write**: 20-50ms（プライマリリージョンへの同期書き込み）
- **リトライロジック**: `packages/shared/src/utils/d1-retry.ts`で実装
  - 最大3回リトライ
  - 指数バックオフ（100ms → 200ms → 400ms）

### 1000万MAU での影響評価

#### 懸念事項
🔴 **高リスク**:

1. **シングルデータベースの限界**
   - 1000万ユーザー = 1000万行の`users`テーブル
   - クエリパフォーマンスがボトルネックになる可能性
   - D1の容量制限: 10GB（無料）、50GB+（有料）

2. **書き込み集中**
   - 全Writeがプライマリリージョンに集中
   - 1000万MAU想定: 約1万QPS（1日1ログイン/ユーザー）
   - 特に`audit_log`テーブルへの書き込みが頻繁

3. **ホットテーブル**
   - `users`: 1000万行
   - `sessions`: 最大数百万行（アクティブセッション）
   - `audit_log`: 無限に増加（アーカイブ必須）

#### 推奨対策

**短期（3ヶ月以内）**:
1. ✅ **キャッシング戦略強化**
   ```typescript
   // KVを使用したread-throughキャッシュ
   async function getUser(userId: string) {
     // 1. KVキャッシュをチェック
     const cached = await env.KV.get(`user:${userId}`);
     if (cached) return JSON.parse(cached);

     // 2. D1から取得
     const user = await env.DB.prepare(
       "SELECT * FROM users WHERE id = ?"
     ).bind(userId).first();

     // 3. KVにキャッシュ（TTL: 1時間）
     await env.KV.put(`user:${userId}`, JSON.stringify(user), {
       expirationTtl: 3600
     });
     return user;
   }
   ```

2. ✅ **インデックス最適化**（既に実装済み）
   - 23個のインデックスで主要クエリを高速化

3. ✅ **監視とメトリクス**
   - D1クエリパフォーマンスの監視
   - スロークエリの検出とチューニング

**中期（6ヶ月以内）**:
1. **audit_logのアーカイブ戦略**
   ```typescript
   // 90日以上経過したログをR2にアーカイブ
   const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
   const oldLogs = await env.DB.prepare(
     "SELECT * FROM audit_log WHERE created_at < ?"
   ).bind(ninetyDaysAgo).all();

   // R2に保存
   await env.AUDIT_ARCHIVE.put(
     `audit-${Date.now()}.json`,
     JSON.stringify(oldLogs)
   );

   // D1から削除
   await env.DB.prepare(
     "DELETE FROM audit_log WHERE created_at < ?"
   ).bind(ninetyDaysAgo).run();
   ```

2. **D1 Read Replica活用**
   - 読み取りクエリの分散（Cloudflareの機能）

**長期（12ヶ月以内）**:
1. **テーブル分割戦略**
   - `users`テーブルのパーティショニング検討
   - 地域別またはID範囲別の分割

2. **代替データベース検討**
   - Neon、PlanetScale等の分散SQLデータベース
   - または、Durable Objects + SQLiteによるシャーディング

---

## 2. R2ストレージ（オブジェクトストレージ）

### 概要
- **バインディング名**: `AVATARS`
- **バケット名**:
  - 本番: `authrim-avatars`
  - プレビュー: `authrim-avatars-preview`

### データ内容

**ユーザーアバター画像専用**
- **ファイルパス**: `avatars/{userId}.{ext}`
- **対応形式**: JPEG, PNG, GIF, WebP
- **最大サイズ**: 5MB/ファイル
- **メタデータ**: Content-Type、ETag

### 使用箇所

```typescript
// packages/op-management/src/admin.ts

// アップロード
export async function adminUserAvatarUploadHandler(c: Context) {
  const file = await c.req.parseBody()['avatar'];
  const filePath = `avatars/${userId}.${extension}`;

  await c.env.AVATARS.put(filePath, arrayBuffer, {
    httpMetadata: { contentType: file.type }
  });
}

// 配信
export async function serveAvatarHandler(c: Context) {
  const object = await c.env.AVATARS.get(`avatars/${filename}`);

  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}
```

### スケーラビリティ分析

#### 単位とシャーディング
- **単位**: バケット単位（環境ごとに1つ）
- **シャーディング**: ✅ **Cloudflareが自動的に分散**
- **容量**: 実質無制限

#### レイテンシ特性
- **Read**: 10-50ms（エッジキャッシュ利用時は数ms）
- **Write**: 50-200ms（グローバル同期）
- **CDN統合**: ✅ Cloudflareエッジから直接配信

### 1000万MAU での影響評価

✅ **問題なし** - R2は大規模データに最適

#### スケーラビリティ
- **ストレージ容量**: 実質無制限
- **10M users × 500KB/avatar = 5TB**: 問題なく対応可能
- **Egress料金**: $0（Cloudflare内部からのアクセス）

#### コスト推定（1000万MAU、月間）
| 項目 | 使用量 | 単価 | 費用 |
|------|--------|------|------|
| ストレージ | 5TB | $0.015/GB/月 | $75 |
| Class A操作（Write） | 10万リクエスト | $4.50/百万 | $0.45 |
| Class B操作（Read） | 1000万リクエスト | $0.36/百万 | $3.60 |
| **合計** | - | - | **$79/月** |

#### 推奨設定
```toml
# wrangler.toml
[[r2_buckets]]
binding = "AVATARS"
bucket_name = "authrim-avatars"
preview_bucket_name = "authrim-avatars-preview"
```

```typescript
// 配信最適化
headers.set('cache-control', 'public, max-age=31536000, immutable');
headers.set('etag', object.httpEtag);

// Cloudflare Image Resizing統合（将来的な最適化）
// https://developers.cloudflare.com/images/
const resizedUrl = `/cdn-cgi/image/width=200,height=200/${avatarUrl}`;
```

---

## 3. Durable Objects（強整合性ストレージ）

Authrimでは **10種類のDurable Objects** を使用しています。

### 3.1 SessionStore

#### 目的
アクティブセッションの管理（Hot/Coldパターン）

#### データ構造
```typescript
interface Session {
  id: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
  data?: {
    amr?: string[];  // Authentication Methods References
    acr?: string;    // Authentication Context Class Reference
    deviceName?: string;
    ipAddress?: string;
    userAgent?: string;
  };
}

// Durable Storage内
{
  version: 1,
  sessions: Map<sessionId, Session>,
  lastCleanup: number
}
```

#### 実装パターン
**Hot/Cold パターン**:
- **Hot**: DO内メモリ（サブミリ秒アクセス）
- **Cold**: D1データベース（フォールバック）

```typescript
// packages/shared/src/durable-objects/SessionStore.ts
export class SessionStore {
  private sessions: Map<string, Session> = new Map();

  async getSession(sessionId: string): Promise<Session | null> {
    // 1. メモリから取得（Hot）
    let session = this.sessions.get(sessionId);
    if (session) return session;

    // 2. D1から取得（Cold）
    session = await this.loadFromD1(sessionId);
    if (session) {
      // Hotに昇格
      this.sessions.set(sessionId, session);
    }
    return session;
  }
}
```

#### シャーディング
- **現状**: シングルトンインスタンス（`idFromName('global')`）
- **推奨**: User IDベースのシャーディング

```typescript
// 推奨実装
function getSessionShardId(userId: string): string {
  const hash = simpleHash(userId);
  return `shard-${hash % 100}`;
}

const doId = env.SESSION_STORE.idFromName(getSessionShardId(userId));
```

#### 1000万MAU での影響
⚠️ **要注意**:
- 同時アクティブセッション: 10% = 100万セッション
- メモリ使用量: 100万 × 1KB = **1GB**
- DOメモリ制限: 128MB（デフォルト）

**🛠️ 必須対策**: 100シャードに分割
- 1シャード = 1万セッション = 10MB → 余裕あり

---

### 3.2 AuthorizationCodeStore

#### 目的
OAuth 2.0認可コードのワンタイム使用保証

#### データ構造
```typescript
interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  userId: string;
  scope: string;
  codeChallenge?: string;       // PKCE
  codeChallengeMethod?: 'S256' | 'plain';
  nonce?: string;               // OIDC
  used: boolean;
  expiresAt: number;            // 60秒後
  createdAt: number;
}
```

#### セキュリティ機能
- ✅ ワンタイム使用保証（atomicな consume操作）
- ✅ PKCE対応（RFC 7636）
- ✅ 60秒TTL（OAuth 2.0 Security BCP準拠）
- ✅ リプレイ攻撃検知

#### 実装
```typescript
// packages/shared/src/durable-objects/AuthorizationCodeStore.ts
async consume(code: string, clientId: string, codeVerifier?: string) {
  const authCode = this.codes.get(code);

  // 1. 存在チェック
  if (!authCode) throw new Error('invalid_grant');

  // 2. 使用済みチェック
  if (authCode.used) {
    // セキュリティ違反: 全トークン失効
    await this.revokeAllTokens(authCode.userId, authCode.clientId);
    throw new Error('invalid_grant');
  }

  // 3. PKCEチェック
  if (authCode.codeChallenge) {
    const challengeFromVerifier = await generateCodeChallenge(codeVerifier);
    if (challengeFromVerifier !== authCode.codeChallenge) {
      throw new Error('invalid_grant');
    }
  }

  // 4. Atomicに使用済みマーク
  authCode.used = true;
  this.codes.set(code, authCode);
  await this.saveState();

  return authCode;
}
```

#### シャーディング
- **現状**: シングルトンインスタンス
- **評価**: ✅ 問題なし（TTL=60秒で同時存在数が限定的）

#### 1000万MAU での影響
✅ **問題なし**:
- 同時進行中の認可フロー: 最大数千〜数万
- メモリ使用量: 数千 × 2KB = 数MB

---

### 3.3 RefreshTokenRotator

#### 目的
リフレッシュトークンのアトミックローテーションと盗難検知

#### データ構造
```typescript
interface TokenFamily {
  id: string;                    // Family ID
  currentToken: string;          // 現在有効なトークン
  previousTokens: string[];      // ローテーション履歴（最大5個）
  userId: string;
  clientId: string;
  scope: string;
  rotationCount: number;
  createdAt: number;
  lastRotation: number;
  expiresAt: number;             // 30日後（デフォルト）
}
```

#### セキュリティ機能
- ✅ アトミックローテーション（競合条件なし）
- ✅ トークン盗難検知（古いトークンの再利用を検知）
- ✅ ファミリー全体の失効（盗難検知時）
- ✅ D1への監査ログ

#### トークン盗難検知フロー
```typescript
async rotate(currentToken: string) {
  const familyId = this.tokenToFamily.get(currentToken);
  const family = this.families.get(familyId);

  // 現在のトークンか確認
  if (family.currentToken !== currentToken) {
    // 盗難検知: 古いトークンが再利用された
    if (family.previousTokens.includes(currentToken)) {
      console.error('Token theft detected!');

      // ファミリー全体を失効
      await this.revokeFamily(familyId, 'Token theft detected');

      // 監査ログ
      await this.auditLog('theft_detected', familyId);

      throw new Error('invalid_grant');
    }
  }

  // 正常なローテーション
  const newToken = generateToken();
  family.previousTokens.push(family.currentToken);
  family.currentToken = newToken;
  family.rotationCount++;
  family.lastRotation = Date.now();

  // 履歴は最大5個まで
  if (family.previousTokens.length > 5) {
    family.previousTokens.shift();
  }

  await this.saveState();
  return newToken;
}
```

#### シャーディング
- **現状**: ✅ **client_idベースで既にシャーディング済み**
  ```typescript
  const doId = env.REFRESH_TOKEN_ROTATOR.idFromName(client_id);
  ```

#### 1000万MAU での影響
✅ **良好**:
- client_idでの自然な分散
- 1クライアント = 10万ユーザー想定
- 10万トークンファミリー × 2KB = 200MB
- クライアント毎にDOインスタンス分離 → 問題なし

---

### 3.4 KeyManager

#### 目的
JWT署名鍵の管理とローテーション

#### データ構造
```typescript
interface StoredKey {
  kid: string;           // Key ID
  publicJWK: JWK;        // 公開鍵（JWK形式）
  privatePEM: string;    // 秘密鍵（PEM形式）
  createdAt: number;
  isActive: boolean;
}

interface KeyManagerState {
  keys: StoredKey[];
  activeKeyId: string | null;
  config: {
    rotationIntervalDays: 90;   // 90日ごとにローテーション
    retentionPeriodDays: 30;    // 古い鍵は30日間保持
  };
  lastRotation: number | null;
}
```

#### ローテーション戦略
1. 新しい鍵ペアを生成（新しいkid）
2. 既存の鍵と併存（ゼロダウンタイム）
3. 新しいトークンは新しい鍵で署名
4. 古い鍵は検証のみ使用（30日間）
5. 30日後に古い鍵を削除

#### シャーディング
- **現状**: シングルトンインスタンス（グローバル鍵管理）
- **評価**: ✅ 適切（鍵は全体で共有）

#### 1000万MAU での影響
✅ **問題なし**:
- データ量: 数KB（鍵のみ）
- 読み取り中心の操作

---

### 3.5 ChallengeStore

#### 目的
ワンタイムチャレンジの管理（Passkey、Magic Link、Consent等）

#### データ構造
```typescript
type ChallengeType =
  | 'passkey_registration'
  | 'passkey_authentication'
  | 'magic_link'
  | 'session_token'    // ITP回避
  | 'reauth'           // 再認証確認
  | 'login'            // ログインフロー
  | 'consent';         // OAuth同意

interface Challenge {
  id: string;
  type: ChallengeType;
  userId: string;
  challenge: string;        // 実際のチャレンジ/トークン値
  email?: string;
  redirectUri?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;        // 通常15分
  consumed: boolean;
}
```

#### セキュリティ機能
- ✅ Atomicなconsume操作（check + deleteを同時実行）
- ✅ TTL強制
- ✅ 並列リプレイ攻撃防止

#### 実装例
```typescript
async consume(id: string, type: ChallengeType) {
  const challenge = this.challenges.get(id);

  // 存在チェック
  if (!challenge) throw new Error('Invalid challenge');

  // タイプチェック
  if (challenge.type !== type) throw new Error('Invalid challenge type');

  // 期限チェック
  if (Date.now() > challenge.expiresAt) {
    this.challenges.delete(id);
    throw new Error('Challenge expired');
  }

  // 使用済みチェック
  if (challenge.consumed) throw new Error('Challenge already consumed');

  // Atomicに消費
  challenge.consumed = true;
  this.challenges.delete(id);
  await this.saveState();

  return challenge;
}
```

#### シャーディング
- **現状**: シングルトンインスタンス
- **推奨**: user_idベースのシャーディング（高負荷時）

#### 1000万MAU での影響
⚠️ **中程度**:
- アクティブ認証フロー数に依存
- ピーク時: 数万〜数十万チャレンジ
- 必要に応じてシャーディング検討

---

### 3.6 RateLimiterCounter

#### 目的
完全精度のレート制限（Issue #6対応）

#### 問題意識
KVベースのレート制限では、Eventually Consistentのため、並行リクエストで正確なカウントができない。

#### データ構造
```typescript
interface RateLimitRecord {
  count: number;           // 現在のリクエスト数
  resetAt: number;         // ウィンドウリセット時刻
  firstRequestAt: number;  // ウィンドウ内の最初のリクエスト
}

// IPアドレスごとに管理
Map<ipAddress, RateLimitRecord>
```

#### アトミック操作
```typescript
async increment(clientIP: string, config: RateLimitConfig) {
  const now = Date.now();
  let record = this.counts.get(clientIP);

  // 新規またはウィンドウリセット
  if (!record || now >= record.resetAt) {
    record = {
      count: 1,
      resetAt: now + config.windowSeconds * 1000,
      firstRequestAt: now
    };
    this.counts.set(clientIP, record);
    await this.saveState();

    return { allowed: true, current: 1, limit: config.maxRequests };
  }

  // Atomicにインクリメント
  record.count++;
  this.counts.set(clientIP, record);
  await this.saveState();

  const allowed = record.count <= config.maxRequests;
  return {
    allowed,
    current: record.count,
    limit: config.maxRequests,
    resetAt: record.resetAt,
    retryAfter: allowed ? 0 : Math.ceil((record.resetAt - now) / 1000)
  };
}
```

#### シャーディング
- **推奨**: IPアドレスのハッシュ値ベース
  ```typescript
  const shardId = hashIP(clientIP) % 1000;
  const doId = env.RATE_LIMITER.idFromName(`shard-${shardId}`);
  ```

#### 1000万MAU での影響
✅ **良好**（シャーディング実装後）:
- ユニークIPアドレス: 約500万
- 1000シャード: 1シャード = 5000 IP = 500KB
- メモリ: 余裕あり

---

### 3.7 PARRequestStore

#### 目的
PAR request_uriのシングルユース保証（RFC 9126準拠）

#### RFC 9126要件
- ✅ request_uriは一度のみ使用可能
- ✅ 有効期限あり（通常10分）
- ✅ client_idとの紐付け

#### データ構造
```typescript
interface PARRequestData {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  // ... その他OAuthパラメータ
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}
```

#### シャーディング
- **現状**: シングルトンインスタンス
- **評価**: ✅ 問題なし（TTL=10分で短命）

#### 1000万MAU での影響
✅ **問題なし**: 短命データで同時存在数が限定的

---

### 3.8 DPoPJTIStore

#### 目的
DPoP JTIリプレイ保護（Issue #12対応）

#### DPoP要件
- ✅ 各DPoP proof JWTは一意のjtiを持つ
- ✅ jtiは再利用不可（リプレイ防止）
- ✅ 合理的な時間ウィンドウで追跡（1時間）

#### データ構造
```typescript
interface DPoPJTIRecord {
  jti: string;
  client_id?: string;     // オプション: jtiをクライアントに紐付け
  iat: number;            // DPoP proof発行時刻
  createdAt: number;
  expiresAt: number;      // 1時間後
}
```

#### Atomicチェック&ストア
```typescript
async checkAndStore(jti: string, ttl: number): Promise<boolean> {
  // 既に存在するかチェック
  if (this.jtis.has(jti)) {
    // リプレイ攻撃
    return false;
  }

  // Atomicに記録
  this.jtis.set(jti, {
    jti,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl * 1000
  });
  await this.saveState();

  return true;
}
```

#### シャーディング
- **現状**: シングルトンインスタンス
- **推奨**: client_idベース（DPoP使用率が高い場合）

#### 1000万MAU での影響
⚠️ **要監視**:
- DPoP使用率に依存
- 高使用率の場合: シャーディング検討

---

### 3.9 TokenRevocationStore

#### 目的
失効済みトークンのJTI追跡

#### データ構造
```typescript
interface RevokedToken {
  jti: string;
  reason: string;
  revokedAt: number;
  expiresAt: number;  // 元のトークンの有効期限
}
```

#### シャーディング
- **現状**: シングルトンインスタンス
- **評価**: ✅ 適切（失効リストは全体で共有）

---

### 3.10 DeviceCodeStore

#### 目的
デバイス認可フロー（RFC 8628）

#### データ構造
```typescript
interface DeviceCodeMetadata {
  device_code: string;
  user_code: string;        // 短いコード（例: "ABCD-1234"）
  client_id: string;
  scope: string;
  status: 'pending' | 'approved' | 'denied';
  user_id?: string;         // 承認後に設定
  last_poll_time?: number;  // ポーリングレート制限用
  expires_at: number;       // 15分後
}
```

#### シャーディング
- **現状**: シングルトンインスタンス
- **評価**: ✅ 問題なし（限定的な用途）

---

### Durable Objects まとめ

| DO | シャーディング | 1000万MAU対応 | 優先度 |
|----|--------------|--------------|--------|
| SessionStore | ❌ → ✅ User ID | 要実装 | 🔴 高 |
| AuthorizationCodeStore | ✅ Global | 問題なし | 🟢 低 |
| RefreshTokenRotator | ✅ Client ID | 問題なし | 🟢 低 |
| KeyManager | ✅ Global | 問題なし | 🟢 低 |
| ChallengeStore | ❌ → ⚠️ User ID | 監視 | 🟡 中 |
| RateLimiterCounter | ❌ → ✅ IP Hash | 要実装 | 🔴 高 |
| PARRequestStore | ✅ Global | 問題なし | 🟢 低 |
| DPoPJTIStore | ❌ → ⚠️ Client ID | 監視 | 🟡 中 |
| TokenRevocationStore | ✅ Global | 問題なし | 🟢 低 |
| DeviceCodeStore | ✅ Global | 問題なし | 🟢 低 |

#### DOのレイテンシ特性
- **Cold Start**: 50-200ms
- **Warm State**: 1-10ms（同一リージョン）
- **グローバル**: 50-100ms（リージョン間）

#### コスト推定（1000万MAU、月間）
- リクエスト数: 10億リクエスト
  - SessionStore: 5億（最頻繁）
  - RateLimiter: 3億
  - その他: 2億
- **費用**: $12.50/百万リクエスト → 約**$12,500/月**

---

## 4. KVストレージ（Key-Value）

### KVネームスペース一覧

| Namespace | 用途 | データ例 | TTL | 使用Worker |
|-----------|------|----------|-----|-----------|
| **CLIENTS** | OAuthクライアント情報 | Client metadata（JSON） | 無期限 | op-auth, op-token, op-userinfo, op-management |
| **INITIAL_ACCESS_TOKENS** | DCR初期アクセストークン | Token → Client ID | 7日 | op-management |
| **SETTINGS** | システム設定 | system_settings（JSON） | 無期限 | op-management |
| **STATE_STORE** | OAuth stateパラメータ | state → client_id | 600秒 | op-auth |
| **NONCE_STORE** | OIDC nonceパラメータ | nonce → client_id | 600秒 | op-auth, op-token |

### 廃止されたKV（DOに移行済み）
- ~~AUTH_CODES~~ → AuthorizationCodeStore DO
- ~~REFRESH_TOKENS~~ → RefreshTokenRotator DO
- ~~REVOKED_TOKENS~~ → TokenRevocationStore DO
- ~~RATE_LIMIT~~ → RateLimiterCounter DO

### セットアップ

```bash
# scripts/setup-kv.sh
./scripts/setup-kv.sh          # インタラクティブモード
./scripts/setup-kv.sh --reset  # リセットモード
```

**作成されるネームスペース**:
- CLIENTS (本番) + CLIENTS_preview (プレビュー)
- INITIAL_ACCESS_TOKENS + INITIAL_ACCESS_TOKENS_preview
- SETTINGS + SETTINGS_preview

### 使用パターン

#### CLIENTSキャッシュ
D1との併用（Read-through cache pattern）

```typescript
// packages/shared/src/storage/adapters/cloudflare-adapter.ts
async getClient(clientId: string) {
  // 1. KVキャッシュをチェック
  const cached = await env.CLIENTS.get(clientId);
  if (cached) return JSON.parse(cached);

  // 2. D1から取得
  const client = await env.DB.prepare(
    "SELECT * FROM oauth_clients WHERE client_id = ?"
  ).bind(clientId).first();

  // 3. KVにキャッシュ
  await env.CLIENTS.put(clientId, JSON.stringify(client));
  return client;
}
```

#### STATE_STORE / NONCE_STORE
CSRF対策用の短時間データ

```typescript
// packages/shared/src/utils/kv.ts
export async function storeState(env: Env, state: string, clientId: string) {
  const ttl = parseInt(env.STATE_EXPIRY, 10);  // 600秒
  await env.STATE_STORE.put(state, clientId, { expirationTtl: ttl });
}

export async function getState(env: Env, state: string): Promise<string | null> {
  return await env.STATE_STORE.get(state);
}
```

### スケーラビリティ分析

#### 単位とシャーディング
- **単位**: ネームスペース単位（環境ごとに1つ）
- **シャーディング**: ✅ **Cloudflareが自動分散**
- **容量**: 数百万キーまでスケール可能

#### レイテンシ特性
- **Read**: 5-50ms（エッジキャッシュ: 1-5ms）
- **Write**: 1秒程度で最終的整合性
  - ⚠️ **注意**: 書き込み直後の読み込みは古い値を返す可能性

### 1000万MAU での影響評価

#### CLIENTSキャッシュ
- キー数: 約10万クライアント
- データサイズ: 10万 × 2KB = 200MB
- 月間Read: 5億回
- **費用**: $2.50（100億回まで無料枠）

#### STATE_STORE
- 同時進行中の認可フロー: 1万〜10万
- 月間Write/Read: 各1億回
- **費用**: 無料（10億回まで無料枠）

#### SETTINGS
- キー数: 1個（`system_settings`）
- アクセス頻度: 低（キャッシュ可能）

#### 総コスト
💰 ほぼ**無料**（無料枠内）

#### スケーラビリティ
✅ **1億MAUまで問題なし**

ただし、**結果整合性**に注意:
- クリティカルな操作（トークン管理）はDOに移行済み ✅
- STATE/NONCEは短命なので問題なし ✅

---

## 5. 総合評価：1000万MAU規模での運用

### レイテンシ分析

| 操作 | ストレージ | レイテンシ | ボトルネック |
|------|-----------|-----------|-------------|
| **ログイン（Passkey）** | DO(SessionStore) + D1(users) | 50-100ms | DOのCold Start |
| **トークン発行** | DO(AuthCodeStore) + D1 | 30-80ms | D1 Write（audit_log） |
| **トークンリフレッシュ** | DO(RefreshTokenRotator) | 10-30ms | なし |
| **UserInfo取得** | D1(users) + R2(avatar) | 20-50ms | なし |
| **レート制限チェック** | DO(RateLimiter) | 5-20ms | シャーディング未実装時 |

**平均レイテンシ**: 50-100ms（許容範囲内）

### 安全性分析

#### 強み
✅ **アトミック操作**: DOによる完全な一貫性保証
- 認可コードの一回限り使用
- リフレッシュトークンの回転と盗難検知
- レート制限の正確なカウント

✅ **リプレイ攻撃防止**:
- DPoPJTIStore: DPoP proof JTIの再利用防止
- PARRequestStore: PAR request_uriの一回限り使用
- ChallengeStore: Passkey/Magic Linkチャレンジの一回限り使用

✅ **監査ログ**: 全操作をD1に記録

#### 注意点
⚠️ **KVの結果整合性**: クリティカルな操作には使用しない（すでに対応済み）
⚠️ **DOの単一障害点**: シャーディングで分散が必要

### コスト推定（1000万MAU、月間）

| サービス | 使用量 | 単価 | 費用 |
|---------|-------|------|------|
| **D1** | Read: 1億回<br>Write: 1000万回 | 無料枠内 | **$0** |
| **R2** | 5TB、Read: 1000万回 | - | **$79** |
| **DO** | 10億リクエスト | $12.50/百万 | **$12,500** |
| **KV** | Read: 5億回<br>Write: 1億回 | 無料枠内 | **$0** |
| **Workers** | 10億リクエスト | バンドル | **$0** |
| **合計** | - | - | **約$12,600/月** |

**1ユーザーあたり**: $0.0013/月

#### コスト最適化案
1. **DOリクエストの削減**
   - キャッシング強化（KV活用）
   - SessionStoreのTTL最適化
   - 非アクティブセッションの早期パージ

2. **監視とアラート**
   - DO使用量の監視
   - 異常なリクエストパターンの検知

### ボトルネックと対策

#### 1. D1の書き込み集中
**問題**:
- プライマリDBへの全Write集中
- `audit_log`の高頻度書き込み

**対策**:
```typescript
// 非同期audit_log書き込み（Workers Queue利用）
async function logAudit(entry: AuditLogEntry) {
  // Queueに送信（非同期）
  await env.AUDIT_QUEUE.send(entry);
}

// Consumer Worker
export default {
  async queue(batch: MessageBatch, env: Env) {
    // バッチ書き込み（10秒毎に集約）
    const entries = batch.messages.map(m => m.body);

    await env.DB.batch(
      entries.map(entry =>
        env.DB.prepare(
          "INSERT INTO audit_log (id, user_id, action, ...) VALUES (?, ?, ?, ...)"
        ).bind(entry.id, entry.userId, entry.action, ...)
      )
    );
  }
}
```

#### 2. DOのメモリ制限
**問題**:
- SessionStore: 単一インスタンスで100万セッション不可（1GB必要、制限128MB）

**対策（必須）**:
```typescript
// User IDベースシャーディング
function getSessionShardId(userId: string): string {
  // 簡易ハッシュ関数
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    hash = hash & hash; // 32bit整数に変換
  }
  return `shard-${Math.abs(hash) % 100}`;
}

// SessionStore呼び出し時
const shardId = getSessionShardId(userId);
const doId = env.SESSION_STORE.idFromName(shardId);
const sessionStore = env.SESSION_STORE.get(doId);
```

**効果**:
- 100シャード → 1シャード = 1万セッション = 10MB
- 十分な余裕

#### 3. DOのCold Start
**問題**:
- 初回アクセス時50-200msのレイテンシ

**対策**:
1. **Warm-upリクエスト**
   ```typescript
   // Cron Triggerで定期的にhealth check
   export default {
     async scheduled(event: ScheduledEvent, env: Env) {
       // 全シャードをWarm-up
       for (let i = 0; i < 100; i++) {
         const doId = env.SESSION_STORE.idFromName(`shard-${i}`);
         const stub = env.SESSION_STORE.get(doId);
         await stub.fetch(new Request('http://internal/health'));
       }
     }
   }
   ```

2. **重要なDOは常時Warm状態を維持**
   - KeyManager
   - RateLimiterCounter（頻繁にアクセスされるシャード）

### スケーラビリティロードマップ

#### Phase 1（〜100万MAU）
✅ **現行アーキテクチャで対応可能**
- 対策不要
- 監視体制の構築

#### Phase 2（100万〜500万MAU）
🔧 **最適化が必要**

1. **SessionStoreシャーディング実装**（必須）
   - User IDベースで100分割
   - 実装期間: 2週間

2. **RateLimiterシャーディング実装**（必須）
   - IPハッシュで1000分割
   - 実装期間: 1週間

3. **Audit logアーカイブの自動化**
   - 90日以上経過したログをR2に移動
   - Cron Triggerで毎日実行
   - 実装期間: 1週間

#### Phase 3（500万〜1000万MAU）
🔧 **追加最適化**

1. **D1のテーブル分割**
   - `users`テーブルのパーティショニング
   - 地域別またはID範囲別
   - 実装期間: 1ヶ月

2. **キャッシング層の強化**
   - ユーザープロファイルのKVキャッシュ
   - クライアント情報のKVキャッシュ強化
   - 実装期間: 2週間

3. **CDN層の最適化**
   - アバター画像の配信最適化
   - Cloudflare Image Resizing統合
   - 実装期間: 1週間

#### Phase 4（1000万MAU〜）
🚀 **次世代アーキテクチャ**

1. **Multi-region D1**（Cloudflareの機能拡張待ち）
   - 地理的分散
   - Read Replica自動配置

2. **専用Analytics DB**
   - Audit logの分離
   - ClickHouse on Cloudflare?
   - またはR2 + Parquet形式

3. **コスト最適化**
   - DOリクエスト削減のさらなる最適化
   - Workers AI活用検討

---

## 6. 推奨実装：優先度別

### 🔴 高優先度（Phase 2開始前に必須）

#### 1. SessionStoreのシャーディング実装
**ファイル**: `packages/shared/src/durable-objects/SessionStore.ts`

```typescript
// 新規追加: シャーディング用ユーティリティ
export function getSessionShardId(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    hash = hash & hash;
  }
  return `shard-${Math.abs(hash) % 100}`;
}

// 使用例（全Workerで統一）
const shardId = getSessionShardId(userId);
const doId = env.SESSION_STORE.idFromName(shardId);
const sessionStore = env.SESSION_STORE.get(doId);
```

**影響範囲**:
- `packages/op-auth/src/authorize.ts`
- `packages/op-token/src/token.ts`
- `packages/op-userinfo/src/userinfo.ts`
- `packages/op-management/src/admin.ts`

**テスト**:
- 同一ユーザーIDが常に同じシャードに行くことを確認
- 負荷テストで均等分散を確認

#### 2. RateLimiterのシャーディング実装
**ファイル**: `packages/shared/src/durable-objects/RateLimiterCounter.ts`

```typescript
export function getRateLimiterShardId(clientIP: string): string {
  let hash = 0;
  for (let i = 0; i < clientIP.length; i++) {
    hash = ((hash << 5) - hash) + clientIP.charCodeAt(i);
    hash = hash & hash;
  }
  return `shard-${Math.abs(hash) % 1000}`;
}
```

**影響範囲**:
- `packages/shared/src/middleware/rate-limit.ts`

### 🟡 中優先度（Phase 2中に実装）

#### 3. Audit logの非同期化
**新規ファイル**: `packages/shared/src/utils/audit-logger.ts`

```typescript
export async function logAudit(env: Env, entry: AuditLogEntry) {
  // Workers Queueが利用可能な場合
  if (env.AUDIT_QUEUE) {
    await env.AUDIT_QUEUE.send(entry);
  } else {
    // フォールバック: 同期書き込み
    await env.DB.prepare(
      "INSERT INTO audit_log (...) VALUES (...)"
    ).bind(...).run();
  }
}
```

**Consumer Worker**:
```typescript
// packages/audit-consumer/src/index.ts
export default {
  async queue(batch: MessageBatch<AuditLogEntry>, env: Env) {
    await env.DB.batch(
      batch.messages.map(msg =>
        env.DB.prepare("INSERT INTO audit_log (...) VALUES (...)")
          .bind(msg.body.id, msg.body.userId, ...)
      )
    );
  }
}
```

#### 4. Audit logのアーカイブ
**新規ファイル**: `packages/audit-archiver/src/index.ts`

```typescript
export default {
  // Cron: 毎日午前2時（UTC）
  async scheduled(event: ScheduledEvent, env: Env) {
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

    // 1. 古いログを取得
    const oldLogs = await env.DB.prepare(
      "SELECT * FROM audit_log WHERE created_at < ? LIMIT 10000"
    ).bind(ninetyDaysAgo).all();

    if (oldLogs.results.length === 0) return;

    // 2. R2に保存
    const filename = `audit-archive-${Date.now()}.json`;
    await env.AUDIT_ARCHIVE.put(
      filename,
      JSON.stringify(oldLogs.results)
    );

    // 3. D1から削除
    const ids = oldLogs.results.map(log => log.id);
    await env.DB.prepare(
      `DELETE FROM audit_log WHERE id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).run();

    console.log(`Archived ${oldLogs.results.length} logs to ${filename}`);
  }
}
```

**wrangler.toml**:
```toml
[triggers]
crons = ["0 2 * * *"]  # 毎日午前2時（UTC）
```

### 🟢 低優先度（Phase 3以降）

#### 5. ユーザープロファイルのKVキャッシュ強化
```typescript
const CACHE_TTL = 3600; // 1時間

export async function getUserProfile(env: Env, userId: string) {
  const cacheKey = `user:profile:${userId}`;

  // KVキャッシュ
  const cached = await env.KV?.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // D1から取得
  const user = await env.DB.prepare(
    "SELECT id, email, name, picture, email_verified FROM users WHERE id = ?"
  ).bind(userId).first();

  if (!user) return null;

  // KVにキャッシュ
  await env.KV?.put(cacheKey, JSON.stringify(user), {
    expirationTtl: CACHE_TTL
  });

  return user;
}
```

#### 6. Cloudflare Image Resizing統合
```typescript
// アバターURL生成時
function getAvatarUrl(baseUrl: string, size: number = 200): string {
  return `/cdn-cgi/image/width=${size},height=${size},fit=cover/${baseUrl}`;
}

// 使用例
const avatarUrl = getAvatarUrl(user.picture, 200);
// → /cdn-cgi/image/width=200,height=200,fit=cover/https://r2.../avatars/usr_xxx.jpg
```

---

## 7. 監視とアラート

### 重要メトリクス

#### D1データベース
```typescript
// メトリクス収集
{
  "d1_query_duration_ms": number,
  "d1_query_count": number,
  "d1_error_count": number,
  "table": string,
  "operation": "SELECT" | "INSERT" | "UPDATE" | "DELETE"
}
```

**アラート閾値**:
- クエリ時間 > 500ms
- エラー率 > 1%
- audit_logサイズ > 8GB（10GBの80%）

#### Durable Objects
```typescript
// メトリクス収集
{
  "do_name": string,
  "shard_id": string,
  "memory_usage_mb": number,
  "request_count": number,
  "cold_start_count": number,
  "avg_response_time_ms": number
}
```

**アラート閾値**:
- メモリ使用量 > 100MB（128MBの78%）
- Cold Start率 > 10%
- レスポンス時間 > 100ms

#### R2ストレージ
```typescript
// メトリクス収集
{
  "r2_bucket": "AVATARS",
  "total_size_gb": number,
  "request_count": number,
  "error_count": number
}
```

**アラート閾値**:
- エラー率 > 0.1%

#### KVストレージ
```typescript
// メトリクス収集
{
  "kv_namespace": string,
  "read_count": number,
  "write_count": number,
  "cache_hit_rate": number,
  "avg_latency_ms": number
}
```

**アラート閾値**:
- キャッシュヒット率（CLIENTS） < 80%
- レイテンシ > 100ms

### 推奨監視ツール
- **Cloudflare Analytics**: 組み込み
- **Sentry**: エラートラッキング
- **Grafana Cloud**: カスタムダッシュボード

---

## 8. まとめ

### 現状評価
✅ **優れた設計**:
- Durable Objectsの効果的活用（強整合性）
- Hot/Coldパターンによるレイテンシ最適化
- R2とKVの適切な使い分け
- セキュリティベストプラクティス準拠

### 1000万MAU対応の鍵
1. **DOシャーディング実装**（最優先）
   - SessionStore: User IDベース（100シャード）
   - RateLimiter: IPハッシュベース（1000シャード）

2. **D1の書き込み最適化**
   - Audit logの非同期化
   - バッチ書き込み
   - 定期アーカイブ

3. **コスト管理**
   - DOリクエストの削減（約$12,600/月）
   - 不要なDO呼び出しの最適化

### 推定性能（1000万MAU）
- **レイテンシ**: 平均50-100ms ✅
- **可用性**: 99.9%以上（Cloudflare SLA） ✅
- **コスト**: $12,600/月（$0.0013/ユーザー） ✅

### 実装タイムライン

| フェーズ | ユーザー数 | 期間 | 必須タスク |
|---------|-----------|------|-----------|
| Phase 1 | 〜100万 | 現在 | 監視体制構築 |
| Phase 2 | 100万〜500万 | 3-6ヶ月 | DOシャーディング、Audit log非同期化 |
| Phase 3 | 500万〜1000万 | 6-12ヶ月 | D1テーブル分割、キャッシング強化 |
| Phase 4 | 1000万〜 | 12ヶ月以降 | 次世代アーキテクチャ検討 |

### 結論
**Authrimの現在のアーキテクチャは、適切な最適化により1000万MAUに対応可能です。**

Phase 2の対策（SessionStoreとRateLimiterのシャーディング）は、**500万MAU到達前に実装必須**です。それ以外は段階的に実装することで、安全かつコスト効率的に成長できます。
