import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { AuthrimLockSchema, type AuthrimLock } from '../core/lock.js';
import {
  assertDatabaseOnlyWorkerCompatibility,
  assertReleaseDatabaseCompatibility,
  assertProductVersionOpenForNewMigrations,
  assertProductVersionNotBehindPublished,
  buildReleaseMigrationArtifactManifest,
  calculateReleaseMigrationChecksum,
  calculateReleaseManifestChecksum,
  compareProductVersions,
  discoverReleaseMigrationStream,
  generateReleaseMigrationManifest,
  isVersionPublishedOnRemoteMain,
  loadInstalledReleaseMigrationManifest,
  loadTargetReleaseMigrationManifest,
  readReleaseMigrationManifest,
  ReleaseMigrationManifestSchema,
  resolveReleaseMigrationTargets,
  resolveReleaseMigrationExecutionManifest,
  resolveRegisteredSchemaReferences,
  syncDraftReleaseMigrationManifest,
  validateReleaseMigrationManifestFiles,
  validateRemoteMainPublishedReleaseMigrationManifests,
  validatePublishedReleaseMigrationManifests,
  writeReleaseMigrationManifest,
  type ReleaseMigrationManifest,
} from '../core/release-migrations.js';
import {
  buildReleaseSchemaUpdatePlan,
  getControlManagedReleaseStreamIds,
} from '../core/release-update.js';
import { withSchemaTargetStates, withVerifiedInitialReleaseState } from '../core/release-state.js';
import {
  assertReleaseVersionMatchesRoot,
  prepareRelease,
  validateReleaseCandidateForMain,
} from '../../../../scripts/release-migrations.js';
import { parseArguments as parseD1RunnerArguments } from '../../../../scripts/run-d1-migrations.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe('manifest-aware repository D1 runner', () => {
  it('requires an explicit safe database, directory, and logical role', () => {
    expect(
      parseD1RunnerArguments([
        '--database',
        'dev-authrim-core-db',
        '--env',
        'dev',
        '--directory',
        'migrations',
        '--role',
        'core',
        '--status',
      ])
    ).toMatchObject({ database: 'dev-authrim-core-db', role: 'core', status: true });
    expect(() =>
      parseD1RunnerArguments([
        '--database',
        '../unsafe',
        '--directory',
        'migrations',
        '--role',
        'core',
      ])
    ).toThrow('--database');
    expect(() =>
      parseD1RunnerArguments([
        '--database',
        'dev-authrim-core-db',
        '--env',
        'dev',
        '--directory',
        'migrations',
        '--role',
        'audit',
      ])
    ).toThrow('--role');
    expect(() =>
      parseD1RunnerArguments([
        '--database',
        'dev-authrim-core-db',
        '--env',
        'dev',
        '--directory',
        'migrations',
        '--initial',
      ])
    ).toThrow('initial schema bootstrap must use authrim-setup deploy');
  });
});

function temporaryMigrations(): string {
  const root = mkdtempSync(join(tmpdir(), 'authrim-release-manifest-'));
  temporaryDirectories.push(root);
  for (const directory of ['admin', 'pii', 'external/postgres']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, '001_core.sql'), 'CREATE TABLE core_record (id TEXT);\n');
  writeFileSync(join(root, 'pii/001_pii.sql'), 'CREATE TABLE pii_record (id TEXT);\n');
  writeFileSync(join(root, 'admin/001_admin.sql'), 'CREATE TABLE admin_record (id TEXT);\n');
  writeFileSync(
    join(root, 'external/postgres/001_external.sql'),
    'CREATE TABLE external_record (id TEXT);\n'
  );
  writeFileSync(
    join(root, 'external/postgres/002_external_durable_pii.sql'),
    'CREATE TABLE external_pii_record (id TEXT);\n'
  );
  return root;
}

function managedCoreMigrations(): string {
  const root = mkdtempSync(join(tmpdir(), 'authrim-managed-release-manifest-'));
  temporaryDirectories.push(root);
  for (const directory of [
    'admin',
    'control',
    'lookup',
    'pii',
    'plugin-runner',
    'external/postgres',
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(
    join(root, '001_0_4_0_core_baseline.sql'),
    'CREATE TABLE core_record (id TEXT PRIMARY KEY);\n'
  );
  return root;
}

function lock(d1: AuthrimLock['d1']): AuthrimLock {
  return AuthrimLockSchema.parse({
    version: '1.0.0',
    createdAt: '2026-07-21T00:00:00.000Z',
    env: 'test',
    d1,
    kv: {},
  });
}

describe('release migration manifests', () => {
  it('separates a series fresh baseline from patch upgrade deltas', () => {
    const migrationsRoot = managedCoreMigrations();
    const baseline = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '0.4.0',
    });
    expect(baseline.freshInstallBaseline).toEqual({ productVersion: '0.4.0' });
    expect(baseline.upgradePaths).toBeUndefined();
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.0.json'), baseline);
    writeFileSync(
      join(migrationsRoot, '002_add_name.sql'),
      'ALTER TABLE core_record ADD COLUMN name TEXT;\n'
    );

    const patch = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '0.4.1',
      previousManifest: baseline,
      previousManifests: [baseline],
    });
    expect(patch.freshInstallBaseline).toEqual({ productVersion: '0.4.0' });
    expect(
      patch.streams.find((stream) => stream.id === 'd1-core')?.files.map((file) => file.path)
    ).toEqual(['001_0_4_0_core_baseline.sql', '002_add_name.sql']);
    expect(
      patch.upgradePaths?.[0]?.streams
        .find((stream) => stream.id === 'd1-core')
        ?.files.map((file) => file.path)
    ).toEqual(['002_add_name.sql']);
  });

  it('keeps an unpublished initial baseline editable through semantic regeneration', () => {
    const migrationsRoot = managedCoreMigrations();
    const baseline = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '0.4.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.0.json'), baseline);
    writeFileSync(
      join(migrationsRoot, '002_unpublished_change.sql'),
      'ALTER TABLE core_record ADD COLUMN label TEXT;\n'
    );

    expect(() =>
      generateReleaseMigrationManifest({
        migrationsRoot,
        productVersion: '0.4.0',
        previousManifest: baseline,
        previousManifests: [baseline],
      })
    ).toThrow('initial_fresh_baseline_regeneration_required:0.4.0');
    expect(
      generateReleaseMigrationManifest({
        migrationsRoot,
        productVersion: '0.4.0',
        previousManifest: baseline,
        previousManifests: [baseline],
        semanticBaselineSource: true,
      })
        .streams.find((stream) => stream.id === 'd1-core')
        ?.files.map((file) => file.path)
    ).toEqual(['001_0_4_0_core_baseline.sql', '002_unpublished_change.sql']);
  });

  it('retains published legacy SQL without reapplying it after a semantic baseline exists', () => {
    const migrationsRoot = managedCoreMigrations();
    const baseline = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '0.4.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.0.json'), baseline);
    const legacyPath = join(migrationsRoot, '001_published_legacy.sql');
    writeFileSync(legacyPath, 'CREATE TABLE legacy_record (id TEXT PRIMARY KEY);\n');
    const baselineFile = baseline.streams.find((stream) => stream.id === 'd1-core')!.files[0]!;
    writeFileSync(
      join(migrationsRoot, 'semantic-baseline.evidence.json'),
      `${JSON.stringify({
        formatVersion: 1,
        productVersion: '0.4.0',
        compatibility: 'fresh_install_only',
        streams: [
          {
            id: 'd1-core',
            dialect: 'sqlite',
            path: baselineFile.path,
            checksum: baselineFile.checksum,
            schemaChecksum: 'a'.repeat(64),
            seedChecksum: 'b'.repeat(64),
            objectCount: 1,
            generatedFrom: [
              {
                path: '001_published_legacy.sql',
                checksum: calculateReleaseMigrationChecksum(legacyPath, 'sqlite'),
              },
            ],
          },
        ],
      })}\n`
    );

    const normal = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '0.4.0',
      previousManifest: baseline,
      previousManifests: [baseline],
    });
    expect(normal.streams.find((stream) => stream.id === 'd1-core')?.files).toEqual(
      baseline.streams.find((stream) => stream.id === 'd1-core')?.files
    );
    expect(
      generateReleaseMigrationManifest({
        migrationsRoot,
        productVersion: '0.4.0',
        previousManifest: baseline,
        previousManifests: [baseline],
        semanticBaselineSource: true,
      })
        .streams.find((stream) => stream.id === 'd1-core')
        ?.files.map((file) => file.path)
    ).toEqual(['001_0_4_0_core_baseline.sql']);
  });

  it('resolves sequential deltas for upgrades and never applies a new baseline to an existing DB', () => {
    const stream = (
      files: Array<{ path: string; checksum: string }>
    ): ReleaseMigrationManifest['streams'][number] => ({
      id: 'd1-core',
      dialect: 'sqlite',
      logicalRoles: ['core'],
      files,
    });
    const baseline040 = { path: '001_0_4_0_core_baseline.sql', checksum: 'a'.repeat(64) };
    const delta041 = { path: '002_0_4_1_core_delta.sql', checksum: 'b'.repeat(64) };
    const delta042 = { path: '003_0_4_2_core_delta.sql', checksum: 'c'.repeat(64) };
    const baseline050 = { path: '001_0_5_0_core_baseline.sql', checksum: 'd'.repeat(64) };
    const bridge050 = { path: '004_0_5_0_core_delta.sql', checksum: 'e'.repeat(64) };
    const release040 = ReleaseMigrationManifestSchema.parse({
      formatVersion: 1,
      productVersion: '0.4.0',
      freshInstallBaseline: { productVersion: '0.4.0' },
      streams: [stream([baseline040])],
    });
    const release041 = ReleaseMigrationManifestSchema.parse({
      formatVersion: 1,
      productVersion: '0.4.1',
      freshInstallBaseline: { productVersion: '0.4.0' },
      streams: [stream([baseline040, delta041])],
      upgradePaths: [{ fromProductVersion: '0.4.0', kind: 'delta', streams: [stream([delta041])] }],
    });
    const release042 = ReleaseMigrationManifestSchema.parse({
      formatVersion: 1,
      productVersion: '0.4.2',
      freshInstallBaseline: { productVersion: '0.4.0' },
      streams: [stream([baseline040, delta041, delta042])],
      upgradePaths: [{ fromProductVersion: '0.4.1', kind: 'delta', streams: [stream([delta042])] }],
    });
    const release050 = ReleaseMigrationManifestSchema.parse({
      formatVersion: 1,
      productVersion: '0.5.0',
      freshInstallBaseline: { productVersion: '0.5.0' },
      streams: [stream([baseline050])],
      upgradePaths: [
        { fromProductVersion: '0.4.2', kind: 'bridge', streams: [stream([bridge050])] },
      ],
    });

    expect(
      resolveReleaseMigrationExecutionManifest({ targetManifest: release050 }).streams[0]?.files
    ).toEqual([baseline050]);
    expect(
      resolveReleaseMigrationExecutionManifest({
        targetManifest: release050,
        installedProductVersion: '0.4.0',
        availableManifests: [release040, release041, release042, release050],
      }).streams[0]?.files.map((file) => file.path)
    ).toEqual(['002_0_4_1_core_delta.sql', '003_0_4_2_core_delta.sql', '004_0_5_0_core_delta.sql']);
    const artifact = buildReleaseMigrationArtifactManifest({
      targetManifest: release050,
      installedProductVersion: '0.4.0',
      availableManifests: [release040, release041, release042, release050],
    });
    expect(artifact.streams[0]?.files).toEqual([baseline050]);
    expect(
      artifact.upgradePaths
        ?.find((path) => path.fromProductVersion === '0.4.0')
        ?.streams[0]?.files.map((file) => file.path)
    ).toEqual(['002_0_4_1_core_delta.sql', '003_0_4_2_core_delta.sql', '004_0_5_0_core_delta.sql']);
    expect(() =>
      resolveReleaseMigrationExecutionManifest({
        targetManifest: release050,
        installedProductVersion: '0.3.4',
        availableManifests: [release040, release041, release042, release050],
      })
    ).toThrow('release_upgrade_path_not_found:0.3.4:0.5.0');
  });

  it('retains superseded draft paths as accepted history without executing their SQL', () => {
    const baseline = { path: '001_0_4_0_core_baseline.sql', checksum: 'a'.repeat(64) };
    const draft = { path: '002_add_name.sql', checksum: 'b'.repeat(64) };
    const delta = {
      path: '002_0_4_1_core_delta.sql',
      checksum: 'c'.repeat(64),
      supersedes: [draft],
    };
    const stream = (files: ReleaseMigrationManifest['streams'][number]['files']) => ({
      id: 'd1-core',
      dialect: 'sqlite' as const,
      logicalRoles: ['core'],
      files,
    });
    const release = ReleaseMigrationManifestSchema.parse({
      formatVersion: 1,
      productVersion: '0.4.1',
      freshInstallBaseline: { productVersion: '0.4.0' },
      streams: [stream([baseline, delta])],
      upgradePaths: [{ fromProductVersion: '0.4.0', kind: 'delta', streams: [stream([delta])] }],
    });
    const future = ReleaseMigrationManifestSchema.parse({
      formatVersion: 1,
      productVersion: '0.4.2',
      streams: [stream([{ path: '003_0_4_2_core_delta.sql', checksum: 'd'.repeat(64) }])],
    });

    const artifact = buildReleaseMigrationArtifactManifest({
      targetManifest: release,
      installedProductVersion: '0.4.0',
      availableManifests: [release, future],
    });

    expect(artifact.acceptedMigrationHistory?.[0]?.files).toEqual(
      expect.arrayContaining([baseline, draft, delta])
    );
    expect(artifact.acceptedMigrationHistory?.[0]?.files).toHaveLength(3);
    expect(
      artifact.acceptedMigrationHistory?.[0]?.files.some(
        (file) => file.path === '003_0_4_2_core_delta.sql'
      )
    ).toBe(false);
    expect(
      artifact.upgradePaths?.find((path) => path.fromProductVersion === '0.4.0')?.streams[0]?.files
    ).toEqual([delta]);
  });

  it('validates executable SQL without requiring superseded accepted-history files', () => {
    const root = mkdtempSync(join(tmpdir(), 'authrim-release-history-'));
    temporaryDirectories.push(root);
    const sql = 'CREATE TABLE example (id TEXT PRIMARY KEY);\n';
    const path = join(root, '001_0_4_0_core_baseline.sql');
    writeFileSync(path, sql);
    const baseline = {
      path: '001_0_4_0_core_baseline.sql',
      checksum: calculateReleaseMigrationChecksum(path, 'sqlite'),
    };
    const stream = (files: ReleaseMigrationManifest['streams'][number]['files']) => ({
      id: 'd1-core',
      dialect: 'sqlite' as const,
      logicalRoles: ['core'],
      files,
    });
    const manifest = ReleaseMigrationManifestSchema.parse({
      formatVersion: 1,
      productVersion: '0.4.0',
      freshInstallBaseline: { productVersion: '0.4.0' },
      streams: [stream([baseline])],
      acceptedMigrationHistory: [
        stream([{ path: '002_unpublished_source.sql', checksum: 'b'.repeat(64) }]),
      ],
    });

    expect(() => validateReleaseMigrationManifestFiles(root, manifest)).not.toThrow();
    expect(() =>
      validateReleaseMigrationManifestFiles(root, {
        ...manifest,
        acceptedMigrationHistory: [stream([{ ...baseline, checksum: 'c'.repeat(64) }])],
      })
    ).toThrow('Release migration history conflicts');
  });

  it('preserves prior per-target migration evidence when recording an upgrade delta', () => {
    const targetId = 'd1:core-id:d1-core';
    const initial = lock({ DB: { id: 'core-id', name: 'core' } });
    initial.schemaTargets = {
      [targetId]: {
        productVersion: '0.4.0',
        manifestChecksum: 'a'.repeat(64),
        streamId: 'd1-core',
        files: [{ path: '001_0_4_0_core_baseline.sql', checksum: 'b'.repeat(64) }],
        appliedBy: 'automatic',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    };
    const updated = withSchemaTargetStates(initial, {
      targetIds: [targetId],
      manualTargetIds: new Set(),
      productVersion: '0.4.1',
      manifestChecksum: 'c'.repeat(64),
      targetStreamIds: new Map([[targetId, 'd1-core']]),
      manifest: ReleaseMigrationManifestSchema.parse({
        formatVersion: 1,
        productVersion: '0.4.1',
        streams: [
          {
            id: 'd1-core',
            dialect: 'sqlite',
            logicalRoles: ['core'],
            files: [{ path: '002_0_4_1_core_delta.sql', checksum: 'd'.repeat(64) }],
          },
        ],
      }),
      preserveExistingFiles: true,
    });

    expect(updated.schemaTargets?.[targetId]?.files.map((file) => file.path)).toEqual([
      '001_0_4_0_core_baseline.sql',
      '002_0_4_1_core_delta.sql',
    ]);
  });

  it('orders stable semantic product versions above prereleases', () => {
    expect(compareProductVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareProductVersions('1.1.0', '1.1.0-rc.2')).toBeGreaterThan(0);
    expect(compareProductVersions('1.1.0-rc.10', '1.1.0-rc.2')).toBeGreaterThan(0);
    expect(compareProductVersions('1.1.0-1', '1.1.0-alpha')).toBeLessThan(0);
    expect(compareProductVersions('1.1.0-alpha', '1.1.0-alpha.1')).toBeLessThan(0);
  });

  it('enforces the root package version as the release authority', () => {
    expect(() => assertReleaseVersionMatchesRoot('1.1.0', '1.0.0')).toThrow(
      'Release version must match root package.json 1.0.0: received 1.1.0'
    );
    expect(() => assertReleaseVersionMatchesRoot('1.0.0', '1.0.0')).not.toThrow();
    expect(() => assertProductVersionNotBehindPublished('1.0.0', '1.1.0')).toThrow(
      'product_version_behind_latest_release:1.0.0:1.1.0'
    );
    expect(() => assertProductVersionNotBehindPublished('1.1.0', '1.1.0')).not.toThrow();
  });

  it('rejects duplicate streams and migration paths outside their stream directory', () => {
    const stream = {
      id: 'd1-core',
      dialect: 'sqlite' as const,
      logicalRoles: ['core'],
      files: [{ path: '../escape.sql', checksum: 'a'.repeat(64) }],
    };
    expect(() =>
      ReleaseMigrationManifestSchema.parse({
        formatVersion: 1,
        productVersion: '1.0.0',
        streams: [stream, stream],
      })
    ).toThrow();
  });

  it('rejects a fresh baseline from another release series', () => {
    expect(() =>
      ReleaseMigrationManifestSchema.parse({
        formatVersion: 1,
        productVersion: '1.2.1',
        freshInstallBaseline: { productVersion: '1.1.0' },
        streams: [],
      })
    ).toThrow('Fresh-install baseline must be the major/minor boundary');
  });

  it('rejects migration files whose manifest order differs from execution order', () => {
    expect(() =>
      ReleaseMigrationManifestSchema.parse({
        formatVersion: 1,
        productVersion: '1.0.0',
        streams: [
          {
            id: 'd1-control',
            dialect: 'sqlite',
            logicalRoles: ['control'],
            files: [
              { path: '002_second.sql', checksum: 'b'.repeat(64) },
              { path: '001_first.sql', checksum: 'a'.repeat(64) },
            ],
          },
        ],
      })
    ).toThrow('Migration paths must be in strict lexicographic execution order');
  });

  it('requires an explicit exact Worker compatibility contract for database-only updates', () => {
    const manifest = ReleaseMigrationManifestSchema.parse({
      formatVersion: 1,
      productVersion: '1.1.0',
      rollout: {
        databaseExecution: 'setup_then_control',
        workerActivation: 'after_required_databases',
        adminMutationMode: 'read_only',
        databaseOnly: { compatibleWorkerVersions: ['1.0.0'] },
      },
      streams: [],
    });

    expect(() => assertDatabaseOnlyWorkerCompatibility(manifest, '1.0.0')).not.toThrow();
    expect(() => assertDatabaseOnlyWorkerCompatibility(manifest, '0.9.0')).toThrow(
      'database_only_worker_version_incompatible:0.9.0:1.1.0'
    );
    expect(() =>
      assertDatabaseOnlyWorkerCompatibility(
        { ...manifest, rollout: { ...manifest.rollout, databaseOnly: undefined } },
        '1.0.0'
      )
    ).toThrow('database_only_worker_version_incompatible:1.0.0:1.1.0');
    expect(() =>
      ReleaseMigrationManifestSchema.parse({
        ...manifest,
        rollout: {
          ...manifest.rollout,
          databaseOnly: { compatibleWorkerVersions: ['1.0.0', '1.0.0'] },
        },
      })
    ).toThrow();
  });

  it('generates cumulative checksummed streams and preserves published supersedes metadata', () => {
    const migrationsRoot = temporaryMigrations();
    const initial = generateReleaseMigrationManifest({ migrationsRoot, productVersion: '1.0.0' });
    const core = initial.streams.find((stream) => stream.id === 'd1-core');
    expect(core?.files).toHaveLength(1);
    expect(core?.files[0].checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(initial.rollout).toEqual({
      databaseExecution: 'setup_then_control',
      workerActivation: 'after_required_databases',
      adminMutationMode: 'read_only',
    });
    expect(initial.databaseCompatibility).toBe('fresh_install_only');

    const previous: ReleaseMigrationManifest = {
      ...initial,
      streams: initial.streams.map((stream) =>
        stream.id === 'd1-core'
          ? {
              ...stream,
              files: stream.files.map((file) => ({
                ...file,
                supersedes: [{ path: '001_draft.sql', checksum: 'a'.repeat(64) }],
              })),
            }
          : stream
      ),
    };
    const next = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.1.0',
      previousManifest: previous,
    });
    expect(next.streams.find((stream) => stream.id === 'd1-core')?.files[0].supersedes).toEqual([
      { path: '001_draft.sql', checksum: 'a'.repeat(64) },
    ]);
    expect(next.databaseCompatibility).toBe('fresh_and_forward');
  });

  it('rejects pre-1.0 database upgrades unless every target already has the exact baseline', () => {
    const migrationsRoot = temporaryMigrations();
    const manifest = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '0.9.0',
    });
    const manifestChecksum = calculateReleaseManifestChecksum(manifest);

    expect(() => assertReleaseDatabaseCompatibility({ manifest, manifestChecksum })).not.toThrow();
    expect(() =>
      assertReleaseDatabaseCompatibility({
        manifest,
        manifestChecksum,
        installedProductVersion: '0.8.0',
        installedSchemaManifestChecksums: [manifestChecksum],
      })
    ).toThrow('fresh_install_required:0.8.0:0.9.0');
    expect(() =>
      assertReleaseDatabaseCompatibility({
        manifest,
        manifestChecksum,
        installedProductVersion: '0.9.0',
        installedSchemaManifestChecksums: [manifestChecksum, manifestChecksum],
      })
    ).not.toThrow();
    expect(() =>
      assertReleaseDatabaseCompatibility({
        manifest,
        manifestChecksum,
        installedProductVersion: '0.9.0',
        installedSchemaManifestChecksums: ['a'.repeat(64)],
      })
    ).toThrow('fresh_install_required:0.9.0:0.9.0');
  });

  it('allows only exact-prefix migration additions to a same-version development draft', () => {
    const migrationsRoot = temporaryMigrations();
    const previous = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '0.9.0',
    });
    const previousChecksum = calculateReleaseManifestChecksum(previous);
    const previousCoreFiles = previous.streams.find((stream) => stream.id === 'd1-core')!.files;
    writeFileSync(
      join(migrationsRoot, '002_core_append.sql'),
      'ALTER TABLE core_record ADD value TEXT;\n'
    );
    const current = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '0.9.0',
    });
    const currentChecksum = calculateReleaseManifestChecksum(current);
    const targetId = 'd1:core-id:d1-core';
    const installedSchemaTargets: NonNullable<AuthrimLock['schemaTargets']> = {
      [targetId]: {
        productVersion: '0.9.0',
        manifestChecksum: previousChecksum,
        streamId: 'd1-core',
        files: previousCoreFiles.map(({ path, checksum }) => ({ path, checksum })),
        appliedBy: 'automatic',
        updatedAt: '2026-08-31T00:00:00.000Z',
      },
    };
    const compatibilityInput = {
      installedProductVersion: '0.9.0',
      installedSchemaManifestChecksums: [previousChecksum],
      installedSchemaTargets,
      currentTargets: [{ id: targetId, streamId: 'd1-core' }],
      targetManifestIsDraft: true,
    } as const;

    expect(() =>
      assertReleaseDatabaseCompatibility({
        ...compatibilityInput,
        manifest: current,
        manifestChecksum: currentChecksum,
      })
    ).not.toThrow();

    const changed = structuredClone(current);
    changed.streams.find((stream) => stream.id === 'd1-core')!.files[0]!.checksum = 'f'.repeat(64);
    expect(() =>
      assertReleaseDatabaseCompatibility({
        ...compatibilityInput,
        manifest: changed,
        manifestChecksum: calculateReleaseManifestChecksum(changed),
      })
    ).toThrow('fresh_install_required:0.9.0:0.9.0');

    const removed = structuredClone(current);
    removed.streams.find((stream) => stream.id === 'd1-core')!.files = [];
    expect(() =>
      assertReleaseDatabaseCompatibility({
        ...compatibilityInput,
        manifest: removed,
        manifestChecksum: calculateReleaseManifestChecksum(removed),
      })
    ).toThrow('fresh_install_required:0.9.0:0.9.0');

    expect(() =>
      assertReleaseDatabaseCompatibility({
        ...compatibilityInput,
        manifest: current,
        manifestChecksum: currentChecksum,
        targetManifestIsDraft: false,
      })
    ).toThrow('fresh_install_required:0.9.0:0.9.0');
  });

  it('preserves the minimum product version when regenerating the published version', () => {
    const migrationsRoot = temporaryMigrations();
    const published = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.1.0',
      minimumProductVersion: '1.0.0',
    });

    const regenerated = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.1.0',
      previousManifest: published,
    });

    expect(regenerated.minimumProductVersion).toBe('1.0.0');
  });

  it('consolidates only files added after the previous published manifest', () => {
    const migrationsRoot = temporaryMigrations();
    const previous = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.0.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/1.0.0.json'), previous);
    writeFileSync(join(migrationsRoot, '002_draft_a.sql'), 'CREATE TABLE draft_a (id TEXT);\n');
    writeFileSync(join(migrationsRoot, '003_draft_b.sql'), 'CREATE TABLE draft_b (id TEXT);\n');

    prepareRelease({
      migrationsRoot,
      version: '1.1.0',
      minimumVersion: '1.0.0',
      write: true,
    });

    const released = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.1.0',
      previousManifest: previous,
    });
    expect(
      released.streams.find((stream) => stream.id === 'd1-core')?.files.map((file) => file.path)
    ).toEqual(['001_core.sql', '002_1_1_0_core_delta.sql']);
    const releaseManifest = JSON.parse(
      readFileSync(join(migrationsRoot, 'releases/1.1.0.json'), 'utf-8')
    ) as ReleaseMigrationManifest;
    expect(
      releaseManifest.streams.find((stream) => stream.id === 'd1-core')?.files[1].supersedes
    ).toEqual([
      expect.objectContaining({ path: '002_draft_a.sql' }),
      expect.objectContaining({ path: '003_draft_b.sql' }),
    ]);
    expect(existsSync(join(migrationsRoot, 'releases/.1.1.0.prepare-state'))).toBe(false);
  });

  it('increments canonical delta numbers across patch releases in a managed series', () => {
    const migrationsRoot = managedCoreMigrations();
    const baseline = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '0.4.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.0.json'), baseline);
    writeFileSync(
      join(migrationsRoot, '002_add_label.sql'),
      'ALTER TABLE core_record ADD COLUMN label TEXT;\n'
    );
    writeFileSync(
      join(migrationsRoot, '003_add_label_index.sql'),
      'CREATE INDEX core_record_label_idx ON core_record(label);\n'
    );

    prepareRelease({ migrationsRoot, version: '0.4.1', write: true });
    expect(existsSync(join(migrationsRoot, '002_0_4_1_core_delta.sql'))).toBe(true);
    const release041 = readReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.1.json'));
    expect(
      release041.streams
        .find((stream) => stream.id === 'd1-core')
        ?.files.find((file) => file.path === '002_0_4_1_core_delta.sql')?.semanticEvidence
    ).toMatchObject({ objectCount: 2 });

    writeFileSync(
      join(migrationsRoot, '003_add_state.sql'),
      "ALTER TABLE core_record ADD COLUMN state TEXT NOT NULL DEFAULT 'active';\n"
    );
    writeFileSync(
      join(migrationsRoot, '004_add_state_index.sql'),
      'CREATE INDEX core_record_state_idx ON core_record(state);\n'
    );

    prepareRelease({ migrationsRoot, version: '0.4.2', write: true });
    expect(existsSync(join(migrationsRoot, '003_0_4_2_core_delta.sql'))).toBe(true);
    const release042 = readReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.2.json'));
    expect(
      release042.streams.find((stream) => stream.id === 'd1-core')?.files.map((file) => file.path)
    ).toEqual([
      '001_0_4_0_core_baseline.sql',
      '002_0_4_1_core_delta.sql',
      '003_0_4_2_core_delta.sql',
    ]);
    expect(
      release042.upgradePaths?.[0]?.streams
        .find((stream) => stream.id === 'd1-core')
        ?.files.map((file) => file.path)
    ).toEqual(['003_0_4_2_core_delta.sql']);

    prepareRelease({ migrationsRoot, version: '0.4.2', write: true });
    expect(readReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.2.json'))).toEqual(
      release042
    );
  });

  it('semantically verifies an already-canonical single patch delta without deleting it', () => {
    const migrationsRoot = managedCoreMigrations();
    const baseline = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '0.4.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.0.json'), baseline);
    const deltaPath = join(migrationsRoot, '002_0_4_1_core_delta.sql');
    writeFileSync(deltaPath, 'ALTER TABLE core_record ADD COLUMN label TEXT;\n');

    prepareRelease({ migrationsRoot, version: '0.4.1', write: true });

    expect(existsSync(deltaPath)).toBe(true);
    const release = readReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.1.json'));
    const delta = release.upgradePaths?.[0]?.streams
      .find((stream) => stream.id === 'd1-core')
      ?.files.at(0);
    expect(delta).toMatchObject({
      path: '002_0_4_1_core_delta.sql',
      semanticEvidence: { objectCount: 1 },
    });
    expect(delta?.supersedes).toBeUndefined();
  });

  it('resumes release preparation from its durable journal after interruption', () => {
    const migrationsRoot = temporaryMigrations();
    const previous = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.0.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/1.0.0.json'), previous);
    const draftA = 'CREATE TABLE interrupted_a (id TEXT);\n';
    const draftB = 'CREATE TABLE interrupted_b (id TEXT);\n';
    writeFileSync(join(migrationsRoot, '002_interrupted_a.sql'), draftA);
    writeFileSync(join(migrationsRoot, '003_interrupted_b.sql'), draftB);
    prepareRelease({ migrationsRoot, version: '1.1.0', write: true });

    const releasePath = join(migrationsRoot, 'releases/1.1.0.json');
    const manifest = JSON.parse(readFileSync(releasePath, 'utf-8')) as ReleaseMigrationManifest;
    const bundle = manifest.streams
      .find((stream) => stream.id === 'd1-core')
      ?.files.find((file) => file.supersedes?.length);
    expect(bundle?.supersedes).toHaveLength(2);
    if (!bundle?.supersedes) throw new Error('Expected consolidated core bundle');

    rmSync(join(migrationsRoot, bundle.path));
    rmSync(releasePath);
    rmSync(join(migrationsRoot, 'release-manifest.draft.json'));
    writeFileSync(join(migrationsRoot, '002_interrupted_a.sql'), draftA);
    writeFileSync(join(migrationsRoot, '003_interrupted_b.sql'), draftB);
    const journalPath = join(migrationsRoot, 'releases/.1.1.0.prepare-state');
    writeFileSync(
      journalPath,
      `${JSON.stringify(
        {
          formatVersion: 1,
          productVersion: '1.1.0',
          manifest,
          operations: [
            {
              streamId: 'd1-core',
              dialect: 'sqlite',
              sources: bundle.supersedes,
              bundlePath: bundle.path,
              bundleChecksum: bundle.checksum,
            },
          ],
        },
        null,
        2
      )}\n`
    );

    prepareRelease({ migrationsRoot, version: '1.1.0', write: true });

    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(join(migrationsRoot, bundle.path))).toBe(true);
    expect(existsSync(releasePath)).toBe(true);
    expect(existsSync(join(migrationsRoot, 'release-manifest.draft.json'))).toBe(true);
    expect(existsSync(join(migrationsRoot, '002_interrupted_a.sql'))).toBe(false);
    expect(existsSync(join(migrationsRoot, '003_interrupted_b.sql'))).toBe(false);
  });

  it('resumes a major/minor bridge whose delta is outside the fresh plan', () => {
    const migrationsRoot = managedCoreMigrations();
    const previous = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '0.4.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.0.json'), previous);
    writeFileSync(
      join(migrationsRoot, '001_0_5_0_core_baseline.sql'),
      'CREATE TABLE core_record (id TEXT PRIMARY KEY, label TEXT);\n'
    );
    const bridgeSql = 'ALTER TABLE core_record ADD COLUMN label TEXT;\n';
    writeFileSync(join(migrationsRoot, '002_bridge_to_0_5.sql'), bridgeSql);
    prepareRelease({ migrationsRoot, version: '0.5.0', write: true });

    const releasePath = join(migrationsRoot, 'releases/0.5.0.json');
    const manifest = readReleaseMigrationManifest(releasePath);
    const bundle = manifest.upgradePaths?.[0]?.streams
      .find((stream) => stream.id === 'd1-core')
      ?.files.at(0);
    expect(bundle?.path).toBe('002_0_5_0_core_delta.sql');
    expect(bundle?.semanticEvidence).toBeDefined();
    if (!bundle?.supersedes) throw new Error('Expected consolidated bridge provenance');

    rmSync(join(migrationsRoot, bundle.path));
    rmSync(releasePath);
    rmSync(join(migrationsRoot, 'release-manifest.draft.json'));
    writeFileSync(join(migrationsRoot, '002_bridge_to_0_5.sql'), bridgeSql);
    const journalPath = join(migrationsRoot, 'releases/.0.5.0.prepare-state');
    writeFileSync(
      journalPath,
      `${JSON.stringify(
        {
          formatVersion: 1,
          productVersion: '0.5.0',
          manifest,
          operations: [
            {
              streamId: 'd1-core',
              dialect: 'sqlite',
              sources: bundle.supersedes,
              bundlePath: bundle.path,
              bundleChecksum: bundle.checksum,
            },
          ],
        },
        null,
        2
      )}\n`
    );

    prepareRelease({ migrationsRoot, version: '0.5.0', write: true });
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(join(migrationsRoot, bundle.path))).toBe(true);
    expect(readReleaseMigrationManifest(releasePath)).toEqual(manifest);
  });

  it('uses the remote-main tag as the publication boundary', () => {
    const migrationsRoot = temporaryMigrations();
    const manifest = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.0.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/1.0.0.json'), manifest);
    expect(() =>
      assertProductVersionOpenForNewMigrations(migrationsRoot, '1.0.0', {
        isVersionPublished: () => true,
      })
    ).toThrow('product_version_already_published:1.0.0');
    expect(() =>
      assertProductVersionOpenForNewMigrations(migrationsRoot, '1.0.0', {
        isVersionPublished: () => false,
      })
    ).not.toThrow();

    writeFileSync(join(migrationsRoot, '002_too_late.sql'), 'CREATE TABLE too_late (id TEXT);\n');
    expect(() =>
      syncDraftReleaseMigrationManifest({ migrationsRoot, productVersion: '1.0.0' })
    ).not.toThrow();
  });

  it('does not treat a local-only tag on remote main as published', () => {
    const root = mkdtempSync(join(tmpdir(), 'authrim-remote-tag-boundary-'));
    temporaryDirectories.push(root);
    const remote = join(root, 'origin.git');
    const repository = join(root, 'repository');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    execFileSync('git', ['init', '--initial-branch=main', repository], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'migration-test@authrim.invalid'], {
      cwd: repository,
    });
    execFileSync('git', ['config', 'user.name', 'Authrim Migration Test'], { cwd: repository });
    writeFileSync(join(repository, 'README.md'), 'test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repository });
    execFileSync('git', ['commit', '-m', 'test'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repository });
    execFileSync('git', ['push', '--set-upstream', 'origin', 'main'], {
      cwd: repository,
      stdio: 'ignore',
    });
    execFileSync('git', ['tag', 'v0.4.0'], { cwd: repository });

    expect(
      isVersionPublishedOnRemoteMain({ repositoryRoot: repository, productVersion: '0.4.0' })
    ).toBe(false);

    execFileSync('git', ['push', 'origin', 'refs/tags/v0.4.0'], {
      cwd: repository,
      stdio: 'ignore',
    });
    expect(
      isVersionPublishedOnRemoteMain({ repositoryRoot: repository, productVersion: '0.4.0' })
    ).toBe(true);
  });

  it('compares published migration artifacts with their remote-main tag', () => {
    const root = mkdtempSync(join(tmpdir(), 'authrim-published-artifact-boundary-'));
    temporaryDirectories.push(root);
    const remote = join(root, 'origin.git');
    const repository = join(root, 'repository');
    const migrationsRoot = join(repository, 'migrations');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    execFileSync('git', ['init', '--initial-branch=main', repository], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'migration-test@authrim.invalid'], {
      cwd: repository,
    });
    execFileSync('git', ['config', 'user.name', 'Authrim Migration Test'], { cwd: repository });
    mkdirSync(join(migrationsRoot, 'releases'), { recursive: true });
    mkdirSync(join(migrationsRoot, 'evidence'), { recursive: true });
    const baselinePath = join(migrationsRoot, '001_0_4_0_core_baseline.sql');
    const baselineSql = 'CREATE TABLE core_record (id TEXT PRIMARY KEY);\n';
    writeFileSync(baselinePath, baselineSql);
    const manifestPath = join(migrationsRoot, 'releases/0.4.0.json');
    const manifest = ReleaseMigrationManifestSchema.parse({
      formatVersion: 1,
      productVersion: '0.4.0',
      databaseCompatibility: 'fresh_install_only',
      freshInstallBaseline: { productVersion: '0.4.0' },
      streams: [
        {
          id: 'd1-core',
          dialect: 'sqlite',
          logicalRoles: ['core'],
          files: [
            {
              path: '001_0_4_0_core_baseline.sql',
              checksum: calculateReleaseMigrationChecksum(baselinePath, 'sqlite'),
            },
          ],
        },
      ],
    });
    writeReleaseMigrationManifest(manifestPath, manifest);
    const evidencePath = join(migrationsRoot, 'evidence/0.4.0.json');
    writeFileSync(evidencePath, '{"formatVersion":1}\n');
    execFileSync('git', ['add', 'migrations'], { cwd: repository });
    execFileSync('git', ['commit', '-m', 'release 0.4.0 migrations'], {
      cwd: repository,
      stdio: 'ignore',
    });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repository });
    execFileSync('git', ['push', '--set-upstream', 'origin', 'main'], {
      cwd: repository,
      stdio: 'ignore',
    });
    execFileSync('git', ['tag', 'v0.4.0'], { cwd: repository });
    execFileSync('git', ['push', 'origin', 'refs/tags/v0.4.0'], {
      cwd: repository,
      stdio: 'ignore',
    });

    expect(() =>
      validateRemoteMainPublishedReleaseMigrationManifests({
        migrationsRoot,
        repositoryRoot: repository,
      })
    ).not.toThrow();

    writeFileSync(baselinePath, 'CREATE TABLE changed_record (id TEXT PRIMARY KEY);\n');
    const changedManifest = {
      ...manifest,
      streams: manifest.streams.map((stream) => ({
        ...stream,
        files: stream.files.map((file) => ({
          ...file,
          checksum: calculateReleaseMigrationChecksum(baselinePath, 'sqlite'),
        })),
      })),
    };
    writeReleaseMigrationManifest(manifestPath, changedManifest);
    expect(() =>
      validateRemoteMainPublishedReleaseMigrationManifests({
        migrationsRoot,
        repositoryRoot: repository,
      })
    ).toThrow('Published migration manifest changed since tag: 0.4.0');

    writeFileSync(baselinePath, baselineSql);
    writeReleaseMigrationManifest(manifestPath, manifest);
    rmSync(evidencePath);
    expect(() =>
      validateRemoteMainPublishedReleaseMigrationManifests({
        migrationsRoot,
        repositoryRoot: repository,
      })
    ).toThrow('Published migration evidence changed since tag: 0.4.0');
  });

  it('requires an owner-prepared baseline candidate before merging a boundary release to main', () => {
    const migrationsRoot = mkdtempSync(join(tmpdir(), 'authrim-main-release-check-'));
    temporaryDirectories.push(migrationsRoot);
    mkdirSync(join(migrationsRoot, 'releases'), { recursive: true });
    const baselinePath = '001_0_4_0_core_baseline.sql';
    const fullPath = join(migrationsRoot, baselinePath);
    writeFileSync(fullPath, 'CREATE TABLE core_record (id TEXT PRIMARY KEY);\n');
    const baseline = {
      path: baselinePath,
      checksum: calculateReleaseMigrationChecksum(fullPath, 'sqlite'),
    };
    const manifest = ReleaseMigrationManifestSchema.parse({
      formatVersion: 1,
      productVersion: '0.4.0',
      databaseCompatibility: 'fresh_install_only',
      freshInstallBaseline: { productVersion: '0.4.0' },
      streams: [{ id: 'd1-core', dialect: 'sqlite', logicalRoles: ['core'], files: [baseline] }],
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'release-manifest.draft.json'), manifest);
    expect(() =>
      validateReleaseCandidateForMain({ migrationsRoot, productVersion: '0.4.0' })
    ).toThrow('Release migration candidate is missing');

    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.0.json'), manifest);
    const evidence = `${JSON.stringify({
      formatVersion: 1,
      productVersion: '0.4.0',
      compatibility: 'fresh_install_only',
      streams: [
        {
          id: 'd1-core',
          dialect: 'sqlite',
          ...baseline,
          schemaChecksum: 'a'.repeat(64),
          seedChecksum: 'b'.repeat(64),
          objectCount: 1,
          generatedFrom: [baseline],
        },
      ],
    })}\n`;
    writeFileSync(join(migrationsRoot, 'semantic-baseline.evidence.json'), evidence);
    mkdirSync(join(migrationsRoot, 'evidence'), { recursive: true });
    writeFileSync(join(migrationsRoot, 'evidence/0.4.0.json'), evidence);
    expect(() =>
      validateReleaseCandidateForMain({ migrationsRoot, productVersion: '0.4.0' })
    ).not.toThrow();

    writeReleaseMigrationManifest(join(migrationsRoot, 'release-manifest.draft.json'), {
      ...manifest,
      rollout: {
        databaseExecution: 'setup_then_control',
        workerActivation: 'after_required_databases',
        adminMutationMode: 'available',
      },
    });
    expect(() =>
      validateReleaseCandidateForMain({ migrationsRoot, productVersion: '0.4.0' })
    ).toThrow('is not prepared from the current draft');
  });

  it('requires one canonical owner-prepared delta per changed stream for a main-bound patch', () => {
    const migrationsRoot = mkdtempSync(join(tmpdir(), 'authrim-main-patch-check-'));
    temporaryDirectories.push(migrationsRoot);
    mkdirSync(join(migrationsRoot, 'releases'), { recursive: true });
    const baselinePath = '001_0_4_0_core_baseline.sql';
    const deltaPath = '002_0_4_1_core_delta.sql';
    writeFileSync(join(migrationsRoot, baselinePath), 'CREATE TABLE core_record (id TEXT);\n');
    writeFileSync(
      join(migrationsRoot, deltaPath),
      'ALTER TABLE core_record ADD COLUMN name TEXT;\n'
    );
    const baseline = {
      path: baselinePath,
      checksum: calculateReleaseMigrationChecksum(join(migrationsRoot, baselinePath), 'sqlite'),
    };
    const delta = {
      path: deltaPath,
      checksum: calculateReleaseMigrationChecksum(join(migrationsRoot, deltaPath), 'sqlite'),
      semanticEvidence: {
        schemaChecksum: 'a'.repeat(64),
        seedChecksum: 'b'.repeat(64),
        objectCount: 1,
      },
    };
    const stream = (files: ReleaseMigrationManifest['streams'][number]['files']) => ({
      id: 'd1-core',
      dialect: 'sqlite' as const,
      logicalRoles: ['core'],
      files,
    });
    const baselineManifest = ReleaseMigrationManifestSchema.parse({
      formatVersion: 1,
      productVersion: '0.4.0',
      freshInstallBaseline: { productVersion: '0.4.0' },
      streams: [stream([baseline])],
    });
    const patchManifest = ReleaseMigrationManifestSchema.parse({
      formatVersion: 1,
      productVersion: '0.4.1',
      freshInstallBaseline: { productVersion: '0.4.0' },
      streams: [stream([baseline, delta])],
      upgradePaths: [{ fromProductVersion: '0.4.0', kind: 'delta', streams: [stream([delta])] }],
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.0.json'), baselineManifest);
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.1.json'), patchManifest);
    writeReleaseMigrationManifest(
      join(migrationsRoot, 'release-manifest.draft.json'),
      patchManifest
    );

    expect(() =>
      validateReleaseCandidateForMain({ migrationsRoot, productVersion: '0.4.1' })
    ).not.toThrow();

    const unconsolidated = {
      ...patchManifest,
      streams: [stream([baseline, { ...delta, path: '002_add_name.sql' }])],
      upgradePaths: [
        {
          fromProductVersion: '0.4.0',
          kind: 'delta' as const,
          streams: [stream([{ ...delta, path: '002_add_name.sql' }])],
        },
      ],
    };
    writeFileSync(
      join(migrationsRoot, '002_add_name.sql'),
      'ALTER TABLE core_record ADD COLUMN name TEXT;\n'
    );
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/0.4.1.json'), unconsolidated);
    writeReleaseMigrationManifest(
      join(migrationsRoot, 'release-manifest.draft.json'),
      unconsolidated
    );
    expect(() =>
      validateReleaseCandidateForMain({ migrationsRoot, productVersion: '0.4.1' })
    ).toThrow('delta is not canonical');
  });

  it('preserves an explicit database-only compatibility contract when refreshing a draft', () => {
    const migrationsRoot = temporaryMigrations();
    const draft = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.1.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'release-manifest.draft.json'), {
      ...draft,
      rollout: {
        ...draft.rollout!,
        databaseOnly: { compatibleWorkerVersions: ['1.0.0'] },
      },
    });
    writeFileSync(
      join(migrationsRoot, '002_next.sql'),
      'ALTER TABLE sample ADD COLUMN name TEXT;\n'
    );

    const refreshed = syncDraftReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.1.0',
    });

    expect(refreshed.manifest.rollout?.databaseOnly).toEqual({
      compatibleWorkerVersions: ['1.0.0'],
    });
  });

  it('does not rewrite an untagged release candidate while refreshing the draft', () => {
    const migrationsRoot = temporaryMigrations();
    const candidatePath = join(migrationsRoot, 'releases/1.1.0.json');
    const candidate = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.1.0',
    });
    writeReleaseMigrationManifest(candidatePath, candidate);
    writeFileSync(join(migrationsRoot, '002_next.sql'), 'CREATE TABLE next_record (id TEXT);\n');

    const refreshed = syncDraftReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.1.0',
    });

    expect(readReleaseMigrationManifest(candidatePath)).toEqual(candidate);
    expect(refreshed.manifest).not.toEqual(candidate);
    expect(refreshed.manifest.streams[0]?.files.map((file) => file.path)).toContain('002_next.sql');
    expect(
      loadTargetReleaseMigrationManifest({
        migrationsRoot,
        productVersion: '1.1.0',
        allowDraft: true,
      })
    ).toMatchObject({ draft: true, manifest: refreshed.manifest });
  });

  it('fails closed when a draft differs from the published manifest of the same version', () => {
    const migrationsRoot = temporaryMigrations();
    const published = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.0.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/1.0.0.json'), published);
    writeReleaseMigrationManifest(join(migrationsRoot, 'release-manifest.draft.json'), {
      ...published,
      streams: published.streams.map((stream) =>
        stream.id === 'd1-core'
          ? {
              ...stream,
              files: [...stream.files, { path: '999_divergent.sql', checksum: 'f'.repeat(64) }],
            }
          : stream
      ),
    });
    expect(() => discoverReleaseMigrationStream(migrationsRoot)).toThrow(
      'draft_manifest_diverges_from_published_version:1.0.0'
    );
    expect(() =>
      loadTargetReleaseMigrationManifest({
        migrationsRoot,
        productVersion: '1.0.0',
      })
    ).toThrow('draft_manifest_diverges_from_published_version:1.0.0');
  });

  it('validates every selected manifest stream before a release update', () => {
    const migrationsRoot = temporaryMigrations();
    const published = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.0.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/1.0.0.json'), published);
    writeFileSync(
      join(migrationsRoot, 'external/postgres/001_external.sql'),
      'CREATE TABLE changed_external_record (id TEXT);\n'
    );

    expect(() =>
      loadTargetReleaseMigrationManifest({ migrationsRoot, productVersion: '1.0.0' })
    ).toThrow('Release migration checksum changed: 1.0.0/external-postgres-core');
  });

  it('discovers the latest published manifest when the draft file is absent', () => {
    const migrationsRoot = temporaryMigrations();
    const published = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.0.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/1.0.0.json'), published);

    const discovered = discoverReleaseMigrationStream(migrationsRoot);
    expect(discovered).toMatchObject({ draft: false });
    expect(discovered?.manifest.productVersion).toBe('1.0.0');
    expect(discovered?.stream.id).toBe('d1-core');
  });

  it('blocks a new release while another version has an incomplete preparation journal', () => {
    const migrationsRoot = temporaryMigrations();
    mkdirSync(join(migrationsRoot, 'releases'), { recursive: true });
    writeFileSync(join(migrationsRoot, 'releases/.1.0.5.prepare-state'), '{}\n');

    expect(() => prepareRelease({ migrationsRoot, version: '1.1.0', write: true })).toThrow(
      'Another release preparation is incomplete'
    );
  });

  it('allows an untagged release candidate to be regenerated before publication', () => {
    const migrationsRoot = temporaryMigrations();
    const previous = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.1.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/1.1.0.json'), previous);
    writeFileSync(join(migrationsRoot, '002_draft_a.sql'), 'CREATE TABLE draft_a (id TEXT);\n');
    writeFileSync(join(migrationsRoot, '003_draft_b.sql'), 'CREATE TABLE draft_b (id TEXT);\n');

    expect(() => prepareRelease({ migrationsRoot, version: '1.1.0', write: true })).not.toThrow();
    expect(existsSync(join(migrationsRoot, '002_draft_a.sql'))).toBe(true);
    expect(existsSync(join(migrationsRoot, '003_draft_b.sql'))).toBe(true);
  });

  it('rejects published manifest filename/version mismatches and changed published SQL', () => {
    const migrationsRoot = temporaryMigrations();
    const manifest = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.0.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/1.0.0.json'), {
      ...manifest,
      productVersion: '1.1.0',
    });
    expect(() =>
      loadTargetReleaseMigrationManifest({ migrationsRoot, productVersion: '1.0.0' })
    ).toThrowError('release_migration_manifest_version_mismatch:1.0.0:1.1.0');

    rmSync(join(migrationsRoot, 'releases'), { recursive: true });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/1.0.0.json'), manifest);
    writeFileSync(join(migrationsRoot, '001_core.sql'), 'CREATE TABLE changed (id TEXT);\n');
    expect(() => validatePublishedReleaseMigrationManifests(migrationsRoot)).toThrow(
      'Published migration checksum changed'
    );
  });
});

describe('release migration topology', () => {
  it('expands shared, tenant-specific, and multi-shard D1 bindings from one logical manifest', () => {
    const config = createDefaultConfig('test');
    const targets = resolveReleaseMigrationTargets({
      config,
      lock: lock({
        DB: { id: 'db-core', name: 'core' },
        DB_PII: { id: 'db-pii', name: 'pii' },
        DB_ADMIN: { id: 'db-admin', name: 'admin' },
        CONTROL_DB: { id: 'db-control', name: 'control' },
        LOOKUP_DB: { id: 'db-lookup', name: 'lookup' },
        PLUGIN_RUNNER_DB: { id: 'db-plugin-runner', name: 'plugin-runner' },
        TEST_TDB_SLOT_0001_CORE: { id: 'tenant-core', name: 'tenant-core' },
        TEST_TDB_SLOT_0001_PII: { id: 'tenant-pii', name: 'tenant-pii' },
        TEST_TDB_ACME_CORE_S1: { id: 'tenant-core-s1', name: 'tenant-core-s1' },
      }),
    });

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: 'DB', streamId: 'd1-core', scope: 'deployment' }),
        expect.objectContaining({
          binding: 'CONTROL_DB',
          databaseId: 'db-control',
          streamId: 'd1-control',
          logicalRoles: ['control'],
        }),
        expect.objectContaining({
          binding: 'LOOKUP_DB',
          databaseId: 'db-lookup',
          streamId: 'd1-lookup',
          logicalRoles: ['lookup'],
        }),
        expect.objectContaining({
          binding: 'PLUGIN_RUNNER_DB',
          databaseId: 'db-plugin-runner',
          streamId: 'd1-plugin-runner',
          logicalRoles: ['plugin_runner'],
        }),
        expect.objectContaining({
          binding: 'TEST_TDB_SLOT_0001_CORE',
          streamId: 'd1-core',
          scope: 'tenant',
        }),
        expect.objectContaining({
          binding: 'TEST_TDB_ACME_CORE_S1',
          streamId: 'd1-core',
          shard: '1',
        }),
      ])
    );
  });

  it('keeps unsupported tenant database roles in inventory so release updates fail closed', () => {
    const config = createDefaultConfig('test');
    const targets = resolveReleaseMigrationTargets({
      config,
      lock: lock({
        TEST_TDB_ACME_AUDIT: { id: 'tenant-audit', name: 'tenant-audit' },
        TEST_TDB_ACME_CUSTOM_S2: { id: 'tenant-custom-s2', name: 'tenant-custom-s2' },
      }),
    });

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: 'TEST_TDB_ACME_AUDIT',
          streamId: null,
          blockedReason: 'release_migration_stream_not_available:tenant_audit',
        }),
        expect.objectContaining({
          binding: 'TEST_TDB_ACME_CUSTOM_S2',
          streamId: null,
          shard: '2',
          blockedReason: 'release_migration_stream_not_available:tenant_custom',
        }),
      ])
    );
  });

  it('keeps Core and PII as separate streams even if lock data points at one physical DB', () => {
    const config = createDefaultConfig('test');
    const targets = resolveReleaseMigrationTargets({
      config,
      lock: lock({
        DB: { id: 'single', name: 'single' },
        DB_PII: { id: 'single', name: 'single' },
      }),
    });
    expect(
      targets
        .filter((target) => ['DB', 'DB_PII'].includes(target.binding ?? ''))
        .map((target) => target.streamId)
    ).toEqual(expect.arrayContaining(['d1-core', 'd1-pii']));
  });

  it('does not activate user-store migration targets from Hyperdrive references alone', () => {
    const config = createDefaultConfig('test');
    config.profiles.references.hyperdrive = {
      'core-primary': { binding: 'HD_CORE', id: 'hd-core', driver: 'postgres' },
      'pii-primary': { binding: 'HD_PII', id: 'hd-pii', driver: 'postgres' },
    };
    const targets = resolveReleaseMigrationTargets({ config, lock: lock({}) });
    expect(targets.filter((target) => target.scope === 'external')).toEqual([]);
  });

  it('retains external database references only as fail-closed audit extension points', () => {
    const config = createDefaultConfig('test');
    config.profiles.references.hyperdrive = {
      shared: { binding: 'HD_SHARED', id: 'hd-shared', driver: 'postgres' },
    };
    config.profiles.seed.audit = [
      {
        id: 'custom:audit:shared-postgres',
        label: 'Shared PostgreSQL audit',
        primary: { type: 'postgres', connectionRef: 'shared' },
        archive: null,
      },
    ];
    const targets = resolveReleaseMigrationTargets({ config, lock: lock({}) });
    expect(targets.filter((target) => target.scope === 'external')).toEqual([
      expect.objectContaining({
        id: 'external:postgres:shared:audit',
        streamId: null,
        logicalRoles: ['audit'],
        automatic: false,
        blockedReason: 'release_migration_stream_not_available:postgres',
      }),
    ]);
  });

  it('does not treat audit extension points as tenant user-store placement choices', () => {
    const config = createDefaultConfig('test');
    config.profiles.references.hyperdrive = {
      'audit-a': { binding: 'HD_AUDIT_A', id: 'hd-audit-a', driver: 'postgres' },
    };
    config.profiles.seed.audit = [
      {
        id: 'tenant:audit:a',
        label: 'Tenant A audit export',
        primary: { type: 'postgres', connectionRef: 'audit-a' },
        archive: null,
      },
    ];

    const targets = resolveReleaseMigrationTargets({ config, lock: lock({}) });
    expect(targets.some((target) => target.logicalRoles.includes('core'))).toBe(false);
    expect(targets.some((target) => target.logicalRoles.includes('pii'))).toBe(false);
    expect(targets.some((target) => target.logicalRoles.includes('audit'))).toBe(true);
  });
});

describe('release schema update plans', () => {
  it('does not schedule database work for a Worker-only release', () => {
    const migrationsRoot = temporaryMigrations();
    const current = generateReleaseMigrationManifest({ migrationsRoot, productVersion: '1.0.0' });
    const target = { ...current, productVersion: '1.1.0' };
    const d1Target = {
      id: 'd1:core:d1-core',
      streamId: 'd1-core',
      driver: 'd1' as const,
      scope: 'deployment' as const,
      logicalRoles: ['core'],
      databaseName: 'core',
      automatic: true,
    };

    const plan = buildReleaseSchemaUpdatePlan({
      targetManifest: target,
      currentManifest: current,
      targets: [d1Target],
    });

    expect(plan.targets[0]).toMatchObject({ changedFiles: [], requiresAction: false });
    expect(plan.automaticTargets).toEqual([]);
    expect(
      getControlManagedReleaseStreamIds({ targetManifest: target, currentManifest: current })
    ).toEqual([]);
  });

  it('initializes a new database even when a synthetic release stream is empty', () => {
    const migrationsRoot = temporaryMigrations();
    const target = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.1.0',
    });
    target.streams = target.streams.map((stream) =>
      stream.id === 'd1-core' ? { ...stream, files: [] } : stream
    );
    const d1Target = {
      id: 'd1:new-core:d1-core',
      streamId: 'd1-core',
      driver: 'd1' as const,
      scope: 'deployment' as const,
      logicalRoles: ['core'],
      databaseName: 'new-core',
      automatic: true,
    };

    const plan = buildReleaseSchemaUpdatePlan({
      targetManifest: target,
      currentManifestForTarget: () => undefined,
      targets: [d1Target],
    });

    expect(plan.automaticTargets).toHaveLength(1);
    expect(plan.targets[0]).toMatchObject({ changedFiles: [], requiresAction: true });
  });

  it('fails closed instead of applying only upgrade deltas when target history is missing', () => {
    const migrationsRoot = temporaryMigrations();
    const target = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.1.0',
    });
    target.streams = target.streams.map((stream) =>
      stream.id === 'd1-core'
        ? { ...stream, files: [{ path: '002_1_1_0_core_delta.sql', checksum: 'a'.repeat(64) }] }
        : stream
    );
    const d1Target = {
      id: 'd1:unknown-core:d1-core',
      streamId: 'd1-core',
      driver: 'd1' as const,
      scope: 'deployment' as const,
      logicalRoles: ['core'],
      databaseName: 'unknown-core',
      automatic: true,
    };

    const plan = buildReleaseSchemaUpdatePlan({
      targetManifest: target,
      currentManifestForTarget: () => undefined,
      requireCurrentManifestForTargets: true,
      targets: [d1Target],
    });

    expect(plan.automaticTargets).toEqual([]);
    expect(plan.blockedTargets[0]).toMatchObject({
      changedFiles: ['002_1_1_0_core_delta.sql'],
      requiresAction: true,
      blockedReason: 'release_migration_target_history_required:d1:unknown-core:d1-core',
    });
  });

  it('does not require target history for a Worker-only release with no schema delta', () => {
    const target = generateReleaseMigrationManifest({
      migrationsRoot: temporaryMigrations(),
      productVersion: '1.1.0',
    });
    target.streams = target.streams.map((stream) => ({ ...stream, files: [] }));
    const plan = buildReleaseSchemaUpdatePlan({
      targetManifest: target,
      currentManifestForTarget: () => undefined,
      requireCurrentManifestForTargets: true,
      targets: [
        {
          id: 'd1:unknown-core:d1-core',
          streamId: 'd1-core',
          driver: 'd1',
          scope: 'deployment',
          logicalRoles: ['core'],
          databaseName: 'unknown-core',
          automatic: true,
        },
      ],
    });

    expect(plan.targets[0]).toMatchObject({ changedFiles: [], requiresAction: false });
    expect(plan.blockedTargets).toEqual([]);
  });

  it('only blocks an external target when its stream changed', () => {
    const migrationsRoot = temporaryMigrations();
    const current = generateReleaseMigrationManifest({ migrationsRoot, productVersion: '1.0.0' });
    const target = { ...current, productVersion: '1.1.0' };
    const externalTarget = {
      id: 'external:postgres:core-primary',
      streamId: 'external-postgres-core',
      driver: 'postgres' as const,
      scope: 'external' as const,
      logicalRoles: ['core'],
      automatic: false,
      blockedReason: 'external_database_executor_not_configured',
    };
    expect(
      buildReleaseSchemaUpdatePlan({
        targetManifest: target,
        currentManifest: current,
        targets: [externalTarget],
      }).blockedTargets
    ).toHaveLength(0);

    const changed: ReleaseMigrationManifest = {
      ...target,
      streams: target.streams.map((stream) =>
        stream.id === 'external-postgres-core'
          ? {
              ...stream,
              files: [...stream.files, { path: '002_new.sql', checksum: 'b'.repeat(64) }],
            }
          : stream
      ),
    };
    expect(
      buildReleaseSchemaUpdatePlan({
        targetManifest: changed,
        currentManifest: current,
        targets: [externalTarget],
      }).blockedTargets
    ).toHaveLength(1);
  });

  it('plans the cumulative stream for a new external target and blocks missing drivers', () => {
    const migrationsRoot = temporaryMigrations();
    const target = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.1.0',
    });
    const postgresTarget = {
      id: 'external:postgres:new-core',
      streamId: 'external-postgres-core',
      driver: 'postgres' as const,
      scope: 'external' as const,
      logicalRoles: ['core'],
      automatic: false,
      blockedReason: 'external_database_executor_not_configured',
    };
    const mysqlTarget = {
      id: 'external:mysql:new-core',
      streamId: null,
      driver: 'mysql' as const,
      scope: 'external' as const,
      logicalRoles: ['core'],
      automatic: false,
      blockedReason: 'release_migration_stream_not_available:mysql',
    };
    const plan = buildReleaseSchemaUpdatePlan({
      targetManifest: target,
      currentManifestForTarget: () => undefined,
      targets: [postgresTarget, mysqlTarget],
    });
    expect(plan.blockedTargets).toHaveLength(2);
    expect(
      plan.blockedTargets.find((item) => item.target.id === postgresTarget.id)?.changedFiles
    ).toEqual(['001_external.sql']);
    expect(
      plan.blockedTargets.find((item) => item.target.id === mysqlTarget.id)?.blockedReason
    ).toBe('release_migration_stream_not_available:mysql');
  });

  it('fails closed when a target names a stream absent from the release manifest', () => {
    const manifest = generateReleaseMigrationManifest({
      migrationsRoot: temporaryMigrations(),
      productVersion: '1.1.0',
    });
    const withoutExternalCore = {
      ...manifest,
      streams: manifest.streams.filter((stream) => stream.id !== 'external-postgres-core'),
    };
    const target = {
      id: 'external:postgres:tenant-primary:external-postgres-core',
      streamId: 'external-postgres-core',
      driver: 'postgres' as const,
      scope: 'external' as const,
      logicalRoles: ['core'],
      connectionRef: 'tenant-primary',
      automatic: false,
    };
    const updatePlan = buildReleaseSchemaUpdatePlan({
      targetManifest: withoutExternalCore,
      targets: [target],
    });
    expect(updatePlan.blockedTargets).toHaveLength(1);
    expect(updatePlan.blockedTargets[0].blockedReason).toBe(
      'release_migration_stream_not_found:external-postgres-core'
    );

    expect(() =>
      withVerifiedInitialReleaseState(lock({}), {
        productVersion: '1.1.0',
        manifestChecksum: calculateReleaseManifestChecksum(withoutExternalCore),
        manifest: withoutExternalCore,
        targets: [target],
        acknowledgedManualTargetIds: new Set([target.id]),
      })
    ).toThrow('release_manifest_stream_missing');
  });

  it('treats a published bundle as ready when its draft sources were already applied', () => {
    const sourceA = { path: '008_draft.sql', checksum: 'a'.repeat(64) };
    const sourceB = { path: '009_draft.sql', checksum: 'b'.repeat(64) };
    const current: ReleaseMigrationManifest = {
      formatVersion: 1,
      productVersion: '1.1.0',
      streams: [
        {
          id: 'external-postgres-core',
          dialect: 'postgres',
          logicalRoles: ['core'],
          files: [sourceA, sourceB],
        },
      ],
    };
    const published: ReleaseMigrationManifest = {
      formatVersion: 1,
      productVersion: '1.1.0',
      streams: [
        {
          id: 'external-postgres-core',
          dialect: 'postgres',
          logicalRoles: ['core'],
          files: [
            {
              path: '009_release_1_1_0_external_postgres_core.sql',
              checksum: 'c'.repeat(64),
              supersedes: [sourceA, sourceB],
            },
          ],
        },
      ],
    };
    const target = {
      id: 'external:postgres:shared:external-postgres-core',
      streamId: 'external-postgres-core',
      driver: 'postgres' as const,
      scope: 'external' as const,
      logicalRoles: ['core'],
      automatic: false,
      blockedReason: 'external_database_executor_not_configured',
    };
    const plan = buildReleaseSchemaUpdatePlan({
      targetManifest: published,
      currentManifest: current,
      targets: [target],
    });
    expect(plan.targets[0]).toMatchObject({ changedFiles: [], requiresAction: false });
    expect(plan.blockedTargets).toEqual([]);
  });
});

describe('release update lock state', () => {
  it('exports only schema references verified for the installed release stream', () => {
    const config = createDefaultConfig('prod');
    const installed = lock({ DB: { id: 'core-id', name: 'prod-core' } });
    installed.productVersion = '1.0.0';
    installed.releaseUpdate = {
      targetVersion: '1.0.0',
      phase: 'verified',
      manifestChecksum: 'a'.repeat(64),
      startedAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      appliedTargets: ['d1:core-id:d1-core'],
      manualTargets: [],
    };
    installed.schemaTargets = {
      'd1:core-id:d1-core': {
        productVersion: '1.0.0',
        manifestChecksum: 'a'.repeat(64),
        streamId: 'd1-core',
        files: [],
        appliedBy: 'automatic',
        updatedAt: '2026-07-21T00:00:00.000Z',
      },
    };

    expect(resolveRegisteredSchemaReferences({ lock: installed, config })).toEqual([
      'binding:DB:d1-core',
    ]);
    installed.schemaTargets['d1:core-id:d1-core'].productVersion = '0.9.0';
    expect(resolveRegisteredSchemaReferences({ lock: installed, config })).toEqual([]);
    installed.schemaTargets['d1:core-id:d1-core'].productVersion = '1.0.0';
    installed.schemaTargets['d1:core-id:d1-core'].manifestChecksum = 'b'.repeat(64);
    expect(resolveRegisteredSchemaReferences({ lock: installed, config })).toEqual([]);
  });

  it('does not serialize assignment slots into the Worker schema-reference variable', () => {
    const config = createDefaultConfig('prod');
    const installed = lock({
      DB: { id: 'core-id', name: 'prod-core' },
      TEST_TDB_SLOT_001_CORE: { id: 'tenant-core-id', name: 'prod-tenant-core-001' },
      TEST_TDB_SLOT_001_PII: { id: 'tenant-pii-id', name: 'prod-tenant-pii-001' },
    });
    installed.productVersion = '1.0.0';
    installed.releaseUpdate = {
      targetVersion: '1.0.0',
      phase: 'verified',
      manifestChecksum: 'a'.repeat(64),
      startedAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      appliedTargets: [
        'd1:core-id:d1-core',
        'd1:tenant-core-id:d1-core',
        'd1:tenant-pii-id:d1-pii',
      ],
      manualTargets: [],
    };
    installed.schemaTargets = Object.fromEntries(
      [
        ['d1:core-id:d1-core', 'd1-core'],
        ['d1:tenant-core-id:d1-core', 'd1-core'],
        ['d1:tenant-pii-id:d1-pii', 'd1-pii'],
      ].map(([id, streamId]) => [
        id,
        {
          productVersion: '1.0.0',
          manifestChecksum: 'a'.repeat(64),
          streamId,
          files: [],
          appliedBy: 'automatic' as const,
          updatedAt: '2026-07-21T00:00:00.000Z',
        },
      ])
    );

    expect(resolveRegisteredSchemaReferences({ lock: installed, config })).toEqual([
      'binding:DB:d1-core',
    ]);
  });

  it('accepts resumable release metadata without changing the lock format version', () => {
    const parsed = AuthrimLockSchema.parse({
      version: '1.0.0',
      productVersion: '1.1.0',
      createdAt: '2026-07-21T00:00:00.000Z',
      env: 'prod',
      d1: {},
      kv: {},
      releaseUpdate: {
        targetVersion: '1.1.0',
        previousProductVersion: '1.0.0',
        phase: 'verified',
        manifestChecksum: 'c'.repeat(64),
        startedAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:01:00.000Z',
      },
      schemaTargets: {
        'external:postgres:core-primary': {
          productVersion: '1.1.0',
          manifestChecksum: 'c'.repeat(64),
          appliedBy: 'operator',
          updatedAt: '2026-07-21T00:01:00.000Z',
        },
      },
    });
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.productVersion).toBe('1.1.0');
    expect(parsed.releaseUpdate?.appliedTargets).toEqual([]);
    expect(parsed.schemaTargets?.['external:postgres:core-primary']?.appliedBy).toBe('operator');
  });

  it('records the exact initial product and every automatic or acknowledged schema target', () => {
    const initialLock = lock({
      DB: { id: 'core-id', name: 'prod-core' },
    });
    initialLock.releaseUpdate = {
      targetVersion: '1.0.0',
      phase: 'schema_applied',
      manifestChecksum: 'c'.repeat(64),
      startedAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:01:00.000Z',
      appliedTargets: [],
      manualTargets: [],
      initialWorkerRedeployRequired: true,
    };
    const manifest: ReleaseMigrationManifest = {
      formatVersion: 1,
      productVersion: '1.0.0',
      streams: [
        {
          id: 'd1-core',
          dialect: 'sqlite',
          logicalRoles: ['core'],
          files: [{ path: '001.sql', checksum: 'a'.repeat(64) }],
        },
        {
          id: 'external-postgres-core',
          dialect: 'postgresql',
          logicalRoles: ['core'],
          files: [{ path: '001.sql', checksum: 'b'.repeat(64) }],
        },
      ],
    };
    const result = withVerifiedInitialReleaseState(initialLock, {
      productVersion: '1.0.0',
      manifestChecksum: 'c'.repeat(64),
      manifest,
      targets: [
        {
          id: 'd1:core-id:d1-core',
          streamId: 'd1-core',
          driver: 'd1',
          scope: 'deployment',
          logicalRoles: ['core'],
          automatic: true,
          databaseId: 'core-id',
          databaseName: 'prod-core',
        },
        {
          id: 'external:postgres:primary:external-postgres-core',
          streamId: 'external-postgres-core',
          driver: 'postgres',
          scope: 'external',
          logicalRoles: ['core'],
          automatic: false,
          connectionRef: 'primary',
        },
      ],
      acknowledgedManualTargetIds: new Set(['external:postgres:primary:external-postgres-core']),
    });

    expect(result.productVersion).toBe('1.0.0');
    expect(result.releaseUpdate?.phase).toBe('verified');
    expect(result.releaseUpdate?.initialWorkerRedeployRequired).toBeUndefined();
    expect(result.releaseUpdate?.appliedTargets).toHaveLength(2);
    expect(result.schemaTargets?.['d1:core-id:d1-core']?.appliedBy).toBe('automatic');
    expect(
      result.schemaTargets?.['external:postgres:primary:external-postgres-core']?.appliedBy
    ).toBe('operator');
  });

  it('rejects initial verification while a Control release rollout is recorded', () => {
    const initialLock = lock({});
    initialLock.releaseUpdate = {
      targetVersion: '0.4.0',
      phase: 'control_handoff',
      manifestChecksum: 'a'.repeat(64),
      startedAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:01:00.000Z',
      appliedTargets: [],
      manualTargets: [],
      controlOperationId: `op_release_rollout_${'b'.repeat(32)}`,
    };
    const manifest: ReleaseMigrationManifest = {
      formatVersion: 1,
      productVersion: '0.4.0',
      streams: [],
    };

    expect(() =>
      withVerifiedInitialReleaseState(initialLock, {
        productVersion: '0.4.0',
        manifestChecksum: 'a'.repeat(64),
        manifest,
        targets: [],
      })
    ).toThrow('initial_release_control_rollout_incomplete');
  });

  it('allows an installed draft only when its verified checksum is unchanged', () => {
    const migrationsRoot = temporaryMigrations();
    const manifest = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '0.4.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'release-manifest.draft.json'), manifest);
    const checksum = calculateReleaseManifestChecksum(manifest);
    const installedLock = lock({});
    installedLock.productVersion = '0.4.0';
    installedLock.releaseUpdate = {
      targetVersion: '0.4.0',
      phase: 'verified',
      manifestChecksum: checksum,
      startedAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };

    expect(
      loadInstalledReleaseMigrationManifest({
        migrationsRoot,
        productVersion: '0.4.0',
        lock: installedLock,
      }).draft
    ).toBe(true);
    installedLock.releaseUpdate.manifestChecksum = 'f'.repeat(64);
    expect(() =>
      loadInstalledReleaseMigrationManifest({
        migrationsRoot,
        productVersion: '0.4.0',
        lock: installedLock,
      })
    ).toThrow('unverified_draft_release_manifest:0.4.0');
  });
});
