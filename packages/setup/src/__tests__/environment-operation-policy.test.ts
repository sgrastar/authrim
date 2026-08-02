import { describe, expect, it } from 'vitest';
import {
  classifyEnvironmentLifecycle,
  evaluateEnvironmentOperation,
  type EnvironmentOperationKind,
} from '../core/environment-operation-policy.js';
import type { AuthrimLock } from '../core/lock.js';

const checksum = 'a'.repeat(64);

function lock(
  input: {
    productVersion?: string;
    workers?: Record<string, { name: string; version?: string }>;
    release?: AuthrimLock['releaseUpdate'];
  } = {}
): AuthrimLock {
  return {
    version: '1.0.0',
    env: 'test',
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    d1: {},
    kv: {},
    ...(input.productVersion ? { productVersion: input.productVersion } : {}),
    ...(input.workers ? { workers: input.workers } : {}),
    ...(input.release ? { releaseUpdate: input.release } : {}),
  };
}

const updatingRelease: AuthrimLock['releaseUpdate'] = {
  targetVersion: '1.1.0',
  previousProductVersion: '1.0.0',
  phase: 'schema_applied',
  manifestChecksum: checksum,
  startedAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:01:00.000Z',
  appliedTargets: [],
  manualTargets: [],
};

describe('environment operation policy', () => {
  it('allows deletion recovery when remote resources remain after local cleanup', () => {
    expect(
      evaluateEnvironmentOperation({
        operation: 'delete',
        lock: null,
        environmentObservedRemotely: true,
      })
    ).toMatchObject({ allowed: true, lifecycle: 'absent' });
  });

  it('classifies every persisted lifecycle shape centrally', () => {
    expect(classifyEnvironmentLifecycle()).toBe('absent');
    expect(classifyEnvironmentLifecycle(lock())).toBe('provisioned');
    expect(
      classifyEnvironmentLifecycle(lock({ workers: { 'ar-auth': { name: 'test-ar-auth' } } }))
    ).toBe('legacy');
    expect(
      classifyEnvironmentLifecycle(lock({ productVersion: '1.0.0', release: updatingRelease }))
    ).toBe('updating');
    expect(classifyEnvironmentLifecycle(lock({ productVersion: '1.0.0' }))).toBe('deployed');
    expect(
      classifyEnvironmentLifecycle(
        lock({
          productVersion: '1.0.0',
          release: { ...updatingRelease, phase: 'verified', targetVersion: '1.1.0' },
        })
      )
    ).toBe('inconsistent');
  });

  it('enforces the operation-by-lifecycle decision table', () => {
    const operations: EnvironmentOperationKind[] = [
      'provision',
      'initial_deploy',
      'release_update',
      'worker_redeploy',
      'topology_change',
      'manual_migration',
      'config_mutation',
      'structure_migration',
      'delete',
    ];
    const cases: Array<{
      name: string;
      value?: AuthrimLock;
      targetVersion: string;
      allowed: EnvironmentOperationKind[];
    }> = [
      {
        name: 'absent',
        targetVersion: '1.1.0',
        allowed: ['provision', 'config_mutation'],
      },
      {
        name: 'provisioned',
        value: lock(),
        targetVersion: '1.1.0',
        allowed: ['initial_deploy', 'config_mutation', 'structure_migration', 'delete'],
      },
      {
        name: 'legacy',
        value: lock({ workers: { 'ar-auth': { name: 'test-ar-auth', version: '1.0.0' } } }),
        targetVersion: '1.1.0',
        allowed: ['release_update', 'structure_migration', 'delete'],
      },
      {
        name: 'updating',
        value: lock({ productVersion: '1.0.0', release: updatingRelease }),
        targetVersion: '1.1.0',
        allowed: ['release_update', 'delete'],
      },
      {
        name: 'deployed-same',
        value: lock({ productVersion: '1.1.0' }),
        targetVersion: '1.1.0',
        allowed: [
          'release_update',
          'worker_redeploy',
          'topology_change',
          'manual_migration',
          'config_mutation',
          'structure_migration',
          'delete',
        ],
      },
      {
        name: 'deployed-different',
        value: lock({ productVersion: '1.0.0' }),
        targetVersion: '1.1.0',
        allowed: ['release_update', 'structure_migration', 'delete'],
      },
    ];

    for (const testCase of cases) {
      for (const operation of operations) {
        expect(
          evaluateEnvironmentOperation({
            operation,
            lock: testCase.value,
            targetVersion: testCase.targetVersion,
          }).allowed,
          `${testCase.name}:${operation}`
        ).toBe(testCase.allowed.includes(operation));
      }
    }
  });

  it('allows only the matching release update to resume', () => {
    const value = lock({ productVersion: '1.0.0', release: updatingRelease });
    expect(
      evaluateEnvironmentOperation({
        operation: 'release_update',
        lock: value,
        targetVersion: '1.1.0',
      }).allowed
    ).toBe(true);
    expect(
      evaluateEnvironmentOperation({
        operation: 'release_update',
        lock: value,
        targetVersion: '1.2.0',
      }).reason
    ).toBe('release_update_in_progress');
  });

  it('allows an exact initial deployment to resume without weakening release updates', () => {
    const value = lock({
      release: {
        ...updatingRelease,
        previousProductVersion: undefined,
      },
    });
    expect(
      evaluateEnvironmentOperation({
        operation: 'initial_deploy',
        lock: value,
        targetVersion: '1.1.0',
        releaseManifestChecksum: checksum,
      }).allowed
    ).toBe(true);
    expect(
      evaluateEnvironmentOperation({
        operation: 'initial_deploy',
        lock: value,
        targetVersion: '1.1.0',
        releaseManifestChecksum: 'b'.repeat(64),
      }).reason
    ).toBe('release_update_in_progress');
  });

  it('fails closed when a same-version operation omits its target version', () => {
    expect(
      evaluateEnvironmentOperation({
        operation: 'worker_redeploy',
        lock: lock({ productVersion: '1.0.0' }),
      }).reason
    ).toBe('target_version_required');
  });

  it('requires a target version and rejects release downgrades centrally', () => {
    const value = lock({ productVersion: '1.1.0' });
    expect(
      evaluateEnvironmentOperation({
        operation: 'release_update',
        lock: value,
      }).reason
    ).toBe('target_version_required');
    expect(
      evaluateEnvironmentOperation({
        operation: 'release_update',
        lock: value,
        targetVersion: '1.0.0',
      }).reason
    ).toBe('product_downgrade_not_supported');
  });

  it('allows only release update or delete to repair inconsistent release evidence', () => {
    const value = lock({
      productVersion: '1.0.0',
      release: { ...updatingRelease, phase: 'verified', targetVersion: '1.1.0' },
    });
    expect(
      evaluateEnvironmentOperation({
        operation: 'release_update',
        lock: value,
        targetVersion: '1.1.0',
      }).allowed
    ).toBe(true);
    expect(
      evaluateEnvironmentOperation({
        operation: 'worker_redeploy',
        lock: value,
        targetVersion: '1.0.0',
      }).reason
    ).toBe('inconsistent_release_state');
    expect(
      evaluateEnvironmentOperation({
        operation: 'structure_migration',
        lock: value,
        targetVersion: '1.1.0',
      }).reason
    ).toBe('inconsistent_release_state');
  });

  it.each(['config_staged', 'preparing', 'pending_deploy'] as const)(
    'blocks unrelated operations while topology is %s',
    (phase) => {
      const value = lock({ productVersion: '1.0.0' });
      value.topologyUpdate = {
        kind: 'r2',
        phase,
        targetProductVersion: '1.0.0',
        configChecksum: 'a'.repeat(64),
        authorizationTokenHash: 'b'.repeat(64),
        startedAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
      };

      expect(
        evaluateEnvironmentOperation({
          operation: 'config_mutation',
          lock: value,
          targetVersion: '1.0.0',
        }).reason
      ).toBe('topology_update_in_progress');
      expect(
        evaluateEnvironmentOperation({
          operation: 'topology_change',
          lock: value,
          targetVersion: '1.0.0',
        }).allowed
      ).toBe(true);
    }
  );
});
