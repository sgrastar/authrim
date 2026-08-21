import { describe, expect, it, vi } from 'vitest';
import type { R2Bucket } from '@cloudflare/workers-types';
import { scanAndReportPluginBundleMetrics } from '../r2-bucket-metrics';

function database() {
  const state = new Map<string, string>();
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first<T>() {
          const accumulator = state.get('PLUGIN_BUNDLES');
          return (accumulator ? { accumulator_json: accumulator } : null) as T | null;
        },
        async run() {
          if (sql.includes('INSERT INTO plugin_runner_r2_metric_scan_state')) {
            state.set('PLUGIN_BUNDLES', String(values[0]));
          } else if (sql.includes('DELETE FROM plugin_runner_r2_metric_scan_state')) {
            state.delete('PLUGIN_BUNDLES');
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe('Plugin Runner R2 metrics', () => {
  it('scans only its bundle bucket and reports a secret-free summary to Control', async () => {
    const reportR2BucketMetrics = vi.fn(async () => ({ metrics: [], generatedAt: 2_000 }));
    const list = vi.fn(async () => ({
      objects: [
        { key: 'bundles/plugin-a/v1.js', size: 100, uploaded: new Date(1_000) },
        { key: 'bundles/plugin-b/v1.js', size: 250, uploaded: new Date(1_500) },
      ],
      truncated: false,
      delimitedPrefixes: [],
    }));

    await scanAndReportPluginBundleMetrics(
      {
        PLUGIN_RUNNER_DB: database(),
        PLUGIN_BUNDLES: { list } as unknown as R2Bucket,
        CONTROL: { reportR2BucketMetrics },
      } as never,
      2_000
    );

    expect(list).toHaveBeenCalledWith({ limit: 1000, cursor: undefined });
    expect(reportR2BucketMetrics).toHaveBeenCalledWith({
      metrics: [
        expect.objectContaining({
          binding: 'PLUGIN_BUNDLES',
          objectCount: 2,
          totalBytes: 350,
          oldestObjectAt: 1_000,
          scanComplete: true,
          measuredAt: 2_000,
        }),
      ],
    });
  });

  it('does not require Control or R2 in reduced test/runtime profiles', async () => {
    await expect(
      scanAndReportPluginBundleMetrics({ PLUGIN_RUNNER_DB: database() } as never)
    ).resolves.toBeUndefined();
  });
});
