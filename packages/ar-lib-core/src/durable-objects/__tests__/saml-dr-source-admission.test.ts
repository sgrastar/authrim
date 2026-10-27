import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { KeyManager, SAML_DR_KEY_MANAGER_SURFACE } from '../KeyManager';
import {
  SessionRevocationStore,
  SAML_DR_SESSION_REVOCATION_SURFACE,
} from '../SessionRevocationStore';
import { emptyKeyManagerTenantBackupSnapshot } from '../../services/tenant-portability/key-manager-portability';

function fixture(seed: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(structuredClone(seed)));
  const put = vi.fn(async (key: string | Record<string, unknown>, value?: unknown) => {
    if (typeof key === 'string') data.set(key, structuredClone(value));
    else for (const [name, item] of Object.entries(key)) data.set(name, structuredClone(item));
  });
  const storage = {
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    put,
    delete: vi.fn(async (key: string) => data.delete(key)),
    list: async <T>(options: { prefix?: string; limit?: number } = {}) =>
      new Map(
        [...data]
          .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, options.limit)
          .map(([key, value]) => [key, structuredClone(value) as T])
      ),
    transaction: async <T>(run: (value: unknown) => Promise<T>) => run(storage),
  };
  const context = {
    storage,
    blockConcurrencyWhile: <T>(run: () => Promise<T>) => run(),
  } as unknown as DurableObjectState;
  const acquire = vi.fn(async (_input: unknown) => ({ admitted: false }));
  const complete = vi.fn(async (_input: unknown) => {});
  const env = {
    ENABLE_SAML_DR_EXPORT: 'true',
    TENANT_BACKUP_WRAPPING_KEY: 'local-test-key',
    SAML_DR_MUTATION_CONTROL: {
      acquireEnvironmentBackupMutationPermit: acquire,
      completeEnvironmentBackupMutationPermit: complete,
    },
  } as unknown as Env;
  return { data, put, storage, context, env, acquire, complete };
}

function seededKeys() {
  const snapshot = emptyKeyManagerTenantBackupSnapshot();
  return {
    state: snapshot.rsa,
    ecState: snapshot.vcEc,
    oidcECState: snapshot.oidcEs256,
    oidcPS256State: snapshot.oidcPs256,
    requestObjectEncState: snapshot.requestObjectEnc,
  };
}

async function invoke(object: object, name: string): Promise<unknown> {
  const method = Reflect.get(object, name) as (this: object) => Promise<unknown>;
  return method.call(object);
}

const classes = [
  { name: 'KeyManager', Class: KeyManager, surface: SAML_DR_KEY_MANAGER_SURFACE },
  {
    name: 'SessionRevocationStore',
    Class: SessionRevocationStore,
    surface: SAML_DR_SESSION_REVOCATION_SURFACE,
  },
] as const;

describe('SAML DR authoritative DO admission', () => {
  for (const entry of classes) {
    it(`${entry.name} catalogue contains every exposed method and no private RPC bypass`, () => {
      const publicNames = Object.getOwnPropertyNames(entry.Class.prototype).filter(
        (name) => name !== 'constructor'
      );
      expect(publicNames.sort()).toEqual(
        [...entry.surface.guarded, ...entry.surface.snapshot, ...entry.surface.readonly].sort()
      );
      expect(new Set(publicNames).size).toBe(publicNames.length);
    });

    it.each(entry.surface.guarded)(
      `${entry.name}.%s rejects before any source write`,
      async (name) => {
        const f = fixture();
        const instance = new entry.Class(f.context, f.env);
        await expect(invoke(instance, name)).rejects.toThrow('backup_mutation_unavailable');
        expect(f.acquire).toHaveBeenCalledOnce();
        expect(f.complete).not.toHaveBeenCalled();
        expect(f.put).not.toHaveBeenCalled();
        expect(f.storage.delete).not.toHaveBeenCalled();
        expect(f.data.size).toBe(0);
      }
    );
  }

  it('flag-on constructor and snapshot probes do not create missing key authority', async () => {
    const f = fixture();
    const keys = new KeyManager(f.context, f.env);
    await expect(keys.exportTenantBackupStateRpc()).rejects.toThrow(
      'saml_dr_key_manager_authority_uninitialized'
    );
    await expect(keys.startTenantBackupSnapshotRpc('a'.repeat(64))).rejects.toThrow(
      'saml_dr_key_manager_authority_uninitialized'
    );
    expect(f.put).not.toHaveBeenCalled();
    expect(f.acquire).not.toHaveBeenCalled();
  });

  it('reads only an existing secret during a hold and returns an isolated copy', async () => {
    const seed = seededKeys();
    const secret = {
      secretRef: 'tenant:tenant-a:consent:ip-salt',
      active: { kid: 'salt-a', value: 'synthetic-secret-value', createdAt: 100 },
      updatedAt: 100,
    };
    const f = fixture({
      ...seed,
      state: { ...seed.state, secrets: { [secret.secretRef]: secret } },
    });
    const keys = new KeyManager(f.context, f.env);
    const result = await keys.getExistingSecretRpc(secret.secretRef);
    expect(result).toEqual(secret);
    if (!result) throw new Error('expected_existing_secret');
    result.active.value = 'changed-copy';
    expect(await keys.getExistingSecretRpc(secret.secretRef)).toEqual(secret);
    expect(await keys.getExistingSecretRpc('tenant:tenant-b:consent:ip-salt')).toBeNull();
    await expect(keys.getExistingSecretRpc('__proto__')).rejects.toThrow(
      'Invalid secret reference'
    );
    expect(f.put).not.toHaveBeenCalled();
    expect(f.acquire).not.toHaveBeenCalled();
  });

  it('cannot initialize a missing authority through existing-secret lookup', async () => {
    const f = fixture();
    const keys = new KeyManager(f.context, f.env);
    await expect(keys.getExistingSecretRpc('tenant:tenant-a:consent:ip-salt')).rejects.toThrow(
      'saml_dr_key_manager_authority_uninitialized'
    );
    expect(f.data.size).toBe(0);
    expect(f.put).not.toHaveBeenCalled();
    expect(f.acquire).not.toHaveBeenCalled();
  });

  it('never exports a failed-save secret and reloads the cache before the next normal write', async () => {
    const f = fixture(seededKeys());
    f.acquire.mockResolvedValue({ admitted: true });
    const keys = new KeyManager(f.context, f.env);
    const secretRef = 'tenant:tenant-a:consent:ip-salt';
    f.put.mockRejectedValueOnce(new Error('storage_failed'));
    await expect(keys.getOrCreateSecretRpc(secretRef)).rejects.toThrow('storage_failed');
    expect(await keys.getExistingSecretRpc(secretRef)).toBeNull();
    const frozen = await keys.exportTenantBackupStateRpc();
    expect(frozen.rsa.secrets).toEqual({});
    await keys.startTenantBackupSnapshotRpc('c'.repeat(64));
    expect((await keys.loadTenantBackupSnapshotRpc('c'.repeat(64))).rsa.secrets).toEqual({});
    await keys.updateConfigRpc({ retentionPeriodDays: 19 });
    expect((f.data.get('state') as { secrets: unknown }).secrets).toEqual({});
    expect(await keys.getExistingSecretRpc(secretRef)).toBeNull();
  });

  it('initializes only inside admitted normal operations and keeps nested calls under one permit', async () => {
    const f = fixture();
    f.acquire.mockResolvedValue({ admitted: true });
    const keys = new KeyManager(f.context, f.env);
    await keys.updateConfigRpc({ retentionPeriodDays: 12 });
    expect((f.data.get('state') as { config: unknown }).config).toMatchObject({
      retentionPeriodDays: 12,
    });
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.data.size).toBe(5);
    expect(f.put.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.acquire.mock.invocationCallOrder[0]
    );
    expect(f.complete.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.put.mock.invocationCallOrder.at(-1) ?? 0
    );
  });

  it('does not mutate an older key format until admission succeeds', async () => {
    const seed = seededKeys();
    const oldKey = { kid: 'old-key', isActive: true, createdAt: 1 };
    const f = fixture({ ...seed, state: { ...seed.state, keys: [oldKey] } });
    const before = structuredClone(f.data);
    const keys = new KeyManager(f.context, f.env);
    await expect(keys.getConfigRpc()).rejects.toThrow('backup_mutation_unavailable');
    expect(f.data).toEqual(before);
    expect(f.put).not.toHaveBeenCalled();
    await expect(keys.startTenantBackupSnapshotRpc('a'.repeat(64))).rejects.toThrow(
      'saml_dr_key_manager_authority_uninitialized'
    );
    f.acquire.mockResolvedValue({ admitted: true });
    await keys.getConfigRpc();
    const migrated = f.data.get('state') as { keys: Array<Record<string, unknown>> };
    expect(migrated.keys[0]).toMatchObject({ kid: 'old-key', status: 'active' });
    expect(migrated.keys[0]).not.toHaveProperty('isActive');
  });

  it('does not share an in-flight operation permit with a concurrent RPC on the same instance', async () => {
    const f = fixture(seededKeys());
    f.acquire.mockResolvedValueOnce({ admitted: true });
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.put.mockImplementationOnce(async (key, value) => {
      await blocked;
      if (typeof key !== 'string') throw new Error('expected_source_key');
      f.data.set(key, structuredClone(value));
    });
    const keys = new KeyManager(f.context, f.env);
    const first = keys.updateConfigRpc({ retentionPeriodDays: 18 });
    await vi.waitFor(() => expect(f.put).toHaveBeenCalledOnce());
    await expect(keys.getOrCreateSecretRpc('tenant:tenant-a:consent:ip-salt')).rejects.toThrow(
      'backup_mutation_unavailable'
    );
    expect(f.acquire).toHaveBeenCalledTimes(2);
    expect(f.complete).not.toHaveBeenCalled();
    finish();
    await first;
    expect(f.complete).toHaveBeenCalledOnce();
    expect(await keys.getExistingSecretRpc('tenant:tenant-a:consent:ip-salt')).toBeNull();
    expect((f.data.get('state') as { config: unknown }).config).toMatchObject({
      retentionPeriodDays: 18,
    });
  });

  it('freezes initialized key state during a hold and reads the same view after later mutations', async () => {
    const f = fixture(seededKeys());
    const keys = new KeyManager(f.context, f.env);
    const id = 'b'.repeat(64);
    await keys.startTenantBackupSnapshotRpc(id);
    const frozen = await keys.loadTenantBackupSnapshotRpc(id);
    expect(f.acquire).not.toHaveBeenCalled();
    f.acquire.mockResolvedValue({ admitted: true });
    await keys.updateConfigRpc({ retentionPeriodDays: 17 });
    f.acquire.mockResolvedValue({ admitted: false });
    const reloaded = new KeyManager(f.context, f.env);
    expect(await reloaded.loadTenantBackupSnapshotRpc(id)).toEqual(frozen);
    await reloaded.startTenantBackupSnapshotRpc(id);
    expect(await reloaded.loadTenantBackupSnapshotRpc(id)).toEqual(frozen);
    await reloaded.releaseTenantBackupSnapshotRpc(id);
    await reloaded.assertTenantBackupSnapshotReleasedRpc(id);
    expect(f.data.has(`tenantBackupSnapshot:${id}`)).toBe(false);
    expect((f.data.get('state') as { config: unknown }).config).toMatchObject({
      retentionPeriodDays: 17,
    });
  });

  it('default-off key initialization remains unchanged without a Control binding', async () => {
    const f = fixture();
    const keys = new KeyManager(f.context, {} as Env);
    await expect(keys.getConfigRpc()).resolves.toMatchObject({ retentionPeriodDays: 30 });
    expect(f.data.size).toBe(5);
    expect(f.acquire).not.toHaveBeenCalled();
  });

  it('account snapshots and cleanup remain available while normal account writes are denied', async () => {
    const f = fixture();
    f.acquire.mockResolvedValue({ admitted: true });
    const store = new SessionRevocationStore(f.context, f.env);
    const identity = { tenantId: 'tenant-a', userId: 'user-a', accountId: 'account:user-a' };
    await store.initializeSamlDrNameIdRegistryRpc({
      ...identity,
      freshAccount: true,
      initializationId: 'fresh-a',
      initializedAtMs: 100,
    });
    await store.initializeAccountStateRpc('tenant-a', 'user-a', 'account:user-a', 'active', 200);
    await store.advancePasskeyCounterRpc(
      'tenant-a',
      'user-a',
      'account:user-a',
      'passkey-a',
      0,
      1,
      300
    );
    f.acquire.mockResolvedValue({ admitted: false });
    const snapshot = { ...identity, snapshotId: 'snapshot-a', boundaryUnixMs: 500 };
    await store.startSamlDrSnapshotRpc(snapshot);
    const page = await store.readSamlDrSnapshotPageRpc(snapshot);
    await expect(
      store.advancePasskeyCounterRpc('tenant-a', 'user-a', 'account:user-a', 'passkey-a', 1, 2, 600)
    ).rejects.toThrow('backup_mutation_unavailable');
    expect((await store.readSamlDrSnapshotPageRpc(snapshot)).passkeyCounters).toEqual(
      page.passkeyCounters
    );
    await store.releaseSamlDrSnapshotRpc(snapshot);
    await store.assertSamlDrSnapshotReleasedRpc(snapshot);
    expect([...f.data.keys()].some((key) => key.startsWith('saml-dr-account-snapshot:'))).toBe(
      false
    );
    expect(f.data.get('passkey-counter:passkey-a')).toEqual({ counter: 1, updatedAtMs: 300 });
  });
});
