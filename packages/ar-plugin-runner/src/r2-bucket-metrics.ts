import type { ControlR2BucketMetric } from '@authrim/ar-lib-core/control-plane';
import type { PluginRunnerEnv } from './types';

interface PluginBundleMetricAccumulator extends Omit<
  ControlR2BucketMetric,
  'scanComplete' | 'measuredAt'
> {
  binding: 'PLUGIN_BUNDLES';
  cursor: string | null;
  nextScanAt: number;
}

const RETENTION_POLICY = 'Referenced signed bundles retained; superseded bundles policy managed';

function emptyAccumulator(): PluginBundleMetricAccumulator {
  return {
    binding: 'PLUGIN_BUNDLES',
    cursor: null,
    nextScanAt: 0,
    objectCount: 0,
    totalBytes: 0,
    oldestObjectAt: null,
    encryptionMethods: {},
    retentionOverdueObjects: null,
    retentionPolicy: RETENTION_POLICY,
  };
}

export async function scanAndReportPluginBundleMetrics(
  env: PluginRunnerEnv,
  nowMs = Date.now()
): Promise<void> {
  if (!env.PLUGIN_BUNDLES || !env.CONTROL?.reportR2BucketMetrics) return;
  const stored = await env.PLUGIN_RUNNER_DB.prepare(
    `SELECT accumulator_json FROM plugin_runner_r2_metric_scan_state
      WHERE binding = 'PLUGIN_BUNDLES'`
  ).first<{ accumulator_json: string }>();
  let accumulator = emptyAccumulator();
  if (stored) {
    try {
      accumulator = JSON.parse(stored.accumulator_json) as PluginBundleMetricAccumulator;
    } catch {
      // Restart a corrupt, internal-only accumulator without exposing its contents.
    }
  }
  if (accumulator.nextScanAt > nowMs) return;
  const listed = await env.PLUGIN_BUNDLES.list({
    limit: 1000,
    cursor: accumulator.cursor ?? undefined,
  });
  for (const object of listed.objects) {
    const uploadedAt = object.uploaded instanceof Date ? object.uploaded.getTime() : nowMs;
    accumulator.objectCount += 1;
    accumulator.totalBytes += object.size;
    accumulator.oldestObjectAt =
      accumulator.oldestObjectAt === null
        ? uploadedAt
        : Math.min(accumulator.oldestObjectAt, uploadedAt);
    const method = 'plugin-bundle';
    accumulator.encryptionMethods[method] = (accumulator.encryptionMethods[method] ?? 0) + 1;
  }
  accumulator.cursor = listed.truncated ? (listed.cursor ?? null) : null;
  const nextAccumulator = listed.truncated
    ? accumulator
    : { ...emptyAccumulator(), nextScanAt: nowMs + 6 * 60 * 60 * 1000 };
  await env.PLUGIN_RUNNER_DB.prepare(
    `INSERT INTO plugin_runner_r2_metric_scan_state (binding, accumulator_json, updated_at)
     VALUES ('PLUGIN_BUNDLES', ?, ?)
     ON CONFLICT(binding) DO UPDATE SET
       accumulator_json = excluded.accumulator_json, updated_at = excluded.updated_at`
  )
    .bind(JSON.stringify(nextAccumulator), nowMs)
    .run();
  const metric: ControlR2BucketMetric = {
    binding: 'PLUGIN_BUNDLES',
    objectCount: accumulator.objectCount,
    totalBytes: accumulator.totalBytes,
    oldestObjectAt: accumulator.oldestObjectAt,
    encryptionMethods: accumulator.encryptionMethods,
    retentionOverdueObjects: accumulator.retentionOverdueObjects,
    retentionPolicy: accumulator.retentionPolicy,
    scanComplete: !listed.truncated,
    measuredAt: nowMs,
  };
  await env.CONTROL.reportR2BucketMetrics({ metrics: [metric] });
}
