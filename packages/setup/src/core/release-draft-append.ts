import type { AuthrimLock } from './lock.js';
import {
  assertSameVersionDraftAppendUnpublished,
  evaluateSameVersionDraftAppend,
  type ReleaseMigrationManifest,
  type ReleaseMigrationPhysicalTarget,
  type SameVersionDraftAppendResult,
} from './release-migrations.js';

export type SameVersionDraftAppend = Extract<SameVersionDraftAppendResult, { allowed: true }>;

/**
 * Resolve the tail of an unpublished development draft that must be applied to an environment that
 * already runs the same product version, or `undefined` when this update is not such a case.
 *
 * It is `undefined` for published manifests (they never re-run), for a different installed
 * version (the normal upgrade paths apply), and when this exact draft was already verified.
 * Otherwise the append is allowed only with evidence recorded in the lock that every target's
 * applied files are an identical prefix of the draft, and only while the version is not
 * reachable from remote `main` as a release tag. Anything else throws, so the caller never
 * proceeds with an empty plan and then records the new draft checksum as installed.
 */
export function resolveSameVersionDraftAppend(input: {
  migrationsRoot: string;
  manifest: ReleaseMigrationManifest;
  manifestChecksum: string;
  manifestIsDraft: boolean;
  lock: AuthrimLock;
  targets: readonly ReleaseMigrationPhysicalTarget[];
  /** False in a dry run, which may read from the remote but must not fetch from it. */
  allowFetch?: boolean;
  assertUnpublished?: typeof assertSameVersionDraftAppendUnpublished;
}): SameVersionDraftAppend | undefined {
  const productVersion = input.manifest.productVersion;
  if (!input.manifestIsDraft || input.lock.productVersion !== productVersion) return undefined;

  const release = input.lock.releaseUpdate;
  if (
    release?.phase === 'verified' &&
    release.targetVersion === productVersion &&
    release.manifestChecksum === input.manifestChecksum
  ) {
    return undefined;
  }

  const evaluation = evaluateSameVersionDraftAppend({
    manifest: input.manifest,
    manifestChecksum: input.manifestChecksum,
    installedProductVersion: input.lock.productVersion,
    installedSchemaTargets: input.lock.schemaTargets,
    currentTargets: input.targets,
    targetManifestIsDraft: input.manifestIsDraft,
  });
  if (!evaluation.allowed) {
    throw new Error(`draft_append_rejected:${productVersion}:${evaluation.reason}`);
  }
  if (!evaluation.hasForwardProgress) {
    // The files are unchanged and nothing is behind: only the manifest metadata differs. Running
    // an empty plan would record the new checksum as verified without any database evidence.
    throw new Error(`draft_append_rejected:${productVersion}:no_forward_progress`);
  }
  (input.assertUnpublished ?? assertSameVersionDraftAppendUnpublished)({
    migrationsRoot: input.migrationsRoot,
    productVersion,
    ...(input.allowFetch === false ? { allowFetch: false } : {}),
  });
  return evaluation;
}
