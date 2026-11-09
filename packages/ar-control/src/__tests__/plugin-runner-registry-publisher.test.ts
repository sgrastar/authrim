import {
  buildPluginRunnerRegistryGenerationKey,
  buildPluginRunnerRegistrySnapshotKey,
} from '@authrim/ar-lib-core/control-plane';
import { describe, expect, it, vi } from 'vitest';
import { PluginRunnerRegistryPublisher } from '../plugin-runner-registry-publisher';
import type { ControlEnv } from '../types';

const now = 1_800_000_000;
const validShard = {
  shard_id: 'shard-a',
  binding_ref: 'TEST_TDB_DEFAULT_A',
  data_role: 'tenant_core/default',
  residency_partition: 'jp',
  generation: 1,
};

function fixture(
  options: {
    shards?: Array<Record<string, unknown>>;
    publication?: Record<string, unknown> | null;
    signingKey?: unknown;
  } = {}
) {
  let publication = options.publication ?? null;
  const calls: string[] = [];
  const put = vi.fn(async (key: string, _value: string) => {
    calls.push(key);
  });
  const run = vi.fn(async () => {
    if (publication) publication = { ...publication, status: 'active' };
    return { success: true, meta: { changes: 1 } };
  });
  const all = vi.fn(async () => ({
    success: true,
    results: options.shards ?? [validShard],
    meta: {},
  }));
  const first = vi.fn(async () => publication);
  const prepare = vi.fn((_sql: string) => ({
    bind: (..._values: unknown[]) => ({ first, all, run }),
  }));
  const env = {
    CONTROL_DB: { prepare },
    TENANT_RUNTIME_REGISTRY: { put },
    RUNTIME_REGISTRY_SIGNING_ACTIVE_SLOT: 'A',
    RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: JSON.stringify(
      options.signingKey ?? { kid: 'registry-key-a' }
    ),
    TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key-a',
  } as unknown as ControlEnv;
  return {
    env,
    put,
    run,
    all,
    prepare,
    calls,
    setPublication(next: Record<string, unknown>) {
      publication = next;
    },
  };
}

describe('Plugin runner registry publication guards', () => {
  it.each([
    ['unsafe shard identifier', { shard_id: '../tenant-b' }],
    ['unsafe binding reference', { binding_ref: 'TENANT_B_DATABASE' }],
    ['unsupported data role', { data_role: 'tenant_pii' }],
    ['unsafe residency partition', { residency_partition: 'JP/other' }],
    ['invalid route generation', { generation: 0 }],
  ])('rejects %s before signing or publishing', async (_reason, override) => {
    const f = fixture({ shards: [{ ...validShard, ...override }] });
    await expect(
      new PluginRunnerRegistryPublisher(f.env, () => now).publishEnvironment('test')
    ).rejects.toThrow('plugin_runner_registry_shard_invalid');
    expect(f.put).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('rejects an oversized shard inventory before signing or publishing', async () => {
    const f = fixture({ shards: Array.from({ length: 5_001 }, () => validShard) });
    await expect(
      new PluginRunnerRegistryPublisher(f.env, () => now).publishEnvironment('test')
    ).rejects.toThrow('plugin_runner_registry_shard_limit_exceeded');
    expect(f.put).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('rejects a mismatched signing key before persisting a publication', async () => {
    const f = fixture({ signingKey: { kid: 'old-key' } });
    await expect(
      new PluginRunnerRegistryPublisher(f.env, () => now).publishEnvironment('test')
    ).rejects.toThrow('plugin_runner_registry_signing_key_id_mismatch');
    expect(f.put).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('rejects an invalid environment identifier without querying or publishing', async () => {
    const f = fixture();
    await expect(
      new PluginRunnerRegistryPublisher(f.env, () => now).publishEnvironment('../test')
    ).rejects.toThrow('plugin_runner_registry_environment_invalid');
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });

  it('resumes a prepared snapshot before publishing its generation pointer', async () => {
    const f = fixture({
      publication: {
        environment_id: 'test',
        generation: 2,
        inventory_digest: 'digest',
        snapshot_jws: 'signed-snapshot',
        issued_at: now - 10,
        expires_at: now + 1_000,
        status: 'publishing',
      },
    });
    await expect(
      new PluginRunnerRegistryPublisher(f.env, () => now).publishEnvironment('test')
    ).resolves.toEqual({ environmentId: 'test', generation: 2, status: 'resumed' });
    expect(f.calls).toEqual([
      buildPluginRunnerRegistrySnapshotKey('test'),
      buildPluginRunnerRegistryGenerationKey('test'),
    ]);
    expect(f.all).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('does not activate a prepared publication when the generation pointer write fails', async () => {
    const f = fixture({
      publication: {
        environment_id: 'test',
        generation: 2,
        inventory_digest: 'digest',
        snapshot_jws: 'signed-snapshot',
        issued_at: now - 10,
        expires_at: now + 1_000,
        status: 'publishing',
      },
    });
    f.put.mockImplementationOnce(async (key) => {
      f.calls.push(key);
    });
    f.put.mockRejectedValueOnce(new Error('kv_unavailable'));

    await expect(
      new PluginRunnerRegistryPublisher(f.env, () => now).publishEnvironment('test')
    ).rejects.toThrow('kv_unavailable');
    expect(f.calls).toEqual([buildPluginRunnerRegistrySnapshotKey('test')]);
    expect(f.put.mock.calls[1]?.[0]).toBe(buildPluginRunnerRegistryGenerationKey('test'));
    expect(f.run).not.toHaveBeenCalled();
  });

  it('accepts an identical publication activated by another reconciler', async () => {
    const prepared = {
      environment_id: 'test',
      generation: 2,
      inventory_digest: 'digest',
      snapshot_jws: 'signed-snapshot',
      issued_at: now - 10,
      expires_at: now + 1_000,
      status: 'publishing',
    };
    const f = fixture({ publication: prepared });
    f.run.mockImplementation(async () => {
      f.setPublication({ ...prepared, status: 'active' });
      return { success: true, meta: { changes: 0 } };
    });

    await expect(
      new PluginRunnerRegistryPublisher(f.env, () => now).publishEnvironment('test')
    ).resolves.toEqual({ environmentId: 'test', generation: 2, status: 'resumed' });
    expect(f.calls).toEqual([
      buildPluginRunnerRegistrySnapshotKey('test'),
      buildPluginRunnerRegistryGenerationKey('test'),
    ]);
  });

  it('rejects a lost publication race after the KV writes', async () => {
    const f = fixture({
      publication: {
        environment_id: 'test',
        generation: 2,
        inventory_digest: 'digest',
        snapshot_jws: 'signed-snapshot',
        issued_at: now - 10,
        expires_at: now + 1_000,
        status: 'publishing',
      },
    });
    f.run.mockResolvedValue({ success: true, meta: { changes: 0 } });

    await expect(
      new PluginRunnerRegistryPublisher(f.env, () => now).publishEnvironment('test')
    ).rejects.toThrow('plugin_runner_registry_publication_stale');
    expect(f.put).toHaveBeenCalledTimes(2);
  });
});
