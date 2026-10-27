import { describe, expect, it, vi } from 'vitest';
vi.mock('../index', () => ({ default: { fetch: vi.fn() } }));
import { isAwsPasskeyIdpAuthRoute, fetchAwsPasskeyIdpAuth } from '../aws-passkey-idp';
import app from '../index';
import type { Env } from '@authrim/ar-lib-core';

describe('AWS passkey browser preflight surface', () => {
  it.each([
    '/api/v1/auth/direct/passkey/login/start',
    '/api/v1/login/interactions/start',
    '/api/v1/login/interactions/opaque-id/submit',
    '/api/sessions/status',
  ])('delegates OPTIONS %s to the existing auth CORS policy', async (path) => {
    const request = new Request(`https://idp.example.test${path}`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://login.example.test', 'Access-Control-Request-Method': 'POST' },
    });
    const env = {} as Env;
    const execution = {} as ExecutionContext;
    expect(isAwsPasskeyIdpAuthRoute('OPTIONS', path)).toBe(true);
    await fetchAwsPasskeyIdpAuth(request, env, execution);
    expect(app.fetch).toHaveBeenCalledWith(request, env, execution);
  });
  it.each([
    '/api/admin/users',
    '/oauth/token',
    '/api/v1/auth/direct/passkey/register/start',
    '/api/v1/login/interactions/a/submit/extra',
  ])('keeps unexposed OPTIONS %s unavailable', (path) => {
    expect(isAwsPasskeyIdpAuthRoute('OPTIONS', path)).toBe(false);
  });
});
