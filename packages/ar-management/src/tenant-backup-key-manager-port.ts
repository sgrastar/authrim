import type { Env } from '@authrim/ar-lib-core';
import type { KeyManagerTenantBackupSnapshot } from '@authrim/ar-lib-core/services/tenant-portability/key-manager-portability';
import type { Phase4OtherStorePorts } from './tenant-backup-phase4-other-stores';
import type { Phase5KeyManagerSnapshotPorts } from './tenant-backup-phase5-adapter';

interface TenantBackupKeyManagerStub {
  exportTenantBackupStateRpc(): Promise<KeyManagerTenantBackupSnapshot>;
  startTenantBackupSnapshotRpc(snapshotId: string): Promise<void>;
  loadTenantBackupSnapshotRpc(snapshotId: string): Promise<KeyManagerTenantBackupSnapshot>;
  releaseTenantBackupSnapshotRpc(snapshotId: string): Promise<void>;
  assertTenantBackupSnapshotReleasedRpc(snapshotId: string): Promise<void>;
  importTenantBackupStateRpc(
    snapshot: unknown,
    options?: { replaceBootstrapKey?: boolean }
  ): Promise<unknown>;
  verifyTenantBackupStateRpc(snapshot: unknown): Promise<boolean>;
}

export type TenantBackupKeyManagerPort = Phase5KeyManagerSnapshotPorts &
  Pick<Phase4OtherStorePorts, 'importKeyManager' | 'verifyKeyManager'>;

function stub(env: Pick<Env, 'KEY_MANAGER'>, tenantId: string) {
  if (!tenantId || tenantId.length > 256) throw new Error('backup_key_manager_tenant_invalid');
  return env.KEY_MANAGER.get(
    env.KEY_MANAGER.idFromName(`${tenantId}-v3`)
  ) as unknown as TenantBackupKeyManagerStub;
}

/** Bind the Phase 8 snapshot contract to the tenant's KeyManager Durable Object. */
export function createTenantBackupKeyManagerSnapshotPort(
  env: Pick<Env, 'KEY_MANAGER'>
): TenantBackupKeyManagerPort {
  return {
    async assertSource(context) {
      context.context.signal.throwIfAborted();
      await stub(env, context.context.lease.tenantId).exportTenantBackupStateRpc();
      context.context.signal.throwIfAborted();
    },
    async start(context, snapshotId, assertHeld) {
      await assertHeld();
      context.context.signal.throwIfAborted();
      await stub(env, context.context.lease.tenantId).startTenantBackupSnapshotRpc(snapshotId);
      await assertHeld();
      context.context.signal.throwIfAborted();
    },
    async load(context, snapshotId) {
      context.context.signal.throwIfAborted();
      const snapshot = await stub(env, context.context.lease.tenantId).loadTenantBackupSnapshotRpc(
        snapshotId
      );
      context.context.signal.throwIfAborted();
      return snapshot;
    },
    async release(context, snapshotId) {
      context.context.signal.throwIfAborted();
      await stub(env, context.context.lease.tenantId).releaseTenantBackupSnapshotRpc(snapshotId);
    },
    async assertReleased(context, snapshotId) {
      context.context.signal.throwIfAborted();
      await stub(env, context.context.lease.tenantId).assertTenantBackupSnapshotReleasedRpc(
        snapshotId
      );
      context.context.signal.throwIfAborted();
    },
    async importKeyManager(context, snapshot) {
      context.signal.throwIfAborted();
      await stub(env, context.lease.tenantId).importTenantBackupStateRpc(snapshot, {
        replaceBootstrapKey: true,
      });
      context.signal.throwIfAborted();
    },
    async verifyKeyManager(context, snapshot) {
      context.signal.throwIfAborted();
      const result = await stub(env, context.lease.tenantId).verifyTenantBackupStateRpc(snapshot);
      context.signal.throwIfAborted();
      return result;
    },
  };
}
