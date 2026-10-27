import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DeploymentAuthority } from '@authrim/ar-lib-core/services/deployment-replication/authority';
import { PostgresDeploymentAuthority } from './authority-postgres';
import { ReplicationJournal } from './journal';
import {
  PostgresReplicationGenerationCatalog,
  type ReplicationGenerationLocation,
} from './generation-catalog';
import {
  advanceReplicationOperation,
  type ReplicationCoordinatorDependencies,
  type ReplicationOperationPlan,
  type ReplicationOperationProgress,
} from './coordinator';
import type { DownloadedReplicationExport } from './export-client';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('test fixture missing');
  return value;
}

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

(url ? describe : describe.skip)(
  'replication coordination with native PostgreSQL authority and journal',
  () => {
    const schema = `replication_coordinator_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url });
    const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 });
    const authority = new PostgresDeploymentAuthority(pool);
    const journal = new ReplicationJournal(pool);
    const catalog = new PostgresReplicationGenerationCatalog(pool);
    let created = false;
    beforeAll(async () => {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      for (const path of [
        'authority-schema.sql',
        'generation-catalog-schema.sql',
        'journal-schema.sql',
      ])
        await pool.query(await readFile(new URL(path, import.meta.url), 'utf8'));
      await pool.query(
        'CREATE TABLE test_restore_targets (generation_id text PRIMARY KEY, complete boolean NOT NULL)'
      );
    });
    afterAll(async () => {
      await pool.end();
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });

    async function fixture(mode: 'sync' | 'switch' = 'switch') {
      const pairId = randomUUID();
      const tenantId = `tenant-${randomUUID()}`;
      await authority.initialize({
        pairId,
        tenantId,
        deployments: [
          { deploymentId: 'cf-a', provider: 'cloudflare' },
          { deploymentId: 'aws-a', provider: 'aws' },
        ],
        initialOwnerDeploymentId: 'cf-a',
        initialGenerationId: 'initial-generation',
      });
      const plan: ReplicationOperationPlan = {
        operationId: randomUUID(),
        pairId,
        tenantId,
        sourceDeploymentId: 'cf-a',
        destinationDeploymentId: 'aws-a',
        expectedEpoch: 1,
        mode,
      };
      const initial: ReplicationOperationProgress = {
        formatVersion: 1,
        phase: 'pending',
        plan,
        generationId: randomUUID(),
        attempt: 0,
        writerAuthorityChanged: false,
      };
      const exportId = `replication-backup-${'b'.repeat(64)}`;
      const source = {
        advance: vi.fn(async () => ({
          id: exportId,
          state: 'ready',
          phase: 'export_complete',
          revision: 1,
        })),
        download: vi.fn(
          async (_id: string, minimum: number): Promise<DownloadedReplicationExport> => ({
            publication: {
              formatVersion: 1,
              operationId: exportId,
              expiresAt: Date.now() + 60_000,
              byteCount: 1,
              boundaryUnixMs: minimum || Date.now(),
              receipt: {
                source: { tenantId, issuer: 'https://idp.example.test', productVersion: '0.4.2' },
                bundleId: 'a'.repeat(32),
                snapshotId: 'snapshot-a',
                inventoryDigestSha256: 'c'.repeat(64),
                parts: [{ size: 1, sha256: 'd'.repeat(64) }],
              },
              selection: {
                settings: true,
                users: true,
                admin: false,
                logs: { audit: false, other: false, sensitive: false, period: 7 },
                artifacts: false,
              },
              datasets: [],
            },
            partPaths: ['/synthetic/part'],
            publicationPath: '/synthetic/publication.json',
            publicationSha256: 'e'.repeat(64),
          })
        ),
      };
      const target = {
        restore: vi.fn(
          async ({
            generationId,
            servingEpoch,
          }: Parameters<ReplicationCoordinatorDependencies['target']['restore']>[0]) => {
            await pool.query('INSERT INTO test_restore_targets VALUES ($1,true)', [generationId]);
            return {
              generation: {
                pairId,
                tenantId,
                deploymentId: 'aws-a',
                generationId,
                epoch: servingEpoch,
                location,
              },
              verificationSha256: 'f'.repeat(64),
            };
          }
        ),
        register: vi.fn((generation: ReplicationGenerationLocation) =>
          catalog.register(generation)
        ),
      };
      const run = (override: Partial<ReplicationCoordinatorDependencies> = {}) =>
        journal.withOperation({
          pairId,
          operationId: plan.operationId,
          planSha256: 'a'.repeat(64),
          initial,
          run: (checkpoint) =>
            advanceReplicationOperation({
              expectedPlan: plan,
              authority,
              checkpoint,
              source,
              target,
              ...override,
            }),
        });
      const saved = () =>
        journal.withOperation({
          pairId,
          operationId: plan.operationId,
          planSha256: 'a'.repeat(64),
          initial,
          run: async (checkpoint) => checkpoint.current().value,
        });
      return { pairId, tenantId, plan, initial, source, target, run, saved };
    }

    function loseReply(method: 'beginDrain' | 'promote'): DeploymentAuthority {
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
              throw new Error('response lost after durable operation');
            }
            return result;
          };
        },
      });
    }

    it('keeps ordinary synchronization non-serving, with no authority change', async () => {
      const f = await fixture('sync');
      const result = await f.run();
      expect(result.phase).toBe('complete');
      expect(result.writerAuthorityChanged).toBe(false);
      expect(await authority.get(f.pairId, f.tenantId)).toMatchObject({
        ownerDeploymentId: 'cf-a',
        epoch: 1,
        selectedGenerationId: 'initial-generation',
        phase: 'active',
      });
      expect(f.target.restore).toHaveBeenCalledTimes(1);
      expect(await f.run()).toEqual(result);
      expect(f.target.restore).toHaveBeenCalledTimes(1);
      const { location: _location, ...identity } = required(result.destination).generation;
      expect(await catalog.get(identity)).toEqual(required(result.destination).generation);
    });

    it.each(['beginDrain', 'promote'] as const)(
      'resumes an actual committed %s after its response is lost',
      async (method) => {
        const f = await fixture();
        const unreliable = loseReply(method);
        await expect(f.run({ authority: unreliable })).rejects.toThrow('response lost');
        expect((await f.saved()).phase).toBe(method === 'beginDrain' ? 'draining' : 'verified');
        const result = await f.run();
        expect(result.phase).toBe('complete');
        expect(result.cutover?.promotedEpoch).toBe(2);
        expect(f.target.restore).toHaveBeenCalledTimes(1);
        expect((await authority.get(f.pairId, f.tenantId)).selectedGenerationId).toBe(
          result.generationId
        );
      }
    );

    it('blocks without starting export while a non-expiring writer remains unresolved', async () => {
      const f = await fixture();
      const permit = {
        pairId: f.pairId,
        tenantId: f.tenantId,
        deploymentId: 'cf-a',
        epoch: 1,
        generationId: 'initial-generation',
        permitId: randomUUID(),
        operationDigest: 'a'.repeat(64),
      };
      await authority.enter(permit);
      expect((await f.run()).phase).toBe('draining');
      expect(f.source.advance).not.toHaveBeenCalled();
      expect(f.target.restore).not.toHaveBeenCalled();
      await authority.complete(permit);
      expect((await f.run()).phase).toBe('complete');
    });

    it('abandons a partially restored generation and resumes into a new empty target', async () => {
      const f = await fixture();
      f.target.restore.mockImplementationOnce(async ({ generationId }) => {
        await pool.query('INSERT INTO test_restore_targets VALUES ($1,false)', [generationId]);
        throw new Error('uncertain family commit');
      });
      await expect(f.run()).rejects.toThrow('uncertain family commit');
      expect((await f.saved()).phase).toBe('restoring');
      const result = await f.run();
      expect(result.generationId).not.toBe(f.initial.generationId);
      expect(result.attempt).toBe(1);
      const targets = await pool.query<{ generation_id: string; complete: boolean }>(
        'SELECT * FROM test_restore_targets WHERE generation_id=ANY($1::text[]) ORDER BY complete',
        [[f.initial.generationId, result.generationId]]
      );
      expect(targets.rows).toEqual([
        { generation_id: f.initial.generationId, complete: false },
        { generation_id: result.generationId, complete: true },
      ]);
      expect(f.target.register).toHaveBeenCalledTimes(1);
      expect((await authority.get(f.pairId, f.tenantId)).selectedGenerationId).toBe(
        result.generationId
      );
    });

    it('rejects a pre-drain snapshot and does not allocate a destination', async () => {
      const f = await fixture();
      const original = required(f.source.download.getMockImplementation());
      f.source.download.mockImplementation(async (id, minimum) => {
        const snapshot = await original(id, minimum);
        snapshot.publication.boundaryUnixMs = minimum - 1;
        return snapshot;
      });
      await expect(f.run()).rejects.toThrow('replication_operation_conflict');
      expect(f.target.restore).not.toHaveBeenCalled();
      expect((await authority.get(f.pairId, f.tenantId)).phase).toBe('draining');
    });

    it('rejects source epoch changes during restore before registering the stale result', async () => {
      const f = await fixture('sync');
      const original = required(f.target.restore.getMockImplementation());
      f.target.restore.mockImplementation(async (input) => {
        const result = await original(input);
        const drain = await authority.beginDrain({
          pairId: f.pairId,
          tenantId: f.tenantId,
          operationId: randomUUID(),
          sourceDeploymentId: 'cf-a',
          destinationDeploymentId: 'aws-a',
          expectedEpoch: 1,
          expectedRevision: 1,
        });
        const identity = { pairId: f.pairId, tenantId: f.tenantId, operationId: drain.operationId };
        await authority.verifyGeneration(identity, {
          generationId: randomUUID(),
          sourceDeploymentId: 'cf-a',
          destinationDeploymentId: 'aws-a',
          sourceEpoch: 1,
          sourceFenceRevision: drain.drainRevision,
          capturedAtMs: required(drain.drainedAtMs),
          manifestSha256: 'c'.repeat(64),
          verificationSha256: 'd'.repeat(64),
        });
        await authority.promote(identity);
        return result;
      });
      await expect(f.run()).rejects.toThrow('replication_operation_conflict');
      expect(f.target.register).not.toHaveBeenCalled();
      expect((await f.saved()).phase).toBe('restoring');
    });

    it('refuses a contradictory recovered destination even when the operation already promoted', async () => {
      const f = await fixture();
      await expect(f.run({ authority: loseReply('promote') })).rejects.toThrow('response lost');
      await journal.withOperation({
        pairId: f.pairId,
        operationId: f.plan.operationId,
        planSha256: 'a'.repeat(64),
        initial: f.initial,
        run: async (checkpoint) => {
          const progress = checkpoint.current().value;
          required(progress.destination).verificationSha256 = 'b'.repeat(64);
          await checkpoint.save(progress);
        },
      });
      await expect(f.run()).rejects.toThrow('idempotency_conflict');
      expect((await f.saved()).phase).toBe('verified');
      expect((await authority.get(f.pairId, f.tenantId)).epoch).toBe(2);
    });

    it('rejects checkpoint plan drift before any source or target operation', async () => {
      const f = await fixture();
      await journal.withOperation({
        pairId: f.pairId,
        operationId: f.plan.operationId,
        planSha256: 'a'.repeat(64),
        initial: { ...f.initial, plan: { ...f.plan, destinationDeploymentId: 'other-deployment' } },
        run: async () => undefined,
      });
      await expect(f.run()).rejects.toThrow('replication_operation_conflict');
      expect(f.source.advance).not.toHaveBeenCalled();
      expect(f.target.restore).not.toHaveBeenCalled();
      expect((await authority.get(f.pairId, f.tenantId)).phase).toBe('active');
    });

    it('keeps catalog pins immutable and refuses cross-tenant or unregistered destinations', async () => {
      const f = await fixture('sync');
      const completed = await f.run();
      const generation = required(completed.destination).generation;
      await catalog.register(generation);
      await expect(
        catalog.register({
          ...generation,
          location: { ...location, manifestSha256: 'b'.repeat(64) },
        })
      ).rejects.toThrow('replication_generation_conflict');
      await expect(
        catalog.register({ ...generation, generationId: randomUUID(), tenantId: 'other-tenant' })
      ).rejects.toThrow();
      await expect(
        catalog.register({
          ...generation,
          generationId: randomUUID(),
          deploymentId: 'other-deployment',
        })
      ).rejects.toThrow();
      const { location: _location, ...identity } = generation;
      await expect(catalog.get({ ...identity, epoch: identity.epoch + 1 })).rejects.toThrow(
        'replication_generation_unavailable'
      );
      await expect(
        catalog.register({
          ...generation,
          unexpected: 'must-not-persist',
        } as ReplicationGenerationLocation)
      ).rejects.toThrow('replication_generation_invalid');
    });

    it('serializes one pair journal, rejects plan rebinding, and closes escaped checkpoint writers', async () => {
      const f = await fixture();
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let escaped: ((value: ReplicationOperationProgress) => Promise<unknown>) | undefined;
      const running = journal.withOperation({
        pairId: f.pairId,
        operationId: f.plan.operationId,
        planSha256: 'a'.repeat(64),
        initial: f.initial,
        run: async (checkpoint) => {
          escaped = (value) => checkpoint.save(value);
          entered();
          await gate;
        },
      });
      await ready;
      await expect(f.run()).rejects.toThrow('replication_operation_busy');
      release();
      await running;
      await expect(required(escaped)(f.initial)).rejects.toThrow('replication_journal_closed');
      await expect(
        journal.withOperation({
          pairId: f.pairId,
          operationId: f.plan.operationId,
          planSha256: 'b'.repeat(64),
          initial: f.initial,
          run: async () => undefined,
        })
      ).rejects.toThrow('replication_plan_conflict');
      expect((await f.saved()).phase).toBe('pending');
    });
  }
);
