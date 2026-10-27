import { describe, expect, it, vi } from 'vitest';
import {
  assertDeploymentDrainRequest,
  assertDeploymentAcceptedDataLoss,
  assertDeploymentStandbyGeneration,
  assertDeploymentPairDefinition,
  assertDeploymentVerifiedGeneration,
  assertDeploymentWritePermit,
  runWithDeploymentWritePermit,
  type DeploymentWritePermit,
} from '../authority';

const permit: DeploymentWritePermit = {
  pairId: 'pair-a',
  tenantId: 'tenant-a',
  deploymentId: 'cf-a',
  epoch: 1,
  generationId: 'initial-generation',
  permitId: 'private-operation-a',
  operationDigest: 'a'.repeat(64),
};

describe('deployment writer authority contracts', () => {
  it('accepts either provider as the initial writer without deriving ownership from provider', () => {
    for (const owner of ['cf-a', 'aws-a'])
      expect(() =>
        assertDeploymentPairDefinition({
          pairId: 'pair-a',
          tenantId: 'tenant-a',
          deployments: [
            { deploymentId: 'cf-a', provider: 'cloudflare' },
            { deploymentId: 'aws-a', provider: 'aws' },
          ],
          initialOwnerDeploymentId: owner,
          initialGenerationId: 'initial-generation',
        })
      ).not.toThrow();
  });

  it.each([
    { ...permit, epoch: 0 },
    { ...permit, epoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...permit, generationId: '' },
    { ...permit, permitId: '../other-tenant' },
    { ...permit, operationDigest: 'not-a-digest' },
    { ...permit, expiresAt: 1000 },
    { ...permit, force: true },
  ])('rejects malformed ownership and any implicit expiry/force option', (input) => {
    expect(() => assertDeploymentWritePermit(input)).toThrow('deployment_authority_invalid_input');
  });

  it('rejects same-source switching and a source proof without the drain generation', () => {
    expect(() =>
      assertDeploymentDrainRequest({
        pairId: 'pair-a',
        tenantId: 'tenant-a',
        operationId: 'switch-a',
        sourceDeploymentId: 'cf-a',
        destinationDeploymentId: 'cf-a',
        expectedEpoch: 1,
        expectedRevision: 1,
      })
    ).toThrow('deployment_authority_invalid_input');
    expect(() =>
      assertDeploymentVerifiedGeneration({
        generationId: 'generation-2',
        sourceDeploymentId: 'cf-a',
        destinationDeploymentId: 'aws-a',
        sourceEpoch: 1,
        capturedAtMs: 1000,
        manifestSha256: 'a'.repeat(64),
        verificationSha256: 'b'.repeat(64),
      })
    ).toThrow('deployment_authority_invalid_input');
  });

  it.each([
    { maximumSnapshotAgeMs: 0 },
    { maximumSnapshotAgeMs: -1 },
    { maximumSnapshotAgeMs: Number.MAX_SAFE_INTEGER + 1 },
    { acceptedAtMs: 0 },
    { sourceSyncPlanSha256: 'unverified' },
    { force: true },
  ])('requires explicit finite acceptance and never permits force or ignored fields', (change) => {
    expect(() =>
      assertDeploymentAcceptedDataLoss({
        sourceSyncOperationId: 'sync-a',
        sourceSyncPlanSha256: 'a'.repeat(64),
        maximumSnapshotAgeMs: 60_000,
        acceptedAtMs: 1_800_000_000_000,
        ...change,
      })
    ).toThrow('deployment_authority_invalid_input');
  });

  it('requires a scoped, source-plan-bound standby registration rather than only a digest', () => {
    expect(() =>
      assertDeploymentStandbyGeneration({
        pairId: 'pair-a',
        tenantId: 'tenant-a',
        sourceSyncOperationId: 'sync-a',
        sourceSyncPlanSha256: 'a'.repeat(64),
        generation: { manifestSha256: 'b'.repeat(64) },
      })
    ).toThrow('deployment_authority_invalid_input');
  });

  it('never runs an effect when the authority is unavailable', async () => {
    const effect = vi.fn();
    const complete = vi.fn();
    await expect(
      runWithDeploymentWritePermit(
        {
          enter: () => Promise.reject(new Error('unavailable')),
          complete,
        },
        permit,
        effect
      )
    ).rejects.toThrow('unavailable');
    expect(effect).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('retains an uncertain effect permit and never retries the effect', async () => {
    const error = new Error('transport failed after possible commit');
    const effect = vi.fn(() => Promise.reject(error));
    const complete = vi.fn();
    await expect(
      runWithDeploymentWritePermit(
        {
          enter: async (input) => input,
          complete,
        },
        permit,
        effect
      )
    ).rejects.toBe(error);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects an admission response for a different generation before any effect', async () => {
    const effect = vi.fn();
    const complete = vi.fn();
    await expect(
      runWithDeploymentWritePermit(
        {
          enter: async (input) => ({ ...input, generationId: 'other-generation' }),
          complete,
        },
        permit,
        effect
      )
    ).rejects.toThrow('admission_mismatch');
    expect(effect).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not finish admission before an awaited effect settles', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const complete = vi.fn(async () => undefined);
    const promise = runWithDeploymentWritePermit(
      {
        enter: async (input) => input,
        complete,
      },
      permit,
      async () => {
        await gate;
        return 7;
      }
    );
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    finish();
    await expect(promise).resolves.toBe(7);
    expect(complete).toHaveBeenCalledExactlyOnceWith(permit);
  });

  it('pins the permit before admission and does not replay an effect after lost completion', async () => {
    const callerPermit = structuredClone(permit);
    const complete = vi.fn(() => Promise.reject(new Error('completion response lost')));
    const effect = vi.fn(async () => {
      callerPermit.epoch = 2;
      return 'committed';
    });
    await expect(
      runWithDeploymentWritePermit(
        {
          enter: async (input) => input,
          complete,
        },
        callerPermit,
        effect
      )
    ).rejects.toThrow('completion response lost');
    expect(complete).toHaveBeenCalledExactlyOnceWith(permit);
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
