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
  mockGetSystemSettingsCached: vi.fn().mockResolvedValue(null),
  mockValidateClientId: vi.fn().mockReturnValue({ valid: true }),
  mockVerifyClientSecretHash: vi.fn().mockResolvedValue(true),
  mockValidateClientAssertion: vi.fn().mockResolvedValue({ valid: true }),
  mockParseBasicAuth: vi.fn().mockReturnValue({ success: false }),
  mockParseToken: vi.fn(),
  mockParseTokenHeader: vi.fn(),
  mockVerifyToken: vi.fn().mockResolvedValue({}),
  mockIsTokenRevoked: vi.fn().mockResolvedValue(false),
  mockCreateOAuthConfigManager: vi.fn().mockReturnValue({
    getTokenExpiry: vi.fn().mockResolvedValue(3600),
  }),
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
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: mocks.mockGetLogger,
    createLogger: mocks.mockCreateLogger,
    getClientCached: mocks.mockGetClientCached,
    loadTenantProfileCached: mocks.mockLoadTenantProfileCached,
    getSystemSettingsCached: mocks.mockGetSystemSettingsCached,
    getTenantSystemSettings: mocks.mockGetSystemSettingsCached,
    validateClientId: mocks.mockValidateClientId,
    verifyClientSecretHash: mocks.mockVerifyClientSecretHash,
    validateClientAssertion: mocks.mockValidateClientAssertion,
    parseBasicAuth: mocks.mockParseBasicAuth,
    parseToken: mocks.mockParseToken,
    parseTokenHeader: mocks.mockParseTokenHeader,
    verifyToken: mocks.mockVerifyToken,
    isTokenRevoked: mocks.mockIsTokenRevoked,
    createOAuthConfigManager: mocks.mockCreateOAuthConfigManager,
    generateRegionAwareJti: mocks.mockGenerateRegionAwareJti,
    createAccessToken: mocks.mockCreateAccessToken,
    extractDPoPProof: mocks.mockExtractDPoPProof,
    validateDPoPProof: mocks.mockValidateDPoPProof,
    requireDedicatedAdminDatabaseAdapter: mocks.mockRequireDedicatedAdminDatabaseAdapter,
    resolveElevationGrantSubjectToken: mocks.mockResolveElevationGrantSubjectToken,
  };
});

vi.mock('../external-id-jag-verifier', () => ({
  verifyExternalIdJagSubjectToken: mocks.mockVerifyExternalIdJagSubjectToken,
}));

import { tokenHandler } from '../token';

describe('downstream elevation grant token exchange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockGetSystemSettingsCached.mockReset().mockResolvedValue(null);
    mocks.mockVerifyExternalIdJagSubjectToken.mockReset();
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

    it('uses cached settings to disable an environment-enabled exchange', async () => {
      mocks.mockGetSystemSettingsCached.mockResolvedValue({
        oidc: { tokenExchange: { enabled: false } },
      });
      await expectOAuthError(
        request(),
        400,
        'unsupported_grant_type',
        'Token Exchange is not enabled'
      );
    });

    it('falls back to environment configuration when settings lookup fails', async () => {
      mocks.mockGetSystemSettingsCached.mockRejectedValueOnce(new Error('KV unavailable'));
      await expectOAuthError(
        request({ subject_token: undefined }),
        400,
        'invalid_request',
        'subject_token is required'
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
      mocks.mockGetSystemSettingsCached.mockResolvedValue({
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

      mocks.mockGetSystemSettingsCached.mockResolvedValueOnce({
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

      mocks.mockGetSystemSettingsCached.mockResolvedValueOnce({
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

      mocks.mockGetSystemSettingsCached.mockResolvedValueOnce({
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
      mocks.mockGetSystemSettingsCached.mockResolvedValue({
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
      mocks.mockGetSystemSettingsCached.mockResolvedValue({
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
    mocks.mockGetSystemSettingsCached.mockResolvedValueOnce({
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
