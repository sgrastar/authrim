import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  MIGRATION_LOGICAL_ROLES,
  MIGRATION_MANIFEST_DIALECTS,
  MIGRATION_SCHEMA_FAMILIES,
  MIGRATION_STREAM_CONTRACTS,
  MIGRATION_STREAM_IDS,
  MIGRATION_TARGET_KINDS,
  isMigrationLogicalRole,
  migrationRendererDialect,
  migrationStreamContract,
  resolveMigrationStreamId,
  type MigrationManifestDialect,
  type MigrationLogicalRole,
  type MigrationStreamContract,
  type MigrationStreamId,
} from '@authrim/ar-lib-core/services/control-plane/migration-stream-contract';
import type { AuthrimConfig } from './config.js';
import type { AuthrimLock } from './lock.js';
import { getTenantDatabaseRoleFromBinding, isTenantDatabaseBinding } from './tenant-database.js';
import { renderPortableMigrationSql } from './sql-portability.js';

export const RELEASE_MIGRATION_MANIFEST_FORMAT_VERSION = 2 as const;
export const DRAFT_RELEASE_MANIFEST_FILENAME = 'release-manifest.draft.json';
const PRODUCT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const ProductVersionSchema = z.string().regex(PRODUCT_VERSION_PATTERN);
const MigrationPathSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z._/-]*\.sql$/u)
  .refine((path) => !path.includes('..') && !path.includes('//'), {
    message: 'Migration paths must remain inside their logical stream directory',
  });

export const ReleaseMigrationSupersededFileSchema = z.object({
  path: MigrationPathSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
});

const SemanticBaselineEvidenceSchema = z
  .object({
    formatVersion: z.literal(RELEASE_MIGRATION_MANIFEST_FORMAT_VERSION),
    productVersion: ProductVersionSchema,
    compatibility: z.literal('fresh_install_only'),
    streams: z.array(
      z.object({
        id: z.enum(MIGRATION_STREAM_IDS),
        schemaFamily: z.enum(MIGRATION_SCHEMA_FAMILIES),
        dialect: z.enum(MIGRATION_MANIFEST_DIALECTS),
        targetKind: z.enum(MIGRATION_TARGET_KINDS),
        path: MigrationPathSchema,
        checksum: z.string().regex(/^[a-f0-9]{64}$/u),
        schemaChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
        seedChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
        objectCount: z.number().int().nonnegative(),
        generatedFrom: z.array(ReleaseMigrationSupersededFileSchema),
      })
    ),
  })
  .refine(
    (evidence) =>
      new Set(evidence.streams.map((stream) => stream.id)).size === evidence.streams.length,
    {
      message: 'Semantic baseline evidence stream IDs must be unique',
    }
  );

export const ReleaseMigrationFileSchema = z.object({
  path: MigrationPathSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  semanticEvidence: z
    .object({
      schemaChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
      seedChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
      objectCount: z.number().int().nonnegative(),
    })
    .optional(),
  supersedes: z
    .array(ReleaseMigrationSupersededFileSchema)
    .refine((files) => new Set(files.map((file) => file.path)).size === files.length, {
      message: 'Superseded migration paths must be unique',
    })
    .optional(),
});

export const ReleaseMigrationStreamSchema = z
  .object({
    id: z.enum(MIGRATION_STREAM_IDS),
    schemaFamily: z.enum(MIGRATION_SCHEMA_FAMILIES),
    dialect: z.enum(MIGRATION_MANIFEST_DIALECTS),
    targetKind: z.enum(MIGRATION_TARGET_KINDS),
    logicalRoles: z.array(z.enum(MIGRATION_LOGICAL_ROLES)).min(1),
    files: z.array(ReleaseMigrationFileSchema),
  })
  .superRefine((stream, context) => {
    const contract = migrationStreamContract(stream.id);
    if (
      stream.schemaFamily !== contract.schemaFamily ||
      stream.dialect !== contract.dialect ||
      stream.targetKind !== contract.targetKind ||
      stream.logicalRoles.length !== contract.logicalRoles.length ||
      stream.logicalRoles.some((role, index) => role !== contract.logicalRoles[index])
    ) {
      context.addIssue({
        code: 'custom',
        message: `Migration stream metadata does not match the canonical contract: ${stream.id}`,
      });
    }
  })
  .refine((stream) => new Set(stream.files.map((file) => file.path)).size === stream.files.length, {
    message: 'Migration paths must be unique within a stream',
  })
  .refine(
    (stream) =>
      stream.files.every((file, index) => index === 0 || stream.files[index - 1]!.path < file.path),
    {
      message: 'Migration paths must be in strict lexicographic execution order',
    }
  );

export const ReleaseMigrationUpgradePathSchema = z
  .object({
    fromProductVersion: ProductVersionSchema,
    kind: z.enum(['delta', 'bridge']),
    streams: z.array(ReleaseMigrationStreamSchema),
  })
  .refine((path) => new Set(path.streams.map((stream) => stream.id)).size === path.streams.length, {
    message: 'Release migration upgrade stream IDs must be unique',
  });

export const FreshInstallBaselineSchema = z.object({
  productVersion: ProductVersionSchema,
});

export const ReleaseRolloutPolicySchema = z.object({
  databaseExecution: z.literal('setup_then_control'),
  workerActivation: z.literal('after_required_databases'),
  adminMutationMode: z.enum(['available', 'read_only']),
  databaseOnly: z
    .object({
      compatibleWorkerVersions: z
        .array(ProductVersionSchema)
        .min(1)
        .max(100)
        .refine((versions) => new Set(versions).size === versions.length, {
          message: 'Database-only compatible Worker versions must be unique',
        }),
    })
    .optional(),
});

export const ReleaseMigrationManifestSchema = z
  .object({
    formatVersion: z.literal(RELEASE_MIGRATION_MANIFEST_FORMAT_VERSION),
    productVersion: ProductVersionSchema,
    minimumProductVersion: ProductVersionSchema.optional(),
    databaseCompatibility: z
      .enum(['fresh_install_only', 'fresh_and_forward', 'forward_only'])
      .optional(),
    freshInstallBaseline: FreshInstallBaselineSchema.optional(),
    upgradePaths: z.array(ReleaseMigrationUpgradePathSchema).optional(),
    acceptedMigrationHistory: z.array(ReleaseMigrationStreamSchema).optional(),
    rollout: ReleaseRolloutPolicySchema.optional(),
    streams: z.array(ReleaseMigrationStreamSchema),
  })
  .refine(
    (manifest) =>
      new Set(manifest.streams.map((stream) => stream.id)).size === manifest.streams.length,
    { message: 'Release migration stream IDs must be unique' }
  )
  .refine(
    (manifest) =>
      new Set((manifest.upgradePaths ?? []).map((path) => path.fromProductVersion)).size ===
      (manifest.upgradePaths ?? []).length,
    { message: 'Release migration upgrade source versions must be unique' }
  )
  .refine(
    (manifest) =>
      new Set((manifest.acceptedMigrationHistory ?? []).map((stream) => stream.id)).size ===
      (manifest.acceptedMigrationHistory ?? []).length,
    { message: 'Accepted migration history stream IDs must be unique' }
  )
  .refine(
    (manifest) =>
      (manifest.upgradePaths ?? []).every(
        (path) => compareProductVersions(path.fromProductVersion, manifest.productVersion) < 0
      ),
    { message: 'Release migration upgrade paths must start below the target version' }
  )
  .refine(
    (manifest) => {
      if (!manifest.freshInstallBaseline) return true;
      const [baselineMajor, baselineMinor, baselinePatch] = versionCore(
        manifest.freshInstallBaseline.productVersion
      );
      const [productMajor, productMinor] = versionCore(manifest.productVersion);
      return (
        baselinePatch === 0 &&
        /^\d+\.\d+\.0$/u.test(manifest.freshInstallBaseline.productVersion) &&
        baselineMajor === productMajor &&
        baselineMinor === productMinor &&
        compareProductVersions(
          manifest.freshInstallBaseline.productVersion,
          manifest.productVersion
        ) <= 0
      );
    },
    {
      message:
        'Fresh-install baseline must be the major/minor boundary for the manifest product series',
    }
  )
  .refine(
    (manifest) =>
      !manifest.freshInstallBaseline ||
      manifest.streams.every(
        (stream) =>
          stream.files.length === 0 ||
          stream.files.filter(
            (file) =>
              baselineVersionFromPath(file.path) === manifest.freshInstallBaseline!.productVersion
          ).length === 1
      ),
    { message: 'Fresh-install streams must contain exactly one selected series baseline' }
  )
  .refine(
    (manifest) =>
      (manifest.upgradePaths ?? []).every((path) =>
        path.streams.every((stream) =>
          stream.files.every((file) => baselineVersionFromPath(file.path) === null)
        )
      ),
    { message: 'Upgrade paths must not contain fresh-install baselines' }
  );

export type ReleaseMigrationFile = z.infer<typeof ReleaseMigrationFileSchema>;
export type ReleaseMigrationStream = z.infer<typeof ReleaseMigrationStreamSchema>;
export type ReleaseMigrationManifest = z.infer<typeof ReleaseMigrationManifestSchema>;
export type ReleaseMigrationUpgradePath = z.infer<typeof ReleaseMigrationUpgradePathSchema>;
export type ReleaseRolloutPolicy = z.infer<typeof ReleaseRolloutPolicySchema>;

export const DEFAULT_RELEASE_ROLLOUT_POLICY: ReleaseRolloutPolicy = {
  databaseExecution: 'setup_then_control',
  workerActivation: 'after_required_databases',
  adminMutationMode: 'read_only',
};

export function assertDatabaseOnlyWorkerCompatibility(
  manifest: ReleaseMigrationManifest,
  installedWorkerVersion: string | undefined
): void {
  if (!installedWorkerVersion || !ProductVersionSchema.safeParse(installedWorkerVersion).success) {
    throw new Error('database_only_installed_worker_version_required');
  }
  const compatibleVersions = manifest.rollout?.databaseOnly?.compatibleWorkerVersions;
  if (!compatibleVersions?.includes(installedWorkerVersion)) {
    throw new Error(
      `database_only_worker_version_incompatible:${installedWorkerVersion}:${manifest.productVersion}`
    );
  }
}

export function assertReleaseDatabaseCompatibility(input: {
  manifest: ReleaseMigrationManifest;
  manifestChecksum: string;
  installedProductVersion?: string;
  installedSchemaManifestChecksums?: readonly string[];
  installedSchemaTargets?: AuthrimLock['schemaTargets'];
  currentTargets?: readonly Pick<ReleaseMigrationPhysicalTarget, 'id' | 'streamId'>[];
  targetManifestIsDraft?: boolean;
}): void {
  if (input.manifest.databaseCompatibility !== 'fresh_install_only') return;
  if (!input.installedProductVersion) return;
  if (calculateReleaseManifestChecksum(input.manifest) !== input.manifestChecksum) {
    throw new Error('release_manifest_checksum_mismatch');
  }
  const installedChecksums = input.installedSchemaManifestChecksums ?? [];
  const alreadyOnExactBaseline =
    input.installedProductVersion === input.manifest.productVersion &&
    installedChecksums.length > 0 &&
    installedChecksums.every((checksum) => checksum === input.manifestChecksum);
  if (alreadyOnExactBaseline) return;

  // A development draft may grow while an existing disposable test environment remains on the
  // same pre-1.0 product version. Permit only a cryptographically evidenced forward suffix. The
  // lock must describe every current physical target, and every recorded path/checksum pair must
  // be an exact prefix of that target's current stream. This deliberately excludes published
  // manifests, semantic baseline rewrites, missing legacy evidence, target-set changes, edits,
  // removals, and reordering.
  const schemaTargets = input.installedSchemaTargets;
  const currentTargets = input.currentTargets ?? [];
  const schemaTargetEntries = Object.entries(schemaTargets ?? {});
  const currentTargetIds = new Set(currentTargets.map((target) => target.id));
  const appendOnlyDraftEvolution =
    input.targetManifestIsDraft === true &&
    input.installedProductVersion === input.manifest.productVersion &&
    currentTargets.length > 0 &&
    currentTargetIds.size === currentTargets.length &&
    schemaTargetEntries.length === currentTargets.length &&
    schemaTargetEntries.every(([targetId]) => currentTargetIds.has(targetId)) &&
    (() => {
      let hasForwardProgress = false;
      for (const target of currentTargets) {
        const state = schemaTargets?.[target.id];
        if (
          !target.streamId ||
          !state ||
          state.productVersion !== input.manifest.productVersion ||
          state.streamId !== target.streamId ||
          !Array.isArray(state.files)
        ) {
          return false;
        }
        const stream = input.manifest.streams.find((candidate) => candidate.id === target.streamId);
        if (!stream || state.files.length > stream.files.length) return false;
        for (let index = 0; index < state.files.length; index += 1) {
          const installedFile = state.files[index];
          const targetFile = stream.files[index];
          if (
            installedFile.path !== targetFile.path ||
            installedFile.checksum !== targetFile.checksum
          ) {
            return false;
          }
        }
        if (state.manifestChecksum === input.manifestChecksum) {
          // A target checkpointed against this exact manifest must already contain its full
          // stream; a shorter list would be contradictory evidence.
          if (state.files.length !== stream.files.length) return false;
          hasForwardProgress = true;
        } else if (state.files.length < stream.files.length) {
          hasForwardProgress = true;
        }
      }
      return hasForwardProgress;
    })();
  if (appendOnlyDraftEvolution) return;

  throw new Error(
    `fresh_install_required:${input.installedProductVersion}:${input.manifest.productVersion}`
  );
}

export type MigrationStreamDefinition = MigrationStreamContract;

export const RELEASE_MIGRATION_STREAM_DEFINITIONS = MIGRATION_STREAM_CONTRACTS;

const LEGACY_MIGRATION_STREAM_IDS: Readonly<Record<string, MigrationStreamId>> = {
  'd1-core': 'core-d1',
  'd1-pii': 'pii-d1',
  'd1-admin': 'admin-d1',
  'd1-control': 'control-d1',
  'd1-lookup': 'lookup-d1',
  'd1-plugin-runner': 'plugin-runner-d1',
  'external-postgres-core': 'core-postgresql',
  'external-postgres-pii': 'pii-postgresql',
};

function listSqlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];

  function walk(relativeDirectory: string): void {
    const absoluteDirectory = relativeDirectory ? join(root, relativeDirectory) : root;
    for (const entry of readdirSync(absoluteDirectory).sort()) {
      if (entry.startsWith('.')) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
      const absolutePath = join(root, relativePath);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        walk(relativePath);
      } else if (stat.isFile() && entry.endsWith('.sql')) {
        files.push(relativePath);
      }
    }
  }

  walk('');
  return files.sort();
}

export function calculateReleaseMigrationChecksum(
  filePath: string,
  dialect: MigrationManifestDialect
): string {
  const rendered = renderPortableMigrationSql(
    readFileSync(filePath, 'utf-8'),
    migrationRendererDialect(dialect)
  );
  return createHash('sha256').update(rendered).digest('hex');
}

function previousFileByStreamAndPath(
  previousManifests: readonly ReleaseMigrationManifest[]
): Map<string, ReleaseMigrationFile> {
  const previous = new Map<string, ReleaseMigrationFile>();
  for (const manifest of previousManifests) {
    for (const stream of manifest.streams) {
      for (const file of stream.files) previous.set(`${stream.id}:${file.path}`, file);
    }
    for (const path of manifest.upgradePaths ?? []) {
      for (const stream of path.streams) {
        for (const file of stream.files) previous.set(`${stream.id}:${file.path}`, file);
      }
    }
    for (const stream of manifest.acceptedMigrationHistory ?? []) {
      for (const file of stream.files) previous.set(`${stream.id}:${file.path}`, file);
    }
  }
  return previous;
}

function semanticBaselineProvenancePaths(migrationsRoot: string): ReadonlyMap<string, Set<string>> {
  const evidencePath = join(migrationsRoot, 'semantic-baseline.evidence.json');
  if (!existsSync(evidencePath)) return new Map();
  const raw = JSON.parse(readFileSync(evidencePath, 'utf-8')) as unknown;
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (raw as { formatVersion?: unknown }).formatVersion === 1
  ) {
    const streams = (raw as { streams?: unknown }).streams;
    if (!Array.isArray(streams)) throw new Error('Legacy semantic baseline evidence is invalid');
    return new Map(
      streams.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error('Legacy semantic baseline evidence stream is invalid');
        }
        const record = entry as { id?: unknown; generatedFrom?: unknown };
        const id =
          typeof record.id === 'string' ? LEGACY_MIGRATION_STREAM_IDS[record.id] : undefined;
        if (!id)
          throw new Error(`Legacy semantic baseline stream is unknown: ${String(record.id)}`);
        const generatedFrom = z
          .array(ReleaseMigrationSupersededFileSchema)
          .parse(record.generatedFrom);
        return [id, new Set(generatedFrom.map((file) => file.path))] as const;
      })
    );
  }
  const evidence = SemanticBaselineEvidenceSchema.parse(raw);
  return new Map(
    evidence.streams.map((stream) => [
      stream.id,
      new Set(stream.generatedFrom.map((file) => file.path)),
    ])
  );
}

function versionCore(version: string): [number, number, number] {
  const core = version
    .split(/[+-]/u, 1)[0]!
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  return [core[0]!, core[1]!, core[2]!];
}

function sameReleaseSeries(left: string, right: string): boolean {
  const [leftMajor, leftMinor] = versionCore(left);
  const [rightMajor, rightMinor] = versionCore(right);
  return leftMajor === rightMajor && leftMinor === rightMinor;
}

function baselineVersionFromPath(path: string): string | null {
  const match = path.match(/^\d+_(\d+)_(\d+)_(\d+)(?:_[0-9A-Za-z]+)*_.*_baseline\.sql$/u);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function streamWithFiles(
  stream: Omit<ReleaseMigrationStream, 'files'>,
  files: ReleaseMigrationFile[]
): ReleaseMigrationStream {
  return ReleaseMigrationStreamSchema.parse({ ...stream, files });
}

function mergeMigrationFiles(
  left: readonly ReleaseMigrationFile[],
  right: readonly ReleaseMigrationFile[]
): ReleaseMigrationFile[] {
  const files = new Map<string, ReleaseMigrationFile>();
  for (const file of [...left, ...right]) {
    const current = files.get(file.path);
    if (current && current.checksum !== file.checksum) {
      throw new Error(`release_migration_path_checksum_conflict:${file.path}`);
    }
    files.set(file.path, file);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function generateReleaseMigrationManifest(input: {
  migrationsRoot: string;
  productVersion: string;
  minimumProductVersion?: string;
  previousManifest?: ReleaseMigrationManifest;
  previousManifests?: readonly ReleaseMigrationManifest[];
  semanticBaselineSource?: boolean;
}): ReleaseMigrationManifest {
  const history = [
    ...(input.previousManifests ?? []),
    ...(input.previousManifest ? [input.previousManifest] : []),
  ].filter(
    (manifest, index, manifests) =>
      manifests.findIndex((candidate) => candidate.productVersion === manifest.productVersion) ===
      index
  );
  const previousFiles = previousFileByStreamAndPath(history);
  const minimumProductVersion =
    input.minimumProductVersion ??
    (input.previousManifest?.productVersion === input.productVersion
      ? input.previousManifest.minimumProductVersion
      : undefined);
  const discoveredStreams = RELEASE_MIGRATION_STREAM_DEFINITIONS.map((definition) => {
    const streamRoot = join(input.migrationsRoot, definition.directory);
    const paths = listSqlFiles(streamRoot);
    return {
      id: definition.id,
      schemaFamily: definition.schemaFamily,
      dialect: definition.dialect,
      targetKind: definition.targetKind,
      logicalRoles: [...definition.logicalRoles],
      files: paths.map((path) => {
        const checksum = calculateReleaseMigrationChecksum(
          join(streamRoot, path),
          definition.dialect
        );
        const previous = previousFiles.get(`${definition.id}:${path}`);
        return {
          path,
          checksum,
          ...(previous?.checksum === checksum && previous.semanticEvidence
            ? { semanticEvidence: previous.semanticEvidence }
            : {}),
          ...(previous?.checksum === checksum && previous.supersedes
            ? { supersedes: previous.supersedes }
            : {}),
        };
      }),
    };
  });

  const priorRelease = history
    .filter((manifest) => compareProductVersions(manifest.productVersion, input.productVersion) < 0)
    .sort((a, b) => compareProductVersions(a.productVersion, b.productVersion))
    .at(-1);
  const sameVersion = history.find((manifest) => manifest.productVersion === input.productVersion);
  const isSeriesBoundary = versionCore(input.productVersion)[2] === 0;
  const exactBaselineByStream = new Map(
    discoveredStreams.map((stream) => [
      stream.id,
      stream.files.filter((file) => baselineVersionFromPath(file.path) === input.productVersion),
    ])
  );
  const usesManagedLayout = discoveredStreams
    .filter((stream) => stream.files.length > 0)
    .every((stream) => (exactBaselineByStream.get(stream.id)?.length ?? 0) === 1);

  if (
    isSeriesBoundary &&
    priorRelease?.freshInstallBaseline &&
    !usesManagedLayout &&
    input.semanticBaselineSource !== true
  ) {
    throw new Error(`fresh_install_baseline_required:${input.productVersion}`);
  }

  const provenancePaths = semanticBaselineProvenancePaths(input.migrationsRoot);
  const newFilesByStream = new Map(
    discoveredStreams.map((stream) => [
      stream.id,
      stream.files.filter(
        (file) =>
          !previousFiles.has(`${stream.id}:${file.path}`) &&
          baselineVersionFromPath(file.path) !== input.productVersion &&
          !provenancePaths.get(stream.id)?.has(file.path)
      ),
    ])
  );
  if (
    usesManagedLayout &&
    !priorRelease &&
    input.semanticBaselineSource !== true &&
    [...newFilesByStream.values()].some((files) => files.length > 0)
  ) {
    throw new Error(`initial_fresh_baseline_regeneration_required:${input.productVersion}`);
  }
  const freshInstallBaselineVersion =
    isSeriesBoundary && usesManagedLayout
      ? input.productVersion
      : (sameVersion?.freshInstallBaseline?.productVersion ??
        (priorRelease && sameReleaseSeries(priorRelease.productVersion, input.productVersion)
          ? priorRelease.freshInstallBaseline?.productVersion
          : undefined));
  const streams =
    input.semanticBaselineSource && !priorRelease && usesManagedLayout
      ? discoveredStreams.map((stream) =>
          streamWithFiles(
            stream,
            mergeMigrationFiles(
              exactBaselineByStream.get(stream.id) ?? [],
              newFilesByStream.get(stream.id) ?? []
            )
          )
        )
      : input.semanticBaselineSource && priorRelease && !usesManagedLayout
        ? discoveredStreams.map((stream) => {
            const previous = priorRelease.streams.find((candidate) => candidate.id === stream.id);
            return streamWithFiles(
              stream,
              mergeMigrationFiles(previous?.files ?? [], newFilesByStream.get(stream.id) ?? [])
            );
          })
        : isSeriesBoundary && usesManagedLayout
          ? discoveredStreams.map((stream) =>
              streamWithFiles(stream, exactBaselineByStream.get(stream.id) ?? [])
            )
          : sameVersion
            ? discoveredStreams.map((stream) => {
                const previous = sameVersion.streams.find(
                  (candidate) => candidate.id === stream.id
                );
                return streamWithFiles(
                  stream,
                  mergeMigrationFiles(previous?.files ?? [], newFilesByStream.get(stream.id) ?? [])
                );
              })
            : priorRelease && sameReleaseSeries(priorRelease.productVersion, input.productVersion)
              ? discoveredStreams.map((stream) => {
                  const previous = priorRelease.streams.find(
                    (candidate) => candidate.id === stream.id
                  );
                  return streamWithFiles(
                    stream,
                    mergeMigrationFiles(
                      previous?.files ?? [],
                      newFilesByStream.get(stream.id) ?? []
                    )
                  );
                })
              : discoveredStreams;

  const previousUpgradePaths = sameVersion?.upgradePaths ?? [];
  const directUpgradePath = priorRelease
    ? {
        fromProductVersion: priorRelease.productVersion,
        kind: sameReleaseSeries(priorRelease.productVersion, input.productVersion)
          ? ('delta' as const)
          : ('bridge' as const),
        streams: discoveredStreams.map((stream) => {
          const existing = sameVersion?.upgradePaths
            ?.find((path) => path.fromProductVersion === priorRelease.productVersion)
            ?.streams.find((candidate) => candidate.id === stream.id);
          return streamWithFiles(
            stream,
            mergeMigrationFiles(existing?.files ?? [], newFilesByStream.get(stream.id) ?? [])
          );
        }),
      }
    : undefined;
  const upgradePaths = directUpgradePath
    ? [
        ...previousUpgradePaths.filter(
          (path) => path.fromProductVersion !== directUpgradePath.fromProductVersion
        ),
        directUpgradePath,
      ].sort((a, b) => compareProductVersions(a.fromProductVersion, b.fromProductVersion))
    : previousUpgradePaths;

  return ReleaseMigrationManifestSchema.parse({
    formatVersion: RELEASE_MIGRATION_MANIFEST_FORMAT_VERSION,
    productVersion: input.productVersion,
    ...(minimumProductVersion ? { minimumProductVersion } : {}),
    databaseCompatibility:
      input.previousManifest?.productVersion === input.productVersion &&
      input.previousManifest.databaseCompatibility
        ? input.previousManifest.databaseCompatibility
        : priorRelease
          ? 'fresh_and_forward'
          : 'fresh_install_only',
    ...(freshInstallBaselineVersion
      ? { freshInstallBaseline: { productVersion: freshInstallBaselineVersion } }
      : {}),
    ...(upgradePaths.length > 0 ? { upgradePaths } : {}),
    rollout:
      input.previousManifest?.productVersion === input.productVersion &&
      input.previousManifest.rollout
        ? input.previousManifest.rollout
        : DEFAULT_RELEASE_ROLLOUT_POLICY,
    streams,
  });
}

export function resolveReleaseMigrationExecutionManifest(input: {
  targetManifest: ReleaseMigrationManifest;
  installedProductVersion?: string;
  availableManifests?: readonly ReleaseMigrationManifest[];
}): ReleaseMigrationManifest {
  if (!input.installedProductVersion) return input.targetManifest;
  if (input.installedProductVersion === input.targetManifest.productVersion) {
    return ReleaseMigrationManifestSchema.parse({
      ...input.targetManifest,
      streams: input.targetManifest.streams.map((stream) => ({ ...stream, files: [] })),
      freshInstallBaseline: undefined,
      upgradePaths: undefined,
    });
  }

  const candidates = [input.targetManifest, ...(input.availableManifests ?? [])]
    .filter(
      (manifest, index, manifests) =>
        compareProductVersions(manifest.productVersion, input.installedProductVersion!) > 0 &&
        compareProductVersions(manifest.productVersion, input.targetManifest.productVersion) <= 0 &&
        manifests.findIndex((candidate) => candidate.productVersion === manifest.productVersion) ===
          index
    )
    .sort((a, b) => compareProductVersions(a.productVersion, b.productVersion));
  let currentVersion = input.installedProductVersion;
  const selected: ReleaseMigrationStream[] = RELEASE_MIGRATION_STREAM_DEFINITIONS.map(
    (definition) => ({
      id: definition.id,
      schemaFamily: definition.schemaFamily,
      dialect: definition.dialect,
      targetKind: definition.targetKind,
      logicalRoles: [...definition.logicalRoles],
      files: [],
    })
  );

  while (currentVersion !== input.targetManifest.productVersion) {
    const next = candidates.find((manifest) =>
      manifest.upgradePaths?.some((path) => path.fromProductVersion === currentVersion)
    );
    if (!next) {
      throw new Error(
        `release_upgrade_path_not_found:${currentVersion}:${input.targetManifest.productVersion}`
      );
    }
    const path = next.upgradePaths!.find(
      (candidate) => candidate.fromProductVersion === currentVersion
    )!;
    for (const targetStream of selected) {
      const pathStream = path.streams.find((stream) => stream.id === targetStream.id);
      targetStream.files = mergeMigrationFiles(targetStream.files, pathStream?.files ?? []);
    }
    currentVersion = next.productVersion;
  }

  return ReleaseMigrationManifestSchema.parse({
    ...input.targetManifest,
    streams: selected,
    freshInstallBaseline: undefined,
    upgradePaths: undefined,
  });
}

export function buildReleaseMigrationArtifactManifest(input: {
  targetManifest: ReleaseMigrationManifest;
  installedProductVersion: string;
  availableManifests?: readonly ReleaseMigrationManifest[];
}): ReleaseMigrationManifest {
  const execution = resolveReleaseMigrationExecutionManifest(input);
  const kind = sameReleaseSeries(input.installedProductVersion, input.targetManifest.productVersion)
    ? 'delta'
    : 'bridge';
  const historySources = [input.targetManifest, ...(input.availableManifests ?? [])].filter(
    (manifest, index, manifests) =>
      compareProductVersions(manifest.productVersion, input.targetManifest.productVersion) <= 0 &&
      manifests.findIndex((candidate) => candidate.productVersion === manifest.productVersion) ===
        index
  );
  const acceptedMigrationHistory = RELEASE_MIGRATION_STREAM_DEFINITIONS.map((definition) => {
    let files: ReleaseMigrationFile[] = [];
    for (const manifest of historySources) {
      const streams = [
        ...manifest.streams,
        ...(manifest.upgradePaths ?? []).flatMap((path) => path.streams),
        ...(manifest.acceptedMigrationHistory ?? []),
      ];
      for (const stream of streams.filter((candidate) => candidate.id === definition.id)) {
        files = mergeMigrationFiles(
          files,
          stream.files.flatMap((file) => [
            file,
            ...(file.supersedes ?? []).map((superseded) => ({ ...superseded })),
          ])
        );
      }
    }
    return {
      id: definition.id,
      schemaFamily: definition.schemaFamily,
      dialect: definition.dialect,
      targetKind: definition.targetKind,
      logicalRoles: [...definition.logicalRoles],
      files,
    };
  });
  return ReleaseMigrationManifestSchema.parse({
    ...input.targetManifest,
    upgradePaths: [
      ...(input.targetManifest.upgradePaths ?? []).filter(
        (path) => path.fromProductVersion !== input.installedProductVersion
      ),
      {
        fromProductVersion: input.installedProductVersion,
        kind,
        streams: execution.streams,
      },
    ].sort((left, right) =>
      compareProductVersions(left.fromProductVersion, right.fromProductVersion)
    ),
    acceptedMigrationHistory,
  });
}

export function serializeReleaseMigrationManifest(manifest: ReleaseMigrationManifest): string {
  return `${JSON.stringify(ReleaseMigrationManifestSchema.parse(manifest), null, 2)}\n`;
}

export function calculateReleaseManifestChecksum(manifest: ReleaseMigrationManifest): string {
  return createHash('sha256').update(serializeReleaseMigrationManifest(manifest)).digest('hex');
}

export function readReleaseMigrationManifest(path: string): ReleaseMigrationManifest {
  return ReleaseMigrationManifestSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

export function writeReleaseMigrationManifest(
  path: string,
  manifest: ReleaseMigrationManifest
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeReleaseMigrationManifest(manifest), 'utf-8');
}

export function syncDraftReleaseMigrationManifest(input: {
  migrationsRoot: string;
  productVersion: string;
}): { path: string; manifest: ReleaseMigrationManifest } {
  const repositoryRoot = dirname(input.migrationsRoot);
  validateRemoteMainPublishedReleaseMigrationManifests({
    migrationsRoot: input.migrationsRoot,
    repositoryRoot,
  });
  const releaseManifests = listReleaseMigrationManifests(input.migrationsRoot).map(
    (release) => release.manifest
  );
  const publishedManifest = releaseManifests
    .filter((manifest) =>
      isVersionPublishedOnRemoteMain({
        repositoryRoot,
        productVersion: manifest.productVersion,
      })
    )
    .at(-1);
  const latestReleaseCandidate = releaseManifests.at(-1);
  assertProductVersionNotBehindPublished(input.productVersion, publishedManifest?.productVersion);
  const path = join(input.migrationsRoot, DRAFT_RELEASE_MANIFEST_FILENAME);
  const currentDraft = existsSync(path) ? readReleaseMigrationManifest(path) : undefined;
  const previousManifest =
    currentDraft?.productVersion === input.productVersion ? currentDraft : latestReleaseCandidate;
  const manifest = generateReleaseMigrationManifest({
    migrationsRoot: input.migrationsRoot,
    productVersion: input.productVersion,
    previousManifest,
    previousManifests: releaseManifests,
  });
  const publishedSameVersion = join(
    input.migrationsRoot,
    'releases',
    `${input.productVersion}.json`
  );
  if (existsSync(publishedSameVersion)) {
    const published = readReleaseMigrationManifest(publishedSameVersion);
    if (
      serializeReleaseMigrationManifest(published) !==
        serializeReleaseMigrationManifest(manifest) &&
      isVersionPublishedOnRemoteMain({
        repositoryRoot,
        productVersion: input.productVersion,
      })
    ) {
      throw new Error(
        `product_version_already_published:${input.productVersion}:bump the root package version before adding migrations`
      );
    }
  }
  writeReleaseMigrationManifest(path, manifest);
  return { path, manifest };
}

export function assertProductVersionNotBehindPublished(
  productVersion: string,
  latestPublishedVersion: string | undefined
): void {
  if (
    latestPublishedVersion &&
    compareProductVersions(productVersion, latestPublishedVersion) < 0
  ) {
    throw new Error(
      `product_version_behind_latest_release:${productVersion}:${latestPublishedVersion}`
    );
  }
}

export function assertProductVersionOpenForNewMigrations(
  migrationsRoot: string,
  productVersion: string,
  options: {
    repositoryRoot?: string;
    isVersionPublished?: (version: string) => boolean;
  } = {}
): void {
  const repositoryRoot = options.repositoryRoot ?? dirname(migrationsRoot);
  const published =
    options.isVersionPublished?.(productVersion) ??
    isVersionPublishedOnRemoteMain({ repositoryRoot, productVersion });
  if (published) {
    throw new Error(
      `product_version_already_published:${productVersion}:bump the root package version before adding migrations`
    );
  }
}

export function isVersionPublishedOnRemoteMain(input: {
  repositoryRoot: string;
  productVersion: string;
  remote?: string;
  mainBranch?: string;
}): boolean {
  return resolveVersionTagPublishedOnRemoteMain(input) !== null;
}

function resolveVersionTagPublishedOnRemoteMain(input: {
  repositoryRoot: string;
  productVersion: string;
  remote?: string;
  mainBranch?: string;
}): string | null {
  const remote = input.remote ?? 'origin';
  const mainBranch = input.mainBranch ?? 'main';
  const remoteMain = `refs/remotes/${remote}/${mainBranch}`;
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', remoteMain], {
      cwd: input.repositoryRoot,
      stdio: 'ignore',
    });
  } catch {
    return null;
  }
  for (const tag of [`v${input.productVersion}`, input.productVersion]) {
    const tagRef = `refs/tags/${tag}`;
    try {
      execFileSync('git', ['show-ref', '--verify', '--quiet', tagRef], {
        cwd: input.repositoryRoot,
        stdio: 'ignore',
      });
      const localTagObject = execFileSync('git', ['rev-parse', tagRef], {
        cwd: input.repositoryRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      let remoteTags: string;
      try {
        remoteTags = execFileSync('git', ['ls-remote', '--tags', remote, tagRef], {
          cwd: input.repositoryRoot,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        throw new Error(`remote_tag_verification_failed:${remote}:${tag}`);
      }
      const remoteTagObject = remoteTags
        .split(/\r?\n/u)
        .map((line) => line.trim().split(/\s+/u))
        .find((parts) => parts[1] === tagRef)?.[0];
      if (remoteTagObject !== localTagObject) continue;
      execFileSync('git', ['merge-base', '--is-ancestor', tagRef, remoteMain], {
        cwd: input.repositoryRoot,
        stdio: 'ignore',
      });
      return tag;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('remote_tag_verification_failed:')) {
        throw error;
      }
      // A local-only/mismatched tag, or a tag not reachable from remote main, is unpublished.
    }
  }
  return null;
}

export function findLatestReleaseMigrationManifest(
  migrationsRoot: string
): { path: string; manifest: ReleaseMigrationManifest } | null {
  return listReleaseMigrationManifests(migrationsRoot).at(-1) ?? null;
}

export function listReleaseMigrationManifests(
  migrationsRoot: string
): Array<{ path: string; manifest: ReleaseMigrationManifest }> {
  const releasesDirectory = join(migrationsRoot, 'releases');
  if (!existsSync(releasesDirectory)) return [];
  return readdirSync(releasesDirectory)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      const path = join(releasesDirectory, entry);
      const manifest = readReleaseMigrationManifest(path);
      if (entry !== `${manifest.productVersion}.json`) {
        throw new Error(
          `Release manifest filename/version mismatch: ${entry} != ${manifest.productVersion}`
        );
      }
      return { path, manifest };
    })
    .sort((a, b) => compareProductVersions(a.manifest.productVersion, b.manifest.productVersion));
}

export function validateReleaseMigrationManifestFiles(
  migrationsRoot: string,
  manifest: ReleaseMigrationManifest
): void {
  const executableStreams = [
    ...manifest.streams,
    ...(manifest.upgradePaths ?? []).flatMap((path) => path.streams),
  ];
  const allStreams = [...executableStreams, ...(manifest.acceptedMigrationHistory ?? [])];
  const historyByStreamAndPath = new Map<string, string>();
  for (const stream of allStreams) {
    for (const file of stream.files) {
      const historyKey = `${stream.id}:${file.path}`;
      const previousChecksum = historyByStreamAndPath.get(historyKey);
      if (previousChecksum && previousChecksum !== file.checksum) {
        throw new Error(
          `Release migration history conflicts: ${manifest.productVersion}/${stream.id}/${file.path}`
        );
      }
      historyByStreamAndPath.set(historyKey, file.checksum);
    }
  }

  // acceptedMigrationHistory is provenance used to recognize SQL that was applied before an
  // unpublished release was semantically consolidated. Those superseded source files are
  // deliberately not published or executed, so only their path/checksum identity is validated.
  const validated = new Set<string>();
  for (const stream of executableStreams) {
    const directory = streamDirectory(migrationsRoot, stream.id);
    if (!directory) throw new Error(`Unknown release migration stream: ${stream.id}`);
    for (const file of stream.files) {
      const validationKey = `${stream.id}:${file.path}:${file.checksum}`;
      if (validated.has(validationKey)) continue;
      validated.add(validationKey);
      const path = join(directory, file.path);
      if (!existsSync(path)) {
        throw new Error(
          `Release migration is missing: ${manifest.productVersion}/${stream.id}/${file.path}`
        );
      }
      const checksum = calculateReleaseMigrationChecksum(path, stream.dialect);
      if (checksum !== file.checksum) {
        throw new Error(
          `Release migration checksum changed: ${manifest.productVersion}/${stream.id}/${file.path}`
        );
      }
    }
  }
}

export function validatePublishedReleaseMigrationManifests(migrationsRoot: string): void {
  for (const { manifest } of listReleaseMigrationManifests(migrationsRoot)) {
    try {
      validateReleaseMigrationManifestFiles(migrationsRoot, manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replace(/^Release migration/u, 'Published migration'));
    }
  }
}

export function validateRemoteMainPublishedReleaseMigrationManifests(input: {
  migrationsRoot: string;
  repositoryRoot?: string;
}): void {
  const repositoryRoot = input.repositoryRoot ?? dirname(input.migrationsRoot);
  const remoteMain = 'refs/remotes/origin/main';
  let mergedTags: string[];
  try {
    mergedTags = execFileSync('git', ['tag', '--merged', remoteMain, '--list'], {
      cwd: repositoryRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/u)
      .map((tag) => tag.trim())
      .filter(Boolean);
  } catch {
    return;
  }

  for (const candidateTag of mergedTags) {
    const productVersion = candidateTag.startsWith('v') ? candidateTag.slice(1) : candidateTag;
    if (!ProductVersionSchema.safeParse(productVersion).success) continue;
    const tag = resolveVersionTagPublishedOnRemoteMain({ repositoryRoot, productVersion });
    if (!tag || tag !== candidateTag) continue;
    const manifestRelativePath = `migrations/releases/${productVersion}.json`;
    try {
      execFileSync('git', ['cat-file', '-e', `${tag}:${manifestRelativePath}`], {
        cwd: repositoryRoot,
        stdio: 'ignore',
      });
    } catch {
      // Tags that predate the release-manifest workflow are outside this immutable artifact check.
      continue;
    }

    const manifestPath = join(repositoryRoot, manifestRelativePath);
    if (!existsSync(manifestPath)) {
      throw new Error(`Published migration manifest is missing: ${productVersion}`);
    }
    const taggedManifestContents = execFileSync('git', ['show', `${tag}:${manifestRelativePath}`], {
      cwd: repositoryRoot,
    });
    if (!readFileSync(manifestPath).equals(taggedManifestContents)) {
      throw new Error(`Published migration manifest changed since tag: ${productVersion}`);
    }

    const manifest = readReleaseMigrationManifest(manifestPath);
    try {
      validateReleaseMigrationManifestFiles(input.migrationsRoot, manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replace(/^Release migration/u, 'Published migration'));
    }

    const executableStreams = [
      ...manifest.streams,
      ...(manifest.upgradePaths ?? []).flatMap((path) => path.streams),
    ];
    const compared = new Set<string>();
    for (const stream of executableStreams) {
      const directory = streamDirectory(input.migrationsRoot, stream.id);
      if (!directory) throw new Error(`Unknown release migration stream: ${stream.id}`);
      for (const file of stream.files) {
        const filePath = join(directory, file.path);
        const fileRelativePath = relative(repositoryRoot, filePath).replaceAll('\\', '/');
        if (compared.has(fileRelativePath)) continue;
        compared.add(fileRelativePath);
        let taggedContents: Buffer;
        try {
          taggedContents = execFileSync('git', ['show', `${tag}:${fileRelativePath}`], {
            cwd: repositoryRoot,
          });
        } catch {
          throw new Error(
            `Published migration was not present at its release tag: ${productVersion}/${fileRelativePath}`
          );
        }
        if (!readFileSync(filePath).equals(taggedContents)) {
          throw new Error(
            `Published migration changed since tag: ${productVersion}/${fileRelativePath}`
          );
        }
      }
    }

    const evidenceRelativePath = `migrations/evidence/${productVersion}.json`;
    let taggedEvidenceExists = true;
    try {
      execFileSync('git', ['cat-file', '-e', `${tag}:${evidenceRelativePath}`], {
        cwd: repositoryRoot,
        stdio: 'ignore',
      });
    } catch {
      taggedEvidenceExists = false;
    }
    if (taggedEvidenceExists) {
      const taggedEvidence = execFileSync('git', ['show', `${tag}:${evidenceRelativePath}`], {
        cwd: repositoryRoot,
      });
      const evidencePath = join(repositoryRoot, evidenceRelativePath);
      if (!existsSync(evidencePath) || !readFileSync(evidencePath).equals(taggedEvidence)) {
        throw new Error(`Published migration evidence changed since tag: ${productVersion}`);
      }
    }
  }
}

export function compareProductVersions(left: string, right: string): number {
  const parse = (value: string): { core: number[]; prerelease: string[] } => {
    const withoutBuild = value.split('+', 1)[0];
    const [core, prerelease = ''] = withoutBuild.split('-', 2);
    return {
      core: core.split('.').map((part) => Number.parseInt(part, 10)),
      prerelease: prerelease ? prerelease.split('.') : [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  const identifiers = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < identifiers; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return Number.parseInt(leftIdentifier, 10) - Number.parseInt(rightIdentifier, 10);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier.localeCompare(rightIdentifier);
  }
  return 0;
}

export function isProductVersion(value: string): boolean {
  return ProductVersionSchema.safeParse(value).success;
}

export function loadTargetReleaseMigrationManifest(input: {
  migrationsRoot: string;
  productVersion: string;
  allowDraft?: boolean;
}): { path: string; manifest: ReleaseMigrationManifest; draft: boolean } {
  const releasePath = join(input.migrationsRoot, 'releases', `${input.productVersion}.json`);
  if (existsSync(releasePath)) {
    const manifest = readReleaseMigrationManifest(releasePath);
    if (manifest.productVersion !== input.productVersion) {
      throw new Error(
        `release_migration_manifest_version_mismatch:${input.productVersion}:${manifest.productVersion}`
      );
    }
    const draftPath = join(input.migrationsRoot, DRAFT_RELEASE_MANIFEST_FILENAME);
    if (existsSync(draftPath)) {
      const draft = readReleaseMigrationManifest(draftPath);
      if (
        draft.productVersion === input.productVersion &&
        serializeReleaseMigrationManifest(draft) !== serializeReleaseMigrationManifest(manifest)
      ) {
        if (input.allowDraft) {
          validateReleaseMigrationManifestFiles(input.migrationsRoot, draft);
          return { path: draftPath, manifest: draft, draft: true };
        }
        throw new Error(`draft_manifest_diverges_from_published_version:${input.productVersion}`);
      }
    }
    validateReleaseMigrationManifestFiles(input.migrationsRoot, manifest);
    return { path: releasePath, manifest, draft: false };
  }
  const draftPath = join(input.migrationsRoot, DRAFT_RELEASE_MANIFEST_FILENAME);
  if (input.allowDraft && existsSync(draftPath)) {
    const manifest = readReleaseMigrationManifest(draftPath);
    if (manifest.productVersion === input.productVersion) {
      validateReleaseMigrationManifestFiles(input.migrationsRoot, manifest);
      return { path: draftPath, manifest, draft: true };
    }
  }
  throw new Error(`release_migration_manifest_not_found:${input.productVersion}`);
}

export function loadInstalledReleaseMigrationManifest(input: {
  migrationsRoot: string;
  productVersion: string;
  lock: AuthrimLock;
}): { path: string; manifest: ReleaseMigrationManifest; draft: boolean } {
  const result = loadTargetReleaseMigrationManifest({
    migrationsRoot: input.migrationsRoot,
    productVersion: input.productVersion,
    allowDraft: true,
  });
  if (!result.draft) return result;

  const checksum = calculateReleaseManifestChecksum(result.manifest);
  const installed = input.lock.releaseUpdate;
  if (
    installed?.phase !== 'verified' ||
    installed.targetVersion !== input.productVersion ||
    installed.manifestChecksum !== checksum ||
    input.lock.productVersion !== input.productVersion
  ) {
    throw new Error(`unverified_draft_release_manifest:${input.productVersion}`);
  }
  return result;
}

export type MigrationTargetDriver = 'd1' | 'postgres' | 'mysql';
export type MigrationTargetScope = 'deployment' | 'tenant' | 'external';

export interface ReleaseMigrationPhysicalTarget {
  id: string;
  streamId: MigrationStreamId | null;
  driver: MigrationTargetDriver;
  scope: MigrationTargetScope;
  logicalRoles: string[];
  binding?: string;
  databaseId?: string;
  databaseName?: string;
  connectionRef?: string;
  shard?: string;
  automatic: boolean;
  blockedReason?: string;
}

function assignmentShardFromBinding(binding: string): string | undefined {
  return binding.match(/_S([0-9]+)$/u)?.[1];
}

export function buildAssignmentReleaseMigrationTarget(input: {
  binding: string;
  databaseId: string;
  databaseName: string;
  role: 'tenant_core' | 'tenant_pii';
}): ReleaseMigrationPhysicalTarget {
  const streamId = resolveMigrationStreamId({
    logicalRole: input.role,
    targetKind: 'cloudflare-d1',
  });
  if (!streamId) throw new Error(`release_migration_stream_not_available:${input.role}`);
  return {
    id: `d1:${input.databaseId}:${streamId}`,
    streamId,
    driver: 'd1',
    scope: 'tenant',
    logicalRoles: [input.role],
    binding: input.binding,
    databaseId: input.databaseId,
    databaseName: input.databaseName,
    shard: assignmentShardFromBinding(input.binding),
    automatic: true,
  };
}

function pushUniqueTarget(
  targets: ReleaseMigrationPhysicalTarget[],
  target: ReleaseMigrationPhysicalTarget
): void {
  const existing = targets.find((candidate) => candidate.id === target.id);
  if (!existing) {
    targets.push(target);
    return;
  }
  existing.logicalRoles = [...new Set([...existing.logicalRoles, ...target.logicalRoles])].sort();
}

function resolveHyperdriveReference(
  config: AuthrimConfig,
  ref: string
): { connectionRef: string; binding: string; driver: 'postgres' | 'mysql' } | null {
  const direct = config.profiles.references.hyperdrive[ref];
  if (direct) return { connectionRef: ref, binding: direct.binding, driver: direct.driver };
  const byBinding = Object.entries(config.profiles.references.hyperdrive).find(
    ([, reference]) => reference.binding === ref
  );
  if (!byBinding) return null;
  return {
    connectionRef: byBinding[0],
    binding: byBinding[1].binding,
    driver: byBinding[1].driver,
  };
}

function addExternalTarget(
  targets: ReleaseMigrationPhysicalTarget[],
  config: AuthrimConfig,
  input: {
    driver: 'postgres' | 'mysql';
    ref?: string;
    logicalRole: string;
  }
): void {
  if (!input.ref) return;
  const reference = resolveHyperdriveReference(config, input.ref);
  const driver = reference?.driver ?? input.driver;
  const connectionRef = reference?.connectionRef ?? input.ref;
  const streamId =
    driver === 'postgres' && isMigrationLogicalRole(input.logicalRole)
      ? resolveMigrationStreamId({
          logicalRole: input.logicalRole,
          targetKind: 'postgresql-connection',
        })
      : null;
  const targetStreamKey = streamId ?? input.logicalRole;
  pushUniqueTarget(targets, {
    id: `external:${driver}:${connectionRef}:${targetStreamKey}`,
    streamId,
    driver,
    scope: 'external',
    logicalRoles: [input.logicalRole],
    connectionRef,
    binding: reference?.binding,
    automatic: false,
    blockedReason: streamId
      ? 'external_database_executor_not_configured'
      : `release_migration_stream_not_available:${driver}`,
  });
}

export function resolveReleaseMigrationTargets(input: {
  lock: AuthrimLock;
  config: AuthrimConfig;
}): ReleaseMigrationPhysicalTarget[] {
  const targets: ReleaseMigrationPhysicalTarget[] = [];
  const sharedBindings: Array<{
    binding: string;
    streamId: MigrationStreamId;
    logicalRole: MigrationLogicalRole;
  }> = [
    { binding: 'DB', streamId: 'core-d1', logicalRole: 'core' },
    { binding: 'DB_PII', streamId: 'pii-d1', logicalRole: 'pii' },
    { binding: 'DB_ADMIN', streamId: 'admin-d1', logicalRole: 'admin' },
    { binding: 'CONTROL_DB', streamId: 'control-d1', logicalRole: 'control' },
    { binding: 'LOOKUP_DB', streamId: 'lookup-d1', logicalRole: 'lookup' },
    {
      binding: 'PLUGIN_RUNNER_DB',
      streamId: 'plugin-runner-d1',
      logicalRole: 'plugin_runner',
    },
  ];

  for (const definition of sharedBindings) {
    const resource = input.lock.d1[definition.binding];
    if (!resource) continue;
    pushUniqueTarget(targets, {
      id: `d1:${resource.id}:${definition.streamId}`,
      streamId: definition.streamId,
      driver: 'd1',
      scope: 'deployment',
      logicalRoles: [definition.logicalRole],
      binding: definition.binding,
      databaseId: resource.id,
      databaseName: resource.name,
      automatic: true,
    });
  }

  for (const [binding, resource] of Object.entries(input.lock.d1)) {
    if (!isTenantDatabaseBinding(binding)) continue;
    const role = getTenantDatabaseRoleFromBinding(binding);
    if (!role) {
      const unsupportedRole = binding.match(/_(AUDIT|CUSTOM)(?:_S[0-9]+)?$/u)?.[1]?.toLowerCase();
      pushUniqueTarget(targets, {
        id: `d1:${resource.id}:unsupported:${unsupportedRole ?? 'unknown'}`,
        streamId: null,
        driver: 'd1',
        scope: 'tenant',
        logicalRoles: [`tenant_${unsupportedRole ?? 'unknown'}`],
        binding,
        databaseId: resource.id,
        databaseName: resource.name,
        shard: assignmentShardFromBinding(binding),
        automatic: false,
        blockedReason: `release_migration_stream_not_available:tenant_${unsupportedRole ?? 'unknown'}`,
      });
      continue;
    }
    pushUniqueTarget(
      targets,
      buildAssignmentReleaseMigrationTarget({
        binding,
        databaseId: resource.id,
        databaseName: resource.name,
        role,
      })
    );
  }

  for (const profile of input.config.profiles.seed.audit) {
    for (const target of [profile.primary, profile.archive]) {
      if (!target || target.type === 'd1' || target.type === 'r2') continue;
      addExternalTarget(targets, input.config, {
        driver: target.type,
        ref: target.connectionRef ?? target.bindingRef,
        logicalRole: 'audit',
      });
    }
  }

  return targets.sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveRegisteredSchemaReferences(input: {
  lock: AuthrimLock;
  config: AuthrimConfig;
}): string[] {
  const releaseEvidence =
    input.lock.releaseUpdate && input.lock.releaseUpdate.phase !== 'planned'
      ? input.lock.releaseUpdate
      : undefined;
  if (!releaseEvidence) return [];
  const schemaVersion = releaseEvidence.targetVersion;

  const references = new Set<string>();
  for (const target of resolveReleaseMigrationTargets(input)) {
    // Control-managed D1 bindings are selected through the signed runtime registry,
    // not through admin-created runtime profiles. Emitting every Control-managed shard here would
    // make this Worker text variable grow linearly with the tenant pool and exceed Cloudflare's
    // per-variable size limit. Shared and setup-seeded external profile references remain listed.
    if (target.scope === 'tenant') continue;
    if (!target.streamId) continue;
    const state = input.lock.schemaTargets?.[target.id];
    if (
      !state ||
      state.productVersion !== schemaVersion ||
      state.manifestChecksum !== releaseEvidence.manifestChecksum ||
      state.streamId !== target.streamId ||
      !Array.isArray(state.files)
    ) {
      continue;
    }
    if (target.binding) references.add(`binding:${target.binding}:${target.streamId}`);
    if (target.connectionRef) {
      references.add(`connection:${target.connectionRef}:${target.streamId}`);
    }
  }
  return [...references].sort();
}

export function streamDirectory(migrationsRoot: string, streamId: string): string | null {
  const definition = RELEASE_MIGRATION_STREAM_DEFINITIONS.find((item) => item.id === streamId);
  return definition ? join(migrationsRoot, definition.directory) : null;
}

export function discoverReleaseMigrationStream(migrationsDir: string): {
  manifest: ReleaseMigrationManifest;
  stream: ReleaseMigrationStream;
  draft: boolean;
} | null {
  let candidate = resolve(migrationsDir);
  for (let depth = 0; depth < 4; depth += 1) {
    const draftPath = join(candidate, DRAFT_RELEASE_MANIFEST_FILENAME);
    const draftManifest = existsSync(draftPath)
      ? readReleaseMigrationManifest(draftPath)
      : undefined;
    const latestPublished = findLatestReleaseMigrationManifest(candidate)?.manifest;
    if (draftManifest || latestPublished) {
      if (
        draftManifest &&
        latestPublished &&
        compareProductVersions(draftManifest.productVersion, latestPublished.productVersion) < 0
      ) {
        throw new Error(
          `draft_manifest_older_than_published_version:${draftManifest.productVersion}:${latestPublished.productVersion}`
        );
      }
      const sameVersionReleasePath = draftManifest
        ? join(candidate, 'releases', `${draftManifest.productVersion}.json`)
        : undefined;
      const sameVersionPublished =
        sameVersionReleasePath && existsSync(sameVersionReleasePath)
          ? readReleaseMigrationManifest(sameVersionReleasePath)
          : undefined;
      if (
        draftManifest &&
        sameVersionPublished &&
        serializeReleaseMigrationManifest(sameVersionPublished) !==
          serializeReleaseMigrationManifest(draftManifest)
      ) {
        throw new Error(
          `draft_manifest_diverges_from_published_version:${draftManifest.productVersion}`
        );
      }
      const manifest = sameVersionPublished ?? draftManifest ?? latestPublished!;
      const definition = RELEASE_MIGRATION_STREAM_DEFINITIONS.find(
        (item) => resolve(candidate, item.directory) === resolve(migrationsDir)
      );
      const stream = definition
        ? manifest.streams.find((item) => item.id === definition.id)
        : undefined;
      if (stream) {
        return {
          manifest,
          stream,
          draft: !sameVersionPublished && Boolean(draftManifest),
        };
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return null;
}

export function relativeMigrationRoot(rootDir: string, path: string): string {
  return relative(rootDir, path).replaceAll('\\', '/');
}
