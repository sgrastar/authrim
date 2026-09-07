import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCoreQuery,
  mockCoreExecute,
  mockSessionFetch,
  mockSessionGet,
  mockSessionInvalidate,
  mockListExternalProviderSessions,
  mockFindByProviderSub,
  mockUpdateLinkedIdentity,
  mockGetProvider,
  mockSafeFetchJson,
  mockJwtVerify,
  mockCreateLocalJwkSet,
  mockDiagnosticTokenValidation,
  mockDiagnosticAuthDecision,
  mockDiagnosticCleanup,
  mockCreateDiagnosticLogger,
  mockResolveAccountContext,
  MockD1Adapter,
  sqlTracker,
} = vi.hoisted(() => {
  const tracker = {
    calls: [] as { method: string; sql: string; params: unknown[] }[],
    reset() {
      this.calls.length = 0;
    },
  };

  const coreQuery = vi.fn().mockResolvedValue([]);
  const coreExecute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
  const sessionFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  const sessionGet = vi.fn();
  const sessionInvalidate = vi.fn();
  const listExternalProviderSessions = vi.fn();
  const findByProviderSub = vi.fn().mockResolvedValue([]);
  const updateLinkedIdentity = vi.fn().mockResolvedValue(true);
  const getProvider = vi.fn().mockResolvedValue({
    id: 'provider-google',
    name: 'Google',
    issuer: 'https://accounts.google.com',
    clientId: 'client-123',
    jwksUri: 'https://accounts.google.com/jwks',
  });
  const jwtVerify = vi.fn();
  const createLocalJwkSet = vi.fn().mockReturnValue({});
  const safeFetchJson = vi.fn().mockResolvedValue({ keys: [] });
  const diagnosticTokenValidation = vi.fn().mockResolvedValue(undefined);
  const diagnosticAuthDecision = vi.fn().mockResolvedValue(undefined);
  const diagnosticCleanup = vi.fn().mockResolvedValue(undefined);
  const createDiagnosticLogger = vi.fn().mockResolvedValue({
    logTokenValidation: diagnosticTokenValidation,
    logAuthDecision: diagnosticAuthDecision,
    cleanup: diagnosticCleanup,
  });
  const resolveAccountContext = vi.fn();

  class D1AdapterClass {
    constructor(_options: { db: unknown }) {}

    query = (sql: string, params?: unknown[]) => {
      tracker.calls.push({ method: 'query', sql, params: params || [] });
      return coreQuery(sql, params);
    };

    execute = (sql: string, params?: unknown[]) => {
      tracker.calls.push({ method: 'execute', sql, params: params || [] });
      return coreExecute(sql, params);
    };
  }

  return {
    mockCoreQuery: coreQuery,
    mockCoreExecute: coreExecute,
    mockSessionFetch: sessionFetch,
    mockSessionGet: sessionGet,
    mockSessionInvalidate: sessionInvalidate,
    mockListExternalProviderSessions: listExternalProviderSessions,
    mockFindByProviderSub: findByProviderSub,
    mockUpdateLinkedIdentity: updateLinkedIdentity,
    mockGetProvider: getProvider,
    mockSafeFetchJson: safeFetchJson,
    mockJwtVerify: jwtVerify,
    mockCreateLocalJwkSet: createLocalJwkSet,
    mockDiagnosticTokenValidation: diagnosticTokenValidation,
    mockDiagnosticAuthDecision: diagnosticAuthDecision,
    mockDiagnosticCleanup: diagnosticCleanup,
    mockCreateDiagnosticLogger: createDiagnosticLogger,
    mockResolveAccountContext: resolveAccountContext,
    MockD1Adapter: D1AdapterClass,
    sqlTracker: tracker,
  };
});

vi.mock('@authrim/ar-lib-core', () => ({
  D1Adapter: MockD1Adapter,
  resolveAuthCorePersistenceAdapterFromEnv: vi
    .fn()
    .mockResolvedValue(new MockD1Adapter({ db: {} })),
  getSessionStoreBySessionId: vi.fn(() => ({
    stub: {
      fetch: mockSessionFetch,
      getSessionRpc: mockSessionGet,
      invalidateSessionRpc: mockSessionInvalidate,
    },
  })),
  listExternalProviderSessions: mockListExternalProviderSessions,
  isShardedSessionId: vi.fn(() => true),
  createErrorResponse: vi.fn(
    (_c, code, _opts) => new Response(null, { status: code === 'internal' ? 500 : 400 })
  ),
  AR_ERROR_CODES: {
    ADMIN_RESOURCE_NOT_FOUND: 'not_found',
    VALIDATION_REQUIRED_FIELD: 'required',
    VALIDATION_INVALID_VALUE: 'invalid',
    INTERNAL_ERROR: 'internal',
  },
  getLogger: vi.fn(() => ({
    module: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  })),
  getTenantIdFromContext: vi.fn((c: { get?: (key: string) => unknown }) => c.get?.('tenantId')),
  safeFetchJson: mockSafeFetchJson,
  createDiagnosticLoggerFromContext: mockCreateDiagnosticLogger,
  getDiagnosticSessionId: vi.fn().mockReturnValue(undefined),
  DIAGNOSTIC_FLOW_ID_HEADER: 'X-Authrim-Diagnostic-Flow-Id',
  resolveAccountDataContextByIdentifier: mockResolveAccountContext,
}));

vi.mock('../services/provider-store', () => ({
  getProviderByIdOrSlug: mockGetProvider,
}));

vi.mock('../services/linked-identity-store', () => ({
  findLinkedIdentitiesByProviderSub: mockFindByProviderSub,
  updateLinkedIdentity: mockUpdateLinkedIdentity,
}));

vi.mock('jose', () => ({
  createLocalJWKSet: mockCreateLocalJwkSet,
  jwtVerify: mockJwtVerify,
}));

import {
  classifyBackchannelLogoutError,
  handleBackchannelLogout,
} from '../handlers/backchannel-logout';

describe('backchannel logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlTracker.reset();
    mockCoreQuery.mockReset().mockResolvedValue([{ id: 'sess-1' }]);
    mockCoreExecute.mockReset().mockResolvedValue({ rowsAffected: 1 });
    mockSessionFetch.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
    mockListExternalProviderSessions
      .mockReset()
      .mockResolvedValue([
        { sessionId: 'sess-1', userId: 'user-a', expiresAtMs: Date.now() + 60_000 },
      ]);
    mockSessionGet.mockReset().mockResolvedValue({
      id: 'sess-1',
      tenantId: 'tenant-a',
      userId: 'user-a',
      data: {
        external_provider_id: 'provider-google',
        external_provider_sub: 'provider-sub-123',
        external_provider_sid: 'provider-session-123',
      },
    });
    mockSessionInvalidate.mockReset().mockResolvedValue(true);
    mockSafeFetchJson.mockReset().mockResolvedValue({ keys: [] });
    mockFindByProviderSub.mockReset().mockResolvedValue([
      {
        id: 'link-1',
        tenantId: 'tenant-a',
      },
    ]);
    mockUpdateLinkedIdentity.mockReset().mockResolvedValue(true);
    mockGetProvider.mockReset().mockResolvedValue({
      id: 'provider-google',
      name: 'Google',
      issuer: 'https://accounts.google.com',
      clientId: 'client-123',
      jwksUri: 'https://accounts.google.com/jwks',
    });
    mockJwtVerify.mockReset().mockResolvedValue({
      payload: {
        iss: 'https://accounts.google.com',
        aud: 'client-123',
        iat: Math.floor(Date.now() / 1000),
        jti: 'logout-token-1',
        sub: 'provider-sub-123',
        events: {
          'http://schemas.openid.net/event/backchannel-logout': {},
        },
      },
    });
    mockDiagnosticTokenValidation.mockReset().mockResolvedValue(undefined);
    mockDiagnosticAuthDecision.mockReset().mockResolvedValue(undefined);
    mockDiagnosticCleanup.mockReset().mockResolvedValue(undefined);
    mockCreateDiagnosticLogger.mockReset().mockResolvedValue({
      logTokenValidation: mockDiagnosticTokenValidation,
      logAuthDecision: mockDiagnosticAuthDecision,
      cleanup: mockDiagnosticCleanup,
    });
    mockResolveAccountContext.mockReset().mockResolvedValue({
      accountId: 'account:user-a',
      legacyUserId: 'user-a',
      piiDb: { binding: 'pii-a' },
    });
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof fetch;
  });

  it('limits linked identity and session invalidation to the tenant in context', async () => {
    const contextStore = new Map<string, unknown>([['tenantId', 'tenant-a']]);
    const env = {
      DB: {},
      SETTINGS: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
    };
    const c = {
      req: {
        param: vi.fn(() => 'google'),
        query: vi.fn(() => undefined),
        header: vi.fn((name: string) =>
          name === 'Content-Type' ? 'application/x-www-form-urlencoded' : undefined
        ),
        parseBody: vi.fn().mockResolvedValue({
          logout_token: 'signed.logout.token',
        }),
      },
      env,
      get: vi.fn((key: string) => contextStore.get(key)),
      header: vi.fn(),
    };

    const response = await handleBackchannelLogout(c as never);

    expect(response.status).toBe(200);
    expect(mockFindByProviderSub).toHaveBeenCalledWith(
      env,
      'tenant-a',
      'provider-google',
      'provider-sub-123',
      { binding: 'pii-a' }
    );
    expect(mockListExternalProviderSessions).toHaveBeenCalledWith(env, {
      tenantId: 'tenant-a',
      providerId: 'provider-google',
      claimKind: 'sub',
      claim: 'provider-sub-123',
    });
    expect(mockSessionInvalidate).toHaveBeenCalledWith('sess-1');
    expect(mockDiagnosticTokenValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'logout-token-validation',
        result: 'pass',
        flowId: expect.any(String),
      })
    );
    expect(mockDiagnosticAuthDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'allow',
        reason: 'backchannel_logout_processed',
        flowId: expect.any(String),
      })
    );
    expect(mockDiagnosticCleanup).toHaveBeenCalledOnce();
    expect(mockJwtVerify).toHaveBeenCalledWith(
      'signed.logout.token',
      expect.anything(),
      expect.objectContaining({ algorithms: ['RS256'] })
    );
  });

  it('uses the external-subject routed PII shard for logout', async () => {
    const accountContext = {
      accountId: 'account:user-a',
      legacyUserId: 'user-a',
      piiDb: { binding: 'pii-a' },
    };
    mockResolveAccountContext.mockResolvedValue(accountContext);
    const contextStore = new Map<string, unknown>([['tenantId', 'tenant-a']]);
    const env = {
      DB: {},
      SETTINGS: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
    };
    const c = {
      req: {
        param: vi.fn(() => 'google'),
        query: vi.fn(() => undefined),
        header: vi.fn((name: string) =>
          name === 'Content-Type' ? 'application/x-www-form-urlencoded' : undefined
        ),
        parseBody: vi.fn().mockResolvedValue({ logout_token: 'signed.logout.token' }),
      },
      env,
      get: vi.fn((key: string) => contextStore.get(key)),
      header: vi.fn(),
    };

    const response = await handleBackchannelLogout(c as never);

    expect(response.status).toBe(200);
    expect(mockResolveAccountContext).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        tenantId: 'tenant-a',
        indexKind: 'external_subject',
        identifier: { issuer: 'provider-google', subject: 'provider-sub-123' },
      })
    );
    expect(mockFindByProviderSub).toHaveBeenCalledWith(
      env,
      'tenant-a',
      'provider-google',
      'provider-sub-123',
      accountContext.piiDb
    );
    expect(mockUpdateLinkedIdentity).toHaveBeenCalledWith(
      env,
      'tenant-a',
      'link-1',
      expect.anything(),
      accountContext.piiDb
    );
  });

  it('pins logout token verification to the provider configured ID Token algorithm', async () => {
    mockGetProvider.mockResolvedValueOnce({
      id: 'provider-google',
      name: 'Google',
      issuer: 'https://accounts.google.com',
      clientId: 'client-123',
      jwksUri: 'https://accounts.google.com/jwks',
      providerQuirks: { idTokenSignedResponseAlg: 'ES256' },
    });
    const contextStore = new Map<string, unknown>([['tenantId', 'tenant-a']]);
    const c = {
      req: {
        param: vi.fn(() => 'google'),
        header: vi.fn((name: string) =>
          name === 'Content-Type' ? 'application/x-www-form-urlencoded' : undefined
        ),
        parseBody: vi.fn().mockResolvedValue({ logout_token: 'signed.logout.token' }),
      },
      env: { SETTINGS: { get: vi.fn(), put: vi.fn() } },
      get: vi.fn((key: string) => contextStore.get(key)),
      header: vi.fn(),
    };

    const response = await handleBackchannelLogout(c as never);

    expect(response.status).toBe(200);
    expect(mockJwtVerify).toHaveBeenCalledWith(
      'signed.logout.token',
      expect.anything(),
      expect.objectContaining({ algorithms: ['ES256'] })
    );
  });

  it('terminates the session selected by a sid-only logout token', async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: {
        iss: 'https://accounts.google.com',
        aud: 'client-123',
        iat: Math.floor(Date.now() / 1000),
        jti: 'logout-token-sid-only',
        sid: 'provider-session-123',
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      },
    });
    const contextStore = new Map<string, unknown>([['tenantId', 'tenant-a']]);
    const c = {
      req: {
        param: vi.fn(() => 'google'),
        header: vi.fn((name: string) =>
          name === 'Content-Type' ? 'application/x-www-form-urlencoded' : undefined
        ),
        parseBody: vi.fn().mockResolvedValue({ logout_token: 'signed.logout.token' }),
      },
      env: { SETTINGS: { get: vi.fn(), put: vi.fn() } },
      get: vi.fn((key: string) => contextStore.get(key)),
      header: vi.fn(),
    };

    const response = await handleBackchannelLogout(c as never);

    expect(response.status).toBe(200);
    expect(mockListExternalProviderSessions).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      providerId: 'provider-google',
      claimKind: 'sid',
      claim: 'provider-session-123',
    });
    expect(mockFindByProviderSub).not.toHaveBeenCalled();
    expect(mockSessionInvalidate).toHaveBeenCalledOnce();
  });

  it('records a sanitized rejection reason for an invalid logout token', async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error('cryptographic internals must not be exported'));
    const contextStore = new Map<string, unknown>([['tenantId', 'tenant-a']]);
    const c = {
      req: {
        param: vi.fn(() => 'google'),
        header: vi.fn((name: string) =>
          name === 'Content-Type' ? 'application/x-www-form-urlencoded' : undefined
        ),
        parseBody: vi.fn().mockResolvedValue({ logout_token: 'invalid.logout.token' }),
      },
      env: {
        SETTINGS: {
          get: vi.fn().mockResolvedValue(null),
          put: vi.fn().mockResolvedValue(undefined),
        },
      },
      get: vi.fn((key: string) => contextStore.get(key)),
      header: vi.fn(),
    };

    const response = await handleBackchannelLogout(c as never);

    expect(response.status).toBe(400);
    expect(mockDiagnosticTokenValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'logout-token-validation',
        result: 'fail',
        errorMessage: 'signature_or_claim_validation_failed',
      })
    );
    expect(mockDiagnosticAuthDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'deny',
        reason: 'backchannel_logout_rejected',
        context: { validation_error: 'signature_or_claim_validation_failed' },
      })
    );
    expect(mockDiagnosticAuthDecision).not.toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          validation_error: 'cryptographic internals must not be exported',
        }),
      })
    );
    expect(mockDiagnosticCleanup).toHaveBeenCalledOnce();
  });

  it('does not fail logout when diagnostic logging initialization fails', async () => {
    mockCreateDiagnosticLogger.mockRejectedValueOnce(new Error('R2 unavailable'));
    const contextStore = new Map<string, unknown>([['tenantId', 'tenant-a']]);
    const c = {
      req: {
        param: vi.fn(() => 'google'),
        header: vi.fn((name: string) =>
          name === 'Content-Type' ? 'application/x-www-form-urlencoded' : undefined
        ),
        parseBody: vi.fn().mockResolvedValue({ logout_token: 'signed.logout.token' }),
      },
      env: {
        DB: {},
        SETTINGS: {
          get: vi.fn().mockResolvedValue(null),
          put: vi.fn().mockResolvedValue(undefined),
        },
      },
      get: vi.fn((key: string) => contextStore.get(key)),
      header: vi.fn(),
    };

    const response = await handleBackchannelLogout(c as never);

    expect(response.status).toBe(200);
    expect(mockFindByProviderSub).toHaveBeenCalled();
  });

  it('does not misclassify a post-validation storage failure as a token failure', async () => {
    mockSessionInvalidate.mockRejectedValueOnce(new Error('session store unavailable'));
    const contextStore = new Map<string, unknown>([['tenantId', 'tenant-a']]);
    const c = {
      req: {
        param: vi.fn(() => 'google'),
        header: vi.fn((name: string) =>
          name === 'Content-Type' ? 'application/x-www-form-urlencoded' : undefined
        ),
        parseBody: vi.fn().mockResolvedValue({ logout_token: 'signed.logout.token' }),
      },
      env: {
        SETTINGS: {
          get: vi.fn().mockResolvedValue(null),
          put: vi.fn().mockResolvedValue(undefined),
        },
      },
      get: vi.fn((key: string) => contextStore.get(key)),
      header: vi.fn(),
    };

    const response = await handleBackchannelLogout(c as never);

    expect(response.status).toBe(500);
    expect(mockDiagnosticTokenValidation).toHaveBeenCalledTimes(1);
    expect(mockDiagnosticTokenValidation).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'pass' })
    );
    expect(mockDiagnosticAuthDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'deny',
        context: { validation_error: 'session_invalidation_failed' },
      })
    );
    expect(mockDiagnosticCleanup).toHaveBeenCalledOnce();
  });
});

describe('backchannel logout diagnostic classification', () => {
  it('distinguishes the OIDF issuer, audience, algorithm, and signature failures', () => {
    expect(
      classifyBackchannelLogoutError({
        code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
        claim: 'iss',
      })
    ).toBe('issuer_mismatch');
    expect(
      classifyBackchannelLogoutError({
        code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
        claim: 'aud',
      })
    ).toBe('audience_mismatch');
    expect(classifyBackchannelLogoutError({ code: 'ERR_JOSE_ALG_NOT_ALLOWED' })).toBe(
      'unexpected_signing_algorithm'
    );
    expect(classifyBackchannelLogoutError({ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' })).toBe(
      'invalid_signature'
    );
  });

  it('uses stable safe codes for semantic logout token failures', () => {
    expect(
      classifyBackchannelLogoutError(new Error('Logout token missing backchannel-logout event'))
    ).toBe('missing_logout_event');
    expect(
      classifyBackchannelLogoutError(new Error('Logout token MUST NOT contain nonce claim'))
    ).toBe('nonce_present');
  });
});
