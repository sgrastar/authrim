import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { resumePendingPiiPurges } from '../log-iceberg-maintenance';
const mocks = vi.hoisted(() => ({ stores: vi.fn(), query: vi.fn(), resume: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  ensureDatabaseAdapter: () => ({ query: mocks.query }),
  resolveTenantAssignedDatabaseSourcesFromRegistry: mocks.stores,
}));
vi.mock('@authrim/ar-lib-core/services/audit/index', () => ({
  createAuditService: () => ({ resumePendingPIIPurge: mocks.resume }),
}));
function fixture() {
  vi.resetAllMocks();
  const values = new Map<string, string>();
  const env = Object.assign({} as Env, {
    AUTHRIM_CONFIG: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    },
  });
  mocks.stores.mockResolvedValue([{ source: {}, bindingRef: 'PII_A' }]);
  mocks.resume.mockResolvedValue({ success: false, pending: true });
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    user_id: `user-${i}`,
    created_at: i + 1,
  }));
  mocks.query.mockImplementation(async (_sql: string, params: unknown[]) =>
    rows
      .filter(
        (row) =>
          row.created_at > Number(params[1]) ||
          (row.created_at === params[1] && row.id > String(params[3]))
      )
      .slice(0, 4)
  );
  return { env, rows, values };
}
describe('bounded PII purge resumption progress', () => {
  it('advances past the first four pending intents and resumes the fifth on the next pass', async () => {
    const { env, rows } = fixture();
    await resumePendingPiiPurges(env, 'generation', 'tenant-a', Date.now() + 10000);
    expect(mocks.resume).toHaveBeenCalledTimes(4);
    await resumePendingPiiPurges(env, 'generation', 'tenant-a', Date.now() + 10000);
    expect(mocks.resume).toHaveBeenLastCalledWith('tenant-a', rows[4].user_id, rows[4].id);
  });
  it('advances past a failed intent and rotates to later stores', async () => {
    const { env, values } = fixture();
    mocks.stores.mockResolvedValue([
      { source: {}, bindingRef: 'PII_A' },
      { source: {}, bindingRef: 'PII_B' },
    ]);
    mocks.resume.mockRejectedValueOnce(new Error('unavailable'));
    expect(
      (await resumePendingPiiPurges(env, 'generation', 'tenant-a', Date.now() + 10000)).failed
    ).toBe(1);
    await resumePendingPiiPurges(env, 'generation', 'tenant-a', Date.now() + 10000);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(values.get('jobs:log-iceberg:pii-purge-store:generation:tenant-a')).toBe('PII_B');
    expect(values.has('jobs:log-iceberg:pii-purge-cursor:generation:tenant-a:PII_A')).toBe(true);
    expect(values.has('jobs:log-iceberg:pii-purge-cursor:generation:tenant-a:PII_B')).toBe(true);
  });
});
