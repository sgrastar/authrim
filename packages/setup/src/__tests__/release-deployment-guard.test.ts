import { describe, expect, it } from 'vitest';
import { AuthrimLockSchema } from '../core/lock.js';
import { evaluateReleaseDeploymentGuard } from '../core/release-deployment-guard.js';

function lock(input: {
  productVersion?: string;
  workerVersions?: Array<string | undefined>;
  releaseUpdatePhase?: 'planned' | 'schema_applied' | 'workers_deployed' | 'verified';
}) {
  return AuthrimLockSchema.parse({
    version: '1.0.0',
    ...(input.productVersion ? { productVersion: input.productVersion } : {}),
    createdAt: '2026-07-21T00:00:00.000Z',
    env: 'prod',
    d1: {},
    kv: {},
    workers: Object.fromEntries(
      (input.workerVersions ?? []).map((version, index) => [
        `worker-${index}`,
        { name: `worker-${index}`, ...(version ? { version } : {}) },
      ])
    ),
    ...(input.releaseUpdatePhase
      ? {
          releaseUpdate: {
            targetVersion: '1.1.0',
            previousProductVersion: input.productVersion,
            phase: input.releaseUpdatePhase,
            manifestChecksum: 'a'.repeat(64),
            startedAt: '2026-07-21T00:00:00.000Z',
            updatedAt: '2026-07-21T00:00:00.000Z',
            appliedTargets: [],
            manualTargets: [],
          },
        }
      : {}),
  });
}

const checksum = 'a'.repeat(64);

describe('release deployment guard', () => {
  it('allows initial deployments only when the caller declares a complete initial deploy', () => {
    expect(evaluateReleaseDeploymentGuard(lock({}), '1.1.0', 'worker_redeploy').allowed).toBe(
      false
    );
    expect(evaluateReleaseDeploymentGuard(lock({}), '1.1.0', 'initial_deploy').allowed).toBe(true);
    expect(
      evaluateReleaseDeploymentGuard(
        lock({ productVersion: '1.1.0', workerVersions: ['1.1.0'] }),
        '1.1.0',
        'worker_redeploy'
      ).allowed
    ).toBe(true);
  });

  it('requires release update for product changes or ambiguous legacy locks', () => {
    expect(
      evaluateReleaseDeploymentGuard(
        lock({ productVersion: '1.0.0', workerVersions: ['1.0.0'] }),
        '1.1.0',
        'worker_redeploy'
      ).reason
    ).toBe('release_update_required');
    expect(
      evaluateReleaseDeploymentGuard(lock({ productVersion: '1.0.0' }), '1.1.0', 'worker_redeploy')
        .reason
    ).toBe('release_update_required');
    expect(
      evaluateReleaseDeploymentGuard(
        lock({ workerVersions: ['1.0.0'] }),
        '1.1.0',
        'worker_redeploy'
      ).reason
    ).toBe('release_update_required');
    expect(
      evaluateReleaseDeploymentGuard(
        lock({ workerVersions: [undefined] }),
        '1.1.0',
        'worker_redeploy'
      ).reason
    ).toBe('unknown_worker_version');
    expect(
      evaluateReleaseDeploymentGuard(
        lock({ workerVersions: ['1.0.0', '1.1.0'] }),
        '1.1.0',
        'worker_redeploy'
      ).reason
    ).toBe('mixed_worker_versions');
    expect(
      evaluateReleaseDeploymentGuard(
        lock({ productVersion: '1.0.0', releaseUpdatePhase: 'schema_applied' }),
        '1.1.0',
        'worker_redeploy'
      ).reason
    ).toBe('release_update_in_progress');
    expect(
      evaluateReleaseDeploymentGuard(
        lock({
          productVersion: '1.1.0',
          workerVersions: ['1.0.0', undefined],
          releaseUpdatePhase: 'verified',
        }),
        '1.1.0',
        'worker_redeploy'
      ).allowed
    ).toBe(true);
  });

  it('resumes only an exact initial release and rejects ambiguous Worker evidence', () => {
    const interrupted = lock({ releaseUpdatePhase: 'schema_applied' });
    expect(
      evaluateReleaseDeploymentGuard(interrupted, '1.1.0', 'initial_deploy', {
        releaseManifestChecksum: checksum,
      }).allowed
    ).toBe(true);
    expect(
      evaluateReleaseDeploymentGuard(interrupted, '1.1.0', 'initial_deploy', {
        releaseManifestChecksum: 'b'.repeat(64),
      }).reason
    ).toBe('initial_manifest_changed');
    expect(
      evaluateReleaseDeploymentGuard(
        lock({ workerVersions: ['1.1.0'], releaseUpdatePhase: 'schema_applied' }),
        '1.1.0',
        'initial_deploy',
        { releaseManifestChecksum: checksum }
      ).allowed
    ).toBe(true);
    expect(
      evaluateReleaseDeploymentGuard(
        lock({ workerVersions: [undefined], releaseUpdatePhase: 'schema_applied' }),
        '1.1.0',
        'initial_deploy',
        { releaseManifestChecksum: checksum }
      ).reason
    ).toBe('release_update_in_progress');
  });
});
