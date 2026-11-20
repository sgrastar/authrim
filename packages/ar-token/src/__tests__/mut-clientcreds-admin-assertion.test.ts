/**
 * Admin API machine access (token.ts handleAdminMachineClientCredentialsGrant): the private_key_jwt
 * assertion's shape and timing, the dedicated Admin database, and the stored principal and
 * credential it must match, before any signature check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Harness } from './helpers/mut-nativesso-harness';
import {
  ADMIN_CLIENT_ID,
  ADMIN_KID,
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

describe('Admin API machine access: assertion and credential checks', () => {
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

  const request = (overrides: Record<string, string | undefined> = {}) =>
    requestClientCredentials(harness, tokenHandler, { ...ADMIN_REQUEST, ...overrides });

  async function expectRefused(
    overrides: Record<string, string | undefined>,
    description: string,
    status = 401,
    error = 'invalid_client'
  ) {
    const { response, body } = await request(overrides);
    expect(response.status).toBe(status);
    expect(body).toEqual({ error, error_description: description });
    expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
  }

  it.each([
    ['no assertion', { client_assertion: undefined }],
    ['an assertion of another type', { client_assertion_type: 'urn:example:saml' }],
  ])('requires private_key_jwt, refusing %s before reading the database', async (_n, input) => {
    await expectRefused(
      input,
      'Admin API machine access requires private_key_jwt client authentication'
    );
    expect(mocks.mockRequireDedicatedAdminDatabaseAdapter).not.toHaveBeenCalled();
    expect(mocks.mockGetClientCached).not.toHaveBeenCalled();
  });

  it('refuses an assertion that cannot be parsed', async () => {
    mocks.mockParseToken.mockImplementation(() => {
      throw new Error('bad');
    });

    await expectRefused({}, 'Invalid client_assertion format');
  });

  describe('client', () => {
    beforeEach(() => {
      mocks.mockValidateClientId.mockImplementation((id: unknown) =>
        typeof id === 'string' && id.length > 0
          ? { valid: true }
          : { valid: false, error: 'client_id is required' }
      );
    });

    it('takes the client from the assertion sub when no client_id is given', async () => {
      const { response } = await request({ client_id: undefined });

      expect(response.status).toBe(200);
      expect(mocks.mockAdminAdapter.queryOne).toHaveBeenCalledWith(
        expect.stringContaining('WHERE p.client_id = ? AND c.kid = ?'),
        [ADMIN_CLIENT_ID, ADMIN_KID]
      );
    });

    it('prefers the client_id given over the assertion sub', async () => {
      useAdminAssertion(mocks, { sub: 'other-client' });

      const { response } = await request();

      expect(response.status).toBe(200);
    });

    it('refuses an assertion whose sub is not a string when no client_id is given', async () => {
      useAdminAssertion(mocks, { sub: 42 });

      await expectRefused({ client_id: undefined }, 'client_id is required');
    });
  });

  it.each([
    ['kid', { kid: undefined }],
    ['kid', { kid: '' }],
    ['alg', { alg: undefined }],
    ['alg', { alg: '' }],
  ])('refuses an assertion header without %s', async (name, header) => {
    useAdminAssertion(mocks, {}, header);

    await expectRefused({}, `Admin machine client_assertion must include ${name}`);
  });

  it.each([
    ['jti', { jti: undefined }],
    ['jti', { jti: '' }],
    ['iat', { iat: String(NOW) }],
    ['exp', { exp: undefined }],
  ])('refuses an assertion without %s', async (name, claims) => {
    useAdminAssertion(mocks, claims);

    await expectRefused({}, `Admin machine client_assertion must include ${name}`);
  });

  describe('timing', () => {
    it.each([
      ['issued more than a minute ahead', { iat: NOW + 61, exp: NOW + 120 }],
      ['expiring when issued', { iat: NOW, exp: NOW }],
    ])('refuses an assertion %s', async (_name, claims) => {
      useAdminAssertion(mocks, claims);

      await expectRefused({}, 'Admin machine client_assertion timing is invalid');
    });

    it('refuses an assertion living more than five minutes', async () => {
      useAdminAssertion(mocks, { exp: NOW + 301 });

      await expectRefused({}, 'Admin machine client_assertion lifetime must be 5 minutes or less');
    });

    it('accepts an assertion issued a minute ahead and living exactly five minutes', async () => {
      useAdminAssertion(mocks, { iat: NOW + 60, exp: NOW + 300 });

      expect((await request()).response.status).toBe(200);
    });
  });

  it('fails when the dedicated Admin database is not configured', async () => {
    mocks.mockRequireDedicatedAdminDatabaseAdapter.mockImplementation(() => {
      throw new Error('DB_ADMIN missing');
    });

    await expectRefused({}, 'Admin machine access is not configured', 500, 'server_error');
    expect(mocks.mockRequireDedicatedAdminDatabaseAdapter).toHaveBeenCalledWith(
      expect.anything(),
      'admin-machine-access'
    );
  });

  describe('stored principal and credential', () => {
    it.each([
      ['an unknown credential', null],
      ['a disabled principal', { status: 'disabled' }],
      ['a revoked credential', { credential_status: 'revoked' }],
      ['a credential of another algorithm', { credential_alg: 'RS256' }],
      ['a credential not valid yet', { credential_not_before: NOW_MS + 1 }],
      ['an expired credential', { credential_expires_at: NOW_MS - 3_600_000 }],
    ])('refuses %s before checking the signature', async (_name, row) => {
      if (row === null) mocks.mockAdminAdapter.queryOne.mockResolvedValue(null);
      else mockAdminMachineAccess(mocks, row);

      await expectRefused({}, 'Client authentication failed');
      expect(mocks.mockValidateClientAssertion).not.toHaveBeenCalled();
    });

    it.each([
      ['a rotating credential', { credential_status: 'rotating' }],
      ['a credential valid from now', { credential_not_before: NOW_MS }],
    ])('accepts %s', async (_name, row) => {
      mockAdminMachineAccess(mocks, row);

      expect((await request()).response.status).toBe(200);
    });

    it('fails on a stored public key that is not JSON', async () => {
      mockAdminMachineAccess(mocks, { credential_public_jwk_json: '{not json' });

      await expectRefused({}, 'Admin machine credential is invalid', 500, 'server_error');
    });

    it('checks the signature with the stored key, its kid and algorithm', async () => {
      mocks.mockValidateClientAssertion.mockResolvedValue({ valid: false, error_description: 'x' });

      await expectRefused({}, 'Client assertion validation failed');
      expect(mocks.mockValidateClientAssertion).toHaveBeenCalledWith(
        'header.payload.signature',
        'https://auth.example.com/token',
        {
          client_id: ADMIN_CLIENT_ID,
          token_endpoint_auth_method: 'private_key_jwt',
          jwks: {
            keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: ADMIN_KID, alg: 'ES256' }],
          },
        },
        { acceptIssuerIdAsAudience: false }
      );
    });

    it('refuses a replayed assertion', async () => {
      mocks.mockAdminAdapter.execute.mockImplementation(async (sql: string) => {
        if (sql.includes('admin_machine_assertion_jti')) throw new Error('UNIQUE constraint');
        return { success: true, rowsAffected: 1 };
      });

      await expectRefused({}, 'Client assertion replay detected');
    });

    it('requires a scope', async () => {
      await expectRefused(
        { scope: undefined },
        'Admin API machine access requires scope',
        400,
        'invalid_scope'
      );
    });
  });
});
