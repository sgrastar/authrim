/**
 * Native SSO token exchange (token.ts handleNativeSSOTokenExchange): the device secret's use,
 * the ID token replay record, the consent of the secret's issuing client and cross-client SSO.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseJsonResponse } from './helpers/mocks';
import { createConfidentialClient } from './helpers/fixtures';
import type { Harness } from './helpers/mut-nativesso-harness';
import {
  ISSUER,
  NATIVE_CLIENT_ID,
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

const SERVICE_UNAVAILABLE = {
  error: 'temporarily_unavailable',
  error_description: 'The service is temporarily unavailable. Please try again later.',
  error_details: {
    code: 'native_sso_server_error',
    retryable: true,
    severity: 'error',
    transient: true,
    user_action: 'retry',
  },
};

describe('Native SSO token exchange: device secret use, replay and cross-client SSO', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setupHarness(mocks);
  });

  afterEach(() => {
    mocks.coreDb.queryOne.mockReset().mockResolvedValue(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function exchange(overrides: Record<string, string | undefined> = {}) {
    const response = await tokenHandler(nativeSSOContext(harness, overrides));
    const body = await parseJsonResponse<NativeSSOErrorBody & Record<string, unknown>>(response);
    return { response, body };
  }

  function useDeviceSecret(overrides: Record<string, unknown>) {
    mocks.mockDeviceSecretRepository.validateAndUse.mockResolvedValue({
      ok: true,
      entity: deviceSecretEntity(overrides),
    });
  }

  describe('device secret use', () => {
    it.each([
      ['not_found', 'Device secret not found or invalid'],
      ['expired', 'Device secret has expired'],
      ['revoked', 'Device secret has been revoked'],
      ['mismatch', 'Device secret validation failed'],
      ['limit_exceeded', 'Device secret use count exceeded - please re-authenticate'],
      ['something_new', 'Invalid device secret'],
    ])('refuses a %s secret with its own description', async (reason, description) => {
      setupNativeSSO(mocks, harness);
      mocks.mockDeviceSecretRepository.validateAndUse.mockResolvedValue({ ok: false, reason });

      const { response, body } = await exchange();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: 'invalid_grant',
        error_description: description,
        error_details: { code: 'device_secret_inactive' },
      });
    });

    it('consumes one use under the configured use count limit', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockGetNativeSSOConfig.mockResolvedValue({
        ...(await mocks.mockGetNativeSSOConfig()),
        maxUseCountPerSecret: 7,
      });

      expect((await exchange()).response.status).toBe(200);
      expect(mocks.mockDeviceSecretRepository.validateAndUse).toHaveBeenCalledWith(
        'presented-device-secret',
        { maxUseCount: 7, tenantId: 'default' }
      );
    });
  });

  describe('ID token replay', () => {
    it('refuses a recorded jti before using the device secret', async () => {
      setupNativeSSO(mocks, harness, { jti: 'jti-1' });
      mocks.replayJtis.add('native-sso-id-token:jti-1');

      const { response, body } = await exchange();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: 'invalid_grant',
        error_description: 'ID token has already been used',
        error_details: { code: 'id_token_replayed' },
      });
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
      expect(mocks.replayRecordInputs).toHaveLength(0);
    });

    it('is retryable when the replay record cannot be read', async () => {
      setupNativeSSO(mocks, harness, { jti: 'jti-1' });
      vi.spyOn(mocks.replayJtis, 'has').mockImplementation(() => {
        throw new Error('replay store down');
      });

      const { response, body } = await exchange();

      expect(response.status).toBe(503);
      expect(body).toEqual(SERVICE_UNAVAILABLE);
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });

    it('is retryable when the jti cannot be recorded after the secret was used', async () => {
      setupNativeSSO(mocks, harness, { jti: 'jti-1' });
      vi.spyOn(mocks.replayJtis, 'has')
        .mockReturnValueOnce(false)
        .mockImplementation(() => {
          throw new Error('replay store down');
        });

      const { response, body } = await exchange();

      expect(response.status).toBe(503);
      expect(body).toEqual(SERVICE_UNAVAILABLE);
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('refuses an exchange whose jti the store reports as recorded by a concurrent one', async () => {
      setupNativeSSO(mocks, harness, { jti: 'jti-1' });
      vi.spyOn(mocks.replayJtis, 'has').mockReturnValueOnce(false).mockReturnValue(true);

      const { response, body } = await exchange();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: 'invalid_grant',
        error_description: 'ID token has already been used',
        error_details: { code: 'id_token_replayed' },
      });
      expect(mocks.mockDeviceSecretRepository.validateAndUse).toHaveBeenCalledTimes(1);
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it.each([
      ['for the remaining lifetime plus a minute', 3600, 3660],
      ['for at least a minute', -30, 60],
    ])('keeps the record %s', async (_name, expiresInSeconds, ttlSeconds) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
      const now = Math.floor(Date.now() / 1000);
      setupNativeSSO(mocks, harness, { jti: 'jti-1', exp: now + expiresInSeconds });

      expect((await exchange()).response.status).toBe(200);
      expect(mocks.replayRecordInputs).toEqual([
        expect.objectContaining({
          tenantId: 'default',
          shardKey: 'jti-1',
          jti: 'native-sso-id-token:jti-1',
          issuedAt: now,
          ttlSeconds,
        }),
      ]);
    });
  });

  describe('issuing client of the device secret', () => {
    it('accepts a secret issued to this client', async () => {
      setupNativeSSO(mocks, harness);
      useDeviceSecret({ client_id: NATIVE_CLIENT_ID });

      expect((await exchange()).response.status).toBe(200);
    });

    it('refuses a secret of another client whose consent was not the one read', async () => {
      setupNativeSSO(mocks, harness);
      useDeviceSecret({ client_id: 'origin-client' });

      const { response, body } = await exchange();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: 'invalid_grant',
        error_description: 'Device secret validation failed',
        error_details: { code: 'device_secret_binding_failed' },
      });
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('refuses a secret issued before the user withdrew this client consent', async () => {
      setupNativeSSO(mocks, harness);
      useDeviceSecret({ created_at: 1_000 });
      mocks.coreDb.queryOne.mockImplementation(async (sql: string) =>
        sql.includes('FROM oauth_client_consent_revocations')
          ? { generation: 1, revoked_at: 2_000 }
          : null
      );

      const { response, body } = await exchange();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: 'invalid_grant',
        error_description: 'The device secret predates the withdrawal of consent for this client',
        error_details: { code: 'device_secret_inactive' },
      });
    });
  });

  describe('cross-client SSO', () => {
    it('takes a token whose audience also names this client as the same client', async () => {
      setupNativeSSO(mocks, harness, {
        client_id: 'source-client',
        aud: ['source-client', NATIVE_CLIENT_ID],
      });

      expect((await exchange()).response.status).toBe(200);
      expect(
        mocks.mockDeviceInstallationRepository.ensureForNativeSSOTokenExchange
      ).toHaveBeenCalledWith(
        expect.objectContaining({ sourceClientId: 'source-client', sameClient: true })
      );
    });

    it('never takes the issuer for the source client', async () => {
      setupNativeSSO(mocks, harness, { aud: [ISSUER, NATIVE_CLIENT_ID] });
      useDeviceSecret({ client_id: NATIVE_CLIENT_ID });

      expect((await exchange()).response.status).toBe(200);
      expect(
        mocks.mockDeviceInstallationRepository.ensureForNativeSSOTokenExchange
      ).toHaveBeenCalledWith(
        expect.objectContaining({ sourceClientId: NATIVE_CLIENT_ID, sameClient: true })
      );
    });

    it('refuses another client outside any shared trust group', async () => {
      const client = setupNativeSSO(mocks, harness, { aud: 'source-client' });
      client.trust_group = 'tg-wallet';
      mocks.mockGetClientCached.mockImplementation(async (_c, _env, clientId: string) =>
        clientId === NATIVE_CLIENT_ID
          ? client
          : createConfidentialClient({ client_id: clientId, trust_group: 'tg-other' })
      );

      const { response, body } = await exchange();

      expect(response.status).toBe(403);
      expect(body).toMatchObject({
        error: 'access_denied',
        error_description: 'Cross-client Native SSO is not allowed',
        error_details: { code: 'trust_group_not_allowed', user_action: 'contact_support' },
      });
      expect(
        mocks.mockDeviceInstallationRepository.ensureForNativeSSOTokenExchange
      ).not.toHaveBeenCalled();
    });
  });

  describe('installation', () => {
    it('records the installation as seen now, and reports it when the secret has no last use', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
      const nowMs = Date.now();
      setupNativeSSO(mocks, harness);
      useDeviceSecret({ last_used_at: undefined });

      const { response, body } = await exchange();

      expect(response.status).toBe(200);
      expect(
        mocks.mockDeviceInstallationRepository.ensureForNativeSSOTokenExchange
      ).toHaveBeenCalledWith(expect.objectContaining({ lastSeenAt: nowMs }));
      expect(body.last_seen_at_unix).toBe(nowMs / 1000);
    });

    it('fails retryably when the installation cannot be resolved', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockDeviceInstallationRepository.ensureForNativeSSOTokenExchange.mockRejectedValue(
        new Error('D1 down')
      );

      const { response, body } = await exchange();

      expect(response.status).toBe(500);
      expect(body).toMatchObject({
        error: 'server_error',
        error_description: 'Failed to resolve Native SSO installation',
        error_details: { code: 'native_sso_server_error', retryable: true, user_action: 'retry' },
      });
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });
  });
});
