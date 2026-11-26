import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const app = new Hono<{ Bindings: Env }>();
app.get('/api/protected/fapi-resource', fapiResourceHandler);

const INSUFFICIENT = {
  error: 'insufficient_scope',
  error_description: 'A client credentials access token is required',
};

function valid(claims: Record<string, unknown>) {
  mocks.introspect.mockResolvedValue({ valid: true, claims });
}

describe('fapiResourceHandler (exact behaviour)', () => {
  beforeEach(() => mocks.introspect.mockReset());
  afterEach(() => vi.useRealTimers());

  it('audiences the token against the request URL without its query or fragment', async () => {
    valid({ sub: 'client:c1', client_id: 'c1' });
    await app.request('https://rs.example.com/api/protected/fapi-resource?a=1&b=2');
    expect(mocks.introspect).toHaveBeenCalledWith(expect.anything(), {
      audience: 'https://rs.example.com/api/protected/fapi-resource',
    });
  });

  it('sets the FAPI response headers and answers an empty scope as an empty string', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z'));
    valid({ sub: 'client:c1', client_id: 'c1' });
    const response = await app.request('/api/protected/fapi-resource');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('X-FAPI-Interaction-ID')).toBeNull();
    expect(response.headers.get('Date')).toBe('Sun, 01 Nov 2026 00:00:00 GMT');
    expect(await response.json()).toEqual({ sub: 'client:c1', client_id: 'c1', scope: '' });
  });

  it('answers a scope that is not a string as an empty string', async () => {
    valid({ sub: 'client:c1', client_id: 'c1', scope: ['a', 'b'] });
    const body = await (
      await app.request('/api/protected/fapi-resource')
    ).json<{ scope: string }>();
    expect(body.scope).toBe('');
  });

  it.each([
    ['a user subject', { sub: 'user-1', client_id: 'c1' }],
    ['a missing subject', { client_id: 'c1' }],
    ['a subject that is not a string', { sub: 5, client_id: 'c1' }],
    ['a missing client id', { sub: 'client:c1' }],
    ['an empty client id', { sub: 'client:', client_id: '' }],
    ['a client id that is not a string', { sub: 'client:1', client_id: 1 }],
    ['a subject of another client', { sub: 'client:c2', client_id: 'c1' }],
    ['a client prefix without the exact id', { sub: 'client:c1x', client_id: 'c1' }],
  ])('refuses %s with the insufficient_scope challenge', async (_label, claims) => {
    valid(claims);
    const response = await app.request('/api/protected/fapi-resource');
    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer error="insufficient_scope"');
    expect(await response.json()).toEqual(INSUFFICIENT);
  });

  it('treats a valid answer without claims as an invalid token', async () => {
    mocks.introspect.mockResolvedValue({ valid: true });
    const response = await app.request('/api/protected/fapi-resource');
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(await response.json()).toEqual({
      error: 'invalid_token',
      error_description: 'The access token is invalid',
    });
  });

  it('answers an invalid token without error details with the defaults', async () => {
    mocks.introspect.mockResolvedValue({ valid: false });
    const response = await app.request('/api/protected/fapi-resource');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'invalid_token',
      error_description: 'The access token is invalid',
    });
  });

  it('passes through the status, error and challenge of a refused token', async () => {
    mocks.introspect.mockResolvedValue({
      valid: false,
      error: {
        error: 'use_dpop_nonce',
        error_description: 'Nonce required',
        statusCode: 400,
        wwwAuthenticate: 'DPoP error="use_dpop_nonce"',
      },
    });
    const response = await app.request('/api/protected/fapi-resource');
    expect(response.status).toBe(400);
    expect(response.headers.get('WWW-Authenticate')).toBe('DPoP error="use_dpop_nonce"');
    expect(await response.json()).toEqual({
      error: 'use_dpop_nonce',
      error_description: 'Nonce required',
    });
  });

  it('defaults the missing parts of an error answer', async () => {
    mocks.introspect.mockResolvedValue({ valid: false, error: { statusCode: 403 } });
    const response = await app.request('/api/protected/fapi-resource');
    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(await response.json()).toEqual({
      error: 'invalid_token',
      error_description: 'The access token is invalid',
    });
  });
});
