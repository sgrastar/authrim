import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  introspect: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  introspectTokenFromContext: mocks.introspect,
}));

import { fapiResourceHandler } from '../fapi-resource';

describe('fapiResourceHandler', () => {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/api/protected/fapi-resource', fapiResourceHandler);

  beforeEach(() => mocks.introspect.mockReset());

  it('returns a no-store response for a valid client credentials token', async () => {
    mocks.introspect.mockResolvedValue({
      valid: true,
      claims: { sub: 'client:client-1', client_id: 'client-1', scope: 'fapi' },
    });

    const response = await app.request('/api/protected/fapi-resource', {
      headers: { 'X-FAPI-Interaction-ID': 'interaction-1' },
    });

    expect(mocks.introspect).toHaveBeenCalledWith(expect.anything(), {
      audience: 'http://localhost/api/protected/fapi-resource',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sub: 'client:client-1',
      client_id: 'client-1',
      scope: 'fapi',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Date')).toBeTruthy();
    expect(response.headers.get('X-FAPI-Interaction-ID')).toBe('interaction-1');
  });

  it('rejects a user token at the M2M resource boundary', async () => {
    mocks.introspect.mockResolvedValue({
      valid: true,
      claims: { sub: 'user-1', client_id: 'client-1', scope: 'fapi' },
    });

    const response = await app.request('/api/protected/fapi-resource');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'insufficient_scope' });
  });

  it('preserves token validation failures', async () => {
    mocks.introspect.mockResolvedValue({
      valid: false,
      error: {
        error: 'invalid_token',
        error_description: 'DPoP proof does not match',
        statusCode: 401,
        wwwAuthenticate: 'DPoP error="invalid_token"',
      },
    });

    const response = await app.request('/api/protected/fapi-resource');
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('DPoP');
  });
});
