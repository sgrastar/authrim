/**
 * Native SSO token exchange (token.ts handleNativeSSOTokenExchange): the checks made before the
 * device secret is used — feature and client switches, scope, DPoP, FAL, rate limiting, the
 * device secret route and the consent reads — with the exact error each one answers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseJsonResponse } from './helpers/mocks';
import type { Harness } from './helpers/mut-nativesso-harness';
import {
  contextHeader,
  nativeSSOContext,
  setupNativeSSO,
  useAssuranceSettings,
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

describe('Native SSO token exchange: checks before the device secret is used', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setupHarness(mocks);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function exchange(
    overrides: Record<string, string | undefined> = {},
    headers: Record<string, string> = {}
  ) {
    const ctx = nativeSSOContext(harness, overrides, headers);
    const response = await tokenHandler(ctx);
    const body = await parseJsonResponse<NativeSSOErrorBody>(response);
    return { ctx, response, body };
  }

  it('refuses when Native SSO is disabled, uncached, and audits the denial', async () => {
    setupNativeSSO(mocks, harness);
    mocks.mockIsNativeSSOEnabled.mockResolvedValue(false);

    const { ctx, response, body } = await exchange();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: 'unsupported_grant_type',
      error_description: 'Native SSO is not enabled',
      error_details: { code: 'native_sso_disabled', user_action: 'contact_support' },
    });
    expect(contextHeader(ctx, 'Cache-Control')).toBe('no-store');
    expect(contextHeader(ctx, 'Pragma')).toBe('no-cache');
    expect(contextHeader(ctx, 'Retry-After')).toBeUndefined();
    expect(mocks.mockLoggerMethods.warn).toHaveBeenCalledWith(
      'NativeSSO Token Exchange Failure',
      expect.objectContaining({ outcome: 'denied', error: 'unsupported_grant_type', status: 400 })
    );
  });

  it('refuses a client that is not configured for Native SSO', async () => {
    setupNativeSSO(mocks, harness, {}, { native_sso_enabled: false });

    const { response, body } = await exchange();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      error: 'unauthorized_client',
      error_description: 'Client is not configured for Native SSO',
      error_details: { code: 'native_sso_client_disabled', user_action: 'contact_support' },
    });
  });

  it('refuses an explicit scope request without openid before reading the DPoP proof', async () => {
    setupNativeSSO(mocks, harness);

    const { response, body } = await exchange({ scope: 'profile' });

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: 'invalid_scope',
      error_description: 'Native SSO scope must include openid',
      error_details: { code: 'native_sso_scope_invalid', user_action: 'contact_support' },
    });
    expect(mocks.mockValidateDPoPProof).not.toHaveBeenCalled();
  });

  describe('DPoP', () => {
    it('answers use_dpop_nonce with a fresh nonce when the proof lacks the server nonce', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockValidateDPoPProof.mockResolvedValue({
        valid: false,
        error: 'use_dpop_nonce',
        error_description: 'DPoP nonce is required',
      });

      const { response, body } = await exchange();

      expect(response.status).toBe(400);
      expect(body.error).toBe('use_dpop_nonce');
      expect(body.error_description).toBe('DPoP nonce is required');
      expect(response.headers.get('DPoP-Nonce')).toBeTruthy();
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });

    it('applies the nonce policy of the requested resource', async () => {
      setupNativeSSO(mocks, harness);
      harness.setSystemSettings({
        oidc: { tokenExchange: { enabled: true, allowedSubjectTokenTypes: ['id_token'] } },
        security: { dpop_nonce_resource_overrides: { 'https://api.example.com': false } },
      });
      mocks.mockValidateDPoPProof.mockResolvedValue({ valid: false, error: 'use_dpop_nonce' });

      const { response, body } = await exchange({ resource: 'https://api.example.com' });

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_dpop_proof');
      expect(body.error_description).toBe('DPoP validation failed');
      expect(response.headers.get('DPoP-Nonce')).toBeNull();
    });

    it('describes an invalid proof by the validator, or generically', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockValidateDPoPProof.mockResolvedValue({ valid: false });

      const { response, body } = await exchange();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: 'invalid_request',
        error_description: 'DPoP validation failed',
        error_details: { code: 'dpop_proof_invalid' },
      });
    });

    it('refuses a valid proof that carries no key thumbprint', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockValidateDPoPProof.mockResolvedValue({ valid: true });

      const { response, body } = await exchange();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: 'invalid_request',
        error_description: 'DPoP proof is missing key thumbprint',
        error_details: { code: 'dpop_proof_invalid', user_action: 'reauthenticate' },
      });
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });
  });

  describe('federation assurance level', () => {
    it('counts the DPoP proof toward FAL2', async () => {
      setupNativeSSO(mocks, harness);
      useAssuranceSettings(mocks, {
        'assurance.enabled': true,
        'assurance.default_fal': 'FAL2',
        'assurance.fal2_requires_dpop': true,
      });

      const { response } = await exchange();

      expect(response.status).toBe(200);
    });

    it('refuses at FAL3, which needs a signed pushed request Native SSO never has', async () => {
      setupNativeSSO(mocks, harness);
      useAssuranceSettings(mocks, {
        'assurance.enabled': true,
        'assurance.default_fal': 'FAL3',
        'assurance.fal3_requires_par': true,
      });

      const { response, body } = await exchange();

      expect(response.status).toBe(400);
      expect(body.error).toBe('unauthorized_client');
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    const key = (ip: string) => `native-sso:default:native-client-001:${ip}`;

    it('counts attempts per CF-Connecting-IP, then X-Forwarded-For', async () => {
      setupNativeSSO(mocks, harness);

      await exchange({}, { 'CF-Connecting-IP': '203.0.113.1', 'X-Forwarded-For': '198.51.100.9' });
      await exchange({}, { 'X-Forwarded-For': '198.51.100.9' });

      expect(mocks.rateLimitRecords.get(key('203.0.113.1'))?.count).toBe(1);
      expect(mocks.rateLimitRecords.get(key('198.51.100.9'))?.count).toBe(1);
      expect(mocks.rateLimitRecords.has(key('unknown'))).toBe(false);
    });

    it('blocks for the configured minutes once the per-minute limit is exceeded', async () => {
      setupNativeSSO(mocks, harness);
      mocks.mockGetNativeSSOConfig.mockResolvedValue({
        ...(await mocks.mockGetNativeSSOConfig()),
        rateLimit: { maxAttemptsPerMinute: 1, blockDurationMinutes: 2 },
      });

      const first = await exchange();
      const second = await exchange();

      expect(first.response.status).toBe(200);
      expect(second.response.status).toBe(429);
      expect(second.body).toMatchObject({
        error: 'slow_down',
        error_description: 'Too many attempts. Please wait 120 seconds.',
        error_details: {
          code: 'native_sso_rate_limited',
          retryable: true,
          severity: 'warning',
          user_action: 'retry',
        },
      });
      expect(contextHeader(second.ctx, 'Retry-After')).toBe('120');
      const block = mocks.rateLimitRecords.get(`${key('unknown')}:blocked`);
      expect((block?.resetAt ?? 0) - Math.floor(Date.now() / 1000)).toBeGreaterThan(100);
      expect(mocks.mockDeviceSecretRepository.validateAndUse).toHaveBeenCalledTimes(1);
    });

    it('reports the remaining block time, and lets the exchange through once it has passed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
      const now = Math.floor(Date.now() / 1000);
      setupNativeSSO(mocks, harness);
      const blockKey = `${key('unknown')}:blocked`;
      mocks.rateLimitRecords.set(blockKey, { count: 1, resetAt: now + 45, firstRequestAt: now });

      const blocked = await exchange();
      expect(blocked.response.status).toBe(429);
      expect(blocked.body.error_description).toBe('Too many attempts. Please wait 45 seconds.');
      expect(mocks.rateLimitRecords.has(key('unknown'))).toBe(false);

      mocks.rateLimitRecords.set(blockKey, { count: 1, resetAt: now, firstRequestAt: now - 60 });
      const passed = await exchange();
      expect(passed.response.status).toBe(200);
      expect(mocks.rateLimitRecords.get(key('unknown'))?.count).toBe(1);
    });

    it('refuses rather than leaving the exchange unlimited when the limiter fails', async () => {
      setupNativeSSO(mocks, harness);
      (harness.mockEnv as unknown as { RATE_LIMITER: unknown }).RATE_LIMITER = {
        idFromName: (name: string) => name,
        get: () => ({
          getStatusRpc: vi.fn().mockRejectedValue(new Error('limiter down')),
          incrementRpc: vi.fn(),
        }),
      };

      const { response, body } = await exchange();

      expect(response.status).toBe(503);
      expect(body).toEqual({
        error: 'temporarily_unavailable',
        error_description: 'The service is temporarily unavailable. Please try again later.',
        error_details: {
          code: 'native_sso_server_error',
          retryable: true,
          severity: 'error',
          transient: true,
          user_action: 'retry',
        },
      });
      expect(mocks.mockResolveDeviceSecretRouteHint).not.toHaveBeenCalled();
    });
  });
});
