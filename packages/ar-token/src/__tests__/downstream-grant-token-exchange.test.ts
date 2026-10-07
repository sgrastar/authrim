import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockContext,
  createMockDurableObjectNamespace,
  parseJsonResponse,
} from './helpers/mocks';

const mocks = vi.hoisted(() => ({
  mockGetLogger: vi.fn().mockReturnValue({
    module: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  mockCreateLogger: vi.fn().mockReturnValue({
    module: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  mockGetClientCached: vi.fn(),
  mockLoadTenantProfileCached: vi.fn(),
  mockGetProtocolSettingsCached: vi.fn().mockResolvedValue(null),
  mockResolveEffectiveSettings: vi.fn(),
  mockValidateClientId: vi.fn().mockReturnValue({ valid: true }),
  mockVerifyClientSecretHash: vi.fn().mockResolvedValue(true),
  mockValidateClientAssertion: vi.fn().mockResolvedValue({ valid: true }),
  mockParseBasicAuth: vi.fn().mockReturnValue({ success: false }),
  mockParseToken: vi.fn(),
  mockParseTokenHeader: vi.fn(),
  mockVerifyToken: vi.fn().mockResolvedValue({}),
  mockIsTokenRevoked: vi.fn().mockResolvedValue(false),
  mockGenerateRegionAwareJti: vi.fn().mockResolvedValue({ jti: 'region-jti-1' }),
  mockCreateAccessToken: vi.fn().mockResolvedValue({
    token: 'downstream-access-token',
    jti: 'at-jti-1',
  }),
  mockExtractDPoPProof: vi.fn().mockReturnValue(null),
  mockValidateDPoPProof: vi.fn().mockResolvedValue({ valid: true, jkt: 'dpop-jkt' }),
  mockRequireDedicatedAdminDatabaseAdapter: vi.fn().mockReturnValue({}),
  mockResolveElevationGrantSubjectToken: vi.fn(),
  mockVerifyExternalIdJagSubjectToken: vi.fn(),
  mockResolveAccountDataContextFromHono: vi.fn(),
  mockReadAccountAuthenticationState: vi.fn(),
  mockFindOAuthClientConsentRevocation: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: mocks.mockGetLogger,
    createLogger: mocks.mockCreateLogger,
    getClientCached: mocks.mockGetClientCached,
    loadTenantProfileCached: mocks.mockLoadTenantProfileCached,
    getProtocolSettingsCached: async (...args: unknown[]) => ({
      fapi: {},
      oidc: {},
      security: {},
      ...((await mocks.mockGetProtocolSettingsCached(...args)) ?? {}),
    }),
    resolveEffectiveSettings: mocks.mockResolveEffectiveSettings,
    validateClientId: mocks.mockValidateClientId,
    verifyClientSecretHash: mocks.mockVerifyClientSecretHash,
    validateClientAssertion: mocks.mockValidateClientAssertion,
    parseBasicAuth: mocks.mockParseBasicAuth,
    parseToken: mocks.mockParseToken,
    parseTokenHeader: mocks.mockParseTokenHeader,
    verifyToken: mocks.mockVerifyToken,
    isTokenRevoked: mocks.mockIsTokenRevoked,
    generateRegionAwareJti: mocks.mockGenerateRegionAwareJti,
    createAccessToken: mocks.mockCreateAccessToken,
    extractDPoPProof: mocks.mockExtractDPoPProof,
    validateDPoPProof: mocks.mockValidateDPoPProof,
    requireDedicatedAdminDatabaseAdapter: mocks.mockRequireDedicatedAdminDatabaseAdapter,
    resolveElevationGrantSubjectToken: mocks.mockResolveElevationGrantSubjectToken,
    // The subject user's account database and its consent withdrawals.
    resolveAccountDataContextFromHono: mocks.mockResolveAccountDataContextFromHono,
    createAccountAuthContextFromHono: () => ({ coreAdapter: {} }),
    findOAuthClientConsentRevocation: mocks.mockFindOAuthClientConsentRevocation,
    readAccountAuthenticationState: mocks.mockReadAccountAuthenticationState,
  };
});

vi.mock('../external-id-jag-verifier', () => ({
  verifyExternalIdJagSubjectToken: mocks.mockVerifyExternalIdJagSubjectToken,
}));

import { tokenHandler } from '../token';
import { settingsFromSystemSettings } from './helpers/effective-settings';

/** The older system settings the test describes, as both the document and the Settings API. */
let systemSettings: Record<string, unknown> | null = null;
function setSystemSettings(value: Record<string, unknown> | null): void {
  systemSettings = value;
  mocks.mockGetProtocolSettingsCached.mockResolvedValue(value);
}

describe('downstream elevation grant token exchange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockGetProtocolSettingsCached.mockReset().mockResolvedValue(null);
    setSystemSettings(null);
    mocks.mockResolveEffectiveSettings.mockImplementation(async (env: unknown, category: string) =>
      category === 'oauth'
        ? { 'oauth.access_token_expiry': 3600, 'oauth.refresh_token_expiry': 86400 * 30 }
        : settingsFromSystemSettings(env, systemSettings, category)
    );
    mocks.mockVerifyExternalIdJagSubjectToken.mockReset();
    mocks.mockResolveAccountDataContextFromHono.mockReset().mockResolvedValue({});
    mocks.mockReadAccountAuthenticationState.mockReset().mockResolvedValue({ lifecycle: null });
    mocks.mockFindOAuthClientConsentRevocation
      .mockReset()
      .mockResolvedValue({ generation: 0, revokedAt: null });
    mocks.mockVerifyToken.mockReset().mockResolvedValue({});
    mocks.mockIsTokenRevoked.mockReset().mockResolvedValue(false);
    mocks.mockCreateAccessToken.mockReset().mockResolvedValue({
      token: 'downstream-access-token',
      jti: 'at-jti-1',
    });
    mocks.mockValidateClientId.mockReturnValue({ valid: true });
    mocks.mockVerifyClientSecretHash.mockResolvedValue(true);
    mocks.mockLoadTenantProfileCached.mockResolvedValue({
      allows_token_exchange: true,
      max_token_ttl_seconds: 3600,
    });
    mocks.mockGetClientCached.mockResolvedValue({
      client_id: 'service-client-1',
      tenant_id: 'tenant-a',
      client_secret_hash: 'hashed-secret',
      token_exchange_allowed: true,
      token_endpoint_auth_method: 'client_secret_post',
      delegation_mode: 'delegation',
      allowed_scopes: ['openid', 'profile_export'],
      allowed_token_exchange_resources: ['https://service.example.com'],
      allowed_subject_token_clients: [],
    });
    mocks.mockParseToken.mockReturnValue({
      iss: 'https://auth.example.com',
      sub: 'user-1',
      aud: ['service-client-1'],
      client_id: 'authrim-approval-grant',
      exp: Math.floor(Date.now() / 1000) + 300,
      jti: 'subject-jti-1',
      token_use: 'elevation_grant_subject',
    });
    mocks.mockResolveElevationGrantSubjectToken.mockResolvedValue({
      grant: {
        public_grant_id: 'egr_public_1',
        resource_class: 'customer_profile',
        redaction_level: 'masked',
      },
      request: {
        public_request_id: 'apr_public_1',
        investigation_id: 'inv_123',
        target_subject_type: 'user',
        target_subject_id: 'user-1',
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-1',
      },
      authorizationDetails: [
        {
          type: 'authrim_break_glass',
          grant_id: 'egr_public_1',
          request_id: 'apr_public_1',
          investigation_id: 'inv_123',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-1'],
          detail_classes: ['profile_export'],
          dataset: 'profiles',
          audience: 'https://service.example.com',
          redaction_level: 'masked',
          target_subject_type: 'user',
          target_subject_id: 'user-1',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-1',
          ticket_reference: null,
          reference: null,
          policy_preset: 'technical_debug_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
      actClaim: {
        sub: 'admin_user:admin-1',
        client_id: 'service-client-1',
      },
      targetSubject: {
        type: 'user',
        id: 'user-1',
      },
    });
  });

  describe('RFC 8693 validation matrix', () => {
    const defaultBody = {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'subject-token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      client_id: 'service-client-1',
      client_secret: 'top-secret',
      audience: 'https://service.example.com',
    };

    function request(
      bodyOverrides: Record<string, unknown> = {},
      envOverrides: Record<string, unknown> = {}
    ) {
      const body: Record<string, unknown> = { ...defaultBody, ...bodyOverrides };
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) delete body[key];
      }
      return tokenHandler(
        createMockContext({
          method: 'POST',
          body: body as Record<string, string>,
          env: {
            ENABLE_TOKEN_EXCHANGE: 'true',
            ...envOverrides,
          },
        })
      );
    }

    async function expectOAuthError(
      responsePromise: Promise<Response>,
      status: number,
      error: string,
      description: string
    ) {
      const response = await responsePromise;
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);
      expect(response.status).toBe(status);
      expect(body).toEqual({ error, error_description: description });
    }

    async function createVerificationEnv() {
      const actual =
        await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
      const keySet = await actual.generateKeySet('subject-kid-matrix');
      mocks.mockParseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'subject-kid-matrix' });
      return {
        KEY_MANAGER: createMockDurableObjectNamespace({
          rpcMethods: {
            getActiveKeyWithPrivateRpc: vi.fn().mockResolvedValue({
              kid: 'subject-kid-matrix',
              privatePEM: keySet.privatePEM,
            }),
            getAllPublicKeysRpc: vi.fn().mockResolvedValue([keySet.publicJWK]),
          },
        }),
        PUBLIC_JWK_JSON: JSON.stringify(keySet.publicJWK),
      };
    }

    it('rejects token exchange when both environment and settings disable it', async () => {
      await expectOAuthError(
        request({}, { ENABLE_TOKEN_EXCHANGE: 'false' }),
        400,
        'unsupported_grant_type',
        'Token Exchange is not enabled'
      );
      expect(mocks.mockGetClientCached).not.toHaveBeenCalled();
    });

    it('refuses token exchange when its settings cannot be read, even if env enables it', async () => {
      mocks.mockResolveEffectiveSettings.mockRejectedValue(new Error('kv unavailable'));
      await expectOAuthError(
        request(),
        503,
        'temporarily_unavailable',
        'Token Exchange settings are unavailable; try again later'
      );
      expect(mocks.mockResolveEffectiveSettings).toHaveBeenCalledWith(
        expect.anything(),
        'tokens',
        expect.anything()
      );
    });

    it('uses cached settings to disable an environment-enabled exchange', async () => {
      setSystemSettings({
        oidc: { tokenExchange: { enabled: false } },
      });
      await expectOAuthError(
        request(),
        400,
        'unsupported_grant_type',
        'Token Exchange is not enabled'
      );
    });

    it('enforces the configured resource parameter limit', async () => {
      await expectOAuthError(
        request(
          { resource: ['https://one.example', 'https://two.example'] },
          { TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS: '1' }
        ),
        400,
        'invalid_request',
        'Too many resource parameters (max: 1)'
      );
    });

    it('enforces the configured audience parameter limit', async () => {
      await expectOAuthError(
        request(
          { audience: ['service-a', 'service-b'] },
          { TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS: '1' }
        ),
        400,
        'invalid_request',
        'Too many audience parameters (max: 1)'
      );
    });

    it('requires both subject token parameters before client lookup', async () => {
      await expectOAuthError(
        request({ subject_token: undefined }),
        400,
        'invalid_request',
        'subject_token is required'
      );
      await expectOAuthError(
        request({ subject_token_type: undefined }),
        400,
        'invalid_request',
        'subject_token_type is required'
      );
      expect(mocks.mockGetClientCached).not.toHaveBeenCalled();
    });

    it('rejects disallowed subject token types and refresh tokens even when configured', async () => {
      await expectOAuthError(
        request({ subject_token_type: 'urn:ietf:params:oauth:token-type:id_token' }),
        400,
        'invalid_request',
        "subject_token_type 'urn:ietf:params:oauth:token-type:id_token' is not allowed. Allowed types: access_token"
      );

      await expectOAuthError(
        request(
          { subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token' },
          { TOKEN_EXCHANGE_ALLOWED_TYPES: 'refresh_token' }
        ),
        400,
        'invalid_request',
        'refresh_token cannot be used as subject_token for security reasons'
      );
    });

    it('rejects malformed Basic credentials instead of falling back to body credentials', async () => {
      mocks.mockParseBasicAuth.mockReturnValueOnce({
        success: false,
        error: 'malformed_credentials',
      });
      await expectOAuthError(
        request(),
        401,
        'invalid_client',
        'Invalid Authorization header format'
      );
    });

    it('rejects invalid and unknown clients with non-enumerating errors', async () => {
      mocks.mockValidateClientId.mockReturnValueOnce({ valid: false, error: 'invalid client id' });
      await expectOAuthError(request(), 401, 'invalid_client', 'invalid client id');

      mocks.mockGetClientCached.mockResolvedValueOnce(null);
      await expectOAuthError(request(), 401, 'invalid_client', 'Client authentication failed');
    });

    it('enforces tenant profile permission before verifying subject tokens', async () => {
      mocks.mockLoadTenantProfileCached.mockResolvedValueOnce({
        allows_token_exchange: false,
        max_token_ttl_seconds: 3600,
      });
      await expectOAuthError(
        request(),
        403,
        'unauthorized_client',
        'token_exchange grant is not allowed for this tenant profile'
      );
      expect(mocks.mockParseToken).not.toHaveBeenCalled();
    });

    it('requires valid confidential client credentials', async () => {
      mocks.mockVerifyClientSecretHash.mockResolvedValueOnce(false);
      await expectOAuthError(request(), 401, 'invalid_client', 'Invalid client credentials');

      mocks.mockGetClientCached.mockResolvedValueOnce({
        client_id: 'service-client-1',
        tenant_id: 'tenant-a',
        token_endpoint_auth_method: 'none',
        token_exchange_allowed: true,
      });
      await expectOAuthError(
        request({ client_secret: undefined }),
        401,
        'invalid_client',
        'Client authentication is required for Token Exchange'
      );
    });

    it('enforces per-client token exchange and delegation controls', async () => {
      mocks.mockGetClientCached.mockResolvedValueOnce({
        client_id: 'service-client-1',
        tenant_id: 'tenant-a',
        client_secret_hash: 'hashed-secret',
        token_exchange_allowed: false,
      });
      await expectOAuthError(
        request(),
        403,
        'unauthorized_client',
        'Client is not authorized for Token Exchange'
      );

      mocks.mockGetClientCached.mockResolvedValueOnce({
        client_id: 'service-client-1',
        tenant_id: 'tenant-a',
        client_secret_hash: 'hashed-secret',
        token_exchange_allowed: true,
        delegation_mode: 'none',
      });
      await expectOAuthError(
        request(),
        403,
        'unauthorized_client',
        'Token Exchange is disabled for this client'
      );
    });

    it('rejects unsupported requested token types before parsing the subject token', async () => {
      await expectOAuthError(
        request({ requested_token_type: 'urn:ietf:params:oauth:token-type:refresh_token' }),
        400,
        'invalid_request',
        'Only access_token and id-jag (when enabled) are supported as requested_token_type'
      );
      expect(mocks.mockParseToken).not.toHaveBeenCalled();
    });

    it('rejects malformed subject tokens and tokens without a key identifier', async () => {
      mocks.mockParseToken.mockImplementationOnce(() => {
        throw new Error('malformed JWT');
      });
      await expectOAuthError(request(), 400, 'invalid_request', 'Invalid subject_token format');

      mocks.mockParseToken.mockReturnValueOnce({ sub: 'user-1', aud: 'service-client-1' });
      mocks.mockParseTokenHeader.mockReturnValueOnce({ alg: 'RS256' });
      await expectOAuthError(
        request(),
        400,
        'invalid_grant',
        'Subject token is missing kid in header'
      );
    });

    it('rejects expired, revoked, and cross-audience subject tokens', async () => {
      const env = await createVerificationEnv();
      mocks.mockParseToken.mockReturnValueOnce({
        sub: 'user-1',
        aud: 'service-client-1',
        exp: Math.floor(Date.now() / 1000) - 1,
      });
      await expectOAuthError(request({}, env), 400, 'invalid_grant', 'Subject token has expired');

      mocks.mockParseToken.mockReturnValueOnce({
        sub: 'user-1',
        aud: 'service-client-1',
        jti: 'revoked-jti',
      });
      mocks.mockIsTokenRevoked.mockResolvedValueOnce(true);
      await expectOAuthError(
        request({}, env),
        400,
        'invalid_grant',
        'Subject token has been revoked'
      );

      mocks.mockParseToken.mockReturnValueOnce({
        sub: 'user-1',
        aud: 'unrelated-client',
        client_id: 'issuer-client',
      });
      await expectOAuthError(
        request({}, env),
        403,
        'invalid_target',
        'Client is not authorized to exchange this token'
      );
    });

    it.each([
      [
        'ftp://service.example.com',
        "resource 'ftp://service.example.com' must be an absolute URI with http or https scheme",
      ],
      [
        'https://service.example.com/path#fragment',
        "resource 'https://service.example.com/path#fragment' must not include a fragment component",
      ],
      ['not-an-absolute-uri', "resource 'not-an-absolute-uri' must be a valid absolute URI"],
    ])('rejects invalid resource parameter %s', async (resource, description) => {
      const env = await createVerificationEnv();
      mocks.mockParseToken.mockReturnValue({ sub: 'user-1', aud: 'service-client-1' });
      await expectOAuthError(
        request({ audience: undefined, resource }, env),
        400,
        'invalid_request',
        description
      );
    });

    it('rejects allowed-resource violations after subject authorization', async () => {
      const env = await createVerificationEnv();
      mocks.mockParseToken.mockReturnValue({ sub: 'user-1', aud: 'service-client-1' });
      await expectOAuthError(
        request({ audience: 'https://disallowed.example.com' }, env),
        403,
        'invalid_target',
        'Requested audience/resource not allowed: https://disallowed.example.com'
      );
    });

    it('requires actor_token_type and supports only access tokens as actors', async () => {
      const env = await createVerificationEnv();
      mocks.mockParseToken.mockReturnValue({ sub: 'user-1', aud: 'service-client-1' });
      await expectOAuthError(
        request({ actor_token: 'actor-token' }, env),
        400,
        'invalid_request',
        'actor_token_type is required when actor_token is provided'
      );
      await expectOAuthError(
        request(
          {
            actor_token: 'actor-token',
            actor_token_type: 'urn:ietf:params:oauth:token-type:id_token',
          },
          env
        ),
        400,
        'invalid_request',
        'Only access_token is supported as actor_token_type'
      );
    });

    it('rejects malformed actors and actors without kid or audience', async () => {
      const env = await createVerificationEnv();
      const subject = { sub: 'user-1', aud: 'service-client-1' };
      mocks.mockParseToken.mockReturnValueOnce(subject).mockImplementationOnce(() => {
        throw new Error('bad actor');
      });
      await expectOAuthError(
        request(
          {
            actor_token: 'actor-token',
            actor_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          },
          env
        ),
        400,
        'invalid_request',
        'Invalid actor_token format'
      );

      mocks.mockParseToken.mockReturnValueOnce(subject).mockReturnValueOnce({ sub: 'actor-1' });
      mocks.mockParseTokenHeader
        .mockReturnValueOnce({ kid: 'subject-kid-matrix' })
        .mockReturnValueOnce({ alg: 'RS256' });
      await expectOAuthError(
        request(
          {
            actor_token: 'actor-token',
            actor_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          },
          env
        ),
        400,
        'invalid_grant',
        'Actor token is missing kid in header'
      );

      mocks.mockParseToken.mockReturnValueOnce(subject).mockReturnValueOnce({ sub: 'actor-1' });
      mocks.mockParseTokenHeader.mockReturnValue({ kid: 'subject-kid-matrix' });
      await expectOAuthError(
        request(
          {
            actor_token: 'actor-token',
            actor_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          },
          env
        ),
        400,
        'invalid_grant',
        'Actor token must have an audience claim'
      );
    });

    it('issues a downgraded delegated token with explicit actor and multiple targets', async () => {
      const env = await createVerificationEnv();
      mocks.mockGetClientCached.mockResolvedValueOnce({
        client_id: 'service-client-1',
        tenant_id: 'tenant-a',
        client_secret_hash: 'hashed-secret',
        token_exchange_allowed: true,
        delegation_mode: 'delegation',
        allowed_scopes: ['openid', 'profile_export'],
        allowed_token_exchange_resources: [
          'https://service.example.com',
          'https://backup.example.com',
        ],
      });
      mocks.mockParseToken
        .mockReturnValueOnce({
          sub: 'user-1',
          aud: ['service-client-1'],
          scope: 'openid profile_export admin',
          act: { sub: 'prior-actor', client_id: 'prior-client' },
        })
        .mockReturnValueOnce({
          sub: 'actor-1',
          client_id: 'actor-client',
          aud: ['service-client-1'],
        });
      mocks.mockParseTokenHeader.mockReturnValue({ kid: 'subject-kid-matrix' });

      const response = await request(
        {
          scope: 'openid profile_export forbidden',
          audience: ['https://service.example.com', 'https://backup.example.com'],
          actor_token: 'actor-token',
          actor_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        },
        env
      );
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        access_token: 'downstream-access-token',
        token_type: 'Bearer',
        scope: 'openid profile_export',
      });
      expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({
          aud: ['https://service.example.com', 'https://backup.example.com'],
          scope: 'openid profile_export',
          act: {
            sub: 'actor-1',
            client_id: 'actor-client',
            act: { sub: 'prior-actor', client_id: 'prior-client' },
          },
        }),
        expect.anything(),
        expect.any(String),
        expect.any(Number),
        'region-jti-1'
      );
    });

    it('requires ID-JAG to be enabled before accepting its requested token type', async () => {
      await expectOAuthError(
        request({ requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag' }),
        400,
        'invalid_request',
        'ID-JAG token type is not enabled. Enable it via Admin API.'
      );
    });

    it('restricts ID-JAG to identity-bearing subject token types', async () => {
      setSystemSettings({
        oidc: {
          tokenExchange: {
            enabled: true,
            allowedSubjectTokenTypes: ['access_token'],
            idJag: { enabled: true, allowedIssuers: ['https://idp.example.com'] },
          },
        },
      });
      await expectOAuthError(
        request({ requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag' }),
        400,
        'invalid_request',
        'ID-JAG requires subject_token_type to be id_token, jwt, or saml2. Got: urn:ietf:params:oauth:token-type:access_token'
      );
    });

    it('fails closed when ID-JAG issuer trust is missing or mismatched', async () => {
      const idJagBody = {
        requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      };
      mocks.mockParseTokenHeader.mockReturnValue({ kid: 'external-kid' });

      setSystemSettings({
        oidc: {
          tokenExchange: {
            enabled: true,
            allowedSubjectTokenTypes: ['id_token'],
            idJag: { enabled: true, allowedIssuers: [] },
          },
        },
      });
      mocks.mockParseToken.mockReturnValueOnce({ sub: 'user-1' });
      await expectOAuthError(
        request(idJagBody),
        400,
        'invalid_grant',
        'Subject token is missing issuer (iss) claim'
      );

      setSystemSettings({
        oidc: {
          tokenExchange: {
            enabled: true,
            allowedSubjectTokenTypes: ['id_token'],
            idJag: { enabled: true, allowedIssuers: [] },
          },
        },
      });
      mocks.mockParseToken.mockReturnValueOnce({ sub: 'user-1', iss: 'https://idp.example.com' });
      await expectOAuthError(
        request(idJagBody),
        400,
        'invalid_grant',
        'ID-JAG is enabled but no allowed issuers are configured. Configure allowedIssuers via Admin API.'
      );

      setSystemSettings({
        oidc: {
          tokenExchange: {
            enabled: true,
            allowedSubjectTokenTypes: ['id_token'],
            idJag: { enabled: true, allowedIssuers: ['https://trusted.example.com'] },
          },
        },
      });
      mocks.mockParseToken.mockReturnValueOnce({ sub: 'user-1', iss: 'https://evil.example.com' });
      await expectOAuthError(
        request(idJagBody),
        400,
        'invalid_grant',
        "Subject token issuer 'https://evil.example.com' is not in the allowed issuers list"
      );
    });

    it('returns a generic ID-JAG error when external signature verification fails', async () => {
      setSystemSettings({
        oidc: {
          tokenExchange: {
            enabled: true,
            allowedSubjectTokenTypes: ['id_token'],
            idJag: {
              enabled: true,
              allowedIssuers: ['https://idp.example.com'],
            },
          },
        },
      });
      mocks.mockParseToken.mockReturnValue({
        sub: 'user-1',
        iss: 'https://idp.example.com',
      });
      mocks.mockParseTokenHeader.mockReturnValue({ kid: 'external-kid' });
      mocks.mockVerifyExternalIdJagSubjectToken.mockRejectedValueOnce(
        new Error('external signature invalid')
      );

      await expectOAuthError(
        request({
          requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        }),
        400,
        'invalid_grant',
        'Subject token verification failed'
      );
    });

    it('issues a short-lived ID-JAG token with preserved authentication context', async () => {
      const env = await createVerificationEnv();
      setSystemSettings({
        oidc: {
          tokenExchange: {
            enabled: true,
            allowedSubjectTokenTypes: ['id_token'],
            idJag: {
              enabled: true,
              allowedIssuers: ['https://idp.example.com'],
              maxTokenLifetime: 300,
              includeTenantClaim: true,
              requireConfidentialClient: true,
            },
          },
        },
      });
      mocks.mockParseToken.mockReturnValue({
        sub: 'external-user',
        iss: 'https://idp.example.com',
      });
      mocks.mockParseTokenHeader.mockReturnValue({ kid: 'external-kid' });
      mocks.mockVerifyExternalIdJagSubjectToken.mockResolvedValue({
        sub: 'external-user',
        iss: 'https://idp.example.com',
        aud: 'service-client-1',
        scope: 'openid profile_export',
        acr: 'urn:example:loa:2',
        amr: ['pwd', 'otp'],
      });

      const response = await request(
        {
          requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        },
        env
      );
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body.issued_token_type).toBe('urn:ietf:params:oauth:token-type:id-jag');
      expect(body.expires_in).toBe(300);
      expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'external-user',
          original_issuer: 'https://idp.example.com',
          tenant: 'tenant-a',
          acr: 'urn:example:loa:2',
          amr: ['pwd', 'otp'],
        }),
        expect.anything(),
        expect.any(String),
        300,
        'region-jti-1'
      );
    });

    it('rejects actor tokens with invalid signatures, expiry, revocation, or audience', async () => {
      const env = await createVerificationEnv();
      const actorRequest = {
        actor_token: 'actor-token',
        actor_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      };
      const subject = { sub: 'user-1', aud: 'service-client-1' };

      mocks.mockParseToken.mockReturnValueOnce(subject).mockReturnValueOnce({
        sub: 'actor-1',
        aud: 'service-client-1',
      });
      mocks.mockVerifyToken.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('bad actor'));
      await expectOAuthError(
        request(actorRequest, env),
        400,
        'invalid_grant',
        'Actor token verification failed'
      );

      mocks.mockParseToken.mockReturnValueOnce(subject).mockReturnValueOnce({
        sub: 'actor-1',
        aud: 'service-client-1',
        exp: Math.floor(Date.now() / 1000) - 1,
      });
      await expectOAuthError(
        request(actorRequest, env),
        400,
        'invalid_grant',
        'Actor token has expired'
      );

      mocks.mockParseToken.mockReturnValueOnce(subject).mockReturnValueOnce({
        sub: 'actor-1',
        aud: 'service-client-1',
        jti: 'revoked-actor',
      });
      mocks.mockIsTokenRevoked.mockResolvedValueOnce(true);
      await expectOAuthError(
        request(actorRequest, env),
        400,
        'invalid_grant',
        'Actor token has been revoked'
      );

      mocks.mockParseToken.mockReturnValueOnce(subject).mockReturnValueOnce({
        sub: 'actor-1',
        aud: 'different-client',
      });
      await expectOAuthError(
        request(actorRequest, env),
        400,
        'invalid_grant',
        'Actor token audience does not match requesting client'
      );
    });

    it('fails closed when exchanged access token creation fails', async () => {
      const env = await createVerificationEnv();
      mocks.mockParseToken.mockReturnValue({ sub: 'user-1', aud: 'service-client-1' });
      mocks.mockCreateAccessToken.mockRejectedValueOnce(new Error('signing failed'));
      await expectOAuthError(
        request({}, env),
        500,
        'server_error',
        'Failed to create access token'
      );
    });

    it('rejects invalid DPoP and binds valid DPoP to the exchanged token', async () => {
      const env = await createVerificationEnv();
      mocks.mockParseToken.mockReturnValue({ sub: 'user-1', aud: 'service-client-1' });
      mocks.mockExtractDPoPProof.mockReturnValue('dpop-proof');
      mocks.mockValidateDPoPProof.mockResolvedValueOnce({
        valid: false,
        error_description: 'invalid proof',
      });
      const invalidResponse = await request({}, env);
      expect(invalidResponse.status).toBe(400);
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();

      mocks.mockValidateDPoPProof.mockResolvedValueOnce({ valid: true, jkt: 'bound-jkt' });
      const validResponse = await request({}, env);
      const body = await parseJsonResponse<Record<string, unknown>>(validResponse);
      expect(validResponse.status).toBe(200);
      expect(body.token_type).toBe('DPoP');
      expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ cnf: { jkt: 'bound-jkt' } }),
        expect.anything(),
        expect.any(String),
        expect.any(Number),
        'region-jti-1'
      );
    });

    it.each([
      {
        name: 'the requested, subject, and client scope intersection is empty',
        subjectScope: 'openid',
        allowedScopes: ['profile'],
        requestedScope: 'profile',
      },
      {
        name: 'both subject and client scope constraints are absent',
        subjectScope: undefined,
        allowedScopes: undefined,
        requestedScope: 'admin:write',
      },
    ])(
      'rejects token exchange when $name',
      async ({ subjectScope, allowedScopes, requestedScope }) => {
        const env = await createVerificationEnv();
        mocks.mockGetClientCached.mockResolvedValue({
          client_id: 'service-client-1',
          tenant_id: 'tenant-a',
          client_secret_hash: 'hashed-secret',
          token_exchange_allowed: true,
          token_endpoint_auth_method: 'client_secret_post',
          delegation_mode: 'delegation',
          allowed_scopes: allowedScopes,
          allowed_token_exchange_resources: ['https://service.example.com'],
          allowed_subject_token_clients: [],
        });
        mocks.mockParseToken.mockReturnValue({
          sub: 'user-1',
          aud: 'service-client-1',
          scope: subjectScope,
        });

        await expectOAuthError(
          request({ scope: requestedScope }, env),
          400,
          'invalid_scope',
          'Requested scope is not permitted for this token exchange'
        );
        expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      }
    );

    it('uses the subject scope as the ceiling when the client has no scope policy', async () => {
      const env = await createVerificationEnv();
      mocks.mockGetClientCached.mockResolvedValue({
        client_id: 'service-client-1',
        tenant_id: 'tenant-a',
        client_secret_hash: 'hashed-secret',
        token_exchange_allowed: true,
        token_endpoint_auth_method: 'client_secret_post',
        delegation_mode: 'delegation',
        allowed_scopes: undefined,
        allowed_token_exchange_resources: ['https://service.example.com'],
        allowed_subject_token_clients: [],
      });
      mocks.mockParseToken.mockReturnValue({
        sub: 'user-1',
        aud: 'service-client-1',
        scope: 'read:data profile',
      });

      const response = await request({ scope: 'read:data admin:write' }, env);
      const body = await parseJsonResponse<{ scope: string }>(response);

      expect(response.status).toBe(200);
      expect(body.scope).toBe('read:data');
      expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'read:data' }),
        expect.anything(),
        expect.any(String),
        expect.any(Number),
        'region-jti-1'
      );
    });

    it('supports resource-only and combined resource/audience targets', async () => {
      const env = await createVerificationEnv();
      mocks.mockGetClientCached.mockResolvedValue({
        client_id: 'service-client-1',
        tenant_id: 'tenant-a',
        client_secret_hash: 'hashed-secret',
        token_exchange_allowed: true,
        delegation_mode: 'impersonation',
        allowed_scopes: ['openid'],
        allowed_token_exchange_resources: [
          'https://service.example.com',
          'https://resource.example.com',
        ],
      });
      mocks.mockParseToken.mockReturnValue({
        sub: 'user-1',
        aud: 'service-client-1',
        scope: 'openid',
      });

      const resourceOnly = await request(
        { audience: undefined, resource: 'https://resource.example.com' },
        env
      );
      expect(resourceOnly.status).toBe(200);
      expect(mocks.mockCreateAccessToken).toHaveBeenLastCalledWith(
        expect.objectContaining({
          aud: 'https://resource.example.com',
          resource: 'https://resource.example.com',
        }),
        expect.anything(),
        expect.any(String),
        expect.any(Number),
        'region-jti-1'
      );

      const both = await request(
        {
          audience: 'https://service.example.com',
          resource: 'https://resource.example.com',
        },
        env
      );
      expect(both.status).toBe(200);
      expect(mocks.mockCreateAccessToken).toHaveBeenLastCalledWith(
        expect.objectContaining({
          aud: ['https://service.example.com', 'https://resource.example.com'],
        }),
        expect.anything(),
        expect.any(String),
        expect.any(Number),
        'region-jti-1'
      );
    });

    describe('consent of a user subject token', () => {
      const revokedAt = Date.now() - 60_000;

      function userSubjectToken(overrides: Record<string, unknown> = {}) {
        return {
          sub: 'user-1',
          aud: 'service-client-1',
          client_id: 'app-client',
          scope: 'openid',
          iat: Math.floor(Date.now() / 1000) - 10,
          ...overrides,
        };
      }

      it('refuses a subject token of a consent generation the user has withdrawn', async () => {
        const env = await createVerificationEnv();
        mocks.mockFindOAuthClientConsentRevocation.mockResolvedValue({ generation: 2, revokedAt });
        mocks.mockParseToken.mockReturnValue(userSubjectToken({ authrim_consent_generation: 1 }));

        await expectOAuthError(
          request({}, env),
          400,
          'invalid_grant',
          'Subject token is invalid or revoked'
        );
        expect(mocks.mockFindOAuthClientConsentRevocation).toHaveBeenCalledWith(expect.anything(), {
          tenantId: 'tenant-a',
          userId: 'user-1',
          clientId: 'app-client',
        });
        expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      });

      it('refuses a subject token without a generation issued before the withdrawal', async () => {
        const env = await createVerificationEnv();
        mocks.mockFindOAuthClientConsentRevocation.mockResolvedValue({ generation: 1, revokedAt });
        mocks.mockParseToken.mockReturnValue(
          userSubjectToken({ iat: Math.floor(revokedAt / 1000) - 5 })
        );

        await expectOAuthError(
          request({}, env),
          400,
          'invalid_grant',
          'Subject token is invalid or revoked'
        );
        expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      });

      it('carries the subject token consent into the exchanged token', async () => {
        const env = await createVerificationEnv();
        mocks.mockFindOAuthClientConsentRevocation.mockResolvedValue({ generation: 2, revokedAt });
        mocks.mockParseToken.mockReturnValue(userSubjectToken({ authrim_consent_generation: 2 }));

        const response = await request({}, env);
        expect(response.status).toBe(200);
        expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
          expect.objectContaining({
            sub: 'user-1',
            client_id: 'service-client-1',
            authrim_consent_generation: 2,
            authrim_consent_client_id: 'app-client',
          }),
          expect.anything(),
          expect.any(String),
          expect.any(Number),
          'region-jti-1'
        );
      });

      it('fails closed (503) when the withdrawal state cannot be read', async () => {
        const env = await createVerificationEnv();
        mocks.mockFindOAuthClientConsentRevocation.mockRejectedValue(new Error('d1 down'));
        mocks.mockParseToken.mockReturnValue(userSubjectToken({ authrim_consent_generation: 0 }));

        await expectOAuthError(
          request({}, env),
          503,
          'temporarily_unavailable',
          'Consent state is unavailable'
        );
        expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      });

      it('refuses a subject token whose user has no active account', async () => {
        const env = await createVerificationEnv();
        mocks.mockResolveAccountDataContextFromHono.mockRejectedValue(
          new Error('lookup_destination_revalidation_failed')
        );
        mocks.mockParseToken.mockReturnValue(userSubjectToken({ authrim_consent_generation: 0 }));

        await expectOAuthError(
          request({}, env),
          400,
          'invalid_grant',
          'Subject token is invalid or revoked'
        );
      });

      it('carries an external subject issuer on for a subject that was never an account', async () => {
        const env = await createVerificationEnv();
        mocks.mockResolveAccountDataContextFromHono.mockRejectedValue(
          new Error('account_data_route_not_found')
        );
        mocks.mockParseToken.mockReturnValue(
          userSubjectToken({
            sub: 'service-7',
            client_id: 'https://issuer.example.com',
            authrim_subject_issuer: 'https://issuer.example.com',
          })
        );

        const response = await request({}, env);
        expect(response.status).toBe(200);
        expect(mocks.mockReadAccountAuthenticationState).toHaveBeenCalledWith(
          expect.anything(),
          'tenant-a',
          'service-7'
        );
        expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
          expect.objectContaining({
            sub: 'service-7',
            authrim_subject_issuer: 'https://issuer.example.com',
          }),
          expect.anything(),
          expect.any(String),
          expect.any(Number),
          'region-jti-1'
        );
        const claims = mocks.mockCreateAccessToken.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(claims.authrim_consent_generation).toBeUndefined();
      });

      it('refuses an externally asserted subject that was a deleted account', async () => {
        const env = await createVerificationEnv();
        mocks.mockResolveAccountDataContextFromHono.mockRejectedValue(
          new Error('account_data_route_not_found')
        );
        mocks.mockReadAccountAuthenticationState.mockResolvedValue({ lifecycle: 'deleted' });
        mocks.mockParseToken.mockReturnValue(
          userSubjectToken({ authrim_subject_issuer: 'https://issuer.example.com' })
        );

        await expectOAuthError(
          request({}, env),
          400,
          'invalid_grant',
          'Subject token is invalid or revoked'
        );
        expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      });

      it('holds an externally asserted subject that is an account to its consent', async () => {
        const env = await createVerificationEnv();
        mocks.mockFindOAuthClientConsentRevocation.mockResolvedValue({ generation: 2, revokedAt });
        mocks.mockParseToken.mockReturnValue(
          userSubjectToken({
            authrim_subject_issuer: 'https://issuer.example.com',
            authrim_consent_generation: 1,
          })
        );

        await expectOAuthError(
          request({}, env),
          400,
          'invalid_grant',
          'Subject token is invalid or revoked'
        );
        expect(mocks.mockResolveAccountDataContextFromHono).toHaveBeenCalledWith(
          expect.anything(),
          'user-1'
        );
        expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      });

      it('holds a user grant to its consent even when its public sub looks like a client', async () => {
        const env = await createVerificationEnv();
        mocks.mockFindOAuthClientConsentRevocation.mockResolvedValue({ generation: 2, revokedAt });
        mocks.mockParseToken.mockReturnValue(
          userSubjectToken({ sub: 'client:alice', authrim_consent_generation: 1 })
        );

        await expectOAuthError(
          request({}, env),
          400,
          'invalid_grant',
          'Subject token is invalid or revoked'
        );
        expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      });

      it('refuses a legacy ID token whose mapped sub only looks like a client', async () => {
        const env = await createVerificationEnv();
        // Issued before mapped principal subs were refused: no consent generation, no reference,
        // no token_use. Its owner cannot be found, so it is refused.
        mocks.mockResolveAccountDataContextFromHono.mockRejectedValue(
          new Error('account_data_route_not_found')
        );
        mocks.mockParseToken.mockReturnValue({
          sub: 'client:alice',
          aud: 'service-client-1',
          scope: 'openid',
          iat: Math.floor(Date.now() / 1000) - 10,
        });

        await expectOAuthError(
          // Presented under any subject_token_type: what it is comes from its signed claims.
          request({}, env),
          400,
          'invalid_grant',
          'Subject token is invalid or revoked'
        );
        expect(mocks.mockResolveAccountDataContextFromHono).toHaveBeenCalledWith(
          expect.anything(),
          'client:alice'
        );
        expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      });

      it('exchanges a client credentials token, recording its principal on the new token', async () => {
        const env = await createVerificationEnv();
        mocks.mockParseToken.mockReturnValue({
          sub: 'client:app-client',
          aud: 'service-client-1',
          client_id: 'app-client',
          scope: 'openid',
          token_use: 'access',
          jti: 'cc-jti-1',
          iat: Math.floor(Date.now() / 1000) - 10,
        });

        const response = await request({}, env);
        expect(response.status).toBe(200);
        expect(mocks.mockResolveAccountDataContextFromHono).not.toHaveBeenCalled();
        expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
          expect.objectContaining({
            sub: 'client:app-client',
            client_id: 'service-client-1',
            authrim_subject_principal: 'client',
          }),
          expect.anything(),
          expect.any(String),
          expect.any(Number),
          'region-jti-1'
        );
      });

      it('carries the recorded principal on through another exchange', async () => {
        const env = await createVerificationEnv();
        // A token from an earlier exchange: sub of the client, client_id of the exchanger.
        mocks.mockParseToken.mockReturnValue({
          sub: 'client:app-client',
          aud: 'service-client-1',
          client_id: 'first-exchanger',
          scope: 'openid',
          token_use: 'access',
          jti: 'exchanged-jti-1',
          authrim_subject_principal: 'client',
          iat: Math.floor(Date.now() / 1000) - 10,
        });

        const response = await request({}, env);
        expect(response.status).toBe(200);
        expect(mocks.mockResolveAccountDataContextFromHono).not.toHaveBeenCalled();
        expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
          expect.objectContaining({
            sub: 'client:app-client',
            authrim_subject_principal: 'client',
          }),
          expect.anything(),
          expect.any(String),
          expect.any(Number),
          'region-jti-1'
        );
      });

      it('refuses a legacy ID token mapped to look like a client credentials token', async () => {
        const env = await createVerificationEnv();
        mocks.mockResolveAccountDataContextFromHono.mockRejectedValue(
          new Error('account_data_route_not_found')
        );
        // A mapping could once emit sub, client_id and token_use on an ID token, but never jti.
        mocks.mockParseToken.mockReturnValue({
          sub: 'client:alice',
          aud: 'service-client-1',
          client_id: 'alice',
          token_use: 'access',
          scope: 'openid',
          iat: Math.floor(Date.now() / 1000) - 10,
        });

        await expectOAuthError(
          request({}, env),
          400,
          'invalid_grant',
          'Subject token is invalid or revoked'
        );
        expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      });

      it('does not take a recorded principal on an ID token', async () => {
        const env = await createVerificationEnv();
        mocks.mockResolveAccountDataContextFromHono.mockRejectedValue(
          new Error('account_data_route_not_found')
        );
        // No token_use: an ID token, whose mapping or custom claims might have added the claim.
        mocks.mockParseToken.mockReturnValue({
          sub: 'client:alice',
          aud: 'service-client-1',
          scope: 'openid',
          authrim_subject_principal: 'client',
          iat: Math.floor(Date.now() / 1000) - 10,
        });

        await expectOAuthError(
          request({}, env),
          400,
          'invalid_grant',
          'Subject token is invalid or revoked'
        );
        expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      });

      it('does not take an original_issuer claim for evidence of an external subject', async () => {
        const env = await createVerificationEnv();
        // An ID token whose identity mapping emitted original_issuer, for a subject with no
        // account route: not an external subject, so refused.
        mocks.mockResolveAccountDataContextFromHono.mockRejectedValue(
          new Error('account_data_route_not_found')
        );
        mocks.mockParseToken.mockReturnValue(
          userSubjectToken({ sub: 'pairwise-legacy', original_issuer: 'https://idp.example.com' })
        );

        await expectOAuthError(
          request({}, env),
          400,
          'invalid_grant',
          'Subject token is invalid or revoked'
        );
        expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      });

      it('finds the account of a pairwise ID token through its sealed subject reference', async () => {
        const actual =
          await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
        const rootKey = 'ab'.repeat(32);
        const reference = await actual.sealSubjectReference(
          { OBJECT_ENCRYPTION_ROOT_KEY: rootKey },
          { tenantId: 'tenant-a', clientId: 'app-client' },
          'user-1'
        );
        const env = { ...(await createVerificationEnv()), OBJECT_ENCRYPTION_ROOT_KEY: rootKey };
        // Only the account the reference seals has a route; the pairwise sub has none.
        mocks.mockResolveAccountDataContextFromHono.mockImplementation(
          async (_c: unknown, accountId: string) => {
            if (accountId !== 'user-1') throw new Error('account_data_route_not_found');
            return {};
          }
        );
        mocks.mockFindOAuthClientConsentRevocation.mockResolvedValue({ generation: 2, revokedAt });
        mocks.mockParseToken.mockReturnValue({
          sub: 'pairwise-subject-abc',
          aud: 'service-client-1',
          azp: 'app-client',
          scope: 'openid',
          iat: Math.floor(Date.now() / 1000) - 10,
          authrim_consent_generation: 2,
          authrim_subject_ref: reference,
        });

        const response = await request({}, env);
        expect(response.status).toBe(200);
        expect(mocks.mockFindOAuthClientConsentRevocation).toHaveBeenCalledWith(expect.anything(), {
          tenantId: 'tenant-a',
          userId: 'user-1',
          clientId: 'app-client',
        });
        expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
          expect.objectContaining({
            sub: 'pairwise-subject-abc',
            authrim_consent_generation: 2,
            authrim_consent_client_id: 'app-client',
            authrim_subject_ref: reference,
          }),
          expect.anything(),
          expect.any(String),
          expect.any(Number),
          'region-jti-1'
        );
      });

      it('refuses a subject reference sealed for another client', async () => {
        const actual =
          await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
        const rootKey = 'ab'.repeat(32);
        const reference = await actual.sealSubjectReference(
          { OBJECT_ENCRYPTION_ROOT_KEY: rootKey },
          { tenantId: 'tenant-a', clientId: 'other-client' },
          'user-1'
        );
        const env = { ...(await createVerificationEnv()), OBJECT_ENCRYPTION_ROOT_KEY: rootKey };
        mocks.mockParseToken.mockReturnValue({
          sub: 'pairwise-subject-abc',
          aud: 'service-client-1',
          azp: 'app-client',
          scope: 'openid',
          iat: Math.floor(Date.now() / 1000) - 10,
          authrim_consent_generation: 0,
          authrim_subject_ref: reference,
        });

        await expectOAuthError(
          request({}, env),
          400,
          'invalid_grant',
          'Subject token is invalid or revoked'
        );
      });
    });
  });

  it('mints downstream access tokens with approval authorization details', async () => {
    const actual =
      await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
    const keySet = await actual.generateKeySet('subject-kid-1');
    mocks.mockParseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'subject-kid-1' });

    const ctx = createMockContext({
      method: 'POST',
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: 'subject-token',
        subject_token_type: 'urn:authrim:token-type:elevation-grant',
        client_id: 'service-client-1',
        client_secret: 'top-secret',
        audience: 'https://service.example.com',
      },
      env: {
        KEY_MANAGER: createMockDurableObjectNamespace({
          rpcMethods: {
            getActiveKeyWithPrivateRpc: vi.fn().mockResolvedValue({
              kid: 'subject-kid-1',
              privatePEM: keySet.privatePEM,
            }),
            getAllPublicKeysRpc: vi.fn().mockResolvedValue([keySet.publicJWK]),
          },
        }),
        ENABLE_TOKEN_EXCHANGE: 'true',
        PUBLIC_JWK_JSON: JSON.stringify(keySet.publicJWK),
      },
    });

    const response = await tokenHandler(ctx);
    const body = await parseJsonResponse<{ access_token: string; issued_token_type: string }>(
      response
    );

    expect(response.status).toBe(200);
    expect(body.access_token).toBe('downstream-access-token');
    expect(body.issued_token_type).toBe('urn:ietf:params:oauth:token-type:access_token');
    expect(mocks.mockResolveElevationGrantSubjectToken).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        requestingClientId: 'service-client-1',
      })
    );
    expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'user-1',
        aud: 'https://service.example.com',
        client_id: 'service-client-1',
        act: {
          sub: 'admin_user:admin-1',
          client_id: 'service-client-1',
        },
        authorization_details: [
          expect.objectContaining({
            type: 'authrim_break_glass',
            grant_id: 'egr_public_1',
          }),
        ],
        authrim_elevation: expect.objectContaining({
          grant_id: 'egr_public_1',
          request_id: 'apr_public_1',
          target_subject_id: 'user-1',
        }),
      }),
      expect.anything(),
      expect.anything(),
      expect.any(Number),
      'region-jti-1'
    );
  });

  it('preserves requested audience even if a second parseBody call would be empty', async () => {
    const actual =
      await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
    const keySet = await actual.generateKeySet('subject-kid-1');
    mocks.mockParseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'subject-kid-1' });

    const ctx = createMockContext({
      method: 'POST',
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: 'subject-token',
        subject_token_type: 'urn:authrim:token-type:elevation-grant',
        client_id: 'service-client-1',
        client_secret: 'top-secret',
        audience: 'https://service.example.com',
      },
      env: {
        KEY_MANAGER: createMockDurableObjectNamespace({
          rpcMethods: {
            getActiveKeyWithPrivateRpc: vi.fn().mockResolvedValue({
              kid: 'subject-kid-1',
              privatePEM: keySet.privatePEM,
            }),
            getAllPublicKeysRpc: vi.fn().mockResolvedValue([keySet.publicJWK]),
          },
        }),
        ENABLE_TOKEN_EXCHANGE: 'true',
        PUBLIC_JWK_JSON: JSON.stringify(keySet.publicJWK),
      },
    });

    const firstParsedBody = {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'subject-token',
      subject_token_type: 'urn:authrim:token-type:elevation-grant',
      client_id: 'service-client-1',
      client_secret: 'top-secret',
      audience: 'https://service.example.com',
    };
    vi.mocked(ctx.req.parseBody).mockResolvedValueOnce(firstParsedBody).mockResolvedValueOnce({});

    const response = await tokenHandler(ctx);
    const body = await parseJsonResponse<{ access_token: string }>(response);

    expect(response.status).toBe(200);
    expect(body.access_token).toBe('downstream-access-token');
    expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        aud: 'https://service.example.com',
      }),
      expect.anything(),
      expect.anything(),
      expect.any(Number),
      'region-jti-1'
    );
    expect(ctx.req.parseBody).toHaveBeenCalledTimes(1);
  });

  it('downgrades exchanged token scope to the subject, request, and client intersection', async () => {
    const actual =
      await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
    const keySet = await actual.generateKeySet('subject-kid-1');
    mocks.mockParseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'subject-kid-1' });
    mocks.mockParseToken.mockReturnValue({
      iss: 'https://auth.example.com',
      sub: 'user-1',
      aud: ['service-client-1'],
      client_id: 'upstream-client-1',
      exp: Math.floor(Date.now() / 1000) + 300,
      jti: 'subject-jti-1',
      scope: 'read:data write:data',
    });
    mocks.mockGetClientCached.mockResolvedValueOnce({
      client_id: 'service-client-1',
      tenant_id: 'tenant-a',
      client_secret_hash: 'hashed-secret',
      token_exchange_allowed: true,
      token_endpoint_auth_method: 'client_secret_post',
      delegation_mode: 'delegation',
      allowed_scopes: ['read:data', 'profile'],
      allowed_token_exchange_resources: ['https://service.example.com'],
      allowed_subject_token_clients: [],
    });

    const ctx = createMockContext({
      method: 'POST',
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: 'subject-token',
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        client_id: 'service-client-1',
        client_secret: 'top-secret',
        audience: 'https://service.example.com',
        scope: 'read:data admin:data',
      },
      env: {
        KEY_MANAGER: createMockDurableObjectNamespace({
          rpcMethods: {
            getActiveKeyWithPrivateRpc: vi.fn().mockResolvedValue({
              kid: 'subject-kid-1',
              privatePEM: keySet.privatePEM,
            }),
            getAllPublicKeysRpc: vi.fn().mockResolvedValue([keySet.publicJWK]),
          },
        }),
        ENABLE_TOKEN_EXCHANGE: 'true',
        PUBLIC_JWK_JSON: JSON.stringify(keySet.publicJWK),
      },
    });

    const response = await tokenHandler(ctx);
    const body = await parseJsonResponse<{ access_token: string; scope: string }>(response);

    expect(response.status).toBe(200);
    expect(body.access_token).toBe('downstream-access-token');
    expect(body.scope).toBe('read:data');
    expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'user-1',
        aud: 'https://service.example.com',
        client_id: 'service-client-1',
        scope: 'read:data',
        act: {
          sub: 'client:service-client-1',
          client_id: 'service-client-1',
        },
      }),
      expect.anything(),
      expect.anything(),
      expect.any(Number),
      'region-jti-1'
    );
  });

  it('rejects repeated resource parameters above the env configured limit', async () => {
    const ctx = createMockContext({
      method: 'POST',
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      },
      env: {
        ENABLE_TOKEN_EXCHANGE: 'true',
        TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS: '1',
      },
    });
    const repeatedResourceBody = {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'subject-token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      client_id: 'service-client-1',
      client_secret: 'top-secret',
      resource: ['https://service.example.com/a', 'https://service.example.com/b'],
    } as unknown as Awaited<ReturnType<typeof ctx.req.parseBody>>;
    vi.mocked(ctx.req.parseBody).mockResolvedValueOnce(repeatedResourceBody);

    const response = await tokenHandler(ctx);
    const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toBe('Too many resource parameters (max: 1)');
    expect(mocks.mockGetClientCached).not.toHaveBeenCalled();
  });

  it('applies settings configured audience limits before client authentication', async () => {
    setSystemSettings({
      oidc: {
        tokenExchange: {
          maxAudienceParams: 1,
        },
      },
    });
    const ctx = createMockContext({
      method: 'POST',
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      },
      env: {
        ENABLE_TOKEN_EXCHANGE: 'true',
        TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS: '10',
      },
    });
    const repeatedAudienceBody = {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'subject-token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      client_id: 'service-client-1',
      client_secret: 'top-secret',
      audience: ['https://service.example.com/a', 'https://service.example.com/b'],
    } as unknown as Awaited<ReturnType<typeof ctx.req.parseBody>>;
    vi.mocked(ctx.req.parseBody).mockResolvedValueOnce(repeatedAudienceBody);

    const response = await tokenHandler(ctx);
    const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toBe('Too many audience parameters (max: 1)');
    expect(mocks.mockGetClientCached).not.toHaveBeenCalled();
  });

  it('rejects subject token types that are not enabled by env configuration', async () => {
    const ctx = createMockContext({
      method: 'POST',
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: 'subject-token',
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        client_id: 'service-client-1',
        client_secret: 'top-secret',
      },
      env: {
        ENABLE_TOKEN_EXCHANGE: 'true',
        TOKEN_EXCHANGE_ALLOWED_TYPES: 'jwt',
      },
    });

    const response = await tokenHandler(ctx);
    const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toBe(
      "subject_token_type 'urn:ietf:params:oauth:token-type:access_token' is not allowed. Allowed types: jwt"
    );
    expect(mocks.mockGetClientCached).not.toHaveBeenCalled();
  });

  it('rejects refresh tokens even if they are mistakenly enabled as subject token types', async () => {
    const ctx = createMockContext({
      method: 'POST',
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: 'subject-token',
        subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
        client_id: 'service-client-1',
        client_secret: 'top-secret',
      },
      env: {
        ENABLE_TOKEN_EXCHANGE: 'true',
        TOKEN_EXCHANGE_ALLOWED_TYPES: 'refresh_token',
      },
    });

    const response = await tokenHandler(ctx);
    const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toBe(
      'refresh_token cannot be used as subject_token for security reasons'
    );
    expect(mocks.mockGetClientCached).not.toHaveBeenCalled();
  });
});
