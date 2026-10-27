import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DeploymentDrainRequest,
  DeploymentPairDefinition,
  DeploymentSwitchOperation,
  DeploymentVerifiedGeneration,
  DeploymentWritePermit,
} from '@authrim/ar-lib-core/services/deployment-replication/authority';
import { PostgresDeploymentAuthority } from './authority-postgres';

const url = process.env.AUTHRIM_AWS_TEST_DATABASE_URL ?? process.env.AUTHRIM_TEST_DATABASE_URL;

(url ? describe : describe.skip)(
  'PostgreSQL deployment authority (local explicit database)',
  () => {
    const schema = `replication_authority_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url });
    const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 });
    const authority = new PostgresDeploymentAuthority(pool);
    let created = false;
    beforeAll(async () => {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await pool.query(await readFile(new URL('./authority-schema.sql', import.meta.url), 'utf8'));
    });
    afterAll(async () => {
      await pool.end();
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });

    async function create() {
      const definition: DeploymentPairDefinition = {
        pairId: randomUUID(),
        tenantId: `tenant-${randomUUID()}`,
        deployments: [
          { deploymentId: 'cloudflare-a', provider: 'cloudflare' },
          { deploymentId: 'aws-a', provider: 'aws' },
        ],
        initialOwnerDeploymentId: 'cloudflare-a',
        initialGenerationId: 'initial-generation',
      };
      const state = await authority.initialize(definition);
      const request: DeploymentDrainRequest = {
        pairId: definition.pairId,
        tenantId: definition.tenantId,
        operationId: randomUUID(),
        sourceDeploymentId: state.ownerDeploymentId,
        destinationDeploymentId: 'aws-a',
        expectedEpoch: state.epoch,
        expectedRevision: state.revision,
      };
      const permit: DeploymentWritePermit = {
        pairId: definition.pairId,
        tenantId: definition.tenantId,
        deploymentId: state.ownerDeploymentId,
        epoch: state.epoch,
        generationId: state.selectedGenerationId,
        permitId: randomUUID(),
        operationDigest: 'a'.repeat(64),
      };
      return { definition, state, request, permit };
    }

    function proof(operation: DeploymentSwitchOperation): DeploymentVerifiedGeneration {
      return {
        generationId: randomUUID(),
        sourceDeploymentId: operation.sourceDeploymentId,
        destinationDeploymentId: operation.destinationDeploymentId,
        sourceEpoch: operation.expectedEpoch,
        sourceFenceRevision: operation.drainRevision,
        capturedAtMs: operation.drainedAtMs ?? 1,
        manifestSha256: 'b'.repeat(64),
        verificationSha256: 'c'.repeat(64),
      };
    }

    function identity(request: DeploymentDrainRequest) {
      return {
        pairId: request.pairId,
        tenantId: request.tenantId,
        operationId: request.operationId,
      };
    }

    it('initializes idempotently but rejects altered owner/generation and cross-tenant reads', async () => {
      const input = await create();
      expect(await authority.initialize(input.definition)).toEqual(input.state);
      await expect(
        authority.initialize({ ...input.definition, initialOwnerDeploymentId: 'aws-a' })
      ).rejects.toThrow('idempotency_conflict');
      await expect(
        authority.initialize({ ...input.definition, initialGenerationId: 'old-data' })
      ).rejects.toThrow('idempotency_conflict');
      await expect(
        authority.initialize({
          ...input.definition,
          pairId: randomUUID(),
          initialOwnerDeploymentId: 'aws-a',
        })
      ).rejects.toThrow('membership_conflict');
      await expect(authority.get(input.definition.pairId, 'tenant-b')).rejects.toThrow('not_found');
      await expect(authority.enter({ ...input.permit, tenantId: 'tenant-b' })).rejects.toThrow(
        'not_found'
      );
    });

    it('rejects secondary writers, wrong epochs and warmed runtimes pinned to old generations', async () => {
      const { permit } = await create();
      for (const wrong of [
        { ...permit, deploymentId: 'aws-a' },
        { ...permit, epoch: 2 },
        { ...permit, generationId: 'old-generation' },
      ])
        await expect(authority.enter(wrong)).rejects.toThrow('writer_fenced');
      expect((await authority.get(permit.pairId, permit.tenantId)).outstandingPermits).toBe(0);
    });

    it('never ages out an unresolved permit and resumes the same admission after drain/restart', async () => {
      const { request, permit } = await create();
      await authority.enter(permit);
      const draining = await authority.beginDrain(request);
      expect(draining.drainedAtMs).toBeNull();
      await expect(authority.enter({ ...permit, permitId: randomUUID() })).rejects.toThrow(
        'writer_draining'
      );
      await expect(authority.verifyGeneration(identity(request), proof(draining))).rejects.toThrow(
        'unresolved_permits'
      );
      await expect(authority.promote(identity(request))).rejects.toThrow('unresolved_permits');
      const restarted = new PostgresDeploymentAuthority(pool);
      expect(await restarted.enter(permit)).toEqual(permit);
      expect((await restarted.get(permit.pairId, permit.tenantId)).outstandingPermits).toBe(1);
      await expect(
        restarted.complete({ ...permit, operationDigest: 'd'.repeat(64) })
      ).rejects.toThrow('permit_mismatch');
      await restarted.complete(permit);
      await restarted.complete(permit);
      const state = await restarted.get(permit.pairId, permit.tenantId);
      expect(state.outstandingPermits).toBe(0);
      expect(state.drainedAtMs).toBeGreaterThan(0);
      expect(state.phase).toBe('draining');
      await expect(restarted.enter(permit)).rejects.toThrow('permit_completed');
    });

    it('serializes two competing switches and admits at most one immutable operation', async () => {
      const { request } = await create();
      const outcomes = await Promise.allSettled([
        authority.beginDrain(request),
        new PostgresDeploymentAuthority(pool).beginDrain({ ...request, operationId: randomUUID() }),
      ]);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const state = await authority.get(request.pairId, request.tenantId);
      expect(state.phase).toBe('draining');
      expect(state.epoch).toBe(1);
      expect(state.revision).toBe(2);
    });

    it('serializes writer admission against draining without dropping an admitted writer', async () => {
      const { request, permit } = await create();
      const [admission, drain] = await Promise.allSettled([
        authority.enter(permit),
        authority.beginDrain(request),
      ]);
      expect(drain.status).toBe('fulfilled');
      const state = await authority.get(request.pairId, request.tenantId);
      expect(state.outstandingPermits).toBe(admission.status === 'fulfilled' ? 1 : 0);
      if (admission.status === 'fulfilled') {
        await expect(authority.promote(identity(request))).rejects.toThrow('unresolved_permits');
        await authority.complete(permit);
      }
    });

    it('requires the exact final post-drain verified generation and refuses conflicting proofs', async () => {
      const { request } = await create();
      const draining = await authority.beginDrain(request);
      await expect(authority.promote(identity(request))).rejects.toThrow('generation_unverified');
      const valid = proof(draining);
      for (const wrong of [
        { ...valid, sourceEpoch: 2 },
        { ...valid, sourceFenceRevision: 1 },
        { ...valid, capturedAtMs: valid.capturedAtMs - 1 },
        { ...valid, capturedAtMs: Date.now() + 60_000 },
        { ...valid, sourceDeploymentId: 'other-source' },
        { ...valid, destinationDeploymentId: 'other-destination' },
        { ...valid, generationId: 'initial-generation' },
      ])
        await expect(authority.verifyGeneration(identity(request), wrong)).rejects.toThrow(
          'generation_mismatch'
        );
      const verified = await authority.verifyGeneration(identity(request), valid);
      expect(verified.state).toBe('verified');
      expect(await authority.verifyGeneration(identity(request), valid)).toEqual(verified);
      await expect(
        authority.verifyGeneration(identity(request), { ...valid, manifestSha256: 'd'.repeat(64) })
      ).rejects.toThrow('idempotency_conflict');
    });

    it('promotes once, fails back in reverse at a higher epoch, and never reactivates stale generations', async () => {
      const { request, permit } = await create();
      const first = await authority.beginDrain(request);
      const firstProof = proof(first);
      await authority.verifyGeneration(identity(request), firstProof);
      const promoted = await Promise.all([
        authority.promote(identity(request)),
        authority.promote(identity(request)),
      ]);
      expect(promoted[0]).toEqual(promoted[1]);
      expect(promoted[0].promotedEpoch).toBe(2);
      await expect(authority.enter(permit)).rejects.toThrow('writer_fenced');
      const active = await authority.get(request.pairId, request.tenantId);
      const awsPermit = {
        ...permit,
        permitId: randomUUID(),
        deploymentId: 'aws-a',
        epoch: 2,
        generationId: firstProof.generationId,
      };
      await authority.enter(awsPermit);
      await authority.complete(awsPermit);
      const reverse: DeploymentDrainRequest = {
        ...request,
        operationId: randomUUID(),
        sourceDeploymentId: 'aws-a',
        destinationDeploymentId: 'cloudflare-a',
        expectedEpoch: active.epoch,
        expectedRevision: active.revision,
      };
      const second = await authority.beginDrain(reverse);
      const secondProof = proof(second);
      await authority.verifyGeneration(identity(reverse), secondProof);
      await authority.promote(identity(reverse));
      const returned = await authority.get(request.pairId, request.tenantId);
      expect(returned.ownerDeploymentId).toBe('cloudflare-a');
      expect(returned.epoch).toBe(3);
      expect(returned.selectedGenerationId).toBe(secondProof.generationId);
      await expect(
        authority.enter({ ...permit, epoch: 3, permitId: randomUUID() })
      ).rejects.toThrow('writer_fenced');
      expect(await authority.promote(identity(request))).toEqual(promoted[0]);
      expect((await authority.get(request.pairId, request.tenantId)).epoch).toBe(3);
      const third = await authority.beginDrain({
        ...request,
        operationId: randomUUID(),
        expectedEpoch: 3,
        expectedRevision: returned.revision,
      });
      await expect(
        authority.verifyGeneration(identity(third), {
          ...proof(third),
          generationId: firstProof.generationId,
        })
      ).rejects.toThrow('generation_reused');
    });

    it('recovers a committed promotion with a lost response without incrementing epoch twice', async () => {
      const { request } = await create();
      const drain = await authority.beginDrain(request);
      await authority.verifyGeneration(identity(request), proof(drain));
      // The same SQL transaction commits, then this transport wrapper loses its reply.
      let loseCommit = true;
      const lossyPool = new Proxy(pool, {
        get(target, property, receiver) {
          if (property !== 'connect') return Reflect.get(target, property, receiver) as unknown;
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, key) {
                if (key === 'query')
                  return async (sql: string, values?: unknown[]) => {
                    const result = await connection.query(sql, values);
                    if (sql === 'COMMIT' && loseCommit) {
                      loseCommit = false;
                      throw new Error('secret database transport lost');
                    }
                    return result;
                  };
                if (key === 'release') return connection.release.bind(connection);
                return Reflect.get(connection, key, connection) as unknown;
              },
            });
          };
        },
      });
      await expect(
        new PostgresDeploymentAuthority(lossyPool).promote(identity(request))
      ).rejects.toThrow('deployment_authority_unavailable');
      const receipt = await new PostgresDeploymentAuthority(pool).promote(identity(request));
      expect(receipt.promotedEpoch).toBe(2);
      expect((await authority.get(request.pairId, request.tenantId)).epoch).toBe(2);
    });
  }
);

it('fails closed without disclosing connection errors', async () => {
  const pool = new Pool({
    connectionString: 'postgresql://unused:private@127.0.0.1:1/absent',
    connectionTimeoutMillis: 100,
  });
  try {
    await expect(new PostgresDeploymentAuthority(pool).get('pair-a', 'tenant-a')).rejects.toThrow(
      'deployment_authority_unavailable'
    );
  } finally {
    await pool.end();
  }
});
