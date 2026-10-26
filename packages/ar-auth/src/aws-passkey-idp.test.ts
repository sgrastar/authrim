import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const { appFetch } = vi.hoisted(() => ({ appFetch: vi.fn() }));
vi.mock('./index', () => ({ default: { fetch: appFetch } }));

import { fetchAwsPasskeyIdpAuth, isAwsPasskeyIdpAuthRoute } from './aws-passkey-idp';

describe('AWS passkey IdP ar-auth entrypoint', () => {
  beforeEach(() => {
    appFetch.mockReset();
  });

  it('exposes only the existing routes needed for SAML passkey login', () => {
    expect(isAwsPasskeyIdpAuthRoute('POST', '/api/v1/auth/direct/passkey/login/start')).toBe(true);
    expect(isAwsPasskeyIdpAuthRoute('POST', '/api/v1/login/interactions/flow-1/submit')).toBe(true);
    expect(isAwsPasskeyIdpAuthRoute('POST', '/api/v1/auth/direct/passkey/signup/start')).toBe(
      false
    );
    expect(isAwsPasskeyIdpAuthRoute('POST', '/api/v1/auth/direct/token')).toBe(false);
    expect(isAwsPasskeyIdpAuthRoute('GET', '/api/v1/login/interactions/flow-1/submit')).toBe(false);
  });

  it('delegates allowed requests to the production app with the same bindings and context', async () => {
    const request = new Request(
      'https://auth.example.test/api/v1/auth/direct/passkey/login/start',
      {
        method: 'POST',
      }
    );
    const env = {} as Env;
    const context = {} as ExecutionContext;
    const appResponse = new Response('handled');
    appFetch.mockResolvedValueOnce(appResponse);

    const response = await fetchAwsPasskeyIdpAuth(request, env, context);

    expect(response).toBe(appResponse);
    expect(appFetch).toHaveBeenCalledExactlyOnceWith(request, env, context);
  });

  it('rejects other routes before they reach the production app', async () => {
    const request = new Request('https://auth.example.test/api/v1/auth/direct/token', {
      method: 'POST',
    });
    const response = await fetchAwsPasskeyIdpAuth(request, {} as Env, {} as ExecutionContext);

    expect(response.status).toBe(404);
    expect(appFetch).not.toHaveBeenCalled();
  });
});
