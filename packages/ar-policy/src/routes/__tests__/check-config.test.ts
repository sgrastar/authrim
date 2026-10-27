import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { CheckAuditServiceConfig } from '@authrim/ar-lib-core/services/check-audit-service';

const audit = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@authrim/ar-lib-core/services/check-audit-service', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@authrim/ar-lib-core/services/check-audit-service')>();
  return {
    ...original,
    createCheckAuditService: audit.create.mockImplementation(original.createCheckAuditService),
  };
});

import { checkRoutes } from '../check';

function createDb() {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
    })),
    batch: vi.fn().mockResolvedValue([]),
  };
}

function createKv(values: Record<string, string | null> = {}, reject = false) {
  return {
    get: vi.fn(async (key: string) => {
      if (reject) throw new Error('configuration unavailable');
      return values[key] ?? null;
    }),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  };
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    POLICY_API_SECRET: 'policy-secret',
    ENABLE_CHECK_API: 'true',
    TDB_POLICY_TEST_CORE: createDb(),
    ...overrides,
  };
}

const app = new Hono();
app.use('*', async (c, next) => {
  const coreDb = c.env.TDB_POLICY_TEST_CORE;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const context = c as any;
  context.set('tenantId', 'default');
  if (coreDb) {
    context.set('tenantMetadataContext', {
      tenantId: 'default',
      coreDb,
      route: {},
    });
  }
  await next();
});
app.route('/', checkRoutes);

async function health(overrides: Record<string, unknown> = {}) {
  return app.request('/health', {}, env(overrides));
}

async function reachAuditConfiguration(overrides: Record<string, unknown> = {}) {
  const bindings = env(overrides);
  const response = await app.request(
    '/',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer policy-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenant_id: 'tenant-a' }),
    },
    bindings
  );
  return { response, bindings };
}

function expectAuditConfiguration(
  bindings: ReturnType<typeof env>,
  config: CheckAuditServiceConfig
): void {
  expect(audit.create).toHaveBeenCalledTimes(1);
  const call = audit.create.mock.calls[0];
  expect(call).toHaveLength(2);
  expect(call?.[0]).toBe(bindings);
  expect(call?.[1]).toEqual(config);
}

describe('Check API runtime configuration branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['1', 1],
    ['1000', 1000],
    ['0', 100],
    ['1001', 100],
    ['not-a-number', 100],
  ])('validates environment batch limit %s', async (configured, expected) => {
    const response = await health({ CHECK_API_BATCH_SIZE_LIMIT: configured });
    expect(response.status).toBe(200);
    expect((await response.json()).batch_size_limit).toBe(expected);
  });

  it('falls back to the environment when the settings cannot be read', async () => {
    const response = await health({
      SETTINGS: createKv({}, true),
      CHECK_API_BATCH_SIZE_LIMIT: '30',
    });
    expect((await response.json()).batch_size_limit).toBe(30);
  });

  it('no longer reads the older values from AUTHRIM_CONFIG or the policy service KV', async () => {
    const response = await health({
      ENABLE_CHECK_API: undefined,
      POLICY_FLAGS_KV: createKv({ CHECK_API_ENABLED: 'true', CHECK_API_BATCH_SIZE_LIMIT: '5' }),
      AUTHRIM_CONFIG: createKv({ CHECK_API_ENABLED: 'true', CHECK_API_BATCH_SIZE_LIMIT: '12' }),
    });
    const body = await response.json();
    expect(body.enabled).toBe(false);
    expect(body.batch_size_limit).toBe(100);
  });

  it('applies the platform Settings API values over env', async () => {
    const settings = createKv({
      'settings:platform:feature-flags': JSON.stringify({ 'feature.enable_check_api': false }),
      'settings:platform:limits': JSON.stringify({ 'limits.check_api_batch_size': 7 }),
    });
    const config = createKv({ CHECK_API_ENABLED: 'true', CHECK_API_BATCH_SIZE_LIMIT: '12' });
    const response = await health({ SETTINGS: settings, AUTHRIM_CONFIG: config });
    const body = await response.json();
    expect(body.enabled).toBe(false);
    expect(body.batch_size_limit).toBe(7);
  });

  it.each(['1', 'TRUE', 'True'])(
    'turns the Check API on from env only as exactly true, not %s',
    async (value) => {
      const response = await health({ ENABLE_CHECK_API: value });
      expect((await response.json()).enabled).toBe(false);
    }
  );

  it('keeps the value it could read when the other settings document cannot be read', async () => {
    const flagsOnly = createKv({
      'settings:platform:feature-flags': JSON.stringify({ 'feature.enable_check_api': false }),
      'settings:platform:limits': 'not json',
    });
    let body = await (
      await health({
        SETTINGS: flagsOnly,
        ENABLE_CHECK_API: 'true',
        CHECK_API_BATCH_SIZE_LIMIT: '9',
      })
    ).json();
    expect(body.enabled).toBe(false);
    expect(body.batch_size_limit).toBe(9);

    const limitsOnly = createKv({
      'settings:platform:feature-flags': 'not json',
      'settings:platform:limits': JSON.stringify({ 'limits.check_api_batch_size': 7 }),
    });
    body = await (
      await health({
        SETTINGS: limitsOnly,
        ENABLE_CHECK_API: 'true',
        CHECK_API_BATCH_SIZE_LIMIT: '9',
      })
    ).json();
    // A switch that cannot be read is off: env does not turn on what may have been turned off.
    expect(body.enabled).toBe(false);
    expect(body.batch_size_limit).toBe(7);
  });

  it('reports database, cache, debug, and disabled secure-default state', async () => {
    const response = await health({
      ENABLE_CHECK_API: undefined,
      ENABLE_CHECK_API_DEBUG: 'true',
      TDB_POLICY_TEST_CORE: undefined,
      CHECK_CACHE_KV: createKv(),
    });
    expect(await response.json()).toMatchObject({
      status: 'limited',
      enabled: false,
      database: false,
      cache: true,
      debug_mode: true,
    });
  });

  it.each([
    ['/', undefined],
    ['/', 'false'],
    ['/batch', undefined],
    ['/batch', 'false'],
  ])(
    'does not enable %s or create an audit service when the Check API flag is %s',
    async (route, flag) => {
      const response = await app.request(
        route,
        { method: 'POST' },
        env({ ENABLE_CHECK_API: flag })
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe('access_denied');
      expect(audit.create).not.toHaveBeenCalled();
    }
  );

  it('creates the audit service with the platform Settings API values over env', async () => {
    const { bindings } = await reachAuditConfiguration({
      ENABLE_CHECK_API_AUDIT: 'false',
      CHECK_API_AUDIT_MODE: 'queue',
      SETTINGS: createKv({
        'settings:platform:check-api-audit': JSON.stringify({
          'audit.check_api_enabled': true,
          'audit.check_api_mode': 'sync',
          'audit.check_api_log_allow': 'always',
          'audit.check_api_sample_rate': 0,
          'audit.check_api_retention_days': 1,
        }),
      }),
    });
    expectAuditConfiguration(bindings, {
      mode: 'sync',
      logDeny: 'always',
      logAllow: 'always',
      sampleRate: 0,
      retentionDays: 1,
    });
  });

  it.each([
    ['without a settings binding', {}],
    ['with no saved settings', { SETTINGS: createKv() }],
  ])('enables auditing by default %s', async (_description, overrides) => {
    const { bindings } = await reachAuditConfiguration(overrides);
    expectAuditConfiguration(bindings, {
      mode: 'waitUntil',
      logDeny: 'always',
      logAllow: 'sample',
      sampleRate: 0.01,
      retentionDays: 90,
    });
  });

  it.each([
    ['without a settings binding', {}],
    ['with no saved settings', { SETTINGS: createKv() }],
  ])('honors an explicit audit env opt-out %s', async (_description, overrides) => {
    await reachAuditConfiguration({ ...overrides, ENABLE_CHECK_API_AUDIT: 'false' });
    expect(audit.create).not.toHaveBeenCalled();
  });

  it('uses env, then the defaults, for the audit settings nothing saved', async () => {
    const { bindings } = await reachAuditConfiguration({
      SETTINGS: createKv(),
      ENABLE_CHECK_API_AUDIT: 'true',
      CHECK_API_AUDIT_LOG_ALLOW: 'never',
      CHECK_API_AUDIT_RETENTION_DAYS: '365',
    });
    expectAuditConfiguration(bindings, {
      mode: 'waitUntil',
      logDeny: 'always',
      logAllow: 'never',
      sampleRate: 0.01,
      retentionDays: 365,
    });
  });

  it('takes a decimal sample rate from env and ignores env values it cannot use', async () => {
    const { bindings } = await reachAuditConfiguration({
      SETTINGS: createKv(),
      ENABLE_CHECK_API_AUDIT: 'true',
      CHECK_API_AUDIT_MODE: 'invalid',
      CHECK_API_AUDIT_LOG_ALLOW: 'invalid',
      CHECK_API_AUDIT_SAMPLE_RATE: '0.5',
      CHECK_API_AUDIT_RETENTION_DAYS: '0',
    });
    expectAuditConfiguration(bindings, {
      mode: 'waitUntil',
      logDeny: 'always',
      logAllow: 'sample',
      sampleRate: 0.5,
      retentionDays: 90,
    });

    audit.create.mockClear();
    const { bindings: fallbackBindings } = await reachAuditConfiguration({
      SETTINGS: createKv(),
      ENABLE_CHECK_API_AUDIT: 'true',
      CHECK_API_AUDIT_SAMPLE_RATE: '2',
    });
    expectAuditConfiguration(fallbackBindings, {
      mode: 'waitUntil',
      logDeny: 'always',
      logAllow: 'sample',
      sampleRate: 0.01,
      retentionDays: 90,
    });
  });

  it('creates no audit service when the Settings API turns auditing off, even if env enables it', async () => {
    await reachAuditConfiguration({
      ENABLE_CHECK_API_AUDIT: 'true',
      SETTINGS: createKv({
        'settings:platform:check-api-audit': JSON.stringify({ 'audit.check_api_enabled': false }),
      }),
    });
    expect(audit.create).not.toHaveBeenCalled();
  });

  it('keeps auditing on with the defaults when its settings cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bindings } = await reachAuditConfiguration({
      SETTINGS: createKv({ 'settings:platform:check-api-audit': 'not json' }),
      ENABLE_CHECK_API_AUDIT: 'false',
    });
    expectAuditConfiguration(bindings, {
      mode: 'waitUntil',
      logDeny: 'always',
      logAllow: 'sample',
      sampleRate: 0.01,
      retentionDays: 90,
    });
  });

  it('no longer reads the older audit values from AUTHRIM_CONFIG', async () => {
    const { bindings } = await reachAuditConfiguration({
      SETTINGS: createKv(),
      AUTHRIM_CONFIG: createKv({ CHECK_API_AUDIT_ENABLED: 'false' }),
    });
    expectAuditConfiguration(bindings, {
      mode: 'waitUntil',
      logDeny: 'always',
      logAllow: 'sample',
      sampleRate: 0.01,
      retentionDays: 90,
    });
  });
});
