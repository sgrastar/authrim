import { describe, expect, it, vi } from 'vitest';

const { adapter, mockResolveAdapter } = vi.hoisted(() => {
  const adapter = {
    query: vi.fn(),
    execute: vi.fn(),
  };
  return {
    adapter,
    mockResolveAdapter: vi.fn(async () => adapter),
  };
});

vi.mock('@authrim/ar-lib-core', () => ({
  getDefaultTenantId: () => 'default',
  resolveAuthCorePersistenceAdapterFromEnv: mockResolveAdapter,
}));

import { processConsentRetentionJobs } from '../consent-retention-jobs';

describe('processConsentRetentionJobs', () => {
  it('purges expired terminal consent records and history per statement retention', async () => {
    adapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT tenant_id')) return [{ tenant_id: 'default' }];
      if (sql.includes('SELECT id, record_retention_days')) {
        return [{ id: 'stmt-1', record_retention_days: 30 }];
      }
      return [];
    });
    adapter.execute.mockResolvedValue(undefined);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await processConsentRetentionJobs({} as never, log);

    expect(mockResolveAdapter).toHaveBeenCalledWith({}, 'management-consent-retention');
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
  });
});
