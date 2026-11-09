import {
  LOG_ICEBERG_READINESS_SCHEMA_VERSION,
  logIcebergReadinessAttemptDigest,
  type LogIcebergReadinessResult,
} from '@authrim/ar-lib-core/services/log-iceberg-readiness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceLogArchiveReadiness } from '../log-archive-readiness';
import type { ControlEnv } from '../types';

const signRequest = vi.hoisted(() => vi.fn());
vi.mock('../runtime-smoke-signer', () => ({ signControlRuntimeSmokeRequest: signRequest }));

const attempt = {
  attemptId: '12345678-1234-4123-8123-123456789abc',
  startedAt: '2026-11-09T00:00:00.000Z',
  deploymentFingerprint: 'a'.repeat(64),
};

function environment(probe = vi.fn()) {
  return {
    env: {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      SMOKE_AR_MANAGEMENT: { probeLogArchive: probe },
    } as unknown as ControlEnv,
    probe,
  };
}

describe('Control log archive readiness handoff', () => {
  beforeEach(() => {
    signRequest.mockReset().mockResolvedValue('signed-probe-token');
  });

  it('signs a fixed Management binding probe derived from the validated attempt', async () => {
    const { env, probe } = environment();
    const expected = { ...attempt, state: 'pending' } as unknown as LogIcebergReadinessResult;
    probe.mockResolvedValue(expected);

    await expect(advanceLogArchiveReadiness(env, attempt)).resolves.toBe(expected);
    expect(signRequest).toHaveBeenCalledWith({
      env,
      request: {
        environmentId: 'test',
        operationId: `log_archive_probe_v1:${await logIcebergReadinessAttemptDigest(attempt)}`,
        attempt: 1,
        targetWorker: 'test-ar-management',
        bindingRef: 'LOG_ARCHIVE',
        expectedMigrationGeneration: LOG_ICEBERG_READINESS_SCHEMA_VERSION,
        dataRole: 'tenant_core/default',
        residencyPartition: 'platform',
      },
    });
    expect(probe).toHaveBeenCalledExactlyOnceWith({ token: 'signed-probe-token', attempt });
  });

  it('copies the attempt before awaiting the digest so a caller mutation cannot change the probe', async () => {
    const { env, probe } = environment();
    probe.mockResolvedValue({ state: 'pending' });
    const mutable = { ...attempt };
    const expectedDigest = await logIcebergReadinessAttemptDigest(mutable);

    const pending = advanceLogArchiveReadiness(env, mutable);
    mutable.deploymentFingerprint = 'b'.repeat(64);
    await pending;

    const signed = signRequest.mock.calls[0]?.[0] as { request: { operationId: string } };
    const probed = probe.mock.calls[0]?.[0] as { attempt: typeof attempt };
    expect(signed.request.operationId).toBe(`log_archive_probe_v1:${expectedDigest}`);
    expect(probed.attempt.deploymentFingerprint).toBe('a'.repeat(64));
  });

  it.each([
    [{ ...attempt, attemptId: '../other' }],
    [{ ...attempt, deploymentFingerprint: 'not-a-digest' }],
    [{ ...attempt, extra: 'caller payload' }],
  ])('rejects malformed attempts before signing or probing', async (malformed) => {
    const { env, probe } = environment();
    await expect(advanceLogArchiveReadiness(env, malformed)).rejects.toThrow(
      'log_iceberg_probe_attempt_invalid'
    );
    expect(signRequest).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('fails closed if the environment or private probe binding is absent', async () => {
    const { env, probe } = environment();
    await expect(
      advanceLogArchiveReadiness({ ...env, AUTHRIM_ENVIRONMENT_NAME: '' }, attempt)
    ).rejects.toThrow('runtime_smoke_log_archive_binding_unavailable');
    await expect(
      advanceLogArchiveReadiness({ ...env, SMOKE_AR_MANAGEMENT: undefined }, attempt)
    ).rejects.toThrow('runtime_smoke_log_archive_binding_unavailable');
    expect(signRequest).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not call Management if request signing fails', async () => {
    const { env, probe } = environment();
    signRequest.mockRejectedValue(new Error('signing_failed'));
    await expect(advanceLogArchiveReadiness(env, attempt)).rejects.toThrow('signing_failed');
    expect(probe).not.toHaveBeenCalled();
  });
});
