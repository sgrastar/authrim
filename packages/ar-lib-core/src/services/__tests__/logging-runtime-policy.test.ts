import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeLoggingPolicySnapshot,
  publishRuntimeLoggingPolicySnapshot,
} from '@authrim/ar-lib-logging/policies';
import { resolveRuntimeLoggingPolicyTargetFromEnv } from '../logging-runtime-policy';

function createSnapshotStores() {
  const kvValues = new Map<string, string>();
  const objectValues = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => kvValues.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      kvValues.set(key, value);
    }),
  } as unknown as KVNamespace;
  const bucket = {
    put: vi.fn(async (key: string, value: string) => {
      objectValues.set(key, value);
    }),
    get: vi.fn(async (key: string) =>
      objectValues.has(key)
        ? {
            text: vi.fn(async () => objectValues.get(key) ?? ''),
          }
        : null
    ),
  } as unknown as R2Bucket;
  return { kv, bucket };
}

describe('runtime logging policy resolver', () => {
  it('marks the fresh-environment R2 archive as direct delivery', async () => {
    const { bucket } = createSnapshotStores();

    const resolved = await resolveRuntimeLoggingPolicyTargetFromEnv(
      { AUDIT_ARCHIVE: bucket },
      {
        tenantId: 'tenant-fresh-environment',
        logType: 'admin_audit',
        plane: 'archive',
      }
    );

    expect(resolved).toMatchObject({
      destinationId: 'platform_default_r2_archive',
      destination: null,
      requiresDeliveryFanout: false,
      target: {
        type: 'r2',
        destinationId: 'platform_default_r2_archive',
        bucketRef: 'AUDIT_ARCHIVE',
      },
    });
  });

  it('resolves webhook external sink targets from tenant snapshots without repeated KV reads', async () => {
    const tenantId = 'tenant-webhook-runtime';
    const { kv, bucket } = createSnapshotStores();
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: tenantId,
      version: 1,
      snapshotId: 'snap_webhook_runtime',
      synchronizedAt: 1_700_000_000_000,
      sourceUpdatedAt: 1_700_000_000_000,
      policies: {
        assignments: [
          {
            id: 'lpa_webhook_sink',
            tenant_id: tenantId,
            log_type: 'webhook',
            plane: 'external_sink',
            destination_id: 'dest_webhook_http',
            enabled: 1,
            managed_by: 'tenant',
            lane: 'default',
            version: 1,
          },
        ],
        fallbacks: [],
        destinations: [
          {
            id: 'dest_webhook_http',
            scope_type: 'shared',
            scope_id: null,
            destination_kind: 'http_sink',
            provider: 'http',
            name: 'webhook-collector',
            display_name: 'Webhook Collector',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({
              urlRef: 'secret://logging/webhook-collector/url',
              headers: { 'X-Authrim-Log-Type': 'webhook' },
            }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(['webhook']),
            allowed_planes: JSON.stringify(['external_sink']),
            region: null,
            critical_allowed: 0,
            default_fallback_eligible: 0,
            retention_days: 30,
            encryption_mode: 'platform_managed',
          },
        ],
      },
    });
    await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv,
      objectStore: bucket,
      now: 1_700_000_000_000,
    });
    vi.mocked(kv.get).mockClear();
    vi.mocked(bucket.get).mockClear();

    const env = { AUTHRIM_CONFIG: kv, DIAGNOSTIC_LOGS: bucket };
    const first = await resolveRuntimeLoggingPolicyTargetFromEnv(env, {
      tenantId,
      logType: 'webhook',
      plane: 'external_sink',
    });
    const second = await resolveRuntimeLoggingPolicyTargetFromEnv(env, {
      tenantId,
      logType: 'webhook',
      plane: 'external_sink',
    });

    expect(first?.destinationId).toBe('dest_webhook_http');
    expect(first?.source).toBe('tenant_assignment');
    expect(first?.requiresDeliveryFanout).toBe(true);
    expect(first?.target).toEqual({
      type: 'http',
      destinationId: 'dest_webhook_http',
      urlRef: 'secret://logging/webhook-collector/url',
      method: 'POST',
      headers: { 'X-Authrim-Log-Type': 'webhook' },
      format: 'json',
    });
    expect(second).toEqual(first);
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(bucket.get).toHaveBeenCalledTimes(1);
  });

  it('falls back to platform snapshots for job archive routing', async () => {
    const tenantId = 'tenant-job-runtime';
    const { kv, bucket } = createSnapshotStores();
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'platform',
      scopeId: 'global',
      version: 1,
      snapshotId: 'snap_job_platform_runtime',
      synchronizedAt: 1_700_000_000_000,
      sourceUpdatedAt: 1_700_000_000_000,
      policies: {
        assignments: [
          {
            id: 'lpa_job_archive',
            tenant_id: null,
            log_type: 'job',
            plane: 'archive',
            destination_id: 'dest_job_archive',
            enabled: 1,
            managed_by: 'platform',
            lane: 'default',
            version: 1,
          },
        ],
        fallbacks: [],
        destinations: [
          {
            id: 'dest_job_archive',
            scope_type: 'platform',
            scope_id: 'global',
            destination_kind: 'object_storage',
            provider: 'r2',
            name: 'job-archive',
            display_name: 'Job Archive',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({
              bindingRef: 'DIAGNOSTIC_LOGS',
              prefix: 'job-chunks',
            }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(['job']),
            allowed_planes: JSON.stringify(['archive']),
            region: null,
            critical_allowed: 0,
            default_fallback_eligible: 1,
            retention_days: 30,
            encryption_mode: 'platform_managed',
          },
        ],
      },
    });
    await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv,
      objectStore: bucket,
      now: 1_700_000_000_000,
    });
    vi.mocked(kv.get).mockClear();
    vi.mocked(bucket.get).mockClear();

    const resolved = await resolveRuntimeLoggingPolicyTargetFromEnv(
      { AUTHRIM_CONFIG: kv, DIAGNOSTIC_LOGS: bucket },
      {
        tenantId,
        logType: 'job',
        plane: 'archive',
      }
    );

    expect(resolved?.source).toBe('platform_assignment');
    expect(resolved?.target).toEqual({
      type: 'r2',
      destinationId: 'dest_job_archive',
      bucketRef: 'DIAGNOSTIC_LOGS',
      prefix: 'job-chunks',
    });
    expect(kv.get).toHaveBeenCalledTimes(2);
    expect(bucket.get).toHaveBeenCalledTimes(1);
  });

  it('respects runtime residency when selecting fallback destinations', async () => {
    const tenantId = 'tenant-eu-runtime';
    const { kv, bucket } = createSnapshotStores();
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: tenantId,
      version: 1,
      snapshotId: 'snap_runtime_region',
      synchronizedAt: 1_700_000_000_000,
      sourceUpdatedAt: 1_700_000_000_000,
      policies: {
        assignments: [
          {
            id: 'lpa_webhook_enam',
            tenant_id: tenantId,
            log_type: 'webhook',
            plane: 'external_sink',
            destination_id: 'dest_enam_http',
            enabled: 1,
            managed_by: 'tenant',
            lane: 'default',
            version: 1,
          },
        ],
        fallbacks: [
          {
            id: 'fb_webhook_weur',
            scope_type: 'tenant',
            scope_id: tenantId,
            log_type: 'webhook',
            plane: 'external_sink',
            fallback_destination_id: 'dest_weur_http',
            failure_mode: 'retry_then_platform_default',
            version: 1,
          },
        ],
        destinations: [
          {
            id: 'dest_enam_http',
            scope_type: 'shared',
            scope_id: null,
            destination_kind: 'http_sink',
            provider: 'http',
            name: 'enam-collector',
            display_name: 'ENAM Collector',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({ url: 'https://enam.example.test/logs' }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(['webhook']),
            allowed_planes: JSON.stringify(['external_sink']),
            region: 'enam',
            critical_allowed: 0,
            default_fallback_eligible: 0,
            retention_days: 30,
            encryption_mode: 'platform_managed',
          },
          {
            id: 'dest_weur_http',
            scope_type: 'shared',
            scope_id: null,
            destination_kind: 'http_sink',
            provider: 'http',
            name: 'weur-collector',
            display_name: 'WEUR Collector',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({ url: 'https://weur.example.test/logs' }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(['webhook']),
            allowed_planes: JSON.stringify(['external_sink']),
            region: 'weur',
            critical_allowed: 0,
            default_fallback_eligible: 1,
            retention_days: 30,
            encryption_mode: 'platform_managed',
          },
        ],
      },
    });
    await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv,
      objectStore: bucket,
      now: 1_700_000_000_000,
    });

    const resolved = await resolveRuntimeLoggingPolicyTargetFromEnv(
      { AUTHRIM_CONFIG: kv, DIAGNOSTIC_LOGS: bucket },
      {
        tenantId,
        logType: 'webhook',
        plane: 'external_sink',
        region: 'weur',
      }
    );

    expect(resolved?.selectedDestinationId).toBe('dest_enam_http');
    expect(resolved?.destinationId).toBeNull();
    expect(resolved?.fallbackDestinationId).toBe('dest_weur_http');
    expect(resolved?.failureMode).toBe('retry_then_platform_default');
    expect(resolved?.warnings).toContain('destination_unusable');
    expect(resolved?.target).toEqual({
      type: 'http',
      destinationId: 'dest_weur_http',
      url: 'https://weur.example.test/logs',
      method: 'POST',
      format: 'json',
    });
  });
});
