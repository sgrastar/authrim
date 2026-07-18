import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware:
      (options?: { requirePermissions?: string[] }) =>
      async (c: any, next: () => Promise<void>) => {
        const permissions = (c.req.header('x-test-permissions') ?? '')
          .split(',')
          .map((permission: string) => permission.trim())
          .filter(Boolean);
        c.set('adminAuth', {
          userId: 'machine-test',
          authMethod: 'machine_access_token',
          roles: [],
          permissions,
          tenantId: 'default',
          tenantScope: ['default'],
          mfaVerified: false,
        });
        if (
          options?.requirePermissions?.some(
            (required) => !actual.hasAdminPermission(permissions, required)
          )
        ) {
          return c.json({ error: 'insufficient_permissions' }, 403);
        }
        await next();
      },
  };
});

import { adminManagementRouter } from '../routes/admin-management';

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin', adminManagementRouter);
  app.post('/api/admin/signing-keys/rotate', (c) => c.json({ reached: true }));
  return app;
}

describe('Admin management router middleware boundary', () => {
  it('does not apply root-mounted ABAC, ReBAC, or policy auth to later sibling routes', async () => {
    const response = await createApp().request(
      '/api/admin/signing-keys/rotate',
      {
        method: 'POST',
        headers: { 'x-test-permissions': 'admin:security:write' },
      },
      { DB_ADMIN: {} } as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reached: true });
  });
});
