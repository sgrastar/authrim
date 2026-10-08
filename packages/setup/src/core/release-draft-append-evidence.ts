import { verifyD1AppliedMigrationFiles } from './cloudflare.js';
import type { SameVersionDraftAppend } from './release-draft-append.js';
import type { ReleaseMigrationPhysicalTarget } from './release-migrations.js';
import type { AuthrimLock } from './lock.js';
import { withSchemaTargetStates } from './release-state.js';
import type { ReleaseMigrationManifest } from './release-migrations.js';
import {
  listControlSnapshotPreview,
  listReleaseRolloutTargets,
  verifyControlRolloutCoversTargets,
} from './release-rollout-handoff.js';

type FileEvidence = { path: string; checksum: string };

/**
 * Check, for every automatic D1 target and before anything is changed, that the database really
 * records each file the lock says was applied (same name, same checksum). This also covers
 * databases the append leaves unchanged and the tenant databases Control will migrate, so a
 * restored, edited or hand-modified database stops the update instead of being extended.
 */
export async function verifyDraftAppendDatabaseEvidence(input: {
  append: SameVersionDraftAppend;
  targets: readonly ReleaseMigrationPhysicalTarget[];
  concurrency?: number;
  verify?: typeof verifyD1AppliedMigrationFiles;
  onProgress?: (message: string) => void;
}): Promise<void> {
  const verify = input.verify ?? verifyD1AppliedMigrationFiles;
  const queue = input.targets.filter(
    (target) => target.automatic && target.driver === 'd1' && target.streamId && target.databaseId
  );
  const failures: string[] = [];
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < queue.length) {
      const target = queue[index++]!;
      const recorded: readonly FileEvidence[] =
        input.append.recordedFilesByTarget.get(target.id) ?? [];
      input.onProgress?.(`Verifying recorded migrations of ${target.binding ?? target.id}`);
      const result = await verify(target.databaseId!, recorded);
      if (!result.success) failures.push(`${target.id}:${result.error ?? 'verification_failed'}`);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, input.concurrency ?? 4), queue.length) }, worker)
  );
  if (failures.length > 0) {
    throw new Error(`draft_append_database_evidence_mismatch:${failures.sort().join(' | ')}`);
  }
}

/** Tenant databases of the Control-managed streams: the set Control must have migrated. */
export function expectedControlManagedTargets(
  targets: readonly ReleaseMigrationPhysicalTarget[],
  managedStreamIds: readonly string[]
): ReleaseMigrationPhysicalTarget[] {
  return targets.filter(
    (target) =>
      target.scope === 'tenant' &&
      target.automatic &&
      target.databaseId &&
      target.streamId &&
      managedStreamIds.includes(target.streamId)
  );
}

const targetKey = (databaseId: string, streamId: string): string => `${databaseId}:${streamId}`;

function lockD1Keys(targets: readonly ReleaseMigrationPhysicalTarget[]): Set<string> {
  return new Set(
    targets
      .filter((target) => target.automatic && target.driver === 'd1')
      .flatMap((target) =>
        target.databaseId && target.streamId ? [targetKey(target.databaseId, target.streamId)] : []
      )
  );
}

/**
 * Before the handoff exists, compare the databases Control will snapshot with the lock's. Control
 * applies SQL to whatever it snapshots, so a database the lock does not know (no recorded evidence),
 * one the lock expects but Control lacks, or one whose provider ID is not resolved yet must stop
 * the update here; a check after the fact could not undo an application.
 */
export async function assertControlSnapshotMatchesLock(input: {
  controlDatabaseId: string;
  environmentId: string;
  targets: readonly ReleaseMigrationPhysicalTarget[];
  managedStreamIds: readonly string[];
  preview?: typeof listControlSnapshotPreview;
}): Promise<void> {
  const rows = (
    await (input.preview ?? listControlSnapshotPreview)({
      controlDatabaseId: input.controlDatabaseId,
      environmentId: input.environmentId,
    })
  ).filter((row) => input.managedStreamIds.includes(row.streamId));
  const known = lockD1Keys(input.targets);
  const control = new Set<string>();
  const unresolved: string[] = [];
  const unknown: string[] = [];
  for (const row of rows) {
    if (!row.databaseId) {
      unresolved.push(row.streamId);
      continue;
    }
    const key = targetKey(row.databaseId, row.streamId);
    control.add(key);
    if (!known.has(key)) unknown.push(key);
  }
  const missing = expectedControlManagedTargets(input.targets, input.managedStreamIds)
    .map((target) => targetKey(target.databaseId!, target.streamId!))
    .filter((key) => !control.has(key));
  if (unresolved.length > 0 || unknown.length > 0 || missing.length > 0) {
    throw new Error(
      'control_target_set_mismatch:' +
        `unknown_to_lock=[${unknown.sort().join(',')}] ` +
        `missing_in_control=[${missing.sort().join(',')}] ` +
        `unresolved=[${unresolved.sort().join(',')}]`
    );
  }
}

/**
 * After Control's rollout is ready, record the tenant databases it migrated in the lock, but only
 * from Control's own record. `strict` (same-version draft append, whose next append depends on this
 * evidence) stops on any mismatch. A normal upgrade keeps its previous behaviour when the record
 * does not match: it warns and leaves the old evidence rather than failing a finished migration.
 */
export async function recordControlMigratedEvidence(input: {
  lock: AuthrimLock;
  controlDatabaseId: string;
  environmentId: string;
  operationId: string;
  targets: readonly ReleaseMigrationPhysicalTarget[];
  managedStreamIds: readonly string[];
  productVersion: string;
  manifestChecksum: string;
  manifest: ReleaseMigrationManifest;
  strict: boolean;
  listTargets?: typeof listReleaseRolloutTargets;
}): Promise<{ lock: AuthrimLock; recordedTargetIds: string[]; warnings: string[] }> {
  const expected = expectedControlManagedTargets(input.targets, input.managedStreamIds);
  // A same-version append must still read Control's record when nothing is expected: Control may
  // have migrated databases the lock does not know, and that must stop the update.
  if (expected.length === 0 && !input.strict) {
    return { lock: input.lock, recordedTargetIds: [], warnings: [] };
  }
  const warnings: string[] = [];
  try {
    const rows = await (input.listTargets ?? listReleaseRolloutTargets)({
      controlDatabaseId: input.controlDatabaseId,
      environmentId: input.environmentId,
      operationId: input.operationId,
    });
    const { missing, unexpected } = verifyControlRolloutCoversTargets({
      expected: expected.map((target) => ({
        databaseId: target.databaseId!,
        streamId: target.streamId!,
      })),
      rows,
    });
    if (missing.length > 0)
      throw new Error(`control_rollout_targets_incomplete:${missing.join(',')}`);
    const known = lockD1Keys(input.targets);
    const unknownToLock = unexpected.filter((key) => !known.has(key));
    if (unknownToLock.length > 0) {
      throw new Error(`control_rollout_targets_unknown_to_lock:${unknownToLock.join(',')}`);
    }
  } catch (error) {
    if (input.strict) throw error;
    warnings.push(error instanceof Error ? error.message : String(error));
    return { lock: input.lock, recordedTargetIds: [], warnings };
  }
  if (expected.length === 0) return { lock: input.lock, recordedTargetIds: [], warnings };
  const lock = withSchemaTargetStates(input.lock, {
    targetIds: expected.map((target) => target.id),
    manualTargetIds: new Set<string>(),
    productVersion: input.productVersion,
    manifestChecksum: input.manifestChecksum,
    targetStreamIds: new Map(input.targets.map((target) => [target.id, target.streamId])),
    manifest: input.manifest,
    preserveExistingFiles: true,
  });
  return { lock, recordedTargetIds: expected.map((target) => target.id), warnings };
}
