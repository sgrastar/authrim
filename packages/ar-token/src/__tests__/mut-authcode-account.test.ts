/**
 * Authorization code grant after the code is spent: signing key and lifetime reads, the subject
 * account, consent withdrawal, PII availability and guest accounts (src/token.ts
 * handleAuthorizationCodeGrant).
 */
import {
  mocks,
  resetHarness,
  useCodeStore,
  useTenantSettings,
  postClient,
  postToken,
  codeRequest,
  expectOAuthError,
  account,
} from './helpers/mut-authcode-harness';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthCodeData } from './helpers/fixtures';
import type { MockEnv } from './helpers/mocks';

let env: MockEnv;
const client = postClient();
const GRANT_INVALID = 'The provided authorization grant is invalid, expired, or revoked';

beforeEach(() => {
  env = resetHarness();
  mocks.getClientCached.mockResolvedValue(client);
});

async function exchange(data = createAuthCodeData({ scope: 'api:read' })) {
  useCodeStore(env, data);
  return postToken(env, codeRequest(client, data));
}

describe('signing key and lifetimes', () => {
  it('answers 500 when the signing key cannot be loaded', async () => {
    // A new key version makes the cached key stale, so the KeyManager is asked again.
    await env.AUTHRIM_CONFIG.put('v1:key-version:default', `v-${Math.random()}`);
    env.KEY_MANAGER.get = vi.fn().mockReturnValue({
      getActiveKeyWithPrivateRpc: vi.fn().mockRejectedValue(new Error('DO down')),
    });
    const result = await exchange();
    expectOAuthError(result, 500, 'server_error', 'Failed to load signing key');
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('answers 500 when the access token lifetime cannot be read', async () => {
    mocks.loadTenantProfileCached
      .mockResolvedValueOnce({ tenant_id: 'default', max_token_ttl_seconds: 3600 })
      .mockRejectedValueOnce(new Error('profile unavailable'));
    const result = await exchange();
    expectOAuthError(result, 500, 'server_error', 'Failed to load token configuration');
  });

  it('issues the configured access token lifetime below the profile cap', async () => {
    useTenantSettings(env, { oauth: { 'oauth.access_token_expiry': 600 } });
    const result = await exchange();
    expect(result.response.status).toBe(200);
    expect(result.body.expires_in).toBe(600);
    expect(mocks.createAccessToken.mock.calls[0][3]).toBe(600);
  });
});

describe('the subject account', () => {
  it('refuses a grant whose account route no longer exists', async () => {
    mocks.resolveAccountDataContext.mockRejectedValue(new Error('account_data_route_not_found'));
    const result = await exchange();
    expectOAuthError(result, 400, 'invalid_grant', GRANT_INVALID);
  });

  it('answers 503 when the account route is unavailable', async () => {
    mocks.resolveAccountDataContext.mockRejectedValue(new Error('route store down'));
    const result = await exchange();
    expectOAuthError(result, 503, 'temporarily_unavailable', 'Account data is unavailable');
  });

  it('refuses a grant for an account that may no longer authenticate', async () => {
    mocks.ensureAccountAuthenticationState.mockRejectedValue(
      new Error('account_authentication_not_allowed')
    );
    const result = await exchange();
    expectOAuthError(result, 400, 'invalid_grant', GRANT_INVALID);
  });

  it('answers 503 when the account authentication state is unavailable', async () => {
    mocks.ensureAccountAuthenticationState.mockRejectedValue(new Error('db down'));
    const result = await exchange();
    expectOAuthError(result, 503, 'temporarily_unavailable', 'Authentication state is unavailable');
  });

  it('answers 503 when the subject account cannot be read', async () => {
    mocks.findAccount.mockRejectedValue(new Error('db down'));
    const result = await exchange();
    expectOAuthError(
      result,
      503,
      'temporarily_unavailable',
      'Account authorization state is unavailable'
    );
  });

  it('refuses PII scopes when the subject account cannot be read', async () => {
    mocks.findAccount.mockRejectedValue(new Error('db down'));
    const result = await exchange(createAuthCodeData({ scope: 'openid profile' }));
    expectOAuthError(
      result,
      400,
      'temporarily_unavailable',
      'Requested claims require PII that is not currently available'
    );
  });

  it('refuses PII scopes for a subject without an account', async () => {
    mocks.findAccount.mockResolvedValue(null);
    const result = await exchange(createAuthCodeData({ scope: 'openid profile' }));
    expect(result.response.status).toBe(400);
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('issues non-PII scopes for a subject without an account', async () => {
    mocks.findAccount.mockResolvedValue(null);
    const result = await exchange();
    expect(result.response.status).toBe(200);
  });
});

describe('consent withdrawal', () => {
  it('sends the client back to authorize when the withdrawal cannot be read', async () => {
    mocks.findConsentRevocation.mockRejectedValue(new Error('db down'));
    const result = await exchange();
    expectOAuthError(
      result,
      400,
      'invalid_grant',
      'The authorization grant could not be confirmed; start the authorization again'
    );
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('reads the withdrawal of this user and client', async () => {
    await exchange();
    expect(mocks.findConsentRevocation).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'default',
      userId: 'user-001',
      clientId: client.client_id,
    });
  });

  it('refuses a code granted under an earlier consent generation', async () => {
    mocks.findConsentRevocation.mockResolvedValue({ generation: 2, revokedAt: 5_000 });
    const result = await exchange({
      ...createAuthCodeData({ scope: 'api:read' }),
      consentGeneration: 1,
    } as never);
    expectOAuthError(result, 400, 'invalid_grant', GRANT_INVALID);
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('refuses a code without a generation issued before the withdrawal', async () => {
    mocks.findConsentRevocation.mockResolvedValue({ generation: 1, revokedAt: 5_000 });
    const result = await exchange(createAuthCodeData({ scope: 'api:read', createdAt: 4_000 }));
    expectOAuthError(result, 400, 'invalid_grant', GRANT_INVALID);
  });

  it('issues a code without a generation issued after the withdrawal, under the current one', async () => {
    mocks.findConsentRevocation.mockResolvedValue({ generation: 1, revokedAt: 5_000 });
    const result = await exchange(createAuthCodeData({ scope: 'api:read', createdAt: 6_000 }));
    expect(result.response.status).toBe(200);
    expect(mocks.createAccessToken.mock.calls[0][0]).toMatchObject({
      authrim_consent_generation: 1,
    });
  });
});

describe('guest accounts', () => {
  beforeEach(() => {
    mocks.findAccount.mockImplementation(async (id: string) =>
      account(id, { registration_state: 'guest' })
    );
  });

  it('refuses a guest account that may no longer sign in', async () => {
    mocks.assertGuestSessionAuthenticationAllowed.mockRejectedValue(
      new Error('account_authentication_not_allowed')
    );
    const result = await exchange();
    expectOAuthError(result, 400, 'invalid_grant', 'The account is no longer available');
  });

  it('answers 503 when the guest account state is unavailable', async () => {
    mocks.assertGuestSessionAuthenticationAllowed.mockRejectedValue(new Error('db down'));
    const result = await exchange();
    expectOAuthError(result, 503, 'temporarily_unavailable', 'Account state is unavailable');
  });

  it('answers 503 for a non-Error guest state failure', async () => {
    // Not an Error, though it carries the message of a refusal.
    mocks.assertGuestSessionAuthenticationAllowed.mockRejectedValue({
      message: 'account_authentication_not_allowed',
    });
    const result = await exchange();
    expectOAuthError(result, 503, 'temporarily_unavailable', 'Account state is unavailable');
  });

  it('refuses scopes the client does not permit guests', async () => {
    mocks.guestContract.mockReturnValue({
      guestAuth: { enabled: true, allowedScopes: ['openid'] },
    });
    const result = await exchange(createAuthCodeData({ scope: 'openid api:read' }));
    expectOAuthError(
      result,
      400,
      'invalid_scope',
      'The client does not permit the requested guest scopes'
    );
    expect(mocks.assertGuestSessionAuthenticationAllowed).toHaveBeenCalledWith(
      expect.anything(),
      'default',
      'user-001'
    );
  });

  it('issues the scopes the client permits guests', async () => {
    mocks.guestContract.mockReturnValue({
      guestAuth: { enabled: true, allowedScopes: ['openid', 'api:read'] },
    });
    const result = await exchange(createAuthCodeData({ scope: 'openid api:read' }));
    expect(result.response.status).toBe(200);
  });

  it('holds an anonymous authentication to the guest scopes too', async () => {
    mocks.findAccount.mockImplementation(async (id: string) => account(id));
    mocks.guestContract.mockReturnValue({ guestAuth: { enabled: true, allowedScopes: [] } });
    const result = await exchange(createAuthCodeData({ scope: 'api:read', amr: ['anon'] }));
    expectOAuthError(result, 400, 'invalid_scope');
  });
});
