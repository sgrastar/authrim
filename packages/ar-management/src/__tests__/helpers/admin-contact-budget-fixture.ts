/** Actual signed inventory and canonical SQL; only D1 transport is an in-memory SQLite binding. */
import { readdirSync, readFileSync } from 'node:fs';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair } from 'jose';
import {
  CanonicalRuntimeUserStore,
  buildTenantRuntimeRegistryGenerationKey,
  buildTenantRuntimeRegistrySnapshotKey,
  ensureDatabaseAdapter,
  lookupVirtualBucket,
  signTenantRuntimeRegistrySnapshot,
  type AccountDirectoryPublication,
  type Env,
  type TenantRuntimeRegistrySnapshot,
  type TenantRuntimeRegistryStoreSnapshot,
} from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../../ar-lib-core/dist/migrations/sql-portability';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from '../test-sqlite';
import { adminSessionsListHandler } from '../../admin-user-sessions';
import { adminAccountContacts } from '../../admin-account-storage';

export const TENANT = 'tenant-a';
const TARGET = 'edge-a';
const sql = (family: 'core' | 'pii') => {
  const dir = new URL(`../../../../../migrations/${family}/d1/`, import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => renderPortableMigrationSql(readFileSync(new URL(name, dir), 'utf8'), 'sqlite'))
    .join('\n');
};
const CORE_SQL = sql('core');
const PII_SQL = sql('pii');

export class CallCounter {
  enabled = false;
  calls = 0;
  statements = 0;
  maxBinds = 0;
  maxBatch = 0;
  concurrent = 0;
  maxConcurrent = 0;
  cap = 1000;
  budgetExceeded = 0;
  sessions: string[] = [];
  failures = new Set<string>();
  async call<T>(key: string, operation: () => T): Promise<T> {
    if (!this.enabled) return operation();
    this.calls++;
    if (this.calls > this.cap) {
      this.budgetExceeded++;
      throw new Error('fixture_d1_invocation_budget_exceeded');
    }
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      await Promise.resolve();
      if (this.failures.has(key)) throw new Error('fixture_database_unavailable');
      return operation();
    } finally {
      this.concurrent--;
    }
  }
}

class SqlStatement {
  constructor(
    readonly store: Store,
    readonly sql: string,
    readonly params: SQLInputValue[] = []
  ) {}
  bind(...values: unknown[]) {
    const params = values.map((value): SQLInputValue => {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'bigint' ||
        value === null ||
        value instanceof Uint8Array
      )
        return value;
      throw new Error('unsupported_fixture_bind');
    });
    if (this.store.counter.enabled) {
      this.store.counter.maxBinds = Math.max(this.store.counter.maxBinds, params.length);
      if (params.length > 100) throw new Error('fixture_bind_limit_exceeded');
    }
    return new SqlStatement(this.store, this.sql, params);
  }
  result<T>() {
    if (this.store.counter.enabled) this.store.counter.statements++;
    if (/^\s*SELECT\b/iu.test(this.sql)) {
      return {
        success: true,
        results: this.store.db.prepare(this.sql).all(...this.params) as T[],
        meta: { duration: 0, changes: 0 },
      };
    }
    const result = this.store.db.prepare(this.sql).run(...this.params);
    return {
      success: true,
      results: [] as T[],
      meta: { duration: 0, changes: Number(result.changes) },
    };
  }
  all<T>() {
    return this.store.counter.call(this.store.key, () => this.result<T>());
  }
  async first<T>() {
    return (await this.all<T>()).results[0] ?? null;
  }
  run<T>() {
    return this.all<T>();
  }
}

export class Store {
  readonly db: SQLiteDatabase;
  readonly source: D1Database;
  constructor(
    readonly key: string,
    family: 'core' | 'pii',
    readonly counter: CallCounter
  ) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(family === 'core' ? CORE_SQL : PII_SQL);
    const prepare = (query: string) => new SqlStatement(this, query);
    const batch = async <T>(statements: D1PreparedStatement[]) =>
      counter.call(key, () => {
        if (counter.enabled) {
          counter.maxBatch = Math.max(counter.maxBatch, statements.length);
          if (statements.length > 50) throw new Error('fixture_batch_statement_bound_exceeded');
        }
        this.db.exec('BEGIN');
        try {
          const results = statements.map((statement) => {
            if (!(statement instanceof SqlStatement) || statement.store !== this)
              throw new Error('wrong_fixture_binding');
            return statement.result<T>();
          });
          this.db.exec('COMMIT');
          return results;
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      });
    this.source = {
      prepare,
      batch,
      withSession: (constraint: string) => {
        if (counter.enabled) counter.sessions.push(constraint);
        return { prepare, batch, getBookmark: () => 'fixture-bookmark' };
      },
    } as unknown as D1Database;
  }
}

export async function registryKeys() {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  const publicJwk = await exportJWK(pair.publicKey);
  for (const jwk of [privateJwk, publicJwk])
    Object.assign(jwk, { kid: 'registry-key', alg: 'EdDSA', use: 'sig' });
  return { privateJwk, publicJwk };
}

export async function contactFixture(
  keys: Awaited<ReturnType<typeof registryKeys>>,
  options: {
    shards?: number;
    users?: number;
    routed?: boolean;
    scope?: 'shared_pool' | 'tenant_exclusive';
  } = {}
) {
  const count = options.shards ?? 2;
  const userCount = options.users ?? 2;
  const routed = options.routed ?? true;
  const scope = options.scope ?? 'shared_pool';
  const counter = new CallCounter();
  const metadata = new Store('METADATA', 'core', counter);
  const defaultPii = new Store('DB_PII', 'pii', counter);
  const core = Array.from(
    { length: count },
    (_, index) => new Store(`AUTHRIM_TDB_CORE_${index}`, 'core', counter)
  );
  const pii = Array.from(
    { length: count },
    (_, index) => new Store(`AUTHRIM_TDB_PII_${index}`, 'pii', counter)
  );
  const all = [metadata, defaultPii, ...core, ...pii];
  const envValues: Record<string, unknown> = {
    DB: metadata.source,
    DB_PII: defaultPii.source,
    AUTHRIM_DEPLOYMENT_TARGET: TARGET,
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [keys.publicJwk] }),
  };
  for (const store of [...core, ...pii]) envValues[store.key] = store.source;
  const inventory: TenantRuntimeRegistryStoreSnapshot[] = [...core, ...pii].map((store, index) => {
    const isPii = index >= count;
    const shardIndex = index % count;
    return {
      tenantId: TENANT,
      role: isPii ? 'tenant_pii' : 'tenant_core',
      dataRole: isPii ? 'tenant_pii' : 'tenant_core/users',
      residencyPolicyId: 'default-policy',
      residencyPartition: 'default',
      shardId: `${isPii ? 'pii' : 'core'}-${shardIndex}`,
      assignmentGeneration: 1,
      bindingRouteGeneration: 3,
      placementPolicyGeneration: 1,
      allocationScope: scope,
      ownerTenantId: scope === 'tenant_exclusive' ? TENANT : null,
      generation: 3,
      runtimeGeneration: 8,
      schemaVersion: 1,
      shardGroup: 'default',
      shardIndex,
      shardCount: count,
      shardKeyStrategy: 'hash',
      provider: 'd1',
      driver: 'd1',
      bindingRef: store.key,
      connectionRef: null,
      deploymentTarget: TARGET,
      status: 'active',
      healthStatus: 'active',
      databaseId: `db-${index}`,
      databaseName: `fixture-${index}`,
      regionHint: null,
      jurisdiction: null,
    };
  });
  const unsigned: TenantRuntimeRegistrySnapshot = {
    version: 4,
    tenantId: TENANT,
    snapshotScope: 'tenant',
    deploymentTarget: TARGET,
    runtimeGeneration: 8,
    routeStatus: 'active',
    quarantineDenyGeneration: 0,
    backend: { provider: 'd1', resolver: 'control-plane' },
    placement: { isolationPolicy: scope, policyGeneration: 1 },
    publishedAt: '2026-05-16T00:00:00.000Z',
    expiresAt: '2099-05-16T00:30:00.000Z',
    stores: inventory,
    metadata: {
      storeCount: inventory.length,
      roles: ['tenant_core', 'tenant_pii'],
      signature: null,
      signatureKeyId: null,
      signatureAlgorithm: null,
      signedAt: null,
    },
  };
  const signed = await signTenantRuntimeRegistrySnapshot(
    unsigned,
    { privateJwk: keys.privateJwk, keyId: 'registry-key' },
    '2026-05-16T00:00:00.000Z'
  );
  const snapshotKey = buildTenantRuntimeRegistrySnapshotKey(TENANT, TARGET);
  const generationKey = buildTenantRuntimeRegistryGenerationKey(TENANT, TARGET);
  const registryReads = new Map<string, number>();
  const documents = new Map([
    [snapshotKey, JSON.stringify(signed)],
    [
      generationKey,
      JSON.stringify({
        runtimeGeneration: 8,
        routeStatus: 'active',
        quarantineDenyGeneration: 0,
        publishedAt: '2026-05-16T00:00:00.000Z',
        expiresAt: '2099-05-16T00:00:00.000Z',
      }),
    ],
  ]);
  envValues.TENANT_RUNTIME_REGISTRY = {
    get: async (key: string) => {
      registryReads.set(key, (registryReads.get(key) ?? 0) + 1);
      return documents.get(key) ?? null;
    },
  };
  const env = envValues as unknown as Env;
  const digest = 'a'.repeat(64);
  const virtualBucket = await lookupVirtualBucket('account_id', digest);
  async function seed(
    user: string,
    index: number,
    tenant = TENANT,
    publicationPatch?: (publication: AccountDirectoryPublication) => void
  ) {
    const account = routed ? core[index] : metadata;
    const personal = routed ? pii[index] : defaultPii;
    await new CanonicalRuntimeUserStore({
      coreAdapter: ensureDatabaseAdapter(account.source),
      piiAdapter: ensureDatabaseAdapter(personal.source),
      tenantId: tenant,
    }).syncUser({
      userId: user,
      active: true,
      emailVerified: true,
      piiFields: { email: true, name: true },
      sensitiveValues: { email: `${user}@example.test`, name: `Name ${user}` },
    });
    account.db
      .prepare(
        "UPDATE identity_accounts SET directory_publication_state='active' WHERE tenant_id=? AND legacy_user_id=?"
      )
      .run(tenant, user);
    const publication: AccountDirectoryPublication = {
      operationId: `operation:${tenant}:${user}`,
      tenantId: tenant,
      accountId: `account:${user}`,
      idempotencyKey: `key:${tenant}:${user}`,
      routeProjection: {
        schemaVersion: 1,
        accountRouteGeneration: 1,
        residencyPolicyId: 'default-policy',
        targets: [
          {
            dataRole: 'tenant_core/users',
            residencyPartition: 'default',
            shardId: `core-${index}`,
            bindingRef: account.key,
            requiredBindingRouteGeneration: 3,
          },
          {
            dataRole: 'tenant_pii',
            residencyPartition: 'default',
            shardId: `pii-${index}`,
            bindingRef: personal.key,
            requiredBindingRouteGeneration: 3,
          },
        ],
      },
      indexes: [
        {
          indexKind: 'account_id',
          normalizationVersion: 1,
          hmacKeyGeneration: 1,
          digest,
          virtualBucket,
        },
      ],
    };
    publicationPatch?.(publication);
    account.db
      .prepare(
        `INSERT INTO account_routing_outbox(outbox_id,tenant_id,account_id,event_kind,route_generation,route_schema_version,hmac_key_generation,payload_json,status,created_at,updated_at) VALUES(?,?,?,'account_created',1,1,1,?,'succeeded',1,1) ON CONFLICT(outbox_id) DO UPDATE SET payload_json=excluded.payload_json`
      )
      .run(`outbox:${tenant}:${user}`, tenant, `account:${user}`, JSON.stringify(publication));
  }
  for (let index = 0; index < userCount; index++) {
    const user = `user-${index}`;
    await seed(user, index % count);
    metadata.db
      .prepare('INSERT INTO users_core(id,tenant_id,created_at,updated_at) VALUES(?,?,1,1)')
      .run(user, TENANT);
    metadata.db
      .prepare(
        'INSERT INTO sessions(id,tenant_id,user_id,created_at,expires_at) VALUES(?,?,?,1,2000000000)'
      )
      .run(`session-${index}`, TENANT, user);
  }
  const pending: Promise<unknown>[] = [];
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, TENANT as never);
    c.set('adminAuth' as never, { userId: 'admin-1', actorType: 'human' } as never);
    c.set(
      'tenantMetadataContext' as never,
      {
        tenantId: TENANT,
        coreDb: metadata.source,
        ...(routed ? { route: { allocationScope: scope } } : {}),
      } as never
    );
    await next();
  });
  app.get('/sessions', adminSessionsListHandler);
  app.get('/contacts', async (c) => {
    const contacts = await adminAccountContacts(
      c,
      TENANT,
      Array.from({ length: userCount }, (_, index) => `user-${index}`)
    );
    return c.json(
      [...contacts].map(([id, contact]) => ({
        id,
        email: contact.email,
        name: contact.name,
        key: contact.store.key,
      }))
    );
  });
  const fetch = async (path = '/sessions?limit=500') => {
    counter.enabled = true;
    const response = await app.fetch(new Request(`https://example.test${path}`), env, {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: () => {},
      props: {},
    });
    await Promise.all(pending.splice(0));
    return response;
  };
  return {
    env,
    core,
    pii,
    metadata,
    defaultPii,
    counter,
    registryReads,
    documents,
    snapshotKey,
    generationKey,
    inventory,
    publish: async () => {
      unsigned.metadata.storeCount = unsigned.stores.length;
      documents.set(
        snapshotKey,
        JSON.stringify(
          await signTenantRuntimeRegistrySnapshot(
            unsigned,
            { privateJwk: keys.privateJwk, keyId: 'registry-key' },
            '2026-05-16T00:00:00.000Z'
          )
        )
      );
    },
    seed,
    fetch,
    close: () => all.forEach((store) => store.db.close()),
  };
}
