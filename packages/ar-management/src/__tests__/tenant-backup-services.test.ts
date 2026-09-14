import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { TenantBackupBoundaryRequest } from '@authrim/ar-lib-core/services/tenant-portability/boundary-rpc-contract';
import {
  processTenantBackupMaintenance,
  getTenantBackupBoundaryClient,
  abortTenantBackupBoundary,
} from '../tenant-backup-services';
const db = vi.hoisted(() => ({ execute: vi.fn(), queryOne: vi.fn() }));
const uploads = vi.hoisted(() => ({ claim: vi.fn(), complete: vi.fn() }));
const cleanup = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@authrim/ar-lib-core', () => ({ requireDedicatedAdminDatabaseAdapter: () => db }));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/upload-store', () => ({
  TenantBackupUploadStore: class {
    claimCompletion = uploads.claim;
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/complete-upload', () => ({
  completeTenantBackupUpload: uploads.complete,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/cleanup-upload', () => ({
  cleanupExpiredTenantBackupUpload: cleanup.run,
}));
beforeEach(() => {
  vi.clearAllMocks();
  db.execute.mockResolvedValue({ success: true, rowsAffected: 3 });
  uploads.claim.mockResolvedValue(null);
  uploads.complete.mockResolvedValue({});
  cleanup.run.mockResolvedValue({ cleaned: false });
});
it('does not contact storage without a configured backup key', async () => {
  expect(await processTenantBackupMaintenance({} as Env)).toEqual({
    keysRemoved: 0,
    uploadsCompleted: 0,
    uploadFailures: 0,
    uploadsCleaned: 0,
    uploadCleanupFailures: 0,
  });
  expect(db.execute).not.toHaveBeenCalled();
});
it('runs bounded database key cleanup when configured and propagates database failures', async () => {
  const env = { TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32) } as Env;
  expect(await processTenantBackupMaintenance(env)).toEqual({
    keysRemoved: 3,
    uploadsCompleted: 0,
    uploadFailures: 0,
    uploadsCleaned: 0,
    uploadCleanupFailures: 0,
  });
  expect(db.execute).toHaveBeenCalledWith(expect.stringContaining('LIMIT 100'), [
    expect.any(Number),
    expect.any(Number),
  ]);
  db.execute.mockRejectedValue(new Error('storage unavailable'));
  await expect(processTenantBackupMaintenance(env)).rejects.toThrow('storage unavailable');
});

it('cleans expired output even without a wrapping key', async () => {
  db.queryOne.mockResolvedValue(null);
  const bucket = { delete: vi.fn() };
  expect(
    await processTenantBackupMaintenance({ EXPORT_ARTIFACTS: bucket } as unknown as Env)
  ).toEqual({
    keysRemoved: 0,
    uploadsCompleted: 0,
    uploadFailures: 0,
    uploadsCleaned: 0,
    uploadCleanupFailures: 0,
  });
  expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('expires_at<=?'), [
    expect.any(Number),
  ]);
  expect(bucket.delete).not.toHaveBeenCalled();
});

it('completes at most five durably claimed uploads and reports isolated failures', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    id: `upload-${index}`,
    tenant_id: 'tenant',
    created_by: 'admin',
  }));
  uploads.claim.mockImplementation(async () => rows.shift() ?? null);
  uploads.complete.mockRejectedValueOnce(new Error('r2 unavailable'));
  expect(await processTenantBackupMaintenance({ IMPORT_ARTIFACTS: {} } as unknown as Env)).toEqual({
    keysRemoved: 0,
    uploadsCompleted: 4,
    uploadFailures: 1,
    uploadsCleaned: 0,
    uploadCleanupFailures: 0,
  });
  expect(uploads.claim).toHaveBeenCalledTimes(5);
  expect(uploads.complete).toHaveBeenCalledTimes(5);
  expect(uploads.complete).toHaveBeenCalledWith(
    expect.objectContaining({
      owner: { tenantId: 'tenant', actorId: 'admin', uploadId: 'upload-0' },
    })
  );
});

it('cleans at most five expired inputs and stops the cleanup page after an isolated failure', async () => {
  cleanup.run
    .mockResolvedValueOnce({ cleaned: true })
    .mockResolvedValueOnce({ cleaned: true })
    .mockRejectedValueOnce(new Error('r2 unavailable'));
  expect(await processTenantBackupMaintenance({ IMPORT_ARTIFACTS: {} } as unknown as Env)).toEqual({
    keysRemoved: 0,
    uploadsCompleted: 0,
    uploadFailures: 0,
    uploadsCleaned: 2,
    uploadCleanupFailures: 1,
  });
  expect(cleanup.run).toHaveBeenCalledTimes(3);
});

it('pins the boundary client to the deployment environment and rejects a mismatched Control reply', async () => {
  const operation = { tenantId: 'tenant', operationId: 'op', inventoryDigest: 'ab'.repeat(32) };
  expect(() => getTenantBackupBoundaryClient({} as Env, operation)).toThrow(
    'backup_boundary_rpc_unavailable'
  );
  const client = getTenantBackupBoundaryClient(
    {
      AUTHRIM_ENVIRONMENT_NAME: 'expected',
      CONTROL: {
        async tenantBackupSnapshotBoundary() {
          return { environmentId: 'wrong', boundary: null, accepted: true };
        },
      },
    } as unknown as Env,
    operation
  );
  await expect(
    client.receipts.assertHeld(
      { ...operation, environmentId: 'expected', boundaryId: 'cd'.repeat(32) },
      100
    )
  ).rejects.toThrow('backup_boundary_rpc_invalid');
});

it('aborts the deterministic sealed export boundary and treats a missing inventory as a no-op', async () => {
  const requests: TenantBackupBoundaryRequest[] = [];
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL: {
      async tenantBackupSnapshotBoundary(request: TenantBackupBoundaryRequest) {
        requests.push(request);
        return { environmentId: 'test', boundary: null, accepted: true };
      },
    },
  } as unknown as Env;
  const context = {
    operation: { kind: 'export', state: 'cancelling' },
    lease: {
      tenantId: 'tenant',
      operationId: 'operation',
      owner: 'cleaner',
      fencingToken: 4,
    },
    signal: new AbortController().signal,
  } as never;
  db.queryOne.mockResolvedValueOnce(null);
  await abortTenantBackupBoundary(env, context, () => 100);
  expect(requests).toEqual([]);

  db.queryOne.mockResolvedValueOnce({ chain_digest: 'ab'.repeat(32) });
  await abortTenantBackupBoundary(env, context, () => 101);
  expect(requests).toHaveLength(1);
  const request = requests[0];
  expect(request?.tenantId).toBe('tenant');
  expect(request?.operationId).toBe('operation');
  expect(request?.inventoryDigest).toBe('ab'.repeat(32));
  expect(request?.action).toBe('abort');
  expect(request?.boundaryId).toMatch(/^[a-f0-9]{64}$/);
});
