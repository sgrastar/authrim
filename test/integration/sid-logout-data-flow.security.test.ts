import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const securityRegressionIt =
  process.env.AUTHRIM_SECURITY_REGRESSION_SUITE === 'true' ? it : it.skip;

const TENANT_ID = 'default';
const ISSUER = 'https://op.example.com';
const CLIENT_ID = 'rp-client';
const REDIRECT_URI = 'https://rp.example.com/callback';
const RAW_SESSION_ID = 'g1:apac:0:session_0123456789abcdefghijkl';

type SessionClientRecord = {
  id: string;
  tenant_id: string;
  session_id: string;
  client_id: string;
  oidc_sid?: string;
  first_token_at: number;
  last_token_at: number;
  last_seen_at: number | null;
};

const testState = vi.hoisted(() => {
  const loggerMethods = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const logger = { module: vi.fn(() => loggerMethods) };

  const adapter = {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async () => ({ success: true, rowsAffected: 0 })),
    transaction: vi.fn(async (callback: (value: unknown) => unknown) => callback(adapter)),
    batch: vi.fn(async () => []),
    isHealthy: vi.fn(async () => ({ healthy: true, latencyMs: 0, type: 'mock' })),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => undefined),
  };

  const hydrateLogoutTargets = vi.fn(async (clients: SessionClientRecord[]) => ({
    backchannelClients: [],
    frontchannelClients: clients.map((client) => ({
      ...client,
      client_name: 'RP Client',
      backchannel_logout_uri: null,
      backchannel_logout_session_required: false,
      frontchannel_logout_uri: 'https://rp.example.com/frontchannel-logout',
      frontchannel_logout_session_required: true,
    })),
    webhookClients: [],
  }));

  return {
    logger,
    loggerMethods,
    adapter,
    hydrateLogoutTargets,
    validateIdTokenHint: vi.fn(),
    getSettingsAll: vi.fn(async (category: string) =>
      category === 'client'
        ? {
            values: { 'client.sso_enabled': true },
            sources: { 'client.sso_enabled': 'kv' },
          }
        : { values: {}, sources: {} }
    ),
    createAccessToken: vi.fn(async () => ({ token: 'access-token', jti: 'access-jti' })),
    createIDToken: vi.fn(async () => 'id-token'),
    createRefreshToken: vi.fn(async () => ({ token: 'refresh-token', jti: 'refresh-jti' })),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const mockClientMetadata = {
    client_id: 'rp-client',
    client_secret_hash: 'stored-client-secret-hash',
    redirect_uris: ['https://rp.example.com/callback'],
    grant_types: ['authorization_code', 'implicit'],
    response_types: ['code', 'id_token', 'code id_token'],
    scope: 'openid',
    token_endpoint_auth_method: 'client_secret_post',
    default_resource: 'https://api.example.com',
    tenant_id: 'default',
    frontchannel_logout_uri: 'https://rp.example.com/frontchannel-logout',
    frontchannel_logout_session_required: true,
  };
  const authContext = {
    tenantId: 'default',
    coreAdapter: testState.adapter,
    repositories: {
      client: { findByClientId: vi.fn(async () => mockClientMetadata) },
      sessionClient: {
        listLogoutCandidateClientIds: vi.fn(async () => [CLIENT_ID]),
        hydrateLogoutTargetsFromSessionClients: testState.hydrateLogoutTargets,
      },
    },
  };

  return {
    ...actual,
    getLogger: vi.fn(() => testState.logger),
    createLogger: vi.fn(() => testState.logger),
    getClient: vi.fn(async () => mockClientMetadata),
    getClientCached: vi.fn(async () => mockClientMetadata),
    loadTenantProfileCached: vi.fn(async () => ({ max_token_ttl_seconds: 3600 })),
    getSystemSettingsCached: vi.fn(async () => null),
    createSettingsManager: vi.fn(() => ({
      registerCategory: vi.fn(),
      getAll: testState.getSettingsAll,
    })),
    createOAuthConfigManager: vi.fn(() => ({
      isStateRequired: vi.fn(async () => false),
      getTokenExpiry: vi.fn(async () => 3600),
      getRefreshTokenExpiry: vi.fn(async () => 86400),
    })),
    createAuthContextFromHono: vi.fn(() => authContext),
    createAccountAuthContextFromHono: vi.fn(() => authContext),
    createPIIContextFromHono: vi.fn(() => ({
      coreAdapter: testState.adapter,
      defaultPiiAdapter: testState.adapter,
    })),
    resolveAccountDataContextFromHono: vi.fn(async () => ({
      tenantId: 'default',
      accountId: 'user-1',
      legacyUserId: 'user-1',
      coreDb: {},
      piiDb: {},
      coreBindingRef: 'DB',
      piiBindingRef: 'DB',
      coreResidencyPartition: 'default',
      piiResidencyPartition: 'default',
      accountRouteGeneration: 1,
      userCacheScope: { tenantId: TENANT_ID, accountRouteGeneration: 1 },
      piiCacheMode: 'disabled',
    })),
    resolveClientTrustPolicy: vi.fn(async () => ({
      first_party: true,
      trusted: true,
      skip_authorization_consent: true,
    })),
    resolveSignInConfirmationPolicy: vi.fn(async () => null),
    getCachedConsent: vi.fn(async () => ({
      id: 'consent-1',
      tenant_id: TENANT_ID,
      user_id: 'user-1',
      client_id: CLIENT_ID,
      scope: 'openid',
      granted_at: Date.now(),
      expires_at: null,
    })),
    getShardCount: vi.fn(async () => 1),
    verifyClientSecretHash: vi.fn(async () => true),
    generateRegionAwareJti: vi.fn(async () => ({ jti: 'g1:apac:0:jti_access' })),
    createAccessToken: testState.createAccessToken,
    calculateAtHash: vi.fn(async () => 'access-token-hash'),
    createIDToken: testState.createIDToken,
    createRefreshToken: testState.createRefreshToken,
    ensureAccountAuthenticationState: vi.fn(async () => undefined),
    findCanonicalAccountAuthenticationState: vi.fn(async () => ({
      userId: 'user-1',
      accountType: 'user',
      lifecycle: 'active',
      sourceVersionMs: 1,
    })),
    CanonicalIdentityRepository: vi.fn(function CanonicalIdentityRepositoryMock() {
      return {
        findAccountByLegacyUserId: vi.fn(async () => ({
          id: 'user-1',
          account_type: 'user',
          active: 1,
        })),
      };
    }),
    CanonicalRuntimeUserProjectionRepository: vi.fn(
      function CanonicalRuntimeUserProjectionRepositoryMock() {
        return { findByLegacyUserId: vi.fn(async () => null) };
      }
    ),
    CanonicalSensitiveValueResolver: vi.fn(function CanonicalSensitiveValueResolverMock() {
      return {};
    }),
    getAccessTokenRBACClaims: vi.fn(async () => ({})),
    getIDTokenRBACClaims: vi.fn(async () => ({})),
    isPolicyEmbeddingEnabled: vi.fn(async () => false),
    isIdLevelPermissionsEnabled: vi.fn(async () => false),
    isCustomClaimsEnabled: vi.fn(async () => false),
    isNativeSSOEnabled: vi.fn(async () => false),
    loadFeatureConfig: vi.fn(async () => ({ enabled: false })),
    applyOIDCIdentityMapping: vi.fn(async (input: { claims: Record<string, unknown> }) => ({
      claims: input.claims,
      binding: null,
    })),
    enforceOIDCAttributeReleaseConsent: vi.fn(async () => ({
      action: 'release',
      claimSetHash: null,
      reasonCodes: [],
    })),
    publishEvent: vi.fn(async () => undefined),
    validateIdTokenHint: testState.validateIdTokenHint,
  };
});

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    importPKCS8: vi.fn(async () => ({
      type: 'private',
      algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    })),
  };
});

import { resolveLogoutTargetsFromSessionClientStore } from '@authrim/ar-lib-core';
import { authorizeHandler } from '../../packages/ar-auth/src/authorize';
import { frontChannelLogoutHandler } from '../../packages/ar-auth/src/logout';
import { tokenHandler } from '../../packages/ar-token/src/token';

class MemoryKV {
  private readonly values = new Map<string, string>();

  async get<T = string>(key: string, options?: { type?: string }): Promise<T | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return (options?.type === 'json' ? JSON.parse(value) : value) as T;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function createDurableObjectId(name: string): DurableObjectId {
  return {
    name,
    toString: () => name,
    equals: (other: DurableObjectId) => other.toString() === name,
  } as DurableObjectId;
}

function createSessionClientNamespace() {
  const recordsByStoreName = new Map<string, Map<string, SessionClientRecord>>();
  const sessionIdByAliasStoreName = new Map<string, string>();
  const listSessionIds: string[] = [];
  const registerSessionIds: string[] = [];

  return {
    idFromName: vi.fn((name: string) => createDurableObjectId(name)),
    get: vi.fn((id: DurableObjectId) => {
      const storeName = id.toString();
      return {
        registerClientRpc: vi.fn(
          async (input: {
            tenantId: string;
            sessionId: string;
            clientId: string;
            oidcSid?: string;
          }) => {
            registerSessionIds.push(input.sessionId);
            let records = recordsByStoreName.get(storeName);
            if (!records) {
              records = new Map();
              recordsByStoreName.set(storeName, records);
            }
            const now = Date.now();
            const record: SessionClientRecord = {
              id: `${input.sessionId}:${input.clientId}`,
              tenant_id: input.tenantId,
              session_id: input.sessionId,
              client_id: input.clientId,
              oidc_sid: input.oidcSid,
              first_token_at: now,
              last_token_at: now,
              last_seen_at: now,
            };
            records.set(input.clientId, record);
            return record;
          }
        ),
        listClientsRpc: vi.fn(async (input: { sessionId: string }) => {
          listSessionIds.push(input.sessionId);
          return [...(recordsByStoreName.get(storeName)?.values() ?? [])];
        }),
        registerOidcSidAliasRpc: vi.fn(async (input: { sessionId: string }) => {
          sessionIdByAliasStoreName.set(storeName, input.sessionId);
        }),
        resolveOidcSidAliasRpc: vi.fn(async () => sessionIdByAliasStoreName.get(storeName) ?? null),
      };
    }),
    _recordsByStoreName: recordsByStoreName,
    _listSessionIds: listSessionIds,
    _registerSessionIds: registerSessionIds,
    _sessionIdByAliasStoreName: sessionIdByAliasStoreName,
  };
}

function createSessionStore() {
  const sessions = new Map<string, Record<string, unknown>>();
  const invalidateSessionRpc = vi.fn(async (sessionId: string) => sessions.delete(sessionId));
  const stub = {
    getSessionRpc: vi.fn(async (sessionId: string) => sessions.get(sessionId) ?? null),
    invalidateSessionRpc,
  };

  return {
    idFromName: vi.fn((name: string) => createDurableObjectId(name)),
    get: vi.fn(() => stub),
    _sessions: sessions,
    _invalidateSessionRpc: invalidateSessionRpc,
  };
}

type StoredAuthorizationCode = {
  code: string;
  tenantId: string;
  clientId: string;
  redirectUri: string;
  userId: string;
  scope: string;
  nonce?: string;
  state?: string;
  authTime?: number;
  acr?: string;
  amr?: string[];
  sid?: string;
  sessionId?: string;
};

function createAuthorizationCodeStore() {
  const codes = new Map<string, StoredAuthorizationCode>();
  const storeCodeRpc = vi.fn(async (input: StoredAuthorizationCode) => {
    codes.set(input.code, input);
    return { success: true };
  });
  const consumeCodeRpc = vi.fn(async (input: { code: string }) => {
    const code = codes.get(input.code);
    if (!code) throw new Error('Code not found');
    codes.delete(input.code);
    return code;
  });
  const stub = {
    storeCodeRpc,
    consumeCodeRpc,
    registerIssuedTokensRpc: vi.fn(async () => true),
  };

  return {
    idFromName: vi.fn((name: string) => createDurableObjectId(name)),
    get: vi.fn(() => stub),
    _codes: codes,
    _storeCodeRpc: storeCodeRpc,
  };
}

function createKeyManager() {
  const stub = {
    getActiveKeyWithPrivateRpc: vi.fn(async () => ({
      kid: 'test-signing-key',
      privatePEM: 'test-private-key',
    })),
    getActiveOIDCSigningKeyWithPrivateRpc: vi.fn(async () => ({
      kid: 'test-signing-key',
      privatePEM: 'test-private-key',
    })),
    rotateKeysWithPrivateRpc: vi.fn(async () => ({
      kid: 'test-signing-key',
      privatePEM: 'test-private-key',
    })),
    getAllPublicKeysRpc: vi.fn(async () => []),
  };
  return {
    idFromName: vi.fn((name: string) => createDurableObjectId(name)),
    get: vi.fn(() => stub),
  };
}

function createGenericNamespace() {
  const stub = {
    storeChallengeRpc: vi.fn(async () => ({ success: true })),
    getChallengeRpc: vi.fn(async () => null),
    consumeChallengeRpc: vi.fn(async () => {
      throw new Error('Challenge not found');
    }),
    fetch: vi.fn(async () => new Response('{}')),
  };
  return {
    idFromName: vi.fn((name: string) => createDurableObjectId(name)),
    get: vi.fn(() => stub),
  };
}

function createD1(): D1Database {
  const createStatement = () => {
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [], success: true })),
      run: vi.fn(async () => ({ success: true, meta: { changes: 0 } })),
      raw: vi.fn(async () => []),
    };
    return statement;
  };
  return {
    prepare: vi.fn(() => createStatement()),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
    dump: vi.fn(async () => new ArrayBuffer(0)),
  } as unknown as D1Database;
}

type SecurityTestEnv = Env & {
  SESSION_CLIENT_STORE: ReturnType<typeof createSessionClientNamespace>;
  SESSION_STORE: ReturnType<typeof createSessionStore>;
  AUTH_CODE_STORE: ReturnType<typeof createAuthorizationCodeStore>;
};

function createEnv(): SecurityTestEnv {
  const settings = new MemoryKV();
  const authrimConfig = new MemoryKV();
  const sessionClientStore = createSessionClientNamespace();
  const sessionStore = createSessionStore();
  const authCodeStore = createAuthorizationCodeStore();

  return {
    ISSUER_URL: ISSUER,
    UI_URL: ISSUER,
    ENABLE_CONFORMANCE_MODE: 'false',
    ACCESS_TOKEN_EXPIRY: '3600',
    REFRESH_TOKEN_EXPIRY: '86400',
    AUTHRIM_CONFIG: authrimConfig as unknown as KVNamespace,
    SETTINGS: settings as unknown as KVNamespace,
    CLIENTS_CACHE: new MemoryKV() as unknown as KVNamespace,
    STATE_STORE: new MemoryKV() as unknown as KVNamespace,
    NONCE_STORE: new MemoryKV() as unknown as KVNamespace,
    DB: createD1(),
    KEY_MANAGER: createKeyManager(),
    AUTH_CODE_STORE: authCodeStore,
    SESSION_STORE: sessionStore,
    SESSION_CLIENT_STORE: sessionClientStore,
    CHALLENGE_STORE: createGenericNamespace(),
    PAR_REQUEST_STORE: createGenericNamespace(),
    TOKEN_REVOCATION_STORE: createGenericNamespace(),
    DPOP_JTI_STORE: createGenericNamespace(),
  } as unknown as SecurityTestEnv;
}

function seedBrowserSession(env: SecurityTestEnv): void {
  env.SESSION_STORE._sessions.set(RAW_SESSION_ID, {
    id: RAW_SESSION_ID,
    userId: 'user-1',
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 3_600_000,
    data: { authTime: Math.floor(Date.now() / 1000) - 60 },
  });
}

function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, TENANT_ID as never);
    c.set(
      'tenantMetadataContext' as never,
      {
        tenantId: 'default',
        coreDb: c.env.DB,
        route: {
          tenantId: TENANT_ID,
          dataRole: 'core',
          bindingRef: 'DB',
          residencyPartition: 'default',
          generation: 1,
        },
      } as never
    );
    await next();
  });
  app.get('/authorize', authorizeHandler);
  app.post('/token', tokenHandler);
  app.get('/logout', frontChannelLogoutHandler);
  app.post('/logout', frontChannelLogoutHandler);
  return app;
}

function createExecutionContext(): {
  executionCtx: ExecutionContext;
  drain: () => Promise<PromiseSettledResult<unknown>[]>;
} {
  const pending: Promise<unknown>[] = [];
  return {
    executionCtx: {
      waitUntil: vi.fn((promise: Promise<unknown>) => pending.push(promise)),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

async function deriveExpectedSid(): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${ISSUER}\u0000${CLIENT_ID}\u0000${RAW_SESSION_ID}`)
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function seedLegacySessionClient(env: SecurityTestEnv, sessionId: string, oidcSid?: string): void {
  env.SESSION_CLIENT_STORE._recordsByStoreName.set(
    `${TENANT_ID}:${sessionId}`,
    new Map([
      [
        CLIENT_ID,
        {
          id: `${sessionId}:${CLIENT_ID}`,
          tenant_id: TENANT_ID,
          session_id: sessionId,
          client_id: CLIENT_ID,
          ...(oidcSid ? { oidc_sid: oidcSid } : {}),
          first_token_at: Date.now() - 60_000,
          last_token_at: Date.now() - 60_000,
          last_seen_at: null,
        },
      ],
    ])
  );
}

async function authorizeAndExchangeCode(
  app: Hono<{ Bindings: Env }>,
  env: SecurityTestEnv
): Promise<{ code: string; derivedSid: string }> {
  const authorizeExecution = createExecutionContext();
  const authorizeResponse = await app.request(
    `${ISSUER}/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=openid&state=state-1`,
    { headers: { Cookie: `authrim_session=${RAW_SESSION_ID}` } },
    env,
    authorizeExecution.executionCtx
  );
  await authorizeExecution.drain();
  expect(authorizeResponse.status).toBe(302);
  const authorizeLocation = authorizeResponse.headers.get('Location');
  expect(authorizeLocation).toBeTruthy();
  const authorizeRedirect = new URL(authorizeLocation!);
  const code = authorizeRedirect.searchParams.get('code');
  expect(
    code,
    `${authorizeLocation}\n${JSON.stringify(testState.loggerMethods.info.mock.calls)}\n${JSON.stringify(testState.loggerMethods.debug.mock.calls)}\n${JSON.stringify(testState.getSettingsAll.mock.calls)}`
  ).toBeTruthy();

  const storedCode = env.AUTH_CODE_STORE._codes.get(code!);
  const derivedSid = await deriveExpectedSid();
  expect(storedCode?.sid).toBe(derivedSid);
  expect(derivedSid).not.toBe(RAW_SESSION_ID);

  const tokenExecution = createExecutionContext();
  const tokenResponse = await app.request(
    `${ISSUER}/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        client_id: CLIENT_ID,
        client_secret: 'client-secret',
        redirect_uri: REDIRECT_URI,
      }),
    },
    env,
    tokenExecution.executionCtx
  );
  await tokenExecution.drain();
  const tokenBody = await tokenResponse.clone().text();
  expect(tokenResponse.status, tokenBody).toBe(200);
  await Promise.resolve();

  return { code: code!, derivedSid };
}

describe('OIDC sid / internal session ID security boundary', () => {
  let app: Hono<{ Bindings: Env }>;
  let env: SecurityTestEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    testState.validateIdTokenHint.mockResolvedValue({ valid: false });
    app = createApp();
    env = createEnv();
    seedBrowserSession(env);
  });

  securityRegressionIt(
    '[security regression][AO-10] preserves code-flow logout linkage and emits the RP-facing sid',
    async () => {
      const { derivedSid } = await authorizeAndExchangeCode(app, env);

      expect(env.SESSION_CLIENT_STORE._registerSessionIds).toEqual([RAW_SESSION_ID]);
      const browserSessionTargets = await resolveLogoutTargetsFromSessionClientStore(
        env,
        TENANT_ID,
        RAW_SESSION_ID,
        {
          hydrateLogoutTargetsFromSessionClients: testState.hydrateLogoutTargets,
        } as never,
        ISSUER
      );
      expect(browserSessionTargets?.frontchannelClients).toHaveLength(1);

      testState.validateIdTokenHint.mockResolvedValue({
        valid: true,
        userId: 'user-1',
        clientId: CLIENT_ID,
        sid: derivedSid,
      });
      const browserExecution = createExecutionContext();
      const browserLogout = await app.request(
        `${ISSUER}/logout`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: `authrim_session=${RAW_SESSION_ID}; authrim_logout_confirmation=confirm-1`,
          },
          body: new URLSearchParams({
            confirmation_token: 'confirm-1',
            id_token_hint: 'id-token',
          }),
        },
        env,
        browserExecution.executionCtx
      );
      await browserExecution.drain();
      const html = await browserLogout.text();

      expect(browserLogout.status).toBe(200);
      expect(env.SESSION_STORE._invalidateSessionRpc).toHaveBeenCalledWith(RAW_SESSION_ID);
      expect(html).toContain('https://rp.example.com/frontchannel-logout');
      expect(html).toContain(`sid=${encodeURIComponent(derivedSid)}`);
      expect(html).not.toContain(`sid=${encodeURIComponent(RAW_SESSION_ID)}`);
    }
  );

  securityRegressionIt(
    '[security regression][AO-10] never exposes the raw session ID in hybrid frontchannel logout',
    async () => {
      const derivedSid = await deriveExpectedSid();
      const authorizeExecution = createExecutionContext();
      const authorizeResponse = await app.request(
        `${ISSUER}/authorize?response_type=${encodeURIComponent('code id_token')}&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=openid&state=state-1&nonce=nonce-1`,
        { headers: { Cookie: `authrim_session=${RAW_SESSION_ID}` } },
        env,
        authorizeExecution.executionCtx
      );
      await authorizeExecution.drain();

      expect(authorizeResponse.status).toBe(302);
      expect(env.SESSION_CLIENT_STORE._registerSessionIds).toEqual([RAW_SESSION_ID]);
      expect(testState.createIDToken.mock.calls[0]?.[0]).toMatchObject({ sid: derivedSid });

      const execution = createExecutionContext();
      const response = await app.request(
        `${ISSUER}/logout`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: `authrim_session=${RAW_SESSION_ID}; authrim_logout_confirmation=confirm-2`,
          },
          body: new URLSearchParams({ confirmation_token: 'confirm-2' }),
        },
        env,
        execution.executionCtx
      );
      await execution.drain();
      const html = await response.text();

      expect(
        response.status,
        `${html}\n${testState.loggerMethods.error.mock.calls
          .map((call) =>
            call
              .map((value) =>
                value instanceof Error
                  ? `${value.message}\n${value.stack ?? ''}`
                  : JSON.stringify(value)
              )
              .join(' | ')
          )
          .join('\n')}\n${JSON.stringify(testState.loggerMethods.warn.mock.calls)}`
      ).toBe(200);
      expect(html).toContain('https://rp.example.com/frontchannel-logout');
      expect(html).toContain(`sid=${encodeURIComponent(derivedSid)}`);
      expect(html).not.toContain(`sid=${encodeURIComponent(RAW_SESSION_ID)}`);
    }
  );

  securityRegressionIt(
    '[security regression][AO-10] resolves a validated RP sid without a browser cookie',
    async () => {
      const { derivedSid } = await authorizeAndExchangeCode(app, env);
      testState.validateIdTokenHint.mockResolvedValue({
        valid: true,
        userId: 'user-1',
        clientId: CLIENT_ID,
        sid: derivedSid,
      });

      const execution = createExecutionContext();
      const response = await app.request(
        `${ISSUER}/logout`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: 'authrim_logout_confirmation=confirm-3',
          },
          body: new URLSearchParams({
            confirmation_token: 'confirm-3',
            id_token_hint: 'id-token',
          }),
        },
        env,
        execution.executionCtx
      );
      await execution.drain();
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(env.SESSION_STORE._invalidateSessionRpc).toHaveBeenCalledWith(RAW_SESSION_ID);
      expect(html).toContain(`sid=${encodeURIComponent(derivedSid)}`);
      expect(html).not.toContain(`sid=${encodeURIComponent(RAW_SESSION_ID)}`);
    }
  );

  securityRegressionIt(
    '[security regression][AO-19] read-repairs a predeployment hybrid association',
    async () => {
      const derivedSid = await deriveExpectedSid();
      seedLegacySessionClient(env, RAW_SESSION_ID);

      const execution = createExecutionContext();
      const response = await app.request(
        `${ISSUER}/logout`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: `authrim_session=${RAW_SESSION_ID}; authrim_logout_confirmation=legacy-hybrid`,
          },
          body: new URLSearchParams({ confirmation_token: 'legacy-hybrid' }),
        },
        env,
        execution.executionCtx
      );
      await execution.drain();
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain(`sid=${encodeURIComponent(derivedSid)}`);
      expect(html).not.toContain(`sid=${encodeURIComponent(RAW_SESSION_ID)}`);
      expect(
        env.SESSION_CLIENT_STORE._sessionIdByAliasStoreName.get(
          `${TENANT_ID}:oidc-sid:${derivedSid}`
        )
      ).toBe(RAW_SESSION_ID);
    }
  );

  securityRegressionIt(
    '[security regression][AO-19] discovers a predeployment code-flow association on cookie logout',
    async () => {
      const derivedSid = await deriveExpectedSid();
      seedLegacySessionClient(env, derivedSid);

      const execution = createExecutionContext();
      const response = await app.request(
        `${ISSUER}/logout`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: `authrim_session=${RAW_SESSION_ID}; authrim_logout_confirmation=legacy-code`,
          },
          body: new URLSearchParams({ confirmation_token: 'legacy-code' }),
        },
        env,
        execution.executionCtx
      );
      await execution.drain();
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(env.SESSION_STORE._invalidateSessionRpc).toHaveBeenCalledWith(RAW_SESSION_ID);
      expect(html).toContain(`sid=${encodeURIComponent(derivedSid)}`);
      expect(html).not.toContain(`sid=${encodeURIComponent(RAW_SESSION_ID)}`);
      expect(env.SESSION_CLIENT_STORE._registerSessionIds).toContain(RAW_SESSION_ID);
    }
  );

  securityRegressionIt(
    '[security regression][AO-19] recovers the RP target from a validated hint without a cookie',
    async () => {
      const derivedSid = await deriveExpectedSid();
      seedLegacySessionClient(env, derivedSid);
      testState.validateIdTokenHint.mockResolvedValue({
        valid: true,
        userId: 'user-1',
        clientId: CLIENT_ID,
        sid: derivedSid,
      });

      const execution = createExecutionContext();
      const response = await app.request(
        `${ISSUER}/logout`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: 'authrim_logout_confirmation=legacy-hint',
          },
          body: new URLSearchParams({
            confirmation_token: 'legacy-hint',
            id_token_hint: 'legacy-id-token',
          }),
        },
        env,
        execution.executionCtx
      );
      await execution.drain();
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain(`sid=${encodeURIComponent(derivedSid)}`);
      expect(html).not.toContain(`sid=${encodeURIComponent(RAW_SESSION_ID)}`);
    }
  );
});
