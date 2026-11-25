import {
  buildTenantRuntimeRegistryGenerationKey,
  buildTenantRuntimeRegistrySnapshotKey,
} from '@authrim/ar-lib-core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { NOW, repository, service } from './support/shard-cleanup-fixtures';
import {
  registryDocuments,
  signingKeys,
  type SnapshotOptions,
} from './support/registry-snapshot-fixtures';

type Keys = Awaited<ReturnType<typeof signingKeys>>;
let keys: Keys;
let otherKeys: Keys;
beforeAll(async () => {
  keys = await signingKeys();
  otherKeys = await signingKeys('other-key');
});

const TARGET = {
  operationId: 'quarantine-op',
  environmentId: 'env-1',
  shardId: 'shard-1',
  bindingRef: 'TDB_RETIRED_DEFAULT',
  databaseId: 'database-retired',
  denyRegistryGeneration: 1,
  drainNotBefore: NOW - 1,
  retryBudgetStartedAt: NOW - 10,
  tenants: [{ tenantId: 'tenant-a', minimumRuntimeGeneration: 10 }],
};

async function reconcileWith(
  options: Partial<SnapshotOptions> = {},
  overrides: {
    generation?: (document: Record<string, unknown>) => Record<string, unknown>;
    deploymentTarget?: string | undefined;
    keysOverride?: unknown;
  } = {}
) {
  const documents = await registryDocuments({
    privateJwk: keys.privateJwk,
    kid: keys.kid,
    publishedAt: NOW - 60,
    ...options,
  });
  const generation = overrides.generation
    ? JSON.stringify(
        overrides.generation(JSON.parse(documents.generation) as Record<string, unknown>)
      )
    : documents.generation;
  const target = overrides.deploymentTarget ?? 'default';
  const repo = repository();
  repo.listDueQuarantines.mockResolvedValue([TARGET]);
  repo.listDueCleanups.mockResolvedValue([]);
  repo.countActiveReferences.mockResolvedValue(0);
  const get = vi
    .fn()
    .mockImplementation((key: string) =>
      Promise.resolve(
        key === buildTenantRuntimeRegistrySnapshotKey('tenant-a', target)
          ? documents.snapshot
          : key === buildTenantRuntimeRegistryGenerationKey('tenant-a', target)
            ? generation
            : null
      )
    );
  const { instance } = service(repo, {
    registry: { get },
    registryVerificationKeys: overrides.keysOverride ?? [
      { publicJwk: keys.publicJwk, keyId: keys.kid },
    ],
    deploymentTarget: overrides.deploymentTarget ?? 'default',
  });
  const result = await instance.reconcile();
  return { repo, result, get };
}

const MISMATCH = 'control_shard_quarantine_registry_readback_mismatch';
const blockedWith = (repo: ReturnType<typeof repository>) =>
  repo.markQuarantineBlocked.mock.calls[0]?.[1] as unknown;

describe('quarantine registry verification', () => {
  it('records tenant evidence for a fresh snapshot signed by a trusted key', async () => {
    const { repo, result, get } = await reconcileWith();
    expect(result).toMatchObject({ quarantineReady: 1, blocked: 0 });
    expect(repo.recordQuarantineTenantEvidence).toHaveBeenCalledExactlyOnceWith({
      operationId: 'quarantine-op',
      tenantId: 'tenant-a',
      runtimeGeneration: 10,
      quarantineDenyGeneration: 0,
      publishedAt: NOW - 60,
      expiresAt: NOW - 60 + 1800,
      now: NOW,
    });
    expect(get.mock.calls.map((call) => call[0] as string).sort()).toEqual(
      [
        buildTenantRuntimeRegistrySnapshotKey('tenant-a', 'default'),
        buildTenantRuntimeRegistryGenerationKey('tenant-a', 'default'),
      ].sort()
    );
  });

  it('reads the keys of the configured deployment target', async () => {
    const { result, get } = await reconcileWith(
      { deploymentTarget: 'blue' },
      { deploymentTarget: 'blue' }
    );
    expect(result.quarantineReady).toBe(1);
    expect(get.mock.calls.some((call) => String(call[0]).includes('blue'))).toBe(true);
  });

  it('accepts a runtime generation equal to the minimum and a window of exactly thirty minutes', async () => {
    const { result } = await reconcileWith({ runtimeGeneration: 10, expiresInSeconds: 1800 });
    expect(result.quarantineReady).toBe(1);
  });

  it.each([
    ['older runtime generation', { runtimeGeneration: 9 }, undefined],
    ['other tenant', { tenantId: 'tenant-b' }, undefined],
    ['other deployment target', { deploymentTarget: 'green' }, undefined],
    ['other snapshot version', { version: 3 }, undefined],
    ['window over thirty minutes', { expiresInSeconds: 1801 }, undefined],
    ['already expired', { publishedAt: NOW - 3600, expiresInSeconds: 1800 }, undefined],
    ['expiring this very second', { publishedAt: NOW - 1800, expiresInSeconds: 1800 }, undefined],
    ['published in the future', { publishedAt: NOW + 1, expiresInSeconds: 100 }, undefined],
    ['zero length window', { expiresInSeconds: 0 }, undefined],
    ['negative window', { expiresInSeconds: -5 }, undefined],
    ['unparsable publication time', { publishedAtOverride: 'yesterday' }, undefined],
    ['unparsable expiry', { expiresAtOverride: 'tomorrow' }, undefined],
    ['still routing to the retired binding', { storeBindingRef: 'TDB_RETIRED_DEFAULT' }, undefined],
    ['still routing to the retired database', { storeDatabaseId: 'database-retired' }, undefined],
    [
      'a second store routing to the retired binding',
      { extraStores: [{ bindingRef: 'TDB_RETIRED_DEFAULT', databaseId: 'database-other' }] },
      undefined,
    ],
    [
      'a second store routing to the retired database',
      { extraStores: [{ bindingRef: 'TDB_OTHER', databaseId: 'database-retired' }] },
      undefined,
    ],
  ])('blocks a snapshot with %s', async (_name, options, generation) => {
    const { repo, result } = await reconcileWith(options, {
      generation,
      deploymentTarget:
        (options as Partial<SnapshotOptions>).deploymentTarget === 'green' ? 'default' : undefined,
    });
    expect(result.blocked).toBe(1);
    expect(blockedWith(repo)).toBe(MISMATCH);
    expect(repo.recordQuarantineTenantEvidence).not.toHaveBeenCalled();
  });

  it('accepts several stores that avoid the retired shard', async () => {
    const { result } = await reconcileWith({
      extraStores: [{ bindingRef: 'TDB_OTHER', databaseId: 'database-other' }],
    });
    expect(result.quarantineReady).toBe(1);
  });

  it('accepts a window that starts exactly now', async () => {
    const { result } = await reconcileWith({ publishedAt: NOW, expiresInSeconds: 60 });
    expect(result.quarantineReady).toBe(1);
  });

  it.each([
    ['runtime generation', (doc: Record<string, unknown>) => ({ ...doc, runtimeGeneration: 11 })],
    ['route status', (doc: Record<string, unknown>) => ({ ...doc, routeStatus: 'draining' })],
    [
      'deny generation',
      (doc: Record<string, unknown>) => ({ ...doc, quarantineDenyGeneration: 3 }),
    ],
  ])('blocks when the generation document disagrees on the %s', async (_name, generation) => {
    const { repo, result } = await reconcileWith({}, { generation });
    expect(result.blocked).toBe(1);
    expect(blockedWith(repo)).toBe(MISMATCH);
  });

  it('blocks a snapshot signed by an untrusted key', async () => {
    const { repo, result } = await reconcileWith(
      {},
      { keysOverride: [{ publicJwk: otherKeys.publicJwk, keyId: otherKeys.kid }] }
    );
    expect(result.blocked).toBe(1);
    expect(blockedWith(repo)).toBe(MISMATCH);
  });

  it.each([
    ['a string', 'x'],
    ['an object', {}],
    ['null', null],
  ])('blocks a correctly signed snapshot whose stores are %s', async (_name, storesOverride) => {
    const { repo, result } = await reconcileWith({ storesOverride });
    expect(result).toMatchObject({ blocked: 1, waitingRetry: 0 });
    expect(repo.markQuarantineBlocked).toHaveBeenCalledExactlyOnceWith(
      'quarantine-op',
      MISMATCH,
      NOW
    );
  });

  it('verifies every tenant before the quarantine becomes ready', async () => {
    const documents = await registryDocuments({
      privateJwk: keys.privateJwk,
      kid: keys.kid,
      publishedAt: NOW - 60,
    });
    const repo = repository();
    repo.listDueQuarantines.mockResolvedValue([
      {
        ...TARGET,
        tenants: [
          { tenantId: 'tenant-a', minimumRuntimeGeneration: 1 },
          { tenantId: 'tenant-b', minimumRuntimeGeneration: 1 },
        ],
      },
    ]);
    repo.listDueCleanups.mockResolvedValue([]);
    repo.countActiveReferences.mockResolvedValue(0);
    const { instance } = service(repo, {
      registry: {
        get: vi
          .fn()
          .mockImplementation((key: string) =>
            Promise.resolve(
              key === buildTenantRuntimeRegistryGenerationKey('tenant-a', 'default')
                ? documents.generation
                : key === buildTenantRuntimeRegistrySnapshotKey('tenant-a', 'default')
                  ? documents.snapshot
                  : null
            )
          ),
      },
      registryVerificationKeys: [{ publicJwk: keys.publicJwk, keyId: keys.kid }],
    });
    const result = await instance.reconcile();
    expect(repo.recordQuarantineTenantEvidence).toHaveBeenCalledTimes(1);
    expect(result.waitingRetry).toBe(1);
    expect(repo.markQuarantineReady).not.toHaveBeenCalled();
  });

  it.each([
    ['no store', { registryVerificationKeys: [{ publicJwk: {}, keyId: 'k' }] }],
    ['no keys', { registry: { get: vi.fn() }, registryVerificationKeys: [] }],
    ['undefined keys', { registry: { get: vi.fn() }, registryVerificationKeys: undefined }],
  ])('blocks tenants when the verifier has %s', async (_name, overrides) => {
    const repo = repository();
    repo.listDueQuarantines.mockResolvedValue([TARGET]);
    repo.listDueCleanups.mockResolvedValue([]);
    repo.countActiveReferences.mockResolvedValue(0);
    const { instance } = service(repo, overrides);
    await expect(instance.reconcile()).resolves.toMatchObject({ blocked: 1 });
    expect(blockedWith(repo)).toBe('control_shard_quarantine_registry_verifier_missing');
  });
});

describe('malformed registry documents', () => {
  const run = async (snapshot: string, generation: string, _signed = false) => {
    const repo = repository();
    repo.listDueQuarantines.mockResolvedValue([TARGET]);
    repo.listDueCleanups.mockResolvedValue([]);
    repo.countActiveReferences.mockResolvedValue(0);
    const { instance } = service(repo, {
      registry: {
        get: (key: string) => Promise.resolve(key.includes('generation') ? generation : snapshot),
      },
      registryVerificationKeys: [{ publicJwk: keys.publicJwk, keyId: keys.kid }],
    });
    return { repo, result: await instance.reconcile() };
  };

  it.each([
    ['no metadata', '{"stores":[]}'],
    ['null metadata', '{"stores":[],"metadata":null}'],
    ['scalar metadata', '{"stores":[],"metadata":5}'],
    ['a null snapshot', 'null'],
    ['a scalar snapshot', '5'],
  ])('blocks a snapshot with %s using the stable readback code', async (_name, snapshot) => {
    const { repo, result } = await run(snapshot, '{}');
    expect(result).toMatchObject({ blocked: 1, waitingRetry: 0 });
    expect(repo.markQuarantineBlocked).toHaveBeenCalledExactlyOnceWith(
      'quarantine-op',
      MISMATCH,
      NOW
    );
  });

  it.each([['null'], ['5'], ['"text"']])(
    'blocks a %s generation document next to a valid signed snapshot',
    async (generation) => {
      const documents = await registryDocuments({
        privateJwk: keys.privateJwk,
        kid: keys.kid,
        publishedAt: NOW - 60,
      });
      const { repo, result } = await run(documents.snapshot, generation, true);
      expect(result).toMatchObject({ blocked: 1, waitingRetry: 0 });
      expect(repo.markQuarantineBlocked).toHaveBeenCalledExactlyOnceWith(
        'quarantine-op',
        MISMATCH,
        NOW
      );
    }
  );
});
