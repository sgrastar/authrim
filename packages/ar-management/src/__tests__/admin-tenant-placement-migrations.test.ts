import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type {
  AdminAuthContext,
  ControlTenantPlacementMigrationView,
  DatabaseAdapter,
  Env,
  TransactionContext,
} from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminTenantPlacementMigrationCancelHandler,
  adminTenantPlacementMigrationGetHandler,
  adminTenantPlacementMigrationStartHandler,
} from '../admin-tenant-placement-migrations';
import { TenantPlacementMigrationJobRepository } from '../tenant-placement-migration-job';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...original, createAuditLog: vi.fn(async () => {}) };
});

vi.mock('../tenant-placement-migration-scheduled', () => ({
  processNextTenantPlacementMigration: vi.fn(async () => false),
}));

function adapter(database: DatabaseSync): DatabaseAdapter {
  const result = {
    async query<T>(sql: string, params: unknown[] = []) {
      return database.prepare(sql).all(...(params as never[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (database.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      const executed = database.prepare(sql).run(...(params as never[]));
      return { success: true, rowsAffected: Number(executed.changes) };
    },
    async transaction<T>(fn: (tx: TransactionContext) => Promise<T>) {
      return fn(result as unknown as TransactionContext);
    },
    async batch() {
      throw new Error('not implemented');
    },
    async isHealthy() {
      return { healthy: true, latencyMs: 0, type: 'sqlite-test' };
    },
    getType: () => 'sqlite-test',
    async close() {},
  };
  return result as unknown as DatabaseAdapter;
}

function controlView(overrides: Partial<ControlTenantPlacementMigrationView> = {}) {
  const roles = ['tenant_core/default', 'tenant_core/users', 'tenant_pii'] as const;
  return {
    operationId: 'tenant-placement:abc',
    tenantId: 'tenant-a',
    state: 'planning',
    sourceIsolationPolicy: 'shared_pool',
    targetIsolationPolicy: 'tenant_exclusive',
    sourcePolicyGeneration: 1,
    targetPolicyGeneration: 2,
    writeFenceState: 'inactive',
    routeCutoverStarted: false,
    canCancel: true,
    canApprovePurge: false,
    sourceRetentionExpiresAt: null,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
    shards: roles.map((dataRole, index) => ({
      dataRole,
      residencyPolicyId: 'builtin:residency:default',
      residencyPartition: 'default',
      sourceShardId: `source-${index}`,
      sourceAssignmentGeneration: 1,
      targetShardId: null,
      target: null,
      state: 'target_pending' as const,
      inventoryTableCount: null,
      sourceRowCount: null,
      targetRowCount: null,
      lastObservedSourceSequence: 0,
      lastAppliedSourceSequence: 0,
      lastErrorCode: null,
      updatedAt: 1,
    })),
    ...overrides,
  } satisfies ControlTenantPlacementMigrationView;
}

describe('Admin tenant placement migration API', () => {
  let adminDatabase: DatabaseSync;
  let platformDatabase: DatabaseSync;
  let admin: DatabaseAdapter;
  let platform: DatabaseAdapter;

  beforeEach(() => {
    adminDatabase = new DatabaseSync(':memory:');
    adminDatabase.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/admin/035_tenant_placement_migration_jobs.sql'),
        'utf8'
      )
    );
    platformDatabase = new DatabaseSync(':memory:');
    platformDatabase.exec(
      `CREATE TABLE tenants (
         id TEXT PRIMARY KEY, isolation_policy TEXT NOT NULL, lifecycle_state TEXT NOT NULL
       );
       INSERT INTO tenants VALUES ('tenant-a', 'shared_pool', 'active');`
    );
    admin = adapter(adminDatabase);
    platform = adapter(platformDatabase);
  });

  afterEach(() => {
    adminDatabase.close();
    platformDatabase.close();
  });

  function app(env: Env) {
    const value = new Hono<{
      Bindings: Env;
      Variables: { adminAuth?: AdminAuthContext };
    }>();
    value.use('*', async (c, next) => {
      c.set('adminAuth', {
        userId: 'admin@example.com',
        authMethod: 'session',
        roles: ['system_admin'],
      });
      await next();
    });
    value.post('/tenants/:id/placement-migrations', adminTenantPlacementMigrationStartHandler);
    value.get(
      '/tenants/:id/placement-migrations/:operationId',
      adminTenantPlacementMigrationGetHandler
    );
    value.post(
      '/tenants/:id/placement-migrations/:operationId/cancel',
      adminTenantPlacementMigrationCancelHandler
    );
    return { value, env };
  }

  it('starts an exclusive migration and stores a Control-safe actor identifier', async () => {
    const start = vi.fn(
      async (_input: {
        tenantId: string;
        targetIsolationPolicy: 'tenant_exclusive';
        idempotencyKey: string;
        requestedById: string;
      }) => controlView()
    );
    const get = vi.fn(async () => controlView());
    const env = {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      DB: platform,
      DB_ADMIN: admin,
      CONTROL: { startTenantPlacementMigration: start, getTenantPlacementMigration: get },
    } as unknown as Env;
    const test = app(env);
    const response = await test.value.request(
      '/tenants/tenant-a/placement-migrations',
      { method: 'POST', headers: { 'Idempotency-Key': 'request-a' } },
      test.env,
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext
    );

    expect(response.status).toBe(202);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', targetIsolationPolicy: 'tenant_exclusive' })
    );
    const requestedById = start.mock.calls[0]![0].requestedById;
    expect(requestedById).toMatch(/^admin:[a-f0-9]{64}$/u);
    const stored = await new TenantPlacementMigrationJobRepository(admin).get(
      'tenant-placement:abc',
      'test'
    );
    expect(stored?.requestedBy).toBe(requestedById);
  });

  it('does not disclose a migration through a different tenant path', async () => {
    await new TenantPlacementMigrationJobRepository(admin).create({
      operationId: 'tenant-placement:abc',
      environmentId: 'test',
      tenantId: 'tenant-a',
      controlOperationId: 'tenant-placement:abc',
      requestHash: 'a'.repeat(64),
      idempotencyKey: 'request-a',
      requestedBy: 'admin-a',
      now: 1,
    });
    const env = {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      DB: platform,
      DB_ADMIN: admin,
      CONTROL: { getTenantPlacementMigration: vi.fn(async () => controlView()) },
    } as unknown as Env;
    const test = app(env);
    const response = await test.value.request(
      '/tenants/tenant-b/placement-migrations/tenant-placement:abc',
      undefined,
      test.env
    );
    expect(response.status).toBe(404);
  });

  it('rejects cancellation after route cutover starts', async () => {
    await new TenantPlacementMigrationJobRepository(admin).create({
      operationId: 'tenant-placement:abc',
      environmentId: 'test',
      tenantId: 'tenant-a',
      controlOperationId: 'tenant-placement:abc',
      requestHash: 'a'.repeat(64),
      idempotencyKey: 'request-a',
      requestedBy: 'admin-a',
      now: 1,
    });
    const cancel = vi.fn();
    const env = {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      DB: platform,
      DB_ADMIN: admin,
      CONTROL: {
        getTenantPlacementMigration: vi.fn(async () =>
          controlView({ routeCutoverStarted: true, canCancel: false, state: 'cutover_ready' })
        ),
        cancelTenantPlacementMigration: cancel,
      },
    } as unknown as Env;
    const test = app(env);
    const response = await test.value.request(
      '/tenants/tenant-a/placement-migrations/tenant-placement:abc/cancel',
      { method: 'POST', headers: { 'Idempotency-Key': 'cancel-a' } },
      test.env
    );
    expect(response.status).toBe(409);
    expect(cancel).not.toHaveBeenCalled();
  });
});
