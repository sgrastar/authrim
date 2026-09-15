import { describe, expect, it, vi } from 'vitest';
import type { KeyManagerTenantBackupSnapshot } from '@authrim/ar-lib-core/services/tenant-portability/key-manager-portability';
import { createTenantBackupKeyManagerSnapshotPort } from '../tenant-backup-key-manager-port';

const snapshot = {
  kind: 'authrim.key_manager_tenant_backup.v1',
  version: 1,
  rsa: {},
  vcEc: {},
  oidcEs256: {},
  oidcPs256: {},
} as unknown as KeyManagerTenantBackupSnapshot;

function fixture() {
  const calls: string[] = [];
  const stub = {
    exportTenantBackupStateRpc: vi.fn(async () => snapshot),
    startTenantBackupSnapshotRpc: vi.fn(async () => {
      calls.push('start');
    }),
    loadTenantBackupSnapshotRpc: vi.fn(async () => snapshot),
    releaseTenantBackupSnapshotRpc: vi.fn(async () => undefined),
    assertTenantBackupSnapshotReleasedRpc: vi.fn(async () => undefined),
    importTenantBackupStateRpc: vi.fn(async () => ({ imported: true })),
    verifyTenantBackupStateRpc: vi.fn(async () => true),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => `id:${name}`),
    get: vi.fn(() => stub),
  };
  const context = {
    context: {
      signal: new AbortController().signal,
      lease: { tenantId: 'tenant-a' },
    },
  };
  return { calls, context, namespace, stub };
}

describe('tenant backup KeyManager production port', () => {
  it('takes the immutable DO snapshot between boundary checks', async () => {
    const { calls, context, namespace, stub } = fixture();
    const port = createTenantBackupKeyManagerSnapshotPort({
      KEY_MANAGER: namespace,
    } as never);
    const held = vi.fn(async () => {
      calls.push('held');
    });

    await port.start(context as never, 'ab'.repeat(32), held);

    expect(calls).toEqual(['held', 'start', 'held']);
    expect(namespace.idFromName).toHaveBeenCalledWith('tenant-a-v3');
    expect(stub.startTenantBackupSnapshotRpc).toHaveBeenCalledWith('ab'.repeat(32));
  });

  it('loads and releases the same operation snapshot', async () => {
    const { context, namespace, stub } = fixture();
    const port = createTenantBackupKeyManagerSnapshotPort({
      KEY_MANAGER: namespace,
    } as never);
    const snapshotId = 'cd'.repeat(32);

    await expect(port.load(context as never, snapshotId)).resolves.toBe(snapshot);
    await port.release(context as never, snapshotId);
    await port.assertReleased(context as never, snapshotId);

    expect(stub.loadTenantBackupSnapshotRpc).toHaveBeenCalledWith(snapshotId);
    expect(stub.releaseTenantBackupSnapshotRpc).toHaveBeenCalledWith(snapshotId);
    expect(stub.assertTenantBackupSnapshotReleasedRpc).toHaveBeenCalledWith(snapshotId);
  });

  it('imports and verifies through the target tenant Durable Object', async () => {
    const { context, namespace, stub } = fixture();
    const port = createTenantBackupKeyManagerSnapshotPort({
      KEY_MANAGER: namespace,
    } as never);

    await port.importKeyManager(context.context as never, snapshot);
    await expect(port.verifyKeyManager(context.context as never, snapshot)).resolves.toBe(true);

    expect(stub.importTenantBackupStateRpc).toHaveBeenCalledWith(snapshot);
    expect(stub.verifyTenantBackupStateRpc).toHaveBeenCalledWith(snapshot);
  });
});
