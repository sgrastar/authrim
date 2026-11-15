import { describe, expect, it, vi } from 'vitest';

vi.mock('../admin-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-shared')>();
  return { ...actual, writeAdminAuditLog: vi.fn(async () => 'audit') };
});

import {
  adminAuthMiddleware,
  hasGlobalMachinePermission,
  type AdminAuthContext,
} from '@authrim/ar-lib-core';
import { loggingPoliciesRouter } from '../routes/admin-management/logging-control';
import { TENANT, createTokenKit, setupApp } from './helpers/admin-authority-fixture';

/**
 * A handler addressed by a stored record's ID (resolving a logging notification) decides on the
 * record's tenant. A wildcard used to make a non-platform all-tenants machine a "platform
 * authority" there, so it could resolve a protected tenant's notification while naming an
 * unprotected tenant in the request. Real: the Admin API authentication, the router, the handler,
 * the Admin schema. Only the audit write is replaced.
 */

const PROTECTED = 'tenant-prot';
const OVERVIEW = 'admin:logging:overview:read';

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
      app.route('/api/admin/logging-policies', loggingPoliciesRouter);
      // What the central authority check says about the caller.
      app.get('/api/admin/probe-authority', (c) =>
        c.json({
          controlPlane: hasGlobalMachinePermission(
            (c as unknown as { get(k: string): AdminAuthContext }).get('adminAuth'),
            'admin:control_plane:read'
          ),
        })
      );
    },
    { ...kit.env, MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: exclude }
  );
  let sequence = 0;
  const now = Date.now();
  const principal = (type: string, permissions: string[], requested = permissions) => {
    sequence += 1;
    const id = `amp_l${sequence}`;
    context.db
      .prepare(
        `INSERT INTO admin_machine_principals (id, client_id, display_name, principal_type, status,
           default_audience, token_ttl_seconds, created_at, updated_at)
         VALUES (?, ?, 'L', ?, 'active', 'authrim:admin-api', 600, ?, ?)`
      )
      .run(id, `client-${id}`, type, now, now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_credentials (id, principal_id, kid, public_jwk_json, alg, display_name,
           status, created_at, updated_at) VALUES (?, ?, ?, '{"kty":"EC"}', 'ES256', 'K', 'active', ?, ?)`
      )
      .run(`amk_${id}`, id, `kid-${id}`, now, now);
    for (const permission of permissions) {
      context.db
        .prepare(
          `INSERT INTO admin_machine_principal_permissions (principal_id, permission, created_at)
           VALUES (?, ?, ?)`
        )
        .run(id, permission, now);
    }
    context.db
      .prepare(
        `INSERT INTO admin_machine_principal_tenant_scopes (principal_id, scope_mode, tenant_id, created_at)
         VALUES (?, 'all', NULL, ?)`
      )
      .run(id, now);
    return kit.mint(context.db, `amk_${id}`, requested);
  };
  const notification = (id: string, tenantId: string) =>
    context.db
      .prepare(
        `INSERT INTO internal_notification_events
           (id, tenant_id, category, event_type, severity, status, payload_json, created_at, updated_at)
         VALUES (?, ?, 'logging_delivery_failure', 'delivery_failed', 'low', 'pending', '{}', ?, ?)`
      )
      .run(id, tenantId, new Date().toISOString(), new Date().toISOString());
  const status = (id: string) =>
    (
      context.db
        .prepare('SELECT status FROM internal_notification_events WHERE id = ?')
        .get(id) as {
        status: string;
      }
    ).status;
  const resolve = (token: string, id: string, tenantHeader = TENANT) =>
    context.callWithToken(
      token,
      'POST',
      `/api/admin/logging-policies/notifications/${id}/resolve`,
      {},
      {
        'X-Tenant-Id': tenantHeader,
      }
    );
  return { ...context, principal, notification, status, resolve };
}

describe('resolving a logging notification by its ID', () => {
  it('refuses a wildcard machine on a protected tenant’s record, and serves its own request tenant’s', async () => {
    const t = await setup(PROTECTED);
    const token = await t.principal('automation', ['*']);
    t.notification('n-prot', PROTECTED);
    t.notification('n-own', TENANT);
    const refused = await t.resolve(token, 'n-prot');
    expect(refused.status).toBe(403);
    expect(t.status('n-prot')).toBe('pending');
    const served = await t.resolve(token, 'n-own');
    expect(served.status, JSON.stringify(served.json)).toBe(200);
    expect(t.status('n-own')).toBe('suppressed');
  });

  it('refuses the same for a machine holding an exact permission, and serves its own tenant', async () => {
    const t = await setup(PROTECTED);
    const token = await t.principal('automation', [OVERVIEW]);
    t.notification('n-prot', PROTECTED);
    t.notification('n-own', TENANT);
    expect((await t.resolve(token, 'n-prot')).status).toBe(403);
    expect((await t.resolve(token, 'n-own')).status).toBe(200);
  });

  it('is unchanged while the list is empty, for the setup principal, and for a token that names the tenant', async () => {
    const empty = await setup('');
    const token = await empty.principal('automation', ['*']);
    empty.notification('n-prot', PROTECTED);
    expect((await empty.resolve(token, 'n-prot')).status).toBe(200);

    const listed = await setup(PROTECTED);
    const tool = await listed.principal('setup_tool', ['*']);
    listed.notification('n-prot', PROTECTED);
    expect((await listed.resolve(tool, 'n-prot')).status).toBe(200);
  });
});

describe('a token whose scope carries an exact name that a stored wildcard covers', () => {
  const probe = async (t: Awaited<ReturnType<typeof setup>>, token: string) =>
    (
      await t.callWithToken(token, 'GET', '/api/admin/probe-authority', undefined, {
        'X-Tenant-Id': TENANT,
      })
    ).json as { controlPlane: boolean };

  it('is no cross-tenant authority: only an exact name in the stored grant is', async () => {
    const t = await setup(PROTECTED);
    // Stored: a wildcard. Requested: the exact name (the token endpoint expands the wildcard to it).
    const wildcard = await t.principal('automation', ['*'], ['admin:control_plane:read']);
    expect((await probe(t, wildcard)).controlPlane).toBe(false);
    // Stored: the exact name.
    const exact = await t.principal('automation', ['admin:control_plane:read']);
    expect((await probe(t, exact)).controlPlane).toBe(true);
    // Platform principal, and an empty list: unchanged.
    const tool = await t.principal('setup_tool', ['*'], ['admin:control_plane:read']);
    expect((await probe(t, tool)).controlPlane).toBe(true);
    const empty = await setup('');
    const open = await empty.principal('automation', ['*'], ['admin:control_plane:read']);
    expect((await probe(empty, open)).controlPlane).toBe(true);
  });
});
