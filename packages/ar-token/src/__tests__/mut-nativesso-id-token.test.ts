/**
 * Native SSO token exchange (token.ts handleNativeSSOTokenExchange): the device secret route, the
 * consent reads, and the subject ID token checks, each with the exact error it answers and
 * without consuming a use of the device secret.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseJsonResponse } from './helpers/mocks';
import type { Harness } from './helpers/mut-nativesso-harness';
import {
  ISSUER,
  NATIVE_CLIENT_ID,
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

describe('Native SSO token exchange: device secret route, consent reads and the ID token', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setupHarness(mocks);
  });

  afterEach(() => {
    const core = mocks.coreDb;
    core.query.mockReset().mockResolvedValue([]);
    core.queryOne.mockReset().mockResolvedValue(null);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function exchange(overrides: Record<string, string | undefined> = {}) {
    const response = await tokenHandler(nativeSSOContext(harness, overrides));
    const body = await parseJsonResponse<NativeSSOErrorBody>(response);
    return { response, body };
  }

  function expectInvalidGrant(
    result: { response: Response; body: NativeSSOErrorBody },
    description: string,
    code: string
  ) {
    expect(result.response.status).toBe(400);
    expect(result.body).toMatchObject({
      error: 'invalid_grant',
      error_description: description,
      error_details: { code, user_action: 'reauthenticate', retryable: false },
    });
    expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    expect(mocks.mockLoggerMethods.warn).toHaveBeenCalledWith(
      'NativeSSO Token Exchange Failure',
      expect.objectContaining({
        outcome: 'invalid_grant',
        clientId: NATIVE_CLIENT_ID,
        errorDetailsCode: code,
        status: 400,
      })
    );
  }

  describe('device secret route', () => {
    it('refuses a device secret without a route', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockResolveDeviceSecretRouteHint.mockResolvedValue(null);

      expectInvalidGrant(
        await exchange(),
        'Device secret not found or invalid',
        'device_secret_inactive'
      );
      expect(mocks.mockResolveAccountDataContextFromHono).not.toHaveBeenCalled();
    });

    it('refuses a device secret whose account route no longer exists', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockResolveAccountDataContextFromHono.mockRejectedValue(
        new Error('account_data_route_not_found')
      );

      expectInvalidGrant(
        await exchange(),
        'Device secret not found or invalid',
        'device_secret_inactive'
      );
    });

    it('is retryable when the account data cannot be reached', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockResolveAccountDataContextFromHono.mockRejectedValue(new Error('D1 unavailable'));

      const { response, body } = await exchange();

      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        error: 'temporarily_unavailable',
        error_description: 'Native SSO account data is unavailable',
        error_details: {
          code: 'native_sso_server_error',
          retryable: true,
          severity: 'warning',
          user_action: 'retry',
        },
      });
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });

    it('takes a route to an account id without the account: prefix as that id, then refuses it', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockResolveDeviceSecretRouteHint.mockResolvedValue({
        tenantId: 'default',
        accountId: 'user-001',
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_702_592_000_000,
      });

      // The owner is the hint's id itself, so the ID token subject matches it; the validated
      // secret's own account then does not match the route.
      expectInvalidGrant(
        await exchange(),
        'Device secret validation failed',
        'device_secret_binding_failed'
      );
      expect(mocks.mockDeviceSecretRepository.validateAndUse).toHaveBeenCalledTimes(1);
    });
  });

  describe('consent reads', () => {
    it('is retryable when the consent withdrawal cannot be read', async () => {
      setupNativeSSO(mocks, harness);
      mocks.coreDb.queryOne.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM oauth_client_consent_revocations')) throw new Error('D1 down');
        return null;
      });

      const { response, body } = await exchange();

      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        error: 'temporarily_unavailable',
        error_description: 'Consent state is unavailable',
        error_details: { code: 'native_sso_server_error', retryable: true, severity: 'warning' },
      });
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });

    it('is retryable when the information release consent cannot be read', async () => {
      setupNativeSSO(mocks, harness, {}, {
        information_release_consent: { enabled: true, ask: 'once' },
      } as Record<string, unknown>);
      mocks.coreDb.queryOne.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM oauth_client_consents')) throw new Error('D1 down');
        return null;
      });

      const { response, body } = await exchange();

      expect(response.status).toBe(503);
      expect(body).toEqual({
        error: 'temporarily_unavailable',
        error_description: 'Consent state is unavailable',
        error_details: {
          code: 'native_sso_server_error',
          retryable: true,
          severity: 'warning',
          transient: true,
          user_action: 'retry',
        },
      });
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });
  });

  describe('subject ID token', () => {
    it('refuses a token that cannot be parsed', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockParseToken.mockImplementation(() => {
        throw new Error('bad token');
      });

      expectInvalidGrant(await exchange(), 'Invalid ID token format', 'id_token_malformed');
    });

    it('refuses a token header without kid, before any key lookup', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockParseTokenHeader.mockReturnValue({ alg: 'RS256' });

      expectInvalidGrant(
        await exchange(),
        'ID token is missing kid in header',
        'id_token_signature_invalid'
      );
      expect(mocks.mockVerifyToken).not.toHaveBeenCalled();
    });

    it.each([
      ['another issuer', 'https://other.example.com'],
      ['a non-string issuer', 42],
    ])('refuses %s', async (_name, iss) => {
      setupNativeSSO(mocks, harness, { iss });

      expectInvalidGrant(await exchange(), 'ID token issuer is invalid', 'id_token_issuer_invalid');
    });

    it.each([
      ['an empty audience', { aud: [] }],
      ['a client_id claim outside the audience', { client_id: 'someone-else' }],
      ['an audience of the issuer alone', { aud: [ISSUER] }],
    ])('refuses %s', async (_name, payload) => {
      setupNativeSSO(mocks, harness, payload);

      expectInvalidGrant(
        await exchange(),
        'ID token audience is invalid',
        'id_token_audience_invalid'
      );
    });

    it('accepts an audience naming the issuer and the client', async () => {
      setupNativeSSO(mocks, harness, { aud: [ISSUER, NATIVE_CLIENT_ID] });

      const { response } = await exchange();

      expect(response.status).toBe(200);
    });

    it('verifies the signature itself with the key algorithm only, checking the audience apart', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockVerifyToken.mockRejectedValue(new Error('signature mismatch'));

      expectInvalidGrant(
        await exchange(),
        'ID token verification failed',
        'id_token_signature_invalid'
      );
      expect(mocks.mockVerifyToken).toHaveBeenCalledWith(
        'subject-id-token',
        expect.anything(),
        ISSUER,
        { skipAudienceCheck: true, algorithms: [expect.any(String)] }
      );
    });

    it('accepts a token that has not yet expired, and refuses one past the clock skew', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
      const now = Math.floor(Date.now() / 1000);

      // The signature check (jose) already refuses exp <= now, so a token inside the handler's
      // 60 s skew window is never accepted in practice; only a still-valid one is accepted here.
      setupNativeSSO(mocks, harness, { exp: now + 1 });
      expect((await exchange()).response.status).toBe(200);
      mocks.mockCreateAccessToken.mockClear();

      setupNativeSSO(mocks, harness, { exp: now - 61 });
      expectInvalidGrant(await exchange(), 'ID token has expired', 'id_token_expired');
    });

    it('refuses a token whose ds_hash does not bind the presented device secret', async () => {
      setupNativeSSO(mocks, harness, { ds_hash: 'another-hash' });

      expectInvalidGrant(
        await exchange(),
        'ID token device secret binding validation failed',
        'device_secret_binding_failed'
      );
    });

    it('is retryable when the sealed account reference cannot be opened yet', async () => {
      setupNativeSSO(mocks, harness, {
        sub: 'alice',
        authrim_subject_account: undefined,
        authrim_subject_ref: 'sealed-reference',
      });
      (harness.mockEnv as unknown as Record<string, unknown>).OBJECT_ENCRYPTION_ROOT_KEY =
        undefined;

      const { response, body } = await exchange();

      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        error: 'temporarily_unavailable',
        error_description: 'Account data is unavailable',
        error_details: { code: 'native_sso_server_error', retryable: true, severity: 'warning' },
      });
    });

    it('refuses a sub that names no account', async () => {
      setupNativeSSO(mocks, harness, { sub: 'a', authrim_subject_account: undefined });

      expectInvalidGrant(
        await exchange(),
        'ID token subject does not name an account',
        'device_secret_binding_failed'
      );
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
    ])('refuses a sub that is %s as malformed', async (_name, sub) => {
      setupNativeSSO(mocks, harness, { sub });

      expectInvalidGrant(await exchange(), 'ID token subject is missing', 'id_token_malformed');
    });

    it('refuses a subject other than the device secret owner, without using the secret', async () => {
      setupNativeSSO(mocks, harness, { sub: 'user-002' });

      expectInvalidGrant(
        await exchange(),
        'ID token subject does not match device secret owner',
        'device_secret_binding_failed'
      );
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });
  });
});
