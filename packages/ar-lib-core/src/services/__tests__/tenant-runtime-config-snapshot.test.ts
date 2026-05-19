import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TENANT_RUNTIME_CONFIG_GENERATION_TTL_SECONDS,
  DEFAULT_TENANT_RUNTIME_CONFIG_SNAPSHOT_TTL_SECONDS,
  buildTenantRuntimeConfigGenerationKey,
  buildTenantRuntimeConfigSnapshotKey,
  parseTenantRuntimeConfigSnapshot,
  publishTenantRuntimeConfigSnapshot,
} from '../tenant-runtime-config-snapshot';

function createSnapshotStore() {
  return {
    put: vi.fn(async () => undefined),
  };
}

describe('tenant-runtime-config-snapshot', () => {
  it('publishes tenant settings snapshots to KV and bumps control DB generation metadata', async () => {
    const snapshotStore = createSnapshotStore();
    const repository = {
      upsertRuntimeCacheGeneration: vi.fn(async () => undefined),
    };

    const result = await publishTenantRuntimeConfigSnapshot({
      tenantId: 'tenant-a',
      namespace: 'settings',
      generation: 4,
      payload: {
        'login-entry.mode': 'discovery_required',
        'login-entry.selection_policy': 'select_if_multiple',
      },
      source: 'control_db',
      snapshotStore,
      repository: repository as never,
      actorId: 'system',
      now: new Date('2026-05-16T00:00:00.000Z'),
    });

    expect(result.snapshotKey).toBe(buildTenantRuntimeConfigSnapshotKey('tenant-a', 'settings'));
    expect(result.generationKey).toBe(
      buildTenantRuntimeConfigGenerationKey('tenant-a', 'settings')
    );
    expect(result.snapshot.metadata.payloadKeys).toEqual([
      'login-entry.mode',
      'login-entry.selection_policy',
    ]);
    expect(snapshotStore.put).toHaveBeenNthCalledWith(
      1,
      result.snapshotKey,
      JSON.stringify(result.snapshot),
      { expirationTtl: DEFAULT_TENANT_RUNTIME_CONFIG_SNAPSHOT_TTL_SECONDS }
    );
    expect(snapshotStore.put).toHaveBeenNthCalledWith(
      2,
      result.generationKey,
      JSON.stringify({
        generation: 4,
        publishedAt: '2026-05-16T00:00:00.000Z',
        expiresAt: '2026-05-16T00:05:00.000Z',
      }),
      { expirationTtl: DEFAULT_TENANT_RUNTIME_CONFIG_GENERATION_TTL_SECONDS }
    );
    expect(repository.upsertRuntimeCacheGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        cache_namespace: 'settings',
        generation: 4,
        updated_by: 'system',
      })
    );
  });

  it('publishes tenant policy snapshots sourced from the tenant durable store', async () => {
    const snapshotStore = createSnapshotStore();

    const result = await publishTenantRuntimeConfigSnapshot({
      tenantId: 'tenant-a',
      namespace: 'policy',
      generation: 7,
      payload: {
        contract_version: 2,
        resolved_policy_ref: 'tenant-policy:tenant-a:v7',
      },
      source: 'tenant_durable_store',
      snapshotStore,
      now: new Date('2026-05-16T00:00:00.000Z'),
    });

    expect(result.snapshot.metadata.source).toBe('tenant_durable_store');
    expect(result.snapshot.namespace).toBe('policy');
  });

  it('parses only fresh snapshots for the expected tenant, namespace, and generation', () => {
    const snapshot = {
      version: 1,
      tenantId: 'tenant-a',
      namespace: 'settings',
      generation: 4,
      publishedAt: '2026-05-16T00:00:00.000Z',
      expiresAt: '2026-05-16T00:05:00.000Z',
      payload: { key: 'value' },
      metadata: { payloadKeys: ['key'], source: 'control_db' },
    };

    expect(
      parseTenantRuntimeConfigSnapshot(JSON.stringify(snapshot), {
        tenantId: 'tenant-a',
        namespace: 'settings',
        minimumGeneration: 4,
        now: new Date('2026-05-16T00:04:00.000Z'),
      })
    ).toEqual(snapshot);
    expect(
      parseTenantRuntimeConfigSnapshot(JSON.stringify(snapshot), {
        tenantId: 'tenant-a',
        namespace: 'settings',
        minimumGeneration: 5,
        now: new Date('2026-05-16T00:04:00.000Z'),
      })
    ).toBeNull();
    expect(
      parseTenantRuntimeConfigSnapshot(JSON.stringify(snapshot), {
        tenantId: 'tenant-a',
        namespace: 'settings',
        now: new Date('2026-05-16T00:06:00.000Z'),
      })
    ).toBeNull();
  });
});
