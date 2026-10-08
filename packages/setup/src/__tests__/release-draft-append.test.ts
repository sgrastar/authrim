import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthrimLock } from '../core/lock.js';
import {
  assertControlSnapshotMatchesLock,
  recordControlMigratedEvidence,
  verifyDraftAppendDatabaseEvidence,
} from '../core/release-draft-append-evidence.js';
import { resolveSameVersionDraftAppend } from '../core/release-draft-append.js';
import {
  assertSameVersionDraftAppendUnpublished,
  buildReleaseMigrationArtifactManifest,
  gitSupportsNoLazyFetch,
  PARTIAL_CLONE_CONFIG_PATTERN,
  calculateReleaseManifestChecksum,
  loadTargetReleaseMigrationManifest,
  readReleaseMigrationManifest,
  RELEASE_MIGRATION_STREAM_DEFINITIONS,
  ReleaseMigrationManifestSchema,
  resolveReleaseMigrationExecutionManifest,
  serializeReleaseMigrationManifest,
  type ReleaseMigrationManifest,
  type ReleaseMigrationPhysicalTarget,
} from '../core/release-migrations.js';
import {
  applyReleaseSchemaUpdatePlan,
  buildReleaseSchemaUpdatePlan,
  getControlManagedReleaseStreamIds,
} from '../core/release-update.js';
import { withSchemaTargetStates } from '../core/release-state.js';

const runD1MigrationsMock = vi.hoisted(() => vi.fn());
vi.mock('../core/cloudflare.js', () => ({ runD1Migrations: runD1MigrationsMock }));

const VERSION = '0.9.1';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const sqlFile = (path: string) => ({ path, checksum: sha(path) });
const BASELINE = sqlFile('001_0_9_0_core_baseline.sql');
const SECOND = sqlFile('002_first_draft_migration.sql');
const APPENDED = sqlFile('003_appended_after_install.sql');
const PII_BASELINE = sqlFile('001_0_9_0_pii_baseline.sql');

function stream(id: 'core-d1' | 'pii-d1', files: Array<{ path: string; checksum: string }>) {
  const definition = RELEASE_MIGRATION_STREAM_DEFINITIONS.find((candidate) => candidate.id === id)!;
  return {
    id,
    schemaFamily: definition.schemaFamily,
    dialect: definition.dialect,
    targetKind: definition.targetKind,
    logicalRoles: [...definition.logicalRoles],
    files,
  };
}

function draft(coreFiles: Array<{ path: string; checksum: string }>): ReleaseMigrationManifest {
  return ReleaseMigrationManifestSchema.parse({
    formatVersion: 2,
    productVersion: VERSION,
    databaseCompatibility: 'fresh_and_forward',
    upgradePaths: [
      {
        fromProductVersion: '0.9.0',
        kind: 'delta',
        streams: [stream('core-d1', coreFiles.slice(1)), stream('pii-d1', [])],
      },
    ],
    streams: [stream('core-d1', coreFiles), stream('pii-d1', [PII_BASELINE])],
  });
}

const installed = draft([BASELINE, SECOND]);
const target = draft([BASELINE, SECOND, APPENDED]);
const installedChecksum = calculateReleaseManifestChecksum(installed);
const targetChecksum = calculateReleaseManifestChecksum(target);

function physicalTarget(
  id: string,
  streamId: 'core-d1' | 'pii-d1',
  scope: ReleaseMigrationPhysicalTarget['scope'] = 'deployment'
): ReleaseMigrationPhysicalTarget {
  return {
    id,
    streamId,
    driver: 'd1',
    scope,
    logicalRoles: [streamId === 'core-d1' ? 'core' : 'pii'],
    databaseId: id,
    databaseName: `db-${id}`,
    automatic: true,
  };
}

const sharedCore = physicalTarget('d1:shared:core-d1', 'core-d1');
const tenantCore = physicalTarget('d1:tenant:core-d1', 'core-d1', 'tenant');
const pii = physicalTarget('d1:pii:pii-d1', 'pii-d1');
const targets = [pii, sharedCore, tenantCore];

function state(
  streamId: string,
  files: Array<{ path: string; checksum: string }>,
  manifestChecksum = installedChecksum
) {
  return {
    productVersion: VERSION,
    manifestChecksum,
    streamId,
    files,
    appliedBy: 'automatic' as const,
    updatedAt: '2026-10-08T00:00:00.000Z',
  };
}

function lockAt(
  schemaTargets: NonNullable<AuthrimLock['schemaTargets']>,
  releaseUpdate: Partial<NonNullable<AuthrimLock['releaseUpdate']>> = {}
): AuthrimLock {
  return {
    version: '1.0.0',
    env: 'test',
    createdAt: '2026-10-08T00:00:00.000Z',
    productVersion: VERSION,
    d1: {},
    kv: {},
    workers: {},
    schemaTargets,
    releaseUpdate: {
      targetVersion: VERSION,
      previousProductVersion: '0.9.0',
      phase: 'verified',
      manifestChecksum: installedChecksum,
      startedAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
      appliedTargets: targets.map((candidate) => candidate.id),
      manualTargets: [],
      ...releaseUpdate,
    },
  } as AuthrimLock;
}

function installedTargets(): NonNullable<AuthrimLock['schemaTargets']> {
  return {
    [pii.id]: state('pii-d1', [PII_BASELINE]),
    [sharedCore.id]: state('core-d1', [BASELINE, SECOND]),
    [tenantCore.id]: state('core-d1', [BASELINE, SECOND]),
  };
}

const unpublished = vi.fn();
function resolve(overrides: Partial<Parameters<typeof resolveSameVersionDraftAppend>[0]> = {}) {
  return resolveSameVersionDraftAppend({
    migrationsRoot: '/repo/migrations',
    manifest: target,
    manifestChecksum: targetChecksum,
    manifestIsDraft: true,
    lock: lockAt(installedTargets()),
    targets,
    assertUnpublished: unpublished,
    ...overrides,
  });
}

describe('same-version draft append planning', () => {
  it('plans only the appended file for the databases that do not hold it', () => {
    unpublished.mockReset();
    const append = resolve();
    expect(append).toBeDefined();
    expect(append!.appendedFileCount).toBe(2);
    expect(unpublished).toHaveBeenCalledWith({
      migrationsRoot: '/repo/migrations',
      productVersion: VERSION,
    });

    const execution = resolveReleaseMigrationExecutionManifest({
      targetManifest: target,
      installedProductVersion: VERSION,
      sameVersionDraftAppend: append,
    });
    expect(execution.streams.find((item) => item.id === 'core-d1')!.files).toEqual([APPENDED]);
    expect(execution.streams.find((item) => item.id === 'pii-d1')!.files).toEqual([]);
    expect(execution.freshInstallBaseline).toBeUndefined();

    const lock = lockAt(installedTargets());
    const plan = buildReleaseSchemaUpdatePlan({
      targetManifest: execution,
      currentManifestForTarget: (item) => {
        const recorded = lock.schemaTargets![item.id]!;
        return {
          formatVersion: 2,
          productVersion: recorded.productVersion,
          streams: [stream(item.streamId as 'core-d1', recorded.files!)],
        };
      },
      requireCurrentManifestForTargets: true,
      targets,
    });
    expect(plan.automaticTargets.map((item) => [item.target.id, item.changedFiles])).toEqual([
      [sharedCore.id, [APPENDED.path]],
      [tenantCore.id, [APPENDED.path]],
    ]);
    expect(plan.blockedTargets).toEqual([]);
    expect(getControlManagedReleaseStreamIds({ targetManifest: execution })).toEqual(['core-d1']);
  });

  it('keeps the plan empty without an explicit, evidence-checked draft append', () => {
    // A published (non-draft) manifest at the installed version never re-runs.
    expect(resolve({ manifestIsDraft: false })).toBeUndefined();
    const execution = resolveReleaseMigrationExecutionManifest({
      targetManifest: target,
      installedProductVersion: VERSION,
    });
    expect(execution.streams.every((item) => item.files.length === 0)).toBe(true);
    // A different installed version uses the ordinary upgrade paths.
    expect(resolve({ lock: { ...lockAt(installedTargets()), productVersion: '0.9.0' } })).toBe(
      undefined
    );
    // The same draft that was already verified has nothing to append.
    expect(
      resolve({
        lock: lockAt(installedTargets(), { manifestChecksum: targetChecksum }),
        manifestChecksum: targetChecksum,
      })
    ).toBeUndefined();
  });

  it('only builds a Control artifact for the same version from a draft append', () => {
    const append = resolve()!;
    expect(() =>
      buildReleaseMigrationArtifactManifest({
        targetManifest: target,
        installedProductVersion: VERSION,
      })
    ).toThrow(`release_artifact_same_version_requires_draft_append:${VERSION}`);

    const artifact = buildReleaseMigrationArtifactManifest({
      targetManifest: target,
      installedProductVersion: VERSION,
      sameVersionDraftAppend: append,
    });
    const appendPath = artifact.upgradePaths!.find((path) => path.fromProductVersion === VERSION)!;
    expect(appendPath.kind).toBe('draft_append');
    // Every non-baseline file of the draft, independent of what any database holds.
    expect(appendPath.streams.find((item) => item.id === 'core-d1')!.files).toEqual([
      SECOND,
      APPENDED,
    ]);
    // The full stream stays available as accepted history so Control can verify the prefix.
    expect(artifact.acceptedMigrationHistory!.find((item) => item.id === 'core-d1')!.files).toEqual(
      [BASELINE, SECOND, APPENDED]
    );
    // The earlier 0.9.0 -> 0.9.1 path is untouched and the artifact digest is draft-specific.
    expect(artifact.upgradePaths!.map((path) => [path.fromProductVersion, path.kind])).toEqual([
      ['0.9.0', 'delta'],
      [VERSION, 'draft_append'],
    ]);
    expect(calculateReleaseManifestChecksum(artifact)).not.toBe(targetChecksum);
  });

  it('does not loosen the upgrade-path constraint for releases', () => {
    const base = serializeReleaseMigrationManifest(target);
    const parsed = JSON.parse(base) as ReleaseMigrationManifest;
    const sameVersionDelta = {
      ...parsed,
      upgradePaths: [
        { fromProductVersion: VERSION, kind: 'delta', streams: [stream('core-d1', [APPENDED])] },
      ],
    };
    expect(() => ReleaseMigrationManifestSchema.parse(sameVersionDelta)).toThrow(
      'Release migration upgrade paths must start below the target version'
    );
    const belowAsAppend = {
      ...parsed,
      upgradePaths: [
        {
          fromProductVersion: '0.9.0',
          kind: 'draft_append',
          streams: [stream('core-d1', [APPENDED])],
        },
      ],
    };
    expect(() => ReleaseMigrationManifestSchema.parse(belowAsAppend)).toThrow(
      'Release migration upgrade paths must start below the target version'
    );
  });

  it('never accepts a draft-append path inside a repository manifest file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-draft-append-file-'));
    temporaryDirectories.push(directory);
    const artifact = buildReleaseMigrationArtifactManifest({
      targetManifest: target,
      installedProductVersion: VERSION,
      sameVersionDraftAppend: resolve()!,
    });
    const path = join(directory, 'release-manifest.draft.json');
    writeFileSync(path, serializeReleaseMigrationManifest(artifact));
    expect(() => readReleaseMigrationManifest(path)).toThrow(
      `draft_append_upgrade_path_not_allowed_in_manifest_file:${VERSION}`
    );
  });
});

describe('same-version draft append rejection', () => {
  const reason = (code: string) => `draft_append_rejected:${VERSION}:${code}`;

  it('rejects a modified, removed or reordered recorded migration', () => {
    const changed = draft([BASELINE, { ...SECOND, checksum: sha('edited') }, APPENDED]);
    expect(() =>
      resolve({ manifest: changed, manifestChecksum: calculateReleaseManifestChecksum(changed) })
    ).toThrow(reason('migration_file_changed'));

    const removed = draft([BASELINE]);
    expect(() =>
      resolve({ manifest: removed, manifestChecksum: calculateReleaseManifestChecksum(removed) })
    ).toThrow(reason('migration_file_removed_or_reordered'));

    const renamed = draft([BASELINE, sqlFile('002_renamed.sql'), APPENDED]);
    expect(() =>
      resolve({ manifest: renamed, manifestChecksum: calculateReleaseManifestChecksum(renamed) })
    ).toThrow(reason('migration_file_removed_or_reordered'));
  });

  it('rejects missing or legacy evidence and a changed set of databases', () => {
    const noFiles = installedTargets();
    noFiles[sharedCore.id] = { ...noFiles[sharedCore.id]!, files: undefined };
    expect(() => resolve({ lock: lockAt(noFiles) })).toThrow(reason('target_evidence_missing'));

    const otherVersion = installedTargets();
    otherVersion[sharedCore.id] = { ...otherVersion[sharedCore.id]!, productVersion: '0.9.0' };
    expect(() => resolve({ lock: lockAt(otherVersion) })).toThrow(
      reason('target_evidence_missing')
    );

    const missingTarget = installedTargets();
    delete missingTarget[tenantCore.id];
    expect(() => resolve({ lock: lockAt(missingTarget) })).toThrow(reason('target_set_changed'));

    expect(() => resolve({ lock: lockAt({}) })).toThrow(reason('target_set_changed'));

    const movedStream = installedTargets();
    movedStream[sharedCore.id] = { ...movedStream[sharedCore.id]!, streamId: 'pii-d1' };
    expect(() => resolve({ lock: lockAt(movedStream) })).toThrow(reason('target_stream_changed'));
  });

  it('rejects a checkpoint that contradicts the draft it claims to match', () => {
    const contradictory = installedTargets();
    contradictory[sharedCore.id] = state('core-d1', [BASELINE, SECOND], targetChecksum);
    expect(() => resolve({ lock: lockAt(contradictory) })).toThrow(
      reason('checkpoint_contradicts_manifest')
    );
  });

  it('rejects a version whose release tag is reachable from remote main', () => {
    const published = vi.fn(() => {
      throw new Error(`product_version_already_published:${VERSION}:bump the root package version`);
    });
    expect(() => resolve({ assertUnpublished: published })).toThrow(
      `product_version_already_published:${VERSION}`
    );
  });

  it('refuses to load a draft manifest without --allow-draft-manifest', () => {
    const migrationsRoot = mkdtempSync(join(tmpdir(), 'authrim-draft-append-load-'));
    temporaryDirectories.push(migrationsRoot);
    writeFileSync(
      join(migrationsRoot, 'release-manifest.draft.json'),
      serializeReleaseMigrationManifest(target)
    );
    expect(() =>
      loadTargetReleaseMigrationManifest({ migrationsRoot, productVersion: VERSION })
    ).toThrow(`release_migration_manifest_not_found:${VERSION}`);
  });
});

describe('same-version draft append retry and resume', () => {
  it('resumes after a partial run by planning only databases still behind', () => {
    // One core database finished (checkpointed against the new draft), the other did not.
    const partial = installedTargets();
    partial[sharedCore.id] = state('core-d1', [BASELINE, SECOND, APPENDED], targetChecksum);
    const lock = lockAt(partial, {
      phase: 'control_handoff',
      manifestChecksum: targetChecksum,
      appliedTargets: [pii.id, sharedCore.id],
    });
    const append = resolve({ lock })!;
    expect(append.hasForwardProgress).toBe(true);
    expect(append.appendedFileCount).toBe(1);

    const execution = resolveReleaseMigrationExecutionManifest({
      targetManifest: target,
      installedProductVersion: VERSION,
      sameVersionDraftAppend: append,
    });
    const plan = buildReleaseSchemaUpdatePlan({
      targetManifest: execution,
      currentManifestForTarget: (item) => {
        const recorded = lock.schemaTargets![item.id]!;
        return {
          formatVersion: 2,
          productVersion: recorded.productVersion,
          streams: [stream(item.streamId as 'core-d1', recorded.files!)],
        };
      },
      requireCurrentManifestForTargets: true,
      targets,
    });
    expect(plan.automaticTargets.map((item) => item.target.id)).toEqual([tenantCore.id]);
  });

  it('records completion evidence so a rerun finds nothing left to apply', () => {
    unpublished.mockReset();
    const append = resolve()!;
    const execution = resolveReleaseMigrationExecutionManifest({
      targetManifest: target,
      installedProductVersion: VERSION,
      sameVersionDraftAppend: append,
    });
    const completed = withSchemaTargetStates(lockAt(installedTargets()), {
      targetIds: targets.map((item) => item.id),
      manualTargetIds: new Set<string>(),
      productVersion: VERSION,
      manifestChecksum: targetChecksum,
      targetStreamIds: new Map(targets.map((item) => [item.id, item.streamId])),
      manifest: execution,
      preserveExistingFiles: true,
    });
    expect(completed.schemaTargets![sharedCore.id]!.files).toEqual([BASELINE, SECOND, APPENDED]);
    expect(completed.schemaTargets![pii.id]!.files).toEqual([PII_BASELINE]);

    // Interrupted before Workers finished: same checksum, phase not verified.
    const rerun = resolve({
      lock: {
        ...completed,
        releaseUpdate: { ...completed.releaseUpdate!, phase: 'control_handoff' },
      } as AuthrimLock,
    })!;
    expect(rerun.appendedFileCount).toBe(0);
    const rerunExecution = resolveReleaseMigrationExecutionManifest({
      targetManifest: target,
      installedProductVersion: VERSION,
      sameVersionDraftAppend: rerun,
    });
    expect(rerunExecution.streams.every((item) => item.files.length === 0)).toBe(true);
  });

  it('hands the executor only the appended tail, never the fresh-install baseline', async () => {
    runD1MigrationsMock.mockReset();
    runD1MigrationsMock.mockResolvedValue({ success: true, appliedCount: 1, skippedCount: 0 });
    const append = resolve()!;
    const execution = resolveReleaseMigrationExecutionManifest({
      targetManifest: target,
      installedProductVersion: VERSION,
      sameVersionDraftAppend: append,
    });
    const lock = lockAt(installedTargets());
    const plan = buildReleaseSchemaUpdatePlan({
      targetManifest: execution,
      currentManifestForTarget: (item) => ({
        formatVersion: 2,
        productVersion: VERSION,
        streams: [stream(item.streamId as 'core-d1', lock.schemaTargets![item.id]!.files!)],
      }),
      requireCurrentManifestForTargets: true,
      targets: [sharedCore],
    });
    await applyReleaseSchemaUpdatePlan({
      plan,
      manifest: execution,
      migrationsRoot: '/repo/migrations',
    });
    expect(runD1MigrationsMock).toHaveBeenCalledOnce();
    expect(runD1MigrationsMock.mock.calls[0]![3].manifestFiles).toEqual([APPENDED]);
  });
});

describe('same-version draft append identity, evidence and Control coverage', () => {
  it('rebuilds the identical artifact however far a previous attempt got', () => {
    const fresh = resolve()!;
    const partial = installedTargets();
    partial[sharedCore.id] = state('core-d1', [BASELINE, SECOND, APPENDED], targetChecksum);
    partial[pii.id] = state('pii-d1', [PII_BASELINE], targetChecksum);
    const resumed = resolve({
      lock: lockAt(partial, { phase: 'control_handoff', manifestChecksum: targetChecksum }),
    })!;
    const build = (append: typeof fresh) =>
      buildReleaseMigrationArtifactManifest({
        targetManifest: target,
        installedProductVersion: VERSION,
        sameVersionDraftAppend: append,
      });
    expect(calculateReleaseManifestChecksum(build(resumed))).toBe(
      calculateReleaseManifestChecksum(build(fresh))
    );
  });

  it('rejects a draft whose only change is outside the migration files', () => {
    const metadataOnly = ReleaseMigrationManifestSchema.parse({
      ...installed,
      rollout: {
        databaseExecution: 'setup_then_control',
        workerActivation: 'after_required_databases',
        adminMutationMode: 'available',
      },
    });
    const checksum = calculateReleaseManifestChecksum(metadataOnly);
    expect(checksum).not.toBe(installedChecksum);
    expect(() => resolve({ manifest: metadataOnly, manifestChecksum: checksum })).toThrow(
      `draft_append_rejected:${VERSION}:no_forward_progress`
    );
  });

  it('verifies every automatic D1 target against its recorded files, changed or not', async () => {
    const append = resolve()!;
    const verify = vi.fn(async (_database: string, files: readonly unknown[]) =>
      files.length === 0 ? { success: false, error: 'unexpected' } : { success: true }
    );
    await verifyDraftAppendDatabaseEvidence({ append, targets, verify });
    expect(verify.mock.calls.map((call) => [call[0], call[1]])).toEqual(
      expect.arrayContaining([
        [pii.databaseId, [PII_BASELINE]],
        [sharedCore.databaseId, [BASELINE, SECOND]],
        [tenantCore.databaseId, [BASELINE, SECOND]],
      ])
    );
    expect(verify).toHaveBeenCalledTimes(3);

    const failing = vi.fn(async (database: string) =>
      database === tenantCore.databaseId
        ? { success: false, error: 'Applied migration history does not match: 002' }
        : { success: true }
    );
    await expect(
      verifyDraftAppendDatabaseEvidence({ append, targets, verify: failing })
    ).rejects.toThrow(`draft_append_database_evidence_mismatch:${tenantCore.id}`);
  });

  it('still has recorded files to verify when a resume has nothing left to append', () => {
    const finished = installedTargets();
    for (const item of [sharedCore, tenantCore]) {
      finished[item.id] = state('core-d1', [BASELINE, SECOND, APPENDED], targetChecksum);
    }
    finished[pii.id] = state('pii-d1', [PII_BASELINE], targetChecksum);
    const append = resolve({
      lock: lockAt(finished, { phase: 'workers_deployed', manifestChecksum: targetChecksum }),
    })!;
    // update.ts verifies the databases whenever an append is in progress, not only when files remain.
    expect(append.appendedFileCount).toBe(0);
    expect(append.recordedFilesByTarget.get(sharedCore.id)).toEqual([BASELINE, SECOND, APPENDED]);
  });

  it('rejects evidence that records nothing, so the baseline can never run on a database', () => {
    const empty = installedTargets();
    empty[sharedCore.id] = { ...empty[sharedCore.id]!, files: [] };
    expect(() => resolve({ lock: lockAt(empty) })).toThrow(
      `draft_append_rejected:${VERSION}:target_evidence_missing`
    );
    const partialBaseline = installedTargets();
    partialBaseline[sharedCore.id] = { ...partialBaseline[sharedCore.id]!, files: [] };
    partialBaseline[tenantCore.id] = { ...partialBaseline[tenantCore.id]!, files: [] };
    expect(() => resolve({ lock: lockAt(partialBaseline) })).toThrow('target_evidence_missing');
  });

  it('never lets a baseline of another version into the executable tail', () => {
    // The record holds a baseline and one delta, i.e. as many files as there are baselines in the
    // stream once a later baseline is appended; counting baselines would accept this.
    const lateBaseline = sqlFile('004_0_9_1_core_baseline.sql');
    const withBaselines = (coreFiles: Array<{ path: string; checksum: string }>) =>
      ReleaseMigrationManifestSchema.parse({
        formatVersion: 2,
        productVersion: VERSION,
        databaseCompatibility: 'fresh_and_forward',
        streams: [stream('core-d1', coreFiles), stream('pii-d1', [PII_BASELINE])],
      });
    const withLateBaseline = withBaselines([BASELINE, SECOND, APPENDED, lateBaseline]);
    expect(() =>
      resolve({
        manifest: withLateBaseline,
        manifestChecksum: calculateReleaseManifestChecksum(withLateBaseline),
      })
    ).toThrow(`draft_append_rejected:${VERSION}:target_evidence_missing`);
  });

  it('detects a partial clone by any of its config keys and needs Git 2.45 for it', () => {
    const pattern = new RegExp(PARTIAL_CLONE_CONFIG_PATTERN.replaceAll('\\\\', '\\'), 'u');
    for (const key of [
      'remote.origin.promisor',
      'remote.origin.partialclonefilter',
      'extensions.partialclone',
    ]) {
      expect(pattern.test(key)).toBe(true);
    }
    expect(pattern.test('remote.origin.url')).toBe(false);
    expect(gitSupportsNoLazyFetch('git version 2.44.1')).toBe(false);
    expect(gitSupportsNoLazyFetch('git version 2.45.0')).toBe(true);
    expect(gitSupportsNoLazyFetch('git version 2.50.0')).toBe(true);
    expect(gitSupportsNoLazyFetch('git version 3.0.0')).toBe(true);
    expect(gitSupportsNoLazyFetch('not git')).toBe(false);
  });

  describe('Control coverage', () => {
    const operationId = 'op_release_rollout_' + 'a'.repeat(32);
    const done = { streamId: 'core-d1', databaseId: tenantCore.databaseId!, state: 'succeeded' };
    const record = (
      rows: Array<{ streamId: string; databaseId: string | null; state: string }>,
      options: { strict: boolean; lock?: AuthrimLock; targetsOverride?: typeof targets } = {
        strict: true,
      }
    ) =>
      recordControlMigratedEvidence({
        lock: options.lock ?? lockAt(installedTargets()),
        controlDatabaseId: 'control-db',
        environmentId: 'test',
        operationId,
        targets: options.targetsOverride ?? targets,
        managedStreamIds: ['core-d1'],
        productVersion: VERSION,
        manifestChecksum: targetChecksum,
        manifest: resolveReleaseMigrationExecutionManifest({
          targetManifest: target,
          installedProductVersion: VERSION,
          sameVersionDraftAppend: resolve()!,
        }),
        strict: options.strict,
        listTargets: async () => rows,
      });

    it('records only databases Control reports as succeeded, and stops otherwise', async () => {
      const recorded = await record([done], { strict: true });
      expect(recorded.recordedTargetIds).toEqual([tenantCore.id]);
      expect(recorded.lock.schemaTargets![tenantCore.id]!.files).toEqual([
        BASELINE,
        SECOND,
        APPENDED,
      ]);
      expect(recorded.lock.schemaTargets![sharedCore.id]!.files).toEqual([BASELINE, SECOND]);
      // A shard dropped from Control's snapshot, unfinished, or in another stream is not recorded.
      await expect(record([], { strict: true })).rejects.toThrow(
        `control_rollout_targets_incomplete:${tenantCore.databaseId}:core-d1`
      );
      await expect(record([{ ...done, state: 'waiting_retry' }], { strict: true })).rejects.toThrow(
        'control_rollout_targets_incomplete'
      );
      await expect(record([{ ...done, streamId: 'pii-d1' }], { strict: true })).rejects.toThrow(
        'control_rollout_targets_incomplete'
      );
      // A database the lock does not know was migrated without evidence: refuse to go on.
      await expect(
        record([done, { streamId: 'core-d1', databaseId: 'stranger', state: 'succeeded' }], {
          strict: true,
        })
      ).rejects.toThrow('control_rollout_targets_unknown_to_lock:stranger:core-d1');
    });

    it("still reads Control's record when no tenant database is expected", async () => {
      const noTenants = [sharedCore, pii];
      const stranger = { streamId: 'core-d1', databaseId: 'stranger', state: 'succeeded' };
      await expect(
        record([stranger], { strict: true, targetsOverride: noTenants })
      ).rejects.toThrow('control_rollout_targets_unknown_to_lock:stranger:core-d1');
      await expect(record([], { strict: true, targetsOverride: noTenants })).resolves.toMatchObject(
        {
          recordedTargetIds: [],
        }
      );
      // A normal upgrade keeps its earlier behaviour: nothing to record, nothing read.
      await expect(
        record([stranger], { strict: false, targetsOverride: noTenants })
      ).resolves.toMatchObject({ recordedTargetIds: [], warnings: [] });
    });

    it('updates stale tenant evidence after a normal upgrade and only warns on a mismatch', async () => {
      const stale = installedTargets();
      stale[tenantCore.id] = {
        ...stale[tenantCore.id]!,
        productVersion: '0.9.0',
        manifestChecksum: 'e'.repeat(64),
        files: [BASELINE],
      };
      const lock = lockAt(stale);
      const recorded = await record([done], { strict: false, lock });
      expect(recorded.lock.schemaTargets![tenantCore.id]).toMatchObject({
        productVersion: VERSION,
        manifestChecksum: targetChecksum,
        files: [BASELINE, APPENDED],
      });
      const warned = await record([], { strict: false, lock });
      expect(warned.recordedTargetIds).toEqual([]);
      expect(warned.warnings[0]).toContain('control_rollout_targets_incomplete');
      expect(warned.lock.schemaTargets![tenantCore.id]!.productVersion).toBe('0.9.0');
    });

    it('stops before the handoff when Control would migrate a different set of databases', async () => {
      const preview = (rows: Array<{ streamId: string; databaseId: string | null }>) =>
        assertControlSnapshotMatchesLock({
          controlDatabaseId: 'control-db',
          environmentId: 'test',
          targets,
          managedStreamIds: ['core-d1'],
          preview: async () => rows,
        });
      const ok = { streamId: 'core-d1', databaseId: tenantCore.databaseId };
      await expect(preview([ok])).resolves.toBeUndefined();
      // Other streams are not part of this handoff.
      await expect(
        preview([ok, { streamId: 'pii-d1', databaseId: 'ignored-for-this-handoff' }])
      ).resolves.toBeUndefined();
      await expect(preview([ok, { streamId: 'core-d1', databaseId: 'stranger' }])).rejects.toThrow(
        'unknown_to_lock=[stranger:core-d1]'
      );
      await expect(preview([])).rejects.toThrow(
        `missing_in_control=[${tenantCore.databaseId}:core-d1]`
      );
      await expect(preview([ok, { streamId: 'core-d1', databaseId: null }])).rejects.toThrow(
        'unresolved=[core-d1]'
      );
    });
  });

  it('hands the executor the recorded prefix to verify, separate from the tail to run', async () => {
    runD1MigrationsMock.mockReset();
    runD1MigrationsMock.mockResolvedValue({ success: true, appliedCount: 1, skippedCount: 0 });
    const append = resolve()!;
    const execution = resolveReleaseMigrationExecutionManifest({
      targetManifest: target,
      installedProductVersion: VERSION,
      sameVersionDraftAppend: append,
    });
    const plan = buildReleaseSchemaUpdatePlan({
      targetManifest: execution,
      currentManifestForTarget: () => ({
        formatVersion: 2,
        productVersion: VERSION,
        streams: [stream('core-d1', [BASELINE, SECOND])],
      }),
      requireCurrentManifestForTargets: true,
      targets: [sharedCore],
    });
    await applyReleaseSchemaUpdatePlan({
      plan,
      manifest: execution,
      migrationsRoot: '/repo/migrations',
      requiredAppliedFilesByTarget: append.recordedFilesByTarget,
    });
    const options = runD1MigrationsMock.mock.calls[0]![3];
    expect(options.manifestFiles).toEqual([APPENDED]);
    expect(options.requiredAppliedFiles).toEqual([BASELINE, SECOND]);
  });
});

describe('same-version draft append publication check', () => {
  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  }

  function repositories() {
    const root = mkdtempSync(join(tmpdir(), 'authrim-draft-append-git-'));
    temporaryDirectories.push(root);
    const remote = join(root, 'origin.git');
    const publisher = join(root, 'publisher');
    const checkout = join(root, 'checkout');
    git(root, 'init', '--bare', remote);
    git(root, 'init', '--initial-branch=main', publisher);
    git(publisher, 'config', 'user.email', 'draft-append@authrim.invalid');
    git(publisher, 'config', 'user.name', 'Draft Append Test');
    writeFileSync(join(publisher, 'README.md'), 'test\n');
    git(publisher, 'add', 'README.md');
    git(publisher, 'commit', '-m', 'initial');
    git(publisher, 'remote', 'add', 'origin', remote);
    git(publisher, 'push', 'origin', 'main');
    git(root, 'clone', remote, checkout);
    mkdirSync(join(checkout, 'migrations'));
    return { remote, publisher, checkout, migrationsRoot: join(checkout, 'migrations') };
  }

  it('fetches remote main and tags, then allows an unpublished version', () => {
    const { migrationsRoot } = repositories();
    expect(() =>
      assertSameVersionDraftAppendUnpublished({ migrationsRoot, productVersion: VERSION })
    ).not.toThrow();
  });

  it('rejects a version that was tagged on remote main after the last local fetch', () => {
    const { publisher, checkout, migrationsRoot } = repositories();
    git(publisher, 'tag', `v${VERSION}`);
    git(publisher, 'push', 'origin', `refs/tags/v${VERSION}`);
    // The checkout has not fetched the tag yet; the check has to fetch it itself.
    expect(existsSync(join(checkout, '.git', 'refs', 'tags', `v${VERSION}`))).toBe(false);
    expect(() =>
      assertSameVersionDraftAppendUnpublished({ migrationsRoot, productVersion: VERSION })
    ).toThrow(`product_version_already_published:${VERSION}`);
  });

  it('does not treat a tag outside remote main as published', () => {
    const { publisher, migrationsRoot } = repositories();
    git(publisher, 'checkout', '-b', 'side');
    writeFileSync(join(publisher, 'side.txt'), 'side\n');
    git(publisher, 'add', 'side.txt');
    git(publisher, 'commit', '-m', 'side');
    git(publisher, 'tag', `v${VERSION}`);
    git(publisher, 'push', 'origin', 'side', `refs/tags/v${VERSION}`);
    expect(() =>
      assertSameVersionDraftAppendUnpublished({ migrationsRoot, productVersion: VERSION })
    ).not.toThrow();
  });

  it('decides from the remote main hash even when the tracking ref is stale', () => {
    const { publisher, checkout, migrationsRoot } = repositories();
    // The checkout only follows a branch that is not main, so origin/main never moves locally.
    git(
      checkout,
      'config',
      'remote.origin.fetch',
      '+refs/heads/develop:refs/remotes/origin/develop'
    );
    writeFileSync(join(publisher, 'release.txt'), 'release\n');
    git(publisher, 'add', 'release.txt');
    git(publisher, 'commit', '-m', 'release');
    git(publisher, 'tag', `v${VERSION}`);
    git(publisher, 'push', 'origin', 'main', `refs/tags/v${VERSION}`);
    const trackedMain = (): string =>
      execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], {
        cwd: checkout,
        encoding: 'utf-8',
      }).trim();
    const before = trackedMain();
    // The tag commit is new to the checkout, so it has to be fetched, then compared to main.
    expect(() =>
      assertSameVersionDraftAppendUnpublished({ migrationsRoot, productVersion: VERSION })
    ).toThrow(`product_version_already_published:${VERSION}`);
    // The objects were fetched, but no ref moved and FETCH_HEAD was not written.
    expect(trackedMain()).toBe(before);
    expect(existsSync(join(checkout, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(
      execFileSync('git', ['tag', '--list'], { cwd: checkout, encoding: 'utf-8' }).trim()
    ).toBe('');
  });

  it('does not move origin/main even when the configured refspec would', () => {
    const { publisher, checkout, migrationsRoot } = repositories();
    writeFileSync(join(publisher, 'release.txt'), 'release\n');
    git(publisher, 'add', 'release.txt');
    git(publisher, 'commit', '-m', 'release');
    git(publisher, 'tag', `v${VERSION}`);
    git(publisher, 'push', 'origin', 'main', `refs/tags/v${VERSION}`);
    const trackedMain = (): string =>
      execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], {
        cwd: checkout,
        encoding: 'utf-8',
      }).trim();
    const before = trackedMain();
    expect(() =>
      assertSameVersionDraftAppendUnpublished({ migrationsRoot, productVersion: VERSION })
    ).toThrow(`product_version_already_published:${VERSION}`);
    expect(trackedMain()).toBe(before);
    expect(existsSync(join(checkout, '.git', 'FETCH_HEAD'))).toBe(false);
  });

  it('keeps a dry run read-only: no fetch, and unavailable history is refused', () => {
    const { publisher, checkout, migrationsRoot } = repositories();
    // No tag on the remote: unpublished, with no local change at all.
    expect(() =>
      assertSameVersionDraftAppendUnpublished({
        migrationsRoot,
        productVersion: VERSION,
        allowFetch: false,
      })
    ).not.toThrow();
    writeFileSync(join(publisher, 'release.txt'), 'release\n');
    git(publisher, 'add', 'release.txt');
    git(publisher, 'commit', '-m', 'release');
    git(publisher, 'tag', `v${VERSION}`);
    git(publisher, 'push', 'origin', 'main', `refs/tags/v${VERSION}`);
    expect(() =>
      assertSameVersionDraftAppendUnpublished({
        migrationsRoot,
        productVersion: VERSION,
        allowFetch: false,
      })
    ).toThrow(`draft_append_publication_unverifiable:${VERSION}`);
    expect(existsSync(join(checkout, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(
      execFileSync('git', ['tag', '--list'], { cwd: checkout, encoding: 'utf-8' }).trim()
    ).toBe('');
  });

  it('refuses a shallow repository when a release tag exists', () => {
    const { remote, publisher } = repositories();
    git(publisher, 'tag', `v${VERSION}`);
    writeFileSync(join(publisher, 'later.txt'), 'later\n');
    git(publisher, 'add', 'later.txt');
    git(publisher, 'commit', '-m', 'later');
    git(publisher, 'push', 'origin', 'main', `refs/tags/v${VERSION}`);
    const shallow = join(dirname(remote), 'shallow');
    execFileSync(
      'git',
      [
        'clone',
        '--depth',
        '1',
        '--no-tags',
        '--branch',
        'main',
        pathToFileURL(remote).href,
        shallow,
      ],
      {
        stdio: 'ignore',
      }
    );
    mkdirSync(join(shallow, 'migrations'));
    expect(() =>
      assertSameVersionDraftAppendUnpublished({
        migrationsRoot: join(shallow, 'migrations'),
        productVersion: VERSION,
      })
    ).toThrow(`draft_append_publication_unverifiable:${VERSION}`);
  });

  it('fails closed when remote main cannot be fetched or is not tracked', () => {
    const { remote, migrationsRoot } = repositories();
    rmSync(remote, { recursive: true, force: true });
    expect(() =>
      assertSameVersionDraftAppendUnpublished({ migrationsRoot, productVersion: VERSION })
    ).toThrow(`draft_append_publication_unverifiable:${VERSION}`);

    const outside = mkdtempSync(join(tmpdir(), 'authrim-draft-append-nogit-'));
    temporaryDirectories.push(outside);
    mkdirSync(join(outside, 'migrations'));
    expect(() =>
      assertSameVersionDraftAppendUnpublished({
        migrationsRoot: join(outside, 'migrations'),
        productVersion: VERSION,
      })
    ).toThrow(`draft_append_publication_unverifiable:${VERSION}`);
  });
});
