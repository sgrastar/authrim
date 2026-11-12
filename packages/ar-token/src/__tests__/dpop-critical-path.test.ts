/**
 * DPoP in `critical_only` mode is required on the token endpoints. The path it is judged on is the
 * one the router dispatched on, so an escaped spelling (`/%74oken`) cannot look uncritical.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getProtocolSettingsCached: vi.fn(async () => ({ fapi: { enabled: false } })),
    resolveAppSecurityRequirements: vi.fn(async () => ({ dpopBoundAccessTokens: false })),
  };
});

import { isDPoPRequiredForTokenRequest } from '../token';

async function required(path: string, dpopMode: string): Promise<boolean> {
  const app = new Hono<{ Bindings: Env }>();
  let result = false;
  app.all('*', async (c) => {
    result = await isDPoPRequiredForTokenRequest(c, {
      client_id: 'client-1',
      tenant_id: 'default',
      dpop_mode: dpopMode,
      dpop_bound_access_tokens: false,
    } as never);
    return c.text('ok');
  });
  await app.request(path, { method: 'POST' }, {});
  return result;
}

describe('DPoP critical_only', () => {
  it.each(['/token', '/%74oken', '/to%6ben', '/oauth/%74oken', '/%6fauth/token'])(
    'requires DPoP on %s',
    async (path) => {
      expect(await required(path, 'critical_only')).toBe(true);
    }
  );

  it('does not require it on a path that is not critical, whatever the spelling', async () => {
    expect(await required('/userinfo', 'critical_only')).toBe(false);
    expect(await required('/%75serinfo', 'critical_only')).toBe(false);
  });

  it.each(['/userinfo%', '/%zz', '/to%6%6ben', '/%e0%a4%a'])(
    'judges a malformed escape (%s) as the token endpoint, the strictest case',
    async (path) => {
      expect(await required(path, 'critical_only')).toBe(true);
    }
  );

  it('keeps the other modes', async () => {
    expect(await required('/%74oken', 'disabled')).toBe(false);
    expect(await required('/anything', 'all')).toBe(true);
  });
});
