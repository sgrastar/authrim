import { createTenantBackupBoundaryRpcClient } from '@authrim/ar-lib-core/services/tenant-portability/boundary-rpc-client';
import { cleanupExpiredTenantBackupArtifact } from '@authrim/ar-lib-core/services/tenant-portability/expired-artifact-cleanup';
import { requireDedicatedAdminDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import { TenantBackupOperationKeyStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-key-store';
import { TenantBackupUploadStore } from '@authrim/ar-lib-core/services/tenant-portability/upload-store';
import { completeTenantBackupUpload } from '@authrim/ar-lib-core/services/tenant-portability/complete-upload';
import { cleanupExpiredTenantBackupUpload } from '@authrim/ar-lib-core/services/tenant-portability/cleanup-upload';
import { tenantBackupBoundaryId } from '@authrim/ar-lib-core/services/tenant-portability/snapshot-boundary-step';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';

export async function getTenantBackupKeyStore(
  env: Env
): Promise<TenantBackupOperationKeyStore | null> {
  const secret = env.TENANT_BACKUP_WRAPPING_KEY;
  if (!secret || !/^[a-fA-F0-9]{64}$/.test(secret)) return null;
  const raw = Uint8Array.from(secret.match(/../g) ?? [], (byte) => parseInt(byte, 16));
  try {
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
    const id = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return new TenantBackupOperationKeyStore(
      requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup'),
      { id, key }
    );
  } finally {
    raw.fill(0);
  }
}

/** Operational housekeeping only; actual capture handlers are connected separately. */
export async function processTenantBackupMaintenance(env: Env): Promise<{
  keysRemoved: number;
  uploadsCompleted: number;
  uploadFailures: number;
  uploadsCleaned: number;
  uploadCleanupFailures: number;
}> {
  if (env.EXPORT_ARTIFACTS) {
    await cleanupExpiredTenantBackupArtifact({
      database: requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup'),
      bucket: env.EXPORT_ARTIFACTS,
      now: Date.now(),
    });
  }
  let uploadsCompleted = 0;
  let uploadFailures = 0;
  let uploadsCleaned = 0;
  let uploadCleanupFailures = 0;
  if (env.IMPORT_ARTIFACTS) {
    const uploads = new TenantBackupUploadStore(
      requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup')
    );
    const workerId = `management-${crypto.randomUUID()}`;
    for (let index = 0; index < 5; index += 1) {
      const upload = await uploads.claimCompletion(workerId, Date.now());
      if (!upload) break;
      try {
        await completeTenantBackupUpload({
          store: uploads,
          bucket: env.IMPORT_ARTIFACTS,
          owner: {
            tenantId: upload.tenant_id,
            actorId: upload.created_by,
            uploadId: upload.id,
          },
          signal: new AbortController().signal,
          now: Date.now,
        });
        uploadsCompleted += 1;
      } catch {
        uploadFailures += 1;
      }
    }
    for (let index = 0; index < 5; index += 1) {
      try {
        const result = await cleanupExpiredTenantBackupUpload({
          store: uploads,
          bucket: env.IMPORT_ARTIFACTS,
          workerId,
          now: Date.now,
        });
        if (!result.cleaned) break;
        uploadsCleaned += 1;
      } catch {
        uploadCleanupFailures += 1;
        break;
      }
    }
  }
  const keys = await getTenantBackupKeyStore(env);
  return {
    keysRemoved: keys ? await keys.cleanupPage(Date.now()) : 0,
    uploadsCompleted,
    uploadFailures,
    uploadsCleaned,
    uploadCleanupFailures,
  };
}

/** Use the same stable environment label as Setup's authenticated Control service binding. */
export function getTenantBackupBoundaryClient(
  env: Env,
  operation: { tenantId: string; operationId: string; inventoryDigest: string }
) {
  if (!env.CONTROL || !env.AUTHRIM_ENVIRONMENT_NAME)
    throw new Error('backup_boundary_rpc_unavailable');
  return createTenantBackupBoundaryRpcClient(env.CONTROL, {
    ...operation,
    environmentId: env.AUTHRIM_ENVIRONMENT_NAME,
  });
}

/** Abort the exact operation boundary if capture reached inventory sealing; absence is idempotent. */
export async function abortTenantBackupBoundary(
  env: Env,
  context: TenantBackupStepContext,
  now: () => number = Date.now
): Promise<void> {
  if (context.operation.kind !== 'export' || context.operation.state !== 'cancelling')
    throw new Error('backup_boundary_cleanup_state');
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new Error('backup_boundary_cleanup_clock');
  const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  const inventory = await database.queryOne<{ chain_digest: string }>(
    `SELECT p.chain_digest FROM tenant_backup_execution_inventories p
    JOIN tenant_backup_operations o ON o.id=p.operation_id AND o.tenant_id=p.tenant_id
    WHERE o.id=? AND o.tenant_id=? AND o.state='cancelling' AND o.lease_owner=?
    AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=? AND p.state='sealed'`,
    [
      context.lease.operationId,
      context.lease.tenantId,
      context.lease.owner,
      context.lease.fencingToken,
      timestamp,
      timestamp,
    ]
  );
  if (!inventory) return;
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId) throw new Error('backup_boundary_rpc_unavailable');
  const boundaryId = await tenantBackupBoundaryId({
    environmentId,
    tenantId: context.lease.tenantId,
    operationId: context.lease.operationId,
    inventoryDigest: inventory.chain_digest,
  });
  context.signal.throwIfAborted();
  const client = getTenantBackupBoundaryClient(env, {
    tenantId: context.lease.tenantId,
    operationId: context.lease.operationId,
    inventoryDigest: inventory.chain_digest,
  });
  await client.receipts.abort(
    {
      environmentId,
      tenantId: context.lease.tenantId,
      boundaryId,
      operationId: context.lease.operationId,
      inventoryDigest: inventory.chain_digest,
    },
    timestamp
  );
  context.signal.throwIfAborted();
}
