import type { AuthrimLock } from './lock.js';
import type { ReleaseRolloutHandoffStatus } from './release-rollout-handoff.js';
import {
  calculateReleaseManifestChecksum,
  type ReleaseMigrationManifest,
  type ReleaseMigrationPhysicalTarget,
} from './release-migrations.js';

export function withReleaseUpdateState(
  lock: AuthrimLock,
  input: {
    targetVersion: string;
    phase:
      | 'planned'
      | 'control_handoff'
      | 'awaiting_setup'
      | 'schema_applied'
      | 'workers_deployed'
      | 'verified'
      | 'database_only_verified';
    manifestChecksum: string;
    appliedTargets?: string[];
    manualTargets?: string[];
    controlOperationId?: string;
    controlCompletedTargets?: number;
    controlTotalTargets?: number;
    initialWorkerRedeployRequired?: boolean;
  }
): AuthrimLock {
  const now = new Date().toISOString();
  const existing =
    lock.releaseUpdate?.targetVersion === input.targetVersion &&
    lock.releaseUpdate.manifestChecksum === input.manifestChecksum
      ? lock.releaseUpdate
      : undefined;
  const initialWorkerRedeployRequired =
    input.initialWorkerRedeployRequired ?? existing?.initialWorkerRedeployRequired ?? false;
  const controlOperationId = input.controlOperationId ?? existing?.controlOperationId;
  const controlCompletedTargets =
    input.controlCompletedTargets ?? existing?.controlCompletedTargets;
  const controlTotalTargets = input.controlTotalTargets ?? existing?.controlTotalTargets;
  return {
    ...lock,
    ...(input.phase === 'verified' ? { productVersion: input.targetVersion } : {}),
    releaseUpdate: {
      targetVersion: input.targetVersion,
      ...(existing?.previousProductVersion || lock.productVersion
        ? { previousProductVersion: existing?.previousProductVersion ?? lock.productVersion }
        : {}),
      phase: input.phase,
      manifestChecksum: input.manifestChecksum,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      appliedTargets: input.appliedTargets ?? existing?.appliedTargets ?? [],
      manualTargets: input.manualTargets ?? existing?.manualTargets ?? [],
      ...(controlOperationId ? { controlOperationId } : {}),
      ...(controlCompletedTargets !== undefined ? { controlCompletedTargets } : {}),
      ...(controlTotalTargets !== undefined ? { controlTotalTargets } : {}),
      ...(initialWorkerRedeployRequired ? { initialWorkerRedeployRequired: true } : {}),
    },
    updatedAt: now,
  };
}

export function withRecoveredReleaseUpdateState(
  lock: AuthrimLock,
  input: {
    targetVersion: string;
    manifestChecksum: string;
    activeRollout: ReleaseRolloutHandoffStatus;
  }
): AuthrimLock {
  const { activeRollout } = input;
  if (activeRollout.targetVersion !== input.targetVersion) {
    throw new Error(
      `release_rollout_active_target_mismatch:${activeRollout.targetVersion}:${input.targetVersion}`
    );
  }
  if (activeRollout.manifestDigest !== input.manifestChecksum) {
    throw new Error(
      `release_rollout_active_manifest_mismatch:${activeRollout.manifestDigest}:${input.manifestChecksum}`
    );
  }
  const expectedSourceVersion =
    lock.releaseUpdate?.previousProductVersion ?? lock.productVersion ?? null;
  if (
    activeRollout.sourceVersion !== null &&
    expectedSourceVersion !== null &&
    activeRollout.sourceVersion !== expectedSourceVersion
  ) {
    throw new Error(
      `release_rollout_active_source_mismatch:${activeRollout.sourceVersion}:${expectedSourceVersion}`
    );
  }
  if (activeRollout.phase === 'completed') {
    throw new Error('release_rollout_active_phase_invalid:completed');
  }
  const phase =
    activeRollout.phase === 'awaiting_setup'
      ? 'awaiting_setup'
      : activeRollout.phase === 'verifying'
        ? 'schema_applied'
        : 'control_handoff';
  return withReleaseUpdateState(lock, {
    targetVersion: input.targetVersion,
    phase,
    manifestChecksum: input.manifestChecksum,
    controlOperationId: activeRollout.operationId,
    controlCompletedTargets: activeRollout.completedTargets,
    controlTotalTargets: activeRollout.totalTargets,
  });
}

export function withSchemaTargetStates(
  lock: AuthrimLock,
  input: {
    targetIds: string[];
    manualTargetIds: ReadonlySet<string>;
    productVersion: string;
    manifestChecksum: string;
    targetStreamIds: ReadonlyMap<string, string | null>;
    manifest: ReleaseMigrationManifest;
  }
): AuthrimLock {
  const updatedAt = new Date().toISOString();
  const schemaTargets = { ...(lock.schemaTargets ?? {}) };
  for (const targetId of input.targetIds) {
    const streamId = input.targetStreamIds.get(targetId);
    if (!streamId) {
      throw new Error(`release_schema_target_stream_missing:${targetId}`);
    }
    const stream = input.manifest.streams.find((candidate) => candidate.id === streamId);
    if (!stream) {
      throw new Error(`release_manifest_stream_missing:${targetId}:${streamId}`);
    }
    schemaTargets[targetId] = {
      productVersion: input.productVersion,
      manifestChecksum: input.manifestChecksum,
      streamId,
      files: stream.files.map((file) => ({ path: file.path, checksum: file.checksum })),
      appliedBy: input.manualTargetIds.has(targetId) ? 'operator' : 'automatic',
      updatedAt,
    };
  }
  return { ...lock, schemaTargets, updatedAt };
}

export function withRecordedReleaseSchemaTargets(
  lock: AuthrimLock,
  input: {
    productVersion: string;
    manifest: ReleaseMigrationManifest;
    targets: ReleaseMigrationPhysicalTarget[];
    targetIds?: ReadonlySet<string>;
    manualTargetIds?: ReadonlySet<string>;
  }
): AuthrimLock {
  const selectedTargets = input.targetIds
    ? input.targets.filter((target) => input.targetIds?.has(target.id))
    : input.targets;
  const unresolved = selectedTargets.filter((target) => !target.streamId);
  if (unresolved.length > 0) {
    throw new Error(
      `release_schema_target_stream_missing:${unresolved.map((target) => target.id).join(',')}`
    );
  }
  return withSchemaTargetStates(lock, {
    targetIds: selectedTargets.map((target) => target.id),
    manualTargetIds: input.manualTargetIds ?? new Set<string>(),
    productVersion: input.productVersion,
    manifestChecksum: calculateReleaseManifestChecksum(input.manifest),
    targetStreamIds: new Map(selectedTargets.map((target) => [target.id, target.streamId])),
    manifest: input.manifest,
  });
}

export function withVerifiedInitialReleaseState(
  lock: AuthrimLock,
  input: {
    productVersion: string;
    manifestChecksum: string;
    manifest: ReleaseMigrationManifest;
    targets: ReleaseMigrationPhysicalTarget[];
    acknowledgedManualTargetIds?: ReadonlySet<string>;
  }
): AuthrimLock {
  const manualTargetIds = input.acknowledgedManualTargetIds ?? new Set<string>();
  const unreadyTargets = input.targets.filter(
    (target) => !target.streamId || (!target.automatic && !manualTargetIds.has(target.id))
  );
  if (unreadyTargets.length > 0) {
    throw new Error(
      `initial_release_schema_targets_not_ready:${unreadyTargets
        .map((target) => target.id)
        .join(',')}`
    );
  }
  const readyTargets = input.targets;
  const targetIds = readyTargets.map((target) => target.id);
  const withTargets = withSchemaTargetStates(lock, {
    targetIds,
    manualTargetIds,
    productVersion: input.productVersion,
    manifestChecksum: input.manifestChecksum,
    targetStreamIds: new Map(readyTargets.map((target) => [target.id, target.streamId])),
    manifest: input.manifest,
  });
  return withReleaseUpdateState(withTargets, {
    targetVersion: input.productVersion,
    phase: 'verified',
    manifestChecksum: input.manifestChecksum,
    appliedTargets: targetIds,
    manualTargets: [...manualTargetIds],
    initialWorkerRedeployRequired: false,
  });
}
