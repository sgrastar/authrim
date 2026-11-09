import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import {
  generateRegionShardedAuthCode,
  getAuthCodeStoreByCode,
  getAuthCodeStoreForNewCode,
  isRegionShardedAuthCode,
  parseRegionShardedAuthCode,
} from '../authcode-helper';
import {
  buildPolicyConstrainedRegionShardConfig,
  clearRegionShardConfigCache,
  resolveShardForNewResource,
} from '../region-sharding';

const config = buildPolicyConstrainedRegionShardConfig({
  residency: {
    version: 1,
    residencyPolicyId: 'policy-eu',
    residencyPartition: 'eu',
    policyGeneration: 1,
    allowedRegions: ['weur', 'eeur'],
    jurisdiction: 'eu',
  },
  totalShards: 4,
  now: 1_000,
});

function environment() {
  const stub = { fetch: vi.fn() };
  const idFromName = vi.fn((name: string) => `id:${name}`);
  const get = vi.fn(() => stub);
  const jurisdiction = vi.fn();
  const namespace = { idFromName, get, jurisdiction };
  jurisdiction.mockReturnValue(namespace);
  const configGet = vi.fn(async () => config);
  const env = {
    AUTHRIM_CONFIG: { get: configGet },
    AUTH_CODE_STORE: namespace,
  } as unknown as Env;
  return { env, stub, idFromName, get, jurisdiction, configGet };
}

beforeEach(() => clearRegionShardConfigCache());
afterEach(() => {
  clearRegionShardConfigCache();
  vi.restoreAllMocks();
});

describe('region-sharded authorization code parsing', () => {
  it('extracts only authorization codes and retains opaque code bytes', () => {
    expect(parseRegionShardedAuthCode('g2:weur_j_eu:3:ac_opaque_123')).toEqual({
      generation: 2,
      regionKey: 'weur_j_eu',
      shardIndex: 3,
      randomPart: 'ac_opaque_123',
      opaqueCode: 'opaque_123',
    });
    expect(isRegionShardedAuthCode('g2:weur_j_eu:3:ac_opaque_123')).toBe(true);
  });

  it.each([
    'not-a-sharded-code',
    'g1:weur:0:ses_not-an-auth-code',
    'g1:weur:0:',
    'g1:weur:bad:ac_opaque',
  ])('rejects malformed or other-resource identifiers: %s', (code) => {
    expect(parseRegionShardedAuthCode(code)).toBeNull();
    expect(isRegionShardedAuthCode(code)).toBe(false);
  });
});

describe('region-sharded authorization code routing', () => {
  it('derives the shard from the user and client pair and retains it in the code', async () => {
    const { env, configGet } = environment();
    const expected = resolveShardForNewResource(config, 'user-a:client-a');

    const minted = await generateRegionShardedAuthCode(
      env,
      'user-a',
      'client-a',
      'random-code',
      'tenant-a'
    );

    expect(minted).toEqual({
      authCode: `g1:${expected.regionKey}:${expected.shardIndex}:ac_random-code`,
      shardIndex: expected.shardIndex,
      regionKey: expected.regionKey,
      generation: 1,
    });
    expect(parseRegionShardedAuthCode(minted.authCode)?.opaqueCode).toBe('random-code');
    expect(configGet).toHaveBeenCalledExactlyOnceWith('region_shard_config:tenant-a', {
      type: 'json',
    });
  });

  it('routes an existing code to its embedded tenant, region, and shard', () => {
    const { env, stub, idFromName, get, jurisdiction, configGet } = environment();

    const result = getAuthCodeStoreByCode(env, 'g2:weur_j_eu:3:ac_opaque', 'tenant-b');

    expect(result).toEqual({
      stub,
      resolution: { generation: 2, regionKey: 'weur_j_eu', shardIndex: 3 },
      instanceName: 'tenant-b:weur_j_eu:acd:3',
      opaqueCode: 'opaque',
    });
    expect(jurisdiction).toHaveBeenCalledExactlyOnceWith('eu');
    expect(idFromName).toHaveBeenCalledExactlyOnceWith('tenant-b:weur_j_eu:acd:3');
    expect(get).toHaveBeenCalledExactlyOnceWith('id:tenant-b:weur_j_eu:acd:3', {
      locationHint: 'weur',
    });
    expect(configGet).not.toHaveBeenCalled();
  });

  it('mints a code and obtains its matching Durable Object without crossing tenants', async () => {
    const { env, stub, idFromName, get, jurisdiction, configGet } = environment();

    const result = await getAuthCodeStoreForNewCode(
      env,
      'user-a',
      'client-a',
      'opaque',
      'tenant-a'
    );

    expect(result.stub).toBe(stub);
    expect(result.authCode).toBe(
      `g${result.resolution.generation}:${result.resolution.regionKey}:${result.resolution.shardIndex}:ac_opaque`
    );
    expect(result.instanceName).toBe(
      `tenant-a:${result.resolution.regionKey}:acd:${result.resolution.shardIndex}`
    );
    expect(jurisdiction).toHaveBeenCalledExactlyOnceWith('eu');
    expect(idFromName).toHaveBeenCalledExactlyOnceWith(result.instanceName);
    expect(get).toHaveBeenCalledExactlyOnceWith(`id:${result.instanceName}`, {
      locationHint: result.resolution.regionKey.replace('_j_eu', ''),
    });
    expect(configGet).toHaveBeenCalledOnce();
  });

  it('rejects a malformed code before any Durable Object lookup', () => {
    const { env, idFromName, get, jurisdiction } = environment();

    expect(() => getAuthCodeStoreByCode(env, 'g1:weur:2:ses_session', 'tenant-a')).toThrow(
      'Invalid region-sharded auth code format'
    );
    expect(idFromName).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(jurisdiction).not.toHaveBeenCalled();
  });

  it('fails before opening a Durable Object when the tenant has no placement config', async () => {
    const { env, idFromName, get } = environment();
    env.AUTHRIM_CONFIG.get = vi.fn(async () => null) as typeof env.AUTHRIM_CONFIG.get;

    await expect(
      getAuthCodeStoreForNewCode(env, 'user-a', 'client-a', 'opaque', 'tenant-a')
    ).rejects.toThrow('region_shard_config_missing');
    expect(idFromName).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
