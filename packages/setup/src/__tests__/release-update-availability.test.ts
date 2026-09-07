import { describe, expect, it } from 'vitest';
import { AuthrimLockSchema } from '../core/lock.js';
import { evaluateReleaseUpdateAvailability } from '../core/release-update-availability.js';

function lock(input: Record<string, unknown> = {}) {
  return AuthrimLockSchema.parse({
    version: '1.0.0',
    productVersion: '1.0.0',
    env: 'prod',
    createdAt: '2026-08-16T00:00:00.000Z',
    d1: {},
    kv: {},
    ...input,
  });
}

describe('release update availability', () => {
  it('offers a forward product update and reports an exact current release', () => {
    expect(evaluateReleaseUpdateAvailability(lock(), '1.1.0')).toMatchObject({
      status: 'update_available',
      currentVersion: '1.0.0',
      targetVersion: '1.1.0',
      canUpdate: true,
    });
    expect(evaluateReleaseUpdateAvailability(lock(), '1.0.0').status).toBe('up_to_date');
  });

  it('resumes only the same incomplete target release', () => {
    const updating = lock({
      releaseUpdate: {
        targetVersion: '1.1.0',
        previousProductVersion: '1.0.0',
        phase: 'schema_applied',
        manifestChecksum: 'a'.repeat(64),
        startedAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:01:00.000Z',
      },
    });
    expect(evaluateReleaseUpdateAvailability(updating, '1.1.0')).toMatchObject({
      status: 'resume_available',
      phase: 'schema_applied',
      canUpdate: true,
    });
    expect(evaluateReleaseUpdateAvailability(updating, '1.2.0')).toMatchObject({
      status: 'blocked',
      canUpdate: false,
    });

    for (const phase of ['control_handoff', 'awaiting_setup'] as const) {
      const handedOff = lock({
        releaseUpdate: {
          ...updating.releaseUpdate,
          phase,
          controlOperationId: `op_release_rollout_${'a'.repeat(32)}`,
        },
      });
      expect(evaluateReleaseUpdateAvailability(handedOff, '1.1.0')).toMatchObject({
        status: 'resume_available',
        phase,
        canUpdate: true,
      });
    }
  });

  it('fails closed for an older setup source and permits legacy reconciliation', () => {
    expect(
      evaluateReleaseUpdateAvailability(lock({ productVersion: '1.2.0' }), '1.1.0')
    ).toMatchObject({ status: 'setup_tool_older', canUpdate: false });
    expect(
      evaluateReleaseUpdateAvailability(
        lock({ productVersion: undefined, workers: { 'ar-auth': { name: 'prod-ar-auth' } } }),
        '1.1.0'
      )
    ).toMatchObject({ status: 'reconciliation_required', canUpdate: true });
  });

  it('offers the full Worker update after a verified database-only update', () => {
    const databaseOnly = lock({
      releaseUpdate: {
        targetVersion: '1.1.0',
        previousProductVersion: '1.0.0',
        phase: 'database_only_verified',
        manifestChecksum: 'a'.repeat(64),
        startedAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:01:00.000Z',
      },
    });

    expect(evaluateReleaseUpdateAvailability(databaseOnly, '1.1.0')).toMatchObject({
      status: 'update_available',
      currentVersion: '1.0.0',
      targetVersion: '1.1.0',
      canUpdate: true,
    });
  });
});
