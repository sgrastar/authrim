/**
 * Authorization code grant: the claims of the issued access token, ID token and refresh token
 * family (src/token.ts handleAuthorizationCodeGrant).
 */
import {
  mocks,
  resetHarness,
  useCodeStore,
  useTenantSettings,
  postClient,
  postToken,
  codeRequest,
  accessTokenClaims,
} from './helpers/mut-authcode-harness';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createAuthCodeData } from './helpers/fixtures';
import type { MockEnv } from './helpers/mocks';

let env: MockEnv;
const client = postClient();

beforeEach(() => {
  env = resetHarness();
  mocks.getClientCached.mockResolvedValue(client);
});

async function exchange(data: object = createAuthCodeData({ scope: 'api:read' })) {
  const store = useCodeStore(env, data);
  const result = await postToken(env, codeRequest(client, data as { redirectUri: string }));
  return { ...result, store };
}

function familyInput(): Record<string, unknown> {
  const stub = env.REFRESH_TOKEN_ROTATOR.get({} as never) as unknown as { createFamilyRpc: Mock };
  expect(stub.createFamilyRpc).toHaveBeenCalledTimes(1);
  return stub.createFamilyRpc.mock.calls[0][0] as Record<string, unknown>;
}

describe('access token permissions', () => {
  it('embeds the policy permissions the scope evaluates to', async () => {
    mocks.isPolicyEmbeddingEnabled.mockResolvedValue(true);
    mocks.evaluatePermissionEmbeddingForScope.mockResolvedValue({
      permissions: ['documents:read'],
      scopedPermissions: [{ resource: 'documents', actions: ['read'] }],
    });
    await exchange();
    expect(mocks.evaluatePermissionEmbeddingForScope).toHaveBeenCalledWith(
      expect.anything(),
      'user-001',
      'api:read',
      expect.objectContaining({ tenantId: 'default', maxPermissions: 50 })
    );
    expect(accessTokenClaims()).toMatchObject({
      authrim_permissions: ['documents:read'],
      authrim_scoped_permissions: [{ resource: 'documents', actions: ['read'] }],
    });
  });

  it('embeds no permission claims when the evaluation finds none or is off', async () => {
    mocks.isPolicyEmbeddingEnabled.mockResolvedValue(true);
    await exchange();
    const claims = accessTokenClaims();
    expect(claims).not.toHaveProperty('authrim_permissions');
    expect(claims).not.toHaveProperty('authrim_scoped_permissions');
    expect(claims).not.toHaveProperty('authrim_resource_permissions');
  });

  it('does not evaluate policy permissions while policy embedding is off', async () => {
    await exchange();
    expect(mocks.evaluatePermissionEmbeddingForScope).not.toHaveBeenCalled();
    expect(mocks.evaluateIdLevelPermissions).not.toHaveBeenCalled();
  });

  it('still issues when the policy evaluation fails', async () => {
    mocks.isPolicyEmbeddingEnabled.mockResolvedValue(true);
    mocks.evaluatePermissionEmbeddingForScope.mockRejectedValue(new Error('policy down'));
    const { response } = await exchange();
    expect(response.status).toBe(200);
    expect(accessTokenClaims()).not.toHaveProperty('authrim_permissions');
  });

  it('embeds the ID-level resource permissions, truncated to the limit', async () => {
    mocks.isIdLevelPermissionsEnabled.mockResolvedValue(true);
    mocks.getEmbeddingLimits.mockResolvedValue({
      max_embedded_permissions: 50,
      max_resource_permissions: 2,
      max_custom_claims: 20,
    });
    mocks.evaluateIdLevelPermissions.mockResolvedValue(['doc:1:read', 'doc:2:read', 'doc:3:read']);
    await exchange();
    expect(mocks.evaluateIdLevelPermissions).toHaveBeenCalledWith(
      expect.anything(),
      'user-001',
      'default',
      { cache: (env as unknown as { REBAC_CACHE?: unknown }).REBAC_CACHE }
    );
    expect(accessTokenClaims().authrim_resource_permissions).toEqual(['doc:1:read', 'doc:2:read']);
  });

  it('embeds every ID-level permission at the limit', async () => {
    mocks.isIdLevelPermissionsEnabled.mockResolvedValue(true);
    mocks.getEmbeddingLimits.mockResolvedValue({
      max_embedded_permissions: 50,
      max_resource_permissions: 2,
      max_custom_claims: 20,
    });
    mocks.evaluateIdLevelPermissions.mockResolvedValue(['doc:1:read', 'doc:2:read']);
    await exchange();
    expect(accessTokenClaims().authrim_resource_permissions).toEqual(['doc:1:read', 'doc:2:read']);
  });

  it('adds the custom claims, but never over the protocol claims', async () => {
    mocks.isCustomClaimsEnabled.mockResolvedValue(true);
    const evaluate = vi.fn().mockResolvedValue({
      claims_to_add: { tier: 'gold', sub: 'forged', scope: 'admin' },
      claim_overrides: [{ claim: 'sub' }],
    });
    mocks.createTokenClaimEvaluator.mockReturnValue({ evaluate });
    mocks.getAccessTokenRBACClaims.mockResolvedValue({ authrim_org_id: 'org-1' });
    await exchange();
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'default',
        subject_id: 'user-001',
        client_id: client.client_id,
        scope: 'api:read',
        roles: [],
        permissions: [],
        org_id: 'org-1',
      }),
      'access'
    );
    const claims = accessTokenClaims();
    expect(claims.tier).toBe('gold');
    expect(claims.scope).toBe('api:read');
    expect(claims.sub).not.toBe('forged');
  });
});

describe('claims request and assurance in the access token', () => {
  it('carries the claims request and whether it was integrity protected', async () => {
    const claimsParam = JSON.stringify({ userinfo: { nickname: null } });
    await exchange({
      ...createAuthCodeData({ scope: 'api:read', claims: claimsParam }),
      claimsRequestProtected: true,
    });
    expect(accessTokenClaims()).toMatchObject({
      claims: claimsParam,
      claims_request_protected: true,
    });
  });

  it('marks an unprotected claims request as such', async () => {
    const claimsParam = JSON.stringify({ userinfo: { nickname: null } });
    await exchange(createAuthCodeData({ scope: 'api:read', claims: claimsParam }));
    expect(accessTokenClaims().claims_request_protected).toBe(false);
  });

  it('carries no claims request when none was made', async () => {
    await exchange();
    expect(accessTokenClaims()).not.toHaveProperty('claims');
    expect(accessTokenClaims()).not.toHaveProperty('claims_request_protected');
  });

  it('refuses a stored claims request that does not parse', async () => {
    const { response, body } = await exchange(
      createAuthCodeData({ scope: 'api:read', claims: '{not json' })
    );
    expect(response.status).toBe(400);
    expect(body.error).toBeTruthy();
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('names no assurance acr or methods for a code without an AAL', async () => {
    useTenantSettings(env, {
      assurance: { 'assurance.enabled': true, 'assurance.include_in_access_token': true },
    });
    mocks.extractDPoPProof.mockReturnValue('proof');
    const data = {
      ...createAuthCodeData({ scope: 'api:read' }),
      assuranceAcr: 'urn:authrim:aal:1',
      assuranceAmr: ['pwd'],
    };
    useCodeStore(env, data);
    await postToken(env, codeRequest(client, data), { DPoP: 'proof' });
    const claims = accessTokenClaims();
    expect(claims).not.toHaveProperty('acr');
    expect(claims).not.toHaveProperty('amr');
  });

  it('names no methods when the AAL was reached with none proven', async () => {
    useTenantSettings(env, {
      assurance: { 'assurance.enabled': true, 'assurance.include_in_access_token': true },
    });
    mocks.extractDPoPProof.mockReturnValue('proof');
    const data = {
      ...createAuthCodeData({ scope: 'api:read' }),
      aal: 'AAL1',
      assuranceAcr: 'urn:authrim:aal:1',
      assuranceAmr: [],
    };
    useCodeStore(env, data);
    await postToken(env, codeRequest(client, data), { DPoP: 'proof' });
    const claims = accessTokenClaims();
    expect(claims.acr).toBe('urn:authrim:aal:1');
    expect(claims).not.toHaveProperty('amr');
  });

  it('carries the authorization details in the access token and the response', async () => {
    const details = [{ type: 'payment_initiation', amount: '10' }];
    const { body } = await exchange({
      ...createAuthCodeData({ scope: 'api:read' }),
      authorizationDetails: JSON.stringify(details),
    });
    expect(accessTokenClaims().authorization_details).toEqual(details);
    expect(body.authorization_details).toEqual(details);
  });

  it('leaves out authorization details that do not parse', async () => {
    const { response, body } = await exchange({
      ...createAuthCodeData({ scope: 'api:read' }),
      authorizationDetails: '{broken',
    });
    expect(response.status).toBe(200);
    expect(accessTokenClaims()).not.toHaveProperty('authorization_details');
    expect(body).not.toHaveProperty('authorization_details');
  });
});

describe('ID token and refresh token family', () => {
  it('records how the user authenticated on the refresh token family', async () => {
    const data = {
      ...createAuthCodeData({
        scope: 'openid offline_access',
        acr: 'urn:acr:silver',
        amr: ['pwd', 7 as unknown as string, 'otp'],
        authTime: 1_700_000_000,
      }),
      aal: 'AAL2',
      assuranceAcr: 'urn:authrim:aal:2',
      assuranceAmr: ['pwd', 'otp'],
      pushedSignedRequest: true,
    };
    const { response } = await exchange(data);
    expect(response.status).toBe(200);
    expect(familyInput().authContext).toEqual({
      auth_time: 1_700_000_000,
      acr: 'urn:acr:silver',
      amr: ['pwd', 'otp'],
      assurance_auth_time: 1_700_000_000,
      aal: 'AAL2',
      assurance_acr: 'urn:authrim:aal:2',
      assurance_amr: ['pwd', 'otp'],
      pushed_signed_request: true,
    });
    expect(mocks.createIDToken.mock.calls[0][0]).toMatchObject({
      acr: 'urn:acr:silver',
      amr: ['pwd', 'otp'],
      sid: data.sid,
    });
  });

  it('records only the authentication time for a code without assurance', async () => {
    const data = createAuthCodeData({
      scope: 'openid offline_access',
      acr: undefined,
      authTime: 1_700_000_000,
    });
    await exchange(data);
    expect(familyInput().authContext).toEqual({
      auth_time: 1_700_000_000,
      assurance_auth_time: 1_700_000_000,
    });
    const idClaims = mocks.createIDToken.mock.calls[0][0] as Record<string, unknown>;
    expect(idClaims).not.toHaveProperty('acr');
    expect(idClaims).not.toHaveProperty('amr');
  });

  it('defaults auth_time to now for a code that recorded none', async () => {
    const before = Math.floor(Date.now() / 1000);
    await exchange(createAuthCodeData({ scope: 'openid offline_access', authTime: undefined }));
    const authTime = (mocks.createIDToken.mock.calls[0][0] as { auth_time: number }).auth_time;
    expect(authTime).toBeGreaterThanOrEqual(before);
    expect(authTime).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('versions the refresh token by its family', async () => {
    await exchange();
    const family = familyInput();
    expect(family).toMatchObject({
      userId: 'user-001',
      clientId: client.client_id,
      scope: 'api:read',
    });
    const call = mocks.createRefreshToken.mock.calls[0];
    expect(call[4]).toBe(family.jti);
    expect(call[5]).toBe(1);
  });

  it('issues a standalone refresh token id without a rotator', async () => {
    (env as unknown as Record<string, unknown>).REFRESH_TOKEN_ROTATOR = undefined;
    const { response, store } = await exchange();
    expect(response.status).toBe(200);
    const jti = mocks.createRefreshToken.mock.calls[0][4] as string;
    expect(jti).toMatch(/^rt_[0-9a-f-]{36}$/);
    expect(store.registerIssuedTokensRpc).toHaveBeenCalledWith(
      'valid-auth-code',
      'at-jti-001',
      jti
    );
  });
});
