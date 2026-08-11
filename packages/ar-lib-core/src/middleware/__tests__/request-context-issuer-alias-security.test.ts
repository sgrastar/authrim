import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { AuthorizationCodeStore } from '../../durable-objects/AuthorizationCodeStore';
import { PARRequestStore } from '../../durable-objects/PARRequestStore';
import type { Env } from '../../types/env';
import { buildRequestIssuerUrl } from '../../utils/issuer';
import { getTenantIdFromContext, requestContextMiddleware } from '../request-context';

const securityRegressionIt =
  process.env.AUTHRIM_SECURITY_REGRESSION_SUITE === 'true' ? it : it.skip;

const runtimeMocks = vi.hoisted(() => ({
  resolveTenantMetadata: vi.fn(),
}));

const vanityMocks = vi.hoisted(() => ({
  getPrimaryTenantVanityDomain: vi.fn(),
  resolveTenantFromVanityHost: vi.fn(),
}));

vi.mock('../../services/runtime-data-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/runtime-data-context')>()),
  resolveTenantMetadataContext: runtimeMocks.resolveTenantMetadata,
}));

vi.mock('../../services/tenant-vanity-domain-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/tenant-vanity-domain-resolver')>()),
  getPrimaryTenantVanityDomain: vanityMocks.getPrimaryTenantVanityDomain,
  resolveTenantFromVanityHost: vanityMocks.resolveTenantFromVanityHost,
}));

class MockDurableObjectState implements Partial<DurableObjectState> {
  private readonly values = new Map<string, unknown>();
  private blockedInitialization: Promise<unknown> = Promise.resolve();
  id!: DurableObjectId;
  storage: DurableObjectStorage;

  constructor() {
    this.storage = {
      get: <T>(key: string): Promise<T | undefined> =>
        Promise.resolve(this.values.get(key) as T | undefined),
      put: (keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> => {
        if (typeof keyOrEntries === 'string') {
          this.values.set(keyOrEntries, value);
        } else {
          for (const [key, entry] of Object.entries(keyOrEntries)) {
            this.values.set(key, entry);
          }
        }
        return Promise.resolve();
      },
      delete: (keyOrKeys: string | string[]): Promise<boolean | number> => {
        if (typeof keyOrKeys === 'string') {
          return Promise.resolve(this.values.delete(keyOrKeys));
        }
        let deleted = 0;
        for (const key of keyOrKeys) {
          if (this.values.delete(key)) deleted += 1;
        }
        return Promise.resolve(deleted);
      },
      deleteAll: (): Promise<void> => {
        this.values.clear();
        return Promise.resolve();
      },
      list: <T>(): Promise<Map<string, T>> =>
        Promise.resolve(new Map(this.values as Map<string, T>)),
      transaction: <T>(closure: (txn: DurableObjectStorage) => Promise<T>): Promise<T> =>
        closure(this.storage),
      getAlarm: (): Promise<number | null> => Promise.resolve(null),
      setAlarm: (): Promise<void> => Promise.resolve(),
      deleteAlarm: (): Promise<void> => Promise.resolve(),
      sync: (): Promise<void> => Promise.resolve(),
      transactionSync: <T>(closure: () => T): T => closure(),
      sql: {} as SqlStorage,
      kv: {} as KVNamespace,
      getCurrentBookmark: (): string => '',
      getBookmarkForTime: (): string => '',
      onNextSessionRestoreBookmark: (): void => {},
    } as unknown as DurableObjectStorage;
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const result = callback();
    this.blockedInitialization = result;
    return result;
  }

  waitUntil(): void {
    // No-op for the in-process test actor.
  }

  async waitForBlockedInitialization(): Promise<void> {
    await this.blockedInitialization;
  }
}

function createMockKV(valuesByKey: Record<string, string | null>): KVNamespace {
  return {
    get: vi.fn(async (key: string) => valuesByKey[key] ?? null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace;
}

function issuerForRequest(c: Parameters<typeof getTenantIdFromContext>[0]): string {
  return buildRequestIssuerUrl(c.req.raw, c.env, getTenantIdFromContext(c));
}

describe('issuer alias authorization record boundary', () => {
  const baseDomain = 'authrim.test';
  const tenantId = 'sample';
  const primaryHost = 'login.sample.example.test';
  const aliasHost = 'signin.sample.example.test';
  const tenantSubdomain = `${tenantId}.${baseDomain}`;
  const clientId = 'oidc-client';
  const redirectUri = 'https://client.example.test/callback';
  const requestUri = 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_issuer_alias_poc';
  const code = 'issuer-alias-code';
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  let codeState: MockDurableObjectState;
  let codeStore: AuthorizationCodeStore;
  let parStore: PARRequestStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    vi.clearAllMocks();

    runtimeMocks.resolveTenantMetadata.mockImplementation(async (env: Env, resolved: string) => ({
      tenantId: resolved,
      coreDb: env.DB,
      route: {},
    }));
    vanityMocks.resolveTenantFromVanityHost.mockImplementation(async (_env: Env, host: string) =>
      host === primaryHost || host === aliasHost ? tenantId : null
    );
    vanityMocks.getPrimaryTenantVanityDomain.mockResolvedValue({
      id: 'primary-vanity',
      tenant_id: tenantId,
      hostname: primaryHost,
      is_active: true,
      is_primary: true,
      status: 'active',
      cloudflare_zone_id: null,
      cloudflare_custom_hostname_id: null,
      ssl_status: 'active',
      ownership_status: 'verified',
      validation_method: null,
      validation_records_json: null,
      last_sync_at: null,
      created_by: 'test',
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    codeState = new MockDurableObjectState();
    codeStore = new AuthorizationCodeStore(codeState as unknown as DurableObjectState, {} as Env);
    await codeState.waitForBlockedInitialization();
    parStore = new PARRequestStore(new MockDurableObjectState() as DurableObjectState, {} as Env);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildEnv(options: { includeAlias: boolean }): Env {
    const allowedDomains = options.includeAlias ? `${primaryHost},${aliasHost}` : primaryHost;
    const allowedIdentifiers = options.includeAlias
      ? `https://${primaryHost},https://${aliasHost}`
      : `https://${primaryHost}`;

    return {
      BASE_DOMAIN: baseDomain,
      AUTHRIM_CONFIG: createMockKV({
        [`v1:tenant-exists:${tenantId}`]: 'true',
        [`settings:tenant:${tenantId}:tenant`]: JSON.stringify({
          'tenant.allowed_domains': allowedDomains,
          'tenant.allowed_identifiers': allowedIdentifiers,
        }),
      }),
    } as Env;
  }

  function buildApp(): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', requestContextMiddleware());

    app.post('/par', async (c) => {
      await parStore.storeRequestRpc({
        requestUri,
        data: {
          tenant_id: getTenantIdFromContext(c),
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: 'openid',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        },
        ttl: 60,
      });
      return c.json({ request_uri: requestUri, issuer: issuerForRequest(c) }, 201);
    });

    app.get('/authorize', async (c) => {
      const pushed = await parStore.consumeRequestRpc({
        requestUri: c.req.query('request_uri') ?? '',
        tenant_id: getTenantIdFromContext(c),
        client_id: clientId,
        expected_authorization_server: 'default',
      });
      await codeStore.storeCodeRpc({
        code,
        tenantId: getTenantIdFromContext(c),
        clientId,
        redirectUri: pushed.redirect_uri,
        userId: 'user-1',
        scope: pushed.scope,
        codeChallenge: pushed.code_challenge,
        codeChallengeMethod: 'S256',
      });
      return c.json({ code, issuer: issuerForRequest(c) });
    });

    app.post('/token', async (c) => {
      const consumed = await codeStore.consumeCodeRpc({
        code,
        tenantId: getTenantIdFromContext(c),
        clientId,
        codeVerifier: verifier,
        expectedAuthorizationServer: 'default',
        expectedSubjectType: 'end_user',
      });
      return c.json({ user_id: consumed.userId, issuer: issuerForRequest(c) });
    });

    return app;
  }

  securityRegressionIt(
    '[security regression][AO-12] prevents PAR and code use across distinct issuer hosts',
    async () => {
      const env = buildEnv({ includeAlias: true });
      const app = buildApp();

      const pushedResponse = await app.request(
        new Request(`https://${primaryHost}/par`, {
          method: 'POST',
          headers: { Host: primaryHost, 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
        undefined,
        env
      );
      expect(pushedResponse.status).toBe(201);
      await expect(pushedResponse.json()).resolves.toMatchObject({
        request_uri: requestUri,
        issuer: `https://${primaryHost}`,
      });

      const authorizationResponse = await app.request(
        new Request(
          `https://${aliasHost}/authorize?request_uri=${encodeURIComponent(requestUri)}`,
          {
            headers: { Host: aliasHost, Accept: 'text/html' },
          }
        ),
        undefined,
        env
      );
      expect([302, 308, 400, 404]).toContain(authorizationResponse.status);
      if (authorizationResponse.status === 302 || authorizationResponse.status === 308) {
        const location = authorizationResponse.headers.get('Location');
        expect(location).toBeTruthy();
        expect(new URL(location!).origin).toBe(`https://${primaryHost}`);
      }
      expect(await codeState.storage.get(`code:${code}`)).toBeUndefined();
    }
  );

  it('negative control: rejects a resolved non-primary alias that is not explicitly allowed', async () => {
    const env = buildEnv({ includeAlias: false });
    const app = buildApp();
    const consumeSpy = vi.spyOn(parStore, 'consumeRequestRpc');

    const response = await app.request(
      new Request(`https://${aliasHost}/authorize?request_uri=${encodeURIComponent(requestUri)}`, {
        headers: { Host: aliasHost, Accept: 'text/html' },
      }),
      undefined,
      env
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'not_found',
      error_description: 'Tenant not found',
    });
    expect(vanityMocks.resolveTenantFromVanityHost).toHaveBeenCalledWith(env, aliasHost);
    expect(consumeSpy).not.toHaveBeenCalled();
  });

  it('negative control: canonicalizes browser traffic and rejects protocol traffic on the old tenant subdomain', async () => {
    const env = buildEnv({ includeAlias: true });
    const app = buildApp();

    const browserResponse = await app.request(
      new Request(`https://${tenantSubdomain}/authorize?client_id=${clientId}`, {
        headers: { Host: tenantSubdomain, Accept: 'text/html' },
      }),
      undefined,
      env
    );
    expect(browserResponse.status).toBe(308);
    expect(browserResponse.headers.get('location')).toBe(
      `https://${primaryHost}/authorize?client_id=${clientId}`
    );

    const protocolResponse = await app.request(
      new Request(`https://${tenantSubdomain}/token`, {
        method: 'POST',
        headers: { Host: tenantSubdomain, Accept: 'application/json' },
      }),
      undefined,
      env
    );
    expect(protocolResponse.status).toBe(404);
    await expect(protocolResponse.json()).resolves.toEqual({
      error: 'not_found',
      error_description: 'Tenant not found',
    });
  });
});
