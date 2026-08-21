import { describe, expect, it } from 'vitest';
import { getR2BucketMetricInventory, reportR2BucketMetrics } from '../r2-bucket-metrics';

type Row = Record<string, unknown>;

function database() {
  const rows: Row[] = [];
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async run() {
        if (sql.includes('INSERT INTO control_r2_bucket_metric_reports')) {
          rows.splice(
            rows.findIndex((row) => row.environment_id === values[0] && row.binding === values[1]),
            rows.some((row) => row.environment_id === values[0] && row.binding === values[1])
              ? 1
              : 0,
            {
              environment_id: values[0],
              binding: values[1],
              owner_worker: values[2],
              object_count: values[3],
              total_bytes: values[4],
              oldest_object_at: values[5],
              encryption_methods_json: values[6],
              retention_overdue_objects: values[7],
              retention_policy: values[8],
              scan_complete: values[9],
              measured_at: values[10],
              reported_at: values[11],
            }
          );
        }
        return { success: true, meta: { changes: 1 } };
      },
      async all<T>() {
        return {
          success: true,
          results: rows.filter((row) => row.environment_id === values[0]) as T[],
          meta: {},
        };
      },
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database;
}

const pluginMetric = {
  binding: 'PLUGIN_BUNDLES' as const,
  objectCount: 3,
  totalBytes: 512,
  oldestObjectAt: 1_000,
  encryptionMethods: { 'plugin-bundle': 3 },
  retentionOverdueObjects: null,
  retentionPolicy: 'Referenced signed bundles retained',
  scanComplete: true,
  measuredAt: 2_000,
};

describe('Control R2 bucket metric aggregation', () => {
  it('persists owner-scoped reports and returns explicit pending entries for missing buckets', async () => {
    const db = database();
    const inventory = await reportR2BucketMetrics(
      db,
      'test',
      'ar-plugin-runner',
      { metrics: [pluginMetric] },
      3_000
    );

    expect(inventory.metrics).toHaveLength(8);
    expect(inventory.metrics.find((metric) => metric.binding === 'PLUGIN_BUNDLES')).toMatchObject({
      ownerWorker: 'ar-plugin-runner',
      availability: 'current',
      objectCount: 3,
      reportedAt: 3_000,
    });
    expect(
      inventory.metrics.find((metric) => metric.binding === 'MIGRATION_RELEASES')
    ).toMatchObject({
      ownerWorker: 'ar-control',
      availability: 'pending',
      unavailableReason: 'metric_not_reported',
    });
  });

  it('rejects a reporter that attempts to claim another Worker owner bucket', async () => {
    await expect(
      reportR2BucketMetrics(database(), 'test', 'ar-plugin-runner', {
        metrics: [{ ...pluginMetric, binding: 'PUBLIC_ASSETS' }],
      })
    ).rejects.toThrow('invalid_r2_bucket_metric_report');
  });

  it('marks reports stale after the bounded freshness window', async () => {
    const db = database();
    await reportR2BucketMetrics(db, 'test', 'ar-plugin-runner', { metrics: [pluginMetric] }, 1_000);
    const inventory = await getR2BucketMetricInventory(db, 'test', 1_000 + 24 * 60 * 60 * 1000 + 1);
    expect(inventory.metrics.find((metric) => metric.binding === 'PLUGIN_BUNDLES')).toMatchObject({
      availability: 'stale',
      unavailableReason: 'metric_report_stale',
    });
  });
});
