# UserCache Architecture

## Overview

UserCacheは、ユーザーメタデータのRead-Throughキャッシュ実装です。D1からの読み取りを最小化し、Token Endpointなどのホットパスにおけるレイテンシを削減します。

**設計原則:**
- Read-Through パターン（Cache miss時にD1から自動取得）
- 1時間TTL + Invalidation Hook
- KV Namespace を使用（`USER_CACHE`）
- Policy Cache とは分離（別のTTL要件）

---

## アーキテクチャ

```
┌─────────────┐     Cache Hit      ┌─────────────┐
│  op-token   │ ←───────────────── │  USER_CACHE │
│  (Worker)   │                    │    (KV)     │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │ Cache Miss                       │ Invalidation
       ▼                                  │
┌─────────────┐                    ┌──────┴──────┐
│     D1      │                    │op-management│
│  (users)    │                    │   (Admin)   │
└─────────────┘                    └─────────────┘
```

---

## データ構造

### CachedUser Interface

```typescript
interface CachedUser {
  id: string;
  email: string;
  email_verified: boolean;
  name: string | null;
  given_name: string | null;
  family_name: string | null;
  nickname: string | null;
  preferred_username: string | null;
  picture: string | null;
  locale: string | null;
  zoneinfo: string | null;
  phone_number: string | null;
  phone_number_verified: boolean;
  address: string | null;
  birthdate: string | null;
  gender: string | null;
  updated_at: number | null;
}
```

### KV Key Format

```
user:{userId}
```

例: `user:550e8400-e29b-41d4-a716-446655440000`

---

## TTL 設計

| キャッシュ | TTL | 理由 |
|-----------|-----|------|
| UserCache | 1時間 | Invalidation Hookがあるため長めでも安全 |
| PolicyCache | 5分 | 頻繁に変更される可能性、invalidation hookなし |
| SigningKeyCache | 10分 | 鍵ローテーション対応 |

**1時間TTLの根拠:**
- ユーザー情報の更新頻度は低い（プロフィール編集は稀）
- Invalidation Hookにより更新時は即座にキャッシュクリア
- Token Endpoint の p95 レイテンシ削減効果が大きい

---

## API

### getCachedUser

```typescript
async function getCachedUser(
  env: Env,
  userId: string
): Promise<CachedUser | null>
```

**動作:**
1. `USER_CACHE.get(`user:${userId}`)` を試行
2. Cache hit → パース して返却
3. Cache miss → D1 から取得 → KV に保存（1時間TTL） → 返却
4. D1 にも存在しない → `null` 返却

**使用例:**
```typescript
// op-token/token.ts
const user = await getCachedUser(c.env, userId);
if (!user) {
  return c.json({ error: 'invalid_grant', error_description: 'User not found' }, 400);
}

// ID Token claims に使用
const idTokenClaims = {
  sub: user.id,
  email: user.email,
  email_verified: user.email_verified,
  name: user.name,
  // ...
};
```

### invalidateUserCache

```typescript
async function invalidateUserCache(
  env: Env,
  userId: string
): Promise<void>
```

**動作:**
1. `USER_CACHE.delete(`user:${userId}`)` を実行
2. 存在しなくても成功（冪等性）

**使用例:**
```typescript
// op-management/admin.ts - ユーザー更新後
await invalidateUserCache(env, userId);
```

---

## Invalidation Hook 設置箇所

### op-management/admin.ts

| エンドポイント | タイミング |
|---------------|-----------|
| `PATCH /api/admin/users/:id` | ユーザー情報更新後 |
| `PUT /api/admin/users/:id/avatar` | アバターアップロード後 |
| `DELETE /api/admin/users/:id/avatar` | アバター削除後 |

### op-management/scim.ts

| エンドポイント | タイミング |
|---------------|-----------|
| `PUT /scim/v2/Users/:id` | SCIM Replace 後 |
| `PATCH /scim/v2/Users/:id` | SCIM Modify 後 |

**実装パターン:**
```typescript
// admin.ts
app.patch('/api/admin/users/:id', async (c) => {
  // ... ユーザー更新処理 ...

  // Invalidation Hook
  await invalidateUserCache(c.env, userId);

  return c.json(updatedUser);
});
```

---

## 実装コード

### kv.ts

```typescript
// packages/shared/src/utils/kv.ts

const USER_CACHE_TTL = 3600; // 1 hour

export interface CachedUser {
  id: string;
  email: string;
  email_verified: boolean;
  name: string | null;
  // ... (全フィールド)
}

export async function getCachedUser(
  env: Env,
  userId: string
): Promise<CachedUser | null> {
  // 1. Try cache first
  if (env.USER_CACHE) {
    const cached = await env.USER_CACHE.get(`user:${userId}`);
    if (cached) {
      return JSON.parse(cached) as CachedUser;
    }
  }

  // 2. Cache miss - fetch from D1
  if (!env.DB) {
    return null;
  }

  const user = await env.DB.prepare(
    `SELECT id, email, email_verified, name, given_name, family_name,
            nickname, preferred_username, picture, locale, zoneinfo,
            phone_number, phone_number_verified, address, birthdate, gender, updated_at
     FROM users WHERE id = ?`
  ).bind(userId).first<CachedUser>();

  if (!user) {
    return null;
  }

  // 3. Store in cache
  if (env.USER_CACHE) {
    await env.USER_CACHE.put(
      `user:${userId}`,
      JSON.stringify(user),
      { expirationTtl: USER_CACHE_TTL }
    );
  }

  return user;
}

export async function invalidateUserCache(
  env: Env,
  userId: string
): Promise<void> {
  if (env.USER_CACHE) {
    await env.USER_CACHE.delete(`user:${userId}`);
  }
}
```

---

## 環境変数設定

### wrangler.toml

```toml
# op-token
[[kv_namespaces]]
binding = "USER_CACHE"
id = "xxx"

# op-management
[[kv_namespaces]]
binding = "USER_CACHE"
id = "xxx"
```

### Env Type

```typescript
// packages/shared/src/types/env.ts
export interface Env {
  // ...
  USER_CACHE?: KVNamespace;
}
```

---

## パフォーマンス効果

### Before (D1 直接アクセス)

```
Token Endpoint Latency:
├── DO Wall Time: ~15ms
├── D1 Read (user): ~150ms ← ボトルネック
├── JWT Sign: ~5ms
└── Total: ~170ms
```

### After (UserCache)

```
Token Endpoint Latency:
├── DO Wall Time: ~15ms
├── KV Read (cache hit): ~5ms ← 大幅改善
├── JWT Sign: ~5ms
└── Total: ~25ms
```

**キャッシュヒット率の期待値:**
- 同一ユーザーの連続リクエスト: 99%+
- 1時間以内のリクエスト: 95%+
- 全体: 80-90%

---

## 注意事項

### 1. キャッシュの一貫性

Invalidation Hookを必ず設置すること。設置漏れがあると、古いユーザー情報がID Tokenに含まれる可能性があります。

**チェックリスト:**
- [ ] `PATCH /api/admin/users/:id`
- [ ] `PUT /api/admin/users/:id/avatar`
- [ ] `DELETE /api/admin/users/:id/avatar`
- [ ] `PUT /scim/v2/Users/:id`
- [ ] `PATCH /scim/v2/Users/:id`

### 2. 新規エンドポイント追加時

ユーザー情報を更新する新しいエンドポイントを追加する場合は、必ず `invalidateUserCache()` を呼び出すこと。

### 3. TTL と Invalidation の併用

- TTL: 最悪ケースの古さを制限（1時間）
- Invalidation: 通常ケースでの即時反映

両方を組み合わせることで、安全性とパフォーマンスを両立。

### 4. Policy Cache との分離

UserCache と PolicyCache は別々のKV Namespaceを使用：
- `USER_CACHE`: ユーザーメタデータ（1時間TTL）
- `POLICY_CACHE`: ポリシー設定（5分TTL）

分離理由:
- 異なる更新頻度
- 異なるinvalidation要件
- 障害分離

---

## 監視とデバッグ

### KV メトリクス

Cloudflare Dashboard で確認:
- Cache hit rate
- Read/Write operations
- Storage usage

### ログ

```typescript
// デバッグログ（本番では無効化推奨）
console.log(`UserCache: ${cached ? 'HIT' : 'MISS'} for ${userId}`);
```

### トラブルシューティング

**症状: 古いユーザー情報が返される**
1. Invalidation Hookの設置を確認
2. KV の `user:{userId}` エントリを手動削除
3. TTL 経過を待つ（最大1時間）

**症状: キャッシュミスが多い**
1. KV Namespace のバインディングを確認
2. `USER_CACHE` が undefined でないことを確認
3. D1 クエリが正常に動作することを確認
