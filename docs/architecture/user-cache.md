# UserCache Architecture

## Overview

UserCache is a Read-Through cache implementation for user metadata. It minimizes D1 reads and reduces latency in hot paths such as the Token Endpoint.

**Design Principles:**
- Read-Through pattern (automatically fetch from D1 on cache miss)
- 1 hour TTL + Invalidation Hook
- Uses KV Namespace (`USER_CACHE`)
- Separated from Policy Cache (different TTL requirements)

---

## Architecture

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

## Data Structure

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

Example: `user:550e8400-e29b-41d4-a716-446655440000`

---

## TTL Design

| Cache | TTL | Reason |
|-----------|-----|------|
| UserCache | 1 hour | Safe to use longer TTL with Invalidation Hook |
| PolicyCache | 5 minutes | May change frequently, no invalidation hook |
| SigningKeyCache | 10 minutes | Support key rotation |

**Rationale for 1-hour TTL:**
- User information updates are infrequent (profile edits are rare)
- Invalidation Hook clears cache immediately on update
- Significant p95 latency reduction for Token Endpoint

---

## API

### getCachedUser

```typescript
async function getCachedUser(
  env: Env,
  userId: string
): Promise<CachedUser | null>
```

**Behavior:**
1. Try `USER_CACHE.get(`user:${userId}`)`
2. Cache hit → parse and return
3. Cache miss → fetch from D1 → save to KV (1 hour TTL) → return
4. Not found in D1 either → return `null`

**Usage Example:**
```typescript
// op-token/token.ts
const user = await getCachedUser(c.env, userId);
if (!user) {
  return c.json({ error: 'invalid_grant', error_description: 'User not found' }, 400);
}

// Use in ID Token claims
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

**Behavior:**
1. Execute `USER_CACHE.delete(`user:${userId}`)`
2. Succeeds even if not exists (idempotent)

**Usage Example:**
```typescript
// op-management/admin.ts - after user update
await invalidateUserCache(env, userId);
```

---

## Invalidation Hook Locations

### op-management/admin.ts

| Endpoint | Timing |
|---------------|-----------|
| `PATCH /api/admin/users/:id` | After user information update |
| `PUT /api/admin/users/:id/avatar` | After avatar upload |
| `DELETE /api/admin/users/:id/avatar` | After avatar deletion |

### op-management/scim.ts

| Endpoint | Timing |
|---------------|-----------|
| `PUT /scim/v2/Users/:id` | After SCIM Replace |
| `PATCH /scim/v2/Users/:id` | After SCIM Modify |

**Implementation Pattern:**
```typescript
// admin.ts
app.patch('/api/admin/users/:id', async (c) => {
  // ... user update processing ...

  // Invalidation Hook
  await invalidateUserCache(c.env, userId);

  return c.json(updatedUser);
});
```

---

## Implementation Code

### kv.ts

```typescript
// packages/shared/src/utils/kv.ts

const USER_CACHE_TTL = 3600; // 1 hour

export interface CachedUser {
  id: string;
  email: string;
  email_verified: boolean;
  name: string | null;
  // ... (all fields)
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

## Environment Variable Configuration

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

## Performance Impact

### Before (Direct D1 Access)

```
Token Endpoint Latency:
├── DO Wall Time: ~15ms
├── D1 Read (user): ~150ms ← bottleneck
├── JWT Sign: ~5ms
└── Total: ~170ms
```

### After (UserCache)

```
Token Endpoint Latency:
├── DO Wall Time: ~15ms
├── KV Read (cache hit): ~5ms ← significant improvement
├── JWT Sign: ~5ms
└── Total: ~25ms
```

**Expected Cache Hit Rate:**
- Consecutive requests from same user: 99%+
- Requests within 1 hour: 95%+
- Overall: 80-90%

---

## Precautions

### 1. Cache Consistency

Always implement Invalidation Hooks. Missing hooks may result in stale user information being included in ID Tokens.

**Checklist:**
- [ ] `PATCH /api/admin/users/:id`
- [ ] `PUT /api/admin/users/:id/avatar`
- [ ] `DELETE /api/admin/users/:id/avatar`
- [ ] `PUT /scim/v2/Users/:id`
- [ ] `PATCH /scim/v2/Users/:id`

### 2. When Adding New Endpoints

When adding new endpoints that update user information, always call `invalidateUserCache()`.

### 3. Combined TTL and Invalidation

- TTL: Limits worst-case staleness (1 hour)
- Invalidation: Immediate reflection in normal cases

Combining both achieves both safety and performance.

### 4. Separation from Policy Cache

UserCache and PolicyCache use separate KV Namespaces:
- `USER_CACHE`: User metadata (1 hour TTL)
- `POLICY_CACHE`: Policy configuration (5 minute TTL)

Separation reasons:
- Different update frequencies
- Different invalidation requirements
- Fault isolation

---

## Monitoring and Debugging

### KV Metrics

Check in Cloudflare Dashboard:
- Cache hit rate
- Read/Write operations
- Storage usage

### Logging

```typescript
// Debug log (recommended to disable in production)
console.log(`UserCache: ${cached ? 'HIT' : 'MISS'} for ${userId}`);
```

### Troubleshooting

**Symptom: Stale user information returned**
1. Verify Invalidation Hook is implemented
2. Manually delete KV `user:{userId}` entry
3. Wait for TTL to expire (max 1 hour)

**Symptom: High cache miss rate**
1. Verify KV Namespace binding
2. Confirm `USER_CACHE` is not undefined
3. Verify D1 query is working correctly
