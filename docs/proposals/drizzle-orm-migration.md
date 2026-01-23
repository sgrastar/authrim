# RFC: Drizzle ORM Migration

| Status | Draft |
|--------|-------|
| Author | Engineering Team |
| Created | 2026-01-23 |
| Updated | 2026-01-23 |

## Abstract

This document outlines the plan to migrate from raw SQL queries to Drizzle ORM for improved type safety, reduced runtime errors, and better multi-database support.

## Table of Contents

1. [Background](#background)
2. [Problem Statement](#problem-statement)
3. [Goals](#goals)
4. [Non-Goals](#non-goals)
5. [Technical Decision](#technical-decision)
6. [Architecture](#architecture)
7. [Migration Strategy](#migration-strategy)
8. [Implementation Phases](#implementation-phases)
9. [Risks and Mitigations](#risks-and-mitigations)
10. [Success Metrics](#success-metrics)

---

## Background

### Current State

The codebase currently uses a custom `DatabaseAdapter` abstraction layer with raw SQL queries:

```typescript
// Current pattern (344 occurrences across 86 files)
await adapter.execute(
  `INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris)
   VALUES (?, ?, ?)`,
  [clientId, hash, JSON.stringify(redirectUris)]
);
```

**Key components:**
- `DatabaseAdapter` interface (`packages/ar-lib-core/src/db/adapter.ts`)
- `D1Adapter` implementation (`packages/ar-lib-core/src/db/adapters/d1-adapter.ts`)
- Repository layer (`packages/ar-lib-core/src/repositories/`)
- 45 manual migration files (`migrations/*.sql`)
- PII partition routing for GDPR compliance

### Pain Points

1. **Placeholder Mismatch Bugs**: Manual counting of `?` placeholders leads to runtime errors
   - Example: `client.ts:365` has 46 placeholders to maintain manually
   - Recent bug caused by an extra `?` placeholder

2. **No Compile-Time Safety**: SQL string errors only caught at runtime

3. **Maintenance Burden**: 344 raw SQL calls across 86 files

4. **Multi-Database Friction**: Future Hyperdrive + MySQL/Aurora migration requires rewriting queries

---

## Problem Statement

Raw SQL with manual placeholder management is error-prone and does not scale. As the codebase grows, the risk of placeholder mismatch bugs increases, and multi-database support becomes increasingly difficult to maintain.

---

## Goals

1. **Type Safety**: Eliminate placeholder mismatch bugs through compile-time validation
2. **Developer Experience**: Improve query readability and maintainability
3. **Multi-Database Support**: Enable seamless transition from D1 (SQLite) to Hyperdrive + MySQL/Aurora
4. **Incremental Migration**: Allow gradual adoption without breaking existing functionality
5. **Preserve Existing Architecture**: Maintain PII partition routing and multi-tenant isolation

---

## Non-Goals

1. Complete rewrite of all existing queries in Phase 1
2. Replacing the existing migration system immediately
3. Changing the current database schema
4. Modifying the PII partition architecture

---

## Technical Decision

### ORM Selection: Drizzle ORM

After evaluating available options, **Drizzle ORM** is selected over alternatives:

| Criteria | Drizzle | Kysely | Prisma |
|----------|---------|--------|--------|
| D1 Support | ✅ Official | ✅ Official | ⚠️ Experimental |
| Bundle Size | ~50KB | ~30KB | ~5MB |
| Edge Runtime | ✅ | ✅ | ⚠️ Limited |
| Type Safety | ✅ Full | ✅ Full | ✅ Full |
| Schema Definition | TypeScript | Types only | DSL (.prisma) |
| Migration Tools | ✅ Built-in | ❌ None | ✅ Built-in |
| SQL Dialect Abstraction | ✅ Automatic | ⚠️ Manual | ✅ Automatic |
| Column Name Mapping | ✅ Built-in | ⚠️ Plugin | ✅ Built-in |

### Rationale

1. **Column Name Mapping**: Drizzle provides built-in mapping from camelCase (TypeScript) to snake_case (database)
   ```typescript
   clientId: text('client_id').primaryKey()  // TS: clientId → DB: client_id
   ```

2. **Multi-Database Dialect Support**: Single API with automatic SQL dialect translation
   ```typescript
   // Same code works for both SQLite and MySQL
   db.insert(users).values({ id, email }).onConflictDoUpdate(...)
   // → SQLite: ON CONFLICT ... DO UPDATE
   // → MySQL: ON DUPLICATE KEY UPDATE
   ```

3. **Migration Tooling**: Generate migrations from schema changes, compatible with existing manual migrations

4. **Lightweight**: ~50KB bundle size, suitable for Cloudflare Workers

---

## Architecture

### Layer Structure

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                         │
│              (ar-auth, ar-token, ar-management)             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Repository Layer                          │
│                 (Drizzle queries + types)                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Database Abstraction                        │
│         ┌─────────────────┬─────────────────┐               │
│         │  Drizzle ORM    │  DatabaseAdapter │  ← Coexist   │
│         │   (new code)    │   (legacy code)  │               │
│         └─────────────────┴─────────────────┘               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   PIIPartitionRouter                         │
│            (Route queries to correct partition)              │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌─────────┐     ┌─────────┐     ┌─────────┐
        │  EU DB  │     │  US DB  │     │ APAC DB │
        │  (D1)   │     │  (D1)   │     │  (D1)   │
        └─────────┘     └─────────┘     └─────────┘
```

### Schema Organization

```
packages/ar-lib-core/src/
├── db/
│   ├── drizzle/
│   │   ├── schema/
│   │   │   ├── index.ts           # Re-exports all schemas
│   │   │   ├── oauth-clients.ts   # OAuth client schema
│   │   │   ├── users.ts           # User schema (core)
│   │   │   ├── sessions.ts        # Session schema
│   │   │   ├── roles.ts           # RBAC schema
│   │   │   └── ...
│   │   ├── client.ts              # Drizzle client factory
│   │   └── migrations/            # Drizzle-generated migrations
│   ├── adapter.ts                 # Existing DatabaseAdapter (preserved)
│   └── adapters/
│       └── d1-adapter.ts          # Existing D1Adapter (preserved)
├── repositories/
│   ├── core/
│   │   ├── client.ts              # Migrate to Drizzle
│   │   ├── client.legacy.ts       # Preserve legacy if needed
│   │   └── ...
│   └── ...
```

### Drizzle Client Factory

```typescript
// packages/ar-lib-core/src/db/drizzle/client.ts

import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from './schema';

export type DrizzleClient = ReturnType<typeof createDrizzleClient>;

export function createDrizzleClient(env: Env) {
  // Future: Switch based on configuration
  if (env.USE_HYPERDRIVE && env.HYPERDRIVE) {
    return drizzleMysql(env.HYPERDRIVE, { schema, mode: 'default' });
  }

  return drizzleD1(env.DB, { schema });
}
```

### Schema Definition Example

```typescript
// packages/ar-lib-core/src/db/drizzle/schema/oauth-clients.ts

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

export const oauthClients = sqliteTable('oauth_clients', {
  // Primary key
  clientId: text('client_id').primaryKey(),

  // Credentials
  clientSecretHash: text('client_secret_hash'),

  // Configuration (JSON stored as text)
  redirectUris: text('redirect_uris').notNull(),
  grantTypes: text('grant_types').notNull(),
  responseTypes: text('response_types').notNull(),
  scope: text('scope'),

  // Multi-tenancy
  tenantId: text('tenant_id').notNull(),

  // Timestamps
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),

  // ... additional fields (46 total)
});

// Define relationships
export const oauthClientsRelations = relations(oauthClients, ({ many }) => ({
  sessions: many(sessions),
}));
```

### Multi-Database Schema Strategy

For future MySQL/Aurora support via Hyperdrive:

```typescript
// packages/ar-lib-core/src/db/drizzle/schema/oauth-clients.ts

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { mysqlTable, varchar, timestamp } from 'drizzle-orm/mysql-core';

// Base field definitions (shared logic)
const oauthClientFields = {
  clientId: { name: 'client_id', primaryKey: true },
  clientSecretHash: { name: 'client_secret_hash' },
  // ...
};

// SQLite schema (current D1)
export const oauthClientsSqlite = sqliteTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientSecretHash: text('client_secret_hash'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  // ...
});

// MySQL schema (future Hyperdrive + Aurora)
export const oauthClientsMysql = mysqlTable('oauth_clients', {
  clientId: varchar('client_id', { length: 255 }).primaryKey(),
  clientSecretHash: varchar('client_secret_hash', { length: 255 }),
  createdAt: timestamp('created_at'),
  // ...
});

// Export based on environment (build-time or runtime switch)
export const oauthClients = process.env.DB_DIALECT === 'mysql'
  ? oauthClientsMysql
  : oauthClientsSqlite;
```

---

## Migration Strategy

### Coexistence Approach

Drizzle will coexist with the existing `DatabaseAdapter` during migration:

```typescript
// Repository can use both
class ClientRepository {
  constructor(
    private legacyAdapter: DatabaseAdapter,  // Existing
    private db: DrizzleClient,               // New
  ) {}

  // New code uses Drizzle
  async findById(clientId: string) {
    return this.db.query.oauthClients.findFirst({
      where: eq(oauthClients.clientId, clientId),
    });
  }

  // Legacy code continues to work
  async legacyComplexQuery() {
    return this.legacyAdapter.query<Client>(
      'SELECT ... complex legacy SQL ...',
      [params]
    );
  }
}
```

### Migration File Compatibility

Existing migrations in `migrations/*.sql` will be preserved:

```typescript
// drizzle.config.ts
export default {
  schema: './packages/ar-lib-core/src/db/drizzle/schema',
  out: './packages/ar-lib-core/src/db/drizzle/migrations',
  driver: 'd1',
  dbCredentials: {
    wranglerConfigPath: './wrangler.toml',
    dbName: 'authrim-db',
  },
  // Existing tables are already created; Drizzle manages new changes
  tablesFilter: ['!_migrations'],  // Exclude migration tracking table
};
```

---

## Implementation Phases

### Phase 1: Foundation (Week 1-2)

**Objective**: Set up Drizzle infrastructure without changing existing code

- [ ] Install Drizzle ORM dependencies
  ```bash
  pnpm add drizzle-orm
  pnpm add -D drizzle-kit
  ```
- [ ] Create Drizzle configuration (`drizzle.config.ts`)
- [ ] Generate initial schema from existing database using `drizzle-kit introspect`
- [ ] Set up Drizzle client factory with D1 support
- [ ] Add schema files for core tables (oauth_clients, users_core, sessions)
- [ ] Write integration tests for Drizzle queries alongside existing tests

**Deliverables**:
- `packages/ar-lib-core/src/db/drizzle/` directory structure
- Schema definitions for core tables
- Drizzle client factory
- Integration test suite

### Phase 2: Repository Migration - Core (Week 3-4)

**Objective**: Migrate high-risk repositories to Drizzle

Priority targets (highest placeholder count):
1. `client.ts` (46 placeholders) - OAuth client repository
2. `user-pii.ts` (26 placeholders) - User PII repository
3. `provider-store.ts` (31 placeholders) - Identity provider store

- [ ] Migrate `ClientRepository` to Drizzle
- [ ] Migrate `UserPiiRepository` to Drizzle
- [ ] Migrate `ProviderStore` to Drizzle
- [ ] Update dependent services to use new repositories
- [ ] Maintain backward compatibility with legacy adapter

**Deliverables**:
- Migrated repositories with Drizzle queries
- Updated test coverage
- Performance benchmarks

### Phase 3: Repository Migration - Extended (Week 5-8)

**Objective**: Migrate remaining repositories

- [ ] Sessions, Passkeys, Roles repositories
- [ ] Audit log repositories
- [ ] REBAC/RBAC repositories
- [ ] Verifiable Credentials repositories
- [ ] SCIM endpoints
- [ ] Admin management endpoints

**Deliverables**:
- All repositories migrated to Drizzle
- Legacy `DatabaseAdapter` usage minimized

### Phase 4: Cleanup and Optimization (Week 9-10)

**Objective**: Remove legacy code and optimize

- [ ] Remove unused `DatabaseAdapter` methods
- [ ] Consolidate duplicate queries
- [ ] Add query performance monitoring
- [ ] Update documentation
- [ ] Prepare for Hyperdrive migration

**Deliverables**:
- Cleaned codebase
- Performance report
- Hyperdrive migration guide

### Phase 5: Multi-Database Support (Future)

**Objective**: Enable Hyperdrive + MySQL/Aurora support

- [ ] Create MySQL schema variants
- [ ] Implement runtime dialect switching
- [ ] Test with Hyperdrive connection pooling
- [ ] Migration guide for production

---

## Risks and Mitigations

### Risk 1: Query Performance Regression

**Risk**: Generated SQL may be less optimal than hand-written queries

**Mitigation**:
- Benchmark critical queries before/after migration
- Use Drizzle's `sql` template for complex queries
- Maintain escape hatch to raw SQL when needed

### Risk 2: Migration Complexity

**Risk**: Migrating 344 query sites is time-consuming and error-prone

**Mitigation**:
- Phased approach with clear priorities
- Coexistence allows gradual migration
- Comprehensive test coverage before migration

### Risk 3: Bundle Size Increase

**Risk**: Adding Drizzle may increase Worker bundle size

**Mitigation**:
- Drizzle is ~50KB gzipped (within 1MB Worker limit)
- Tree-shaking removes unused features
- Monitor bundle size in CI

### Risk 4: PII Partition Compatibility

**Risk**: Drizzle may not work with existing PII partition routing

**Mitigation**:
- Create partition-aware Drizzle client factory
- Test with multi-partition scenarios
- Preserve existing routing logic

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Placeholder bugs | 0 | Issue tracker |
| Type coverage | 100% for new queries | TypeScript compiler |
| Migration progress | 100% by Phase 4 | Query count audit |
| Performance | < 5% regression | Benchmark suite |
| Bundle size | < 1MB total | CI check |
| Test coverage | > 80% for repositories | Coverage report |

---

## Appendix

### A. Affected Files

High-priority files by placeholder count:

| File | Placeholders | Priority |
|------|--------------|----------|
| `repositories/core/client.ts` | 46 | P0 |
| `repositories/pii/user-pii.ts` | 26 | P0 |
| `services/provider-store.ts` | 31 | P0 |
| `scim.ts` | 25 | P1 |
| `admin.ts` | Various | P1 |
| `cloudflare-adapter.ts` | 25 | P1 |

### B. Dependencies

```json
{
  "dependencies": {
    "drizzle-orm": "^0.30.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.21.0"
  }
}
```

### C. Related Documents

- [Database Adapter Interface](../packages/ar-lib-core/src/db/adapter.ts)
- [Migration Files](../migrations/README.md)
- [PII Partition Router](../packages/ar-lib-core/src/db/partition-router.ts)

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-23 | Engineering Team | Initial draft |
