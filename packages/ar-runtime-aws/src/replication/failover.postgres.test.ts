import type { DeploymentFailoverGeneration } from '@authrim/ar-lib-core/services/deployment-replication/authority';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresDeploymentAuthority } from './authority-postgres';
import {
  PostgresReplicationGenerationCatalog,
  type ReplicationGenerationLocation,
} from './generation-catalog';
import type { ReplicationOperationPlan, ReplicationOperationProgress } from './coordinator';
import type { ReplicationJournalRecord } from './journal';
import { advanceReplicationFailover } from './failover';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('test fixture missing');
  return value;
}
type StoredFailoverProgress = ReplicationOperationProgress & {
  failoverProof?: DeploymentFailoverGeneration;
};

const url = process.env.AUTHRIM_AWS_TEST_DATABASE_URL ?? process.env.AUTHRIM_TEST_DATABASE_URL;
(url ? describe : describe.skip)('reviewed standby failover (local native PostgreSQL)', () => {
  const schema = `replication_failover_run_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const authority = new PostgresDeploymentAuthority(pool);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(await readFile(new URL('./authority-schema.sql', import.meta.url), 'utf8'));
    await pool.query(
      await readFile(new URL('./generation-catalog-schema.sql', import.meta.url), 'utf8')
    );
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  async function fixture() {
    const pairId = randomUUID();
    const tenantId = `tenant-${randomUUID()}`;
    const generationId = randomUUID();
    const boundaryUnixMs = Date.now() - 1000;
    const sourceSyncOperationId = randomUUID();
    const sourceSyncPlanSha256 = 'b'.repeat(64);
    await authority.initialize({
      pairId,
      tenantId,
      deployments: [
        { deploymentId: 'cf-a', provider: 'cloudflare' },
        { deploymentId: 'aws-a', provider: 'aws' },
      ],
      initialOwnerDeploymentId: 'cf-a',
      initialGenerationId: 'initial-a',
    });
    const generation: ReplicationGenerationLocation = {
      pairId,
      tenantId,
      deploymentId: 'aws-a',
      generationId,
      epoch: 2,
      location: {
        region: 'ap-northeast-1',
        issuerOrigin: 'https://issuer.example.test',
        bucket: 'replication-example',
        bucketOwner: '123456789012',
        secretArn:
          'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:replication/test-AbCdEf',
        secretVersionId: generationId,
        manifestKey: `generations/${generationId}/manifest.json`,
        manifestVersionId: 'immutable-version',
        manifestSha256: 'c'.repeat(64),
      },
    };
    await new PostgresReplicationGenerationCatalog(pool).register(generation);
    const registered = {
      pairId,
      tenantId,
      sourceSyncOperationId,
      sourceSyncPlanSha256,
      generation: {
        generationId,
        sourceDeploymentId: 'cf-a',
        destinationDeploymentId: 'aws-a',
        sourceEpoch: 1,
        sourceFenceRevision: 1,
        capturedAtMs: boundaryUnixMs,
        manifestSha256: generation.location.manifestSha256,
        verificationSha256: 'd'.repeat(64),
      },
    };
    await authority.registerStandbyGeneration(registered);
    const plan: ReplicationOperationPlan = {
      operationId: randomUUID(),
      pairId,
      tenantId,
      sourceDeploymentId: 'cf-a',
      destinationDeploymentId: 'aws-a',
      expectedEpoch: 1,
      mode: 'failover',
    };
    const standby: ReplicationOperationProgress = {
      formatVersion: 1,
      phase: 'complete',
      plan: { ...plan, operationId: sourceSyncOperationId, mode: 'sync' },
      generationId,
      attempt: 1,
      snapshot: { publication: { boundaryUnixMs } } as ReplicationOperationProgress['snapshot'],
      destination: { generation, verificationSha256: registered.generation.verificationSha256 },
      standby: registered,
      writerAuthorityChanged: false,
    };
    let current: ReplicationJournalRecord<ReplicationOperationProgress> = {
      operationId: plan.operationId,
      planSha256: 'e'.repeat(64),
      revision: 1,
      value: {
        formatVersion: 1,
        phase: 'pending',
        plan,
        generationId: randomUUID(),
        attempt: 1,
        writerAuthorityChanged: false,
      },
    };
    const checkpoint = {
      current: () => structuredClone(current),
      save: async (value: ReplicationOperationProgress) => {
        current = { ...current, revision: current.revision + 1, value: structuredClone(value) };
        return structuredClone(current);
      },
    };
    return {
      plan,
      expectedPlan: plan,
      checkpoint,
      reviewedStandby: { planSha256: sourceSyncPlanSha256, progress: standby },
      maximumSnapshotAgeMs: 60_000,
      authority,
    };
  }

  it('promotes an independently registered snapshot with no source-provider request', async () => {
    const input = await fixture();
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Cloudflare unavailable'));
    try {
      const result = await advanceReplicationFailover(input);
      expect(result.phase).toBe('complete');
      expect(result.writerAuthorityChanged).toBe(true);
      expect(result.cutover?.acceptedDataLoss?.maximumSnapshotAgeMs).toBe(60_000);
      expect(await authority.get(input.plan.pairId, input.plan.tenantId)).toMatchObject({
        ownerDeploymentId: 'aws-a',
        epoch: 2,
        selectedGenerationId: input.reviewedStandby.progress.generationId,
      });
      expect(network).not.toHaveBeenCalled();
      expect(await advanceReplicationFailover(input)).toEqual(result);
    } finally {
      network.mockRestore();
    }
  });
  it('stays drained while a request may still be writing, then resumes without contacting the source', async () => {
    const input = await fixture();
    const permit = {
      pairId: input.plan.pairId,
      tenantId: input.plan.tenantId,
      deploymentId: 'cf-a',
      epoch: 1,
      generationId: 'initial-a',
      permitId: randomUUID(),
      operationDigest: 'f'.repeat(64),
    };
    await authority.enter(permit);
    expect((await advanceReplicationFailover(input)).phase).toBe('draining');
    expect(await authority.get(input.plan.pairId, input.plan.tenantId)).toMatchObject({
      ownerDeploymentId: 'cf-a',
      phase: 'draining',
      outstandingPermits: 1,
    });
    await authority.complete(permit);
    expect((await advanceReplicationFailover(input)).phase).toBe('complete');
  });
  it('recovers a committed promotion with a lost reply without creating a second epoch', async () => {
    const input = await fixture();
    const real = authority.promote.bind(authority);
    const promotion = vi.spyOn(authority, 'promote').mockImplementationOnce(async (identity) => {
      await real(identity);
      throw new Error('reply lost');
    });
    try {
      await expect(advanceReplicationFailover(input)).rejects.toThrow('reply lost');
      expect(input.checkpoint.current().value.phase).toBe('verified');
      expect((await advanceReplicationFailover(input)).phase).toBe('complete');
      expect((await authority.get(input.plan.pairId, input.plan.tenantId)).epoch).toBe(2);
    } finally {
      promotion.mockRestore();
    }
  });
  it('rejects an altered sync receipt before fencing the source', async () => {
    const input = await fixture();
    input.reviewedStandby.planSha256 = '0'.repeat(64);
    await expect(advanceReplicationFailover(input)).rejects.toThrow('replication_failover_invalid');
    expect((await authority.get(input.plan.pairId, input.plan.tenantId)).phase).toBe('active');
  });

  const completedMutations: Array<[string, (progress: StoredFailoverProgress) => void]> = [
    [
      'plan operation',
      (value) => {
        value.plan.operationId = randomUUID();
      },
    ],
    [
      'progress generation',
      (value) => {
        value.generationId = randomUUID();
      },
    ],
    [
      'destination pair',
      (value) => {
        required(value.destination).generation.pairId = randomUUID();
      },
    ],
    [
      'destination tenant',
      (value) => {
        required(value.destination).generation.tenantId = 'other-tenant';
      },
    ],
    [
      'destination deployment',
      (value) => {
        required(value.destination).generation.deploymentId = 'cf-a';
      },
    ],
    [
      'destination epoch',
      (value) => {
        required(value.destination).generation.epoch = 3;
      },
    ],
    [
      'destination manifest',
      (value) => {
        required(value.destination).generation.location.manifestSha256 = '0'.repeat(64);
      },
    ],
    [
      'cutover operation',
      (value) => {
        required(value.cutover).operationId = randomUUID();
      },
    ],
    [
      'cutover pair',
      (value) => {
        required(value.cutover).pairId = randomUUID();
      },
    ],
    [
      'cutover tenant',
      (value) => {
        required(value.cutover).tenantId = 'other-tenant';
      },
    ],
    [
      'cutover destination',
      (value) => {
        required(value.cutover).destinationDeploymentId = 'cf-a';
      },
    ],
    [
      'cutover generation',
      (value) => {
        required(required(value.cutover).generation).generationId = randomUUID();
      },
    ],
    [
      'cutover promoted epoch',
      (value) => {
        required(value.cutover).promotedEpoch = 3;
      },
    ],
    [
      'cutover drain revision',
      (value) => {
        required(value.cutover).drainRevision += 1;
      },
    ],
    [
      'proof source epoch',
      (value) => {
        required(value.failoverProof).generation.sourceEpoch = 2;
      },
    ],
    [
      'proof RPO acceptance',
      (value) => {
        required(value.failoverProof).acceptedDataLoss.maximumSnapshotAgeMs += 1000;
      },
    ],
    [
      'receipt RPO acceptance',
      (value) => {
        required(required(value.cutover).acceptedDataLoss).maximumSnapshotAgeMs += 1000;
      },
    ],
    [
      'proof source plan',
      (value) => {
        required(value.failoverProof).acceptedDataLoss.sourceSyncPlanSha256 = '0'.repeat(64);
      },
    ],
    [
      'receipt acceptance time',
      (value) => {
        required(required(value.cutover).acceptedDataLoss).acceptedAtMs += 1;
      },
    ],
  ];
  it.each(completedMutations)(
    'rejects contradictory completed %s without another authority mutation',
    async (_name, mutate) => {
      const input = await fixture();
      await advanceReplicationFailover(input);
      const completed = input.checkpoint.current().value as StoredFailoverProgress;
      mutate(completed);
      await input.checkpoint.save(completed);
      const promote = vi.spyOn(authority, 'promote');
      const verify = vi.spyOn(authority, 'verifyFailoverGeneration');
      const drain = vi.spyOn(authority, 'beginFailoverDrain');
      try {
        await expect(advanceReplicationFailover(input)).rejects.toThrow();
        expect(promote).not.toHaveBeenCalled();
        expect(verify).not.toHaveBeenCalled();
        expect(drain).not.toHaveBeenCalled();
        expect((await authority.get(input.plan.pairId, input.plan.tenantId)).epoch).toBe(2);
      } finally {
        promote.mockRestore();
        verify.mockRestore();
        drain.mockRestore();
      }
    }
  );

  it.each(['pair', 'tenant', 'deployment', 'generation', 'epoch'] as const)(
    'rejects a selected standby with a contradictory %s before draining',
    async (field) => {
      const input = await fixture();
      const selected = required(input.reviewedStandby.progress.destination).generation;
      if (field === 'pair') selected.pairId = randomUUID();
      if (field === 'tenant') selected.tenantId = 'other-tenant';
      if (field === 'deployment') selected.deploymentId = 'cf-a';
      if (field === 'generation') selected.generationId = randomUUID();
      if (field === 'epoch') selected.epoch = 3;
      const drain = vi.spyOn(authority, 'beginFailoverDrain');
      try {
        await expect(advanceReplicationFailover(input)).rejects.toThrow(
          'replication_failover_invalid'
        );
        expect(drain).not.toHaveBeenCalled();
        expect(await authority.get(input.plan.pairId, input.plan.tenantId)).toMatchObject({
          phase: 'active',
          epoch: 1,
        });
      } finally {
        drain.mockRestore();
      }
    }
  );

  it('compares a locally consistent completed receipt against the durable authority operation', async () => {
    const input = await fixture();
    await advanceReplicationFailover(input);
    const completed = input.checkpoint.current().value as StoredFailoverProgress;
    const cutover = required(completed.cutover);
    const proof = required(completed.failoverProof);
    cutover.drainedAtMs = required(cutover.drainedAtMs) + 1;
    required(cutover.acceptedDataLoss).acceptedAtMs = cutover.drainedAtMs;
    proof.acceptedDataLoss.acceptedAtMs = cutover.drainedAtMs;
    await input.checkpoint.save(completed);
    const read = vi.spyOn(authority, 'getOperation');
    const promote = vi.spyOn(authority, 'promote');
    try {
      await expect(advanceReplicationFailover(input)).rejects.toThrow(
        'replication_failover_invalid'
      );
      expect(read).toHaveBeenCalledTimes(1);
      expect(promote).not.toHaveBeenCalled();
      expect((await authority.get(input.plan.pairId, input.plan.tenantId)).epoch).toBe(2);
    } finally {
      read.mockRestore();
      promote.mockRestore();
    }
  });

  it('fails closed if the durable completed receipt cannot be re-read', async () => {
    const input = await fixture();
    await advanceReplicationFailover(input);
    const read = vi
      .spyOn(authority, 'getOperation')
      .mockRejectedValueOnce(new Error('authority unavailable'));
    const promote = vi.spyOn(authority, 'promote');
    try {
      await expect(advanceReplicationFailover(input)).rejects.toThrow('authority unavailable');
      expect(read).toHaveBeenCalledTimes(1);
      expect(promote).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      promote.mockRestore();
    }
  });
});
