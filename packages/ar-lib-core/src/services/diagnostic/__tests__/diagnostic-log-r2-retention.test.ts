import { describe, expect, it, vi } from 'vitest';
import { buildDiagnosticLogPath, createDiagnosticLogR2Adapter } from '../diagnostic-log-r2-adapter';

describe('diagnostic R2 retention', () => {
  it('deletes only expired objects under the selected tenant prefix', async () => {
    const expiredKey = await buildDiagnosticLogPath({
      pathPrefix: 'diagnostic-logs',
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
      category: 'http',
      timestamp: Date.UTC(2026, 0, 1),
      chunkId: 'expired',
    });
    const retainedKey = await buildDiagnosticLogPath({
      pathPrefix: 'diagnostic-logs',
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
      category: 'http',
      timestamp: Date.UTC(2026, 2, 1),
      chunkId: 'retained',
    });
    const bucket = {
      list: vi.fn().mockResolvedValue({
        objects: [{ key: expiredKey }, { key: retainedKey }],
        truncated: false,
        delimitedPrefixes: [],
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = createDiagnosticLogR2Adapter(bucket as never, {
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
    });

    await expect(adapter.deleteByRetention(Date.UTC(2026, 1, 1))).resolves.toBe(1);

    expect(bucket.list).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: 'diagnostic-logs/v1/tenant-key-a/diagnostic_detail/diagnostic',
      })
    );
    expect(bucket.delete).toHaveBeenCalledOnce();
    expect(bucket.delete).toHaveBeenCalledWith([expiredKey]);
  });

  it('returns a cursor after one bounded retention page', async () => {
    const bucket = {
      list: vi.fn().mockResolvedValue({
        objects: [],
        truncated: true,
        cursor: 'next-page',
        delimitedPrefixes: [],
      }),
      delete: vi.fn(),
    };
    const adapter = createDiagnosticLogR2Adapter(bucket as never, {
      tenantId: 'tenant-a',
      tenantKey: 'tenant-key-a',
    });

    await expect(adapter.deleteByRetentionPage(Date.now(), 100)).resolves.toEqual({
      deleted: 0,
      scanned: 0,
      cursor: 'next-page',
    });
    expect(bucket.list).toHaveBeenCalledOnce();
  });

  it('surfaces R2 failures so the scheduled task records a failed run', async () => {
    const adapter = createDiagnosticLogR2Adapter(
      {
        list: vi.fn().mockRejectedValue(new Error('r2 unavailable')),
      } as never,
      { tenantId: 'tenant-a', tenantKey: 'tenant-key-a' }
    );

    await expect(adapter.deleteByRetention(Date.now())).rejects.toThrow('r2 unavailable');
  });
});
