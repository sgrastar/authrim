import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DeploymentDrainRequest,
  DeploymentFailoverGeneration,
  DeploymentStandbyGeneration,
} from '@authrim/ar-lib-core/services/deployment-replication/authority';
import { PostgresDeploymentAuthority } from './authority-postgres';
import { PostgresReplicationGenerationCatalog } from './generation-catalog';

const url = process.env.AUTHRIM_AWS_TEST_DATABASE_URL ?? process.env.AUTHRIM_TEST_DATABASE_URL;
const location = {
  region: 'ap-northeast-1',
  issuerOrigin: 'https://idp.example.test',
  secretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:synthetic-abcdef',
  secretVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  bucket: 'authrim-local-replication',
  bucketOwner: '123456789012',
  manifestKey: 'generation/manifest.json',
  manifestVersionId: 'immutable-version',
  manifestSha256: 'a'.repeat(64),
};

(url ? describe : describe.skip)('explicit failover with native PostgreSQL authority', () => {
  const schema = `replication_failover_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 });
  const authority = new PostgresDeploymentAuthority(pool);
  const catalog = new PostgresReplicationGenerationCatalog(pool);
  let created = false;
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    for (const file of ['authority-schema.sql', 'generation-catalog-schema.sql'])
      await pool.query(await readFile(new URL(file, import.meta.url), 'utf8'));
  });
  afterAll(async () => {
    await pool.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  async function fixture(
    input: { catalog?: boolean; standby?: boolean; capturedAtMs?: number } = {}
  ) {
    const pairId = randomUUID();
    const tenantId = randomUUID();
    await authority.initialize({
      pairId,
      tenantId,
      deployments: [
        { deploymentId: 'cf-a', provider: 'cloudflare' },
        { deploymentId: 'aws-a', provider: 'aws' },
      ],
      initialOwnerDeploymentId: 'cf-a',
      initialGenerationId: 'initial',
    });
    const standby: DeploymentStandbyGeneration = {
      pairId,
      tenantId,
      sourceSyncOperationId: randomUUID(),
      sourceSyncPlanSha256: 'b'.repeat(64),
      generation: {
        generationId: randomUUID(),
        sourceDeploymentId: 'cf-a',
        destinationDeploymentId: 'aws-a',
        sourceEpoch: 1,
        sourceFenceRevision: 1,
        capturedAtMs: input.capturedAtMs ?? Date.now() - 1000,
        manifestSha256: location.manifestSha256,
        verificationSha256: 'c'.repeat(64),
      },
    };
    if (input.catalog !== false)
      await catalog.register({
        pairId,
        tenantId,
        deploymentId: 'aws-a',
        generationId: standby.generation.generationId,
        epoch: 2,
        location,
      });
    if (input.standby !== false) await authority.registerStandbyGeneration(standby);
    const request: DeploymentDrainRequest = {
      pairId,
      tenantId,
      operationId: randomUUID(),
      sourceDeploymentId: 'cf-a',
      destinationDeploymentId: 'aws-a',
      expectedEpoch: 1,
      expectedRevision: 1,
    };
    const identity = { pairId, tenantId, operationId: request.operationId };
    const drain = async (maximumSnapshotAgeMs = 60_000) => {
      const operation = await authority.beginFailoverDrain(request);
      const proof: DeploymentFailoverGeneration = {
        generation: standby.generation,
        acceptedDataLoss: {
          sourceSyncOperationId: standby.sourceSyncOperationId,
          sourceSyncPlanSha256: standby.sourceSyncPlanSha256,
          maximumSnapshotAgeMs,
          acceptedAtMs: operation.drainedAtMs ?? 1,
        },
      };
      return { operation, proof };
    };
    return { pairId, tenantId, standby, request, identity, drain };
  }

  it('requires the immutable catalog and exact manifest before registering a verified standby', async () => {
    const f = await fixture({ catalog: false, standby: false });
    await expect(authority.registerStandbyGeneration(f.standby)).rejects.toThrow(
      'standby_unregistered'
    );
    await catalog.register({
      pairId: f.pairId,
      tenantId: f.tenantId,
      deploymentId: 'aws-a',
      generationId: f.standby.generation.generationId,
      epoch: 2,
      location: { ...location, manifestSha256: 'd'.repeat(64) },
    });
    await expect(authority.registerStandbyGeneration(f.standby)).rejects.toThrow(
      'generation_mismatch'
    );
    expect(
      (
        await pool.query('SELECT 1 FROM authrim_replication_standby_generations WHERE pair_id=$1', [
          f.pairId,
        ])
      ).rowCount
    ).toBe(0);
  });

  it('pins one standby per source operation without changing authority or accepting altered proof', async () => {
    const f = await fixture();
    await authority.registerStandbyGeneration(f.standby);
    await expect(
      authority.registerStandbyGeneration({ ...f.standby, sourceSyncPlanSha256: 'd'.repeat(64) })
    ).rejects.toThrow('idempotency_conflict');
    await expect(
      authority.registerStandbyGeneration({
        ...f.standby,
        generation: { ...f.standby.generation, generationId: randomUUID() },
      })
    ).rejects.toThrow('idempotency_conflict');
    expect(await authority.get(f.pairId, f.tenantId)).toMatchObject({
      ownerDeploymentId: 'cf-a',
      epoch: 1,
      phase: 'active',
      outstandingPermits: 0,
    });
  });

  it('promotes a pre-drain verified copy only with explicit bounded data-loss acceptance', async () => {
    const f = await fixture();
    const { operation, proof } = await f.drain();
    expect(proof.generation.capturedAtMs).toBeLessThan(operation.drainedAtMs ?? 0);
    await expect(authority.verifyGeneration(f.identity, proof.generation)).rejects.toThrow(
      'operation_kind_mismatch'
    );
    const verified = await authority.verifyFailoverGeneration(f.identity, proof);
    expect(verified).toMatchObject({
      kind: 'failover',
      state: 'verified',
      acceptedDataLoss: proof.acceptedDataLoss,
    });
    const promoted = await authority.promote(f.identity);
    expect(promoted.promotedEpoch).toBe(2);
    const restart = new PostgresDeploymentAuthority(pool);
    expect(await restart.verifyFailoverGeneration(f.identity, proof)).toEqual(promoted);
    expect(await restart.promote(f.identity)).toEqual(promoted);
    expect(await restart.get(f.pairId, f.tenantId)).toMatchObject({
      ownerDeploymentId: 'aws-a',
      selectedGenerationId: proof.generation.generationId,
      epoch: 2,
      phase: 'active',
    });
  });

  it('does not weaken planned switching or allow operation kind rebinding', async () => {
    const f = await fixture();
    const planned = await authority.beginDrain(f.request);
    await expect(authority.beginFailoverDrain(f.request)).rejects.toThrow('idempotency_conflict');
    const proof = {
      generation: f.standby.generation,
      acceptedDataLoss: {
        sourceSyncOperationId: f.standby.sourceSyncOperationId,
        sourceSyncPlanSha256: f.standby.sourceSyncPlanSha256,
        maximumSnapshotAgeMs: 60_000,
        acceptedAtMs: planned.drainedAtMs ?? 1,
      },
    };
    await expect(authority.verifyFailoverGeneration(f.identity, proof)).rejects.toThrow(
      'operation_kind_mismatch'
    );
    await expect(
      authority.verifyGeneration(f.identity, {
        ...f.standby.generation,
        sourceFenceRevision: planned.drainRevision,
      })
    ).rejects.toThrow('generation_mismatch');
    expect((await authority.get(f.pairId, f.tenantId)).epoch).toBe(1);
  });

  it('never clears outstanding permits to satisfy an outage failover', async () => {
    const f = await fixture();
    const permit = {
      pairId: f.pairId,
      tenantId: f.tenantId,
      deploymentId: 'cf-a',
      epoch: 1,
      generationId: 'initial',
      permitId: randomUUID(),
      operationDigest: 'a'.repeat(64),
    };
    await authority.enter(permit);
    const { proof } = await f.drain();
    await expect(authority.verifyFailoverGeneration(f.identity, proof)).rejects.toThrow(
      'unresolved_permits'
    );
    await expect(authority.promote(f.identity)).rejects.toThrow('unresolved_permits');
    expect(
      (await new PostgresDeploymentAuthority(pool).get(f.pairId, f.tenantId)).outstandingPermits
    ).toBe(1);
    await expect(authority.enter({ ...permit, permitId: randomUUID() })).rejects.toThrow(
      'writer_draining'
    );
  });

  it.each(['missing', 'plan', 'operation', 'verification'] as const)(
    'rejects %s standby evidence with no epoch change',
    async (kind) => {
      const f = await fixture({ standby: kind !== 'missing' });
      const { proof } = await f.drain();
      if (kind === 'plan') proof.acceptedDataLoss.sourceSyncPlanSha256 = 'e'.repeat(64);
      if (kind === 'operation') proof.acceptedDataLoss.sourceSyncOperationId = randomUUID();
      if (kind === 'verification')
        proof.generation = { ...proof.generation, verificationSha256: 'e'.repeat(64) };
      await expect(authority.verifyFailoverGeneration(f.identity, proof)).rejects.toThrow(
        'standby_unregistered'
      );
      expect((await authority.getOperation(f.identity)).state).toBe('draining');
    }
  );

  it.each(['old-snapshot', 'future-acceptance', 'before-drain', 'old-epoch'] as const)(
    'uses database time and exact epoch to reject %s',
    async (kind) => {
      const f = await fixture();
      const { proof } = await f.drain();
      if (kind === 'old-snapshot') proof.acceptedDataLoss.maximumSnapshotAgeMs = 1;
      if (kind === 'future-acceptance') proof.acceptedDataLoss.acceptedAtMs = Date.now() + 60_000;
      if (kind === 'before-drain') proof.acceptedDataLoss.acceptedAtMs -= 1;
      if (kind === 'old-epoch') proof.generation = { ...proof.generation, sourceEpoch: 2 };
      await expect(authority.verifyFailoverGeneration(f.identity, proof)).rejects.toThrow(
        'generation_mismatch'
      );
      expect((await authority.get(f.pairId, f.tenantId)).epoch).toBe(1);
    }
  );

  it('rechecks age at promotion and retains the fence when the approved copy becomes too old', async () => {
    const f = await fixture({ capturedAtMs: Date.now() });
    const { proof } = await f.drain(200);
    await authority.verifyFailoverGeneration(f.identity, proof);
    await setTimeout(210);
    await expect(authority.promote(f.identity)).rejects.toThrow('snapshot_too_old');
    expect(await authority.get(f.pairId, f.tenantId)).toMatchObject({
      phase: 'draining',
      epoch: 1,
    });
    expect((await authority.getOperation(f.identity)).state).toBe('verified');
  });

  it('serializes concurrent promotion and preserves its receipt after a planned reverse switch', async () => {
    const f = await fixture();
    const { proof } = await f.drain();
    await authority.verifyFailoverGeneration(f.identity, proof);
    const results = await Promise.all([
      authority.promote(f.identity),
      new PostgresDeploymentAuthority(pool).promote(f.identity),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].promotedEpoch).toBe(2);
    const state = await authority.get(f.pairId, f.tenantId);
    const backRequest = {
      ...f.request,
      operationId: randomUUID(),
      sourceDeploymentId: 'aws-a',
      destinationDeploymentId: 'cf-a',
      expectedEpoch: 2,
      expectedRevision: state.revision,
    };
    const back = await authority.beginDrain(backRequest);
    const backIdentity = { ...f.identity, operationId: back.operationId };
    await authority.verifyGeneration(backIdentity, {
      generationId: randomUUID(),
      sourceDeploymentId: 'aws-a',
      destinationDeploymentId: 'cf-a',
      sourceEpoch: 2,
      sourceFenceRevision: back.drainRevision,
      capturedAtMs: back.drainedAtMs ?? 1,
      manifestSha256: 'd'.repeat(64),
      verificationSha256: 'e'.repeat(64),
    });
    await authority.promote(backIdentity);
    expect(await authority.promote(f.identity)).toEqual(results[0]);
    const latest = await authority.get(f.pairId, f.tenantId);
    expect(latest.epoch).toBe(3);
    const another = {
      ...f.request,
      operationId: randomUUID(),
      expectedEpoch: 3,
      expectedRevision: latest.revision,
    };
    await authority.beginFailoverDrain(another);
    await expect(
      authority.verifyFailoverGeneration({ ...f.identity, operationId: another.operationId }, proof)
    ).rejects.toThrow('generation_mismatch');
    expect((await authority.get(f.pairId, f.tenantId)).epoch).toBe(3);
  });
});
