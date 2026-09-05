#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  DRAFT_RELEASE_MANIFEST_FILENAME,
  RELEASE_MIGRATION_STREAM_DEFINITIONS,
  ReleaseMigrationFileSchema,
  ReleaseMigrationManifestSchema,
  assertProductVersionNotBehindPublished,
  calculateReleaseMigrationChecksum,
  compareProductVersions,
  generateReleaseMigrationManifest,
  isVersionPublishedOnRemoteMain,
  listReleaseMigrationManifests,
  readReleaseMigrationManifest,
  resolveReleaseMigrationExecutionManifest,
  serializeReleaseMigrationManifest,
  streamDirectory,
  syncDraftReleaseMigrationManifest,
  validateReleaseMigrationManifestFiles,
  validateRemoteMainPublishedReleaseMigrationManifests,
  validatePublishedReleaseMigrationManifests,
  writeReleaseMigrationManifest,
  type ReleaseMigrationFile,
  type ReleaseMigrationManifest,
  type ReleaseMigrationStream,
} from '../packages/setup/src/core/release-migrations.js';
import {
  renderPortableMigrationSql,
  type MigrationSqlDialect,
} from '../packages/setup/src/core/sql-portability.js';
import { verifySemanticMigrationComposition } from './semantic-baseline-migrations.js';

type Command = 'baseline' | 'draft' | 'check' | 'prepare';

interface Arguments {
  command: Command;
  version?: string;
  minimumVersion?: string;
  gitRef?: string;
  write: boolean;
  requireReleaseCandidate: boolean;
}

function parseArguments(argv: string[]): Arguments {
  const command = argv[0] as Command | undefined;
  if (!command || !['baseline', 'draft', 'check', 'prepare'].includes(command)) {
    throw new Error(
      'Usage: release-migrations.ts <baseline|draft|check|prepare> [--version x.y.z] [--git-ref ref] [--minimum-version x.y.z] [--write] [--require-release-candidate]'
    );
  }
  const readOption = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    command,
    version: readOption('--version'),
    minimumVersion: readOption('--minimum-version'),
    gitRef: readOption('--git-ref'),
    write: argv.includes('--write'),
    requireReleaseCandidate: argv.includes('--require-release-candidate'),
  };
}

function generateManifestFromGitRef(input: {
  rootDir: string;
  gitRef: string;
  productVersion: string;
}): ReleaseMigrationManifest {
  if (!/^[0-9A-Za-z._/-]+$/u.test(input.gitRef)) throw new Error('Invalid Git ref');
  const listFiles = (path: string): string[] => {
    const output = execFileSync('git', ['ls-tree', '-r', '--name-only', input.gitRef, '--', path], {
      cwd: input.rootDir,
      encoding: 'utf-8',
    });
    return output
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.endsWith('.sql'));
  };
  const streams = RELEASE_MIGRATION_STREAM_DEFINITIONS.map((definition) => {
    const prefix =
      definition.directory === '.' ? 'migrations/' : `migrations/${definition.directory}/`;
    const files = listFiles(prefix)
      .flatMap((path) => {
        const relativePath = path.slice(prefix.length);
        const topLevelDirectory = relativePath.split('/', 1)[0];
        if (
          definition.directory === '.' &&
          ['admin', 'archive', 'external', 'pii', 'releases'].includes(topLevelDirectory)
        ) {
          return [];
        }
        if (definition.includePath && !definition.includePath(relativePath)) return [];
        const sql = execFileSync('git', ['show', `${input.gitRef}:${path}`], {
          cwd: input.rootDir,
          encoding: 'utf-8',
        });
        return [{ path: relativePath, checksum: checksumSql(sql, definition.dialect) }];
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    return {
      id: definition.id,
      dialect: definition.dialect,
      logicalRoles: [...definition.logicalRoles],
      files,
    };
  });
  return {
    formatVersion: 1,
    productVersion: input.productVersion,
    streams,
  };
}

function rootVersion(rootDir: string): string {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8')) as {
    version?: unknown;
  };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('Root package.json does not contain a product version');
  }
  return pkg.version;
}

export function assertReleaseVersionMatchesRoot(
  requestedVersion: string,
  repositoryVersion: string
): void {
  if (requestedVersion !== repositoryVersion) {
    throw new Error(
      `Release version must match root package.json ${repositoryVersion}: received ${requestedVersion}`
    );
  }
}

function checkWorkspaceVersions(rootDir: string, expectedVersion: string): void {
  const packagesDirectory = join(rootDir, 'packages');
  const mismatches: string[] = [];
  for (const entry of readdirSync(packagesDirectory).sort()) {
    const packageDirectory = join(packagesDirectory, entry);
    const packagePath = join(packageDirectory, 'package.json');
    if (!statSync(packageDirectory).isDirectory() || !existsSync(packagePath)) continue;
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as { version?: unknown };
    if (pkg.version !== expectedVersion) mismatches.push(`${entry}=${String(pkg.version)}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Workspace package versions must match root ${expectedVersion}: ${mismatches.join(', ')}`
    );
  }
}

function checksumSql(sql: string, dialect: MigrationSqlDialect): string {
  return createHash('sha256').update(renderPortableMigrationSql(sql, dialect)).digest('hex');
}

function migrationNumber(path: string): number {
  const match = basename(path).match(/^(\d+)_/u);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function releaseBundlePath(
  version: string,
  streamId: string,
  previousFiles: readonly ReleaseMigrationFile[] = []
): string {
  const next = Math.max(0, ...previousFiles.map((file) => migrationNumber(file.path))) + 1;
  const prefix = String(next).padStart(3, '0');
  const streamSuffix = streamId.replace(/^d1-/u, '').replaceAll('-', '_');
  return `${prefix}_${version.replaceAll(/[^0-9A-Za-z]+/gu, '_')}_${streamSuffix}_delta.sql`;
}

function mergeSqlFiles(streamRoot: string, files: ReleaseMigrationFile[], version: string): string {
  const sections = files.map((file) => {
    const sql = readFileSync(join(streamRoot, file.path), 'utf-8').trimEnd();
    return `-- =============================================================================\n-- Consolidated from ${file.path}\n-- =============================================================================\n${sql}`;
  });
  return `-- Authrim ${version} release migration bundle.\n-- Generated from unpublished migrations; do not edit after release.\n\n${sections.join('\n\n')}\n`;
}

function streamMap(manifest: ReleaseMigrationManifest): Map<string, ReleaseMigrationStream> {
  return new Map(manifest.streams.map((stream) => [stream.id, stream]));
}

interface ConsolidationOperation {
  streamId: string;
  streamRoot: string;
  dialect: MigrationSqlDialect;
  sources: ReleaseMigrationFile[];
  bundlePath: string;
  bundleSql: string;
  bundleChecksum: string;
  replaceSources: boolean;
}

interface ReleasePreparationJournal {
  formatVersion: 1;
  productVersion: string;
  manifest: ReleaseMigrationManifest;
  operations: Array<{
    streamId: string;
    dialect: MigrationSqlDialect;
    sources: ReleaseMigrationFile[];
    bundlePath: string;
    bundleChecksum: string;
    replaceSources: boolean;
  }>;
}

function preparationJournalPath(migrationsRoot: string, version: string): string {
  return join(migrationsRoot, 'releases', `.${version}.prepare-state`);
}

function listPreparationJournals(migrationsRoot: string): string[] {
  const releasesDirectory = join(migrationsRoot, 'releases');
  if (!existsSync(releasesDirectory)) return [];
  return readdirSync(releasesDirectory)
    .filter((entry) => entry.startsWith('.') && entry.endsWith('.prepare-state'))
    .map((entry) => join(releasesDirectory, entry))
    .sort();
}

function writeFileAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, content, 'utf-8');
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath);
  }
}

function readPreparationJournal(path: string): ReleasePreparationJournal {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ReleasePreparationJournal>;
  if (raw.formatVersion !== 1 || typeof raw.productVersion !== 'string') {
    throw new Error(`Invalid release preparation journal: ${path}`);
  }
  const manifest = ReleaseMigrationManifestSchema.parse(raw.manifest);
  if (manifest.productVersion !== raw.productVersion || !Array.isArray(raw.operations)) {
    throw new Error(`Release preparation journal version mismatch: ${path}`);
  }
  const operations = raw.operations.map((operation) => {
    if (
      !operation ||
      typeof operation.streamId !== 'string' ||
      !['sqlite', 'postgres', 'mysql'].includes(operation.dialect) ||
      typeof operation.bundlePath !== 'string' ||
      typeof operation.bundleChecksum !== 'string' ||
      !Array.isArray(operation.sources) ||
      (operation.replaceSources !== undefined && typeof operation.replaceSources !== 'boolean')
    ) {
      throw new Error(`Invalid release preparation operation: ${path}`);
    }
    const replaceSources = operation.replaceSources !== false;
    const sources = operation.sources.map((source) => ReleaseMigrationFileSchema.parse(source));
    const matchingStreams = [
      ...manifest.streams,
      ...(manifest.upgradePaths ?? []).flatMap((path) => path.streams),
    ].filter((stream) => stream.id === operation.streamId);
    const bundle = matchingStreams
      .flatMap((stream) => stream.files)
      .find((file) => file.path === operation.bundlePath);
    if (
      !bundle ||
      bundle.checksum !== operation.bundleChecksum ||
      !bundle.semanticEvidence ||
      (replaceSources
        ? JSON.stringify(bundle.supersedes ?? []) !== JSON.stringify(sources)
        : sources.length !== 1 || sources[0]?.path !== bundle.path)
    ) {
      throw new Error(`Release preparation journal does not match its manifest: ${path}`);
    }
    return {
      streamId: operation.streamId,
      dialect: operation.dialect as MigrationSqlDialect,
      sources,
      bundlePath: operation.bundlePath,
      bundleChecksum: operation.bundleChecksum,
      replaceSources,
    };
  });
  return { formatVersion: 1, productVersion: raw.productVersion, manifest, operations };
}

function completeReleasePreparation(input: {
  migrationsRoot: string;
  journalPath: string;
  journal: ReleasePreparationJournal;
}): void {
  for (const operation of input.journal.operations) {
    const streamRoot = streamDirectory(input.migrationsRoot, operation.streamId);
    if (!streamRoot) throw new Error(`Unknown migration stream: ${operation.streamId}`);
    const bundlePath = join(streamRoot, operation.bundlePath);
    if (!existsSync(bundlePath) && operation.replaceSources) {
      for (const source of operation.sources) {
        const sourcePath = join(streamRoot, source.path);
        if (!existsSync(sourcePath)) {
          throw new Error(
            `Cannot resume release; source is missing: ${operation.streamId}/${source.path}`
          );
        }
        if (calculateReleaseMigrationChecksum(sourcePath, operation.dialect) !== source.checksum) {
          throw new Error(
            `Cannot resume release; source changed: ${operation.streamId}/${source.path}`
          );
        }
      }
      const sql = mergeSqlFiles(streamRoot, operation.sources, input.journal.productVersion);
      if (checksumSql(sql, operation.dialect) !== operation.bundleChecksum) {
        throw new Error(`Cannot resume release; bundle checksum changed: ${operation.streamId}`);
      }
      writeFileAtomically(bundlePath, sql);
    }
    if (!existsSync(bundlePath)) {
      throw new Error(
        `Cannot resume release; canonical delta is missing: ${operation.streamId}/${operation.bundlePath}`
      );
    }
    if (
      calculateReleaseMigrationChecksum(bundlePath, operation.dialect) !== operation.bundleChecksum
    ) {
      throw new Error(
        `Generated bundle checksum mismatch: ${operation.streamId}/${operation.bundlePath}`
      );
    }
  }

  const releasePath = join(
    input.migrationsRoot,
    'releases',
    `${input.journal.productVersion}.json`
  );
  writeFileAtomically(releasePath, serializeReleaseMigrationManifest(input.journal.manifest));
  writeFileAtomically(
    join(input.migrationsRoot, DRAFT_RELEASE_MANIFEST_FILENAME),
    serializeReleaseMigrationManifest(input.journal.manifest)
  );

  // The durable manifest now contains every supersedes mapping. Source cleanup
  // can be resumed safely after interruption without losing release identity.
  for (const operation of input.journal.operations) {
    if (!operation.replaceSources) continue;
    const streamRoot = streamDirectory(input.migrationsRoot, operation.streamId);
    if (!streamRoot) throw new Error(`Unknown migration stream: ${operation.streamId}`);
    for (const source of operation.sources) {
      const sourcePath = join(streamRoot, source.path);
      if (!existsSync(sourcePath)) continue;
      if (calculateReleaseMigrationChecksum(sourcePath, operation.dialect) !== source.checksum) {
        throw new Error(
          `Refusing to remove changed release source: ${operation.streamId}/${source.path}`
        );
      }
      rmSync(sourcePath);
    }
  }
  rmSync(input.journalPath);
}

function buildReleaseManifest(input: {
  migrationsRoot: string;
  version: string;
  minimumVersion?: string;
  current: ReleaseMigrationManifest;
  previous?: ReleaseMigrationManifest;
  releaseHistory?: readonly ReleaseMigrationManifest[];
}): { manifest: ReleaseMigrationManifest; operations: ConsolidationOperation[] } {
  if (!input.previous) {
    return {
      manifest: {
        ...input.current,
        productVersion: input.version,
        ...(input.minimumVersion ? { minimumProductVersion: input.minimumVersion } : {}),
      },
      operations: [],
    };
  }

  const currentByStream = streamMap(input.current);
  const previousByStream = streamMap(input.previous);
  const explicitDirectUpgrade = input.current.upgradePaths?.find(
    (path) => path.fromProductVersion === input.previous!.productVersion
  );
  const directUpgrade =
    explicitDirectUpgrade ??
    (!input.current.freshInstallBaseline
      ? {
          fromProductVersion: input.previous.productVersion,
          kind: 'delta' as const,
          streams: input.current.streams.map((stream) => {
            const previous = input.previous!.streams.find(
              (candidate) => candidate.id === stream.id
            );
            const previousPaths = new Set((previous?.files ?? []).map((file) => file.path));
            return {
              ...stream,
              files: stream.files.filter((file) => !previousPaths.has(file.path)),
            };
          }),
        }
      : undefined);
  if (!directUpgrade) {
    throw new Error(
      `Release ${input.version} has no upgrade path from ${input.previous.productVersion}`
    );
  }
  const upgradeByStream = streamMap({
    formatVersion: 1,
    productVersion: input.version,
    streams: directUpgrade.streams,
  });
  const operations: ConsolidationOperation[] = [];
  const streams = RELEASE_MIGRATION_STREAM_DEFINITIONS.map((definition) => {
    const current = currentByStream.get(definition.id);
    const previous = previousByStream.get(definition.id);
    if (!current) throw new Error(`Current manifest is missing stream ${definition.id}`);
    const unpublished = upgradeByStream.get(definition.id)?.files ?? [];
    if (unpublished.length === 0) return current;

    const streamRoot = streamDirectory(input.migrationsRoot, definition.id);
    if (!streamRoot) throw new Error(`Unknown migration stream: ${definition.id}`);
    const previousFiles = input.previous
      ? previousInstalledStreamFiles({
          previous: input.previous,
          releaseHistory: input.releaseHistory ?? [input.previous],
          streamId: definition.id,
        })
      : (previous?.files ?? []);
    const canonicalPath = releaseBundlePath(input.version, definition.id, previousFiles);
    if (unpublished.length === 1 && unpublished[0]?.path === canonicalPath) {
      const source = unpublished[0];
      operations.push({
        streamId: definition.id,
        streamRoot,
        dialect: definition.dialect,
        sources: [source],
        bundlePath: canonicalPath,
        bundleSql: readFileSync(join(streamRoot, source.path), 'utf-8'),
        bundleChecksum: source.checksum,
        replaceSources: false,
      });
      return current;
    }
    const currentFiles = new Map(current.files.map((file) => [file.path, file]));
    if (
      currentFiles.has(canonicalPath) &&
      !unpublished.some((file) => file.path === canonicalPath)
    ) {
      throw new Error(`Release bundle already exists: ${definition.id}/${canonicalPath}`);
    }
    const bundleSql = mergeSqlFiles(streamRoot, unpublished, input.version);
    const bundleChecksum = checksumSql(bundleSql, definition.dialect);
    operations.push({
      streamId: definition.id,
      streamRoot,
      dialect: definition.dialect,
      sources: unpublished,
      bundlePath: canonicalPath,
      bundleSql,
      bundleChecksum,
      replaceSources: true,
    });
    const deltaIsPartOfFreshPlan = unpublished.some((source) =>
      current.files.some((file) => file.path === source.path)
    );
    return {
      ...current,
      files: deltaIsPartOfFreshPlan
        ? current.files
            .filter((file) => !unpublished.some((source) => source.path === file.path))
            .concat({
              path: canonicalPath,
              checksum: bundleChecksum,
              supersedes: unpublished.map((file) => ({
                path: file.path,
                checksum: file.checksum,
              })),
            })
            .sort((left, right) => left.path.localeCompare(right.path))
        : current.files,
    };
  });

  const operationByStream = new Map(operations.map((operation) => [operation.streamId, operation]));
  const upgradePaths = (input.current.upgradePaths ?? []).map((path) =>
    path.fromProductVersion !== input.previous!.productVersion
      ? path
      : {
          ...path,
          streams: path.streams.map((stream) => {
            const operation = operationByStream.get(stream.id);
            if (!operation || !operation.replaceSources) return stream;
            return {
              ...stream,
              files: [
                {
                  path: operation.bundlePath,
                  checksum: operation.bundleChecksum,
                  supersedes: operation.sources.map((file) => ({
                    path: file.path,
                    checksum: file.checksum,
                  })),
                },
              ],
            };
          }),
        }
  );

  return {
    manifest: {
      formatVersion: 1,
      productVersion: input.version,
      ...(input.minimumVersion ? { minimumProductVersion: input.minimumVersion } : {}),
      ...(input.current.databaseCompatibility
        ? { databaseCompatibility: input.current.databaseCompatibility }
        : {}),
      ...(input.current.rollout ? { rollout: input.current.rollout } : {}),
      ...(input.current.freshInstallBaseline
        ? { freshInstallBaseline: input.current.freshInstallBaseline }
        : {}),
      ...(upgradePaths.length > 0 ? { upgradePaths } : {}),
      streams,
    },
    operations,
  };
}

function previousInstalledStreamFiles(input: {
  previous: ReleaseMigrationManifest;
  releaseHistory: readonly ReleaseMigrationManifest[];
  streamId: string;
}): ReleaseMigrationFile[] {
  const freshFiles =
    input.previous.streams.find((stream) => stream.id === input.streamId)?.files ?? [];
  const baselineVersion = input.previous.freshInstallBaseline?.productVersion;
  if (!baselineVersion || baselineVersion === input.previous.productVersion) return freshFiles;
  const execution = resolveReleaseMigrationExecutionManifest({
    targetManifest: input.previous,
    installedProductVersion: baselineVersion,
    availableManifests: input.releaseHistory,
  });
  const deltaFiles = execution.streams.find((stream) => stream.id === input.streamId)?.files ?? [];
  const files = new Map<string, ReleaseMigrationFile>();
  for (const file of [...freshFiles, ...deltaFiles]) {
    const existing = files.get(file.path);
    if (existing && existing.checksum !== file.checksum) {
      throw new Error(`Release history checksum conflict: ${input.streamId}/${file.path}`);
    }
    files.set(file.path, file);
  }
  return [...files.values()];
}

function verifyConsolidationOperations(input: {
  migrationsRoot: string;
  previous?: ReleaseMigrationManifest;
  releaseHistory: readonly ReleaseMigrationManifest[];
  operations: readonly ConsolidationOperation[];
  manifest: ReleaseMigrationManifest;
}): ReleaseMigrationManifest {
  const evidenceByBundle = new Map<
    string,
    { schemaChecksum: string; seedChecksum: string; objectCount: number }
  >();
  for (const operation of input.operations) {
    const baseFiles = input.previous
      ? previousInstalledStreamFiles({
          previous: input.previous,
          releaseHistory: input.releaseHistory,
          streamId: operation.streamId,
        })
      : [];
    const readSql = (file: ReleaseMigrationFile): string =>
      readFileSync(join(operation.streamRoot, file.path), 'utf-8');
    const evidence = verifySemanticMigrationComposition({
      streamId: operation.streamId,
      dialect: operation.dialect,
      baseSql: baseFiles.map(readSql),
      sourceSql: operation.sources.map(readSql),
      consolidatedSql: operation.bundleSql,
    });
    evidenceByBundle.set(`${operation.streamId}:${operation.bundlePath}`, {
      schemaChecksum: evidence.schemaChecksum,
      seedChecksum: evidence.seedChecksum,
      objectCount: evidence.objectCount,
    });
    console.log(
      `  ${operation.streamId}: semantic delta verified ` +
        `(${evidence.objectCount} objects, schema ${evidence.schemaChecksum.slice(0, 12)}, ` +
        `seed ${evidence.seedChecksum.slice(0, 12)})`
    );
  }
  const addEvidence = (stream: ReleaseMigrationStream): ReleaseMigrationStream => ({
    ...stream,
    files: stream.files.map((file) => {
      const semanticEvidence = evidenceByBundle.get(`${stream.id}:${file.path}`);
      return semanticEvidence ? { ...file, semanticEvidence } : file;
    }),
  });
  return ReleaseMigrationManifestSchema.parse({
    ...input.manifest,
    streams: input.manifest.streams.map(addEvidence),
    upgradePaths: input.manifest.upgradePaths?.map((path) => ({
      ...path,
      streams: path.streams.map(addEvidence),
    })),
  });
}

function printPreparationPlan(
  manifest: ReleaseMigrationManifest,
  operations: ConsolidationOperation[],
  write: boolean
): void {
  console.log(`Authrim migration release plan: ${manifest.productVersion}`);
  if (operations.length === 0) {
    console.log(
      '  Initial baseline or no multi-file unpublished streams; no consolidation needed.'
    );
  }
  for (const operation of operations) {
    console.log(
      operation.replaceSources
        ? `  ${operation.streamId}: ${operation.sources.length} files -> ${operation.bundlePath}`
        : `  ${operation.streamId}: verify canonical delta ${operation.bundlePath}`
    );
    for (const source of operation.sources) console.log(`    - ${source.path}`);
  }
  console.log(write ? '  Release files written.' : '  Dry run only; pass --write to modify files.');
}

export function prepareRelease(input: {
  migrationsRoot: string;
  version: string;
  minimumVersion?: string;
  write: boolean;
}): void {
  const journalPath = preparationJournalPath(input.migrationsRoot, input.version);
  const preparationJournals = listPreparationJournals(input.migrationsRoot);
  const otherJournals = preparationJournals.filter((path) => path !== journalPath);
  if (otherJournals.length > 0) {
    throw new Error(
      `Another release preparation is incomplete; resume it before ${input.version}: ${otherJournals.join(', ')}`
    );
  }
  if (preparationJournals.includes(journalPath)) {
    if (!input.write) {
      throw new Error(`Release preparation is incomplete; resume with --write: ${journalPath}`);
    }
    const journal = readPreparationJournal(journalPath);
    if (journal.productVersion !== input.version) {
      throw new Error(`Release preparation journal targets ${journal.productVersion}`);
    }
    completeReleasePreparation({ migrationsRoot: input.migrationsRoot, journalPath, journal });
    console.log(`Resumed and completed Authrim migration release ${input.version}.`);
    return;
  }
  const releaseHistory = listReleaseMigrationManifests(input.migrationsRoot);
  const sameVersionRelease = releaseHistory.find(
    (release) => release.manifest.productVersion === input.version
  );
  const published = isVersionPublishedOnRemoteMain({
    repositoryRoot: dirname(input.migrationsRoot),
    productVersion: input.version,
  });
  if (sameVersionRelease && published) {
    throw new Error(`Release version is published on remote main: ${input.version}`);
  }
  const previous = releaseHistory
    .filter((release) => compareProductVersions(release.manifest.productVersion, input.version) < 0)
    .at(-1)?.manifest;
  const latestNewer = releaseHistory.find(
    (release) => compareProductVersions(release.manifest.productVersion, input.version) > 0
  );
  if (latestNewer) {
    throw new Error(
      `Release version must be newer than ${latestNewer.manifest.productVersion}: ${input.version}`
    );
  }
  const current = generateReleaseMigrationManifest({
    migrationsRoot: input.migrationsRoot,
    productVersion: input.version,
    previousManifest: previous,
    previousManifests: releaseHistory.map((release) => release.manifest),
  });
  const plan = buildReleaseManifest({
    migrationsRoot: input.migrationsRoot,
    version: input.version,
    minimumVersion: input.minimumVersion,
    current,
    previous,
    releaseHistory: releaseHistory.map((release) => release.manifest),
  });

  plan.manifest = verifyConsolidationOperations({
    migrationsRoot: input.migrationsRoot,
    previous,
    releaseHistory: releaseHistory.map((release) => release.manifest),
    operations: plan.operations,
    manifest: plan.manifest,
  });

  if (input.write) {
    const releasePath = join(input.migrationsRoot, 'releases', `${input.version}.json`);
    if (existsSync(releasePath) && published) {
      throw new Error(`Release manifest already exists and is published: ${releasePath}`);
    }
    const journal: ReleasePreparationJournal = {
      formatVersion: 1,
      productVersion: input.version,
      manifest: plan.manifest,
      operations: plan.operations.map((operation) => ({
        streamId: operation.streamId,
        dialect: operation.dialect,
        sources: operation.sources,
        bundlePath: operation.bundlePath,
        bundleChecksum: operation.bundleChecksum,
        replaceSources: operation.replaceSources,
      })),
    };
    writeFileAtomically(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    completeReleasePreparation({ migrationsRoot: input.migrationsRoot, journalPath, journal });
  }
  printPreparationPlan(plan.manifest, plan.operations, input.write);
}

function versionParts(version: string): [number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  if (!match) throw new Error(`Invalid release version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function validateSemanticBaselineEvidence(input: {
  migrationsRoot: string;
  manifest: ReleaseMigrationManifest;
}): void {
  const evidencePath = join(
    input.migrationsRoot,
    'evidence',
    `${input.manifest.productVersion}.json`
  );
  if (!existsSync(evidencePath)) {
    throw new Error(`Semantic baseline evidence is missing: ${evidencePath}`);
  }
  const evidenceContents = readFileSync(evidencePath, 'utf-8');
  const currentEvidencePath = join(input.migrationsRoot, 'semantic-baseline.evidence.json');
  if (
    !existsSync(currentEvidencePath) ||
    readFileSync(currentEvidencePath, 'utf-8') !== evidenceContents
  ) {
    throw new Error(
      `Current semantic baseline evidence differs from the ${input.manifest.productVersion} release candidate`
    );
  }
  const raw = JSON.parse(evidenceContents) as {
    formatVersion?: unknown;
    productVersion?: unknown;
    compatibility?: unknown;
    streams?: unknown;
  };
  if (
    raw.formatVersion !== 1 ||
    raw.productVersion !== input.manifest.productVersion ||
    raw.compatibility !== 'fresh_install_only' ||
    !Array.isArray(raw.streams)
  ) {
    throw new Error(
      `Semantic baseline evidence does not target ${input.manifest.productVersion}: ${evidencePath}`
    );
  }
  const evidenceByStream = new Map<
    string,
    {
      path?: unknown;
      checksum?: unknown;
      schemaChecksum?: unknown;
      seedChecksum?: unknown;
      objectCount?: unknown;
      generatedFrom?: unknown;
    }
  >();
  for (const entry of raw.streams) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as {
      id?: unknown;
      path?: unknown;
      checksum?: unknown;
      schemaChecksum?: unknown;
      seedChecksum?: unknown;
      objectCount?: unknown;
      generatedFrom?: unknown;
    };
    if (typeof record.id === 'string') evidenceByStream.set(record.id, record);
  }
  for (const stream of input.manifest.streams) {
    if (stream.files.length === 0) continue;
    const baseline = stream.files.find(
      (file) =>
        file.path.includes(`_${input.manifest.productVersion.replaceAll('.', '_')}_`) &&
        file.path.endsWith('_baseline.sql')
    );
    const evidence = evidenceByStream.get(stream.id);
    if (
      !baseline ||
      evidence?.path !== baseline.path ||
      evidence.checksum !== baseline.checksum ||
      typeof evidence.schemaChecksum !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(evidence.schemaChecksum) ||
      typeof evidence.seedChecksum !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(evidence.seedChecksum) ||
      typeof evidence.objectCount !== 'number' ||
      !Number.isInteger(evidence.objectCount) ||
      evidence.objectCount < 0 ||
      !Array.isArray(evidence.generatedFrom) ||
      evidence.generatedFrom.length === 0
    ) {
      throw new Error(`Semantic baseline evidence is incomplete for ${stream.id}`);
    }
  }
}

export function validateReleaseCandidateForMain(input: {
  migrationsRoot: string;
  productVersion: string;
}): void {
  const releasePath = join(input.migrationsRoot, 'releases', `${input.productVersion}.json`);
  if (!existsSync(releasePath)) {
    throw new Error(
      `Release migration candidate is missing for ${input.productVersion}. ` +
        'Ask the repository owner to authorize baseline or release-delta preparation before merging to main.'
    );
  }
  const draftPath = join(input.migrationsRoot, DRAFT_RELEASE_MANIFEST_FILENAME);
  if (!existsSync(draftPath)) throw new Error(`Draft manifest is missing: ${draftPath}`);
  const candidate = readReleaseMigrationManifest(releasePath);
  const draft = readReleaseMigrationManifest(draftPath);
  if (candidate.productVersion !== input.productVersion) {
    throw new Error(`Release migration candidate version mismatch: ${candidate.productVersion}`);
  }
  if (serializeReleaseMigrationManifest(candidate) !== serializeReleaseMigrationManifest(draft)) {
    throw new Error(
      `Release migration candidate for ${input.productVersion} is not prepared from the current draft. ` +
        'Ask the repository owner whether to prepare the release migration files.'
    );
  }
  if (candidate.acceptedMigrationHistory) {
    throw new Error(
      'Canonical release candidates must not contain runtime accepted migration history'
    );
  }
  validateReleaseMigrationManifestFiles(input.migrationsRoot, candidate);

  const [major, minor, patch] = versionParts(input.productVersion);
  const seriesBaselineVersion = `${major}.${minor}.0`;
  if (candidate.freshInstallBaseline?.productVersion !== seriesBaselineVersion) {
    throw new Error(
      `Release ${input.productVersion} must select the ${seriesBaselineVersion} fresh-install baseline`
    );
  }
  if (patch === 0) {
    validateSemanticBaselineEvidence({ migrationsRoot: input.migrationsRoot, manifest: candidate });
  }

  const history = listReleaseMigrationManifests(input.migrationsRoot);
  const previous = history
    .filter(
      (entry) => compareProductVersions(entry.manifest.productVersion, input.productVersion) < 0
    )
    .at(-1)?.manifest;
  if (!previous) return;
  const direct = candidate.upgradePaths?.find(
    (path) => path.fromProductVersion === previous.productVersion
  );
  if (!direct) {
    throw new Error(
      `Release ${input.productVersion} is missing an explicit upgrade path from ${previous.productVersion}`
    );
  }
  for (const stream of direct.streams) {
    if (stream.files.length > 1) {
      throw new Error(
        `Release ${input.productVersion} has multiple unconsolidated deltas for ${stream.id}`
      );
    }
    const file = stream.files[0];
    if (!file) continue;
    if (!file.semanticEvidence) {
      throw new Error(
        `Release ${input.productVersion} delta lacks semantic verification evidence: ${stream.id}/${file.path}`
      );
    }
    const expectedPath = releaseBundlePath(
      input.productVersion,
      stream.id,
      previousInstalledStreamFiles({
        previous,
        releaseHistory: history.map((entry) => entry.manifest),
        streamId: stream.id,
      })
    );
    if (file.path !== expectedPath) {
      throw new Error(
        `Release ${input.productVersion} delta is not canonical: ${stream.id}/${file.path}; expected ${expectedPath}`
      );
    }
  }
}

export function runReleaseMigrationsCli(): void {
  const args = parseArguments(process.argv.slice(2));
  const rootDir = process.cwd();
  const migrationsRoot = join(rootDir, 'migrations');
  const repositoryVersion = rootVersion(rootDir);
  const version = args.version ?? repositoryVersion;

  if (args.command === 'baseline') {
    if (!args.gitRef) throw new Error('baseline requires --git-ref');
    const manifest = generateManifestFromGitRef({
      rootDir,
      gitRef: args.gitRef,
      productVersion: version,
    });
    const releasePath = join(migrationsRoot, 'releases', `${version}.json`);
    if (args.write) {
      if (existsSync(releasePath))
        throw new Error(`Release manifest already exists: ${releasePath}`);
      writeReleaseMigrationManifest(releasePath, manifest);
    }
    console.log(
      `${args.write ? 'Wrote' : 'Would write'} ${releasePath} from ${args.gitRef} (${manifest.streams.reduce((count, stream) => count + stream.files.length, 0)} files)`
    );
    return;
  }

  assertReleaseVersionMatchesRoot(version, repositoryVersion);

  if (args.command === 'draft') {
    const result = syncDraftReleaseMigrationManifest({ migrationsRoot, productVersion: version });
    console.log(`Updated ${result.path}`);
    return;
  }

  if (args.command === 'check') {
    const preparationJournals = listPreparationJournals(migrationsRoot);
    if (preparationJournals.length > 0) {
      throw new Error(
        `Release preparation is incomplete; resume before checking manifests: ${preparationJournals.join(', ')}`
      );
    }
    checkWorkspaceVersions(rootDir, version);
    validatePublishedReleaseMigrationManifests(migrationsRoot);
    validateRemoteMainPublishedReleaseMigrationManifests({
      migrationsRoot,
      repositoryRoot: rootDir,
    });
    const draftPath = join(migrationsRoot, DRAFT_RELEASE_MANIFEST_FILENAME);
    if (!existsSync(draftPath)) throw new Error(`Draft manifest is missing: ${draftPath}`);
    const releaseHistory = listReleaseMigrationManifests(migrationsRoot);
    const publishedPrevious = releaseHistory
      .filter((release) =>
        isVersionPublishedOnRemoteMain({
          repositoryRoot: rootDir,
          productVersion: release.manifest.productVersion,
        })
      )
      .at(-1)?.manifest;
    const latestReleaseCandidate = releaseHistory.at(-1)?.manifest;
    assertProductVersionNotBehindPublished(version, publishedPrevious?.productVersion);
    const actual = readReleaseMigrationManifest(draftPath);
    const previous = actual.productVersion === version ? actual : latestReleaseCandidate;
    const expected = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: version,
      previousManifest: previous,
      previousManifests: releaseHistory.map((release) => release.manifest),
    });
    const publishedSameVersionPath = join(migrationsRoot, 'releases', `${version}.json`);
    if (
      existsSync(publishedSameVersionPath) &&
      isVersionPublishedOnRemoteMain({ repositoryRoot: rootDir, productVersion: version })
    ) {
      const published = readReleaseMigrationManifest(publishedSameVersionPath);
      if (
        serializeReleaseMigrationManifest(published) !== serializeReleaseMigrationManifest(expected)
      ) {
        throw new Error(
          `Product version ${version} is already published; bump root package.json before adding migrations.`
        );
      }
    }
    if (serializeReleaseMigrationManifest(actual) !== serializeReleaseMigrationManifest(expected)) {
      throw new Error('Draft migration manifest is stale. Run pnpm migrate:manifest.');
    }
    if (args.requireReleaseCandidate) {
      validateReleaseCandidateForMain({ migrationsRoot, productVersion: version });
      console.log(`Release migration candidate ${version} is ready for main.`);
    }
    console.log('Draft migration manifest is current.');
    return;
  }

  checkWorkspaceVersions(rootDir, repositoryVersion);
  // Release candidates remain mutable until their version tag is reachable from remote main.
  // Validating every local candidate here would prevent an explicitly authorized regeneration
  // after semantic baseline generation changed its checksum. Published artifacts are still
  // checked byte-for-byte against their remote-main tags.
  validateRemoteMainPublishedReleaseMigrationManifests({
    migrationsRoot,
    repositoryRoot: rootDir,
  });

  prepareRelease({
    migrationsRoot,
    version,
    minimumVersion: args.minimumVersion,
    write: args.write,
  });
}
