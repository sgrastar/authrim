# ストレージ一貫性設計 - Phase 6

**作成日**: 2025-11-15
**ブランチ**: claude/storage-consistency-design-01YRFRKmRpGJQowtnmTFKNBw
**ステータス**: 設計提案

---

## エグゼクティブサマリー

Enrai Phase 5のストレージアーキテクチャは、Cloudflare Workers の各種ストレージプリミティブ（Durable Objects、D1、KV）を効果的に組み合わせていますが、**複数のストレージ間の一貫性**に関して3つのクリティカルな課題が存在します：

1. **DOからD1への非同期書き込み** - 信頼性の欠如
2. **KVキャッシュ無効化の一貫性窓** - 古いデータ提供のリスク
3. **認可コードのKV使用** - OAuth 2.0セキュリティ要件違反

本ドキュメントは、これらの課題に対する具体的な解決策と実装戦略を提示します。

---

## 1. 現状分析と課題

### 1.1 DOからD1への書き込み（信頼性の問題）

#### 現状の実装

**ファイル**: `packages/shared/src/durable-objects/SessionStore.ts:239-257`

```typescript
async createSession(userId: string, ttl: number, data?: SessionData): Promise<Session> {
  const session: Session = {
    id: this.generateSessionId(),
    userId,
    expiresAt: Date.now() + ttl * 1000,
    createdAt: Date.now(),
    data,
  };

  // 1. Store in memory (hot)
  this.sessions.set(session.id, session);

  // 2. Persist to D1 (backup & audit) - async, don't wait
  this.saveToD1(session).catch((error) => {
    console.error('SessionStore: Failed to save to D1:', error);
  });

  return session;
}
```

#### 問題点

```
データフロー:
┌─────────────────┐
│ セッション作成  │
└────────┬────────┘
         │
         ├──────────────────────┬─────────────────────┐
         ▼                      ▼                     ▼
   [即座完了]             [非同期・結果待たない]   [レスポンス返却]
   メモリに保存 ✅        D1書き込み ⚠️            クライアントへ
         │                      │                     │
         │              成功/失敗 不明                │
         │              エラーログのみ                │
         └──────────────────────┴─────────────────────┘
                    不整合の可能性
```

**影響範囲**:
- セッション作成: `createSession()` - 252行目
- セッション延長: `extendSession()` - 340行目
- セッション無効化: `invalidateSession()` - 268行目

**具体的なリスク**:
1. **データ損失**: D1書き込みが失敗してもメモリには存在 → Worker再起動で消失
2. **監査証跡の欠落**: コンプライアンス要件を満たせない
3. **hot/cold不整合**: D1フォールバック時に古いデータまたはnullが返る
4. **無言の失敗**: エラーログは出るが、運用アラートなし

---

### 1.2 KVキャッシュの無効化（一貫性の窓）

#### 現状の実装

**ファイル**: `packages/shared/src/storage/adapters/cloudflare-adapter.ts:207-214`

```typescript
private async setToD1WithKVCache(key: string, value: string): Promise<void> {
  // 1. Update D1
  await this.setToD1(key, value);

  // 2. Invalidate KV cache
  if (this.env.CLIENTS_CACHE) {
    await this.env.CLIENTS_CACHE.delete(key);
  }
}
```

#### 問題点

```
タイムライン:
T0: クライアント更新リクエスト受信
T1: D1書き込み開始
T2: D1書き込み完了 ✅
    ↓
   [一貫性の窓 - 問題発生期間]
    ↓
    並行リクエストA: KVからキャッシュ取得 → 古いデータ返却 ❌
    並行リクエストB: KVからキャッシュ取得 → 古いデータ返却 ❌
    ↓
T3: KV削除開始
T4: KV削除完了 ✅
T5: 次のリクエスト: KVミス → D1から新しいデータ取得 → KVに再キャッシュ ✅
```

**影響範囲**:
- クライアントメタデータ更新時
- リダイレクトURI変更時に旧URIが受け入れられる可能性
- スコープ変更が反映されない期間（最大5分 = KV TTL）

**具体的なシナリオ**:
```
1. 管理者がクライアントのredirect_urisを更新
   旧: ["https://old.example.com/callback"]
   新: ["https://new.example.com/callback"]

2. D1更新完了（T2） → KV削除開始（T3）の間に

3. 認可リクエスト到着:
   - redirect_uri: https://old.example.com/callback
   - KVから古いメタデータ取得
   - 検証成功 ❌ (本来は失敗すべき)
   - 認可コード発行 ❌

4. セキュリティリスク: 古いリダイレクトURIへの認可コード送信
```

---

### 1.3 認可コードのKV使用（セキュリティリスク）

#### 現状の実装

**ファイル**: `packages/shared/src/utils/kv.ts:36-65`

```typescript
export async function storeAuthCode(env: Env, code: string, data: AuthCodeData): Promise<void> {
  const ttl = parseInt(env.CODE_EXPIRY, 10);
  const expirationTtl = ttl; // TTL in seconds

  await env.AUTH_CODES.put(code, JSON.stringify(data), {
    expirationTtl,
  });
}

export async function getAuthCode(env: Env, code: string): Promise<AuthCodeData | null> {
  const data = await env.AUTH_CODES.get(code);
  // ... 省略
}
```

#### 問題点

**KVの一貫性モデル**:
- Cloudflare KVは**結果整合性** (Eventually Consistent)
- 複数のエッジロケーション間で即座に同期されない
- 書き込み後、最大60秒の遅延が発生する可能性

**OAuth 2.0セキュリティ要件**:
- RFC 6749: 認可コードは**ワンタイムユース**（一度だけ使用可能）
- セキュリティBCP Draft 16: 再利用検出時は全トークン無効化

**競合状態のシナリオ**:
```
攻撃者が認可コードを傍受した場合:

T0: 正当なクライアント: コード取得
T1: 攻撃者: 同じコードでエッジロケーションAに送信
T2: 正当なクライアント: エッジロケーションBに送信

並行処理:
┌──────────────────────┐       ┌──────────────────────┐
│ Edge Location A      │       │ Edge Location B      │
│ (攻撃者のリクエスト) │       │ (正当なリクエスト)   │
└──────────────────────┘       └──────────────────────┘
         │                              │
         ▼                              ▼
   KV.get(code)                   KV.get(code)
   → found ✅                      → found ✅
         │                              │
         ▼                              ▼
   トークン発行 ❌                トークン発行 ✅
   (攻撃成功)                     (正当)
         │                              │
         ▼                              ▼
   KV.delete(code)                KV.delete(code)

結果: 両方のリクエストが成功 → OAuth 2.0違反
```

**既存の解決策**:
- `AuthorizationCodeStore` Durable Objectが**既に実装済み**
- ファイル: `packages/shared/src/durable-objects/AuthorizationCodeStore.ts`
- しかし、**未使用**（authorize.ts、token.tsで利用されていない）

---

## 2. 解決策の設計

### 2.1 DOからD1への信頼性確保

#### 設計方針

**ストラテジー**: Write-Behind Queue with Retry Logic

```
┌─────────────────────────────────────────────────────────┐
│              Write-Behind Queue Pattern                  │
└─────────────────────────────────────────────────────────┘

メインフロー:
1. メモリに書き込み（即座）
2. 書き込みキューに追加
3. レスポンス返却
4. バックグラウンドでD1書き込み（リトライ付き）

実装:
┌──────────────┐
│ Client Request│
└───────┬───────┘
        │
        ▼
┌────────────────────┐
│ SessionStore DO    │
│                    │
│ ┌────────────────┐ │
│ │ 1. Memory Write│ │ ← 即座完了
│ └────────┬───────┘ │
│          │         │
│          ▼         │
│ ┌────────────────┐ │
│ │ 2. Queue Add   │ │ ← 軽量操作
│ └────────┬───────┘ │
└──────────┼─────────┘
           │
           ▼
    Response to Client ✅
           │
           │ [バックグラウンド処理]
           ▼
┌───────────────────────┐
│ Retry Queue Worker    │
│                       │
│ ┌──────────────────┐  │
│ │ 3. D1 Write      │  │
│ └────┬─────────────┘  │
│      │                │
│      ├─ Success → Remove from queue
│      │                │
│      └─ Failure → Exponential backoff
│         ├─ Retry #1: 1秒後
│         ├─ Retry #2: 2秒後
│         ├─ Retry #3: 4秒後
│         ├─ Retry #4: 8秒後
│         └─ Max 5 retries → Alert
└───────────────────────┘
```

#### 実装詳細

**1. リトライキューの追加**

```typescript
// packages/shared/src/durable-objects/SessionStore.ts

interface QueuedWrite {
  id: string;
  operation: 'create' | 'update' | 'delete';
  session: Session;
  attempts: number;
  nextRetry: number;
}

export class SessionStore {
  private sessions: Map<string, Session> = new Map();
  private writeQueue: Map<string, QueuedWrite> = new Map(); // 新規追加
  private processingQueue: boolean = false;

  // ... existing code ...

  private async queueD1Write(
    operation: 'create' | 'update' | 'delete',
    session: Session
  ): Promise<void> {
    const queueId = `${operation}_${session.id}_${Date.now()}`;

    this.writeQueue.set(queueId, {
      id: queueId,
      operation,
      session,
      attempts: 0,
      nextRetry: Date.now(),
    });

    // バックグラウンド処理開始（非同期、結果を待たない）
    if (!this.processingQueue) {
      void this.processWriteQueue();
    }
  }

  private async processWriteQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    while (this.writeQueue.size > 0) {
      const now = Date.now();

      for (const [queueId, queued] of this.writeQueue.entries()) {
        // リトライタイミングチェック
        if (queued.nextRetry > now) {
          continue;
        }

        try {
          // D1書き込み実行
          switch (queued.operation) {
            case 'create':
            case 'update':
              await this.saveToD1(queued.session);
              break;
            case 'delete':
              await this.deleteFromD1(queued.session.id);
              break;
          }

          // 成功 → キューから削除
          this.writeQueue.delete(queueId);
          console.log(`SessionStore: D1 ${queued.operation} succeeded for ${queued.session.id}`);

        } catch (error) {
          // 失敗 → リトライ戦略
          queued.attempts++;

          if (queued.attempts >= 5) {
            // 最大リトライ回数超過 → アラート
            console.error(
              `SessionStore: D1 ${queued.operation} failed after ${queued.attempts} attempts for ${queued.session.id}`,
              error
            );

            // TODO: 外部監視システムへアラート送信
            // await this.sendAlert('D1_WRITE_FAILURE', { queueId, queued, error });

            // デッドレターキューへ移動（オプション）
            this.writeQueue.delete(queueId);
          } else {
            // Exponential backoff: 2^attempts 秒
            const backoffSeconds = Math.pow(2, queued.attempts);
            queued.nextRetry = now + backoffSeconds * 1000;

            console.warn(
              `SessionStore: D1 ${queued.operation} failed (attempt ${queued.attempts}/5), retrying in ${backoffSeconds}s`,
              error
            );
          }
        }
      }

      // 全てのアイテムが nextRetry > now の場合、一時停止
      const nextItem = Array.from(this.writeQueue.values())
        .sort((a, b) => a.nextRetry - b.nextRetry)[0];

      if (nextItem && nextItem.nextRetry > now) {
        const waitTime = nextItem.nextRetry - now;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      // キューが空になったら終了
      if (this.writeQueue.size === 0) {
        break;
      }
    }

    this.processingQueue = false;
  }

  async createSession(userId: string, ttl: number, data?: SessionData): Promise<Session> {
    const session: Session = {
      id: this.generateSessionId(),
      userId,
      expiresAt: Date.now() + ttl * 1000,
      createdAt: Date.now(),
      data,
    };

    // 1. メモリに保存（即座）
    this.sessions.set(session.id, session);

    // 2. D1書き込みをキューに追加（軽量操作）
    await this.queueD1Write('create', session);

    return session;
  }

  async extendSession(sessionId: string, additionalSeconds: number): Promise<Session | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    session.expiresAt += additionalSeconds * 1000;
    this.sessions.set(sessionId, session);

    // キューに追加
    await this.queueD1Write('update', session);

    return session;
  }

  async invalidateSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    const hadSession = this.sessions.has(sessionId);
    this.sessions.delete(sessionId);

    if (session) {
      // キューに追加
      await this.queueD1Write('delete', session);
    }

    return hadSession;
  }
}
```

**2. 監視とアラート**

```typescript
// packages/shared/src/utils/monitoring.ts (新規作成)

export interface Alert {
  type: 'D1_WRITE_FAILURE' | 'KV_CACHE_FAILURE' | 'AUTH_CODE_RACE';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

export async function sendAlert(env: Env, alert: Alert): Promise<void> {
  // 実装オプション:
  // 1. Cloudflare Workers Logging (console.error with structured data)
  console.error('ALERT:', JSON.stringify(alert));

  // 2. Cloudflare Workers Analytics Engine
  if (env.ANALYTICS) {
    await env.ANALYTICS.writeDataPoint({
      blobs: [alert.type, alert.severity],
      doubles: [alert.timestamp],
      indexes: [alert.type],
    });
  }

  // 3. 外部監視サービス（Sentry, Datadog等）
  // await fetch('https://monitoring-service.example.com/alerts', {
  //   method: 'POST',
  //   body: JSON.stringify(alert),
  // });
}
```

**3. 一貫性レベルの明示化**

```typescript
// packages/shared/src/storage/interfaces.ts

export type ConsistencyLevel = 'strong' | 'eventual';

export interface WriteOptions {
  consistency?: ConsistencyLevel;
  timeout?: number; // ミリ秒
}

export interface ISessionStore {
  create(session: Partial<Session>, options?: WriteOptions): Promise<Session>;
  extend(sessionId: string, seconds: number, options?: WriteOptions): Promise<Session | null>;
  delete(sessionId: string, options?: WriteOptions): Promise<void>;
}
```

**使用例**:
```typescript
// クリティカルなセッション（即座にD1へ書き込み）
await sessionStore.create(session, { consistency: 'strong', timeout: 5000 });

// 通常のセッション（非同期書き込み）
await sessionStore.create(session, { consistency: 'eventual' });
```

---

### 2.2 KVキャッシュ無効化戦略

#### 設計方針

**ストラテジー**: Delete-Then-Write Pattern

```
┌─────────────────────────────────────────────────────┐
│         Delete-Then-Write Pattern                    │
└─────────────────────────────────────────────────────┘

従来 (Write-Then-Delete):
T1: D1書き込み ✅
T2: [一貫性の窓] ← 問題
T3: KV削除 ✅

改善後 (Delete-Then-Write):
T1: KV削除 ✅ (古いキャッシュ削除)
T2: D1書き込み ✅
T3: 次回読み取り → KVミス → D1から最新取得 ✅
```

#### 実装詳細

**1. 順序変更 + エラーハンドリング**

```typescript
// packages/shared/src/storage/adapters/cloudflare-adapter.ts

private async setToD1WithKVCache(key: string, value: string): Promise<void> {
  // Strategy 1: Delete-Then-Write (推奨)

  // Step 1: KVキャッシュを先に削除
  if (this.env.CLIENTS_CACHE) {
    try {
      await this.env.CLIENTS_CACHE.delete(key);
    } catch (error) {
      // キャッシュ削除失敗はログのみ（D1が正とする）
      console.warn(`KV cache delete failed for ${key}, proceeding with D1 write`, error);
    }
  }

  // Step 2: D1に書き込み
  await this.setToD1(key, value);

  // これで不整合の窓が閉じる:
  // - KV削除後: 読み取りはD1にフォールバック（遅いが正しい）
  // - D1書き込み後: 読み取りは最新データ取得
}
```

**2. Alternative: Compare-and-Swap Pattern**

より高度な一貫性が必要な場合:

```typescript
interface CachedValue {
  data: string;
  version: number; // D1のupdated_atタイムスタンプ
}

private async setToD1WithKVCache(key: string, value: string): Promise<void> {
  const valueData = JSON.parse(value);
  const version = Date.now();

  // D1に書き込み（バージョン付き）
  await this.setToD1(key, JSON.stringify({ ...valueData, _version: version }));

  // KVキャッシュにバージョン付きで保存
  if (this.env.CLIENTS_CACHE) {
    await this.env.CLIENTS_CACHE.put(
      key,
      JSON.stringify({ data: value, version }),
      { expirationTtl: 300 }
    );
  }
}

private async getFromD1WithKVCache(key: string): Promise<string | null> {
  if (this.env.CLIENTS_CACHE) {
    const cached = await this.env.CLIENTS_CACHE.get(key);
    if (cached) {
      const { data, version } = JSON.parse(cached) as CachedValue;

      // D1から最新バージョンを確認（軽量クエリ）
      const d1Version = await this.getD1Version(key);

      if (d1Version && d1Version <= version) {
        // キャッシュが最新
        return data;
      }

      // キャッシュが古い → 削除して再取得
      await this.env.CLIENTS_CACHE.delete(key);
    }
  }

  // KVミスまたは古いキャッシュ → D1から取得
  const value = await this.getFromD1(key);

  if (value && this.env.CLIENTS_CACHE) {
    const version = Date.now();
    await this.env.CLIENTS_CACHE.put(
      key,
      JSON.stringify({ data: value, version }),
      { expirationTtl: 300 }
    );
  }

  return value;
}

private async getD1Version(key: string): Promise<number | null> {
  const [table, id] = key.split(':', 2);
  if (table !== 'client') return null;

  const result = await this.env.DB.prepare(
    'SELECT updated_at FROM oauth_clients WHERE client_id = ?'
  )
    .bind(id)
    .first();

  return result ? (result.updated_at as number) : null;
}
```

**3. Cache-Control Headers（クライアント側）**

```typescript
// packages/op-management/src/admin.ts (クライアント更新エンドポイント)

app.put('/clients/:client_id', async (c) => {
  const clientId = c.req.param('client_id');
  const updates = await c.req.json();

  // クライアント更新
  const updated = await clientStore.update(clientId, updates);

  return c.json(updated, 200, {
    // キャッシュ制御ヘッダー
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'ETag': `"${updated.updated_at}"`,
    'Last-Modified': new Date(updated.updated_at * 1000).toUTCString(),
  });
});

app.get('/clients/:client_id', async (c) => {
  const clientId = c.req.param('client_id');
  const client = await clientStore.get(clientId);

  if (!client) {
    return c.json({ error: 'Client not found' }, 404);
  }

  // 条件付きリクエスト対応
  const ifNoneMatch = c.req.header('If-None-Match');
  const etag = `"${client.updated_at}"`;

  if (ifNoneMatch === etag) {
    return c.body(null, 304); // Not Modified
  }

  return c.json(client, 200, {
    'Cache-Control': 'private, max-age=300', // 5分キャッシュ
    'ETag': etag,
    'Last-Modified': new Date(client.updated_at * 1000).toUTCString(),
  });
});
```

---

### 2.3 認可コードのDurable Object移行

#### 設計方針

**既存の `AuthorizationCodeStore` DOを有効化**

現在未使用の `AuthorizationCodeStore` Durable Object を認可フローに統合します。

```
変更前 (KV):
authorize.ts → storeAuthCode(KV) → AUTH_CODES namespace
token.ts → getAuthCode(KV) → 競合の可能性 ❌

変更後 (DO):
authorize.ts → AuthorizationCodeStore DO → 強一貫性 ✅
token.ts → AuthorizationCodeStore DO → ワンタイムユース保証 ✅
```

#### 実装詳細

**1. 認可エンドポイントの変更**

```typescript
// packages/op-auth/src/authorize.ts

// 変更前:
import { storeAuthCode } from '@repo/shared/utils/kv';

// 認可コード生成と保存
const code = crypto.randomUUID();
await storeAuthCode(env, code, {
  clientId,
  redirectUri: validRedirectUri,
  userId: user.id,
  scope,
  codeChallenge,
  codeChallengeMethod,
  nonce,
  state,
});

// 変更後:
// AuthorizationCodeStore DOを使用
const doId = env.AUTH_CODE_STORE.idFromName('default');
const doStub = env.AUTH_CODE_STORE.get(doId);

const code = crypto.randomUUID();

const response = await doStub.fetch(
  new Request('http://internal/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      clientId,
      redirectUri: validRedirectUri,
      userId: user.id,
      scope,
      codeChallenge,
      codeChallengeMethod,
      nonce,
      state,
      expiresAt: Date.now() + 60 * 1000, // 60秒
    }),
  })
);

if (!response.ok) {
  throw new Error('Failed to store authorization code');
}
```

**2. トークンエンドポイントの変更**

```typescript
// packages/op-token/src/token.ts

// 変更前:
import { getAuthCode } from '@repo/shared/utils/kv';

const authCodeData = await getAuthCode(env, code);
if (!authCodeData || authCodeData.used) {
  return c.json({ error: 'invalid_grant' }, 400);
}

// Mark as used
authCodeData.used = true;
await storeAuthCode(env, code, authCodeData);

// 変更後:
// AuthorizationCodeStore DOでアトミックに消費
const doId = env.AUTH_CODE_STORE.idFromName('default');
const doStub = env.AUTH_CODE_STORE.get(doId);

const response = await doStub.fetch(
  new Request('http://internal/code/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      clientId,
      codeVerifier, // PKCEの場合
    }),
  })
);

if (!response.ok) {
  const error = await response.json();

  if (response.status === 409) {
    // コード再利用検出 → 全トークン無効化
    console.error('Authorization code reuse detected:', error);

    // TODO: この認可コードで発行されたトークンを全て無効化
    // await revokeTokensByAuthCode(env, code);

    return c.json({
      error: 'invalid_grant',
      error_description: 'Authorization code has already been used',
    }, 400);
  }

  return c.json({ error: 'invalid_grant' }, 400);
}

const authCodeData = await response.json();

// トークン発行処理続行...
```

**3. AuthorizationCodeStore DOの拡張**

```typescript
// packages/shared/src/durable-objects/AuthorizationCodeStore.ts

export class AuthorizationCodeStore {
  // ... existing code ...

  /**
   * コードをアトミックに消費
   * ワンタイムユース保証 + PKCE検証
   */
  async consumeCode(request: ConsumeCodeRequest): Promise<ConsumeCodeResponse> {
    const { code, clientId, codeVerifier } = request;

    const stored = this.codes.get(code);

    if (!stored) {
      throw new Error('Code not found or expired');
    }

    // 既に使用済み → 再利用検出
    if (stored.used) {
      // セキュリティイベントログ
      console.error('SECURITY: Authorization code reuse attempt detected', {
        code,
        clientId,
        originalClientId: stored.clientId,
        timestamp: Date.now(),
      });

      // 監査ログ
      await this.logToD1('auth_code.reuse_detected', {
        code,
        clientId,
        userId: stored.userId,
      });

      // 409 Conflict
      throw new ConflictError('Authorization code has already been used');
    }

    // クライアント検証
    if (stored.clientId !== clientId) {
      throw new Error('Client mismatch');
    }

    // PKCE検証
    if (stored.codeChallenge) {
      if (!codeVerifier) {
        throw new Error('Code verifier required');
      }

      const isValid = await this.verifyPKCE(
        codeVerifier,
        stored.codeChallenge,
        stored.codeChallengeMethod
      );

      if (!isValid) {
        throw new Error('Invalid code verifier');
      }
    }

    // アトミックに使用済みマーク
    stored.used = true;
    stored.usedAt = Date.now();
    this.codes.set(code, stored);

    // 監査ログ
    await this.logToD1('auth_code.consumed', {
      code,
      clientId,
      userId: stored.userId,
    });

    return {
      clientId: stored.clientId,
      redirectUri: stored.redirectUri,
      userId: stored.userId,
      scope: stored.scope,
      nonce: stored.nonce,
      state: stored.state,
    };
  }

  private async verifyPKCE(
    verifier: string,
    challenge: string,
    method: 'S256' | 'plain'
  ): Promise<boolean> {
    if (method === 'plain') {
      return verifier === challenge;
    }

    // S256: BASE64URL(SHA256(verifier)) == challenge
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    return base64 === challenge;
  }

  private async logToD1(event: string, metadata: Record<string, unknown>): Promise<void> {
    if (!this.env.DB) return;

    try {
      await this.env.DB.prepare(
        'INSERT INTO audit_log (event, metadata, created_at) VALUES (?, ?, ?)'
      )
        .bind(event, JSON.stringify(metadata), Math.floor(Date.now() / 1000))
        .run();
    } catch (error) {
      console.error('Failed to log to D1:', error);
    }
  }
}
```

**4. KV AUTH_CODES の段階的廃止**

```typescript
// 移行戦略:
// Phase 1: 並行運用（両方に書き込み、DOから優先読み取り）
// Phase 2: DOのみ書き込み（KV読み取りフォールバック）
// Phase 3: KV完全削除

// packages/shared/src/utils/kv.ts

export async function storeAuthCodeMigration(
  env: Env,
  code: string,
  data: AuthCodeData,
  useDO: boolean = true
): Promise<void> {
  if (useDO && env.AUTH_CODE_STORE) {
    // 新方式: Durable Object
    const doId = env.AUTH_CODE_STORE.idFromName('default');
    const doStub = env.AUTH_CODE_STORE.get(doId);
    await doStub.fetch(
      new Request('http://internal/code', {
        method: 'POST',
        body: JSON.stringify({ code, ...data }),
      })
    );
  } else {
    // 旧方式: KV（後方互換性）
    await storeAuthCode(env, code, data);
  }
}
```

---

## 3. 実装優先順位

### Priority 1: クリティカルセキュリティ修正

#### 3.1 認可コードのDO移行 (推定工数: 2-3日)

**タスク**:
1. `authorize.ts` の修正 - AuthorizationCodeStore DO使用
2. `token.ts` の修正 - consumeCode() API使用
3. `AuthorizationCodeStore.ts` の拡張 - PKCE検証、再利用検出
4. 統合テスト - 認可フロー全体
5. セキュリティテスト - 再利用攻撃シナリオ

**ファイル変更**:
- `packages/op-auth/src/authorize.ts`
- `packages/op-token/src/token.ts`
- `packages/shared/src/durable-objects/AuthorizationCodeStore.ts`
- `test/integration/authorization-code-flow.test.ts` (新規)

#### 3.2 KVキャッシュ無効化修正 (推定工数: 1日)

**タスク**:
1. `cloudflare-adapter.ts` の修正 - Delete-Then-Write
2. エラーハンドリング追加
3. 統合テスト - クライアント更新フロー

**ファイル変更**:
- `packages/shared/src/storage/adapters/cloudflare-adapter.ts`
- `test/integration/client-cache.test.ts` (新規)

---

### Priority 2: 信頼性向上

#### 3.3 D1書き込みリトライロジック (推定工数: 3-4日)

**タスク**:
1. `SessionStore.ts` の修正 - リトライキュー実装
2. 監視ユーティリティ作成 - `monitoring.ts`
3. アラート統合 - Cloudflare Analytics Engine
4. 統合テスト - 失敗シナリオ
5. 負荷テスト - キューパフォーマンス

**ファイル変更**:
- `packages/shared/src/durable-objects/SessionStore.ts`
- `packages/shared/src/utils/monitoring.ts` (新規)
- `test/durable-objects/SessionStore.retry.test.ts` (新規)

---

### Priority 3: 観測性とドキュメント

#### 3.4 一貫性レベルの明示化 (推定工数: 2日)

**タスク**:
1. インターフェース拡張 - `WriteOptions`
2. ドキュメント作成 - 一貫性モデル説明
3. クライアントガイド - 各操作の保証レベル

**ファイル変更**:
- `packages/shared/src/storage/interfaces.ts`
- `docs/architecture/consistency-model.md` (新規)

---

## 4. テスト戦略

### 4.1 ユニットテスト

```typescript
// test/durable-objects/SessionStore.retry.test.ts

describe('SessionStore - Retry Logic', () => {
  it('should retry D1 writes on failure', async () => {
    const mockD1 = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn()
            .mockRejectedValueOnce(new Error('D1 unavailable'))
            .mockRejectedValueOnce(new Error('D1 unavailable'))
            .mockResolvedValueOnce({}),
        }),
      }),
    };

    const store = new SessionStore(state, { ...env, DB: mockD1 });
    const session = await store.createSession('user_123', 3600);

    // メモリには即座に保存されている
    expect(store.sessions.has(session.id)).toBe(true);

    // リトライ処理を待つ
    await waitForQueueProcessing(store);

    // 最終的にD1書き込み成功
    expect(mockD1.prepare).toHaveBeenCalledTimes(3);
  });

  it('should alert after max retries', async () => {
    const mockD1 = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockRejectedValue(new Error('D1 down')),
        }),
      }),
    };

    const alertSpy = vi.fn();
    const store = new SessionStore(state, { ...env, DB: mockD1 }, { onAlert: alertSpy });

    await store.createSession('user_123', 3600);
    await waitForQueueProcessing(store, 10000); // 最大10秒待機

    // アラート送信確認
    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'D1_WRITE_FAILURE',
        severity: 'critical',
      })
    );
  });
});
```

### 4.2 統合テスト

```typescript
// test/integration/authorization-code-flow.test.ts

describe('Authorization Code Flow - Race Condition', () => {
  it('should prevent code reuse across multiple requests', async () => {
    // 1. 認可コード取得
    const authResponse = await app.request('/authorize', {
      method: 'GET',
      query: {
        client_id: 'test_client',
        redirect_uri: 'https://example.com/callback',
        response_type: 'code',
        scope: 'openid',
      },
    });

    const location = new URL(authResponse.headers.get('Location')!);
    const code = location.searchParams.get('code')!;

    // 2. 並行してトークンリクエスト（競合状態シミュレーション）
    const [response1, response2] = await Promise.all([
      app.request('/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: 'test_client',
          client_secret: 'secret',
        }),
      }),
      app.request('/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: 'test_client',
          client_secret: 'secret',
        }),
      }),
    ]);

    // 3. 検証: 1つだけ成功、もう1つは失敗
    const results = [response1, response2].map(r => r.status);
    expect(results).toContain(200); // 1つは成功
    expect(results).toContain(400); // 1つは失敗
    expect(results.filter(s => s === 200).length).toBe(1); // 成功は1つだけ
  });
});
```

### 4.3 負荷テスト

```typescript
// test/load/cache-invalidation.test.ts

describe('Client Cache Invalidation - Load Test', () => {
  it('should handle concurrent reads during cache invalidation', async () => {
    const clientId = 'load_test_client';

    // 100並行リクエスト
    const reads = Array.from({ length: 100 }, () =>
      app.request(`/clients/${clientId}`, { method: 'GET' })
    );

    // 読み取り中にクライアント更新
    const update = app.request(`/clients/${clientId}`, {
      method: 'PUT',
      body: JSON.stringify({ client_name: 'Updated Name' }),
    });

    const [updateResponse, ...readResponses] = await Promise.all([update, ...reads]);

    // 検証
    expect(updateResponse.status).toBe(200);

    // 全ての読み取りが成功（古いか新しいデータ）
    for (const response of readResponses) {
      expect(response.status).toBe(200);
      const data = await response.json();
      // データは一貫している（古いか新しいか、どちらか）
      expect(['Old Name', 'Updated Name']).toContain(data.client_name);
    }

    // 更新後の読み取りは必ず新しいデータ
    const finalRead = await app.request(`/clients/${clientId}`);
    const finalData = await finalRead.json();
    expect(finalData.client_name).toBe('Updated Name');
  });
});
```

---

## 5. マイグレーション計画

### 5.1 認可コードのDO移行

**段階的ロールアウト**:

```typescript
// 環境変数でフィーチャーフラグ制御
const USE_AUTH_CODE_DO = env.FEATURE_AUTH_CODE_DO === 'true';

if (USE_AUTH_CODE_DO) {
  // 新方式: Durable Object
  await storeCodeInDO(env, code, data);
} else {
  // 旧方式: KV
  await storeAuthCode(env, code, data);
}
```

**ロールアウトステージ**:
1. **Stage 1** (1週間): 開発環境でDO有効化、テスト
2. **Stage 2** (1週間): Canary環境で5%トラフィック
3. **Stage 3** (1週間): Canary環境で50%トラフィック
4. **Stage 4** (1週間): 本番環境で100%
5. **Stage 5** (2週間後): KV AUTH_CODES削除

### 5.2 モニタリング指標

```typescript
// メトリクス収集
interface StorageMetrics {
  // D1書き込み
  d1_write_success: number;
  d1_write_failure: number;
  d1_write_retry_count: number;
  d1_write_latency_ms: number;

  // KVキャッシュ
  kv_cache_hit_rate: number;
  kv_cache_invalidation_latency_ms: number;

  // 認可コード
  auth_code_reuse_detected: number;
  auth_code_do_latency_ms: number;
}

// Cloudflare Workers Analytics Engine
await env.ANALYTICS.writeDataPoint({
  blobs: ['d1_write', 'success'],
  doubles: [latency],
  indexes: ['session_create'],
});
```

---

## 6. リスクと軽減策

### 6.1 リトライキューのメモリ使用

**リスク**: キューサイズが大きくなりすぎてメモリ不足

**軽減策**:
- 最大キューサイズ制限（例: 1000アイテム）
- 古いアイテムのデッドレターキュー移動
- メトリクス監視: `queue_size` アラート

```typescript
private readonly MAX_QUEUE_SIZE = 1000;

async queueD1Write(operation, session): Promise<void> {
  if (this.writeQueue.size >= this.MAX_QUEUE_SIZE) {
    // デッドレターキューへ移動
    await this.moveToDeadLetterQueue(this.writeQueue.entries().next().value);
  }
  // ...
}
```

### 6.2 Durable Objectのスケーラビリティ

**リスク**: 単一DO インスタンスがボトルネック

**軽減策**:
- シャーディング戦略: ユーザーIDベースで複数DOに分散
- 監視: リクエストレート、レイテンシ

```typescript
// シャーディング例
const shard = hashUserId(userId) % 10; // 10シャード
const doId = env.SESSION_STORE.idFromName(`shard_${shard}`);
```

### 6.3 D1書き込み遅延の累積

**リスク**: リトライが多すぎて遅延が増大

**軽減策**:
- バックオフ上限設定（最大30秒）
- D1ヘルスチェック: 継続的障害時はアラート + 緊急対応

---

## 7. 結論

本設計により、以下の一貫性保証が実現されます：

### 改善後の一貫性モデル

| 操作 | ストレージ | 一貫性レベル | 保証内容 |
|------|-----------|-------------|---------|
| **セッション作成** | DO + D1 (Queue) | Strong (DO) + Eventual (D1) | メモリ即座、D1はリトライ保証 ✅ |
| **セッション無効化** | DO + D1 (Queue) | Strong | 即座削除、D1はベストエフォート ✅ |
| **認可コード保存** | DO | Strong | ワンタイムユース保証 ✅ |
| **認可コード消費** | DO | Strong | アトミック操作、再利用検出 ✅ |
| **クライアント更新** | D1 + KV | Strong | Delete-Then-Write、不整合窓なし ✅ |
| **トークンローテーション** | DO | Strong | アトミック、盗難検出 ✅ (既存) |

### 次のステップ

1. ✅ 本設計ドキュメントのレビュー
2. 🔧 Priority 1タスクの実装開始
3. 🧪 統合テスト・セキュリティテスト
4. 📊 モニタリング・アラート設定
5. 🚀 段階的ロールアウト

---

## 付録

### A. 参考資料

- [RFC 6749 - OAuth 2.0](https://datatracker.ietf.org/doc/html/rfc6749)
- [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)
- [Cloudflare Durable Objects Documentation](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare KV Consistency Model](https://developers.cloudflare.com/kv/reference/kv-consistency/)

### B. 変更履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|---------|
| 2025-11-15 | 1.0 | 初版作成 |

