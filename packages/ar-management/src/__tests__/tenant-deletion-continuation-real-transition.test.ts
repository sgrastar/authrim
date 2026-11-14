import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

/**
 * A continued deletion job (config exactly as the DELETE API writes it) run through the real job
 * code with the REAL route-state transition and the real admin DDL for the registry tables: only
 * the snapshot publication (KV and signing), Lookup, the shard purge and Control are replaced.
 * Whatever state the failed predecessor left the route in, no transition error may occur.
 */
const hooks = vi.hoisted(
  (): {
    db: unknown;
    core: unknown;
    publishes: string[];
    destructive: string[];
    signingKey: unknown;
  } => ({
    db: null,
    core: null,
    publishes: [],
    destructive: [],
    signingKey: null,
  })
);

const BASELINE = fileURLToPath(
  new URL('../../../../migrations/admin/d1/001_0_5_0_admin_baseline.sql', import.meta.url)
);
const TENANT = 'target-tenant';
const CHAIN = '11111111-2222-4333-8444-555555555555';

function sqliteAdapter(getDb: () => SQLiteDatabase): DatabaseAdapter {
  const tolerate = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      // Tables of the admin baseline this test does not create hold nothing to delete.
      if (String(error).includes('no such table')) return fallback;
      throw error;
    }
  };
  const adapter = {
    queryOne: async (sql: string, params: SQLInputValue[] = []) =>
      tolerate(
        () =>
          getDb()
            .prepare(sql)
            .get(...params) ?? null,
        null
      ),
    query: async (sql: string, params: SQLInputValue[] = []) =>
      tolerate(
        () =>
          getDb()
            .prepare(sql)
            .all(...params),
        []
      ),
    execute: async (sql: string, params: SQLInputValue[] = []) =>
      tolerate(
        () => {
          const result = getDb()
            .prepare(sql)
            .run(...params);
          return { success: true, rowsAffected: Number(result.changes) };
        },
        { success: true, rowsAffected: 0 }
      ),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(adapter),
    batch: async (statements: Array<{ sql: string; params?: SQLInputValue[] }>) =>
      statements.map((statement) => {
        const result = getDb()
          .prepare(statement.sql)
          .run(...(statement.params ?? []));
        return { success: true, rowsAffected: Number(result.changes) };
      }),
  };
  return adapter as unknown as DatabaseAdapter;
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ensureDatabaseAdapter: (source: unknown) => (source === 'admin-db' ? hooks.db : hooks.core),
    listEnvironmentTenantDefaultStores: async () => [
      { tenantId: 'operator-tenant', store: { source: 'core-db', bindingRef: 'CORE' } },
    ],
  };
});

vi.mock('../tenant-runtime-registry-route-state', async () => {
  const lib = await import('@authrim/ar-lib-core');
  return {
    publishTenantRuntimeRegistryRouteState: async (
      _env: unknown,
      options: Parameters<typeof lib.transitionTenantRuntimeRegistryRouteState>[1]
    ) => {
      hooks.publishes.push(`${options.routeStatus}:${options.operationId}`);
      const repository = new lib.TenantDatabaseRegistryRepository(hooks.db as DatabaseAdapter);
      const transition = await lib.transitionTenantRuntimeRegistryRouteState(repository, options);
      // The real publisher, with its registry/pointer integrity checks; only the KV is a fake.
      if (!hooks.signingKey) {
        const pair = (await crypto.subtle.generateKey('Ed25519', true, [
          'sign',
          'verify',
        ])) as CryptoKeyPair;
        const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
        Object.assign(privateJwk, { kid: 'rr-key-1', alg: 'EdDSA', use: 'sig' });
        hooks.signingKey = { privateJwk, keyId: 'rr-key-1' };
      }
      const publication = await lib.publishTenantRuntimeRegistrySnapshot({
        tenantId: options.tenantId,
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 7 },
        repository,
        snapshotStore: { put: async () => undefined },
        deploymentTarget: 'default',
        actorId: options.actorId,
        signingKey: hooks.signingKey as never,
      });
      return { ...transition, publishedAt: publication.snapshot.publishedAt };
    },
  };
});
vi.mock('../tenant-deletion-lookup-cleanup', () => ({
  disableTenantLookupDirectory: vi.fn(async () => {
    hooks.destructive.push('lookup');
  }),
}));
vi.mock('../tenant-deletion-authoritative-purge', () => ({
  purgeTenantAuthoritativeShards: vi.fn(async () => {
    hooks.destructive.push('purge');
  }),
}));
vi.mock('../tenant-deletion-admin-accounts', () => ({
  purgeTenantHomedAdmins: vi.fn(async () => ({ removed: 0, kept: [] })),
  createTenantAdminPurgeAuditWriter: vi.fn(() => vi.fn()),
}));

import { processPendingTenantDeletionJobs } from '../tenant-deletion-jobs';

function openAdminDb(): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  const baseline = readFileSync(BASELINE, 'utf8');
  for (const table of [
    'tenant_database_registry',
    'tenant_database_active_pointers',
    'tenant_runtime_cache_generations',
    'tenant_runtime_registry_snapshots',
  ]) {
    const match = new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\n\\);`, 'u').exec(baseline);
    if (!match) throw new Error(`baseline_ddl_missing:${table}`);
    db.exec(match[0]);
  }
  return db;
}

function seedRoute(db: SQLiteDatabase, routeStatus: string | null, operationId = CHAIN) {
  if (!routeStatus) return;
  db.prepare(
    `INSERT INTO tenant_runtime_cache_generations
       (tenant_id, cache_namespace, generation, metadata_json)
     VALUES (?, 'runtime_registry', 2, ?)`
  ).run(
    TENANT,
    JSON.stringify({
      route_status: routeStatus,
      quarantine_deny_generation: 1,
      route_state_operation_id: operationId,
    })
  );
}

function controlEnvironment() {
  return {
    DB_ADMIN: 'admin-db',
    AUTHRIM_CONFIG: { get: vi.fn().mockResolvedValue(null), put: vi.fn() },
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL: {
      getTenantDeletionInventory: async ({ tenantId, operationId }: Record<string, string>) => ({
        environmentId: 'test',
        tenantId,
        operationId,
        state: 'ready',
        lookupShards: [],
        tenantShards: [],
      }),
      finalizeTenantDeletionControlState: async ({
        tenantId,
        operationId,
      }: Record<string, string>) => {
        hooks.destructive.push('finalize');
        return {
          environmentId: 'test',
          tenantId,
          operationId,
          state: 'finalized',
          finalizedAt: 1_700_000_000,
        };
      },
    },
  } as never;
}

describe('continued deletion job against the real route-state transition', () => {
  let admin: SQLiteDatabase;
  let core: SQLiteDatabase;

  beforeEach(() => {
    hooks.publishes = [];
    hooks.destructive = [];
    admin = openAdminDb();
    core = new DatabaseSync(':memory:');
    core.exec(`CREATE TABLE admin_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT, job_type TEXT, status TEXT, progress TEXT, config TEXT,
      attempt_count INTEGER, max_attempts INTEGER, next_run_at INTEGER, completed_at INTEGER,
      started_at INTEGER, updated_at INTEGER, created_at INTEGER, error_message TEXT
    )`);
    core
      .prepare(
        `INSERT INTO admin_jobs (id, tenant_id, job_type, status, config, created_at, updated_at)
         VALUES ('job-new', 'operator-tenant', 'tenants/delete', 'pending', ?, 1, 1)`
      )
      .run(JSON.stringify({ tenant_id: TENANT, operation_id: CHAIN, skip_backup: true }));
    hooks.db = sqliteAdapter(() => admin);
    hooks.core = sqliteAdapter(() => core);
  });

  const jobStatus = () =>
    core.prepare("SELECT status, error_message FROM admin_jobs WHERE id = 'job-new'").get() as {
      status: string;
      error_message: string | null;
    };

  const START = new Date('2026-11-14T12:00:00Z');
  const row = () =>
    core
      .prepare("SELECT status, progress, config, next_run_at FROM admin_jobs WHERE id = 'job-new'")
      .get() as {
      status: string;
      progress: string;
      config: string;
      next_run_at: number | null;
    };

  it('drains again, then completes, when the predecessor left the route quarantining', async () => {
    seedRoute(admin, 'quarantining');
    const log = { info: vi.fn(), error: vi.fn() };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(START);
      const startSeconds = Math.floor(START.getTime() / 1000);
      await processPendingTenantDeletionJobs(controlEnvironment(), log);

      // The drain restarted: waiting, with the deadline recorded, nothing destructive run.
      expect(row().status).toBe('pending');
      expect(JSON.parse(row().progress)).toMatchObject({ stage: 'quarantine_draining' });
      expect(JSON.parse(row().config)).toMatchObject({
        operation_id: CHAIN,
        quarantine_started_at: startSeconds,
      });
      expect(row().next_run_at).toBe(startSeconds + 30 * 60);
      expect(hooks.destructive).toEqual([]);

      // Before the deadline the job is not selected at all.
      vi.setSystemTime(new Date(START.getTime() + 10 * 60 * 1000));
      await processPendingTenantDeletionJobs(controlEnvironment(), log);
      expect(row().status).toBe('pending');
      expect(hooks.destructive).toEqual([]);

      // After it the job runs on to the end, without publishing `quarantining` again.
      vi.setSystemTime(new Date(START.getTime() + 31 * 60 * 1000));
      await processPendingTenantDeletionJobs(controlEnvironment(), log);
    } finally {
      vi.useRealTimers();
    }
    expect(log.error).not.toHaveBeenCalled();
    expect(row().status).toBe('completed');
    expect(hooks.destructive).toEqual(['lookup', 'purge', 'finalize']);
    expect(hooks.publishes).toEqual([
      `quarantining:${CHAIN}`,
      `quarantined:${CHAIN}`,
      `disabled:${CHAIN}`,
    ]);
  });

  it('skips the drain and completes when the predecessor left the route quarantined', async () => {
    seedRoute(admin, 'quarantined');
    const log = { info: vi.fn(), error: vi.fn() };
    await processPendingTenantDeletionJobs(controlEnvironment(), log);
    expect(log.error).not.toHaveBeenCalled();
    expect(jobStatus()).toMatchObject({ status: 'completed' });
    expect(hooks.publishes).toEqual([`quarantined:${CHAIN}`, `disabled:${CHAIN}`]);
  });

  function seedFailedStores(db: SQLiteDatabase) {
    for (const [role, shardGroup] of [
      ['tenant_core', 'default'],
      ['tenant_pii', 'default'],
    ]) {
      db.prepare(
        `INSERT INTO tenant_database_registry (
           tenant_id, role, generation, shard_group, shard_index, provider, database_id,
           database_name, binding_ref, schema_version, status, shard_count, shard_key_strategy,
           deployment_target, metadata_json
         ) VALUES (?, ?, 1, ?, 0, 'd1', ?, ?, ?, 2, 'failed', 1, 'none', 'default', '{}')`
      ).run(TENANT, role, shardGroup, `db-${role}`, `name-${role}`, `BIND_${role}`);
      db.prepare(
        `INSERT INTO tenant_database_active_pointers (
           tenant_id, role, shard_group, generation, shard_count, shard_key_strategy,
           runtime_generation, status
         ) VALUES (?, ?, ?, 1, 1, 'none', 2, 'active')`
      ).run(TENANT, role, shardGroup);
    }
  }

  it('completes when the predecessor left the route disabled over failed registry rows and active pointers', async () => {
    seedRoute(admin, 'disabled');
    seedFailedStores(admin);
    const env = controlEnvironment() as { CONTROL: Record<string, unknown> };
    const log = { info: vi.fn(), error: vi.fn() };
    await processPendingTenantDeletionJobs(
      {
        ...env,
        CONTROL: {
          ...env.CONTROL,
          getTenantDeletionInventory: async ({
            tenantId,
            operationId,
          }: Record<string, string>) => ({
            environmentId: 'test',
            tenantId,
            operationId,
            state: 'finalized',
            lookupShards: [],
            tenantShards: [],
          }),
        },
      } as never,
      log
    );
    expect(log.error).not.toHaveBeenCalled();
    expect(jobStatus()).toMatchObject({ status: 'completed' });
    expect(hooks.publishes).toEqual([`disabled:${CHAIN}`]);
    const statuses = (table: string) =>
      (
        admin.prepare(`SELECT DISTINCT status FROM ${table} WHERE tenant_id = ?`).all(TENANT) as {
          status: string;
        }[]
      ).map((row) => row.status);
    expect(statuses('tenant_database_active_pointers')).toEqual(['disabled']);
    expect(statuses('tenant_database_registry')).toEqual(['deleted']);
  });
});
