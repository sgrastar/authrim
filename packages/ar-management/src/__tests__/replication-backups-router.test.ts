import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS, type AdminAuthContext } from '@authrim/ar-lib-core';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import {
  replicationBackupGrantsRouter,
  replicationBackupMachineRouter,
} from '../routes/replication-backups';
import { TenantBackupReplicationGrantStore } from '../tenant-backup-replication-grants';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  auth: undefined as unknown,
  audit: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  load: vi.fn(),
  start: vi.fn(),
  status: vi.fn(),
  issue: vi.fn(),
  accept: vi.fn(),
  receipt: vi.fn(),
  download: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  adminAuthMiddleware:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('adminAuth', state.auth);
      await next();
    },
  getTenantIdFromContext: (c: { get: (k: string) => unknown }) => c.get('tenantId') ?? 'tenant-a',
  requireDedicatedAdminDatabaseAdapter: () => state.db,
}));
vi.mock('../admin-shared', () => ({ writeAdminAuditLog: state.audit }));
vi.mock('../request-issuer', () => ({
  getCanonicalTenantBaseUrlAsync: async () => 'https://idp.example.test',
}));
vi.mock('../tenant-backup-services', () => ({
  getTenantBackupKeyStore: async () => ({ issue: state.issue, accept: state.accept }),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/operation-request', () => ({
  TenantBackupRequestStore: class {
    create = state.create;
    load = state.load;
    start = state.start;
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/operation-store', () => ({
  TenantBackupOperationStore: class {
    get = state.get;
  },
}));
vi.mock('../tenant-backup-operation-read-model', () => ({
  TenantBackupOperationReadModel: class {
    get = state.status;
  },
}));
vi.mock('../tenant-backup-export-receipt', () => ({
  readTenantBackupExportReceipt: state.receipt,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/published-artifact-reader', () => ({
  openTenantBackupDownload: state.download,
}));

let db: SQLiteDatabase;
let adapter: Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
let auth: AdminAuthContext;
const installed = {
  version: 1 as const,
  endpoint: 'https://authority.example.test/replication/v1/rpc',
  credentialId: 'source',
  pairId: 'pair-a',
  tenantId: 'tenant-a',
  deploymentId: 'cf-main',
  epoch: 1,
  generationId: 'generation-a',
};
const selection = {
  settings: true,
  users: true,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
};
const env = { AUTHRIM_REPLICATION_WRITER: JSON.stringify(installed), EXPORT_ARTIFACTS: {} };
const scope = {
  version: 1,
  kind: 'tenant_backup_export',
  tenantId: 'tenant-a',
  pairId: 'pair-a',
  sourceDeploymentId: 'cf-main',
  destinationDeploymentId: 'aws-secondary',
  issuer: 'https://idp.example.test',
  selection,
};
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
    async queryOne<T>(sql: string, params?: unknown[]) {
      return (db.prepare(sql).get(...((params ?? []) as SQLInputValue[])) ?? null) as T | null;
    },
    async execute(sql, params) {
      const r = db.prepare(sql).run(...((params ?? []) as SQLInputValue[]));
      return { success: true, rowsAffected: Number(r.changes) };
    },
  };
  state.db = adapter;
  auth = {
    userId: 'admin-a',
    actorId: 'admin-a',
    actorType: 'human',
    authMethod: 'session',
    tenantId: 'tenant-a',
    roles: [],
    permissions: [
      ADMIN_PERMISSIONS.BACKUPS_READ,
      ADMIN_PERMISSIONS.BACKUPS_MANAGE,
      ADMIN_PERMISSIONS.BACKUPS_EXPORT,
    ],
    mfaVerified: true,
    authenticationTimeMs: Date.now(),
  };
  state.auth = auth;
  state.audit.mockResolvedValue('audit-a');
  state.create.mockImplementation(async (v: { id: string }) => ({
    id: v.id,
    state: 'waiting',
    phase: 'unlock',
    revision: 0,
  }));
  state.start.mockResolvedValue({
    id: 'operation-a',
    state: 'queued',
    phase: 'prepare',
    revision: 1,
  });
  state.issue.mockResolvedValue({
    publicKey: { kty: 'RSA' },
    context: { challengeId: 'challenge-a' },
    submitExpiresAt: Date.now() + 10000,
  });
  state.accept.mockResolvedValue(undefined);
  state.receipt.mockResolvedValue({ formatVersion: 1, receipt: { parts: [] } });
  state.status.mockResolvedValue({
    operation: { private: 'INTERNAL' },
    intent: { private: 'INTERNAL' },
    view: { id: 'operation-a', state: 'running', phase: 'export_artifact' },
  });
});
afterEach(() => db.close());
function request(
  path: string,
  method = 'GET',
  body?: unknown,
  credential?: string,
  tenant = 'tenant-a'
) {
  const app = new Hono();
  app.route('/api/admin/replication-backups', replicationBackupGrantsRouter as never);
  app.route('/api/replication-backups', replicationBackupMachineRouter as never);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (credential) headers.Authorization = `Bearer ${credential}`;
  if (tenant) headers['X-Tenant-Id'] = tenant;
  return app.request(
    path,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    env
  );
}
async function delegated() {
  const result = await new TenantBackupReplicationGrantStore(adapter).create({
    tenantId: 'tenant-a',
    actorId: 'admin-a',
    scope,
    expiresAt: Date.now() + 60000,
    now: Date.now(),
    auditId: 'audit-created',
    installed,
  });
  state.get.mockResolvedValue({
    id: 'operation-a',
    kind: 'export',
    created_by: `replication-export:${result.grant.id}`,
    state: 'waiting',
    phase: 'unlock',
    revision: 0,
  });
  state.load.mockResolvedValue({
    kind: 'export',
    source: { tenantId: 'tenant-a', issuer: scope.issuer, productVersion: '0.4.2' },
    selection,
  });
  return { ...result, base: `/api/replication-backups/${result.grant.id}/exports` };
}
describe('human replication export authorization', () => {
  it('issues a credential once after fresh human approval and revokes it with durable audit evidence', async () => {
    const response = await request('/api/admin/replication-backups/grants', 'POST', {
      pairId: 'pair-a',
      sourceDeploymentId: 'cf-main',
      destinationDeploymentId: 'aws-secondary',
      selection,
      expiresAt: Date.now() + 60000,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const parsed: unknown = JSON.parse(await response.text());
    const result = parsed as { grant: { id: string }; credential: string };
    expect(result.credential).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.stringify(db.prepare('SELECT * FROM tenant_backup_replication_grants').all())
    ).not.toContain(result.credential);
    expect(
      (await request(`/api/admin/replication-backups/grants/${result.grant.id}/revoke`, 'POST'))
        .status
    ).toBe(200);
    expect(
      (
        await request(
          `/api/replication-backups/${result.grant.id}/exports`,
          'POST',
          { idempotencyKey: 'request-a' },
          result.credential
        )
      ).status
    ).toBe(403);
    expect(state.create).not.toHaveBeenCalled();
  });
  it('issues a grant for a backup that carries environment-wide SAML DR data only to a global administrator', async () => {
    const body = {
      pairId: 'pair-a',
      sourceDeploymentId: 'cf-main',
      destinationDeploymentId: 'aws-secondary',
      selection,
      expiresAt: Date.now() + 60000,
    };
    const withExtension = { ...env, ENABLE_SAML_DR_EXPORT: 'true' };
    const issue = (app: Hono) =>
      app.request(
        '/api/admin/replication-backups/grants',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'tenant-a' },
          body: JSON.stringify(body),
        },
        withExtension
      );
    const app = new Hono();
    app.route('/api/admin/replication-backups', replicationBackupGrantsRouter as never);
    expect((await issue(app)).status).toBe(403);
    expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_replication_grants').get()).toEqual({
      n: 0,
    });
    auth.tenantScope = ['*'];
    auth.globalPermissions = [ADMIN_PERMISSIONS.BACKUPS_EXPORT];
    expect((await issue(app)).status).toBe(201);
  });
  it.each([
    'stale',
    'machine',
    'missing-export',
    'sensitive',
    'wrong-source',
    'wrong-pair',
    'audit-failed',
  ])('denies %s issuance without persisting a credential', async (kind) => {
    const body = {
      pairId: 'pair-a',
      sourceDeploymentId: 'cf-main',
      destinationDeploymentId: 'aws-secondary',
      selection: structuredClone(selection),
      expiresAt: Date.now() + 60000,
    };
    if (kind === 'stale') auth.authenticationTimeMs = 1;
    if (kind === 'machine') auth.actorType = 'machine';
    if (kind === 'missing-export')
      auth.permissions = [ADMIN_PERMISSIONS.BACKUPS_READ, ADMIN_PERMISSIONS.BACKUPS_MANAGE];
    if (kind === 'sensitive') body.selection.logs.sensitive = true;
    if (kind === 'wrong-source') body.sourceDeploymentId = 'aws-secondary';
    if (kind === 'wrong-pair') body.pairId = 'other';
    if (kind === 'audit-failed') state.audit.mockResolvedValue(null);
    const response = await request('/api/admin/replication-backups/grants', 'POST', body);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_replication_grants').get()).toEqual({
      n: 0,
    });
  });
});
describe('delegated export-only control', () => {
  it('binds idempotent creation to fixed grant scope and uses only the existing encrypted key pipeline', async () => {
    const f = await delegated();
    const created = await request(f.base, 'POST', { idempotencyKey: 'cycle-a' }, f.credential);
    expect(created.status).toBe(201);
    const second = await request(f.base, 'POST', { idempotencyKey: 'cycle-a' }, f.credential);
    expect(await second.json()).toEqual(await created.json());
    expect(state.create.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-a',
      actorId: `replication-export:${f.grant.id}`,
      intent: {
        kind: 'export',
        source: { tenantId: 'tenant-a', issuer: scope.issuer },
        selection,
        inputs: [],
      },
    });
    expect(
      (await request(`${f.base}/operation-a/key-challenges`, 'POST', undefined, f.credential))
        .status
    ).toBe(201);
    expect(state.issue).toHaveBeenCalledWith(
      'tenant-a',
      'operation-a',
      `replication-export:${f.grant.id}`,
      expect.any(Number)
    );
    expect(
      (
        await request(
          `${f.base}/operation-a/key-challenges/challenge-a/accept`,
          'POST',
          { envelope: 'a'.repeat(186), handoff: 'b'.repeat(512) },
          f.credential
        )
      ).status
    ).toBe(200);
    expect(state.accept).toHaveBeenCalledWith(
      'tenant-a',
      'operation-a',
      `replication-export:${f.grant.id}`,
      'challenge-a',
      new Uint8Array(93).fill(170),
      new Uint8Array(256).fill(187),
      expect.any(Number)
    );
    expect(
      (
        await request(
          `${f.base}/operation-a/start`,
          'POST',
          { revision: 0, challengeId: 'challenge-a' },
          f.credential
        )
      ).status
    ).toBe(202);
    expect(state.start).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      actorId: `replication-export:${f.grant.id}`,
      challengeId: 'challenge-a',
      revision: 0,
      now: expect.any(Number) as unknown,
    });
    const auditRecords = JSON.stringify(state.audit.mock.calls.map((call): unknown => call[1]));
    expect(auditRecords).toContain('admin-a');
    expect(auditRecords).toContain(f.grant.id);
    expect(auditRecords).not.toContain(f.credential);
    expect(auditRecords).not.toContain('a'.repeat(186));
  });
  it('exposes only sanitized status and separately authenticated receipt', async () => {
    const f = await delegated();
    const status = await request(`${f.base}/operation-a`, 'GET', undefined, f.credential);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      id: 'operation-a',
      state: 'running',
      phase: 'export_artifact',
    });
    expect(
      (await request(`${f.base}/operation-a/export-receipt`, 'GET', undefined, f.credential)).status
    ).toBe(200);
    expect(state.receipt).toHaveBeenCalledOnce();
  });
  it.each(['missing-tenant', 'wrong-tenant', 'wrong-credential', 'expired', 'revoked'])(
    'denies %s before any export side effect',
    async (kind) => {
      const f = await delegated();
      if (kind === 'expired')
        db.exec(
          'DROP TRIGGER tenant_backup_replication_grant_immutable; UPDATE tenant_backup_replication_grants SET created_at=0,expires_at=1000'
        );
      if (kind === 'revoked')
        await new TenantBackupReplicationGrantStore(adapter).revoke({
          tenantId: 'tenant-a',
          id: f.grant.id,
          actorId: 'admin-a',
          auditId: 'audit-revoked',
          now: Date.now(),
        });
      const response = await request(
        f.base,
        'POST',
        { idempotencyKey: 'cycle-a' },
        kind === 'wrong-credential' ? 'c'.repeat(64) : f.credential,
        kind === 'missing-tenant' ? '' : kind === 'wrong-tenant' ? 'tenant-b' : 'tenant-a'
      );
      expect(response.status).toBe(403);
      expect(state.create).not.toHaveBeenCalled();
      expect(state.audit).not.toHaveBeenCalled();
    }
  );
  it.each(['another-grant', 'import', 'expanded-selection', 'other-issuer'])(
    'denies operation outside grant: %s',
    async (kind) => {
      const f = await delegated();
      if (kind === 'another-grant')
        state.get.mockResolvedValue({
          id: 'operation-a',
          kind: 'export',
          created_by: 'replication-export:other',
        });
      if (kind === 'import')
        state.get.mockResolvedValue({
          id: 'operation-a',
          kind: 'import',
          created_by: `replication-export:${f.grant.id}`,
        });
      if (kind === 'expanded-selection')
        state.load.mockResolvedValue({
          kind: 'export',
          source: { tenantId: 'tenant-a', issuer: scope.issuer },
          selection: { ...selection, admin: true },
        });
      if (kind === 'other-issuer')
        state.load.mockResolvedValue({
          kind: 'export',
          source: { tenantId: 'tenant-a', issuer: 'https://other.example.test' },
          selection,
        });
      expect(
        (
          await request(
            `${f.base}/operation-a/start`,
            'POST',
            { revision: 0, challengeId: 'challenge-a' },
            f.credential
          )
        ).status
      ).toBe(403);
      expect(state.start).not.toHaveBeenCalled();
      expect(state.audit).not.toHaveBeenCalled();
    }
  );
  it('never accepts a passphrase, wider selection, import, approval or general admin mutation', async () => {
    const f = await delegated();
    for (const body of [
      { idempotencyKey: 'cycle-a', selection },
      { idempotencyKey: 'cycle-a', passphrase: 'do-not-send' },
    ])
      expect((await request(f.base, 'POST', body, f.credential)).status).toBe(400);
    for (const path of ['imports', 'operation-a/approve', 'operation-a/cancel', 'users/user-a'])
      expect(
        (await request(`/api/replication-backups/${f.grant.id}/${path}`, 'POST', {}, f.credential))
          .status
      ).toBe(404);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.accept).not.toHaveBeenCalled();
  });
  it('does not submit keys/start/download after audit failure', async () => {
    const f = await delegated();
    state.audit.mockResolvedValue(null);
    expect(
      (
        await request(
          `${f.base}/operation-a/start`,
          'POST',
          { revision: 0, challengeId: 'challenge-a' },
          f.credential
        )
      ).status
    ).toBe(503);
    expect(
      (await request(`${f.base}/operation-a/key-challenges`, 'POST', undefined, f.credential))
        .status
    ).toBe(503);
    expect(state.start).not.toHaveBeenCalled();
    expect(state.issue).not.toHaveBeenCalled();
  });
  it('rechecks revocation after reading each encrypted download part before emitting bytes', async () => {
    const f = await delegated();
    state.download.mockResolvedValue({
      byteCount: 3,
      chunks: {
        async *[Symbol.asyncIterator]() {
          await new TenantBackupReplicationGrantStore(adapter).revoke({
            tenantId: 'tenant-a',
            id: f.grant.id,
            actorId: 'admin-a',
            auditId: 'audit-revoked',
            now: Date.now(),
          });
          yield new Uint8Array([1, 2, 3]);
        },
      },
    });
    const response = await request(
      `${f.base}/operation-a/download`,
      'GET',
      undefined,
      f.credential
    );
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow('backup_download_unavailable');
  });
});
