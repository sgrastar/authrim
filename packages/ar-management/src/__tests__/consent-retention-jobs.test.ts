import { beforeEach, describe, expect, it, vi } from 'vitest';

const { adapter, listEnvironmentTenantDefaultStores } = vi.hoisted(() => {
  const adapter = {
    query: vi.fn(),
    execute: vi.fn(),
  };
  return {
    adapter,
    listEnvironmentTenantDefaultStores: vi.fn(async () => [
      { tenantId: 'default', store: { source: {}, bindingRef: 'TDB_DEFAULT' } },
    ]),
  };
});

vi.mock('@authrim/ar-lib-core', () => ({
  ensureDatabaseAdapter: () => adapter,
  listEnvironmentTenantDefaultStores,
}));

import { processConsentRetentionJobs } from '../consent-retention-jobs';

describe('processConsentRetentionJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listEnvironmentTenantDefaultStores.mockResolvedValue([
      { tenantId: 'default', store: { source: {}, bindingRef: 'TDB_DEFAULT' } },
    ]);
  });

  it('purges expired terminal consent records and history per statement retention', async () => {
    adapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, record_retention_days')) {
        return [{ id: 'stmt-1', record_retention_days: 30 }];
      }
      return [];
    });
    adapter.execute.mockResolvedValue(undefined);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const config = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
    await processConsentRetentionJobs({ AUTHRIM_CONFIG: config } as never, log);

    expect(listEnvironmentTenantDefaultStores).toHaveBeenCalledWith(
      expect.objectContaining({ AUTHRIM_CONFIG: config }),
      { limit: 32, afterTenantId: undefined, concurrency: 4 }
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM consent_item_history'),
      expect.arrayContaining(['default', 'stmt-1'])
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("active_record.status = 'granted'"),
      expect.arrayContaining(['default', 'stmt-1'])
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('retain_until < ?'),
      expect.arrayContaining(['default', 'stmt-1'])
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('withdrawn', 'denied', 'expired')"),
      expect.arrayContaining(['default', 'stmt-1'])
    );
    expect(log.info).toHaveBeenCalledWith('Consent retention cleanup completed', {
      tenantCount: 1,
    });
    expect(config.put).toHaveBeenCalledWith('jobs:consent-retention:tenant-cursor', '');
  });

  it('fails closed before touching a database when the signed tenant directory is unavailable', async () => {
    listEnvironmentTenantDefaultStores.mockRejectedValueOnce(
      new Error('environment_tenant_directory_unavailable')
    );
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      processConsentRetentionJobs(
        { AUTHRIM_CONFIG: { get: vi.fn(async () => null), put: vi.fn() } } as never,
        log
      )
    ).rejects.toThrow('environment_tenant_directory_unavailable');
    expect(adapter.query).not.toHaveBeenCalled();
  });
});
