/**
 * Native SSO token exchange (token.ts handleNativeSSOTokenExchange): what is issued — the scope
 * granted, the access, ID and refresh token claims, the refresh token family, the events and the
 * response headers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RELEASE_APPROVAL_CLAIM, type Env } from '@authrim/ar-lib-core';
import { parseJsonResponse } from './helpers/mocks';
import type { Harness } from './helpers/mut-nativesso-harness';
import {
  NATIVE_CLIENT_ID,
  contextHeader,
  deviceSecretEntity,
  nativeSSOContext,
  setupNativeSSO,
  type NativeSSOErrorBody,
} from './helpers/mut-nativesso-fixtures';

const mocks = await vi.hoisted(async () => {
  const { createHarnessMocks } = await import('./helpers/mut-nativesso-harness');
  return createHarnessMocks();
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const { arLibCoreMock } = await import('./helpers/mut-nativesso-harness');
  return arLibCoreMock(await importOriginal(), mocks);
});

vi.mock('jose', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  importPKCS8: vi.fn().mockResolvedValue({ type: 'private' }),
  importJWK: vi.fn().mockResolvedValue({ type: 'public' }),
}));

import { tokenHandler } from '../token';
import { setupHarness } from './helpers/mut-nativesso-harness';

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';

describe('Native SSO token exchange: issued tokens', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setupHarness(mocks);
  });

  afterEach(() => {
    mocks.coreDb.queryOne.mockReset().mockResolvedValue(null);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function exchange(overrides: Record<string, string | undefined> = {}) {
    const ctx = nativeSSOContext(harness, overrides);
    const response = await tokenHandler(ctx);
    const body = await parseJsonResponse<NativeSSOErrorBody & Record<string, unknown>>(response);
    return { ctx, response, body };
  }

  const accessTokenClaims = () =>
    mocks.mockCreateAccessToken.mock.calls[0][0] as Record<string, unknown>;
  const idTokenClaims = () => mocks.mockCreateIDToken.mock.calls[0][0] as Record<string, unknown>;

  function useRotator() {
    const createFamilyRpc = vi.fn(async (request: { jti: string; scope: string }) => ({
      version: 3,
      newJti: request.jti,
      expiresIn: 3600,
      allowedScope: request.scope,
    }));
    const revokeFamilyIfFirstJtiRpc = vi.fn(async () => true);
    harness.mockEnv.REFRESH_TOKEN_ROTATOR = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ createFamilyRpc, revokeFamilyIfFirstJtiRpc })),
    } as unknown as Harness['mockEnv']['REFRESH_TOKEN_ROTATOR'];
    return { createFamilyRpc, revokeFamilyIfFirstJtiRpc };
  }

  describe('scope', () => {
    it('grants only openid when the ID token carries no scope', async () => {
      setupNativeSSO(mocks, harness, { scope: undefined });

      const { response, body } = await exchange();

      expect(response.status).toBe(200);
      expect(body.scope).toBe('openid');
    });

    it('narrows the request to the scope of the ID token', async () => {
      setupNativeSSO(mocks, harness, { scope: 'openid' });

      const { body } = await exchange();

      expect(body.scope).toBe('openid');
      expect(accessTokenClaims().scope).toBe('openid');
    });

    it('takes the scope of the ID token for a client without a scope ceiling', async () => {
      setupNativeSSO(
        mocks,
        harness,
        { scope: 'openid profile email' },
        {
          allowed_scopes: undefined,
        }
      );

      const { response, body } = await exchange({ scope: undefined });

      expect(response.status).toBe(200);
      expect(body.scope).toBe('openid profile email');
    });

    it('narrows to the client ceiling', async () => {
      setupNativeSSO(mocks, harness, { scope: 'openid profile email' });

      const { body } = await exchange({ scope: undefined });

      expect(body.scope).toBe('openid profile');
    });

    it('refuses when the ceilings leave no openid', async () => {
      setupNativeSSO(mocks, harness, { scope: 'profile' });

      const { response, body } = await exchange({ scope: undefined });

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: 'invalid_scope',
        error_description: 'openid scope is not permitted for this Native SSO token exchange',
        error_details: { code: 'native_sso_scope_invalid' },
      });
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('claims', () => {
    it('binds the session, the installation, the DPoP key and an empty release approval', async () => {
      setupNativeSSO(mocks, harness, { auth_time: 1_700_000_000, acr: 'urn:acr:mfa' });

      expect((await exchange()).response.status).toBe(200);
      expect(accessTokenClaims()).toMatchObject({
        sub: 'user-001',
        client_id: NATIVE_CLIENT_ID,
        sid: 'sid-001',
        authrim_installation_id: 'ds-001',
        cnf: { jkt: 'native-jkt' },
        [RELEASE_APPROVAL_CLAIM]: [],
      });
      expect(idTokenClaims()).toMatchObject({
        sub: 'user-001',
        aud: NATIVE_CLIENT_ID,
        at_hash: 'at-hash-value',
        auth_time: 1_700_000_000,
        acr: 'urn:acr:mfa',
        sid: 'sid-001',
      });
    });

    it('adds no session, auth_time or acr the device secret and ID token do not have', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockDeviceSecretRepository.validateAndUse.mockResolvedValue({
        ok: true,
        entity: deviceSecretEntity({ session_id: undefined }),
      });

      expect((await exchange()).response.status).toBe(200);
      expect(Object.keys(accessTokenClaims())).not.toContain('sid');
      expect(Object.keys(idTokenClaims())).not.toContain('sid');
      expect(Object.keys(idTokenClaims())).not.toContain('auth_time');
      expect(Object.keys(idTokenClaims())).not.toContain('acr');
    });
  });

  describe('refresh token', () => {
    it('creates a DPoP-bound refresh token family carrying the authentication context', async () => {
      const { createFamilyRpc } = useRotator();
      setupNativeSSO(mocks, harness, { auth_time: 1_700_000_000, acr: 'urn:acr:mfa' });

      const { ctx, body } = await exchange();

      expect(body.refresh_token).toBe('mock-refresh-token');
      expect(createFamilyRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-001',
          clientId: NATIVE_CLIENT_ID,
          scope: 'openid profile',
          authContext: { auth_time: 1_700_000_000, acr: 'urn:acr:mfa' },
          releaseApproval: [],
        })
      );
      const familyJti = (createFamilyRpc.mock.calls[0][0] as { jti: string }).jti;
      const [claims, , , ttl, jti, rtv] = mocks.mockCreateRefreshToken.mock.calls[0] as unknown[];
      expect(claims).toMatchObject({
        aud: NATIVE_CLIENT_ID,
        client_id: NATIVE_CLIENT_ID,
        scope: 'openid profile',
        cnf: { jkt: 'native-jkt' },
      });
      expect([ttl, jti, rtv]).toEqual([86400 * 30, familyJti, 3]);
      // The family index is recorded in the account database once the response is sent.
      const waitUntil = vi.mocked(ctx.executionCtx.waitUntil);
      await Promise.all(waitUntil.mock.calls.map(([work]) => work));
      expect(mocks.coreDb.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT'),
        expect.arrayContaining([familyJti, 'user-001', NATIVE_CLIENT_ID])
      );
    });

    it('creates the family with an empty authentication context when the ID token has none', async () => {
      const { createFamilyRpc } = useRotator();
      setupNativeSSO(mocks, harness, { auth_time: 'yesterday', acr: 7 });

      await exchange();

      expect(createFamilyRpc).toHaveBeenCalledWith(expect.objectContaining({ authContext: {} }));
    });

    it('refuses when the consent was withdrawn while the family was created', async () => {
      const { createFamilyRpc, revokeFamilyIfFirstJtiRpc } = useRotator();
      setupNativeSSO(mocks, harness);
      let reads = 0;
      mocks.coreDb.queryOne.mockImplementation(async (sql: string) => {
        if (!sql.includes('FROM oauth_client_consent_revocations')) return null;
        reads += 1;
        return reads === 1 ? null : { generation: 2, revoked_at: Date.now() };
      });

      const { response, body } = await exchange();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: 'invalid_grant',
        error_description: 'Consent for this client was withdrawn during the exchange',
        error_details: { code: 'device_secret_inactive' },
      });
      const familyJti = (createFamilyRpc.mock.calls[0][0] as { jti: string }).jti;
      expect(revokeFamilyIfFirstJtiRpc).toHaveBeenCalledWith(
        'user-001',
        familyJti,
        'consent_revoked'
      );
      expect(body.access_token).toBeUndefined();
    });

    it('asks the user to sign in again when the consent cannot be confirmed', async () => {
      useRotator();
      setupNativeSSO(mocks, harness);
      let reads = 0;
      mocks.coreDb.queryOne.mockImplementation(async (sql: string) => {
        if (!sql.includes('FROM oauth_client_consent_revocations')) return null;
        reads += 1;
        if (reads > 1) throw new Error('D1 down');
        return null;
      });

      const { response, body } = await exchange();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: 'invalid_grant',
        error_description: 'Consent state could not be confirmed; sign in again',
        error_details: {
          code: 'native_sso_server_error',
          retryable: false,
          severity: 'error',
          user_action: 'reauthenticate',
        },
      });
    });

    it('issues no refresh token when the tenant profile does not allow them', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockLoadTenantProfileCached.mockResolvedValue({
        tenant_id: 'default',
        allows_token_exchange: true,
        allows_refresh_token: false,
        max_token_ttl_seconds: 3600,
      });

      const { response, body } = await exchange();

      expect(response.status).toBe(200);
      expect(body.refresh_token).toBeUndefined();
      expect(body.refresh_token_expires_in).toBeUndefined();
      expect(mocks.mockCreateRefreshToken).not.toHaveBeenCalled();
      expect(mocks.mockPublishEvent).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'token.refresh.issued' })
      );
    });

    it('fails retryably, issuing nothing, when the refresh token cannot be stored', async () => {
      setupNativeSSO(mocks, harness);
      (
        harness.mockEnv as unknown as { REFRESH_TOKEN_ROTATOR?: Env['REFRESH_TOKEN_ROTATOR'] }
      ).REFRESH_TOKEN_ROTATOR = undefined;

      const { response, body } = await exchange();

      expect(response.status).toBe(500);
      expect(body).toEqual({
        error: 'server_error',
        error_description: 'Failed to create refresh token',
        error_details: {
          code: 'native_sso_server_error',
          retryable: true,
          severity: 'error',
          transient: true,
          user_action: 'retry',
        },
      });
      expect(mocks.mockCreateRefreshToken.mock.calls[0][4]).toMatch(/^rt_/);
    });
  });

  it('publishes the issued events and answers uncached', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
    const now = Math.floor(Date.now() / 1000);
    useRotator();
    setupNativeSSO(mocks, harness);

    const { ctx, response, body } = await exchange();

    expect(response.status).toBe(200);
    expect(contextHeader(ctx, 'Cache-Control')).toBe('no-store');
    expect(contextHeader(ctx, 'Pragma')).toBe('no-cache');
    const events = mocks.mockPublishEvent.mock.calls.map(([, event]) => event as unknown);
    expect(events).toEqual([
      {
        type: 'token.access.issued',
        tenantId: 'default',
        data: {
          jti: 'at-jti-001',
          clientId: NATIVE_CLIENT_ID,
          userId: 'user-001',
          scopes: ['openid', 'profile'],
          expiresAt: now + (body.expires_in as number),
          grantType: TOKEN_EXCHANGE,
        },
      },
      {
        type: 'token.id.issued',
        tenantId: 'default',
        data: { clientId: NATIVE_CLIENT_ID, userId: 'user-001', grantType: TOKEN_EXCHANGE },
      },
      {
        type: 'token.refresh.issued',
        tenantId: 'default',
        data: {
          jti: expect.any(String) as unknown,
          clientId: NATIVE_CLIENT_ID,
          userId: 'user-001',
          scopes: ['openid', 'profile'],
          grantType: TOKEN_EXCHANGE,
        },
      },
    ]);
  });
});
