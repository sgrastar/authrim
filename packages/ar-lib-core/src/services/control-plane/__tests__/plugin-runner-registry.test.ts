import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  buildPluginRunnerRegistryGenerationKey,
  buildPluginRunnerRegistrySnapshotKey,
  loadVerifiedPluginRunnerRegistry,
  signPluginRunnerRegistry,
  verifyPluginRunnerRegistry,
  type PluginRunnerRegistryInput,
} from '../plugin-runner-registry';

async function keys() {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  return {
    privateJwk: { ...(await exportJWK(pair.privateKey)), kid: 'runner-key-a', alg: 'EdDSA' },
    publicJwk: { ...(await exportJWK(pair.publicKey)), kid: 'runner-key-a', alg: 'EdDSA' },
  };
}

function registry(overrides: Partial<PluginRunnerRegistryInput> = {}): PluginRunnerRegistryInput {
  return {
    environmentId: 'test',
    generation: 3,
    issuedAt: 1_000,
    expiresAt: 2_000,
    shards: [
      {
        shardId: 'shard-a',
        bindingRef: 'TEST_TDB_DEFAULT_JP_0001_CORE',
        dataRole: 'tenant_core/default',
        residencyPartition: 'jp',
        routeGeneration: 1,
      },
      {
        shardId: 'shard-b',
        bindingRef: 'TEST_TDB_USERS_JP_0001_CORE',
        dataRole: 'tenant_core/users',
        residencyPartition: 'jp',
        routeGeneration: 2,
      },
    ],
    ...overrides,
  };
}

describe('Plugin Runner signed shard registry', () => {
  it('round-trips a strict Ed25519 inventory and fixed KV keys', async () => {
    const { privateJwk, publicJwk } = await keys();
    const token = await signPluginRunnerRegistry({ registry: registry(), privateJwk });

    await expect(
      verifyPluginRunnerRegistry({
        token,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: 1_500,
      })
    ).resolves.toMatchObject({ environmentId: 'test', generation: 3 });
    expect(buildPluginRunnerRegistrySnapshotKey('test')).toBe(
      'environment:test:plugin-runner-registry:snapshot'
    );
    expect(buildPluginRunnerRegistryGenerationKey('test')).toBe(
      'environment:test:plugin-runner-registry:generation'
    );
  });

  it('rejects tampering, cross-environment use, expiry, and private verification keys', async () => {
    const { privateJwk, publicJwk } = await keys();
    const token = await signPluginRunnerRegistry({ registry: registry(), privateJwk });
    const segments = token.split('.');
    const payloadOffset = Math.floor(segments[1].length / 2);
    segments[1] = `${segments[1].slice(0, payloadOffset)}${
      segments[1][payloadOffset] === 'a' ? 'b' : 'a'
    }${segments[1].slice(payloadOffset + 1)}`;
    const tampered = segments.join('.');

    await expect(
      verifyPluginRunnerRegistry({
        token: tampered,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: 1_500,
      })
    ).rejects.toThrow('plugin_runner_registry_signature_invalid');
    await expect(
      verifyPluginRunnerRegistry({
        token,
        environmentId: 'other',
        publicJwks: { keys: [publicJwk] },
        now: 1_500,
      })
    ).rejects.toThrow('plugin_runner_registry_claims_invalid');
    await expect(
      verifyPluginRunnerRegistry({
        token,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: 2_010,
      })
    ).rejects.toThrow('plugin_runner_registry_claims_invalid');
    await expect(
      verifyPluginRunnerRegistry({
        token,
        environmentId: 'test',
        publicJwks: { keys: [privateJwk] },
        now: 1_500,
      })
    ).rejects.toThrow('plugin_runner_registry_public_jwks_private_material');
  });

  it('rejects duplicate, unsorted, malformed, and PII shard entries before signing', async () => {
    const { privateJwk } = await keys();
    const valid = registry().shards[0];
    await expect(
      signPluginRunnerRegistry({ registry: registry({ shards: [valid, valid] }), privateJwk })
    ).rejects.toThrow('plugin_runner_registry_shard_invalid');
    await expect(
      signPluginRunnerRegistry({
        registry: registry({ shards: [...registry().shards].reverse() }),
        privateJwk,
      })
    ).rejects.toThrow('plugin_runner_registry_shards_not_sorted');
    await expect(
      signPluginRunnerRegistry({
        registry: registry({
          shards: [{ ...valid, dataRole: 'tenant_pii' } as never],
        }),
        privateJwk,
      })
    ).rejects.toThrow('plugin_runner_registry_shard_invalid');
  });

  it('loads snapshot and generation atomically enough to reject pointer mismatch', async () => {
    const { privateJwk, publicJwk } = await keys();
    const token = await signPluginRunnerRegistry({ registry: registry(), privateJwk });
    const values = new Map([
      [buildPluginRunnerRegistrySnapshotKey('test'), token],
      [buildPluginRunnerRegistryGenerationKey('test'), '3'],
    ]);
    const store = { get: async (key: string) => values.get(key) ?? null };

    await expect(
      loadVerifiedPluginRunnerRegistry({
        store,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: 1_500,
      })
    ).resolves.toMatchObject({ generation: 3 });
    values.set(buildPluginRunnerRegistryGenerationKey('test'), '4');
    await expect(
      loadVerifiedPluginRunnerRegistry({
        store,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: 1_500,
      })
    ).rejects.toThrow('plugin_runner_registry_generation_mismatch');
  });
});
