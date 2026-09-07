import { describe, expect, it, vi } from 'vitest';
import type { AuthrimLock } from '../core/lock.js';
import {
  adoptLegacyWorkerDeployments,
  assertInterruptedInitialWorkerDeploymentEvidence,
  assertLegacyWorkerDeploymentAdoptionPersisted,
  type LegacyWorkerDeploymentTarget,
} from '../core/legacy-worker-deployment-adoption.js';

const targets: LegacyWorkerDeploymentTarget[] = [
  {
    component: 'ar-auth',
    workerName: 'conformance-ar-auth',
    expectedPackageVersion: '0.4.0',
  },
  {
    component: 'ar-token',
    workerName: 'conformance-ar-token',
    expectedPackageVersion: '0.4.0',
  },
];

function emptyLock(): AuthrimLock {
  return {
    version: '1.0.0',
    env: 'conformance',
    createdAt: '2026-08-31T00:00:00.000Z',
    d1: {},
    kv: {},
    workers: {},
  };
}

function liveWorkers() {
  return targets.map((target, index) => ({
    name: target.workerName,
    id: target.workerName,
    tag: `immutable-tag-${index}`,
  }));
}

function deployment(name: string, index = 0) {
  return {
    name,
    exists: true,
    lastDeployedAt: `2026-08-31T00:00:0${index}.000Z`,
    author: 'operator@example.com',
    versionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    source: 'Upload',
  };
}

function recover(overrides: Partial<Parameters<typeof adoptLegacyWorkerDeployments>[0]> = {}) {
  return adoptLegacyWorkerDeployments({
    lock: emptyLock(),
    environment: 'conformance',
    authenticatedAccountId: 'account-id',
    configuredAccountId: 'account-id',
    productVersion: '0.4.0',
    targets,
    dependencies: {
      list: async () => liveWorkers(),
      getDeployment: async (name) => deployment(name, name.endsWith('token') ? 1 : 0),
    },
    ...overrides,
  });
}

describe('legacy Worker deployment recovery', () => {
  it('checkpoints canonical script tags, active versions, and expected package versions', async () => {
    const original = emptyLock();
    const result = await recover({ lock: original });

    expect(result.adopted).toHaveLength(2);
    expect(result.lock.workers?.['ar-auth']).toEqual({
      name: 'conformance-ar-auth',
      version: '0.4.0',
      deployedAt: '2026-08-31T00:00:00.000Z',
      cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
      cloudflareScriptTag: 'immutable-tag-0',
    });
    expect(original.workers).toEqual({});
    expect(() =>
      assertLegacyWorkerDeploymentAdoptionPersisted(result.lock, 'conformance', result.adopted)
    ).not.toThrow();
  });

  it('does not adopt an absent canonical Worker unless a completed checkpoint requires it', async () => {
    const list = async () => liveWorkers().filter((worker) => !worker.name.endsWith('token'));
    await expect(
      recover({ dependencies: { list, getDeployment: async (name) => deployment(name) } })
    ).resolves.toMatchObject({ adopted: [{ component: 'ar-auth' }] });
    await expect(
      recover({
        requireAllTargets: true,
        dependencies: { list, getDeployment: async (name) => deployment(name) },
      })
    ).rejects.toThrow(
      'legacy_worker_recovery_evidence_insufficient_delete_or_recreate:conformance-ar-token:missing'
    );
  });

  it('rejects account, environment, and noncanonical target mismatches', async () => {
    await expect(recover({ configuredAccountId: 'other' })).rejects.toThrow(
      'legacy_worker_recovery_account_mismatch'
    );
    await expect(recover({ environment: 'other' })).rejects.toThrow(
      'legacy_worker_recovery_environment_mismatch'
    );
    await expect(
      recover({ targets: [{ ...targets[0], workerName: 'other-ar-auth' }] })
    ).rejects.toThrow('legacy_worker_recovery_target_set_invalid');
  });

  it('rejects duplicate tags and incomplete active deployment evidence', async () => {
    await expect(
      recover({
        dependencies: {
          list: async () => liveWorkers().map((worker) => ({ ...worker, tag: 'same-tag' })),
          getDeployment: async (name) => deployment(name),
        },
      })
    ).rejects.toThrow('legacy_worker_recovery_duplicate_script_tag');

    const getDeployment = vi.fn(async (name: string) => ({
      ...deployment(name),
      source: null,
    }));
    await expect(
      recover({ dependencies: { list: async () => liveWorkers(), getDeployment } })
    ).rejects.toThrow(
      'legacy_worker_recovery_evidence_insufficient_delete_or_recreate:conformance-ar-auth:deployment_metadata'
    );
  });

  it('never overwrites an existing lock identity and rejects failed readback', async () => {
    const lock = emptyLock();
    lock.workers = {
      'ar-auth': {
        name: 'conformance-ar-auth',
        version: '0.4.0',
        deployedAt: '2026-08-31T00:00:00.000Z',
        cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
        cloudflareScriptTag: 'locked-tag',
      },
      'ar-token': {
        name: 'conformance-ar-token',
        version: '0.4.0',
        deployedAt: '2026-08-31T00:00:01.000Z',
        cloudflareVersionId: '00000000-0000-4000-8000-000000000002',
        cloudflareScriptTag: 'locked-token-tag',
      },
    };
    await expect(recover({ lock })).rejects.toThrow('legacy_worker_recovery_not_required');
    await expect(recover({ lock, allowNoop: true })).resolves.toMatchObject({
      adopted: [],
      lock,
    });
    expect(lock.workers['ar-auth']?.cloudflareScriptTag).toBe('locked-tag');

    const result = await recover();
    const corrupted = structuredClone(result.lock);
    corrupted.workers!['ar-auth']!.cloudflareVersionId = '00000000-0000-4000-8000-999999999999';
    expect(() =>
      assertLegacyWorkerDeploymentAdoptionPersisted(corrupted, 'conformance', result.adopted)
    ).toThrow('legacy_worker_recovery_checkpoint_verification_failed:ar-auth');
  });

  it('links an orphan only to the bounded upload window of an interrupted initial deploy', () => {
    const lock = emptyLock();
    lock.releaseUpdate = {
      targetVersion: '0.4.0',
      phase: 'schema_applied',
      manifestChecksum: 'a'.repeat(64),
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:01:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    lock.workerScriptOwnership = {
      'ar-token': {
        name: 'conformance-ar-token',
        cloudflareScriptTag: 'immutable-token-tag',
        state: 'provisional',
        updatedAt: '2026-08-31T00:02:00.000Z',
      },
    };
    const evidence = [
      {
        component: 'ar-auth',
        workerName: 'conformance-ar-auth',
        scriptTag: 'immutable-auth-tag',
        activeVersionId: '00000000-0000-4000-8000-000000000001',
        deployedAt: '2026-08-31T00:02:30.000Z',
        deploymentSource: 'Upload',
        expectedPackageVersion: '0.4.0',
      },
    ];

    expect(() =>
      assertInterruptedInitialWorkerDeploymentEvidence({ lock, evidence })
    ).not.toThrow();
    expect(() =>
      assertInterruptedInitialWorkerDeploymentEvidence({
        lock,
        evidence: [{ ...evidence[0], deployedAt: '2026-08-30T20:00:00.000Z' }],
      })
    ).toThrow('interrupted_worker_recovery_evidence_outside_upload_window:ar-auth');
    expect(() =>
      assertInterruptedInitialWorkerDeploymentEvidence({
        lock,
        evidence: [{ ...evidence[0], deploymentSource: 'Secret Change' }],
      })
    ).toThrow('interrupted_worker_recovery_evidence_outside_upload_window:ar-auth');
  });

  it('requires a durable sibling upload checkpoint before interrupted adoption', () => {
    const lock = emptyLock();
    lock.releaseUpdate = {
      targetVersion: '0.4.0',
      phase: 'schema_applied',
      manifestChecksum: 'a'.repeat(64),
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:01:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    expect(() =>
      assertInterruptedInitialWorkerDeploymentEvidence({
        lock,
        evidence: [
          {
            component: 'ar-auth',
            workerName: 'conformance-ar-auth',
            scriptTag: 'immutable-auth-tag',
            activeVersionId: '00000000-0000-4000-8000-000000000001',
            deployedAt: '2026-08-31T00:01:30.000Z',
            deploymentSource: 'Upload',
            expectedPackageVersion: '0.4.0',
          },
        ],
      })
    ).toThrow('interrupted_worker_recovery_sibling_checkpoint_required');
  });
});
