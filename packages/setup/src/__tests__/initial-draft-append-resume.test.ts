import { describe, expect, it } from 'vitest';
import type { AuthrimLock } from '../core/lock.js';
import {
  calculateReleaseManifestChecksum,
  type ReleaseMigrationManifest,
  type ReleaseMigrationPhysicalTarget,
} from '../core/release-migrations.js';
import { evaluateReleaseDeploymentGuard } from '../core/release-deployment-guard.js';
import {
  evaluateAppendOnlyInitialDraftResume,
  withReleaseUpdateState,
  withSchemaTargetStates,
} from '../core/release-state.js';

const oldManifestChecksum = 'a'.repeat(64);
const firstChecksum = '1'.repeat(64);
const secondChecksum = '2'.repeat(64);
const targetId = 'd1:core-id:core-d1';

const target: ReleaseMigrationPhysicalTarget = {
  id: targetId,
  streamId: 'core-d1',
  driver: 'd1',
  scope: 'deployment',
  logicalRoles: ['core'],
  binding: 'DB',
  databaseId: 'core-id',
  databaseName: 'test-core',
  automatic: true,
};

function manifest(files: Array<{ path: string; checksum: string }>): ReleaseMigrationManifest {
  return {
    formatVersion: 2,
    productVersion: '0.4.0',
    streams: [
      {
        id: 'core-d1',
        schemaFamily: 'core',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['core', 'tenant_core'],
        files,
      },
    ],
  };
}

function interruptedLock(): AuthrimLock {
  return {
    version: '1.0.0',
    env: 'test',
    createdAt: '2026-08-31T00:00:00.000Z',
    d1: { DB: { id: 'core-id', name: 'test-core' } },
    kv: {},
    workers: {},
    releaseUpdate: {
      targetVersion: '0.4.0',
      phase: 'schema_applied',
      manifestChecksum: oldManifestChecksum,
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:01:00.000Z',
      appliedTargets: [targetId],
      manualTargets: [],
    },
    schemaTargets: {
      [targetId]: {
        productVersion: '0.4.0',
        manifestChecksum: oldManifestChecksum,
        streamId: 'core-d1',
        files: [{ path: '001.sql', checksum: firstChecksum }],
        appliedBy: 'automatic',
        updatedAt: '2026-08-31T00:01:00.000Z',
      },
    },
  };
}

function assess(lock: AuthrimLock, current: ReleaseMigrationManifest, isDraft = true) {
  return evaluateAppendOnlyInitialDraftResume({
    lock,
    currentManifest: current,
    currentManifestChecksum: calculateReleaseManifestChecksum(current),
    currentTargets: [target],
    currentManifestIsDraft: isDraft,
  });
}

describe('append-only initial draft resume', () => {
  it('allows an exact forward suffix and advances the durable schema checkpoint', () => {
    const lock = interruptedLock();
    const current = manifest([
      { path: '001.sql', checksum: firstChecksum },
      { path: '002.sql', checksum: secondChecksum },
    ]);
    const currentManifestChecksum = calculateReleaseManifestChecksum(current);

    expect(assess(lock, current)).toEqual({ allowed: true, appendedFileCount: 1 });
    expect(
      evaluateReleaseDeploymentGuard(lock, '0.4.0', 'initial_deploy', {
        releaseManifestChecksum: currentManifestChecksum,
        initialDraft: { manifest: current, targets: [target] },
      })
    ).toMatchObject({ allowed: true, appendOnlyInitialDraftResume: true });

    const withTargets = withSchemaTargetStates(lock, {
      targetIds: [targetId],
      manualTargetIds: new Set(),
      productVersion: '0.4.0',
      manifestChecksum: currentManifestChecksum,
      targetStreamIds: new Map([[targetId, 'core-d1']]),
      manifest: current,
    });
    const advanced = withReleaseUpdateState(withTargets, {
      targetVersion: '0.4.0',
      phase: 'schema_applied',
      manifestChecksum: currentManifestChecksum,
      appliedTargets: [targetId],
    });
    expect(advanced.releaseUpdate?.manifestChecksum).toBe(currentManifestChecksum);
    expect(advanced.schemaTargets?.[targetId]?.files).toEqual(current.streams[0].files);
  });

  it.each([
    ['changed checksum', manifest([{ path: '001.sql', checksum: secondChecksum }])],
    ['removed file', manifest([])],
  ])('rejects %s', (_name, current) => {
    expect(assess(interruptedLock(), current).allowed).toBe(false);
  });

  it('rejects reordered files at the manifest boundary', () => {
    const reordered = manifest([
      { path: '002.sql', checksum: secondChecksum },
      { path: '001.sql', checksum: firstChecksum },
    ]);
    expect(() => assess(interruptedLock(), reordered)).toThrow(
      'Migration paths must be in strict lexicographic execution order'
    );
  });

  it('rejects missing target evidence, changed target identity, and published manifests', () => {
    const current = manifest([
      { path: '001.sql', checksum: firstChecksum },
      { path: '002.sql', checksum: secondChecksum },
    ]);
    const missingEvidence = interruptedLock();
    delete missingEvidence.schemaTargets;
    expect(assess(missingEvidence, current).allowed).toBe(false);
    const incompleteAppliedTargets = interruptedLock();
    incompleteAppliedTargets.releaseUpdate!.appliedTargets = [];
    expect(assess(incompleteAppliedTargets, current)).toEqual({
      allowed: false,
      reason: 'target_evidence_missing',
    });
    const unknownAppliedTarget = interruptedLock();
    unknownAppliedTarget.releaseUpdate!.appliedTargets = [targetId, 'd1:unknown:core-d1'];
    expect(assess(unknownAppliedTarget, current)).toEqual({
      allowed: false,
      reason: 'target_evidence_missing',
    });
    expect(
      evaluateAppendOnlyInitialDraftResume({
        lock: interruptedLock(),
        currentManifest: current,
        currentManifestChecksum: calculateReleaseManifestChecksum(current),
        currentTargets: [{ ...target, id: 'd1:other-id:core-d1' }],
        currentManifestIsDraft: true,
      }).allowed
    ).toBe(false);
    expect(assess(interruptedLock(), current, false)).toEqual({
      allowed: false,
      reason: 'not_draft',
    });
  });
});
