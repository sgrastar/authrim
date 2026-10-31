import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';
import { registerDeclaredAdminRouteAccessMiddleware } from '../admin-route-access';

import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS, type AdminAuthContext } from '@authrim/ar-lib-core';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import {
  environmentReplicationGrantsRouter,
  environmentReplicationMachineRouter,
} from '../routes/replication-environments';
import { EnvironmentInventoryGrantStore } from '../environment-replication-grants';
import { TenantBackupReplicationGrantStore } from '../tenant-backup-replication-grants';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
const state = vi.hoisted(() => ({
  db: undefined as unknown,
  auth: undefined as unknown,
  audit: vi.fn(),
  inventory: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  adminAuthMiddleware:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('adminAuth', state.auth);
      await next();
    },
  getTenantIdFromContext: () => 'admin-tenant',
  requireDedicatedAdminDatabaseAdapter: () => state.db,
}));
vi.mock('../admin-shared', () => ({ writeAdminAuditLog: state.audit }));
vi.mock('../environment-replication-inventory', async (original) => ({
  ...(await original<typeof import('../environment-replication-inventory')>()),
  readEnvironmentReplicationInventory: state.inventory,
}));
let db: SQLiteDatabase;
let adapter: Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
let auth: AdminAuthContext;
const installed = {
  version: 2 as const,
  endpoint: 'https://authority.example.test/replication/v1/rpc',
  credentialId: 'writer',
  pairId: 'pair-a',
  environmentId: 'test',
  deploymentId: 'cf-a',
  epoch: 1,
  generationId: 'initial',
};
const env = {
  AUTHRIM_ENVIRONMENT_NAME: 'test',
  AUTHRIM_REPLICATION_WRITER: JSON.stringify(installed),
};
const app = new Hono();
app.use('/api/admin/*', async (c, next) => {
  (c as unknown as { set(key: string, value: unknown): void }).set('adminAuth', state.auth);
  await next();
});
registerDeclaredAdminRouteAccessMiddleware(app);
app.route('/api/admin/replication-environments', environmentReplicationGrantsRouter);
app.route('/api/replication-environments', environmentReplicationMachineRouter);
beforeEach(() => {
  vi.resetAllMocks();
  db = new DatabaseSync(':memory:');
  db.exec(
    readRenderedMigrationSql(
      new URL('../../../../migrations/admin/d1/', import.meta.url),
      '001_0_5_0_admin_baseline.sql'
    )
  );
  adapter = {
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) ?? null) as T | null;
    },
    async execute(sql, params = []) {
      const r = db.prepare(sql).run(...(params as SQLInputValue[]));
      return { success: true, rowsAffected: Number(r.changes) };
    },
  };
  state.db = adapter;
  auth = {
    userId: 'human',
    actorId: 'human',
    actorType: 'human',
    authMethod: 'session',
    tenantId: 'admin-tenant',
    roles: ['ar_super_admin'],
    globalRoles: ['ar_super_admin'],
    tenantScope: ['*'],
    permissions: [ADMIN_PERMISSIONS.BACKUPS_MANAGE],
    mfaVerified: true,
    authenticationTimeMs: Date.now(),
  };
  state.auth = auth;
  state.audit.mockResolvedValue('audit-a');
  state.inventory.mockResolvedValue({
    formatVersion: 1,
    environmentId: 'test',
    complete: true,
    inventorySha256: 'a'.repeat(64),
    tenants: [{ tenantId: 'tenant-a' }],
  });
});
afterEach(() => db.close());
async function create() {
  const response = await app.request(
    '/api/admin/replication-environments/grants',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairId: 'pair-a',
        sourceDeploymentId: 'cf-a',
        destinationDeploymentId: 'aws-a',
        expiresAt: Date.now() + 60000,
      }),
    },
    env
  );
  expect(response.status).toBe(201);
  const value: unknown = await response.json();
  return value as { grant: { id: string }; credential: string };
}
function read(
  grant: { grant: { id: string }; credential: string },
  changes: { owner?: string; credential?: string } = {}
) {
  return app.request(
    `/api/replication-environments/${grant.grant.id}/inventory`,
    {
      headers: {
        Authorization: `Bearer ${changes.credential ?? grant.credential}`,
        'X-Tenant-Id': changes.owner ?? 'admin-tenant',
      },
    },
    env
  );
}
it('delegates only metadata and audits issuance and each read', async () => {
  const grant = await create();
  const response = await read(grant);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ complete: true });
  expect(state.audit).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(state.audit.mock.calls)).not.toContain(grant.credential);
});
it.each(['tenant-admin', 'stale', 'machine', 'missing-mfa', 'no-permission'])(
  'refuses %s inventory grant issuance',
  async (kind) => {
    if (kind === 'tenant-admin') auth.globalRoles = [];
    if (kind === 'stale') auth.authenticationTimeMs = Date.now() - 360000;
    if (kind === 'machine') auth.authMethod = 'machine_access_token';
    if (kind === 'missing-mfa') auth.mfaVerified = false;
    if (kind === 'no-permission') auth.permissions = [];
    const response = await app.request(
      '/api/admin/replication-environments/grants',
      { method: 'POST', body: '{}' },
      env
    );
    expect(response.status).toBe(403);
    expect(state.audit).not.toHaveBeenCalled();
  }
);
it('rejects wrong owner, wrong token, expired and revoked grants before inventory reads', async () => {
  const g = await create();
  expect((await read(g, { owner: 'other' })).status).toBe(403);
  expect((await read(g, { credential: 'b'.repeat(64) })).status).toBe(403);
  await new EnvironmentInventoryGrantStore(adapter).revoke({
    tenantId: 'admin-tenant',
    id: g.grant.id,
    actorId: 'human',
    auditId: 'audit-revoke',
    now: Date.now(),
  });
  expect((await read(g)).status).toBe(403);
  expect(state.inventory).not.toHaveBeenCalled();
});
it('an inventory credential cannot authenticate as a tenant export credential', async () => {
  const g = await create();
  await expect(
    new TenantBackupReplicationGrantStore(adapter).authenticate({
      tenantId: 'admin-tenant',
      id: g.grant.id,
      credential: g.credential,
      now: Date.now(),
      installed,
    })
  ).rejects.toThrow();
});
it('audit failure returns no grant or metadata', async () => {
  state.audit.mockResolvedValue(null);
  const response = await app.request(
    '/api/admin/replication-environments/grants',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairId: 'pair-a',
        sourceDeploymentId: 'cf-a',
        destinationDeploymentId: 'aws-a',
        expiresAt: Date.now() + 60000,
      }),
    },
    env
  );
  expect(response.status).toBe(503);
  expect(
    db.prepare('SELECT COUNT(*) AS count FROM tenant_backup_replication_grants').get()
  ).toEqual({ count: 0 });
});
it('does not expose inventory after revocation during metadata collection', async () => {
  const g = await create();
  state.inventory.mockImplementation(async () => {
    await new EnvironmentInventoryGrantStore(adapter).revoke({
      tenantId: 'admin-tenant',
      id: g.grant.id,
      actorId: 'human',
      auditId: 'audit-revoke',
      now: Date.now(),
    });
    return { environmentId: 'test', tenants: [], inventorySha256: 'a'.repeat(64) };
  });
  expect((await read(g)).status).toBe(503);
});

it('permits exact grant revocation through the global gate and denies adjacent undeclared mutations', async () => {
  const g = await create();
  const revoked = await app.request(
    `/api/admin/replication-environments/grants/${g.grant.id}/revoke`,
    { method: 'POST' },
    env
  );
  expect(revoked.status).toBe(200);
  expect((await read(g)).status).toBe(403);
  expect(
    (await app.request('/api/admin/replication-environments/force', { method: 'POST' }, env)).status
  ).toBe(403);
});
