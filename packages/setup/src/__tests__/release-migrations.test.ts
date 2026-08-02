import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { AuthrimLockSchema, type AuthrimLock } from '../core/lock.js';
import {
  assertProductVersionOpenForNewMigrations,
  assertProductVersionNotBehindPublished,
  calculateReleaseManifestChecksum,
  compareProductVersions,
  discoverReleaseMigrationStream,
  generateReleaseMigrationManifest,
  loadInstalledReleaseMigrationManifest,
  loadTargetReleaseMigrationManifest,
  ReleaseMigrationManifestSchema,
  resolveReleaseMigrationTargets,
  resolveRegisteredSchemaReferences,
  syncDraftReleaseMigrationManifest,
  validatePublishedReleaseMigrationManifests,
  writeReleaseMigrationManifest,
  type ReleaseMigrationManifest,
} from '../core/release-migrations.js';
import { buildReleaseSchemaUpdatePlan } from '../core/release-update.js';
import { withVerifiedInitialReleaseState } from '../core/release-state.js';
import {
  assertReleaseVersionMatchesRoot,
  prepareRelease,
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

  it('generates cumulative checksummed streams and preserves published supersedes metadata', () => {
    const migrationsRoot = temporaryMigrations();
    const initial = generateReleaseMigrationManifest({ migrationsRoot, productVersion: '1.0.0' });
    const core = initial.streams.find((stream) => stream.id === 'd1-core');
    expect(core?.files).toHaveLength(1);
    expect(core?.files[0].checksum).toMatch(/^[a-f0-9]{64}$/u);

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
    ).toEqual(['001_core.sql', '003_release_1_1_0.sql']);
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

  it('requires a product version bump after that version has been published', () => {
    const migrationsRoot = temporaryMigrations();
    const manifest = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.0.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/1.0.0.json'), manifest);
    expect(() => assertProductVersionOpenForNewMigrations(migrationsRoot, '1.0.0')).toThrow(
      'product_version_already_published:1.0.0'
    );

    writeFileSync(join(migrationsRoot, '002_too_late.sql'), 'CREATE TABLE too_late (id TEXT);\n');
    expect(() =>
      syncDraftReleaseMigrationManifest({ migrationsRoot, productVersion: '1.0.0' })
    ).toThrow('product_version_already_published:1.0.0');
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

  it('rejects a non-increasing release version before touching draft SQL', () => {
    const migrationsRoot = temporaryMigrations();
    const previous = generateReleaseMigrationManifest({
      migrationsRoot,
      productVersion: '1.1.0',
    });
    writeReleaseMigrationManifest(join(migrationsRoot, 'releases/1.1.0.json'), previous);
    writeFileSync(join(migrationsRoot, '002_draft_a.sql'), 'CREATE TABLE draft_a (id TEXT);\n');
    writeFileSync(join(migrationsRoot, '003_draft_b.sql'), 'CREATE TABLE draft_b (id TEXT);\n');

    expect(() => prepareRelease({ migrationsRoot, version: '1.1.0', write: true })).toThrow(
      'Release version must be newer than 1.1.0'
    );
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
        TDB_SLOT_0001_CORE: { id: 'tenant-core', name: 'tenant-core' },
        TDB_SLOT_0001_PII: { id: 'tenant-pii', name: 'tenant-pii' },
        TDB_ACME_CORE_S1: { id: 'tenant-core-s1', name: 'tenant-core-s1' },
      }),
    });

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: 'DB', streamId: 'd1-core', scope: 'deployment' }),
        expect.objectContaining({
          binding: 'CONTROL_DB',
          streamId: 'd1-control',
          logicalRoles: ['control'],
        }),
        expect.objectContaining({
          binding: 'LOOKUP_DB',
          streamId: 'd1-lookup',
          logicalRoles: ['lookup'],
        }),
        expect.objectContaining({
          binding: 'PLUGIN_RUNNER_DB',
          streamId: 'd1-plugin-runner',
          logicalRoles: ['plugin_runner'],
        }),
        expect.objectContaining({
          binding: 'TDB_SLOT_0001_CORE',
          streamId: 'd1-core',
          scope: 'tenant',
        }),
        expect.objectContaining({
          binding: 'TDB_ACME_CORE_S1',
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
        TDB_ACME_AUDIT: { id: 'tenant-audit', name: 'tenant-audit' },
        TDB_ACME_CUSTOM_S2: { id: 'tenant-custom-s2', name: 'tenant-custom-s2' },
      }),
    });

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: 'TDB_ACME_AUDIT',
          streamId: null,
          blockedReason: 'release_migration_stream_not_available:tenant_audit',
        }),
        expect.objectContaining({
          binding: 'TDB_ACME_CUSTOM_S2',
          streamId: null,
          shard: '2',
          blockedReason: 'release_migration_stream_not_available:tenant_custom',
        }),
      ])
    );
  });

  it('plans both core and PII streams against the same physical DB for single-db profiles', () => {
    const config = createDefaultConfig('test');
    config.profiles.defaults.storage = 'builtin:storage:single-db';
    const targets = resolveReleaseMigrationTargets({
      config,
      lock: lock({ DB: { id: 'single', name: 'single' } }),
    });
    expect(
      targets.filter((target) => target.databaseId === 'single').map((target) => target.streamId)
    ).toEqual(['d1-core', 'd1-pii']);
  });

  it('discovers external PostgreSQL targets and keeps execution fail-closed', () => {
    const config = createDefaultConfig('test');
    config.profiles.defaults.storage = 'builtin:storage:external-postgres';
    config.profiles.references.hyperdrive = {
      'core-primary': { binding: 'HD_CORE', id: 'hd-core', driver: 'postgres' },
      'pii-primary': { binding: 'HD_PII', id: 'hd-pii', driver: 'postgres' },
    };
    const targets = resolveReleaseMigrationTargets({ config, lock: lock({}) });
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'external:postgres:core-primary:external-postgres-core',
          streamId: 'external-postgres-core',
          automatic: false,
        }),
        expect.objectContaining({
          id: 'external:postgres:pii-primary:external-postgres-pii',
          streamId: 'external-postgres-pii',
          logicalRoles: ['pii'],
        }),
      ])
    );
  });

  it('keeps core and PII streams separate when they share one external connection', () => {
    const config = createDefaultConfig('test');
    config.profiles.defaults.storage = 'custom:storage:shared-postgres';
    config.profiles.references.hyperdrive = {
      shared: { binding: 'HD_SHARED', id: 'hd-shared', driver: 'postgres' },
    };
    config.profiles.seed.storage = [
      {
        id: 'custom:storage:shared-postgres',
        label: 'Shared PostgreSQL',
        slices: {
          identity_core: { driver: 'postgres', connectionRef: 'shared', role: 'core' },
          identity_pii: { driver: 'postgres', connectionRef: 'shared', role: 'pii' },
        },
      },
    ];
    const targets = resolveReleaseMigrationTargets({ config, lock: lock({}) });
    expect(targets.map((target) => target.id)).toEqual([
      'external:postgres:shared:external-postgres-core',
      'external:postgres:shared:external-postgres-pii',
    ]);
  });

  it('includes tenant-selectable seeded external profiles even when they are not the default', () => {
    const config = createDefaultConfig('test');
    config.profiles.references.hyperdrive = {
      'tenant-a-core': { binding: 'HD_TENANT_A', id: 'hd-tenant-a', driver: 'postgres' },
    };
    config.profiles.seed.storage = [
      {
        id: 'tenant:storage:a',
        label: 'Tenant A PostgreSQL',
        slices: {
          identity_core: {
            driver: 'postgres',
            connectionRef: 'tenant-a-core',
            role: 'core',
          },
        },
      },
    ];

    expect(resolveReleaseMigrationTargets({ config, lock: lock({}) })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'external:postgres:tenant-a-core:external-postgres-core',
          streamId: 'external-postgres-core',
          automatic: false,
        }),
      ])
    );
  });
});

describe('release schema update plans', () => {
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

  it('does not serialize tenant D1 slots into the Worker schema-reference variable', () => {
    const config = createDefaultConfig('prod');
    const installed = lock({
      DB: { id: 'core-id', name: 'prod-core' },
      TDB_SLOT_001_CORE: { id: 'tenant-core-id', name: 'prod-tenant-core-001' },
      TDB_SLOT_001_PII: { id: 'tenant-pii-id', name: 'prod-tenant-pii-001' },
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
    expect(result.releaseUpdate?.appliedTargets).toHaveLength(2);
    expect(result.schemaTargets?.['d1:core-id:d1-core']?.appliedBy).toBe('automatic');
    expect(
      result.schemaTargets?.['external:postgres:primary:external-postgres-core']?.appliedBy
    ).toBe('operator');
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
