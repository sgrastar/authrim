import { describe, expect, it, vi } from 'vitest';

vi.mock('../admin-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-shared')>();
  return { ...actual, writeAdminAuditLog: vi.fn(async () => 'audit') };
});

import { adminAuthMiddleware } from '@authrim/ar-lib-core';
import { controlPlaneOperationsRouter } from '../routes/admin-management/control-plane-operations';
import { TENANT, createTokenKit, setupApp } from './helpers/admin-authority-fixture';

/**
 * A tenant recovery record is addressed by an operation id and names its tenant itself: the path
 * names none, so the Admin API authentication cannot judge it. The handler judges the record's
 * tenant. Real: the authentication, the router and the handler; the control service is a stub
 * that returns a valid record for the operation id.
 */

const PROTECTED = 'tenant-prot';
const READ = 'admin:control_plane:read';
const PATH = '/api/admin/platform/control-plane/tenant-recovery';

const RECOVERY = {
  environmentId: 'test',
  state: 'reprojecting_lookup',
  pinnedRouteGeneration: 7,
  denyRuntimeGeneration: 8,
  denyRegistryGeneration: 9,
  denyObservedAt: 1_800_000_000,
  drainNotBefore: 1_800_001_800,
  restoreReferenceRecorded: true,
  restoredAt: 1_800_001_900,
  migrationVerifiedAt: 1_800_001_910,
  lookupReprojectedAt: null,
  lookupReprojection: {
    stage: 'email_exact',
    targetIndex: 1,
    afterCreatedAt: 1_800_000_100,
    afterId: 'email-row-1',
    afterRowId: 0,
    projectedRows: 25,
    verifiedRows: 0,
    registryDigestPinned: true,
    leaseActive: true,
  },
  bindingSmokeVerifiedAt: null,
  reactivatedRuntimeGeneration: null,
  reactivatedAt: null,
  lastErrorCode: null,
  canCancel: false,
  canConfirmRestore: false,
  canVerify: false,
  canReactivate: false,
  targets: [
    {
      shardId: 'shard-1',
      dataRole: 'tenant_core/users',
      residencyPartition: 'apac',
      assignmentGeneration: 2,
      shardGeneration: 7,
      bindingRef: 'TEST_TDB_USERS_1234_CORE',
      providerDatabaseId: '11111111-1111-4111-8111-111111111111',
      migrationStreamId: 'core-d1',
      releaseId: '0.4.0',
      manifestDigest: 'd'.repeat(64),
      restoreConfirmedAt: 1_800_001_900,
      migrationVerifiedAt: 1_800_001_910,
      lookupReprojectedAt: null,
      bindingSmokeVerifiedAt: null,
    },
  ],
  createdAt: 1_800_000_000,
  updatedAt: 1_800_001_920,
};

async function setup(exclude: string) {
  const kit = await createTokenKit();
  const context = setupApp(
    (app) => {
      app.use('/api/admin/*', async (c, next) => {
        const header = c.req.header('X-Tenant-Id');
        if (header) (c as unknown as { set(k: string, v: unknown): void }).set('tenantId', header);
        await next();
      });
      app.use('/api/admin/*', adminAuthMiddleware({ plane: 'tenant' }));
      app.route('/api/admin/platform/control-plane', controlPlaneOperationsRouter);
    },
    {
      ...kit.env,
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      CONTROL: {
        getTenantDisasterRecovery: async (operationId: string) => ({
          ...RECOVERY,
          operationId,
          tenantId: operationId === 'tenant-dr:prot' ? PROTECTED : 'tenant-open',
        }),
      },
      MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: exclude,
    }
  );
  let sequence = 0;
  const now = Date.now();
  const principal = (type: string) => {
    sequence += 1;
    const id = `amp_c${sequence}`;
    context.db
      .prepare(
        `INSERT INTO admin_machine_principals (id, client_id, display_name, principal_type, status,
           default_audience, token_ttl_seconds, created_at, updated_at)
         VALUES (?, ?, 'C', ?, 'active', 'authrim:admin-api', 600, ?, ?)`
      )
      .run(id, `client-${id}`, type, now, now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_credentials (id, principal_id, kid, public_jwk_json, alg, display_name,
           status, created_at, updated_at) VALUES (?, ?, ?, '{"kty":"EC"}', 'ES256', 'K', 'active', ?, ?)`
      )
      .run(`amk_${id}`, id, `kid-${id}`, now, now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_principal_permissions (principal_id, permission, created_at)
         VALUES (?, ?, ?)`
      )
      .run(id, READ, now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_principal_tenant_scopes (principal_id, scope_mode, tenant_id, created_at)
         VALUES (?, 'all', NULL, ?)`
      )
      .run(id, now);
    return kit.mint(context.db, `amk_${id}`, [READ]);
  };
  const read = (token: string, operationId: string) =>
    context.callWithToken(token, 'GET', `${PATH}/${encodeURIComponent(operationId)}`, undefined, {
      'X-Tenant-Id': TENANT,
    });
  return { ...context, principal, read };
}

describe('reading a tenant recovery by operation id', () => {
  it('refuses an exact-permission all-tenants machine for a protected tenant’s operation, serves an unprotected one', async () => {
    const t = await setup(PROTECTED);
    const token = await t.principal('automation');
    const refused = await t.read(token, 'tenant-dr:prot');
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('access_denied');
    expect(JSON.stringify(refused.json)).not.toContain('providerDatabaseId');
    const served = await t.read(token, 'tenant-dr:open');
    expect(served.status, JSON.stringify(served.json)).toBe(200);
    expect((served.json.recovery as { tenantId: string }).tenantId).toBe('tenant-open');
  });

  it('is unchanged for a platform principal and while the list is empty', async () => {
    const listed = await setup(PROTECTED);
    const tool = await listed.principal('setup_tool');
    expect((await listed.read(tool, 'tenant-dr:prot')).status).toBe(200);
    const empty = await setup('');
    const token = await empty.principal('automation');
    expect((await empty.read(token, 'tenant-dr:prot')).status).toBe(200);
  });
});
