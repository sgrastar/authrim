import type {
  TenantBackupBoundaryAdmissionPort,
  TenantBackupBoundaryReceiptsPort,
} from './boundary-rpc-contract';
import type { TenantMutationBoundary } from './mutation-admission';
import type { BackupBoundaryIdentity, BackupBoundaryParticipant } from './boundary-receipts';
import {
  startTenantBackupSqliteCapture,
  type TenantBackupSqliteCaptureInput,
} from './sqlite-operation-capture';

export interface TenantBackupBoundaryStart extends BackupBoundaryParticipant {
  /** Must resolve only after the exact snapshot is active; retain uncertain starts for cleanup. */
  start(assertHeld: () => Promise<void>): Promise<void>;
}

/** Adapter for an already prepared SQL resource, retaining its operation and DDL guards. */
export function sqliteBoundaryParticipant(
  input: TenantBackupSqliteCaptureInput
): TenantBackupBoundaryStart {
  return {
    resourceId: input.resourceId,
    snapshotId: input.snapshotId,
    async start(assertHeld) {
      await startTenantBackupSqliteCapture({
        ...input,
        async assertBoundary() {
          await input.assertBoundary();
          await assertHeld();
        },
      });
    },
  };
}

/**
 * One short admission attempt across the complete prepared participant set.
 * The caller must verify required-store coverage and hold routing/DDL exclusions in assertReady.
 * A failed attempt never reuses its partial snapshots as a new boundary: they remain recorded
 * for cleanup. Retrying the same released attempt recovers its receipt without starting again.
 */
export async function startTenantBackupSnapshotBoundary(input: {
  identity: BackupBoundaryIdentity;
  participants: readonly TenantBackupBoundaryStart[];
  admission: TenantBackupBoundaryAdmissionPort;
  receipts: TenantBackupBoundaryReceiptsPort;
  signal: AbortSignal;
  now: () => number;
  assertReady: () => Promise<void>;
}): Promise<TenantMutationBoundary> {
  const { admission, receipts, signal, now } = input;
  const identity = { ...input.identity };
  // Keep the identities and callbacks stable across awaits, independent of caller mutation.
  const participants = input.participants.map((item) => ({
    resourceId: item.resourceId,
    snapshotId: item.snapshotId,
    start: item.start.bind(item),
  }));
  const check = async () => {
    signal.throwIfAborted();
    await input.assertReady();
    signal.throwIfAborted();
  };
  await check();
  const recovered = await receipts.readReleased(identity, participants, now());
  if (recovered) {
    await check();
    return recovered;
  }
  try {
    const boundary = await admission.begin({
      id: identity.boundaryId,
      tenantId: identity.tenantId,
      operationId: identity.operationId,
      inventoryDigest: identity.inventoryDigest,
      now: now(),
    });
    if (!boundary) throw new Error('backup_boundary_unavailable');
    if (!(await receipts.plan(identity, participants, now())))
      throw new Error('backup_boundary_plan_rejected');
    await check();
    if (!(await admission.hold(identity.tenantId, identity.boundaryId, now())))
      throw new Error('backup_boundary_writers_pending');
    const assertHeld = async () => {
      await check();
      await receipts.assertHeld(identity, now());
    };
    // Await every start, including failures, so abort cannot race our own unfinished callbacks.
    const starts = await Promise.allSettled(
      participants.map(async (participant) => {
        await assertHeld();
        await participant.start(assertHeld);
        await assertHeld();
        if (!(await receipts.acknowledge(identity, participant, now())))
          throw new Error('backup_boundary_receipt_rejected');
      })
    );
    if (starts.some((result) => result.status === 'rejected'))
      throw new Error('backup_boundary_participant_failed');
    await assertHeld();
    const released = await receipts.release(identity, now());
    if (!released) throw new Error('backup_boundary_release_rejected');
    return released;
  } catch {
    // A lost successful release response remains released; abort only changes active attempts.
    await receipts.abort(identity, now());
    throw new Error('backup_snapshot_boundary_failed');
  }
}
