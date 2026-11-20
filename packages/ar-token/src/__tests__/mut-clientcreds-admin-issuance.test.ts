/**
 * Admin API machine access (token.ts handleAdminMachineClientCredentialsGrant): the grant
 * snapshot, DPoP, the token lifetime within the credential's, the claims, the credential's
 * last-use record, the issued event and the response headers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Harness } from './helpers/mut-nativesso-harness';
import { contextHeader } from './helpers/mut-nativesso-fixtures';
import {
  ADMIN_CLIENT_ID,
  ADMIN_REQUEST,
  mockAdminMachineAccess,
  requestClientCredentials,
  useAdminAssertion,
} from './helpers/mut-clientcreds-fixtures';

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

const NOW_MS = Date.parse('2026-11-19T00:00:00Z');
const NOW = NOW_MS / 1000;

describe('Admin API machine access: issued token', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    harness = setupHarness(mocks);
    mockAdminMachineAccess(mocks);
    useAdminAssertion(mocks);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const request = (
    overrides: Record<string, string | undefined> = {},
    headers: Record<string, string> = {}
  ) =>
    requestClientCredentials(
      harness,
      tokenHandler,
      { ...ADMIN_REQUEST, ...overrides },
      { headers }
    );
  const claims = () => mocks.mockCreateAccessToken.mock.calls[0][0] as Record<string, unknown>;

  describe('grant snapshot', () => {
    it.each([
      ['the principal was disabled', { status: 'disabled' }],
      ['the credential was revoked', { credential_status: 'revoked' }],
      ['the credential is not valid yet', { credential_not_before: NOW_MS + 60_000 }],
      ['the credential expired', { credential_expires_at: NOW_MS - 1 }],
    ])('refuses when, as of the snapshot, %s', async (_name, snapshot) => {
      mockAdminMachineAccess(mocks, {}, snapshot);

      const { response, body } = await request();

      expect(response.status).toBe(401);
      expect(body).toEqual({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      });
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('accepts a credential that started rotating by the snapshot', async () => {
      mockAdminMachineAccess(mocks, {}, { credential_status: 'rotating' });

      expect((await request()).response.status).toBe(200);
    });
  });

  it('fails without issuing when the signing key cannot be loaded', async () => {
    harness.mockEnv.AUTHRIM_CONFIG.get = vi.fn(async (key: string) =>
      key.startsWith('v1:key-version:') ? `rotated-${Math.random()}` : null
    );
    (harness.mockEnv as unknown as { KEY_MANAGER?: unknown }).KEY_MANAGER = undefined;

    const { response, body } = await request();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: 'server_error',
      error_description: 'Failed to load signing key',
    });
    expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
  });

  describe('DPoP', () => {
    it.each([
      ['an invalid proof', { valid: false, error_description: 'bad proof' }, 'bad proof'],
      ['a proof without key thumbprint', { valid: true }, 'DPoP validation failed'],
    ])('refuses %s', async (_name, validation, description) => {
      mocks.mockExtractDPoPProof.mockReturnValue('dpop-proof');
      mocks.mockValidateDPoPProof.mockResolvedValue(validation);

      const { response, body } = await request();

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: 'invalid_dpop_proof', error_description: description });
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('issues an unconstrained bearer token without a proof', async () => {
      const { body } = await request();

      expect(body.token_type).toBe('Bearer');
      expect(claims()).toMatchObject({
        sender_constrained: false,
        credential_strength: 'asymmetric_key',
      });
      expect(Object.keys(claims())).not.toContain('cnf');
    });
  });

  describe('lifetime', () => {
    it('refuses when less than a second of the credential lifetime would remain', async () => {
      mockAdminMachineAccess(mocks, { credential_expires_at: NOW_MS + 1_999 });

      const { response, body } = await request();

      expect(response.status).toBe(401);
      expect(body).toEqual({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      });
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('ends the token a second before the credential', async () => {
      mockAdminMachineAccess(mocks, { credential_expires_at: NOW_MS + 2_000 });

      const { body } = await request();

      expect(body.expires_in).toBe(1);
      expect(mocks.mockCreateAccessToken.mock.calls[0][3]).toBe(1);
    });
  });

  it('fails without a partial response when the token cannot be created', async () => {
    mocks.mockCreateAccessToken.mockRejectedValue(new Error('signing failed'));

    const { response, body } = await request();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: 'server_error',
      error_description: 'Failed to create access token',
    });
  });

  it('records the last use, publishes the issued event and answers uncached', async () => {
    const { ctx, response, body } = await request(
      { scope: 'admin:tenants.read admin:clients.create' },
      { 'CF-Connecting-IP': '203.0.113.5', 'User-Agent': 'setup-cli/1.0' }
    );
    await Promise.all(vi.mocked(ctx.executionCtx.waitUntil).mock.calls.map(([work]) => work));

    expect(response.status).toBe(200);
    expect(body).toEqual({
      access_token: 'mock-access-token',
      token_type: 'Bearer',
      expires_in: 600,
      scope: 'admin:tenants.read admin:clients.create',
    });
    expect(mocks.mockAdminAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE admin_machine_credentials'),
      [expect.any(Number), '203.0.113.5', 'setup-cli/1.0', 'amk_setup']
    );
    expect(mocks.mockPublishEvent).toHaveBeenCalledWith(expect.anything(), {
      type: 'token.access.issued',
      tenantId: 'default',
      data: {
        jti: 'at-jti-001',
        clientId: ADMIN_CLIENT_ID,
        userId: 'machine:amp_setup',
        scopes: ['admin:tenants.read', 'admin:clients.create'],
        expiresAt: NOW + 600,
        grantType: 'client_credentials',
      },
    });
    expect(contextHeader(ctx, 'Cache-Control')).toBe('no-store');
    expect(contextHeader(ctx, 'Pragma')).toBe('no-cache');
  });

  it('records no client address or agent it was not given', async () => {
    const { ctx } = await request();
    await Promise.all(vi.mocked(ctx.executionCtx.waitUntil).mock.calls.map(([work]) => work));

    expect(mocks.mockAdminAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE admin_machine_credentials'),
      [expect.any(Number), null, null, 'amk_setup']
    );
  });
});
