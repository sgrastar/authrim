import { describe, expect, it, vi } from 'vitest';
import type { queryD1Rows } from '../core/cloudflare.js';
import { loadPluginRunnerResourceBindingsForDeployment } from '../core/plugin-resource-deployment-projection.js';

function queryWithRows(rows: unknown[]) {
  return vi.fn(async <T extends Record<string, unknown>>(_database: string, sql: string) => {
    if (sql.includes('sqlite_master')) {
      return [{ name: 'control_plugin_desired_resources' }] as T[];
    }
    return rows as T[];
  }) as unknown as typeof queryD1Rows;
}

describe('Plugin resource deployment projection', () => {
  it('derives exact environment-scoped D1, KV, and R2 bindings from active desired state', async () => {
    const query = queryWithRows([
      {
        resource_kind: 'd1',
        lifecycle_mode: 'managed',
        provider_resource_id: 'database-id',
        provider_name: 'database-name',
        provider_create_state: 'identified',
        provider_creation_date: null,
        provider_ownership_marker_key: null,
        provider_ownership_id: null,
        provider_identity_checkpointed_at: 10,
        ownership_fingerprint: 'a'.repeat(64),
      },
      {
        resource_kind: 'kv_namespace',
        lifecycle_mode: 'managed',
        provider_resource_id: 'namespace-id',
        provider_name: 'namespace-name',
        provider_create_state: 'identified',
        provider_creation_date: null,
        provider_ownership_marker_key: null,
        provider_ownership_id: null,
        provider_identity_checkpointed_at: 10,
        ownership_fingerprint: 'b'.repeat(64),
      },
      {
        resource_kind: 'r2_bucket',
        lifecycle_mode: 'managed',
        provider_resource_id: 'bucket-name',
        provider_name: 'bucket-name',
        provider_create_state: 'identified',
        provider_creation_date: '2026-08-31T00:00:00.000Z',
        provider_ownership_marker_key: '.authrim/ownership/test',
        provider_ownership_id: 'ownership-id',
        provider_identity_checkpointed_at: 10,
        ownership_fingerprint: 'c'.repeat(64),
      },
    ]);

    const result = await loadPluginRunnerResourceBindingsForDeployment({
      controlDatabaseName: 'test-control-db',
      environmentId: 'test',
      query,
    });

    expect(result).toEqual([
      {
        binding: `PRES_D1_${'A'.repeat(24)}`,
        kind: 'd1',
        providerResourceId: 'database-id',
        providerName: 'database-name',
      },
      {
        binding: `PRES_KV_${'B'.repeat(24)}`,
        kind: 'kv_namespace',
        providerResourceId: 'namespace-id',
        providerName: 'namespace-name',
      },
      {
        binding: `PRES_R2_${'C'.repeat(24)}`,
        kind: 'r2_bucket',
        providerResourceId: 'bucket-name',
        providerName: 'bucket-name',
      },
    ]);
    expect(query).toHaveBeenLastCalledWith(
      'test-control-db',
      expect.stringContaining("WHERE environment_id = 'test' AND status IN ('ready', 'active')")
    );
  });

  it('returns no bindings before the plugin desired-state schema exists', async () => {
    const query = vi.fn(async () => []) as unknown as typeof queryD1Rows;

    await expect(
      loadPluginRunnerResourceBindingsForDeployment({
        controlDatabaseName: 'test-control-db',
        environmentId: 'test',
        query,
      })
    ).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('fails closed on malformed ownership or provider projection', async () => {
    const malformedFingerprint = queryWithRows([
      {
        resource_kind: 'd1',
        provider_resource_id: 'database-id',
        provider_name: 'database-name',
        ownership_fingerprint: 'not-a-digest',
      },
    ]);
    const mismatchedR2 = queryWithRows([
      {
        resource_kind: 'r2_bucket',
        provider_resource_id: 'bucket-id',
        provider_name: 'bucket-name',
        ownership_fingerprint: 'c'.repeat(64),
      },
    ]);

    await expect(
      loadPluginRunnerResourceBindingsForDeployment({
        controlDatabaseName: 'test-control-db',
        environmentId: 'test',
        query: malformedFingerprint,
      })
    ).rejects.toThrow('plugin_resource_projection_row_invalid');
    await expect(
      loadPluginRunnerResourceBindingsForDeployment({
        controlDatabaseName: 'test-control-db',
        environmentId: 'test',
        query: mismatchedR2,
      })
    ).rejects.toThrow('plugin_resource_projection_row_invalid');
  });

  it('rejects managed ready resources without immutable provider evidence', async () => {
    const unverifiedR2 = queryWithRows([
      {
        resource_kind: 'r2_bucket',
        lifecycle_mode: 'managed',
        provider_resource_id: 'bucket-name',
        provider_name: 'bucket-name',
        provider_create_state: 'not_started',
        provider_creation_date: null,
        provider_ownership_marker_key: null,
        provider_ownership_id: null,
        provider_identity_checkpointed_at: null,
        ownership_fingerprint: 'c'.repeat(64),
      },
    ]);

    await expect(
      loadPluginRunnerResourceBindingsForDeployment({
        controlDatabaseName: 'test-control-db',
        environmentId: 'test',
        query: unverifiedR2,
      })
    ).rejects.toThrow('plugin_resource_projection_row_invalid');
  });
});
