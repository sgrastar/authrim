import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { SessionRevocationStore } from '../SessionRevocationStore';
import { createSamlDrPersistentNameIdRegistry } from '../../services/saml-dr-nameid-registry';
import {
  SAML_DR_ACCOUNT_SNAPSHOT_MAX_COUNTERS,
  type SamlDrAccountSnapshotIdentity,
} from '../saml-dr-account-snapshot';

const input: SamlDrAccountSnapshotIdentity = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  accountId: 'account:user-a',
  snapshotId: 'snapshot-a',
  boundaryUnixMs: 5_000,
};
const initialization = {
  tenantId: input.tenantId,
  userId: input.userId,
  accountId: input.accountId,
  freshAccount: true as const,
  initializationId: 'fresh-account-a',
  initializedAtMs: 500,
};

function setup(seed = new Map<string, unknown>()) {
  const data = new Map(structuredClone([...seed]));
  let failPut: string | undefined;
  const io = (target: Map<string, unknown>) => ({
    get: <T>(key: string): Promise<T | undefined> =>
      Promise.resolve(structuredClone(target.get(key)) as T | undefined),
    put: <T>(key: string, value: T): Promise<void> => {
      if (key === failPut) return Promise.reject(new Error('injected_storage_failure'));
      target.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete: (key: string): Promise<boolean> => Promise.resolve(target.delete(key)),
    list: <T>(options: { prefix: string; limit: number }): Promise<Map<string, T>> =>
      Promise.resolve(
        new Map(
          [...target]
            .filter(([key]) => key.startsWith(options.prefix))
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .slice(0, options.limit)
            .map(([key, value]) => [key, structuredClone(value) as T])
        )
      ),
  });
  const storage = {
    ...io(data),
    async transaction<T>(run: (transaction: ReturnType<typeof io>) => Promise<T>): Promise<T> {
      const draft = new Map(structuredClone([...data]));
      const result = await run(io(draft));
      data.clear();
      for (const [key, value] of draft) data.set(key, value);
      return result;
    },
  };
  const context = { storage } as unknown as DurableObjectState;
  return {
    data,
    reload: (enabled = true) =>
      new SessionRevocationStore(context, {
        ENABLE_SAML_DR_EXPORT: enabled ? 'true' : undefined,
        TENANT_BACKUP_WRAPPING_KEY: 'local-test-key',
        SAML_DR_MUTATION_CONTROL: {
          acquireEnvironmentBackupMutationPermit: async () => ({ admitted: true }),
          completeEnvironmentBackupMutationPermit: async () => {},
        },
      } as Env),
    failOnPut: (key: string | undefined) => {
      failPut = key;
    },
  };
}

async function initialize(store: SessionRevocationStore) {
  await store.initializeSamlDrNameIdRegistryRpc(initialization);
  await store.initializeAccountStateRpc('tenant-a', 'user-a', 'account:user-a', 'active', 1_000);
  await store.advancePasskeyCounterRpc(
    'tenant-a',
    'user-a',
    'account:user-a',
    'core-passkey-row-id',
    0,
    4,
    2_000
  );
  await store.revokeAllRpc('tenant-a', 'user-a', 'account:user-a', 2_500);
}

function seedCounters(count: number) {
  const data = new Map<string, unknown>([
    ['saml-dr-nameid-authority', { ...initialization, version: 1 }],
    ['identity', { tenantId: 'tenant-a', userId: 'user-a', accountId: 'account:user-a' }],
    [
      'state',
      {
        revokedAfterMs: null,
        lastLoginAtMs: null,
        lifecycle: 'active',
        lifecycleVersionMs: 1_000,
        lifecycleOperationId: null,
      },
    ],
  ]);
  for (let index = 0; index < count; index += 1) {
    data.set(`passkey-counter:row-${String(index).padStart(4, '0')}`, {
      counter: index,
      updatedAtMs: 2_000,
    });
  }
  return data;
}

describe('SessionRevocationStore SAML DR snapshots', () => {
  it('freezes real authority state and Core row-id counters across mutation, retry and reload', async () => {
    const fixture = setup();
    const store = fixture.reload();
    await initialize(store);
    await store.registerSessionRpc(
      'tenant-a',
      'user-a',
      'account:user-a',
      3_000,
      'private-session',
      10_000
    );
    fixture.data.set('session-index:private-session', { ipAddress: '192.0.2.2' });
    fixture.data.set('totp-time-step:private-totp', { lastAcceptedTimeStep: 123 });
    await store.startSamlDrSnapshotRpc(input);
    const first = await store.readSamlDrSnapshotPageRpc(input);
    expect(first).toEqual({
      ...input,
      initialized: true,
      state: {
        revokedAfterMs: 2_500,
        lastLoginAtMs: 3_000,
        lifecycle: 'active',
        lifecycleVersionMs: 1_000,
        lifecycleOperationId: null,
      },
      passkeyCounters: [{ credentialId: 'core-passkey-row-id', counter: 4, updatedAtMs: 2_000 }],
      totalPasskeyCounters: 1,
      nameIdRegistryInitialized: true,
      persistentNameIds: [],
      totalPersistentNameIds: 0,
      nextCursor: null,
    });
    await store.advancePasskeyCounterRpc(
      'tenant-a',
      'user-a',
      'account:user-a',
      'core-passkey-row-id',
      4,
      5,
      6_000
    );
    await store.revokeAllRpc('tenant-a', 'user-a', 'account:user-a', 7_000);
    await fixture.reload().startSamlDrSnapshotRpc(input);
    expect(await fixture.reload().readSamlDrSnapshotPageRpc(input)).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('private-');
    expect(fixture.data.get('passkey-counter:core-passkey-row-id')).toEqual({
      counter: 5,
      updatedAtMs: 6_000,
    });
  });

  it('captures an explicitly initialized NameID authority without creating authentication state', async () => {
    const fixture = setup();
    const store = fixture.reload();
    await store.initializeSamlDrNameIdRegistryRpc(initialization);
    const source = structuredClone(fixture.data);
    await store.startSamlDrSnapshotRpc(input);
    expect(fixture.data.get('identity')).toEqual(source.get('identity'));
    expect(fixture.data.has('state')).toBe(false);
    expect(await store.readSamlDrSnapshotPageRpc(input)).toMatchObject({
      initialized: false,
      state: { lifecycle: null, lifecycleVersionMs: null, revokedAfterMs: null },
      passkeyCounters: [],
      totalPasskeyCounters: 0,
      nextCursor: null,
    });
    await store.releaseSamlDrSnapshotRpc(input);
    await store.releaseSamlDrSnapshotRpc(input);
    await expect(store.assertSamlDrSnapshotReleasedRpc(input)).resolves.toBeUndefined();
    expect(fixture.data).toEqual(source);
  });

  it('pages the complete bounded authority inventory and preserves unrelated state on cleanup', async () => {
    const source = seedCounters(257);
    const fixture = setup(source);
    const store = fixture.reload();
    await store.startSamlDrSnapshotRpc(input);
    const page0 = await store.readSamlDrSnapshotPageRpc(input);
    expect(page0.nextCursor).toBe('1');
    const page1 = await store.readSamlDrSnapshotPageRpc({ ...input, cursor: '1' });
    expect(page1.nextCursor).toBe('2');
    const page2 = await store.readSamlDrSnapshotPageRpc({ ...input, cursor: '2' });
    expect([page0, page1, page2].map((page) => page.passkeyCounters.length)).toEqual([128, 128, 1]);
    expect([page0, page1, page2].map((page) => page.totalPasskeyCounters)).toEqual([257, 257, 257]);
    expect(page2.nextCursor).toBeNull();
    expect(
      new Set(
        [page0, page1, page2].flatMap((page) => page.passkeyCounters.map((row) => row.credentialId))
      ).size
    ).toBe(257);
    await expect(store.assertSamlDrSnapshotReleasedRpc(input)).rejects.toThrow('_not_released');
    await store.releaseSamlDrSnapshotRpc(input);
    expect(fixture.data).toEqual(source);
    await expect(store.readSamlDrSnapshotPageRpc(input)).rejects.toThrow('_missing');
  });

  it('allows the maximum per-account inventory with storage values below legacy KV limits', async () => {
    const fixture = setup(seedCounters(SAML_DR_ACCOUNT_SNAPSHOT_MAX_COUNTERS));
    const store = fixture.reload();
    await store.startSamlDrSnapshotRpc(input);
    expect(
      (await store.readSamlDrSnapshotPageRpc({ ...input, cursor: '7' })).passkeyCounters
    ).toHaveLength(128);
    for (const [key, value] of fixture.data) {
      if (key.startsWith('saml-dr-account-snapshot:'))
        expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThan(128 * 1024);
    }
  });

  it('rejects an oversized account before persisting any snapshot state', async () => {
    const source = seedCounters(SAML_DR_ACCOUNT_SNAPSHOT_MAX_COUNTERS + 1);
    const fixture = setup(source);
    await expect(fixture.reload().startSamlDrSnapshotRpc(input)).rejects.toThrow('_counter_limit');
    expect(fixture.data).toEqual(source);
  });

  it.each([
    { tenantId: 'tenant-b' },
    { userId: 'user-b', accountId: 'account:user-b' },
    { boundaryUnixMs: 5_001 },
  ])(
    'rejects reuse of the snapshot identity with %j without changing the frozen view',
    async (changed) => {
      const fixture = setup();
      const store = fixture.reload();
      await initialize(store);
      await store.startSamlDrSnapshotRpc(input);
      const before = structuredClone(fixture.data);
      await expect(store.startSamlDrSnapshotRpc({ ...input, ...changed })).rejects.toThrow(
        '_identity_mismatch'
      );
      await expect(store.readSamlDrSnapshotPageRpc({ ...input, ...changed })).rejects.toThrow(
        '_identity_mismatch'
      );
      await expect(store.releaseSamlDrSnapshotRpc({ ...input, ...changed })).rejects.toThrow(
        '_identity_mismatch'
      );
      expect(fixture.data).toEqual(before);
    }
  );

  it.each(['', '../snapshot', 'a'.repeat(129)])(
    'rejects invalid snapshot ID %s before storage writes',
    async (snapshotId) => {
      const fixture = setup();
      await expect(
        fixture.reload().startSamlDrSnapshotRpc({ ...input, snapshotId })
      ).rejects.toThrow('_identity_invalid');
      expect(fixture.data.size).toBe(0);
    }
  );

  it.each(['-1', '01', '8', '1', 'NaN'])(
    'rejects invalid or out-of-range cursor %s',
    async (cursor) => {
      const fixture = setup();
      const store = fixture.reload();
      await store.initializeSamlDrNameIdRegistryRpc(initialization);
      await store.startSamlDrSnapshotRpc(input);
      await expect(store.readSamlDrSnapshotPageRpc({ ...input, cursor })).rejects.toThrow(
        '_cursor_invalid'
      );
    }
  );

  it('rejects a different source DO identity and external-provider objects without creating a snapshot', async () => {
    for (const seed of [
      new Map([
        ['identity', { tenantId: 'tenant-b', userId: 'user-a', accountId: 'account:user-a' }],
      ]),
      new Map<string, unknown>([['external-provider-identity', { tenantId: 'tenant-a' }]]),
    ]) {
      const fixture = setup(seed);
      await expect(fixture.reload().startSamlDrSnapshotRpc(input)).rejects.toThrow(
        '_identity_mismatch'
      );
      expect(fixture.data).toEqual(seed);
    }
  });

  it.each([
    ['missing identity', 'identity', undefined, '_identity_mismatch'],
    ['invalid lifecycle', 'state', { lifecycle: 'unknown' }, '_state_invalid'],
    ['uninitialized lifecycle', 'state', {}, '_state_uninitialized'],
    [
      'overflow counter',
      'passkey-counter:row-0000',
      { counter: 0x1_0000_0000, updatedAtMs: 2_000 },
      '_counter_invalid',
    ],
    [
      'negative counter',
      'passkey-counter:row-0000',
      { counter: -1, updatedAtMs: 2_000 },
      '_counter_invalid',
    ],
  ])('fails closed for %s', async (_label, key, value, error) => {
    const seed = seedCounters(1);
    if (value === undefined) seed.delete(key);
    else seed.set(key, value);
    const fixture = setup(seed);
    await expect(fixture.reload().startSamlDrSnapshotRpc(input)).rejects.toThrow(error);
    expect(fixture.data).toEqual(seed);
  });

  it('rolls back all snapshot pages if persistence fails and can safely retry', async () => {
    const source = seedCounters(129);
    const fixture = setup(source);
    const store = fixture.reload();
    fixture.failOnPut('saml-dr-account-snapshot:snapshot-a:manifest');
    await expect(store.startSamlDrSnapshotRpc(input)).rejects.toThrow('injected_storage_failure');
    expect(fixture.data).toEqual(source);
    fixture.failOnPut(undefined);
    await store.startSamlDrSnapshotRpc(input);
    expect((await store.readSamlDrSnapshotPageRpc(input)).totalPasskeyCounters).toBe(129);
  });

  it('does not let cleanup of one ID remove a differently scoped snapshot', async () => {
    const fixture = setup();
    const store = fixture.reload();
    const other = { ...input, snapshotId: `${input.snapshotId}:nested` };
    await store.initializeSamlDrNameIdRegistryRpc(initialization);
    await store.startSamlDrSnapshotRpc(input);
    await store.startSamlDrSnapshotRpc(other);
    await store.releaseSamlDrSnapshotRpc(input);
    await store.assertSamlDrSnapshotReleasedRpc(input);
    expect((await store.readSamlDrSnapshotPageRpc(other)).snapshotId).toBe(other.snapshotId);
  });

  it('rejects a missing frozen page instead of substituting live state', async () => {
    const fixture = setup(seedCounters(1));
    const store = fixture.reload();
    await store.startSamlDrSnapshotRpc(input);
    fixture.data.delete('saml-dr-account-snapshot:snapshot-a:page:0');
    await expect(store.readSamlDrSnapshotPageRpc(input)).rejects.toThrow('_page_invalid');
  });
});

function nameIdInput(
  sp = 'https://sp.example.test/entity',
  nameId = 'pairwise-user-a',
  createdAt = 2_000
) {
  return {
    tenantId: input.tenantId,
    userId: input.userId,
    accountId: input.accountId,
    registryKey: `saml:persistent-nameid:tenant:tenant-a:sp:${encodeURIComponent(sp)}:subject:user-a`,
    valueJson: JSON.stringify({
      version: 1,
      tenantId: 'tenant-a',
      spEntityId: sp,
      subjectId: 'user-a',
      nameId,
      createdAt,
    }),
  };
}

describe('explicit SAML DR persistent NameID authority', () => {
  it('requires opt-in and refuses to infer an empty authority during reads, writes or export', async () => {
    const fixture = setup();
    await expect(
      fixture.reload(false).initializeSamlDrNameIdRegistryRpc(initialization)
    ).rejects.toThrow('_unavailable');
    const store = fixture.reload();
    await expect(store.getSamlDrNameIdRpc(nameIdInput())).rejects.toThrow('_authority_missing');
    await expect(store.putSamlDrNameIdRpc(nameIdInput())).rejects.toThrow('_authority_missing');
    await expect(store.startSamlDrSnapshotRpc(input)).rejects.toThrow('_authority_missing');
    expect(fixture.data.size).toBe(0);
  });

  it('initializes only a known-fresh empty account and requires the same initialization receipt on retry', async () => {
    const fixture = setup();
    const store = fixture.reload();
    await store.initializeSamlDrNameIdRegistryRpc(initialization);
    await store.initializeAccountStateRpc('tenant-a', 'user-a', 'account:user-a', 'active', 1_000);
    const before = structuredClone(fixture.data);
    await store.initializeSamlDrNameIdRegistryRpc(initialization);
    await expect(
      store.initializeSamlDrNameIdRegistryRpc({ ...initialization, initializationId: 'other' })
    ).rejects.toThrow('_initialization_conflict');
    await expect(
      store.initializeSamlDrNameIdRegistryRpc({ ...initialization, freshAccount: false as never })
    ).rejects.toThrow('_initialization_invalid');
    expect(fixture.data).toEqual(before);
    expect(await store.getSamlDrNameIdRpc(nameIdInput())).toBeNull();
  });

  it.each([
    ['identity', { tenantId: 'tenant-a', userId: 'user-a', accountId: 'account:user-a' }],
    ['state', { lifecycle: 'active' }],
    ['passkey-counter:old', { counter: 0, updatedAtMs: 1_000 }],
    ['legacy-anything', 'existing'],
  ])('refuses fresh initialization on a store containing %s', async (key, value) => {
    const source = new Map<string, unknown>([[key, value]]);
    const fixture = setup(source);
    await expect(
      fixture.reload().initializeSamlDrNameIdRegistryRpc(initialization)
    ).rejects.toThrow('_target_not_empty');
    expect(fixture.data).toEqual(source);
  });

  it('preserves the first NameID and timestamp across retries/reloads and rejects a changed NameID', async () => {
    const fixture = setup();
    const store = fixture.reload();
    await store.initializeSamlDrNameIdRegistryRpc(initialization);
    const first = nameIdInput();
    await store.putSamlDrNameIdRpc(first);
    await fixture.reload().putSamlDrNameIdRpc(nameIdInput(undefined, undefined, 3_000));
    expect(await fixture.reload().getSamlDrNameIdRpc(first)).toBe(first.valueJson);
    const before = structuredClone(fixture.data);
    await expect(store.putSamlDrNameIdRpc(nameIdInput(undefined, 'replacement'))).rejects.toThrow(
      '_conflict'
    );
    expect(fixture.data).toEqual(before);
  });

  it.each([
    { tenantId: 'tenant-b' },
    { userId: 'user-b', accountId: 'account:user-b' },
    {
      registryKey:
        'saml:persistent-nameid:tenant:tenant-a:sp:https%3a%2f%2fsp.example.test:subject:user-a',
    },
    {
      valueJson: JSON.stringify({
        version: 1,
        tenantId: 'tenant-a',
        spEntityId: 'wrong',
        subjectId: 'user-a',
        nameId: 'name',
        createdAt: 1_000,
      }),
    },
    { valueJson: 'not-json' },
    {
      valueJson: JSON.stringify({
        version: 1,
        tenantId: 'tenant-a',
        spEntityId: 'https://sp.example.test/entity',
        subjectId: 'user-a',
        nameId: 'name',
        createdAt: 1_000,
        unexpected: true,
      }),
    },
  ])('rejects misbound or malformed NameID record %j without writes', async (change) => {
    const fixture = setup();
    const store = fixture.reload();
    await store.initializeSamlDrNameIdRegistryRpc(initialization);
    const before = structuredClone(fixture.data);
    await expect(store.putSamlDrNameIdRpc({ ...nameIdInput(), ...change })).rejects.toThrow(
      'saml_dr_nameid_'
    );
    expect(fixture.data).toEqual(before);
  });

  it('freezes all NameID pages with the account counter view and never reads newer live records', async () => {
    const fixture = setup();
    const store = fixture.reload();
    await initialize(store);
    for (let index = 0; index < 5; index += 1)
      await store.putSamlDrNameIdRpc(
        nameIdInput(`https://sp-${index}.example.test/entity`, `name-${index}`)
      );
    await store.startSamlDrSnapshotRpc(input);
    await store.putSamlDrNameIdRpc(
      nameIdInput('https://later.example.test/entity', 'later', 6_000)
    );
    const pages = await Promise.all(
      [undefined, '1', '2'].map((cursor) =>
        fixture.reload().readSamlDrSnapshotPageRpc({ ...input, cursor })
      )
    );
    expect(pages.map((page) => page.nameIdRegistryInitialized)).toEqual([true, true, true]);
    expect(pages.map((page) => page.totalPersistentNameIds)).toEqual([5, 5, 5]);
    expect(pages.map((page) => page.persistentNameIds.length)).toEqual([2, 2, 1]);
    expect(pages.map((page) => page.passkeyCounters.length)).toEqual([1, 0, 0]);
    expect(pages.map((page) => page.nextCursor)).toEqual(['1', '2', null]);
    expect(
      new Set(pages.flatMap((page) => page.persistentNameIds.map((row) => row.registryKey))).size
    ).toBe(5);
    expect(JSON.stringify(pages)).not.toContain('later');
    const source = new Map(
      [...fixture.data].filter(([key]) => !key.startsWith('saml-dr-account-snapshot:'))
    );
    await store.releaseSamlDrSnapshotRpc(input);
    expect(fixture.data).toEqual(source);
  });

  it('rejects a missing frozen NameID page and an oversized registry instead of claiming completeness', async () => {
    const fixture = setup();
    const store = fixture.reload();
    await initialize(store);
    await store.startSamlDrSnapshotRpc(input);
    fixture.data.delete('saml-dr-account-snapshot:snapshot-a:nameids:0');
    await expect(store.readSamlDrSnapshotPageRpc(input)).rejects.toThrow('_page_invalid');
    const row = nameIdInput();
    for (let index = 0; index < 1025; index += 1)
      fixture.data.set(`saml-dr-nameid-record:injected-${index}`, {
        tenantId: 'tenant-a',
        registryKey: row.registryKey,
        valueJson: row.valueJson,
        createdAtMs: 2_000,
      });
    const before = structuredClone(fixture.data);
    await expect(
      store.startSamlDrSnapshotRpc({ ...input, snapshotId: 'over-limit' })
    ).rejects.toThrow('_nameid_limit');
    expect(fixture.data).toEqual(before);
  });

  it('uses only the exact account DO through the opt-in KV-shaped adapter and rejects TTL/default activation', async () => {
    const fixture = setup();
    const store = fixture.reload();
    await store.initializeSamlDrNameIdRegistryRpc(initialization);
    const idFromName = vi.fn((value: string) => value);
    const get = vi.fn(() => store);
    const env = {
      ENABLE_SAML_DR_EXPORT: 'true',
      SESSION_REVOCATION_STORE: { idFromName, get },
    } as unknown as Env & { ENABLE_SAML_DR_EXPORT: string };
    const adapter = createSamlDrPersistentNameIdRegistry(env);
    const row = nameIdInput();
    await adapter.put(row.registryKey, row.valueJson);
    expect(await adapter.get(row.registryKey)).toBe(row.valueJson);
    expect(idFromName).toHaveBeenLastCalledWith('tenant:tenant-a:user-session:user-a');
    expect(get).toHaveBeenLastCalledWith('tenant:tenant-a:user-session:user-a');
    const before = structuredClone(fixture.data);
    await expect(adapter.put(row.registryKey, row.valueJson, { expirationTtl: 5 })).rejects.toThrow(
      '_ttl_unsupported'
    );
    expect(() =>
      createSamlDrPersistentNameIdRegistry({ ...env, ENABLE_SAML_DR_EXPORT: undefined })
    ).toThrow('_unavailable');
    expect(() =>
      createSamlDrPersistentNameIdRegistry({ ...env, AUTH_RUNTIME_PORTS: {} as never })
    ).toThrow('_unavailable');
    expect(fixture.data).toEqual(before);
  });
});
