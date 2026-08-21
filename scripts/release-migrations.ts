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
  findLatestReleaseMigrationManifest,
  generateReleaseMigrationManifest,
  readReleaseMigrationManifest,
  serializeReleaseMigrationManifest,
  streamDirectory,
  syncDraftReleaseMigrationManifest,
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

type Command = 'baseline' | 'draft' | 'check' | 'prepare';

interface Arguments {
  command: Command;
  version?: string;
  minimumVersion?: string;
  gitRef?: string;
  write: boolean;
}

function parseArguments(argv: string[]): Arguments {
  const command = argv[0] as Command | undefined;
  if (!command || !['baseline', 'draft', 'check', 'prepare'].includes(command)) {
    throw new Error(
      'Usage: release-migrations.ts <baseline|draft|check|prepare> [--version x.y.z] [--git-ref ref] [--minimum-version x.y.z] [--write]'
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
  files: ReleaseMigrationFile[],
  version: string,
  streamId: string
): string {
  const highest = Math.max(...files.map((file) => migrationNumber(file.path)));
  const prefix = String(highest).padStart(3, '0');
  const streamSuffix = streamId.startsWith('external-') ? `_${streamId.replaceAll('-', '_')}` : '';
  return `${prefix}_release_${version.replaceAll(/[^0-9A-Za-z]+/gu, '_')}${streamSuffix}.sql`;
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
      !Array.isArray(operation.sources)
    ) {
      throw new Error(`Invalid release preparation operation: ${path}`);
    }
    const sources = operation.sources.map((source) => ReleaseMigrationFileSchema.parse(source));
    const bundle = manifest.streams
      .find((stream) => stream.id === operation.streamId)
      ?.files.find((file) => file.path === operation.bundlePath);
    if (
      !bundle ||
      bundle.checksum !== operation.bundleChecksum ||
      JSON.stringify(bundle.supersedes ?? []) !== JSON.stringify(sources)
    ) {
      throw new Error(`Release preparation journal does not match its manifest: ${path}`);
    }
    return {
      streamId: operation.streamId,
      dialect: operation.dialect as MigrationSqlDialect,
      sources,
      bundlePath: operation.bundlePath,
      bundleChecksum: operation.bundleChecksum,
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
    if (!existsSync(bundlePath)) {
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
  const operations: ConsolidationOperation[] = [];
  const streams = RELEASE_MIGRATION_STREAM_DEFINITIONS.map((definition) => {
    const current = currentByStream.get(definition.id);
    const previous = previousByStream.get(definition.id);
    if (!current) throw new Error(`Current manifest is missing stream ${definition.id}`);
    const previousFiles = new Map((previous?.files ?? []).map((file) => [file.path, file]));
    const currentFiles = new Map(current.files.map((file) => [file.path, file]));

    for (const published of previous?.files ?? []) {
      const candidate = currentFiles.get(published.path);
      if (!candidate)
        throw new Error(`Published migration is missing: ${definition.id}/${published.path}`);
      if (candidate.checksum !== published.checksum) {
        throw new Error(`Published migration checksum changed: ${definition.id}/${published.path}`);
      }
    }

    const unpublished = current.files.filter((file) => !previousFiles.has(file.path));
    if (unpublished.length <= 1) {
      return {
        ...current,
        files: [...(previous?.files ?? []), ...unpublished],
      };
    }

    const streamRoot = streamDirectory(input.migrationsRoot, definition.id);
    if (!streamRoot) throw new Error(`Unknown migration stream: ${definition.id}`);
    const bundlePath = releaseBundlePath(unpublished, input.version, definition.id);
    if (currentFiles.has(bundlePath) && !unpublished.some((file) => file.path === bundlePath)) {
      throw new Error(`Release bundle already exists: ${definition.id}/${bundlePath}`);
    }
    const bundleSql = mergeSqlFiles(streamRoot, unpublished, input.version);
    const bundleChecksum = checksumSql(bundleSql, definition.dialect);
    operations.push({
      streamId: definition.id,
      streamRoot,
      dialect: definition.dialect,
      sources: unpublished,
      bundlePath,
      bundleSql,
      bundleChecksum,
    });
    return {
      ...current,
      files: [
        ...(previous?.files ?? []),
        {
          path: bundlePath,
          checksum: bundleChecksum,
          supersedes: unpublished.map((file) => ({ path: file.path, checksum: file.checksum })),
        },
      ],
    };
  });

  return {
    manifest: {
      formatVersion: 1,
      productVersion: input.version,
      ...(input.minimumVersion ? { minimumProductVersion: input.minimumVersion } : {}),
      ...(input.current.databaseCompatibility
        ? { databaseCompatibility: input.current.databaseCompatibility }
        : {}),
      ...(input.current.rollout ? { rollout: input.current.rollout } : {}),
      streams,
    },
    operations,
  };
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
      `  ${operation.streamId}: ${operation.sources.length} files -> ${operation.bundlePath}`
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
  const previous = findLatestReleaseMigrationManifest(input.migrationsRoot)?.manifest;
  if (previous && compareProductVersions(input.version, previous.productVersion) <= 0) {
    throw new Error(
      `Release version must be newer than ${previous.productVersion}: ${input.version}`
    );
  }
  const current = generateReleaseMigrationManifest({
    migrationsRoot: input.migrationsRoot,
    productVersion: input.version,
    previousManifest: previous,
  });
  const plan = buildReleaseManifest({
    migrationsRoot: input.migrationsRoot,
    version: input.version,
    minimumVersion: input.minimumVersion,
    current,
    previous,
  });

  if (input.write) {
    const releasePath = join(input.migrationsRoot, 'releases', `${input.version}.json`);
    if (existsSync(releasePath)) throw new Error(`Release manifest already exists: ${releasePath}`);
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
      })),
    };
    writeFileAtomically(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    completeReleasePreparation({ migrationsRoot: input.migrationsRoot, journalPath, journal });
  }
  printPreparationPlan(plan.manifest, plan.operations, input.write);
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
    const draftPath = join(migrationsRoot, DRAFT_RELEASE_MANIFEST_FILENAME);
    if (!existsSync(draftPath)) throw new Error(`Draft manifest is missing: ${draftPath}`);
    const publishedPrevious = findLatestReleaseMigrationManifest(migrationsRoot)?.manifest;
    assertProductVersionNotBehindPublished(version, publishedPrevious?.productVersion);
    const actual = readReleaseMigrationManifest(draftPath);
    const previous = actual.productVersion === version ? actual : publishedPrevious;
    const expected = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: version,
      previousManifest: previous,
    });
    const publishedSameVersionPath = join(migrationsRoot, 'releases', `${version}.json`);
    if (existsSync(publishedSameVersionPath)) {
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
    console.log('Draft migration manifest is current.');
    return;
  }

  checkWorkspaceVersions(rootDir, repositoryVersion);
  validatePublishedReleaseMigrationManifests(migrationsRoot);

  prepareRelease({
    migrationsRoot,
    version,
    minimumVersion: args.minimumVersion,
    write: args.write,
  });
}
