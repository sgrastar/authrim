import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  replicationInventoryDigest,
  type EnvironmentReplicationInventory,
} from '@authrim/ar-lib-core/services/deployment-replication/environment-inventory';
import type { EnvironmentAuthority } from '@authrim/ar-lib-core/services/deployment-replication/environment-authority';
import { PostgresEnvironmentAuthority } from './environment-authority-postgres';
import { ReplicationJournal } from './journal';
import {
  advanceEnvironmentReplicationOperation,
  advanceEnvironmentFailover,
  type EnvironmentCoordinatorDependencies,
  type EnvironmentOperationPlan,
  type EnvironmentOperationProgress,
} from './environment-coordinator';
import type { DownloadedReplicationExport } from './export-client';
import { restoreEvidenceDigest } from '../import/restore-evidence';
const url = process.env.AUTHRIM_AWS_TEST_DATABASE_URL ?? process.env.AUTHRIM_TEST_DATABASE_URL;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture');
  return value;
}
(url ? describe : describe.skip)('environment coordinator durable PostgreSQL matrix', () => {
  const schema = `env_coordinator_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 });
  const authority = new PostgresEnvironmentAuthority(pool);
  const journal = new ReplicationJournal(pool, 'environment');
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const file of ['authority-schema.sql', 'environment-authority-schema.sql'])
      await pool.query(await readFile(new URL(file, import.meta.url), 'utf8'));
    await pool.query(
      'CREATE TABLE test_environment_restores (restore_id text PRIMARY KEY,group_id text NOT NULL,tenant_id text NOT NULL)'
    );
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  async function fixture(mode: 'sync' | 'switch' = 'switch', snapshotAge = 0) {
    const pairId = randomUUID(),
      environmentId = randomUUID(),
      cf = `cf-${randomUUID()}`,
      aws = `aws-${randomUUID()}`;
    await authority.initialize({
      pairId,
      environmentId,
      deployments: [
        { deploymentId: cf, provider: 'cloudflare' },
        { deploymentId: aws, provider: 'aws' },
      ],
      initialOwnerDeploymentId: cf,
      initialGenerationId: 'original',
    });
    const plan: EnvironmentOperationPlan = {
      pairId,
      environmentId,
      operationId: randomUUID(),
      sourceDeploymentId: cf,
      destinationDeploymentId: aws,
      expectedEpoch: 1,
      mode,
    };
    const planSha256 = restoreEvidenceDigest(plan);
    const initial: EnvironmentOperationProgress = {
      formatVersion: 2,
      plan,
      phase: 'pending',
      generationId: randomUUID(),
      children: [],
      writerAuthorityChanged: false,
    };
    const inventoryBody = {
      formatVersion: 1 as const,
      complete: true as const,
      pairId,
      environmentId,
      sourceDeploymentId: cf,
      writerCoverageSha256: 'a'.repeat(64),
      tenants: ['alpha', 'beta'].map((tenantId) => ({
        tenantId,
        issuer: `https://${tenantId}.example.test`,
        productVersion: '0.4.2',
        lifecycleState: 'active',
        placementGeneration: 1,
      })),
    };
    const inventorySha256 = await replicationInventoryDigest(inventoryBody);
    const source = {
      inventory: vi.fn(
        async (minimum: number): Promise<EnvironmentReplicationInventory> => ({
          ...inventoryBody,
          observedAtMs: Math.max(minimum, Date.now()),
          inventorySha256,
        })
      ),
      advance: vi.fn(async (tenantId: string, _key: string) => ({
        id: `replication-backup-${restoreEvidenceDigest(tenantId)}`,
        state: 'ready',
        phase: 'export_complete',
        revision: 1,
      })),
      download: vi.fn(
        async (
          tenantId: string,
          operationId: string,
          minimum: number
        ): Promise<DownloadedReplicationExport> => {
          const publication: DownloadedReplicationExport['publication'] = {
            formatVersion: 1,
            operationId,
            expiresAt: Date.now() + 60000,
            byteCount: 1,
            boundaryUnixMs: minimum || Date.now() - snapshotAge,
            receipt: {
              source: {
                tenantId,
                issuer: `https://${tenantId}.example.test`,
                productVersion: '0.4.2',
              },
              bundleId: 'a'.repeat(32),
              snapshotId: `snapshot-${tenantId}`,
              inventoryDigestSha256: 'b'.repeat(64),
              parts: [{ size: 1, sha256: 'c'.repeat(64) }],
            },
            selection: {
              settings: true,
              users: true,
              admin: false,
              logs: { audit: false, other: false, sensitive: false, period: 7 },
              artifacts: false,
            },
            datasets: [],
          };
          return {
            publication,
            publicationSha256: restoreEvidenceDigest(publication),
            publicationPath: `/synthetic/${tenantId}/publication.json`,
            partPaths: [`/synthetic/${tenantId}/part`],
          };
        }
      ),
    };
    const restore = async (
      input: Parameters<EnvironmentCoordinatorDependencies['target']['restore']>[0]
    ) => {
      await pool.query('INSERT INTO test_environment_restores VALUES($1,$2,$3)', [
        input.restoreId,
        input.generationId,
        input.tenantId,
      ]);
      return {
        generation: {
          pairId,
          tenantId: input.tenantId,
          deploymentId: aws,
          generationId: input.restoreId,
          epoch: input.servingEpoch,
          location: {
            region: 'ap-northeast-1',
            issuerOrigin: `https://${input.tenantId}.example.test`,
            secretArn:
              'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:replication-abcdef',
            secretVersionId: randomUUID(),
            bucket: 'authrim-test-replication',
            bucketOwner: '123456789012',
            manifestKey: `generations/${input.restoreId}/manifest.json`,
            manifestVersionId: 'immutable',
            manifestSha256: 'd'.repeat(64),
          },
        },
        verificationSha256: 'e'.repeat(64),
      };
    };
    const target = { restore: vi.fn(restore) };
    const run = (overrides: Partial<EnvironmentCoordinatorDependencies> = {}) =>
      journal.withOperation({
        pairId,
        operationId: plan.operationId,
        planSha256,
        initial,
        run: (checkpoint) =>
          advanceEnvironmentReplicationOperation({
            expectedPlan: plan,
            checkpoint,
            authority,
            source,
            target,
            maximumSnapshotAgeMs: 300000,
            ...overrides,
          }),
      });
    const saved = () =>
      journal.withOperation({
        pairId,
        operationId: plan.operationId,
        planSha256,
        initial,
        run: async (checkpoint) => checkpoint.current().value,
      });
    const alter = (change: (p: EnvironmentOperationProgress) => void) =>
      journal.withOperation({
        pairId,
        operationId: plan.operationId,
        planSha256,
        initial,
        run: async (checkpoint) => {
          const p = checkpoint.current().value;
          change(p);
          await checkpoint.save(p);
        },
      });
    const complete = async (overrides: Partial<EnvironmentCoordinatorDependencies> = {}) => {
      for (let i = 0; i < 8; i++) {
        const p = await run(overrides);
        if (p.phase === 'complete') return p;
      }
      throw new Error('fixture did not complete');
    };
    const permit = {
      pairId,
      environmentId,
      deploymentId: cf,
      epoch: 1,
      generationId: 'original',
      permitId: randomUUID(),
      operationDigest: 'f'.repeat(64),
    };
    return {
      pairId,
      environmentId,
      cf,
      aws,
      plan,
      planSha256,
      initial,
      source,
      target,
      restore,
      run,
      saved,
      alter,
      complete,
      permit,
      inventoryBody,
    };
  }
  function loseReply(method: 'beginDrain' | 'promote'): EnvironmentAuthority {
    let lose = true;
    return new Proxy(authority, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (key !== method) return value.bind(target) as unknown;
        return async (...args: unknown[]) => {
          const result: unknown = await Reflect.apply(value, target, args);
          if (lose) {
            lose = false;
            throw new Error('lost durable reply');
          }
          return result;
        };
      },
    });
  }
  async function failover(
    f: Awaited<ReturnType<typeof fixture>>,
    standby: EnvironmentOperationProgress,
    maximumSnapshotAgeMs = 60000
  ) {
    const plan: EnvironmentOperationPlan = {
      ...f.plan,
      operationId: randomUUID(),
      mode: 'failover',
    };
    const initial: EnvironmentOperationProgress = {
      ...f.initial,
      plan,
      children: [],
      phase: 'pending',
      generationId: randomUUID(),
    };
    const planSha256 = restoreEvidenceDigest(plan);
    const run = (chosen: EnvironmentAuthority = authority) =>
      journal.withOperation({
        pairId: plan.pairId,
        operationId: plan.operationId,
        planSha256,
        initial,
        run: (checkpoint) =>
          advanceEnvironmentFailover({
            expectedPlan: plan,
            checkpoint,
            authority: chosen,
            reviewedStandby: { planSha256: f.planSha256, progress: standby },
            maximumSnapshotAgeMs,
          }),
      });
    return { plan, run };
  }
  it('sync registers a complete two-tenant standby without selecting or admitting it', async () => {
    const f = await fixture('sync');
    expect((await f.run()).phase).toBe('exporting');
    expect((await authority.get(f.pairId, f.environmentId)).epoch).toBe(1);
    const complete = await f.complete();
    expect(complete.writerAuthorityChanged).toBe(false);
    expect(required(complete.generation).children).toHaveLength(2);
    expect(await f.run()).toEqual(complete);
    expect(f.target.restore).toHaveBeenCalledTimes(2);
    expect((await authority.get(f.pairId, f.environmentId)).ownerDeploymentId).toBe(f.cf);
    const child = required(complete.generation).children[0];
    await expect(
      authority.enter({
        ...f.permit,
        deploymentId: f.aws,
        epoch: 2,
        generationId: complete.generationId,
        tenantId: child.tenantId,
        restoreId: child.restoreId,
      })
    ).rejects.toThrow('writer_fenced');
  });
  it('globally drains before export and promotes only after every tenant is restored', async () => {
    const f = await fixture();
    await authority.enter(f.permit);
    expect((await f.run()).phase).toBe('draining');
    expect(f.source.advance).not.toHaveBeenCalled();
    expect(f.target.restore).not.toHaveBeenCalled();
    await authority.complete(f.permit);
    const partial = await f.run();
    expect(partial.phase).toBe('exporting');
    expect(partial.children.map((c) => c.phase)).toEqual(['verified', 'pending']);
    expect((await authority.get(f.pairId, f.environmentId)).ownerDeploymentId).toBe(f.cf);
    const done = await f.complete();
    expect(done.writerAuthorityChanged).toBe(true);
    expect((await authority.get(f.pairId, f.environmentId)).ownerDeploymentId).toBe(f.aws);
    const drained = required(done.cutover).drainedAtMs ?? Number.MAX_SAFE_INTEGER;
    expect(required(done.generation).children.every((c) => c.capturedAtMs >= drained)).toBe(true);
    expect(required(done.generation).inventory.capturedAtMs).toBeGreaterThanOrEqual(drained);
  });
  it('retains the drain when the second tenant restore fails and never selects a partial environment', async () => {
    const f = await fixture();
    await f.run();
    f.target.restore.mockRejectedValueOnce(new Error('second tenant failed'));
    await expect(f.run()).rejects.toThrow('second tenant failed');
    const saved = await f.saved();
    expect(saved.children.map((c) => c.phase)).toEqual(['verified', 'restoring']);
    expect((await authority.get(f.pairId, f.environmentId)).phase).toBe('draining');
    expect((await authority.get(f.pairId, f.environmentId)).epoch).toBe(1);
    expect(
      (
        await pool.query(
          'SELECT 1 FROM authrim_replication_environment_generations WHERE pair_id=$1',
          [f.pairId]
        )
      ).rowCount
    ).toBe(0);
  });
  it('uses a fresh child restore ID after an uncertain committed restore and fences its orphan', async () => {
    const f = await fixture();
    let orphan = '';
    f.target.restore.mockImplementationOnce(async (input) => {
      orphan = input.restoreId;
      await f.restore(input);
      throw new Error('restore response lost');
    });
    await expect(f.run()).rejects.toThrow('restore response lost');
    const before = await f.saved();
    const groupId = before.generationId;
    const complete = await f.complete();
    expect(complete.generationId).toBe(groupId);
    expect(complete.children[0].restoreId).not.toBe(orphan);
    expect(complete.children[0].attempt).toBe(2);
    expect(
      (await pool.query('SELECT 1 FROM test_environment_restores WHERE group_id=$1', [groupId]))
        .rowCount
    ).toBe(3);
    await expect(
      authority.enter({
        ...f.permit,
        permitId: randomUUID(),
        deploymentId: f.aws,
        epoch: 2,
        generationId: groupId,
        tenantId: 'alpha',
        restoreId: orphan,
      })
    ).rejects.toThrow('writer_fenced');
  });
  it.each(['beginDrain', 'promote'] as const)(
    'recovers a lost %s response using the same durable operation',
    async (method) => {
      const f = await fixture();
      const wrapped = loseReply(method);
      if (method === 'promote') await f.run({ authority: wrapped });
      await expect(f.run({ authority: wrapped })).rejects.toThrow('lost durable reply');
      const complete = await f.complete({ authority: wrapped });
      expect(complete.phase).toBe('complete');
      expect((await authority.get(f.pairId, f.environmentId)).epoch).toBe(2);
      expect(f.target.restore).toHaveBeenCalledTimes(2);
    }
  );
  it('rejects changed inventory after export without changing the writer pointer', async () => {
    const f = await fixture('sync');
    await f.run();
    const changed = { ...f.inventoryBody, tenants: f.inventoryBody.tenants.slice(0, 1) };
    f.source.inventory.mockResolvedValue({
      ...changed,
      observedAtMs: Date.now(),
      inventorySha256: await replicationInventoryDigest(changed),
    });
    await expect(f.run()).rejects.toThrow('operation_conflict');
    expect((await authority.get(f.pairId, f.environmentId)).epoch).toBe(1);
  });
  it.each(['scope', 'hash', 'incomplete'] as const)(
    'rejects invalid initial inventory %s before export or restore',
    async (kind) => {
      const f = await fixture('sync');
      const inventory = await f.source.inventory(0);
      if (kind === 'scope') {
        inventory.environmentId = 'different';
        const { observedAtMs: _time, inventorySha256: _sha, ...body } = inventory;
        inventory.inventorySha256 = await replicationInventoryDigest(body);
      }
      if (kind === 'hash') inventory.inventorySha256 = '0'.repeat(64);
      if (kind === 'incomplete') Object.assign(inventory, { complete: false });
      f.source.inventory.mockResolvedValue(inventory);
      await expect(f.run()).rejects.toThrow();
      expect(f.source.advance).not.toHaveBeenCalled();
      expect(f.target.restore).not.toHaveBeenCalled();
    }
  );
  it.each(['tenant', 'issuer', 'digest'] as const)(
    'rejects downloaded publication %s before target writes',
    async (kind) => {
      const f = await fixture('sync');
      const snapshot = await f.source.download(
        'alpha',
        `replication-backup-${restoreEvidenceDigest('alpha')}`,
        0
      );
      if (kind === 'tenant') snapshot.publication.receipt.source.tenantId = 'other';
      if (kind === 'issuer')
        snapshot.publication.receipt.source.issuer = 'https://other.example.test';
      if (kind !== 'digest')
        snapshot.publicationSha256 = restoreEvidenceDigest(snapshot.publication);
      else snapshot.publicationSha256 = '0'.repeat(64);
      f.source.download.mockResolvedValue(snapshot);
      await expect(f.run()).rejects.toThrow('operation_conflict');
      expect(f.target.restore).not.toHaveBeenCalled();
      expect(
        (
          await pool.query('SELECT 1 FROM test_environment_restores WHERE group_id=$1', [
            f.initial.generationId,
          ])
        ).rowCount
      ).toBe(0);
    }
  );
  it('fails over a complete standby without contacting CF or restoring data again', async () => {
    const f = await fixture('sync');
    const standby = await f.complete();
    const calls = {
      inventory: f.source.inventory.mock.calls.length,
      advance: f.source.advance.mock.calls.length,
      download: f.source.download.mock.calls.length,
      restore: f.target.restore.mock.calls.length,
    };
    f.source.inventory.mockRejectedValue(new Error('CF unavailable'));
    f.source.advance.mockRejectedValue(new Error('CF unavailable'));
    f.source.download.mockRejectedValue(new Error('CF unavailable'));
    const recovery = await failover(f, standby);
    const done = await recovery.run();
    expect(done.phase).toBe('complete');
    expect(await recovery.run()).toEqual(done);
    expect((await authority.get(f.pairId, f.environmentId)).epoch).toBe(2);
    expect({
      inventory: f.source.inventory.mock.calls.length,
      advance: f.source.advance.mock.calls.length,
      download: f.source.download.mock.calls.length,
      restore: f.target.restore.mock.calls.length,
    }).toEqual(calls);
  });
  it('blocks failover on unresolved permits, then resumes the same drain after completion', async () => {
    const f = await fixture('sync');
    const standby = await f.complete();
    await authority.enter(f.permit);
    const recovery = await failover(f, standby);
    expect((await recovery.run()).phase).toBe('draining');
    expect((await authority.get(f.pairId, f.environmentId)).epoch).toBe(1);
    await authority.complete(f.permit);
    expect((await recovery.run()).phase).toBe('complete');
  });
  it('rejects an expired standby using its oldest child', async () => {
    const f = await fixture('sync', 120000);
    const standby = await f.complete();
    const recovery = await failover(f, standby, 60000);
    await expect(recovery.run()).rejects.toThrow('snapshot_age_exceeded');
    expect((await authority.get(f.pairId, f.environmentId)).epoch).toBe(1);
  });
  it('resumes failover after a lost promotion reply without contacting the source or promoting twice', async () => {
    const f = await fixture('sync');
    const standby = await f.complete();
    const recovery = await failover(f, standby);
    const wrapped = loseReply('promote');
    await expect(recovery.run(wrapped)).rejects.toThrow('lost durable reply');
    expect((await recovery.run()).phase).toBe('complete');
    expect((await authority.get(f.pairId, f.environmentId)).epoch).toBe(2);
  });
  it.each(['proof', 'cutover', 'children', 'inventory', 'writerFlag'] as const)(
    'rejects contradictory completed checkpoint %s without repeating writes',
    async (kind) => {
      const f = await fixture();
      await f.complete();
      const restoreCount = f.target.restore.mock.calls.length;
      await f.alter((p) => {
        if (kind === 'proof') required(p.proof).generationId = randomUUID();
        if (kind === 'cutover') required(p.cutover).promotedEpoch = 3;
        if (kind === 'children') p.children.pop();
        if (kind === 'inventory')
          required(p.inventory).tenants[0].issuer = 'https://changed.example.test';
        if (kind === 'writerFlag') p.writerAuthorityChanged = false;
      });
      await expect(f.run()).rejects.toThrow();
      expect(f.target.restore).toHaveBeenCalledTimes(restoreCount);
      expect((await authority.get(f.pairId, f.environmentId)).epoch).toBe(2);
    }
  );
});
