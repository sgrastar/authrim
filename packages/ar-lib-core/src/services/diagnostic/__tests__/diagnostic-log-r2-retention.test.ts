import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDiagnosticLogR2Adapter } from '../diagnostic-log-r2-adapter';
import { emitLogIcebergRow } from '../../log-iceberg-emitter';
import { readLogIcebergDataset } from '../../log-iceberg-read';
import type { DiagnosticLogEntry } from '../types';

vi.mock('../../log-iceberg-emitter', () => ({ emitLogIcebergRow: vi.fn() }));
vi.mock('../../log-iceberg-read', () => ({ readLogIcebergDataset: vi.fn() }));
const entry = {
  id: 'diagnostic-1',
  tenantId: 'tenant-1',
  clientId: 'client-a',
  timestamp: 1_800_000_000_000,
  level: 'info',
  category: 'auth-decision',
  decision: 'allow',
  reason: 'allowed',
} as DiagnosticLogEntry;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(emitLogIcebergRow).mockResolvedValue(undefined as never);
});

describe('diagnostic Iceberg storage', () => {
  it('sets the 30-day default on the immutable record and never deletes raw R2 objects', async () => {
    const bucket = { list: vi.fn(), delete: vi.fn(), put: vi.fn() };
    const env = { LOG_ARCHIVE: bucket, AUTHRIM_LOG_ARCHIVE_MODE: 'pipeline' } as never;
    const adapter = createDiagnosticLogR2Adapter(env, { tenantId: 'tenant-1' });
    await expect(adapter.writeLog(entry)).resolves.toMatchObject({
      success: true,
      entriesWritten: 1,
    });
    expect(emitLogIcebergRow).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        sourceDataset: 'diagnostic.diagnostic_log',
        expiresAt: entry.timestamp + 30 * 86_400_000,
      })
    );
    await expect(adapter.deleteByRetention(Date.now())).rejects.toThrow(
      'diagnostic_retention_managed_by_iceberg'
    );
    await expect(adapter.deleteByRetentionPage(Date.now())).rejects.toThrow(
      'diagnostic_retention_managed_by_iceberg'
    );
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });
  it('reports partial batch failure without claiming unwritten entries were accepted', async () => {
    const adapter = createDiagnosticLogR2Adapter({} as never, { tenantId: 'tenant-1' });
    vi.mocked(emitLogIcebergRow)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error('queue_unavailable'));
    await expect(adapter.writeLogBatch([entry, { ...entry, id: 'second' }])).resolves.toMatchObject(
      { success: false, entriesWritten: 1, errorMessage: 'queue_unavailable' }
    );
  });
  it('queries canonical records with tenant/client filters and returns consistency', async () => {
    vi.mocked(readLogIcebergDataset).mockResolvedValue({
      rows: [entry, { ...entry, id: 'other', clientId: 'client-b' }].map((e) => ({
        id: e.id,
        entry_json: JSON.stringify(e),
      })),
      consistency: 'eventual',
    } as never);
    const adapter = createDiagnosticLogR2Adapter({} as never, {
      tenantId: 'tenant-1',
      clientId: 'client-a',
    });
    await expect(
      adapter.query({ tenantId: 'tenant-1', clientId: 'client-a' })
    ).resolves.toMatchObject({ entries: [entry], consistency: 'eventual', hasMore: false });
    await expect(adapter.query({ tenantId: 'tenant-other', clientId: 'client-a' })).rejects.toThrow(
      'scope_invalid'
    );
  });
  it('propagates unavailable/corrupt archive reads rather than returning an empty success', async () => {
    const adapter = createDiagnosticLogR2Adapter({} as never, { tenantId: 'tenant-1' });
    vi.mocked(readLogIcebergDataset).mockRejectedValueOnce(new Error('catalog_unavailable'));
    await expect(adapter.query({ tenantId: 'tenant-1' })).rejects.toThrow('catalog_unavailable');
    vi.mocked(readLogIcebergDataset).mockResolvedValueOnce({
      rows: [{ id: 'wrong', entry_json: JSON.stringify(entry) }],
    } as never);
    await expect(adapter.query({ tenantId: 'tenant-1' })).rejects.toThrow('record_invalid');
  });
});
