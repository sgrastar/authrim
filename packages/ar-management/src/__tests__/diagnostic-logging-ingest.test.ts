import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { hashClientSecret, type Env, type OAuthClient } from '@authrim/ar-lib-core';

// The client lookup goes through the persistence adapter; the tests hand it the env's mock.
const mocks = vi.hoisted(() => ({ emitRuntimeLogRecords: vi.fn(async () => undefined) }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    DiagnosticLogR2Adapter: class {
      private readonly store: Map<string, string>;
      constructor(config: { env: { LOG_ARCHIVE: { store: Map<string, string> } } }) {
        this.store = config.env.LOG_ARCHIVE.store;
      }
      async writeLogBatch(entries: Array<{ id: string }>) {
        for (const entry of entries) this.store.set(entry.id, JSON.stringify(entry));
        return { success: true, entriesWritten: entries.length };
      }
    },
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async (env: { DB: unknown }) => env.DB),
    emitRuntimeLogRecords: mocks.emitRuntimeLogRecords,
  };
});

import ingestApp from '../routes/diagnostic-logging/ingest';

class MockR2Bucket {
  readonly store = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async get(key: string): Promise<{ text: () => Promise<string> } | null> {
    const value = this.store.get(key);
    return value === undefined ? null : { text: async () => value };
  }

  async list(): Promise<{ objects: Array<{ key: string }>; truncated: boolean }> {
    return {
      objects: Array.from(this.store.keys()).map((key) => ({ key })),
      truncated: false,
    };
  }
}

function createClient(overrides: Partial<OAuthClient> = {}): OAuthClient {
  const now = Date.now();
  return {
    client_id: 'diag-client',
    client_secret_hash: null,
    client_name: 'Diagnostic Client',
    description: null,
    tenant_id: 'tenant-1',
    application_type: 'web',
    trust_group: null,
    trust_group_id: null,
    browser_public_client_mode: null,
    browser_refresh_token_policy: 'disabled',
    native_sso_enabled: null,
    native_channel_allowed: null,
    allowed_channels: null,
    device_secret_revoke_enabled: null,
    device_secret_revoke_trust_groups: null,
    device_secret_introspection_enabled: null,
    device_secret_introspection_trust_groups: null,
    redirect_uris: '[]',
    grant_types: '["authorization_code"]',
    response_types: '["code"]',
    scope: null,
    logo_uri: null,
    client_uri: null,
    policy_uri: null,
    tos_uri: null,
    contacts: null,
    post_logout_redirect_uris: null,
    subject_type: 'public',
    sector_identifier_uri: null,
    token_endpoint_auth_method: 'client_secret_post',
    jwks: null,
    jwks_uri: null,
    is_trusted: false,
    skip_consent: false,
    allow_claims_without_scope: false,
    claims_parameter_policy: null,
    asc_enabled: true,
    asc_protected_request_required: true,
    asc_sao_enabled: true,
    asc_transformed_claims_enabled: true,
    asc_allowed_transformed_claims: null,
    token_exchange_allowed: false,
    allowed_subject_token_clients: null,
    allowed_token_exchange_resources: null,
    delegation_mode: 'delegation',
    client_credentials_allowed: false,
    allowed_scopes: null,
    default_scope: null,
    default_audience: null,
    default_resource: null,
    backchannel_token_delivery_mode: null,
    backchannel_client_notification_endpoint: null,
    backchannel_authentication_request_signing_alg: null,
    backchannel_user_code_parameter: false,
    token_endpoint_auth_signing_alg: null,
    id_token_signed_response_alg: null,
    userinfo_signed_response_alg: null,
    authorization_signed_response_alg: null,
    authorization_encrypted_response_alg: null,
    authorization_encrypted_response_enc: null,
    backchannel_logout_uri: null,
    backchannel_logout_session_required: false,
    frontchannel_logout_uri: null,
    frontchannel_logout_session_required: false,
    allowed_redirect_origins: null,
    software_id: null,
    software_version: null,
    requestable_scopes: null,
    require_pkce: true,
    initiate_login_uri: null,
    login_ui_url: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function createAdapter(client: OAuthClient | null) {
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM oauth_clients') && params?.[1] === 'diag-client') {
        return client;
      }
      return null;
    }),
    execute: vi.fn(async () => ({ rowsAffected: 0 })),
    batch: vi.fn(async () => []),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
    isHealthy: vi.fn(async () => ({ healthy: true })),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => undefined),
  };
}

function createKV(values: Record<string, string>): KVNamespace {
  return {
    get: vi.fn(async (key: string) =>
      key === 'settings:tenant:tenant-1:diagnostic-logging'
        ? JSON.stringify({
            'diagnostic-logging.enabled': true,
            'diagnostic-logging.sdk_ingest_enabled': true,
            ...JSON.parse(values[key] ?? '{}'),
          })
        : (values[key] ?? null)
    ),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function createEnv(client: OAuthClient | null, bucket: MockR2Bucket, settings?: KVNamespace): Env {
  return {
    ISSUER_URL: 'https://issuer.example.com',
    OTP_HMAC_SECRET: 'otp-secret',
    DB: createAdapter(client),
    LOG_ARCHIVE: bucket as unknown as R2Bucket,
    AUTHRIM_LOG_ARCHIVE_MODE: 'pipeline',
    ...(settings ? { SETTINGS: settings } : {}),
  } as unknown as Env;
}

describe('diagnostic logging ingest', () => {
  it('rejects confidential clients when client_secret does not match stored hash', async () => {
    const bucket = new MockR2Bucket();
    const client = createClient({
      client_secret_hash: await hashClientSecret('correct-secret'),
    });
    const env = createEnv(client, bucket);

    const response = await ingestApp.request(
      '/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'tenant-1',
          client_id: 'diag-client',
          client_secret: 'wrong-secret',
          logs: [
            {
              id: 'log-1',
              tenantId: 'tenant-1',
              clientId: 'diag-client',
              category: 'auth-decision',
              level: 'info',
              timestamp: Date.now(),
              decision: 'allow',
              reason: 'test',
            },
          ],
        }),
      },
      env
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_client',
      error_description: 'invalid_client_secret',
    });
    expect(bucket.store.size).toBe(0);
  });

  describe('settings and privacy', () => {
    const SETTINGS_KEY = 'settings:tenant:tenant-1:diagnostic-logging';
    const common = {
      tenantId: 'tenant-1',
      clientId: 'diag-client',
      category: 'token-validation',
      level: 'debug',
      timestamp: Date.now(),
      result: 'pass',
      source: 'server',
    };
    const sdkEntries = [
      {
        ...common,
        id: 'log-1',
        step: 'token-response',
        errorMessage: 'sent to jane.doe@example.com',
        details: { access_token: 'raw-access-token' },
      },
      {
        ...common,
        id: 'log-2',
        step: 'userinfo-response',
        details: { claims: { email: 'jane.doe@example.com', name: 'Jane Doe' } },
      },
    ];

    async function ingest(settings: KVNamespace | undefined, logs: unknown[] = sdkEntries) {
      const bucket = new MockR2Bucket();
      const env = createEnv(createClient({ token_endpoint_auth_method: 'none' }), bucket, settings);
      const response = await ingestApp.request(
        '/',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenant_id: 'tenant-1', client_id: 'diag-client', logs }),
        },
        env
      );
      const stored = [...bucket.store.values()].join('\n');
      return { response, stored };
    }

    const FULL_MODE = { 'diagnostic-logging.storage_mode.default': 'full' };

    it('redacts PII and fingerprints tokens of a full-mode client by default', async () => {
      const { response, stored } = await ingest(
        createKV({ [SETTINGS_KEY]: JSON.stringify(FULL_MODE) })
      );

      expect(response.status).toBe(200);
      expect(stored).not.toContain('jane.doe@example.com');
      expect(stored).not.toContain('Jane Doe');
      expect(stored).not.toContain('raw-access-token');
      expect(stored).toContain('sha256:');
    });

    it('stores raw PII of a full-mode client only when the PII filter is off, and still no token', async () => {
      const { response, stored } = await ingest(
        createKV({
          [SETTINGS_KEY]: JSON.stringify({ ...FULL_MODE, 'diagnostic-logging.filter_pii': false }),
        })
      );

      expect(response.status).toBe(200);
      expect(stored).toContain('jane.doe@example.com');
      expect(stored).toContain('Jane Doe');
      expect(stored).not.toContain('raw-access-token');
    });

    it('stores nothing and answers 503 when the settings cannot be read', async () => {
      const failing = createKV({});
      (failing.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kv down'));
      const { response, stored } = await ingest(failing);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
      expect(stored).toBe('');
    });

    it('stores nothing and answers 503 when the settings document is corrupt, so an admin-set off cannot be bypassed', async () => {
      const { response, stored } = await ingest(createKV({ [SETTINGS_KEY]: '{not json' }));

      expect(response.status).toBe(503);
      expect(stored).toBe('');
    });

    it('checks the client first: a client that does not validate gets 401 even with the settings down', async () => {
      const failing = createKV({});
      (failing.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kv down'));
      const bucket = new MockR2Bucket();
      const env = createEnv(
        createClient({ client_secret_hash: await hashClientSecret('right') }),
        bucket,
        failing
      );
      const response = await ingestApp.request(
        '/',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tenant_id: 'tenant-1',
            client_id: 'diag-client',
            client_secret: 'wrong',
            logs: sdkEntries,
          }),
        },
        env
      );

      expect(response.status).toBe(401);
      expect(failing.get).not.toHaveBeenCalled();
      expect(bucket.store.size).toBe(0);
    });

    it.each(['full', 'masked', 'minimal'])(
      'takes secrets out of any step and nesting in %s mode, and validates identifiers',
      async (mode) => {
        const { response, stored } = await ingest(
          createKV({
            [SETTINGS_KEY]: JSON.stringify({ 'diagnostic-logging.storage_mode.default': mode }),
          }),
          [
            {
              ...common,
              id: 'log-9',
              requestId: 'jane@example.com',
              step: 'issuer-check',
              errorMessage: 'cb https://rp.example.com/cb?code=raw-code&state=s',
              details: {
                client_secret: 'raw-client-secret',
                nested: [{ refresh_token: 'raw-refresh' }, { 'Access-Token': { v: 'raw-obj' } }],
              },
            },
          ]
        );

        expect(response.status).toBe(200);
        for (const raw of [
          'raw-client-secret',
          'raw-refresh',
          'raw-obj',
          'raw-code',
          'jane@example.com',
        ]) {
          expect(stored, raw).not.toContain(raw);
        }
      }
    );

    it('stores nothing and answers 503 when the settings namespace is not bound at all', async () => {
      const { response, stored } = await ingest(undefined);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
      expect(stored).toBe('');
    });

    it('keeps an email-shaped client_id out of the failure record it archives', async () => {
      mocks.emitRuntimeLogRecords.mockClear();
      const bucket = new MockR2Bucket();
      const env = createEnv(null, bucket, createKV({}));
      const response = await ingestApp.request(
        '/',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tenant_id: 'tenant-1',
            client_id: 'jane@example.com',
            logs: sdkEntries,
          }),
        },
        env
      );

      expect(response.status).toBe(401);
      const archived = JSON.stringify(mocks.emitRuntimeLogRecords.mock.calls);
      expect(archived).toContain('client_not_found');
      expect(archived).not.toContain('jane@example.com');
      expect(archived).toMatch(/client:sha256:[0-9a-f]{12}/);
    });

    it('archives a plain client_id as it is', async () => {
      mocks.emitRuntimeLogRecords.mockClear();
      const env = createEnv(null, new MockR2Bucket(), createKV({}));
      await ingestApp.request(
        '/',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenant_id: 'tenant-1', client_id: 'plain-client', logs: [] }),
        },
        env
      );
      expect(JSON.stringify(mocks.emitRuntimeLogRecords.mock.calls)).toContain(
        'client:plain-client'
      );
    });

    it('reads the tenant settings from the Settings API namespace', async () => {
      const settings = createKV({
        [SETTINGS_KEY]: JSON.stringify({ 'diagnostic-logging.sdk_ingest_enabled': false }),
      });
      const { response, stored } = await ingest(settings);

      expect(response.status).toBe(403);
      expect(stored).toBe('');
      expect(settings.get).toHaveBeenCalledWith(SETTINGS_KEY);
    });

    it('names the SDK as the writer, whatever the sender claims', async () => {
      const { stored } = await ingest(createKV({}));

      const entry = JSON.parse(stored.split('\n')[0]) as Record<string, unknown>;
      expect(entry.source).toBe('sdk');
    });
  });
});

describe('destination tenant rate limit', () => {
  const IP = { 'CF-Connecting-IP': '192.0.2.10' };

  /** The ingest router behind a request tenant (the tenant of the host the request arrived on). */
  function mountedAt(requestTenant: string) {
    const outer = new Hono<{ Bindings: Env }>();
    outer.use('*', async (c, next) => {
      (c as unknown as { set(k: string, v: unknown): void }).set('tenantId', requestTenant);
      await next();
    });
    outer.route('/', ingestApp);
    return outer;
  }

  function limiterEnv(client: OAuthClient | null, settings: Record<string, unknown> = {}) {
    const counters = new Map<string, number>();
    const env = {
      ...createEnv(
        client,
        new MockR2Bucket(),
        createKV({
          'settings:tenant:tenant-1:diagnostic-logging': JSON.stringify(settings),
        })
      ),
      RATE_LIMITER: {
        idFromName: (name: string) => name,
        get: (id: string) => ({
          incrementRpc: async (
            _k: string,
            config: { maxRequests: number; windowSeconds: number }
          ) => {
            const current = (counters.get(id) ?? 0) + 1;
            counters.set(id, current);
            return {
              allowed: current <= config.maxRequests,
              current,
              limit: config.maxRequests,
              resetAt: Math.floor(Date.now() / 1000) + config.windowSeconds,
              retryAfter: 0,
            };
          },
        }),
      },
    } as unknown as Env;
    return { env, counters };
  }

  const post = (
    app: Hono<{ Bindings: Env }>,
    env: Env,
    tenantId: unknown,
    clientId = 'diag-client'
  ) =>
    app.request(
      '/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...IP },
        body: JSON.stringify({ tenant_id: tenantId, client_id: clientId, logs: [] }),
      },
      env
    );

  const destinationKey = 'tenant:tenant-1:rate-limit:diagnostic_log_ingest:192.0.2.10';

  it('counts a valid ingest for another destination tenant on that tenant, once', async () => {
    const { env, counters } = limiterEnv(createClient({ token_endpoint_auth_method: 'none' }));

    const response = await post(mountedAt('host-a'), env, 'tenant-1');

    expect(response.status).toBe(200);
    expect(counters.get(destinationKey)).toBe(1);
  });

  it('does not count a request whose client is unknown, however the tenant id is spelled', async () => {
    const { env, counters } = limiterEnv(null);

    for (const tenantId of ['tenant-1', 'victim', 'another-made-up']) {
      expect((await post(mountedAt('host-a'), env, tenantId)).status).toBe(401);
    }

    expect([...counters.keys()]).toEqual([]);
  });

  it('does not count a client that belongs to another tenant', async () => {
    const { env, counters } = limiterEnv(
      createClient({ token_endpoint_auth_method: 'none', tenant_id: 'other' })
    );

    expect((await post(mountedAt('host-a'), env, 'tenant-1')).status).toBe(401);
    expect([...counters.keys()]).toEqual([]);
  });

  it('does not count a malformed tenant id (400)', async () => {
    const { env, counters } = limiterEnv(createClient({ token_endpoint_auth_method: 'none' }));

    for (const tenantId of ['Tenant_1', 'a'.repeat(64), 42, '../x']) {
      expect((await post(mountedAt('host-a'), env, tenantId)).status).toBe(400);
    }
    expect([...counters.keys()]).toEqual([]);
  });

  it('counts a request for a tenant whose ingest is disabled (403) on the destination, once', async () => {
    const { env, counters } = limiterEnv(createClient({ token_endpoint_auth_method: 'none' }), {
      'diagnostic-logging.sdk_ingest_enabled': false,
    });

    expect((await post(mountedAt('host-a'), env, 'tenant-1')).status).toBe(403);
    expect(counters.get(destinationKey)).toBe(1);
  });

  it('gains no budget by rotating request hosts with the same destination tenant', async () => {
    const { env } = limiterEnv(createClient({ token_endpoint_auth_method: 'none' }));
    const statuses: number[] = [];

    for (let index = 0; index < 61; index++) {
      statuses.push((await post(mountedAt(`host-${index}`), env, 'tenant-1')).status);
    }

    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  describe('failure events', () => {
    const eventTenants = () =>
      mocks.emitRuntimeLogRecords.mock.calls.map(
        (call) => (call as unknown as [{ tenantId: string }])[0].tenantId
      );

    it('never write to an unverified body tenant: an unknown client is recorded on the request host tenant', async () => {
      mocks.emitRuntimeLogRecords.mockClear();
      const { env } = limiterEnv(null);

      for (let index = 0; index < 5; index++) {
        await post(mountedAt(`host-${index}`), env, 'victim');
      }

      expect(eventTenants()).toEqual(['host-0', 'host-1', 'host-2', 'host-3', 'host-4']);
      expect(eventTenants()).not.toContain('victim');
    });

    it('does not write to the body tenant when the client belongs to another tenant', async () => {
      mocks.emitRuntimeLogRecords.mockClear();
      const { env } = limiterEnv(
        createClient({ token_endpoint_auth_method: 'none', tenant_id: 'other' })
      );

      await post(mountedAt('host-a'), env, 'tenant-1');

      expect(eventTenants()).toEqual(['host-a']);
    });

    it('stops destination writes at the limit even with ingest disabled and rotating hosts', async () => {
      mocks.emitRuntimeLogRecords.mockClear();
      const { env } = limiterEnv(createClient({ token_endpoint_auth_method: 'none' }), {
        'diagnostic-logging.sdk_ingest_enabled': false,
      });
      const statuses: number[] = [];

      for (let index = 0; index < 62; index++) {
        statuses.push((await post(mountedAt(`host-${index}`), env, 'tenant-1')).status);
      }

      expect(statuses.slice(0, 60).every((status) => status === 403)).toBe(true);
      expect(statuses.slice(60)).toEqual([429, 429]);
      // Failure events: 60 for the destination, none after the budget was spent.
      expect(eventTenants().filter((tenant) => tenant === 'tenant-1')).toHaveLength(60);
    });

    it('still records failures after validation on the validated tenant', async () => {
      mocks.emitRuntimeLogRecords.mockClear();
      const { env } = limiterEnv(createClient({ token_endpoint_auth_method: 'none' }), {
        'diagnostic-logging.sdk_ingest_enabled': false,
      });

      expect((await post(mountedAt('host-a'), env, 'tenant-1')).status).toBe(403);

      expect(eventTenants()).toEqual(['tenant-1']);
    });
  });
});
