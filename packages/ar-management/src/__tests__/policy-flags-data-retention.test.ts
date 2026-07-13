import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { queryOne: vi.fn(), execute: vi.fn() },
  audit: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    createAuditLogFromContext: mocks.audit,
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
    createErrorResponse: vi.fn((c, code, options) => c.json({ error: code, ...options }, code === actual.AR_ERROR_CODES.INTERNAL_ERROR ? 500 : 400)),
  };
});

import { clearPolicyFlag, getPolicyFlags, updatePolicyFlag } from '../routes/settings/policy-flags';
import {
  getCleanupRunStatus, getDataRetentionEstimate, listRetentionCategories,
  runDataRetentionCleanup, updateCategoryRetention,
} from '../routes/settings/data-retention';

function kv(values: Record<string, string | null> = {}) {
  return { get: vi.fn((key: string) => Promise.resolve(values[key] ?? null)), put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) };
}
function context(options: { store?: ReturnType<typeof kv>; body?: unknown; param?: string; query?: Record<string, string> } = {}) {
  return {
    req: {
      param: vi.fn(() => options.param), query: vi.fn((name: string) => options.query?.[name]),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: options.store ? { AUTHRIM_CONFIG: options.store } : {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

describe('policy flags and data retention', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.adapter.queryOne.mockReset(); mocks.adapter.execute.mockReset();
    mocks.adapter.queryOne.mockResolvedValue(null); mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.audit.mockResolvedValue(undefined);
  });

  it('requires KV, reads policy flag sources, and handles read errors', async () => {
    expect((await getPolicyFlags(context())).status).toBe(500);
    const store = kv({ CHECK_API_ENABLED: 'true' });
    await expect((await getPolicyFlags(context({ store }))).json()).resolves.toMatchObject({
      flags: { CHECK_API_ENABLED: { value: 'true', source: 'kv' }, CHECK_API_BATCH_SIZE_LIMIT: { source: 'default' } },
    });
    store.get.mockRejectedValueOnce(new Error('failure'));
    expect((await getPolicyFlags(context({ store }))).status).toBe(500);
  });

  it.each([
    ['unknown', { value: true }, 400], ['CHECK_API_ENABLED', {}, 400],
    ['CHECK_API_ENABLED', { value: 1 }, 400], ['CHECK_API_ENABLED', { value: false }, 200],
    ['CHECK_API_BATCH_SIZE_LIMIT', { value: '1' }, 400], ['CHECK_API_BATCH_SIZE_LIMIT', { value: Number.NaN }, 400],
    ['CHECK_API_BATCH_SIZE_LIMIT', { value: 0 }, 400], ['CHECK_API_BATCH_SIZE_LIMIT', { value: 1001 }, 400],
    ['CHECK_API_BATCH_SIZE_LIMIT', { value: 1 }, 200], ['CHECK_API_BATCH_SIZE_LIMIT', { value: 1000 }, 200],
  ])('validates policy flag %s %#', async (name, body, status) => {
    const response = await updatePolicyFlag(context({ store: kv(), param: name, body }));
    expect(response.status).toBe(status);
  });

  it('requires KV and sanitizes policy flag write errors', async () => {
    expect((await updatePolicyFlag(context({ param: 'CHECK_API_ENABLED', body: { value: true } }))).status).toBe(500);
    const store = kv(); store.put.mockRejectedValueOnce(new Error('secret detail'));
    const response = await updatePolicyFlag(context({ store, param: 'CHECK_API_ENABLED', body: { value: true } }));
    expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain('secret detail');
  });

  it('validates/clears policy flags and handles delete errors', async () => {
    expect((await clearPolicyFlag(context({ store: kv(), param: 'unknown' }))).status).toBe(400);
    expect((await clearPolicyFlag(context({ param: 'CHECK_API_ENABLED' }))).status).toBe(500);
    const store = kv(); expect((await clearPolicyFlag(context({ store, param: 'CHECK_API_ENABLED' }))).status).toBe(200);
    store.delete.mockRejectedValueOnce(new Error('failure'));
    expect((await clearPolicyFlag(context({ store, param: 'CHECK_API_ENABLED' }))).status).toBe(500);
  });

  it('estimates all retention categories using tenant overrides and per-table fallback', async () => {
    mocks.adapter.queryOne
      .mockResolvedValueOnce({ settings: JSON.stringify({ data_retention: { categories: { audit_logs: { retention_days: 30 } } } }) })
      .mockResolvedValueOnce({ count: 10, oldest_date: 100 })
      .mockRejectedValueOnce(new Error('missing table'))
      .mockResolvedValue({ count: 2, oldest_date: null });
    const body = (await (await getDataRetentionEstimate(context())).json()) as { estimates: unknown[]; total_records_to_delete: number };
    expect(body.estimates).toHaveLength(6); expect(body.total_records_to_delete).toBe(18);
  });

  it('filters retention estimate and handles corrupt tenant settings', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ count: 1, oldest_date: null });
    const body = (await (await getDataRetentionEstimate(context({ query: { category: 'sessions_data' } }))).json()) as { estimates: unknown[] };
    expect(body.estimates).toHaveLength(0);
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.queryOne.mockResolvedValueOnce({ settings: '{' });
    expect((await getDataRetentionEstimate(context())).status).toBe(500);
  });

  it.each(['unknown', 'audit_logs'])('validates category update %s', async (category) => {
    const body = category === 'unknown' ? { retention_days: 30 } : { retention_days: 0 };
    expect((await updateCategoryRetention(context({ param: category, body }))).status).toBe(400);
  });

  it.each([null, JSON.stringify({ unrelated: true, data_retention: { categories: { audit_logs: { retention_days: 90 } } } })])(
    'updates category settings from stored=%s', async (settings) => {
      mocks.adapter.queryOne.mockResolvedValueOnce(settings ? { settings } : null);
      const response = await updateCategoryRetention(context({ param: 'audit_logs', body: { retention_days: 30 } }));
      expect(response.status).toBe(200); expect(mocks.audit).toHaveBeenCalled();
      const saved = JSON.parse(mocks.adapter.execute.mock.calls[0][1][0]);
      expect(saved.data_retention.categories.audit_logs.retention_days).toBe(30);
    }
  );

  it('handles category update persistence/corrupt settings errors', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ settings: '{' });
    expect((await updateCategoryRetention(context({ param: 'audit_logs', body: { retention_days: 30 } }))).status).toBe(500);
  });

  it.each([[{ categories: 'bad' }], [{ categories: [1] }]])('validates cleanup body %#', async (body) => {
    expect((await runDataRetentionCleanup(context({ body }))).status).toBe(400);
  });

  it('rejects cleanup request with no valid category', async () => {
    expect((await runDataRetentionCleanup(context({ body: { categories: ['unknown'] } }))).status).toBe(400);
  });

  it.each([undefined, ['audit_logs', 'unknown']])('runs cleanup categories=%s', async (categories) => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ settings: null });
    const response = await runDataRetentionCleanup(context({ body: { categories, idempotency_key: 'key-1' } }));
    const body = (await response.json()) as { status: string; categories: string[] };
    expect(body.status).toBe('completed'); expect(body.categories).toHaveLength(categories ? 1 : 6); expect(mocks.audit).toHaveBeenCalled();
  });

  it('continues cleanup after one category fails and reports partial success', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ settings: null });
    mocks.adapter.execute.mockRejectedValueOnce(new Error('audit table missing')).mockResolvedValue({ success: true, rowsAffected: 2 });
    const body = (await (await runDataRetentionCleanup(context({ body: { categories: ['audit_logs', 'session_data'] } }))).json()) as { status: string; error_message: string };
    expect(body.status).toBe('partial_success'); expect(body.error_message).toContain('audit_logs'); expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it('validates cleanup run UUID', async () => {
    expect((await getCleanupRunStatus(context({ param: 'bad' }))).status).toBe(400);
    expect((await getCleanupRunStatus(context({ param: '123e4567-e89b-12d3-a456-426614174000' }))).status).toBe(200);
  });

  it('lists categories with overrides/defaults and handles errors', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ settings: JSON.stringify({ data_retention: { categories: { session_data: { retention_days: 14, updated_at: 100 } } } }) });
    const body = (await (await listRetentionCategories(context())).json()) as { categories: Array<Record<string, unknown>> };
    expect(body.categories).toHaveLength(6); expect(body.categories).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'session_data', retention_days: 14, updated_at: expect.any(String) })]));
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await listRetentionCategories(context())).status).toBe(500);
  });
});
