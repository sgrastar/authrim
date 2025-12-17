# PII/Non-PII 分離 - コード移行ガイド

このドキュメントは、既存コードを新しいRepository/Contextパターンに移行するためのガイドです。

## 概要

### 移行の目的

1. **型安全性**: 直接SQLの代わりにRepositoryを使用
2. **PII分離**: PIIアクセスを型レベルで制御
3. **パーティション対応**: 将来のリージョン別DB分離に対応
4. **キャッシュ統合**: KVキャッシュを一元管理

### 移行対象ファイル

| ファイル | 直接SQL数 | 優先度 |
|---------|----------|--------|
| `packages/op-management/src/admin.ts` | 47+ | 高 |
| `packages/op-token/src/token.ts` | 10+ | 高 |
| `packages/op-auth/src/authorize.ts` | 5+ | 中 |
| `packages/external-idp/src/services/linked-identity-store.ts` | 8+ | 中 |
| `packages/shared/src/storage/adapters/cloudflare-adapter.ts` | 10+ | 中 |

## 移行パターン

### Before: 直接SQL

```typescript
// 旧コード: 直接D1を使用
export async function getUserById(c: Context, userId: string) {
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(userId)
    .first();
  return user;
}
```

### After: Repository経由

```typescript
// 新コード: Repository + Context経由
export async function getUserById(ctx: AuthContext, userId: string) {
  // Non-PIIのみ
  const userCore = await ctx.repositories.userCore.findById(userId);
  return userCore;
}

// PIIが必要な場合
export async function getUserWithPII(ctx: PIIContext, userId: string) {
  // 1. Coreデータを取得
  const userCore = await ctx.repositories.userCore.findById(userId);
  if (!userCore) return null;

  // 2. PIIパーティションに応じたアダプターを取得
  const piiAdapter = ctx.getPiiAdapter(userCore.pii_partition);

  // 3. PIIデータを取得
  const userPII = await ctx.piiRepositories.userPII.findByUserId(userId, piiAdapter);

  return { ...userCore, ...userPII };
}
```

## セットアップ

### 1. ContextFactory の初期化

```typescript
// packages/op-auth/src/index.ts (例)
import { Hono } from 'hono';
import {
  ContextFactory,
  createD1Adapter,
  createPIIPartitionRouter,
} from '@authrim/shared';

const app = new Hono<{ Bindings: Env }>();

// ミドルウェアでContextFactoryを設定
app.use('*', async (c, next) => {
  const coreAdapter = createD1Adapter(c.env.DB, 'core');
  const piiAdapter = createD1Adapter(c.env.DB_PII, 'pii');
  const partitionRouter = createPIIPartitionRouter(
    coreAdapter,
    piiAdapter,
    undefined, // 追加パーティションなし
    c.env.AUTHRIM_CONFIG
  );

  c.set('contextFactory', new ContextFactory({
    coreAdapter,
    defaultPiiAdapter: piiAdapter,
    partitionRouter,
  }));

  await next();
});

// ルートハンドラー
app.get('/userinfo', async (c) => {
  const factory = c.get('contextFactory');
  const ctx = factory.createPIIContext(c);
  // PIIContextを使用してユーザー情報を取得
  // ...
});
```

### 2. Env型の更新

```typescript
// packages/shared/src/types/env.ts
export interface Env {
  // 既存
  DB: D1Database;

  // 新規追加
  DB_PII: D1Database;  // PII専用D1

  // 将来のリージョン別DB (オプション)
  // DB_PII_EU?: D1Database;
  // DB_PII_APAC?: D1Database;
  // HYPERDRIVE_PII_ACME?: Hyperdrive;
}
```

## 移行手順

### ステップ1: Contextの導入

1. ハンドラーの引数を `Context` から `AuthContext` または `PIIContext` に変更
2. `c.env.DB.prepare(...)` を `ctx.repositories.*` に置き換え

### ステップ2: PIIアクセスの分離

1. PIIを扱うハンドラーを特定
2. `AuthContext` → `PIIContext` に型を変更
3. ユーザー取得を2段階に分割:
   - `userCore` (Core DB)
   - `userPII` (PII DB, パーティション対応)

### ステップ3: キャッシュの統合

```typescript
// Before: 個別のKVアクセス
const cached = await c.env.USER_CACHE.get(`user:${userId}`);
if (cached) return JSON.parse(cached);
const user = await c.env.DB.prepare('SELECT ...').first();
await c.env.USER_CACHE.put(`user:${userId}`, JSON.stringify(user));

// After: CacheRepository経由
const user = await ctx.cache.getOrFetchUserCore(userId, async () => {
  return ctx.repositories.userCore.findById(userId);
});
```

## 移行チェックリスト

### admin.ts 移行

- [ ] ユーザー一覧取得 → `userCore.searchUsers()`
- [ ] ユーザー作成 → `userCore.createUser()` + `userPII.createPII()`
- [ ] ユーザー更新 → 該当リポジトリの `update()`
- [ ] ユーザー削除 → `tombstone.createTombstone()` + soft delete
- [ ] クライアント操作 → ClientRepository (将来実装)

### token.ts 移行

- [ ] ユーザー検証 → `userCore.findById()`
- [ ] パスワード検証 → `userCore.findById()` (password_hash)
- [ ] 最終ログイン更新 → `userCore.updateLastLogin()`

### authorize.ts 移行

- [ ] セッション検証 → SessionRepository (将来実装)
- [ ] クライアント検証 → ClientRepository (将来実装)

## 注意事項

### Cross-DB整合性

PII分離後は、Core DBとPII DBの間でトランザクションが使えません。
`pii_status` フィールドで状態を管理します:

```
pending → active (PII書き込み成功)
pending → failed (PII書き込み失敗)
active → deleted (GDPR削除)
```

失敗した場合は Admin API でリトライ可能です。

### GDPR削除フロー

```typescript
async function deleteUserWithGDPR(ctx: PIIContext, userId: string, actor: string) {
  const userCore = await ctx.repositories.userCore.findById(userId);
  if (!userCore) throw new NotFoundError();

  const piiAdapter = ctx.getPiiAdapter(userCore.pii_partition);

  // 1. Tombstone作成 (削除記録)
  const pii = await ctx.piiRepositories.userPII.findByUserId(userId, piiAdapter);
  await ctx.piiRepositories.tombstone.createTombstone({
    id: userId,
    tenant_id: userCore.tenant_id,
    email_blind_index: pii?.email_blind_index,
    deleted_by: actor,
    deletion_reason: 'user_request',
  }, piiAdapter);

  // 2. PII削除
  await ctx.piiRepositories.userPII.deletePII(userId, piiAdapter);

  // 3. Core更新
  await ctx.repositories.userCore.updatePIIStatus(userId, 'deleted');
}
```

## 移行スケジュール (推奨)

| 週 | 作業内容 |
|---|---------|
| 1日目 | admin.ts: ユーザー一覧・詳細取得 |
| 2日目 | admin.ts: ユーザー作成・更新 |
| 3日目 | admin.ts: ユーザー削除・GDPR対応 |
| 4日目 | token.ts: 認証フロー |
| 5日目 | authorize.ts, external-idp |
| 6-7日目 | テスト・デバッグ・ドキュメント |

## 関連ファイル

- `packages/shared/src/db/adapter.ts` - DatabaseAdapterインターフェース
- `packages/shared/src/db/partition-router.ts` - PIIPartitionRouter
- `packages/shared/src/repositories/` - Repositoryクラス群
- `packages/shared/src/context/` - Context型とFactory
- `migrations/007_pii_separation_core.sql` - Core DBスキーマ
- `migrations/pii/001_pii_initial.sql` - PII DBスキーマ
