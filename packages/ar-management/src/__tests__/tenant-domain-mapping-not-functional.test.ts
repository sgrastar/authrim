import { describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { app } from '../index';

/**
 * PINS TODAY'S REALITY, NOT DESIRED BEHAVIOUR. The platform tenant-domain-mapping routes
 * (`/api/admin/platform/tenant-domain-mappings*`) are not functional yet: for a legitimate global
 * super admin they answer 500. `/api/admin/platform/*` is classified `platform_admin`, so the real
 * request context creates no tenant metadata context, and the handlers' `getCoreAdapter()` reads
 * the Core adapter only from that context and throws.
 *
 * Making the feature work needs a storage decision for platform-level mappings (see the follow-up
 * note in the PR); when that lands this test is expected to change. The routes themselves stay
 * behind `requireSystemAdmin()` meanwhile (`tenant-domain-mapping-guard.test.ts`).
 *
 * Unlike the guard test this uses the REAL request context middleware (no adapter mock); only the
 * already-authenticated admin is attached after it.
 */
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requestContextMiddleware: (...args: Parameters<typeof actual.requestContextMiddleware>) => {
      const real = actual.requestContextMiddleware(...args);
      return async (c: Context<{ Bindings: Env }>, next: Next) =>
        real(c, async () => {
          (c as unknown as { set(key: string, value: unknown): void }).set('adminAuth', {
            userId: 'human-1',
            authMethod: 'bearer',
            actorType: 'human',
            tenantScope: ['*'],
            roles: ['ar_super_admin'],
            globalRoles: ['ar_super_admin'],
            permissions: ['*'],
            globalPermissions: ['*'],
          } satisfies AdminAuthContext);
          await next();
        });
    },
  };
});

const env = {
  ISSUER_URL: 'https://op.example.com',
  BASE_DOMAIN: 'op.example.com',
  CONTROL: { getReleaseMigrationRolloutStatus: async () => ({ adminMutationMode: 'read_write' }) },
  SETTINGS: { get: async () => null },
  RATE_LIMITER: {
    idFromName: (name: string) => name,
    get: () => ({
      incrementRpc: async (
        _key: string,
        config: { maxRequests: number; windowSeconds: number }
      ) => ({
        allowed: true,
        current: 1,
        limit: config.maxRequests,
        resetAt: Math.floor(Date.now() / 1000) + config.windowSeconds,
        retryAfter: 0,
      }),
    }),
  },
} as unknown as Env;

const headers = {
  'CF-Connecting-IP': '192.0.2.10',
  Authorization: 'Bearer test-token',
  'Content-Type': 'application/json',
};

describe('platform tenant domain mappings', () => {
  it('are not functional yet: a global super admin gets a 5xx, not a mapping list (follow-up: platform storage)', async () => {
    const list = await app.request('/api/admin/platform/tenant-domain-mappings', { headers }, env);
    expect(list.status).toBeGreaterThanOrEqual(500);

    const create = await app.request(
      '/api/admin/platform/tenant-domain-mappings',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ domain: 'example.com', tenant_id: 'tenant-a' }),
      },
      env
    );
    expect(create.status).toBeGreaterThanOrEqual(500);
  });
});
