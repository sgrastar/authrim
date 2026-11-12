import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  adminWritePrincipalKey,
  clearRateLimitConfigCache,
  clearRateLimitFastPathCache,
} from '@authrim/ar-lib-core';
import app from '../index';
import { createRateLimiterStub } from './rate-limiter-stub';

/**
 * The ReBAC write routes sit behind admin authentication (`adminAuthMiddleware` with
 * policy:rebac:write), so they count on the Admin API write limit of the authenticated principal,
 * in the tenant-less scope. Only the request context is replaced: it supplies the authenticated
 * administrator for requests that say so.
 */
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requestContextMiddleware:
      () =>
      async (c: Context<{ Bindings: Env }>, next: Next): Promise<void> => {
        const ctx = c as unknown as { set(key: string, value: unknown): void };
        ctx.set('requestId', 'rebac-limit');
        ctx.set('tenantId', 'default');
        ctx.set('logger', actual.createLogger({ requestId: 'rebac-limit', tenantId: 'default' }));
        ctx.set('startTime', Date.now());
        if (c.req.header('X-Test-Admin')) {
          ctx.set('adminAuth', {
            userId: c.req.header('X-Test-Admin'),
            authMethod: 'machine_access_token',
            actorType: 'machine',
            actorId: c.req.header('X-Test-Admin'),
            tenantId: 'default',
            tenantScope: ['*'],
            roles: [],
            permissions: [actual.ADMIN_PERMISSIONS.POLICY_REBAC_WRITE],
            hierarchyLevel: 0,
            mfaVerified: false,
          });
        }
        await next();
      },
  };
});

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

beforeEach(() => {
  clearRateLimitConfigCache();
  clearRateLimitFastPathCache();
});

async function adminKey(userId: string) {
  return `rate-limit:adminWrite:${await adminWritePrincipalKey({
    userId,
    actorType: 'machine',
    actorId: userId,
  })}`;
}

const routes: Array<[string, string]> = [
  ['POST', '/api/rebac/write'],
  ['DELETE', '/api/rebac/tuples'],
  ['POST', '/api/rebac/invalidate'],
];

describe('ReBAC admin writes on the Admin API write limit', () => {
  it.each(routes)('counts %s %s under the principal, tenant-less', async (method, path) => {
    const limiter = createRateLimiterStub();
    const env = { RATE_LIMITER: limiter } as unknown as Env;

    await app.request(
      path,
      {
        method,
        headers: {
          'X-Test-Admin': 'alice',
          'Content-Type': 'application/json',
          Authorization: 'Bearer x',
        },
        body: '{}',
      },
      env,
      executionCtx
    );

    expect([...limiter.records.keys()]).toEqual([await adminKey('alice')]);
  });

  it('does not count a request without an administrator (secret-authenticated service calls)', async () => {
    const limiter = createRateLimiterStub();
    const env = { RATE_LIMITER: limiter } as unknown as Env;

    await app.request(
      '/api/rebac/write',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env,
      executionCtx
    );

    expect([...limiter.records.keys()]).toEqual([]);
  });
});
