import { describe, expect, it, vi } from 'vitest';
import {
  loadSigningKeyVerificationStatus,
  waitForSigningKeyVerification,
} from '../core/signing-key-verification.js';

const targets = ['test-ar-auth', 'test-ar-management'];

function succeeded(worker: string, updatedAt = 101) {
  return {
    worker_script_name: worker,
    status: 'succeeded',
    last_error_code: null,
    verified_at: updatedAt,
    updated_at: updatedAt,
  };
}

describe('setup signing-key verification gate', () => {
  it('completes only when every expected target has fresh successful evidence', async () => {
    const query = vi.fn(async () => targets.map((target) => succeeded(target)));
    await expect(
      loadSigningKeyVerificationStatus({
        controlDatabaseName: 'test-control',
        environmentId: 'test',
        purpose: 'smoke_rpc',
        keyId: 'smoke-v2',
        expectedWorkerScriptNames: targets,
        stagedAt: 100,
        query,
      })
    ).resolves.toEqual({
      complete: true,
      expected: 2,
      succeeded: 2,
      failed: 0,
      pending: [],
      failures: [],
    });
    expect(query.mock.calls[0]?.[1]).toContain("evidence.key_id = 'smoke-v2'");
    expect(query.mock.calls[0]?.[1]).toContain('key_state.updated_at = 100');
  });

  it('reports pending and retryable failures without treating them as complete', async () => {
    await expect(
      loadSigningKeyVerificationStatus({
        controlDatabaseName: 'test-control',
        environmentId: 'test',
        purpose: 'runtime_registry',
        keyId: 'registry-v2',
        expectedWorkerScriptNames: targets,
        stagedAt: 100,
        query: vi.fn(async () => [
          {
            worker_script_name: 'test-ar-auth',
            status: 'failed',
            last_error_code: 'runtime_key_verification_registry_keys_unavailable',
            verified_at: null,
            updated_at: 101,
          },
        ]),
      })
    ).resolves.toEqual({
      complete: false,
      expected: 2,
      succeeded: 0,
      failed: 1,
      pending: ['test-ar-management'],
      failures: [
        {
          workerScriptName: 'test-ar-auth',
          errorCode: 'runtime_key_verification_registry_keys_unavailable',
        },
      ],
    });
  });

  it('fails closed for stale or unexpected evidence', async () => {
    await expect(
      loadSigningKeyVerificationStatus({
        controlDatabaseName: 'test-control',
        environmentId: 'test',
        purpose: 'smoke_rpc',
        keyId: 'smoke-v2',
        expectedWorkerScriptNames: targets,
        stagedAt: 100,
        query: vi.fn(async () => [{ ...succeeded('test-ar-auth'), updated_at: 0 }]),
      })
    ).rejects.toThrow('signing_key_verification_evidence_invalid');
    await expect(
      loadSigningKeyVerificationStatus({
        controlDatabaseName: 'test-control',
        environmentId: 'test',
        purpose: 'smoke_rpc',
        keyId: 'smoke-v2',
        expectedWorkerScriptNames: targets,
        stagedAt: 100,
        query: vi.fn(async () => [succeeded('test-ar-token')]),
      })
    ).rejects.toThrow('signing_key_verification_evidence_invalid');
  });

  it('polls until the scheduled Control verifier records all targets', async () => {
    let now = 1_000;
    const query = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([succeeded('test-ar-auth')])
      .mockResolvedValueOnce(targets.map((target) => succeeded(target)));
    const sleep = vi.fn(async (delay: number) => {
      now += delay;
    });

    await expect(
      waitForSigningKeyVerification({
        controlDatabaseName: 'test-control',
        environmentId: 'test',
        purpose: 'smoke_rpc',
        keyId: 'smoke-v2',
        expectedWorkerScriptNames: targets,
        stagedAt: 100,
        query,
        timeoutMs: 1_000,
        pollIntervalMs: 100,
        now: () => now,
        sleep,
      })
    ).resolves.toMatchObject({ complete: true, succeeded: 2 });
    expect(query).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
