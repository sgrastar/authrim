import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRoutes, clearBatchSizeLimitCache } from '../check';

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
    DB: createDb(),
    ...overrides,
  };
}

async function health(overrides: Record<string, unknown> = {}) {
  return checkRoutes.request('/health', {}, env(overrides));
}

async function reachAuditConfiguration(overrides: Record<string, unknown> = {}) {
  return checkRoutes.request(
    '/',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer policy-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenant_id: 'tenant-a' }),
    },
    env(overrides)
  );
}

describe('Check API runtime configuration branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBatchSizeLimitCache();
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

  it.each([
    ['25', 25],
    ['0', 40],
    ['1001', 40],
    ['invalid', 40],
  ])(
    'gives valid KV batch limit priority and rejects invalid value %s',
    async (value, expected) => {
      const kv = createKv({ CHECK_API_BATCH_SIZE_LIMIT: value });
      const response = await health({
        POLICY_FLAGS_KV: kv,
        CHECK_API_BATCH_SIZE_LIMIT: '40',
      });
      expect((await response.json()).batch_size_limit).toBe(expected);
    }
  );

  it('falls back to the environment when batch-limit KV fails', async () => {
    const response = await health({
      POLICY_FLAGS_KV: createKv({}, true),
      CHECK_API_BATCH_SIZE_LIMIT: '30',
    });
    expect((await response.json()).batch_size_limit).toBe(30);
  });

  it('uses AUTHRIM_CONFIG when the policy-specific KV is absent and caches the result', async () => {
    const kv = createKv({ CHECK_API_BATCH_SIZE_LIMIT: '12' });
    let response = await health({ AUTHRIM_CONFIG: kv });
    expect((await response.json()).batch_size_limit).toBe(12);

    kv.get.mockRejectedValue(new Error('should not be read while cached'));
    response = await health({ AUTHRIM_CONFIG: kv });
    expect((await response.json()).batch_size_limit).toBe(12);
    expect(kv.get).toHaveBeenCalledTimes(3); // enable flag per request; batch limit only once
    expect(kv.get.mock.calls.filter(([key]) => key === 'CHECK_API_BATCH_SIZE_LIMIT')).toHaveLength(
      1
    );
  });

  it('reports database, cache, debug, and disabled secure-default state', async () => {
    const response = await health({
      ENABLE_CHECK_API: undefined,
      ENABLE_CHECK_API_DEBUG: 'true',
      DB: undefined,
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

  it('accepts complete audit settings from KV while preserving request validation', async () => {
    const response = await reachAuditConfiguration({
      POLICY_FLAGS_KV: createKv({
        CHECK_API_ENABLED: 'true',
        CHECK_API_AUDIT_ENABLED: 'true',
        CHECK_API_AUDIT_MODE: 'sync',
        CHECK_API_AUDIT_LOG_ALLOW: 'always',
        CHECK_API_AUDIT_SAMPLE_RATE: '0',
        CHECK_API_AUDIT_RETENTION_DAYS: '1',
      }),
    });
    expect(response.status).toBe(400);
  });

  it('falls back from absent KV audit values to valid environment settings', async () => {
    const response = await reachAuditConfiguration({
      POLICY_FLAGS_KV: createKv(),
      ENABLE_CHECK_API_AUDIT: 'true',
      CHECK_API_AUDIT_MODE: 'queue',
      CHECK_API_AUDIT_LOG_ALLOW: 'never',
      CHECK_API_AUDIT_SAMPLE_RATE: '1',
      CHECK_API_AUDIT_RETENTION_DAYS: '365',
    });
    expect(response.status).toBe(400);
  });

  it('falls back from failed KV audit reads to environment settings', async () => {
    const response = await reachAuditConfiguration({
      POLICY_FLAGS_KV: createKv({}, true),
      ENABLE_CHECK_API: 'true',
      ENABLE_CHECK_API_AUDIT: 'true',
      CHECK_API_AUDIT_MODE: 'waitUntil',
      CHECK_API_AUDIT_LOG_ALLOW: 'sample',
      CHECK_API_AUDIT_SAMPLE_RATE: '0.5',
      CHECK_API_AUDIT_RETENTION_DAYS: '30',
    });
    expect(response.status).toBe(400);
  });

  it('ignores invalid audit values and retains secure defaults', async () => {
    const response = await reachAuditConfiguration({
      CHECK_API_AUDIT_MODE: 'invalid',
      CHECK_API_AUDIT_LOG_ALLOW: 'invalid',
      CHECK_API_AUDIT_SAMPLE_RATE: '2',
      CHECK_API_AUDIT_RETENTION_DAYS: '0',
    });
    expect(response.status).toBe(400);
  });
});
