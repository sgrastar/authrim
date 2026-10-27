import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { SamlDrAccountSnapshotPage } from '@authrim/ar-lib-core/durable-objects/saml-dr-account-snapshot';
import {
  createSamlDrAccountSnapshotSource,
  type SamlDrAccountSourceInventory,
} from '../tenant-backup-saml-dr-account-source';

const boundary = { tenantId: 'tenant-a', snapshotId: 'frozen-a', boundaryUnixMs: 5_000 };
const inventory: SamlDrAccountSourceInventory[] = [
  {
    tenantId: 'tenant-a',
    userId: 'user-a',
    accountId: 'account:user-a',
    passkeys: [
      { passkeyId: 'row-a', credentialId: 'public-credential-a', counter: '2', updatedAtMs: 2_000 },
    ],
  },
];
const registryKey =
  'saml:persistent-nameid:tenant:tenant-a:sp:https%3A%2F%2Fsp.example.test:subject:user-a';
const valueJson = JSON.stringify({
  version: 1,
  tenantId: 'tenant-a',
  spEntityId: 'https://sp.example.test',
  subjectId: 'user-a',
  nameId: 'pairwise-a',
  createdAt: 1_500,
});
function page(changes: Partial<SamlDrAccountSnapshotPage> = {}): SamlDrAccountSnapshotPage {
  return {
    ...boundary,
    userId: 'user-a',
    accountId: 'account:user-a',
    initialized: true,
    state: {
      lifecycle: 'active',
      lifecycleVersionMs: 1_000,
      lifecycleOperationId: null,
      revokedAfterMs: 1_100,
      lastLoginAtMs: 2_000,
    },
    passkeyCounters: [{ credentialId: 'row-a', counter: 3, updatedAtMs: 2_100 }],
    totalPasskeyCounters: 1,
    nameIdRegistryInitialized: true,
    persistentNameIds: [{ tenantId: 'tenant-a', registryKey, valueJson, createdAtMs: 1_500 }],
    totalPersistentNameIds: 1,
    nextCursor: null,
    ...changes,
  };
}
function setup(source = inventory) {
  const stub = {
    startSamlDrSnapshotRpc: vi.fn(async () => {}),
    readSamlDrSnapshotPageRpc: vi.fn(async () => page()),
    releaseSamlDrSnapshotRpc: vi.fn(async () => {}),
    assertSamlDrSnapshotReleasedRpc: vi.fn(async () => {}),
  };
  const namespace = { idFromName: vi.fn((name: string) => name), get: vi.fn(() => stub) };
  const env = {
    ENABLE_SAML_DR_EXPORT: 'true',
    SESSION_REVOCATION_STORE: namespace,
  } as unknown as Env & { ENABLE_SAML_DR_EXPORT: string };
  return { stub, namespace, env, source: createSamlDrAccountSnapshotSource(env, source) };
}

describe('SAML DR frozen account source', () => {
  it('does not expose a private RPC failure through the export error', async () => {
    const fixture = setup();
    fixture.stub.readSamlDrSnapshotPageRpc.mockRejectedValue(new Error('private-rpc-detail'));
    await expect(fixture.source.read(boundary)).rejects.toEqual(
      new Error('saml_dr_account_source_invalid')
    );
  });

  it('binds the frozen inventory and maps authoritative Core row IDs to public credential IDs', async () => {
    const mutable = structuredClone(inventory);
    const fixture = setup(mutable);
    mutable[0].passkeys = [];
    const assertHeld = vi.fn(async () => {});
    await fixture.source.start(boundary, assertHeld);
    expect(assertHeld).toHaveBeenCalled();
    expect(fixture.stub.startSamlDrSnapshotRpc).toHaveBeenCalledWith({
      ...boundary,
      userId: 'user-a',
      accountId: 'account:user-a',
    });
    const result = await fixture.source.read(boundary);
    expect(result).toEqual({
      accountAuthStates: [
        { tenantId: 'tenant-a', userId: 'user-a', accountId: 'account:user-a', ...page().state },
      ],
      passkeyCounters: [
        {
          tenantId: 'tenant-a',
          userId: 'user-a',
          passkeyId: 'row-a',
          credentialId: 'public-credential-a',
          counter: '3',
          updatedAtMs: 2_100,
        },
      ],
      persistentNameIds: page().persistentNameIds,
    });
    expect(fixture.namespace.idFromName).toHaveBeenLastCalledWith(
      'tenant:tenant-a:user-session:user-a'
    );
    await fixture.source.release(boundary);
    await fixture.source.assertReleased(boundary);
    expect(fixture.stub.releaseSamlDrSnapshotRpc).toHaveBeenCalledWith({
      ...boundary,
      userId: 'user-a',
      accountId: 'account:user-a',
    });
  });

  it.each([
    { tenantId: 'tenant-b' },
    { userId: 'other-user', accountId: 'account:other-user' },
    { snapshotId: 'other-snapshot' },
    { boundaryUnixMs: 4_999 },
    { initialized: false },
    { nameIdRegistryInitialized: false as never },
    { totalPasskeyCounters: 0, passkeyCounters: [] },
    { passkeyCounters: [{ credentialId: 'unknown-row', counter: 3, updatedAtMs: 2_100 }] },
    { passkeyCounters: [{ credentialId: 'row-a', counter: 1, updatedAtMs: 2_100 }] },
    { passkeyCounters: [{ credentialId: 'row-a', counter: 3, updatedAtMs: 5_001 }] },
    { nextCursor: '1' },
    { persistentNameIds: [], totalPersistentNameIds: 1 },
  ] satisfies Partial<SamlDrAccountSnapshotPage>[])(
    'rejects incomplete/misbound state %j without performing a restore or retry',
    async (change) => {
      const fixture = setup();
      fixture.stub.readSamlDrSnapshotPageRpc.mockResolvedValue(page(change));
      await expect(fixture.source.read(boundary)).rejects.toThrow('saml_dr_account_source_invalid');
      expect(fixture.stub.startSamlDrSnapshotRpc).not.toHaveBeenCalled();
      expect(fixture.stub.releaseSamlDrSnapshotRpc).not.toHaveBeenCalled();
    }
  );

  it('reads every frozen NameID page even after the passkey pages end', async () => {
    const fixture = setup();
    const names = Array.from({ length: 3 }, (_, index) => {
      const spEntityId = `https://sp-${index}.example.test`;
      return {
        tenantId: 'tenant-a',
        registryKey: `saml:persistent-nameid:tenant:tenant-a:sp:${encodeURIComponent(spEntityId)}:subject:user-a`,
        valueJson: JSON.stringify({
          version: 1,
          tenantId: 'tenant-a',
          spEntityId,
          subjectId: 'user-a',
          nameId: `name-${index}`,
          createdAt: 1_500,
        }),
        createdAtMs: 1_500,
      };
    });
    fixture.stub.readSamlDrSnapshotPageRpc
      .mockResolvedValueOnce(
        page({ persistentNameIds: names.slice(0, 2), totalPersistentNameIds: 3, nextCursor: '1' })
      )
      .mockResolvedValueOnce(
        page({ passkeyCounters: [], persistentNameIds: names.slice(2), totalPersistentNameIds: 3 })
      );
    expect((await fixture.source.read(boundary)).persistentNameIds).toEqual(names);
    expect(fixture.stub.readSamlDrSnapshotPageRpc).toHaveBeenNthCalledWith(2, {
      ...boundary,
      userId: 'user-a',
      accountId: 'account:user-a',
      cursor: '1',
    });
  });

  it('rejects repeated registry keys rather than treating row count as completeness', async () => {
    const fixture = setup();
    fixture.stub.readSamlDrSnapshotPageRpc.mockResolvedValue(
      page({
        persistentNameIds: [page().persistentNameIds[0], page().persistentNameIds[0]],
        totalPersistentNameIds: 2,
      })
    );
    await expect(fixture.source.read(boundary)).rejects.toThrow('saml_dr_account_source_invalid');
  });

  it.each(
    [
      [{ ...inventory[0], tenantId: 'tenant-b' }, inventory[0]],
      [inventory[0], inventory[0]],
      [{ ...inventory[0], passkeys: [inventory[0].passkeys[0], inventory[0].passkeys[0]] }],
    ].map((items) => ({ items }))
  )('rejects ambiguous source inventory before creating any DO snapshot', ({ items }) => {
    expect(() => setup(items)).toThrow();
  });

  it('rejects disabled/alternate runtime sources and mismatched boundaries before DO access', async () => {
    const fixture = setup();
    expect(() =>
      createSamlDrAccountSnapshotSource(
        { ...fixture.env, ENABLE_SAML_DR_EXPORT: undefined },
        inventory
      )
    ).toThrow('saml_dr_account_source_invalid');
    expect(() =>
      createSamlDrAccountSnapshotSource(
        { ...fixture.env, AUTH_RUNTIME_PORTS: {} as never },
        inventory
      )
    ).toThrow('saml_dr_account_source_invalid');
    await expect(
      fixture.source.start({ ...boundary, tenantId: 'other' }, async () => {})
    ).rejects.toThrow('saml_dr_account_source_invalid');
    expect(fixture.namespace.get).not.toHaveBeenCalled();
  });

  it('waits for all admitted starts to settle and attempts every cleanup despite a failure', async () => {
    const accounts = [
      inventory[0],
      { tenantId: 'tenant-a', userId: 'user-b', accountId: 'account:user-b', passkeys: [] },
    ];
    const fixture = setup(accounts);
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fixture.stub.startSamlDrSnapshotRpc
      .mockRejectedValueOnce(new Error('private-start-detail'))
      .mockReturnValueOnce(pending);
    let settled = false;
    const started = fixture.source
      .start(boundary, async () => {})
      .catch((error: unknown) => {
        settled = true;
        return error;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    finish?.();
    expect(await started).toEqual(new Error('saml_dr_account_source_invalid'));
    fixture.stub.releaseSamlDrSnapshotRpc.mockRejectedValueOnce(
      new Error('private-cleanup-detail')
    );
    await expect(fixture.source.release(boundary)).rejects.toThrow(
      'saml_dr_account_source_invalid'
    );
    expect(fixture.stub.releaseSamlDrSnapshotRpc).toHaveBeenCalledTimes(2);
  });
});
