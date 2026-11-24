/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- shared route-test harness over untyped JSON and vi mocks */
// App/request helpers; imports the router, so it must be loaded after the vi.mock registrations.
import { Hono } from 'hono';
import type { vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  adminLoggingRouter,
  destinationsRouter,
  loggingPoliciesRouter,
  notificationsRouter,
} from '../routes/admin-management/logging-control';
import { env } from './logging-control-b-harness';

export function createApp(
  permissions: string[] = [],
  roles: string[] = ['ar_tenant_admin'],
  platformRoleIsGlobal = true
) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: unknown; tenantId?: string } }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', c.req.header('x-test-tenant-id') ?? 'tenant-a');
    const global = platformRoleIsGlobal && roles.includes('ar_super_admin');
    c.set('adminAuth', {
      userId: 'admin-1',
      permissions,
      roles,
      globalRoles: global ? roles : [],
      globalPermissions: global ? permissions : [],
      tenantScope: global ? ['*'] : ['tenant-a'],
    });
    await next();
  });
  app.route('/api/admin/destinations', destinationsRouter);
  app.route('/api/admin/logging-policies', loggingPoliciesRouter);
  app.route('/api/admin/admin-logging', adminLoggingRouter);
  app.route('/api/admin/notifications', notificationsRouter);
  return app;
}

export function createPlatformApp(permissions: string[] = []) {
  return createApp(permissions, ['ar_super_admin']);
}

export const POLICIES = '/api/admin/logging-policies';
export const ADMIN_LOGGING = '/api/admin/admin-logging';
export const NOTIFICATIONS = '/api/admin/notifications';

export async function call(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  envOverride: Env = env
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await app.request(
    path,
    {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    envOverride
  );
  const text = await response.text();
  let parsed: Record<string, any> = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return { status: response.status, body: parsed };
}

export function lastCall(fn: ReturnType<typeof vi.fn>, includes: string): unknown[] {
  const found = fn.mock.calls.filter((args) => String(args[0]).includes(includes));
  if (found.length === 0) throw new Error(`no call containing ${includes}`);
  return found[found.length - 1] as unknown[];
}
