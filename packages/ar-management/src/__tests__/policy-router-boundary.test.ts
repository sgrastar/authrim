import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import policyRouter from '../routes/policy';

function appWithUnprivilegedActor() {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth: AdminAuthContext } }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'agent-actor',
      authMethod: 'bearer',
      actorType: 'agent',
      roles: [],
      permissions: ['admin:clients:read'],
      tenantId: 'default',
      tenantScope: ['default'],
      mfaVerified: false,
    } as AdminAuthContext);
    return next();
  });
  app.route('/api/admin', policyRouter as never);
  app.get('/api/admin/agent-read/clients', (c) => c.json({ reached: true }));
  return app;
}

describe('Policy router middleware boundary', () => {
  it('does not apply Policy RBAC to an unrelated route mounted after the router', async () => {
    const response = await appWithUnprivilegedActor().request('/api/admin/agent-read/clients');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reached: true });
  });

  it('continues to protect a route owned by the Policy API', async () => {
    const response = await appWithUnprivilegedActor().request('/api/admin/tenant-policy');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'access_denied',
      required_roles: ['system_admin', 'org_admin', 'admin'],
    });
  });
});
