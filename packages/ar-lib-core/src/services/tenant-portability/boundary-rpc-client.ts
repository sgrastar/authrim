import type { BackupBoundaryIdentity } from './boundary-receipts';
import type {
  TenantBackupBoundaryRequest,
  TenantBackupBoundaryResponse,
  TenantBackupBoundaryAdmissionPort,
  TenantBackupBoundaryReceiptsPort,
} from './boundary-rpc-contract';
import {
  TENANT_BACKUP_BOUNDARY_DEADLINE_MS,
  TENANT_BACKUP_INTERMEDIATE_BOUNDARY_DEADLINE_MS,
  TENANT_BACKUP_LEGACY_BOUNDARY_DEADLINE_MS,
  TENANT_BACKUP_LONG_BOUNDARY_DEADLINE_MS,
} from './mutation-admission';

type Scope = Omit<BackupBoundaryIdentity, 'boundaryId'>;
function fail(): never {
  throw new Error('backup_boundary_rpc_invalid');
}

/** Pinned to one authenticated operation; no caller clock or environment override is sent. */
export function createTenantBackupBoundaryRpcClient(
  binding: {
    tenantBackupSnapshotBoundary?(
      request: TenantBackupBoundaryRequest
    ): Promise<TenantBackupBoundaryResponse>;
  },
  scope: Scope
): { admission: TenantBackupBoundaryAdmissionPort; receipts: TenantBackupBoundaryReceiptsPort } {
  const pinned = { ...scope };
  if (
    !binding.tenantBackupSnapshotBoundary ||
    [pinned.environmentId, pinned.tenantId, pinned.operationId].some(
      (id) => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(id)
    ) ||
    !/^[a-f0-9]{64}$/.test(pinned.inventoryDigest)
  )
    fail();
  function identity(value: BackupBoundaryIdentity) {
    if (
      value.environmentId !== pinned.environmentId ||
      value.tenantId !== pinned.tenantId ||
      value.operationId !== pinned.operationId ||
      value.inventoryDigest !== pinned.inventoryDigest ||
      !/^[a-f0-9]{64}$/.test(value.boundaryId)
    )
      fail();
    return {
      tenantId: pinned.tenantId,
      operationId: pinned.operationId,
      inventoryDigest: pinned.inventoryDigest,
      boundaryId: value.boundaryId,
    };
  }
  async function call(request: TenantBackupBoundaryRequest): Promise<TenantBackupBoundaryResponse> {
    if (!binding.tenantBackupSnapshotBoundary) fail();
    const result = await binding.tenantBackupSnapshotBoundary(request);
    if (
      !result ||
      result.environmentId !== pinned.environmentId ||
      typeof result.accepted !== 'boolean' ||
      !(
        result.boundary === null ||
        (typeof result.boundary === 'object' && !Array.isArray(result.boundary))
      )
    )
      fail();
    const b = result.boundary;
    const returnsBoundary = ['admit', 'begin', 'hold', 'release', 'readReleased'].includes(
      request.action
    );
    if (b) {
      if (
        !returnsBoundary ||
        !result.accepted ||
        b.id !== request.boundaryId ||
        b.tenant_id !== pinned.tenantId ||
        b.operation_id !== pinned.operationId ||
        b.inventory_digest !== pinned.inventoryDigest ||
        !Number.isSafeInteger(b.created_at) ||
        b.created_at < 0 ||
        !Number.isSafeInteger(b.deadline_at) ||
        ![
          TENANT_BACKUP_LONG_BOUNDARY_DEADLINE_MS,
          TENANT_BACKUP_BOUNDARY_DEADLINE_MS,
          TENANT_BACKUP_INTERMEDIATE_BOUNDARY_DEADLINE_MS,
          TENANT_BACKUP_LEGACY_BOUNDARY_DEADLINE_MS,
        ].includes(b.deadline_at - b.created_at)
      )
        fail();
      if (request.action === 'begin' && !['draining', 'held'].includes(b.state)) fail();
      if (request.action === 'admit' && b.state !== 'held') fail();
      if (request.action === 'hold' && b.state !== 'held') fail();
      if (['release', 'readReleased'].includes(request.action) && b.state !== 'released') fail();
      if (b.state === 'held' || b.state === 'released') {
        if (
          !Number.isSafeInteger(b.held_at) ||
          b.held_at === null ||
          b.held_at < b.created_at ||
          b.held_at >= b.deadline_at
        )
          fail();
      } else if (b.held_at !== null) fail();
      if (b.state === 'released') {
        if (
          !Number.isSafeInteger(b.released_at) ||
          b.released_at === null ||
          b.released_at < (b.held_at ?? b.created_at) ||
          b.released_at >= b.deadline_at
        )
          fail();
      } else if (b.released_at !== null) fail();
    } else if (returnsBoundary && result.accepted) fail();
    return result;
  }
  const receipts: TenantBackupBoundaryReceiptsPort = {
    async plan(value, participants, _now) {
      return (
        await call({
          ...identity(value),
          action: 'plan',
          participants: participants.map(({ resourceId, snapshotId }) => ({
            resourceId,
            snapshotId,
          })),
        })
      ).accepted;
    },
    async acknowledge(value, participant, _now) {
      return (
        await call({
          ...identity(value),
          action: 'acknowledge',
          participant: { resourceId: participant.resourceId, snapshotId: participant.snapshotId },
        })
      ).accepted;
    },
    async acknowledgeAll(value, participants, _now) {
      return (
        await call({
          ...identity(value),
          action: 'acknowledgeAll',
          participants: participants.map(({ resourceId, snapshotId }) => ({
            resourceId,
            snapshotId,
          })),
        })
      ).accepted;
    },
    async assertHeld(value, _now) {
      if (!(await call({ ...identity(value), action: 'assertHeld' })).accepted) fail();
    },
    async readReleased(value, participants, _now) {
      return (
        await call({
          ...identity(value),
          action: 'readReleased',
          participants: participants.map(({ resourceId, snapshotId }) => ({
            resourceId,
            snapshotId,
          })),
        })
      ).boundary;
    },
    async release(value, _now) {
      return (await call({ ...identity(value), action: 'release' })).boundary;
    },
    async abort(value, _now) {
      if (!(await call({ ...identity(value), action: 'abort' })).accepted) fail();
    },
  };
  return {
    receipts,
    admission: {
      async admit(value, participants) {
        return (
          await call({
            ...identity({
              ...pinned,
              tenantId: value.tenantId,
              operationId: value.operationId,
              inventoryDigest: value.inventoryDigest,
              boundaryId: value.id,
            }),
            action: 'admit',
            participants: participants.map(({ resourceId, snapshotId }) => ({
              resourceId,
              snapshotId,
            })),
          })
        ).boundary;
      },
      async begin(value) {
        return (
          await call({
            ...identity({
              ...pinned,
              tenantId: value.tenantId,
              operationId: value.operationId,
              inventoryDigest: value.inventoryDigest,
              boundaryId: value.id,
            }),
            action: 'begin',
          })
        ).boundary;
      },
      async hold(tenantId, boundaryId, _now) {
        return (await call({ ...identity({ ...pinned, tenantId, boundaryId }), action: 'hold' }))
          .boundary;
      },
    },
  };
}
