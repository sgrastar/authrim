import type { AuthrimLock } from './lock.js';
import {
  calculateReleaseManifestChecksum,
  type ReleaseMigrationManifest,
  type ReleaseMigrationPhysicalTarget,
} from './release-migrations.js';

export function withReleaseUpdateState(
  lock: AuthrimLock,
  input: {
    targetVersion: string;
    phase: 'planned' | 'schema_applied' | 'workers_deployed' | 'verified';
    manifestChecksum: string;
    appliedTargets?: string[];
    manualTargets?: string[];
  }
): AuthrimLock {
  const now = new Date().toISOString();
  const existing =
    lock.releaseUpdate?.targetVersion === input.targetVersion &&
    lock.releaseUpdate.manifestChecksum === input.manifestChecksum
      ? lock.releaseUpdate
      : undefined;
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
    },
    updatedAt: now,
  };
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
  });
}
