import type {
  ReleaseMigrationManifest,
  ReleaseMigrationPhysicalTarget,
} from './release-migrations.js';
import { streamDirectory } from './release-migrations.js';
import { runD1Migrations } from './cloudflare.js';

export interface ReleaseSchemaTargetPlan {
  target: ReleaseMigrationPhysicalTarget;
  changedFiles: string[];
  requiresAction: boolean;
  blockedReason?: string;
}

export interface ReleaseSchemaUpdatePlan {
  productVersion: string;
  targets: ReleaseSchemaTargetPlan[];
  automaticTargets: ReleaseSchemaTargetPlan[];
  manualTargets: ReleaseSchemaTargetPlan[];
  blockedTargets: ReleaseSchemaTargetPlan[];
}

function streamFiles(
  manifest: ReleaseMigrationManifest | undefined,
  streamId: string | null
): Map<string, string> {
  if (!manifest || !streamId) return new Map();
  const stream = manifest.streams.find((candidate) => candidate.id === streamId);
  return new Map((stream?.files ?? []).map((file) => [file.path, file.checksum]));
}

export function releaseMigrationStreamChangedFiles(
  targetManifest: ReleaseMigrationManifest,
  currentManifest: ReleaseMigrationManifest | undefined,
  streamId: string | null
): string[] {
  if (!streamId) return [];
  const currentFiles = streamFiles(currentManifest, streamId);
  const targetStream = targetManifest.streams.find((candidate) => candidate.id === streamId);
  return (targetStream?.files ?? [])
    .filter((file) => {
      if (currentFiles.get(file.path) === file.checksum) return false;
      return !(
        file.supersedes?.length &&
        file.supersedes.every(
          (superseded) => currentFiles.get(superseded.path) === superseded.checksum
        )
      );
    })
    .map((file) => file.path);
}

export function buildReleaseSchemaUpdatePlan(input: {
  targetManifest: ReleaseMigrationManifest;
  currentManifest?: ReleaseMigrationManifest;
  currentManifestForTarget?: (
    target: ReleaseMigrationPhysicalTarget
  ) => ReleaseMigrationManifest | undefined;
  targets: ReleaseMigrationPhysicalTarget[];
}): ReleaseSchemaUpdatePlan {
  const targets = input.targets.map((target): ReleaseSchemaTargetPlan => {
    const targetCurrentManifest = input.currentManifestForTarget
      ? input.currentManifestForTarget(target)
      : input.currentManifest;
    const targetStream = target.streamId
      ? input.targetManifest.streams.find((stream) => stream.id === target.streamId)
      : undefined;
    const changedFiles = releaseMigrationStreamChangedFiles(
      input.targetManifest,
      targetCurrentManifest,
      target.streamId
    );
    const missingStream = !target.streamId || !targetStream;
    const requiresAction =
      missingStream || targetCurrentManifest === undefined || changedFiles.length > 0;
    const blockedReason = missingStream
      ? target.streamId
        ? `release_migration_stream_not_found:${target.streamId}`
        : (target.blockedReason ?? `release_migration_stream_not_found:${target.id}`)
      : requiresAction && !target.automatic
        ? (target.blockedReason ?? 'manual_migration_required')
        : undefined;
    return { target, changedFiles, requiresAction, ...(blockedReason ? { blockedReason } : {}) };
  });
  return {
    productVersion: input.targetManifest.productVersion,
    targets,
    automaticTargets: targets.filter(
      (plan) => plan.requiresAction && plan.target.automatic && !plan.blockedReason
    ),
    manualTargets: targets.filter(
      (plan) => plan.requiresAction && !plan.target.automatic && !plan.blockedReason
    ),
    blockedTargets: targets.filter((plan) => Boolean(plan.blockedReason)),
  };
}

const CONTROL_MANAGED_RELEASE_STREAMS = ['d1-core', 'd1-pii', 'd1-lookup'] as const;

export function getControlManagedReleaseStreamIds(input: {
  targetManifest: ReleaseMigrationManifest;
  currentManifest?: ReleaseMigrationManifest;
}): Array<(typeof CONTROL_MANAGED_RELEASE_STREAMS)[number]> {
  return CONTROL_MANAGED_RELEASE_STREAMS.filter(
    (streamId) =>
      releaseMigrationStreamChangedFiles(input.targetManifest, input.currentManifest, streamId)
        .length > 0
  );
}

export interface ReleaseSchemaTargetResult {
  targetId: string;
  success: boolean;
  appliedCount: number;
  skippedCount: number;
  error?: string;
}

export interface ReleaseSchemaUpdateResult {
  success: boolean;
  results: ReleaseSchemaTargetResult[];
}

async function runTargetGroup(input: {
  group: ReleaseSchemaTargetPlan[];
  manifest: ReleaseMigrationManifest;
  migrationsRoot: string;
  backfillLegacyChecksums: boolean;
  onProgress?: (message: string) => void;
}): Promise<ReleaseSchemaTargetResult[]> {
  const results: ReleaseSchemaTargetResult[] = [];
  for (const plan of input.group) {
    const target = plan.target;
    const stream = input.manifest.streams.find((candidate) => candidate.id === target.streamId);
    const directory = target.streamId
      ? streamDirectory(input.migrationsRoot, target.streamId)
      : null;
    if (!stream || !directory) {
      results.push({
        targetId: target.id,
        success: false,
        appliedCount: 0,
        skippedCount: 0,
        error: `release_migration_target_unresolvable:${target.id}`,
      });
      break;
    }
    if (!target.databaseId) {
      results.push({
        targetId: target.id,
        success: false,
        appliedCount: 0,
        skippedCount: 0,
        error: `release_migration_target_database_id_required:${target.id}`,
      });
      break;
    }
    const targetLabel = target.binding ?? target.id;
    const targetDisplayName = target.databaseName ?? target.databaseId;
    input.onProgress?.(
      `Migrating ${targetLabel} (${targetDisplayName}) to ${input.manifest.productVersion}`
    );
    const targetProgress = input.onProgress
      ? (message: string): void => input.onProgress?.(`[${targetLabel}] ${message.trimStart()}`)
      : undefined;
    const result = await runD1Migrations(target.databaseId, directory, targetProgress, {
      manifestFiles: stream.files,
      releaseVersion: input.manifest.productVersion,
      backfillLegacyChecksums: input.backfillLegacyChecksums,
    });
    results.push({
      targetId: target.id,
      success: result.success,
      appliedCount: result.appliedCount,
      skippedCount: result.skippedCount,
      ...(result.error ? { error: result.error } : {}),
    });
    if (!result.success) {
      input.onProgress?.(
        `❌ Migration failed for ${targetLabel} (${targetDisplayName}): ${result.error ?? 'unknown migration error'}`
      );
      break;
    }
  }
  return results;
}

export async function applyReleaseSchemaUpdatePlan(input: {
  plan: ReleaseSchemaUpdatePlan;
  manifest: ReleaseMigrationManifest;
  migrationsRoot: string;
  concurrency?: number;
  backfillLegacyChecksums?: boolean;
  onProgress?: (message: string) => void;
}): Promise<ReleaseSchemaUpdateResult> {
  if (input.plan.blockedTargets.length > 0) {
    return {
      success: false,
      results: input.plan.blockedTargets.map((plan) => ({
        targetId: plan.target.id,
        success: false,
        appliedCount: 0,
        skippedCount: 0,
        error: plan.blockedReason,
      })),
    };
  }

  const plansByDatabase = new Map<string, ReleaseSchemaTargetPlan[]>();
  for (const target of input.plan.automaticTargets) {
    const databaseKey = target.target.databaseId ?? target.target.databaseName ?? target.target.id;
    const group = plansByDatabase.get(databaseKey) ?? [];
    group.push(target);
    plansByDatabase.set(databaseKey, group);
  }
  const groups = [...plansByDatabase.values()].map((group) =>
    group.sort((a, b) => a.target.streamId?.localeCompare(b.target.streamId ?? '') ?? 0)
  );
  const concurrency = Math.max(1, Math.floor(input.concurrency ?? 2));
  const results: ReleaseSchemaTargetResult[] = [];
  let index = 0;
  let stopped = false;
  const workers = Array.from({ length: Math.min(concurrency, groups.length) }, async () => {
    while (!stopped && index < groups.length) {
      const group = groups[index++];
      const groupResults = await runTargetGroup({
        group,
        manifest: input.manifest,
        migrationsRoot: input.migrationsRoot,
        backfillLegacyChecksums: input.backfillLegacyChecksums === true,
        onProgress: input.onProgress,
      });
      results.push(...groupResults);
      if (groupResults.some((result) => !result.success)) stopped = true;
    }
  });
  await Promise.all(workers);
  return {
    success: !stopped && results.every((result) => result.success),
    results: results.sort((a, b) => a.targetId.localeCompare(b.targetId)),
  };
}
