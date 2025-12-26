# PII/Non-PII Separation - Code Migration Guide

This document is a guide for migrating existing code to the new Repository/Context pattern.

## Overview

### Migration Goals

1. **Type Safety**: Use Repository instead of direct SQL
2. **PII Separation**: Control PII access at the type level
3. **Partition Support**: Support future region-based DB separation
4. **Cache Integration**: Centralized KV cache management

### Files to Migrate

| File                                                          | Direct SQL Count | Priority |
| ------------------------------------------------------------- | ---------------- | -------- |
| `packages/op-management/src/admin.ts`                         | 47+              | High     |
| `packages/op-token/src/token.ts`                              | 10+              | High     |
| `packages/op-auth/src/authorize.ts`                           | 5+               | Medium   |
| `packages/external-idp/src/services/linked-identity-store.ts` | 8+               | Medium   |
| `packages/shared/src/storage/adapters/cloudflare-adapter.ts`  | 10+              | Medium   |

## Migration Pattern

### Before: Direct SQL

```typescript
// Old code: Direct D1 usage
export async function getUserById(c: Context, userId: string) {
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  return user;
}
```

### After: Via Repository

```typescript
// New code: Via Repository + Context
export async function getUserById(ctx: AuthContext, userId: string) {
  // Non-PII only
  const userCore = await ctx.repositories.userCore.findById(userId);
  return userCore;
}

// When PII is needed
export async function getUserWithPII(ctx: PIIContext, userId: string) {
  // 1. Get Core data
  const userCore = await ctx.repositories.userCore.findById(userId);
  if (!userCore) return null;

  // 2. Get adapter according to PII partition
  const piiAdapter = ctx.getPiiAdapter(userCore.pii_partition);

  // 3. Get PII data
  const userPII = await ctx.piiRepositories.userPII.findByUserId(userId, piiAdapter);

  return { ...userCore, ...userPII };
}
```

## Setup

### 1. ContextFactory Initialization

```typescript
// packages/op-auth/src/index.ts (example)
import { Hono } from 'hono';
import { ContextFactory, createD1Adapter, createPIIPartitionRouter } from '@authrim/shared';

const app = new Hono<{ Bindings: Env }>();

// Set up ContextFactory in middleware
app.use('*', async (c, next) => {
  const coreAdapter = createD1Adapter(c.env.DB, 'core');
  const piiAdapter = createD1Adapter(c.env.DB_PII, 'pii');
  const partitionRouter = createPIIPartitionRouter(
    coreAdapter,
    piiAdapter,
    undefined, // No additional partitions
    c.env.AUTHRIM_CONFIG
  );

  c.set(
    'contextFactory',
    new ContextFactory({
      coreAdapter,
      defaultPiiAdapter: piiAdapter,
      partitionRouter,
    })
  );

  await next();
});

// Route handler
app.get('/userinfo', async (c) => {
  const factory = c.get('contextFactory');
  const ctx = factory.createPIIContext(c);
  // Use PIIContext to get user information
  // ...
});
```

### 2. Update Env Type

```typescript
// packages/shared/src/types/env.ts
export interface Env {
  // Existing
  DB: D1Database;

  // New additions
  DB_PII: D1Database; // PII-dedicated D1

  // Future region-based DB (optional)
  // DB_PII_EU?: D1Database;
  // DB_PII_APAC?: D1Database;
  // HYPERDRIVE_PII_ACME?: Hyperdrive;
}
```

## Migration Steps

### Step 1: Introduce Context

1. Change handler arguments from `Context` to `AuthContext` or `PIIContext`
2. Replace `c.env.DB.prepare(...)` with `ctx.repositories.*`

### Step 2: Separate PII Access

1. Identify handlers that deal with PII
2. Change type from `AuthContext` → `PIIContext`
3. Split user retrieval into two stages:
   - `userCore` (Core DB)
   - `userPII` (PII DB, partition-aware)

### Step 3: Integrate Cache

```typescript
// Before: Individual KV access
const cached = await c.env.USER_CACHE.get(`user:${userId}`);
if (cached) return JSON.parse(cached);
const user = await c.env.DB.prepare('SELECT ...').first();
await c.env.USER_CACHE.put(`user:${userId}`, JSON.stringify(user));

// After: Via CacheRepository
const user = await ctx.cache.getOrFetchUserCore(userId, async () => {
  return ctx.repositories.userCore.findById(userId);
});
```

## Migration Checklist

### admin.ts Migration

- [ ] User list retrieval → `userCore.searchUsers()`
- [ ] User creation → `userCore.createUser()` + `userPII.createPII()`
- [ ] User update → `update()` on appropriate repository
- [ ] User deletion → `tombstone.createTombstone()` + soft delete
- [ ] Client operations → ClientRepository (future implementation)

### token.ts Migration

- [ ] User verification → `userCore.findById()`
- [ ] Password verification → `userCore.findById()` (password_hash)
- [ ] Last login update → `userCore.updateLastLogin()`

### authorize.ts Migration

- [ ] Session verification → SessionRepository (future implementation)
- [ ] Client verification → ClientRepository (future implementation)

## Notes

### Cross-DB Consistency

After PII separation, transactions cannot be used between Core DB and PII DB.
State is managed using the `pii_status` field:

```
pending → active (PII write succeeded)
pending → failed (PII write failed)
active → deleted (GDPR deletion)
```

In case of failure, retry is possible via Admin API.

### GDPR Deletion Flow

```typescript
async function deleteUserWithGDPR(ctx: PIIContext, userId: string, actor: string) {
  const userCore = await ctx.repositories.userCore.findById(userId);
  if (!userCore) throw new NotFoundError();

  const piiAdapter = ctx.getPiiAdapter(userCore.pii_partition);

  // 1. Create Tombstone (deletion record)
  const pii = await ctx.piiRepositories.userPII.findByUserId(userId, piiAdapter);
  await ctx.piiRepositories.tombstone.createTombstone(
    {
      id: userId,
      tenant_id: userCore.tenant_id,
      email_blind_index: pii?.email_blind_index,
      deleted_by: actor,
      deletion_reason: 'user_request',
    },
    piiAdapter
  );

  // 2. Delete PII
  await ctx.piiRepositories.userPII.deletePII(userId, piiAdapter);

  // 3. Update Core
  await ctx.repositories.userCore.updatePIIStatus(userId, 'deleted');
}
```

## Migration Schedule (Recommended)

| Day   | Work                                   |
| ----- | -------------------------------------- |
| Day 1 | admin.ts: User list/detail retrieval   |
| Day 2 | admin.ts: User creation/update         |
| Day 3 | admin.ts: User deletion/GDPR handling  |
| Day 4 | token.ts: Authentication flow          |
| Day 5 | authorize.ts, external-idp             |
| Day 6-7 | Testing, debugging, documentation    |

## Related Files

- `packages/shared/src/db/adapter.ts` - DatabaseAdapter interface
- `packages/shared/src/db/partition-router.ts` - PIIPartitionRouter
- `packages/shared/src/repositories/` - Repository classes
- `packages/shared/src/context/` - Context types and Factory
- `migrations/007_pii_separation_core.sql` - Core DB schema
- `migrations/pii/001_pii_initial.sql` - PII DB schema
