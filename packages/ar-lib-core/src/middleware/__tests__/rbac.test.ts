import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requireAnyRole, requireRole } from '../rbac';
import type { AdminAuthContext } from '../../types/admin';

function createMachineAuth(permissions: string[]): AdminAuthContext {
  return {
    userId: 'machine-validation',
    actorType: 'machine',
    actorId: 'machine-validation',
    principalType: 'ci',
    authMethod: 'machine_access_token',
    roles: [],
    permissions,
    hierarchyLevel: 0,
    mfaVerified: false,
  };
}

describe('RBAC middleware', () => {
  it('allows explicit admin machine access through role gates', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('adminAuth', createMachineAuth(['admin:*']));
      await next();
    });
    app.get('/protected', requireAnyRole(['system_admin', 'org_admin', 'admin']), (c) =>
      c.json({ ok: true })
    );

    const res = await app.request('/protected');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('does not allow narrower machine access to bypass role gates', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('adminAuth', createMachineAuth(['admin:clients:read']));
      await next();
    });
    app.get('/protected', requireRole('system_admin'), (c) => c.json({ ok: true }));

    const res = await app.request('/protected');
    const body = await res.json<{ error: string }>();

    expect(res.status).toBe(403);
    expect(body.error).toBe('access_denied');
  });
});
