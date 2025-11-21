# Storage Abstraction Layer

Phase 5で実装された統合ストレージ抽象化層です。Cloudflare Workers環境（D1、KV、Durable Objects）に対応した統一的なインターフェースを提供します。

## 概要

ストレージ抽象化層は、複数のストレージバックエンドを統合し、インテリジェントなルーティングロジックを提供します。

### ルーティング戦略

| プレフィックス | ルーティング先 | 説明 |
|---------------|--------------|------|
| `session:*` | SessionStore Durable Object + D1 fallback | ホットデータはDO、コールドデータはD1 |
| `client:*` | D1 + KVキャッシュ | リードスルーキャッシュパターン |
| `user:*` | D1 Database | ユーザーデータ |
| `authcode:*` | AuthorizationCodeStore Durable Object | ワンタイムユーザー保証 |
| `refreshtoken:*` | RefreshTokenRotator Durable Object | アトミックローテーション |
| その他 | KV Storage | フォールバック |

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                  CloudflareStorageAdapter                    │
│                    (Unified Interface)                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
    ┌─────────┐     ┌─────────┐   ┌─────────────┐
    │   D1    │     │   KV    │   │   Durable   │
    │Database │     │ Storage │   │   Objects   │
    └─────────┘     └─────────┘   └─────────────┘
         │               │               │
         │               │               ├─ SessionStore
         │               │               ├─ AuthCodeStore
         │               │               └─ RefreshTokenRotator
         │               │
    ┌────▼────┐     ┌────▼────┐
    │ Users   │     │ Cache   │
    │ Clients │     │         │
    │ Passkeys│     └─────────┘
    └─────────┘
```

## 使用方法

### 基本的な使い方

```typescript
import { createStorageAdapter } from '@authrim/shared/storage/adapters/cloudflare-adapter';
import type { Env } from '@authrim/shared/types/env';

// ハンドラー内でストレージアダプターを作成
export default {
  async fetch(request: Request, env: Env) {
    const { adapter, userStore, clientStore, sessionStore, passkeyStore } = createStorageAdapter(env);

    // ユーザーを取得
    const user = await userStore.get('user_123');

    // クライアントを取得（D1 + KVキャッシュ）
    const client = await clientStore.get('client_abc');

    // セッションを作成（Durable Object + D1）
    const session = await sessionStore.create({
      user_id: 'user_123',
      data: { amr: ['pwd'] },
    });

    return new Response('OK');
  },
};
```

### IStorageAdapterインターフェース

低レベルAPIを使用する場合:

```typescript
// キーベースのアクセス（自動ルーティング）
const value = await adapter.get('client:test-client');
await adapter.set('custom:key', 'value', 3600); // TTL: 1 hour
await adapter.delete('session:abc123');

// D1 SQLクエリ
const users = await adapter.query<User>('SELECT * FROM users WHERE email = ?', ['user@example.com']);
await adapter.execute('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
```

### ストア別API

#### UserStore

```typescript
// ユーザーを取得
const user = await userStore.get('user_123');
const userByEmail = await userStore.getByEmail('user@example.com');

// ユーザーを作成
const newUser = await userStore.create({
  email: 'newuser@example.com',
  name: 'New User',
});

// ユーザーを更新
const updated = await userStore.update('user_123', {
  name: 'Updated Name',
});

// ユーザーを削除
await userStore.delete('user_123');
```

#### ClientStore

```typescript
// クライアントを取得（自動キャッシュ）
const client = await clientStore.get('client_abc');

// クライアントを作成
const newClient = await clientStore.create({
  client_id: 'new-client',
  client_name: 'New Client App',
  redirect_uris: ['https://example.com/callback'],
  grant_types: ['authorization_code'],
  response_types: ['code'],
});

// クライアントを更新（キャッシュ無効化）
const updated = await clientStore.update('client_abc', {
  client_name: 'Updated Client Name',
});

// クライアント一覧を取得
const clients = await clientStore.list({ limit: 10, offset: 0 });
```

#### SessionStore

```typescript
// セッションを取得（Durable Object → D1フォールバック）
const session = await sessionStore.get('session_abc123');

// セッションを作成（Durable Object + D1）
const newSession = await sessionStore.create({
  user_id: 'user_123',
  data: { amr: ['pwd', 'mfa'] },
});

// セッションを無効化
await sessionStore.delete('session_abc123');

// ユーザーの全セッションを取得
const sessions = await sessionStore.listByUser('user_123');

// セッション有効期限を延長（Active TTL）
const extended = await sessionStore.extend('session_abc123', 3600); // +1 hour
```

#### PasskeyStore

```typescript
// Passkeyを取得
const passkey = await passkeyStore.getByCredentialId('cred_abc123');

// ユーザーの全Passkeyを取得
const passkeys = await passkeyStore.listByUser('user_123');

// Passkeyを作成
const newPasskey = await passkeyStore.create({
  user_id: 'user_123',
  credential_id: 'cred_xyz789',
  public_key: 'MFkwEwYHKo...',
  counter: 0,
  device_name: 'iPhone 15',
});

// Passkeyカウンターを更新（リプレイアタック防止）
const updated = await passkeyStore.updateCounter('passkey_123', 5);
```

## インターフェース

### IStorageAdapter

統一的なストレージアダプターインターフェース。キーベースのアクセスとD1 SQLクエリをサポート。

### IUserStore

ユーザー管理用のストアインターフェース。

### IClientStore

OAuthクライアント管理用のストアインターフェース。

### ISessionStore

セッション管理用のストアインターフェース。

### IPasskeyStore

Passkey（WebAuthn）管理用のストアインターフェース。

## パフォーマンス最適化

### リードスルーキャッシュ（Client）

```
1. KVキャッシュをチェック → ヒット? 返却
2. キャッシュミス → D1クエリ
3. D1結果をKVにキャッシュ（TTL: 5分）
4. 結果を返却
```

### ホット/コールドパターン（Session）

```
1. Durable Object（ホット）をチェック → ヒット? 返却
2. D1（コールド）をチェック → ヒット? DOに昇格
3. 結果を返却
```

### ワンタイムユーザー保証（AuthCode）

Authorization Codeは、Durable Objectsの強い一貫性保証により、ワンタイムユーザーが保証されます。リプレイアタックを防止します。

## テスト

ユニットテストは、37個のテストケースで以下をカバーしています:

- ルーティングロジック（6テスト）
- Set/Deleteオペレーション（6テスト）
- SQLオペレーション（2テスト）
- UserStore（6テスト）
- ClientStore（5テスト）
- SessionStore（6テスト）
- PasskeyStore（5テスト）
- ファクトリー関数（1テスト）

```bash
pnpm test src/storage/adapters/__tests__/cloudflare-adapter.test.ts
```

## 参考資料

- [Storage Strategy](../../../docs/architecture/storage-strategy.md)
- [Database Schema](../../../docs/architecture/database-schema.md)
- [Durable Objects](../../../docs/architecture/durable-objects.md)
- [Phase 5 Planning](../../../docs/project-management/PHASE5_PLANNING.md)
