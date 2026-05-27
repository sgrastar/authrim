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

import { tokenHandler } from '../token';

describe('downstream elevation grant token exchange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      token_endpoint_auth_method: 'client_secret_basic',
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
      token_endpoint_auth_method: 'client_secret_basic',
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
