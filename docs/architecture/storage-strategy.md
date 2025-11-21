# Authrim Storage Strategy - Hybrid Multi-Tier Architecture 🗄️

**Last Updated**: 2025-11-13
**Status**: Phase 5 Design
**Version**: 1.0.0

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Storage Tier Comparison](#storage-tier-comparison)
3. [Hybrid Architecture Design](#hybrid-architecture-design)
4. [Data Classification](#data-classification)
5. [Storage Patterns](#storage-patterns)
6. [Cost Analysis](#cost-analysis)
7. [Migration Strategy](#migration-strategy)
8. [Implementation Guide](#implementation-guide)

---

## Overview

Authrim uses a **hybrid multi-tier storage architecture** that combines three Cloudflare storage services:

- **Durable Objects (DO)**: Strong consistency, real-time state management
- **D1 (SQLite)**: Persistent relational data, complex queries
- **KV**: Global edge cache, static metadata

This design optimizes for **performance**, **cost**, and **consistency** based on each data type's characteristics.

### Design Principles

1. **Right Tool for Right Job**: Match storage backend to data characteristics
2. **Strong Consistency Where Needed**: Use DO for critical one-time operations
3. **Cost Optimization**: Minimize expensive operations, leverage free tiers
4. **Global Performance**: Edge caching for frequently accessed data
5. **Cloud Portability**: Abstract storage layer for multi-cloud support

---

## Storage Tier Comparison

### Feature Matrix

| Feature | Durable Objects | D1 (SQLite) | KV |
|---------|----------------|-------------|-----|
| **Consistency** | Strong (immediate) | Eventual (seconds) | Eventual (60s globally) |
| **Read Latency** | < 1ms (in-memory) | < 10ms (local) | < 1ms (edge) |
| **Write Latency** | < 10ms | < 50ms | < 500ms (global) |
| **Storage Cost** | $0.20/GB/month | $0.75/GB/month | $0.50/GB/month |
| **Operation Cost** | $0.02/1M CPU-ms | Free (within limits) | $0.50/1M reads |
| **TTL Support** | Manual | Manual (cleanup) | Native |
| **Complex Queries** | No (key-value) | Yes (SQL) | No (key-value) |
| **Transactions** | Yes (single DO) | Yes (SQLite) | No |
| **Global Replication** | Single region | Multi-region | Global edge |
| **Best For** | Real-time state | Persistent data | Static cache |

### Cost Comparison Example

**Scenario**: 10,000 authorization code operations per day

| Storage | Operation Costs | Storage Costs | Total Monthly |
|---------|----------------|---------------|---------------|
| **DO** | $0.03 CPU | $0 (short-lived) | **$0.03** |
| **KV** | $0.45 R/W | $0 (short-lived) | **$0.45** |
| **D1** | $0 (free tier) | $0 (small data) | **$0** |

**Result**: DO is **15x cheaper than KV** for short-lived transactional data.

---

## Hybrid Architecture Design

### Overall Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Client Application                          │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Workers (Hono)                       │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │           Storage Abstraction Layer (IStorage)              │   │
│  └────────────────────────────────────────────────────────────┘   │
│         │                    │                    │                │
└─────────┼────────────────────┼────────────────────┼────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Durable Objects │  │   D1 Database   │  │   KV Storage    │
│                 │  │                 │  │                 │
│ • Session Store │  │ • users         │  │ • JWKs cache    │
│ • Auth Codes    │  │ • oauth_clients │  │ • Discovery     │
│ • Token Rotator │  │ • sessions (log)│  │ • Client cache  │
│ • KeyManager    │  │ • audit_log     │  │ • Magic Links   │
│                 │  │ • passkeys      │  │ • CSRF tokens   │
└─────────────────┘  └─────────────────┘  └─────────────────┘
     Real-time           Persistent           Edge Cache
  Strong Consistency  Relational Data      Global CDN
```

### Storage Tier Responsibilities

#### 🔷 Durable Objects (Strong Consistency Layer)

**Purpose**: Real-time state management requiring strong consistency

```
[ Durable Objects ]
   ┝── Authorization Code Store
   │    ├─ One-time use guarantee (replay attack prevention)
   │    ├─ TTL: 60 seconds
   │    └─ Strong consistency required
   │
   ┝── Refresh Token Rotator
   │    ├─ Atomic token rotation (prevent race conditions)
   │    ├─ Concurrency control
   │    └─ Token family tracking
   │
   ┝── Session Store (Active Sessions)
   │    ├─ In-memory hot data
   │    ├─ Real-time session state
   │    ├─ Instant invalidation
   │    └─ Fallback to D1 for cold sessions
   │
   └── KeyManager (Existing)
        ├─ RSA key generation & rotation
        ├─ Multi-key management
        └─ JWKS source of truth
```

#### 🔶 D1 Database (Persistent Data Layer)

**Purpose**: Long-term storage, relational queries, audit trails

```
[ D1 ]
   ┝── User Data
   │    ├─ users (master records)
   │    ├─ user_custom_fields (searchable attributes)
   │    └─ passkeys (WebAuthn credentials)
   │
   ┝── OAuth Data
   │    ├─ oauth_clients (registered apps)
   │    └─ scope_mappings (claim definitions)
   │
   ┝── Session Logs
   │    ├─ sessions (historical records)
   │    └─ Active session → DO, Expired session → D1
   │
   ┝── Access Control
   │    ├─ roles (RBAC definitions)
   │    └─ user_roles (role assignments)
   │
   ┝── Audit & Compliance
   │    ├─ audit_log (all operations)
   │    └─ refresh_token_log (rotation history)
   │
   └── Configuration
        ├─ branding_settings (UI customization)
        └─ identity_providers (SAML/LDAP configs)
```

#### 🔵 KV Storage (Edge Cache Layer)

**Purpose**: Global CDN cache, static metadata, short-lived tokens

```
[ KV ]
   ┝── Public Keys & Discovery
   │    ├─ JWKs (from KeyManager DO, cached)
   │    ├─ /.well-known/openid-configuration (cached)
   │    └─ TTL: 1 hour, invalidate on key rotation
   │
   ┝── Client Metadata Cache
   │    ├─ Source: D1 oauth_clients
   │    ├─ Read-through cache pattern
   │    └─ TTL: 5 minutes
   │
   ┝── Short-Lived Tokens
   │    ├─ Magic Link tokens (TTL: 15 min)
   │    ├─ CSRF tokens (TTL: 1 hour)
   │    └─ Email verification codes (TTL: 1 hour)
   │
   └── Rate Limiting (Existing)
        ├─ IP-based counters
        └─ Endpoint-specific limits
```

---

## Data Classification

### By Consistency Requirement

| Consistency Level | Data Types | Storage |
|------------------|-----------|---------|
| **Strong** | Authorization codes, Refresh token rotation | Durable Objects |
| **Session** | Active user sessions (hot data) | Durable Objects |
| **Eventual** | User profiles, Client configs | D1 + KV (cache) |
| **Static** | Public keys, Discovery metadata | KV (with DO source) |

### By Lifetime

| Lifetime | Data Types | Storage | TTL |
|----------|-----------|---------|-----|
| **Ultra-short** (< 1 min) | Authorization codes | Durable Objects | 60s |
| **Short** (< 1 hour) | Magic Links, CSRF tokens | KV | 15-60 min |
| **Medium** (< 1 day) | Active sessions | DO → D1 | 24 hours |
| **Long** (months-years) | Users, Clients, Audit logs | D1 | Indefinite |

### By Access Pattern

| Access Pattern | Data Types | Primary Storage | Cache |
|---------------|-----------|----------------|-------|
| **Write-once, read-once** | Authorization codes | Durable Objects | None |
| **Write-rarely, read-often** | Public keys, Discovery | DO/D1 | KV |
| **Write-often, read-often** | Active sessions | Durable Objects | None |
| **Write-often, read-rarely** | Audit logs | D1 | None |

---

## Storage Patterns

### Pattern 1: Write-Through Cache (Client Metadata)

```typescript
// Read path: KV → D1 (on miss)
async function getClient(clientId: string) {
  // 1. Try KV cache first
  const cached = await env.CLIENTS_CACHE.get(`client:${clientId}`);
  if (cached) return JSON.parse(cached);

  // 2. Cache miss, query D1
  const client = await env.DB.prepare(
    'SELECT * FROM oauth_clients WHERE client_id = ?'
  ).bind(clientId).first();

  // 3. Update cache
  if (client) {
    await env.CLIENTS_CACHE.put(
      `client:${clientId}`,
      JSON.stringify(client),
      { expirationTtl: 300 } // 5 minutes
    );
  }

  return client;
}

// Write path: D1 → KV invalidation
async function updateClient(clientId: string, updates: any) {
  // 1. Update D1 master
  await env.DB.prepare(
    'UPDATE oauth_clients SET ... WHERE client_id = ?'
  ).bind(...).run();

  // 2. Invalidate KV cache
  await env.CLIENTS_CACHE.delete(`client:${clientId}`);
}
```

### Pattern 2: Hot/Cold Session Storage

```typescript
// Active sessions in DO, cold sessions in D1
class SessionStore {
  async getSession(sessionId: string) {
    // 1. Check DO (hot data)
    const doSession = await this.doStorage.get(sessionId);
    if (doSession) return doSession;

    // 2. Check D1 (cold data, expired sessions)
    const d1Session = await this.db.prepare(
      'SELECT * FROM sessions WHERE id = ? AND expires_at > ?'
    ).bind(sessionId, Date.now() / 1000).first();

    // 3. Promote to DO if still valid
    if (d1Session && !this.isExpired(d1Session)) {
      await this.doStorage.put(sessionId, d1Session);
      return d1Session;
    }

    return null;
  }

  async createSession(userId: string) {
    const session = { id: generateId(), userId, ... };

    // 1. Store in DO (hot data)
    await this.doStorage.put(session.id, session);

    // 2. Store in D1 (persistent log)
    await this.db.prepare(
      'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).bind(session.id, session.userId, session.expiresAt, session.createdAt).run();

    return session;
  }
}
```

### Pattern 3: Source of Truth + Cache (Public Keys)

```typescript
// DO KeyManager is source of truth, KV is global cache
async function getJWKS() {
  // 1. Try KV cache
  const cached = await env.JWKS_CACHE.get('jwks');
  if (cached) return JSON.parse(cached);

  // 2. Fetch from KeyManager DO
  const keyManagerId = env.KEY_MANAGER.idFromName('default');
  const keyManager = env.KEY_MANAGER.get(keyManagerId);
  const response = await keyManager.fetch(
    new Request('http://internal/jwks', { method: 'GET' })
  );
  const jwks = await response.json();

  // 3. Cache in KV (1 hour TTL)
  await env.JWKS_CACHE.put('jwks', JSON.stringify(jwks), {
    expirationTtl: 3600
  });

  return jwks;
}

// Invalidate cache on key rotation
async function rotateKeys() {
  // 1. Rotate in DO
  const keyManagerId = env.KEY_MANAGER.idFromName('default');
  const keyManager = env.KEY_MANAGER.get(keyManagerId);
  await keyManager.fetch(
    new Request('http://internal/rotate', { method: 'POST' })
  );

  // 2. Invalidate KV cache
  await env.JWKS_CACHE.delete('jwks');
}
```

### Pattern 4: One-Time Use Tokens (Authorization Codes)

```typescript
// Authorization codes in DO for strong consistency
class AuthorizationCodeStore {
  async create(code: string, data: any) {
    // Store in DO with TTL
    await this.doStorage.put(code, {
      data,
      used: false,
      expiresAt: Date.now() + 60000 // 60 seconds
    });
  }

  async consume(code: string): Promise<any | null> {
    const stored = await this.doStorage.get(code);

    if (!stored) return null;
    if (stored.used) throw new Error('Code already used'); // Replay attack
    if (Date.now() > stored.expiresAt) return null;

    // Mark as used atomically (DO guarantees strong consistency)
    stored.used = true;
    await this.doStorage.put(code, stored);

    return stored.data;
  }
}
```

---

## Cost Analysis

### Monthly Cost Estimation (100K active users)

#### Scenario Assumptions
- 100,000 users
- 10,000 logins/day (300K/month)
- 50,000 active sessions
- 1,000 OAuth clients

#### Cost Breakdown

| Service | Usage | Unit Cost | Monthly Cost |
|---------|-------|-----------|--------------|
| **Durable Objects** | | | |
| - CPU (auth codes) | 300K × 5ms = 1.5M ms | $0.02/1M ms | $0.03 |
| - CPU (sessions) | 300K × 2ms = 600K ms | $0.02/1M ms | $0.01 |
| - Storage (50K sessions) | 50K × 1KB = 50MB | $0.20/GB | $0.01 |
| **D1** | | | |
| - Rows read | 1M/month | Free (5M/day) | $0 |
| - Rows written | 500K/month | Free (100K/day) | $0 |
| - Storage (100K users) | 100K × 2KB = 200MB | $0.75/GB | $0.15 |
| **KV** | | | |
| - Reads (JWKS, clients) | 2M/month | $0.50/1M | $1.00 |
| - Writes (cache updates) | 100K/month | $0.50/1M | $0.05 |
| - Storage (metadata) | 10MB | $0.50/GB | $0.01 |
| **Workers** | | | |
| - Requests | 300K/day = 9M/month | Free (10M/month) | $0 |
| **Total** | | | **$1.26/month** |

**Cost per user**: $0.0000126 (~$0.01 per 1000 users)

#### Comparison: KV-Only Architecture

| Item | Cost |
|------|------|
| Auth codes (KV) | $0.45 |
| Sessions (KV) | $0.30 |
| Everything else | $1.21 |
| **Total (KV-only)** | **$1.96/month** |

**Savings with hybrid architecture**: $0.70/month (36% reduction)

---

## Migration Strategy

### Phase 1: Current State (Before Phase 5)

```
All data in KV:
- AUTH_CODES (KV)
- STATE_STORE (KV)
- NONCE_STORE (KV)
- CLIENTS (KV)
- REFRESH_TOKENS (KV)
- REVOKED_TOKENS (KV)

Durable Objects:
- KeyManager (implemented)
```

### Phase 2: Phase 5 Migration Plan

#### Step 1: D1 Setup (Week 1)
1. Create D1 database
2. Run migrations (001_initial_schema.sql, 002_seed_default_data.sql)
3. Test D1 connectivity

#### Step 2: Migrate Static Data (Week 1)
1. Export clients from KV
2. Import to D1 `oauth_clients` table
3. Implement read-through cache (KV as cache layer)

#### Step 3: Implement Durable Objects (Week 2)
1. **SessionStore DO**
   - Implement in-memory session management
   - Integrate with D1 for persistence

2. **AuthorizationCodeStore DO**
   - Migrate from KV to DO
   - Add replay attack prevention

3. **RefreshTokenRotator DO**
   - Implement atomic rotation
   - Add D1 audit log

#### Step 4: Deploy & Test (Week 3)
1. Parallel operation (KV + DO + D1)
2. Validate data consistency
3. Performance testing

#### Step 5: Cutover (Week 4)
1. Switch read traffic to new storage
2. Monitor errors
3. Decommission old KV stores

### Rollback Plan

```typescript
// Feature flags for gradual rollout
const STORAGE_CONFIG = {
  USE_DO_AUTH_CODES: env.ENABLE_DO_AUTH_CODES === 'true',
  USE_DO_SESSIONS: env.ENABLE_DO_SESSIONS === 'true',
  USE_D1_CLIENTS: env.ENABLE_D1_CLIENTS === 'true',
};

// Fallback logic
async function getClient(clientId: string) {
  if (STORAGE_CONFIG.USE_D1_CLIENTS) {
    try {
      return await getClientFromD1(clientId);
    } catch (e) {
      console.error('D1 failed, falling back to KV', e);
      return await getClientFromKV(clientId);
    }
  }
  return await getClientFromKV(clientId);
}
```

---

## Implementation Guide

### Storage Abstraction Layer

```typescript
// packages/shared/src/storage/interfaces.ts
export interface IStorageAdapter {
  // KV-like operations
  get(key: string): Promise<any>;
  set(key: string, value: any, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;

  // SQL-like operations
  query(sql: string, params: any[]): Promise<any[]>;
  execute(sql: string, params: any[]): Promise<void>;
}

// Cloudflare implementation
export class CloudflareStorageAdapter implements IStorageAdapter {
  constructor(
    private d1: D1Database,
    private kv: KVNamespace,
    private doNamespace: DurableObjectNamespace
  ) {}

  async get(key: string): Promise<any> {
    // Route to appropriate storage based on key prefix
    if (key.startsWith('session:')) {
      return this.getFromDO('SessionStore', key);
    } else if (key.startsWith('client:')) {
      return this.getFromD1WithCache(key);
    } else {
      return this.kv.get(key);
    }
  }

  // ... implementation
}

// AWS implementation (future)
export class AWSStorageAdapter implements IStorageAdapter {
  constructor(
    private rds: RDSClient,
    private elasticache: ElastiCacheClient,
    private dynamodb: DynamoDBClient
  ) {}

  // ... implementation
}
```

### Environment Configuration

```toml
# wrangler.toml

# D1 Database
[[d1_databases]]
binding = "DB"
database_name = "authrim-prod"
database_id = "xxxx"

# KV Namespaces
[[kv_namespaces]]
binding = "JWKS_CACHE"
id = "xxxx"

[[kv_namespaces]]
binding = "CLIENTS_CACHE"
id = "xxxx"

[[kv_namespaces]]
binding = "MAGIC_LINKS"
id = "xxxx"

# Durable Objects
[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "authrim"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "authrim"

[[durable_objects.bindings]]
name = "AUTH_CODE_STORE"
class_name = "AuthorizationCodeStore"
script_name = "authrim"

[[durable_objects.bindings]]
name = "REFRESH_TOKEN_ROTATOR"
class_name = "RefreshTokenRotator"
script_name = "authrim"
```

---

## Performance Benchmarks

### Target Latencies (p95)

| Operation | Target | Storage |
|-----------|--------|---------|
| Get authorization code | < 10ms | Durable Objects |
| Get active session | < 5ms | Durable Objects (in-memory) |
| Get cold session | < 50ms | D1 |
| Get client metadata | < 5ms | KV (cache hit) |
| Get client metadata (miss) | < 50ms | D1 + KV update |
| Get JWKS | < 5ms | KV (cache hit) |
| Create user | < 100ms | D1 |
| User search | < 200ms | D1 (indexed) |

### Scalability Limits

| Metric | Limit | Notes |
|--------|-------|-------|
| Users | 10M+ | D1 can handle millions of rows |
| Active sessions | 1M+ | DO distributed across regions |
| Requests/second | 100K+ | Workers auto-scale globally |
| Concurrent logins | 10K+ | DO per-object limit: ~1000 req/s |

---

## Monitoring & Observability

### Key Metrics

```typescript
// packages/shared/src/telemetry/storage-metrics.ts
export const STORAGE_METRICS = {
  // Latency
  'storage.latency.do.read': histogram(),
  'storage.latency.do.write': histogram(),
  'storage.latency.d1.query': histogram(),
  'storage.latency.kv.get': histogram(),

  // Cache hit rates
  'storage.cache.hit_rate.clients': gauge(),
  'storage.cache.hit_rate.jwks': gauge(),

  // Error rates
  'storage.errors.do': counter(),
  'storage.errors.d1': counter(),
  'storage.errors.kv': counter(),

  // Cost tracking
  'storage.operations.do.cpu_ms': counter(),
  'storage.operations.kv.reads': counter(),
  'storage.operations.d1.rows_read': counter(),
};
```

### Health Checks

```typescript
export async function healthCheck(env: Env) {
  const results = {
    do: await checkDO(env),
    d1: await checkD1(env),
    kv: await checkKV(env),
  };

  return {
    healthy: Object.values(results).every(r => r.healthy),
    details: results,
  };
}
```

---

## References

### Related Documents
- [database-schema.md](./database-schema.md) - D1 schema and ER diagrams
- [durable-objects.md](./durable-objects.md) - DO architecture details
- [PHASE5_PLANNING.md](../project-management/PHASE5_PLANNING.md) - Phase 5 implementation plan
- [technical-specs.md](./technical-specs.md) - Overall system architecture

### External Resources
- [Cloudflare D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare KV Pricing](https://developers.cloudflare.com/kv/platform/pricing/)
- [Cloudflare Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [SQLite Performance](https://www.sqlite.org/whentouse.html)

---

**Change History**:
- 2025-11-13: Initial version created (Phase 5 design)
