/**
 * refresh_token grant: the presented refresh token is parsed, its signature, issuer and audience
 * verified, and only then are its binding, family and consent state read.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mocks, resetHarness, answerQueryOne, FAL3_SETTINGS } from './helpers/mut-grants-harness';
import {
  presentRefreshToken,
  refresh,
  RT_CLIENT_ID,
  RT_JTI,
  type PresentedRefreshToken,
} from './helpers/mut-grants-refresh-fixture';
import { createMockDurableObjectNamespace, type MockEnv } from './helpers/mocks';

const INVALID_GRANT = {
  error: 'invalid_grant',
  error_description: 'Refresh token is invalid or expired',
};

describe('refresh_token grant: verification and family state', () => {
  let env: MockEnv;
  let presented: PresentedRefreshToken;

  beforeEach(() => {
    env = resetHarness();
    presented = presentRefreshToken(env);
  });

  function expectNotRotated() {
    expect(presented.rotateRpc).not.toHaveBeenCalled();
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  }

  describe('a certificate-bound client', () => {
    function certificateClient(payloadCnf?: Record<string, unknown>) {
      presented = presentRefreshToken(env, {
        client: { tls_client_certificate_bound_access_tokens: true },
        payload: payloadCnf ? { cnf: payloadCnf } : {},
      });
    }

    it.each([
      ['an invalid certificate', { valid: false, error: 'certificate_required' }],
      ['a certificate without a thumbprint', { valid: true }],
    ])('is refused with %s', async (_label, binding) => {
      certificateClient({ 'x5t#S256': 'thumb' });
      mocks.validateClientCertificateBinding.mockResolvedValue(binding);
      const result = await refresh(env, presented);
      expect(result.status).toBe(401);
      expect(result.body).toEqual({
        error: 'invalid_client',
        error_description: 'Client certificate authentication failed',
      });
      expect(mocks.getRefreshToken).not.toHaveBeenCalled();
    });

    it('is refused a token bound to another certificate', async () => {
      certificateClient({ 'x5t#S256': 'other-thumb' });
      mocks.validateClientCertificateBinding.mockResolvedValue({
        valid: true,
        thumbprint: 'thumb',
      });
      const result = await refresh(env, presented);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_grant',
        error_description: 'Refresh token certificate binding mismatch',
      });
      expect(mocks.getRefreshToken).not.toHaveBeenCalled();
    });

    it('rebinds the new tokens to the same certificate', async () => {
      certificateClient({ 'x5t#S256': 'thumb' });
      mocks.validateClientCertificateBinding.mockResolvedValue({
        valid: true,
        thumbprint: 'thumb',
      });
      const result = await refresh(env, presented);
      expect(result.status).toBe(200);
      expect(mocks.createAccessToken.mock.calls[0][0].cnf).toEqual({ 'x5t#S256': 'thumb' });
      expect(mocks.createRefreshToken.mock.calls[0][0].cnf).toEqual({ 'x5t#S256': 'thumb' });
    });
  });

  describe('the token itself', () => {
    it('refuses a token that cannot be parsed', async () => {
      mocks.parseToken.mockImplementation(() => {
        throw new Error('bad jwt');
      });
      const result = await refresh(env, presented);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_grant',
        error_description: 'Invalid refresh token format',
      });
    });

    it('answers 500 for a token whose header cannot be decoded', async () => {
      const result = await refresh(env, presented, { refresh_token: '%%%.payload.signature' });
      expect(result.status).toBe(500);
      expect(result.body).toEqual({
        error: 'server_error',
        error_description: 'Failed to load verification key',
      });
      expect(mocks.verifyToken).not.toHaveBeenCalled();
    });

    it('decodes a base64url header that uses the URL-safe alphabet', async () => {
      // This header's base64url form contains both "-" and "_".
      const header = { alg: 'RS256', kid: 'test-kid-001', x: '>>>???' };
      const encoded = btoa(JSON.stringify(header))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(encoded).toMatch(/-/);
      expect(encoded).toMatch(/_/);
      const result = await refresh(env, presented, { refresh_token: `${encoded}.e30.sig` });
      expect(result.status).toBe(200);
    });

    it('verifies the signature for the issuer with the client as audience', async () => {
      mocks.verifyToken.mockRejectedValue(new Error('bad signature'));
      const result = await refresh(env, presented);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_grant',
        error_description: 'Refresh token signature verification failed',
      });
      expect(mocks.verifyToken).toHaveBeenCalledWith(
        presented.token,
        expect.anything(),
        'https://auth.example.com',
        { audience: RT_CLIENT_ID }
      );
      expect(mocks.getRefreshToken).not.toHaveBeenCalled();
    });

    it('refuses a token without a jti', async () => {
      presented = presentRefreshToken(env, { payload: { jti: undefined } });
      const result = await refresh(env, presented);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_grant',
        error_description: 'Refresh token missing JTI',
      });
    });

    it('refuses a pairwise client token without a sealed account reference', async () => {
      presented = presentRefreshToken(env, { client: { subject_type: 'pairwise' } });
      const result = await refresh(env, presented);
      expect(result.status).toBe(400);
      expect(result.body).toEqual(INVALID_GRANT);
      expect(mocks.getRefreshToken).not.toHaveBeenCalled();
    });
  });

  describe('the family', () => {
    it.each([
      [3, 3],
      [undefined, 1],
    ])('reads and rotates the family at version rtv=%s', async (rtv, version) => {
      presented = presentRefreshToken(env, { payload: { rtv } });
      expect((await refresh(env, presented)).status).toBe(200);
      expect(mocks.getRefreshToken).toHaveBeenCalledWith(
        env,
        'user-001',
        version,
        RT_CLIENT_ID,
        RT_JTI,
        'default'
      );
      expect(presented.rotateRpc.mock.calls[0][0]).toMatchObject({
        incomingVersion: version,
        incomingJti: RT_JTI,
      });
    });

    it('refuses a token the rotator does not know', async () => {
      mocks.getRefreshToken.mockResolvedValue(null);
      const result = await refresh(env, presented);
      expect(result.status).toBe(400);
      expect(result.body).toEqual(INVALID_GRANT);
      expectNotRotated();
    });

    it('refuses a family begun without a pushed, signed request at FAL3', async () => {
      mocks.settings.assurance = FAL3_SETTINGS;
      const result = await refresh(env, presented);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'unauthorized_client',
        error_description:
          'This grant does not meet the required federation assurance level (FAL3)',
      });
      expectNotRotated();
    });

    it('serves a family begun with a pushed, signed request at FAL3', async () => {
      mocks.settings.assurance = FAL3_SETTINGS;
      presented = presentRefreshToken(env, {
        family: { auth_context: { pushed_signed_request: true } },
      });
      expect((await refresh(env, presented)).status).toBe(200);
    });

    it('answers 500 when no signing key can be loaded', async () => {
      env.AUTHRIM_CONFIG.get = vi.fn().mockResolvedValue('rotated-key-version');
      env.KEY_MANAGER = createMockDurableObjectNamespace({
        rpcMethods: {
          getActiveKeyWithPrivateRpc: vi.fn().mockRejectedValue(new Error('key manager down')),
        },
      });
      const result = await refresh(env, presented);
      expect(result.status).toBe(500);
      expect(result.body).toEqual({
        error: 'server_error',
        error_description: 'Failed to load signing key',
      });
      expectNotRotated();
    });

    it('answers 503 while the account route is unavailable', async () => {
      mocks.resolveAccountDataContextFromHono.mockRejectedValue(new Error('route down'));
      const result = await refresh(env, presented);
      expect(result.status).toBe(503);
      expect(result.body).toEqual({
        error: 'temporarily_unavailable',
        error_description: 'Account data is unavailable',
      });
      expectNotRotated();
    });
  });

  describe('consent', () => {
    it('answers 503 when the consent withdrawal cannot be read', async () => {
      answerQueryOne({ oauth_client_consent_revocations: new Error('db down') });
      const result = await refresh(env, presented);
      expect(result.status).toBe(503);
      expect(result.body).toEqual({
        error: 'temporarily_unavailable',
        error_description: 'Consent state is unavailable',
      });
      expectNotRotated();
    });

    it('refuses a family granted under a withdrawn generation', async () => {
      answerQueryOne({ oauth_client_consent_revocations: { generation: 2, revoked_at: 1 } });
      presented = presentRefreshToken(env, { family: { family_consent_generation: 1 } });
      const result = await refresh(env, presented);
      expect(result.body).toEqual(INVALID_GRANT);
      expectNotRotated();
    });

    it('refuses a family created before the withdrawal', async () => {
      const revokedAt = Date.now() - 1_000;
      answerQueryOne({
        oauth_client_consent_revocations: { generation: 2, revoked_at: revokedAt },
      });
      presented = presentRefreshToken(env, { family: { family_created_at: revokedAt - 1 } });
      expect((await refresh(env, presented)).body).toEqual(INVALID_GRANT);
    });

    it('serves a family granted under the current generation after a withdrawal', async () => {
      answerQueryOne({ oauth_client_consent_revocations: { generation: 2, revoked_at: 1 } });
      presented = presentRefreshToken(env, {
        family: { family_consent_generation: 2, family_created_at: 0 },
      });
      const result = await refresh(env, presented);
      expect(result.status).toBe(200);
      expect(mocks.createAccessToken.mock.calls[0][0].authrim_consent_generation).toBe(2);
    });
  });

  describe('the subject the app receives', () => {
    it('refuses a family whose recorded subject is no longer the one derived', async () => {
      presented = presentRefreshToken(env, { family: { family_issued_subject: 'someone-else' } });
      const result = await refresh(env, presented);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_grant',
        error_description: 'The subject of the tokens changed; the user must authenticate again',
      });
      expectNotRotated();
    });
  });
});
