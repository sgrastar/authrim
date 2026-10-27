import {
  replicationCanonicalJson,
  signReplicationRpc,
} from '@authrim/ar-lib-core/services/deployment-replication/transport';
import { createReplicationAuthorityHttp } from './authority-http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  environmentGenerationDigest,
  type EnvironmentGenerationRecord,
  type EnvironmentPairDefinition,
  type EnvironmentSwitchOperation,
  type EnvironmentDrainRequest,
} from '@authrim/ar-lib-core/services/deployment-replication/environment-authority';
import { PostgresEnvironmentAuthority } from './environment-authority-postgres';
import { PostgresDeploymentAuthority } from './authority-postgres';
const url = process.env.AUTHRIM_AWS_TEST_DATABASE_URL ?? process.env.AUTHRIM_TEST_DATABASE_URL;
(url ? describe : describe.skip)('atomic environment authority (native PostgreSQL)', () => {
  const schema = `rep_env_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 });
  const authority = new PostgresEnvironmentAuthority(pool);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const file of ['authority-schema.sql', 'environment-authority-schema.sql'])
      await pool.query(await readFile(new URL(file, import.meta.url), 'utf8'));
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  async function fixture() {
    const pairId = randomUUID(),
      cf = `cf-${randomUUID()}`,
      aws = `aws-${randomUUID()}`;
    const definition: EnvironmentPairDefinition = {
      pairId,
      environmentId: `env-${randomUUID()}`,
      deployments: [
        { deploymentId: cf, provider: 'cloudflare' },
        { deploymentId: aws, provider: 'aws' },
      ],
      initialOwnerDeploymentId: cf,
      initialGenerationId: 'original',
    };
    const state = await authority.initialize(definition);
    const identity = { pairId, environmentId: definition.environmentId };
    const request: EnvironmentDrainRequest = {
      ...identity,
      operationId: randomUUID(),
      kind: 'planned',
      sourceDeploymentId: cf,
      destinationDeploymentId: aws,
      expectedEpoch: 1,
      expectedRevision: 1,
    };
    const permit = {
      ...identity,
      deploymentId: cf,
      epoch: 1,
      generationId: 'original',
      permitId: randomUUID(),
      operationDigest: 'a'.repeat(64),
    };
    return { definition, state, identity, request, permit, cf, aws };
  }
  const opIdentity = (op: EnvironmentDrainRequest) => ({
    pairId: op.pairId,
    environmentId: op.environmentId,
    operationId: op.operationId,
  });
  async function group(
    request: EnvironmentDrainRequest,
    op?: EnvironmentSwitchOperation,
    age = 0
  ): Promise<EnvironmentGenerationRecord> {
    const capturedAtMs = op?.drainedAtMs ?? Date.now() - age;
    const fence = op?.drainRevision ?? 0;
    const inventory = {
      formatVersion: 1 as const,
      environmentId: request.environmentId,
      sourceDeploymentId: request.sourceDeploymentId,
      sourceEpoch: request.expectedEpoch,
      sourceFenceRevision: fence,
      capturedAtMs,
      sourceReceiptSha256: 'b'.repeat(64),
      complete: true as const,
      tenants: ['alpha', 'beta'].map((tenantId) => ({
        tenantId,
        issuer: `https://${tenantId}.example.test`,
        lifecycle: 'active' as const,
      })),
    };
    const value: Omit<EnvironmentGenerationRecord, 'digestSha256'> = {
      formatVersion: 1,
      ...opIdentity(request),
      sourceDeploymentId: request.sourceDeploymentId,
      deploymentId: request.destinationDeploymentId,
      generationId: randomUUID(),
      epoch: request.expectedEpoch + 1,
      sourceEpoch: request.expectedEpoch,
      sourceFenceRevision: fence,
      sourceOperationId: op ? request.operationId : randomUUID(),
      sourcePlanSha256: 'c'.repeat(64),
      inventory,
      children: inventory.tenants.map((t) => ({
        tenantId: t.tenantId,
        restoreId: randomUUID(),
        sourceEpoch: request.expectedEpoch,
        sourceFenceRevision: fence,
        capturedAtMs,
        verificationSha256: 'd'.repeat(64),
        location: {
          region: 'ap-northeast-1',
          issuerOrigin: t.issuer,
          secretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:replica-abcdef',
          secretVersionId: randomUUID(),
          bucket: 'authrim-test-replication',
          bucketOwner: '123456789012',
          manifestKey: `generations/${randomUUID()}/manifest.json`,
          manifestVersionId: 'immutable-version',
          manifestSha256: 'e'.repeat(64),
        },
      })),
    };
    // Operation identity's operationId is not a catalog field.
    const { operationId: _operationId, ...body } = value as typeof value & { operationId: string };
    return { ...body, digestSha256: await environmentGenerationDigest(body) };
  }
  const proof = (g: EnvironmentGenerationRecord) => ({
    generationId: g.generationId,
    digestSha256: g.digestSha256,
    acceptedDataLoss: null,
  });
  async function planned(f: Awaited<ReturnType<typeof fixture>>) {
    const op = await authority.beginDrain(f.request);
    const g = await group(f.request, op);
    await authority.registerGeneration(g);
    await authority.verifyGeneration(opIdentity(f.request), proof(g));
    return g;
  }
  it('initializes idempotently and separates environment identity from tenant identity', async () => {
    const f = await fixture();
    expect(await authority.initialize(f.definition)).toEqual(f.state);
    await expect(authority.get(f.identity.pairId, 'alpha')).rejects.toThrow('not_found');
    await expect(
      authority.initialize({ ...f.definition, initialGenerationId: 'different' })
    ).rejects.toThrow('idempotency_conflict');
  });
  it('atomically reserves deployments against singleton and competing environment pairs in both directions', async () => {
    const f = await fixture();
    const legacy = new PostgresDeploymentAuthority(pool);
    await expect(
      legacy.initialize({
        pairId: randomUUID(),
        tenantId: 'alpha',
        deployments: f.definition.deployments,
        initialOwnerDeploymentId: f.cf,
        initialGenerationId: 'original',
      })
    ).rejects.toThrow('membership_conflict');
    await expect(
      authority.initialize({ ...f.definition, pairId: randomUUID(), environmentId: randomUUID() })
    ).rejects.toThrow('membership_conflict');
    const suffix = randomUUID();
    const def = {
      pairId: randomUUID(),
      tenantId: 'beta',
      deployments: [
        { deploymentId: `cf-${suffix}`, provider: 'cloudflare' as const },
        { deploymentId: `aws-${suffix}`, provider: 'aws' as const },
      ] as const,
      initialOwnerDeploymentId: `cf-${suffix}`,
      initialGenerationId: 'original',
    };
    const competing = { ...def, pairId: randomUUID(), environmentId: randomUUID() };
    const { tenantId: _tenant, ...env } = competing;
    const results = await Promise.allSettled([legacy.initialize(def), authority.initialize(env)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('retains unresolved permits globally and blocks every tenant until completion, including restart', async () => {
    const f = await fixture();
    await authority.enter(f.permit);
    const op = await authority.beginDrain(f.request);
    expect(op.drainedAtMs).toBeNull();
    await expect(authority.enter({ ...f.permit, permitId: randomUUID() })).rejects.toThrow(
      'writer_draining'
    );
    await expect(authority.promote(opIdentity(op))).rejects.toThrow('unresolved_permits');
    const restarted = new PostgresEnvironmentAuthority(pool);
    expect(await restarted.enter(f.permit)).toEqual(f.permit);
    await expect(
      restarted.complete({ ...f.permit, operationDigest: 'f'.repeat(64) })
    ).rejects.toThrow('permit_mismatch');
    await restarted.complete(f.permit);
    await restarted.complete(f.permit);
    expect(
      (await restarted.get(f.identity.pairId, f.identity.environmentId)).outstandingPermits
    ).toBe(0);
    await expect(restarted.enter(f.permit)).rejects.toThrow('permit_completed');
  });
  it.each([
    'missing',
    'duplicate',
    'wrong-tenant',
    'wrong-epoch',
    'wrong-fence',
    'inactive',
    'digest',
  ] as const)('rejects %s aggregate coverage without registering or promoting', async (kind) => {
    const f = await fixture();
    const op = await authority.beginDrain(f.request);
    const g = await group(f.request, op);
    if (kind === 'missing') g.children.pop();
    if (kind === 'duplicate') g.children[1] = g.children[0];
    if (kind === 'wrong-tenant') g.children[1].tenantId = 'other';
    if (kind === 'wrong-epoch') g.children[1].sourceEpoch = 2;
    if (kind === 'wrong-fence') g.children[1].sourceFenceRevision = 0;
    if (kind === 'inactive') Object.assign(g.inventory.tenants[1], { lifecycle: 'suspended' });
    if (kind === 'digest') g.children[0].verificationSha256 = 'f'.repeat(64);
    await expect(authority.registerGeneration(g)).rejects.toThrow();
    expect(
      (
        await pool.query(
          'SELECT 1 FROM authrim_replication_environment_generations WHERE pair_id=$1',
          [f.identity.pairId]
        )
      ).rowCount
    ).toBe(0);
    await expect(authority.promote(opIdentity(op))).rejects.toThrow('generation_unverified');
  });
  it('atomically promotes all children, fences old/orphan runtimes, and replays lost replies without another epoch', async () => {
    const f = await fixture();
    const g = await planned(f);
    const id = opIdentity(f.request);
    const promoted = await authority.promote(id);
    expect(promoted.promotedEpoch).toBe(2);
    const restarted = new PostgresEnvironmentAuthority(pool);
    expect(await restarted.promote(id)).toEqual(promoted);
    expect(await restarted.getServingGeneration({ ...f.identity, deploymentId: f.aws })).toEqual(g);
    await expect(restarted.enter({ ...f.permit, permitId: randomUUID() })).rejects.toThrow(
      'writer_fenced'
    );
    const target = {
      ...f.permit,
      deploymentId: f.aws,
      epoch: 2,
      generationId: g.generationId,
      permitId: randomUUID(),
    };
    await expect(restarted.enter(target)).rejects.toThrow('writer_fenced');
    await expect(
      restarted.enter({ ...target, tenantId: 'alpha', restoreId: randomUUID() })
    ).rejects.toThrow('writer_fenced');
    for (const child of g.children) {
      const admitted = {
        ...target,
        permitId: randomUUID(),
        tenantId: child.tenantId,
        restoreId: child.restoreId,
      };
      await restarted.enter(admitted);
      await restarted.complete(admitted);
    }
    expect((await restarted.get(f.identity.pairId, f.identity.environmentId)).epoch).toBe(2);
  });
  it('competing drain and promotion are serialized and immutable', async () => {
    const f = await fixture();
    const attempts = [f.request, { ...f.request, operationId: randomUUID() }];
    const results = await Promise.allSettled(attempts.map((r) => authority.beginDrain(r)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const index = results.findIndex((r) => r.status === 'fulfilled');
    const request = attempts[index];
    const op = await authority.getOperation(opIdentity(request));
    const g = await group(request, op);
    await authority.registerGeneration(g);
    await authority.verifyGeneration(opIdentity(request), proof(g));
    const promoted = await Promise.all([
      authority.promote(opIdentity(request)),
      authority.promote(opIdentity(request)),
    ]);
    expect(promoted[0]).toEqual(promoted[1]);
  });
  it('cancels only the unpromoted drain without clearing unresolved writes or reviving cancelled evidence', async () => {
    const f = await fixture();
    await authority.enter(f.permit);
    await authority.beginDrain(f.request);
    const cancelled = await authority.cancelDrain(opIdentity(f.request));
    expect(cancelled.state).toBe('cancelled');
    expect(await authority.cancelDrain(opIdentity(f.request))).toEqual(cancelled);
    expect(
      (await authority.get(f.identity.pairId, f.identity.environmentId)).outstandingPermits
    ).toBe(1);
    await expect(authority.promote(opIdentity(f.request))).rejects.toThrow('switch_conflict');
    await authority.complete(f.permit);
    await authority.enter({ ...f.permit, permitId: randomUUID() });
  });
  it('supports a later reverse planned switch without reviving the original epoch or child', async () => {
    const f = await fixture();
    const first = await planned(f);
    await authority.promote(opIdentity(f.request));
    const state = await authority.get(f.identity.pairId, f.identity.environmentId);
    const reverse = {
      ...f.request,
      operationId: randomUUID(),
      sourceDeploymentId: f.aws,
      destinationDeploymentId: f.cf,
      expectedEpoch: state.epoch,
      expectedRevision: state.revision,
    };
    const op = await authority.beginDrain(reverse);
    const g = await group(reverse, op);
    await authority.registerGeneration(g);
    await authority.verifyGeneration(opIdentity(op), proof(g));
    await authority.promote(opIdentity(op));
    await expect(authority.enter({ ...f.permit, permitId: randomUUID() })).rejects.toThrow(
      'writer_fenced'
    );
    await expect(
      authority.enter({
        ...f.permit,
        deploymentId: f.aws,
        epoch: 2,
        generationId: first.generationId,
        tenantId: 'alpha',
        restoreId: first.children[0].restoreId,
        permitId: randomUUID(),
      })
    ).rejects.toThrow('writer_fenced');
    expect((await authority.get(f.identity.pairId, f.identity.environmentId)).epoch).toBe(3);
  });
  it('failover uses only complete registered unfenced snapshots and explicit loss acceptance', async () => {
    const f = await fixture();
    const g = await group(f.request);
    await authority.registerGeneration(g);
    const op = await authority.beginDrain({ ...f.request, kind: 'failover' });
    const p = {
      ...proof(g),
      acceptedDataLoss: {
        sourceSyncOperationId: g.sourceOperationId,
        sourceSyncPlanSha256: g.sourcePlanSha256,
        maximumSnapshotAgeMs: 60000,
        acceptedAtMs: Date.now(),
      },
    };
    await expect(authority.verifyGeneration(opIdentity(op), proof(g))).rejects.toThrow(
      'snapshot_age_exceeded'
    );
    await authority.verifyGeneration(opIdentity(op), p);
    await authority.promote(opIdentity(op));
    expect(
      (await authority.get(f.identity.pairId, f.identity.environmentId)).ownerDeploymentId
    ).toBe(f.aws);
  });
  it('fails over neither an expired oldest child nor a future acceptance and rechecks expiry at promote', async () => {
    const f = await fixture();
    const g = await group(f.request, undefined, 60000);
    await authority.registerGeneration(g);
    const op = await authority.beginDrain({ ...f.request, kind: 'failover' });
    const base = {
      ...proof(g),
      acceptedDataLoss: {
        sourceSyncOperationId: g.sourceOperationId,
        sourceSyncPlanSha256: g.sourcePlanSha256,
        maximumSnapshotAgeMs: 30000,
        acceptedAtMs: Date.now(),
      },
    };
    await expect(authority.verifyGeneration(opIdentity(op), base)).rejects.toThrow(
      'snapshot_age_exceeded'
    );
    await expect(
      authority.verifyGeneration(opIdentity(op), {
        ...base,
        acceptedDataLoss: {
          ...base.acceptedDataLoss,
          maximumSnapshotAgeMs: 120000,
          acceptedAtMs: Date.now() + 60000,
        },
      })
    ).rejects.toThrow('snapshot_age_exceeded');
    const valid = {
      ...base,
      acceptedDataLoss: { ...base.acceptedDataLoss, maximumSnapshotAgeMs: 120000 },
    };
    await authority.verifyGeneration(opIdentity(op), valid);
    // Persisted age remains authoritative: lower the approved maximum, without changing any source snapshot.
    const changed = {
      ...valid,
      acceptedDataLoss: { ...valid.acceptedDataLoss, maximumSnapshotAgeMs: 1 },
    };
    await pool.query(
      'UPDATE authrim_replication_environment_operations SET generation_json=$3 WHERE pair_id=$1 AND operation_id=$2',
      [op.pairId, op.operationId, JSON.stringify(changed)]
    );
    await expect(authority.promote(opIdentity(op))).rejects.toThrow('snapshot_age_exceeded');
  });
  it('fails closed when the authority is unavailable and never invokes domain writes', async () => {
    const f = await fixture();
    const down = new PostgresEnvironmentAuthority({
      connect: async () => {
        throw new Error('secret diagnostic');
      },
    });
    await expect(down.enter(f.permit)).rejects.toThrow('unavailable');
  });
  it('enforces signed environment credentials, writer/controller separation and actual permit side effects', async () => {
    const f = await fixture();
    const secret = 'a'.repeat(64);
    const http = createReplicationAuthorityHttp({
      authority: new PostgresDeploymentAuthority(pool),
      environmentAuthority: authority,
      credentials: [
        { credentialId: 'env-writer', secret, ...f.identity, role: 'writer', deploymentId: f.cf },
        { credentialId: 'env-controller', secret, ...f.identity, role: 'controller' },
        {
          credentialId: 'tenant-controller',
          secret,
          pairId: f.identity.pairId,
          tenantId: 'alpha',
          role: 'controller',
        },
      ],
    });
    async function send(
      action: string,
      payload: unknown,
      credentialId = 'env-writer',
      valid = true
    ) {
      const body = replicationCanonicalJson({
        version: 1,
        requestId: randomUUID(),
        timestamp: Date.now(),
        credentialId,
        action,
        payload,
      });
      return http(
        new Request('https://authority.example.test/replication/v1/rpc', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Authrim-Replication-Signature': await signReplicationRpc(
              body,
              valid ? secret : 'b'.repeat(64)
            ),
          },
          body,
        })
      );
    }
    expect((await send('environmentEnter', f.permit)).status).toBe(200);
    expect(
      (await authority.get(f.identity.pairId, f.identity.environmentId)).outstandingPermits
    ).toBe(1);
    for (const action of [
      'environmentInitialize',
      'environmentGet',
      'environmentBeginDrain',
      'environmentGetOperation',
      'environmentRegisterGeneration',
      'environmentGetGeneration',
      'environmentVerifyGeneration',
      'environmentPromote',
      'environmentCancelDrain',
    ])
      expect((await send(action, f.permit)).status).toBe(409);
    for (const [action, payload, credential] of [
      ['environmentEnter', { ...f.permit, environmentId: 'other' }, 'env-writer'],
      ['environmentComplete', { ...f.permit, deploymentId: f.aws }, 'env-writer'],
      ['environmentEnter', f.permit, 'env-controller'],
      ['environmentComplete', f.permit, 'env-controller'],
      ['environmentGet', f.identity, 'tenant-controller'],
      ['get', { pairId: f.identity.pairId, tenantId: 'alpha' }, 'env-controller'],
    ] as const)
      expect((await send(action, payload, credential)).status).toBe(409);
    expect((await send('environmentComplete', f.permit, 'env-writer', false)).status).toBe(409);
    expect(
      (await authority.get(f.identity.pairId, f.identity.environmentId)).outstandingPermits
    ).toBe(1);
    expect((await send('environmentComplete', f.permit)).status).toBe(200);
    const draining = await send('environmentBeginDrain', f.request, 'env-controller');
    expect(draining.status).toBe(200);
    const response = await send('environmentCancelDrain', opIdentity(f.request), 'env-controller');
    expect(response.status).toBe(200);
    expect((await authority.get(f.identity.pairId, f.identity.environmentId)).phase).toBe('active');
  });
});
