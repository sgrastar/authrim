/**
 * refresh_token grant: what a refresh issues. Guest revalidation, DPoP binding (RFC 9449
 * section 5), embedded permissions, the original authentication's assurance claims, and the
 * reissued (optionally SD-JWT) ID token.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mocks, resetHarness } from './helpers/mut-grants-harness';
import {
  presentRefreshToken,
  refresh,
  RT_CLIENT_ID,
  type PresentedRefreshToken,
} from './helpers/mut-grants-refresh-fixture';
import type { MockEnv } from './helpers/mocks';

describe('refresh_token grant: issued claims', () => {
  let env: MockEnv;
  let presented: PresentedRefreshToken;

  beforeEach(() => {
    env = resetHarness();
    presented = presentRefreshToken(env);
  });

  const accessClaims = () => mocks.createAccessToken.mock.calls[0][0];
  const idClaims = () => mocks.createIDToken.mock.calls[0][0];

  describe('a guest account', () => {
    beforeEach(() => {
      mocks.findCanonicalRuntimeAccount.mockResolvedValue({
        tenant_id: 'default',
        account_type: 'user',
        registration_state: 'guest',
        lifecycle_state: 'active',
        metadata_json: '{}',
      });
    });

    it('is refused scopes the client does not permit guests', async () => {
      mocks.guestContract.mockReturnValue({
        guestAuth: { enabled: true, allowedScopes: ['openid'] },
      });
      const result = await refresh(env, presented);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_scope',
        error_description: 'The client does not permit the requested guest scopes',
      });
    });

    it('is refused once guest authentication is no longer allowed', async () => {
      mocks.assertGuestSessionAuthenticationAllowed.mockRejectedValue(
        new Error('account_authentication_not_allowed')
      );
      const result = await refresh(env, presented);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_grant',
        error_description: 'The account is no longer available',
      });
    });

    it('answers 503 when its authorization state cannot be read', async () => {
      mocks.assertGuestSessionAuthenticationAllowed.mockRejectedValue(new Error('db down'));
      const result = await refresh(env, presented);
      expect(result.status).toBe(503);
      expect(result.body).toEqual({
        error: 'temporarily_unavailable',
        error_description: 'Account authorization state is unavailable',
      });
      expect(mocks.createAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('DPoP', () => {
    const publicClient = { token_endpoint_auth_method: 'none', client_secret_hash: undefined };

    it.each([
      ['a native', { ...publicClient, application_type: 'native' }, undefined],
      ['a browser', publicClient, { Origin: 'https://spa.example.com' }],
    ])(
      'refuses %s public client a refresh token not bound to DPoP',
      async (_l, client, headers) => {
        presented = presentRefreshToken(env, { client });
        const result = await refresh(env, presented, { client_secret: undefined }, headers);
        expect(result.status).toBe(400);
        expect(result.body).toEqual({
          error: 'invalid_grant',
          error_description: 'Public client refresh tokens must be DPoP-bound',
        });
      }
    );

    it("refuses a public client's proof made with another key", async () => {
      presented = presentRefreshToken(env, {
        client: { ...publicClient, application_type: 'native' },
        payload: { cnf: { jkt: 'bound-jkt' } },
      });
      mocks.extractDPoPProof.mockReturnValue('dpop-proof');
      const result = await refresh(env, presented, { client_secret: undefined });
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_dpop_proof',
        error_description: 'DPoP proof JWK does not match refresh token binding',
      });
    });

    it('lets a confidential client move its tokens to a new DPoP key', async () => {
      presented = presentRefreshToken(env, { payload: { cnf: { jkt: 'old-jkt' } } });
      mocks.extractDPoPProof.mockReturnValue('dpop-proof');
      const result = await refresh(env, presented);
      expect(result.status).toBe(200);
      expect(result.body.token_type).toBe('DPoP');
      expect(accessClaims().cnf).toEqual({ jkt: 'proof-jkt' });
      expect(mocks.createRefreshToken.mock.calls[0][0].cnf).toEqual({ jkt: 'proof-jkt' });
    });

    it('validates the proof for this request and refuses an invalid one', async () => {
      mocks.extractDPoPProof.mockReturnValue('dpop-proof');
      mocks.validateDPoPProof.mockResolvedValue({ valid: false });
      const result = await refresh(env, presented);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_dpop_proof',
        error_description: 'DPoP proof validation failed',
      });
      expect(mocks.validateDPoPProof).toHaveBeenCalledWith(
        'dpop-proof',
        'POST',
        'https://auth.example.com/oauth/token',
        undefined,
        env,
        RT_CLIENT_ID,
        'default'
      );
    });
  });

  describe('embedded permissions', () => {
    it('embeds the permissions of the granted scope', async () => {
      mocks.isPolicyEmbeddingEnabled.mockResolvedValue(true);
      mocks.evaluatePermissionEmbeddingForScope.mockResolvedValue({
        permissions: ['docs:read'],
        scopedPermissions: [{ resource: 'docs', actions: ['read'] }],
      });
      await refresh(env, presented, { scope: 'openid profile' });
      expect(mocks.evaluatePermissionEmbeddingForScope).toHaveBeenCalledWith(
        expect.anything(),
        'user-001',
        'openid profile',
        expect.objectContaining({ tenantId: 'default', maxPermissions: 50 })
      );
      expect(accessClaims()).toMatchObject({
        authrim_permissions: ['docs:read'],
        authrim_scoped_permissions: [{ resource: 'docs', actions: ['read'] }],
      });
    });

    it('embeds nothing when none are found, and evaluates nothing while off', async () => {
      mocks.isPolicyEmbeddingEnabled.mockResolvedValue(true);
      await refresh(env, presented);
      expect(accessClaims()).not.toHaveProperty('authrim_permissions');
      expect(accessClaims()).not.toHaveProperty('authrim_scoped_permissions');

      env = resetHarness();
      presented = presentRefreshToken(env);
      await refresh(env, presented);
      expect(mocks.evaluatePermissionEmbeddingForScope).not.toHaveBeenCalled();
    });
  });

  describe("the original authentication's assurance", () => {
    const authContext = {
      assurance_auth_time: 1_700_000_100,
      aal: 'AAL2',
      assurance_acr: 'urn:aal2',
      assurance_amr: ['pwd', 'otp'],
      auth_time: 1_700_000_000,
      acr: 'id-acr',
      amr: ['pwd'],
    };

    function withAssurance(settings: Record<string, unknown>, context: Record<string, unknown>) {
      mocks.settings.assurance = settings;
      presented = presentRefreshToken(env, { family: { auth_context: context } });
    }

    const enabled = {
      'assurance.enabled': true,
      'assurance.include_in_access_token': true,
    };

    it('carries the authentication time, acr and amr into both tokens', async () => {
      withAssurance(enabled, authContext);
      expect((await refresh(env, presented)).status).toBe(200);
      expect(accessClaims()).toMatchObject({
        auth_time: 1_700_000_100,
        acr: 'urn:aal2',
        amr: ['pwd', 'otp'],
      });
      expect(idClaims()).toMatchObject({ auth_time: 1_700_000_000, acr: 'id-acr', amr: ['pwd'] });
    });

    it('names no acr or amr for a family without an AAL', async () => {
      withAssurance(enabled, { ...authContext, aal: undefined });
      await refresh(env, presented);
      expect(accessClaims().auth_time).toBe(1_700_000_100);
      expect(accessClaims()).not.toHaveProperty('acr');
      expect(accessClaims()).not.toHaveProperty('amr');
    });

    it('leaves out what the family did not record', async () => {
      withAssurance(enabled, { aal: 'AAL1', assurance_amr: [], amr: [], auth_time: 1 });
      await refresh(env, presented);
      expect(accessClaims()).not.toHaveProperty('acr');
      expect(accessClaims()).not.toHaveProperty('amr');
      expect(accessClaims()).not.toHaveProperty('auth_time');
      expect(idClaims()).not.toHaveProperty('acr');
      expect(idClaims()).not.toHaveProperty('amr');
    });

    it.each([
      ['assurance is off', { ...enabled, 'assurance.enabled': false }],
      [
        'the access token does not include it',
        { ...enabled, 'assurance.include_in_access_token': false },
      ],
    ])('adds nothing to the access token while %s', async (_label, settings) => {
      withAssurance(settings, authContext);
      await refresh(env, presented);
      expect(accessClaims()).not.toHaveProperty('auth_time');
      expect(accessClaims()).not.toHaveProperty('acr');
    });
  });

  describe('failures while issuing', () => {
    it('answers 500 when the access token cannot be created', async () => {
      mocks.createAccessToken.mockRejectedValue(new Error('sign failed'));
      const result = await refresh(env, presented);
      expect(result.status).toBe(500);
      expect(result.body).toEqual({
        error: 'server_error',
        error_description: 'Failed to create access token',
      });
      expect(presented.rotateRpc).not.toHaveBeenCalled();
    });

    it('answers 500 when the ID token cannot be created', async () => {
      mocks.createIDToken.mockRejectedValue(new Error('sign failed'));
      const result = await refresh(env, presented);
      expect(result.status).toBe(500);
      expect(result.body).toEqual({
        error: 'server_error',
        error_description: 'Failed to create ID token',
      });
      expect(presented.rotateRpc).not.toHaveBeenCalled();
    });
  });

  describe('an SD-JWT ID token', () => {
    const sdJwtClient = { id_token_signed_response_type: 'sd-jwt' };

    it('is issued with the default selective claims where the tenant enables it', async () => {
      mocks.policyFlags.sdJwt = true;
      presented = presentRefreshToken(env, {
        client: sdJwtClient,
        family: { family_consent_generation: 4, family_release_approval: ['*'] },
      });
      mocks.coreAdapter.queryOne.mockImplementation(async (sql: string) =>
        sql.includes('oauth_client_consent_revocations') ? { generation: 4, revoked_at: 1 } : null
      );
      const result = await refresh(env, presented);
      expect(result.status).toBe(200);
      expect(result.body.id_token).toBe('mock-sd-jwt-id-token');
      expect(mocks.createIDToken).not.toHaveBeenCalled();
      const [claims, , , , selective] = mocks.createSDJWTIDTokenFromClaims.mock.calls[0];
      expect(selective).toEqual(['email', 'phone_number', 'address', 'birthdate']);
      expect(claims).toMatchObject({ authrim_consent_generation: 4, authrim_release: ['*'] });
    });

    it("is issued with the client's own selective claims", async () => {
      mocks.policyFlags.sdJwt = true;
      presented = presentRefreshToken(env, {
        client: { ...sdJwtClient, sd_jwt_selective_claims: ['email'] },
      });
      await refresh(env, presented);
      expect(mocks.createSDJWTIDTokenFromClaims.mock.calls[0][4]).toEqual(['email']);
    });

    it.each([
      ['the tenant does not enable it', sdJwtClient, false],
      ['the client does not ask for it', {}, true],
    ])('is not issued when %s', async (_label, client, flag) => {
      mocks.policyFlags.sdJwt = flag;
      presented = presentRefreshToken(env, { client });
      const result = await refresh(env, presented);
      expect(result.body.id_token).toBe('mock-id-token');
      expect(mocks.createSDJWTIDTokenFromClaims).not.toHaveBeenCalled();
    });
  });
});
