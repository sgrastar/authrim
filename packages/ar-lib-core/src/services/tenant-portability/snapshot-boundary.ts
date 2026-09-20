import type {
  TenantBackupBoundaryAdmissionPort,
  TenantBackupBoundaryReceiptsPort,
} from './boundary-rpc-contract';
import type { TenantMutationBoundary } from './mutation-admission';
import type { BackupBoundaryIdentity, BackupBoundaryParticipant } from './boundary-receipts';
import {
  prepareTenantBackupSqliteCaptureStart,
  type TenantBackupSqliteCaptureInput,
} from './sqlite-operation-capture';

export interface TenantBackupBoundaryStart extends BackupBoundaryParticipant {
  /** Must resolve only after the exact snapshot is active; retain uncertain starts for cleanup. */
  start(assertHeld: () => Promise<void>, boundaryUnixMs: number): Promise<void>;
}

/** Adapter for an already prepared SQL resource, retaining its operation and DDL guards. */
export async function sqliteBoundaryParticipant(
  input: TenantBackupSqliteCaptureInput
): Promise<TenantBackupBoundaryStart> {
  const start = await prepareTenantBackupSqliteCaptureStart(input);
  return {
    resourceId: input.resourceId,
    snapshotId: input.snapshotId,
    async start(assertHeld) {
      await assertHeld();
      await start(assertHeld);
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
    if (!Number.isSafeInteger(recovered.held_at) || (recovered.held_at ?? -1) < 0)
      throw new Error('backup_boundary_snapshot_timestamp_invalid');
    await check();
    return recovered;
  }
  try {
    const admissionInput = {
      id: identity.boundaryId,
      tenantId: identity.tenantId,
      operationId: identity.operationId,
      inventoryDigest: identity.inventoryDigest,
      now: now(),
    };
    const held = admission.admit
      ? await admission.admit(admissionInput, participants)
      : await (async () => {
          const boundary = await admission.begin(admissionInput);
          if (!boundary) throw new Error('backup_boundary_unavailable');
          if (!(await receipts.plan(identity, participants, now())))
            throw new Error('backup_boundary_plan_rejected');
          signal.throwIfAborted();
          return admission.hold(identity.tenantId, identity.boundaryId, now());
        })();
    if (!held) throw new Error('backup_boundary_writers_pending');
    if (!Number.isSafeInteger(held.held_at) || (held.held_at ?? -1) < 0)
      throw new Error('backup_boundary_snapshot_timestamp_invalid');
    const boundaryUnixMs = held.held_at ?? -1;
    const assertHeld = async () => {
      signal.throwIfAborted();
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp >= held.deadline_at)
        throw new Error('backup_boundary_not_held');
    };
    await check();
    await receipts.assertHeld(identity, now());
    // Await every start, including failures, so abort cannot race our own unfinished callbacks.
    const starts = await Promise.allSettled(
      participants.map(async (participant) => {
        await participant.start(assertHeld, boundaryUnixMs);
        await assertHeld();
      })
    );
    if (starts.some((result) => result.status === 'rejected'))
      throw new Error('backup_boundary_participant_failed');
    await assertHeld();
    await check();
    await receipts.assertHeld(identity, now());
    const acknowledged = receipts.acknowledgeAll
      ? await receipts.acknowledgeAll(identity, participants, now())
      : (
          await Promise.all(
            participants.map((participant) => receipts.acknowledge(identity, participant, now()))
          )
        ).every(Boolean);
    if (!acknowledged) throw new Error('backup_boundary_receipt_rejected');
    const released = await receipts.release(identity, now());
    if (!released) throw new Error('backup_boundary_release_rejected');
    if (released.held_at !== boundaryUnixMs)
      throw new Error('backup_boundary_snapshot_timestamp_invalid');
    return released;
  } catch {
    // A lost successful release response remains released; abort only changes active attempts.
    await receipts.abort(identity, now());
    throw new Error('backup_snapshot_boundary_failed');
  }
}
