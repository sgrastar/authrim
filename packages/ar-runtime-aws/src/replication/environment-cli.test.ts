import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EnvironmentCheckpoint,
  EnvironmentOperationProgress,
} from './environment-coordinator';
import type { ReplicationJournalRecord } from './journal';
import { canonicalRestoreJson, restoreEvidenceDigest } from '../import/restore-evidence';
import { environmentTestConfiguration } from './environment-test-fixture';
import type { EnvironmentReplicationPlan } from './environment-plan';
import {
  runEnvironmentReplicationCommand,
  readEnvironmentObservation,
  type EnvironmentObservedState,
} from './environment-cli';
const mocked = vi.hoisted(() => ({
  pool: vi.fn(),
  end: vi.fn(),
  journalScope: vi.fn(),
  sync: vi.fn(),
  failover: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('pg', () => ({
  Pool: class {
    constructor(options: unknown) {
      mocked.pool(options);
    }
    on() {}
    async end() {
      mocked.end();
    }
  },
}));
vi.mock('./environment-coordinator', () => ({
  advanceEnvironmentReplicationOperation: mocked.sync,
  advanceEnvironmentFailover: mocked.failover,
}));
vi.mock('./restore-generation', () => ({ restoreReplicationGeneration: mocked.restore }));
vi.mock('./journal', () => ({
  ReplicationJournal: class {
    constructor(_pool: unknown, scope: string) {
      mocked.journalScope(scope);
    }
    async withOperation(input: {
      operationId: string;
      planSha256: string;
      initial: EnvironmentOperationProgress;
      run: (checkpoint: EnvironmentCheckpoint) => Promise<unknown>;
    }) {
      let current: ReplicationJournalRecord<EnvironmentOperationProgress> = {
        operationId: input.operationId,
        planSha256: input.planSha256,
        revision: 1,
        value: structuredClone(input.initial),
      };
      return input.run({
        current: () => structuredClone(current),
        save: async (value) => {
          current = { ...current, revision: current.revision + 1, value: structuredClone(value) };
          return structuredClone(current);
        },
      });
    }
  },
}));
const folders: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'authrim-env-cli-'));
  folders.push(root);
  const configuration = environmentTestConfiguration(join(root, 'schema.sql'), 'a'.repeat(64));
  const plan: EnvironmentReplicationPlan = {
    formatVersion: 2,
    planId: randomUUID(),
    createdAtMs: Date.now(),
    executorSha256: 'b'.repeat(64),
    authoritySchemaSha256: 'c'.repeat(64),
    configuration,
  };
  const planPath = join(root, 'plan.json'),
    statePath = join(root, 'state.json');
  const rawPlan = canonicalRestoreJson(plan);
  await writeFile(planPath, rawPlan, { mode: 0o600 });
  const args = {
    command: 'sync',
    planPath,
    statePath,
    rawPlan,
    planSha256: restoreEvidenceDigest(plan),
    executorSha256: plan.executorSha256,
    environment: {},
  };
  return { root, plan, args };
}
describe('environment CLI wiring without live providers', () => {
  it.each(['wrong-plan', 'wrong-digest', 'wrong-mode'] as const)(
    'rejects %s local observation before reading credentials or opening DB',
    async (kind) => {
      const f = await fixture();
      const prior: EnvironmentObservedState = {
        formatVersion: 2,
        kind: 'operation',
        mode: kind === 'wrong-mode' ? 'switch' : 'sync',
        planPath: kind === 'wrong-plan' ? join(f.root, 'other.json') : f.args.planPath,
        planSha256: kind === 'wrong-digest' ? 'f'.repeat(64) : f.args.planSha256,
        observedAtMs: Date.now(),
        journal: null,
      };
      await writeFile(f.args.statePath, canonicalRestoreJson(prior), { mode: 0o600 });
      const reads: string[] = [];
      const environment = new Proxy<Record<string, string | undefined>>(
        {},
        {
          get(_target, key) {
            reads.push(String(key));
            throw new Error('credentials must not be read');
          },
        }
      );
      await expect(runEnvironmentReplicationCommand({ ...f.args, environment })).rejects.toThrow(
        'environment_replication_cli_invalid'
      );
      expect(reads).toEqual([]);
      expect(mocked.pool).not.toHaveBeenCalled();
      expect(mocked.sync).not.toHaveBeenCalled();
      expect(mocked.failover).not.toHaveBeenCalled();
    }
  );
  it('runs the failover branch using only authority credentials and the exact pinned local standby', async () => {
    const f = await fixture();
    const standbyPath = join(f.root, 'standby.json');
    const standby = {
      formatVersion: 2,
      kind: 'operation',
      mode: 'sync',
      planPath: join(f.root, 'previous-plan.json'),
      planSha256: 'd'.repeat(64),
      observedAtMs: Date.now(),
      journal: {
        operationId: 'previous-sync',
        planSha256: 'd'.repeat(64),
        revision: 5,
        value: {
          formatVersion: 2,
          phase: 'complete',
          writerAuthorityChanged: false,
          inventory: {
            tenants: f.plan.configuration.tenants.map((child) => ({
              tenantId: child.pair.tenantId,
              issuer: child.source.identity.issuer,
              productVersion: child.source.identity.productVersion,
            })),
          },
        },
      },
    };
    await writeFile(standbyPath, canonicalRestoreJson(standby), { mode: 0o600 });
    f.plan.configuration.failover = {
      standbyStatePath: standbyPath,
      standbyStateSha256: restoreEvidenceDigest(standby),
      maximumSnapshotAgeMs: 60000,
    };
    const rawPlan = canonicalRestoreJson(f.plan);
    const reads: string[] = [];
    const values: Record<string, string | undefined> = {
      AUTHORITY_DATABASE:
        'postgresql://replication_journal:local-only@db.example.test/authority?sslmode=verify-full',
      AUTHORITY_SECRET: 'a'.repeat(64),
    };
    const environment = new Proxy(values, {
      get(target, key) {
        if (typeof key !== 'string' || !Object.hasOwn(target, key))
          throw new Error('unexpected source or restore credential read');
        reads.push(key);
        return target[key];
      },
    });
    const transport = vi.fn(async (url: unknown, options: RequestInit) => {
      expect(String(url)).toBe(f.plan.configuration.authority.endpoint);
      if (typeof options.body !== 'string') throw new Error('missing JSON');
      const envelope = JSON.parse(options.body) as { action: string; payload: unknown };
      expect(envelope.action).toBe('environmentGet');
      expect(envelope.payload).toEqual({ pairId: 'pair-a', environmentId: 'env-a' });
      return Response.json({ phase: 'active' });
    });
    vi.stubGlobal('fetch', transport);
    mocked.failover.mockImplementationOnce(
      async (input: {
        expectedPlan: { pairId: string; environmentId: string; mode: string };
        authority: { get: (pairId: string, environmentId: string) => Promise<unknown> };
        reviewedStandby: unknown;
        maximumSnapshotAgeMs: number;
        checkpoint: EnvironmentCheckpoint;
      }) => {
        expect(input.expectedPlan.mode).toBe('failover');
        expect(input.maximumSnapshotAgeMs).toBe(60000);
        expect(input.reviewedStandby).toEqual({
          planSha256: standby.planSha256,
          progress: standby.journal.value,
        });
        await input.authority.get(input.expectedPlan.pairId, input.expectedPlan.environmentId);
        return input.checkpoint.current().value;
      }
    );
    await runEnvironmentReplicationCommand({
      ...f.args,
      command: 'failover',
      rawPlan,
      planSha256: restoreEvidenceDigest(f.plan),
      environment,
    });
    expect(reads).toEqual(['AUTHORITY_DATABASE', 'AUTHORITY_SECRET']);
    expect(mocked.pool).toHaveBeenCalledOnce();
    expect(mocked.journalScope).toHaveBeenCalledExactlyOnceWith('environment');
    expect(mocked.failover).toHaveBeenCalledOnce();
    expect(mocked.sync).not.toHaveBeenCalled();
    expect(mocked.restore).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
    expect(mocked.end).toHaveBeenCalledOnce();
    const observed = await readEnvironmentObservation(f.args.statePath);
    expect(observed?.mode).toBe('failover');
    expect(observed?.planSha256).toBe(restoreEvidenceDigest(f.plan));
    expect((await stat(f.args.statePath)).mode & 0o077).toBe(0);
    expect(await readFile(f.args.statePath, 'utf8')).not.toContain('local-only');
  });
});
