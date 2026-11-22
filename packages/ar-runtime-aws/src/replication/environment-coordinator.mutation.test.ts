/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- mock call inspection */
import { describe, expect, it, vi } from 'vitest';
import { replicationInventoryDigest } from '@authrim/ar-lib-core/services/deployment-replication/environment-inventory';
import { restoreEvidenceDigest } from '../import/restore-evidence';
import {
  advanceEnvironmentFailover,
  advanceEnvironmentReplicationOperation,
} from './environment-coordinator';

const CONFLICT = 'environment_replication_operation_conflict';
const PLAN_SHA = 'a'.repeat(64);
const NOW = 10_000;
const BOUNDARY = 9_000;
const MAX_AGE = 60_000;
const TENANTS = ['tenant-a', 'tenant-b'];
const issuerOf = (t: string) => `https://${t}.example.test`;

const planFor = (mode: 'sync' | 'switch' | 'failover' = 'sync'): any => ({
  operationId: `op-${mode}`,
  pairId: 'pair-1',
  environmentId: 'env-1',
  sourceDeploymentId: 'cf-a',
  destinationDeploymentId: 'aws-a',
  expectedEpoch: 1,
  mode,
});
const identityFor = (mode: 'sync' | 'switch' | 'failover') => ({
  pairId: 'pair-1',
  environmentId: 'env-1',
  operationId: `op-${mode}`,
});

async function inventory(observedAtMs = 5000, tenants = TENANTS): Promise<any> {
  const body = {
    formatVersion: 1,
    complete: true,
    environmentId: 'env-1',
    pairId: 'pair-1',
    sourceDeploymentId: 'cf-a',
    writerCoverageSha256: 'b'.repeat(64),
    tenants: tenants.map((t) => ({
      tenantId: t,
      issuer: issuerOf(t),
      productVersion: '1.2.3',
      lifecycleState: 'active',
      placementGeneration: 1,
    })),
  };
  return { ...body, observedAtMs, inventorySha256: await replicationInventoryDigest(body) };
}
const snapshotFor = (tenantId: string, operationId: string): any => {
  const publication = {
    operationId,
    boundaryUnixMs: BOUNDARY,
    receipt: { source: { tenantId, issuer: issuerOf(tenantId), productVersion: '1.2.3' } },
  };
  return {
    publication,
    publicationSha256: restoreEvidenceDigest(publication),
    partPaths: [],
    publicationPath: '/x',
  };
};
const locationFor = (tenantId: string) => ({
  region: 'ap-northeast-1',
  issuerOrigin: issuerOf(tenantId),
  secretArn: `arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:synthetic-${tenantId}-abcdef`,
  secretVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  bucket: 'authrim-local-replication',
  bucketOwner: '123456789012',
  manifestKey: `generation/${tenantId}/manifest.json`,
  manifestVersionId: 'immutable-version',
  manifestSha256: 'c'.repeat(64),
});

function activeState(over: Record<string, unknown> = {}): any {
  return {
    pairId: 'pair-1',
    environmentId: 'env-1',
    ownerDeploymentId: 'cf-a',
    selectedGenerationId: 'g0',
    epoch: 1,
    revision: 3,
    phase: 'active',
    activeOperationId: null,
    drainedAtMs: null,
    outstandingPermits: 0,
    ...over,
  };
}
const drainingState = (mode: 'switch' | 'failover', over: Record<string, unknown> = {}) =>
  activeState({ phase: 'draining', activeOperationId: `op-${mode}`, drainedAtMs: 4000, ...over });

interface HarnessOptions {
  mode?: 'sync' | 'switch';
  initial?: any;
  planSha?: string;
}
async function harness(options: HarnessOptions = {}) {
  const mode = options.mode ?? 'sync';
  const plan = planFor(mode);
  const generationId = '11111111-1111-4111-8111-111111111111';
  const initial = options.initial ?? {
    formatVersion: 2,
    plan,
    phase: 'pending',
    generationId,
    children: [],
    writerAuthorityChanged: false,
  };
  let record: any = {
    operationId: plan.operationId,
    planSha256: options.planSha ?? PLAN_SHA,
    revision: 1,
    value: initial,
  };
  const events: string[] = [];
  let registered: any;
  let stateCalls = 0;
  const switchOp = (over: Record<string, unknown> = {}) => ({
    ...identityFor('switch'),
    kind: 'planned',
    sourceDeploymentId: 'cf-a',
    destinationDeploymentId: 'aws-a',
    expectedEpoch: 1,
    expectedRevision: 3,
    state: 'draining',
    drainRevision: 4,
    drainedAtMs: 4000,
    generation: null,
    promotedEpoch: null,
    ...over,
  });
  const authority: any = {
    get: vi.fn(async () => {
      events.push('get');
      stateCalls++;
      return mode === 'switch' && record.value.phase !== 'pending'
        ? drainingState('switch')
        : activeState();
    }),
    beginDrain: vi.fn(async () => (events.push('beginDrain'), switchOp())),
    getOperation: vi.fn(async () => {
      events.push('getOperation');
      return record.value.cutover?.state === 'promoted' ? record.value.cutover : switchOp();
    }),
    registerGeneration: vi.fn(async (g: any) => {
      events.push('registerGeneration');
      registered = structuredClone(g);
    }),
    getGeneration: vi.fn(async () => registered),
    verifyGeneration: vi.fn(async () => void events.push('verifyGeneration')),
    promote: vi.fn(async () => {
      events.push('promote');
      return switchOp({
        state: 'promoted',
        promotedEpoch: 2,
        generation: {
          generationId: record.value.generationId,
          digestSha256: record.value.generation.digestSha256,
          acceptedDataLoss: null,
        },
      });
    }),
  };
  const checkpoint = {
    current: () => record,
    save: vi.fn(async (value: any) => {
      events.push(`save:${value.phase}`);
      record = { ...record, revision: record.revision + 1, value: structuredClone(value) };
      return record;
    }),
  };
  const deps: any = {
    expectedPlan: plan,
    authority,
    checkpoint,
    maximumSnapshotAgeMs: MAX_AGE,
    now: () => NOW,
    source: {
      inventory: vi.fn(async (minimum: number) => {
        events.push(`inventory:${minimum}`);
        return inventory(Math.max(5000, minimum));
      }),
      advance: vi.fn(async (tenantId: string) => {
        events.push(`advance:${tenantId}`);
        return { id: `exp-${tenantId}`, state: 'ready', phase: 'export_complete', revision: 1 };
      }),
      download: vi.fn(async (tenantId: string, operationId: string) => {
        events.push(`download:${tenantId}`);
        return snapshotFor(tenantId, operationId);
      }),
    },
    target: {
      restore: vi.fn(async (a: any) => {
        events.push(`restore:${a.tenantId}`);
        return {
          generation: {
            pairId: 'pair-1',
            tenantId: a.tenantId,
            deploymentId: 'aws-a',
            generationId: a.restoreId,
            epoch: a.servingEpoch,
            location: locationFor(a.tenantId),
          },
          verificationSha256: 'd'.repeat(64),
        };
      }),
    },
  };
  const run = () => advanceEnvironmentReplicationOperation(deps);
  const runToEnd = async () => {
    let last: any;
    for (let i = 0; i < 40; i++) {
      last = await run();
      if (last.phase === 'complete') return last;
    }
    return last;
  };
  return {
    deps,
    authority,
    checkpoint,
    events,
    run,
    runToEnd,
    plan,
    record: () => record,
    registered: () => registered,
    stateCalls: () => stateCalls,
  };
}

describe('sync operation', () => {
  it('walks every tenant to a registered complete aggregate with exact arguments', async () => {
    const h = await harness();
    const result = await h.runToEnd();
    expect(result.phase).toBe('complete');
    expect(result.writerAuthorityChanged).toBe(false);
    expect(h.deps.source.inventory).toHaveBeenCalledWith(0);
    expect(h.deps.source.inventory).toHaveBeenLastCalledWith(0);
    expect(h.deps.source.advance).toHaveBeenCalledTimes(2);
    for (const t of TENANTS) {
      expect(h.deps.source.advance).toHaveBeenCalledWith(
        t,
        `op-sync:${restoreEvidenceDigest(t).slice(0, 16)}`
      );
      expect(h.deps.source.download).toHaveBeenCalledWith(t, `exp-${t}`, 0);
    }
    const restore0 = h.deps.target.restore.mock.calls[0][0];
    expect(restore0.tenantId).toBe('tenant-a');
    expect(restore0.generationId).toBe(result.generationId);
    expect(restore0.servingEpoch).toBe(2);
    expect(restore0.restoreId).toBe(result.children[0].restoreId);
    expect(restore0.restoreId).not.toBe(result.children[1].restoreId);
    const g = h.registered();
    expect(g).toMatchObject({
      formatVersion: 1,
      pairId: 'pair-1',
      environmentId: 'env-1',
      sourceDeploymentId: 'cf-a',
      deploymentId: 'aws-a',
      generationId: result.generationId,
      epoch: 2,
      sourceEpoch: 1,
      sourceFenceRevision: 0,
      sourceOperationId: 'op-sync',
      sourcePlanSha256: PLAN_SHA,
    });
    expect(g.inventory).toMatchObject({
      environmentId: 'env-1',
      sourceDeploymentId: 'cf-a',
      sourceEpoch: 1,
      sourceFenceRevision: 0,
      capturedAtMs: 5000,
      complete: true,
      sourceReceiptSha256: restoreEvidenceDigest(result.inventory),
    });
    expect(g.inventory.tenants).toEqual(
      TENANTS.map((t) => ({ tenantId: t, issuer: issuerOf(t), lifecycle: 'active' }))
    );
    expect(
      g.children.map((c: any) => [c.tenantId, c.capturedAtMs, c.sourceEpoch, c.sourceFenceRevision])
    ).toEqual(TENANTS.map((t) => [t, BOUNDARY, 1, 0]));
    expect(h.authority.registerGeneration).toHaveBeenCalledTimes(1);
    expect(h.authority.verifyGeneration).not.toHaveBeenCalled();
    expect(h.authority.promote).not.toHaveBeenCalled();
    expect(h.authority.beginDrain).not.toHaveBeenCalled();
  });
  it('is idempotent once complete (re-reads and compares the registered generation)', async () => {
    const h = await harness();
    await h.runToEnd();
    h.events.length = 0;
    const again = await h.run();
    expect(again.phase).toBe('complete');
    expect(h.authority.getGeneration).toHaveBeenCalledWith({
      pairId: 'pair-1',
      environmentId: 'env-1',
      deploymentId: 'aws-a',
      generationId: again.generationId,
      epoch: 2,
    });
    expect(h.events).not.toContain('registerGeneration');
  });
  it('rejects completion when the authority holds a different generation', async () => {
    const h = await harness();
    await h.runToEnd();
    h.authority.getGeneration.mockResolvedValue({ ...h.registered(), epoch: 9 });
    await expect(h.run()).rejects.toThrow(CONFLICT);
  });
  it('rejects completion flags and aggregates inconsistent with sync mode', async () => {
    const mk = async (fn: (v: any) => void) => {
      const h = await harness();
      await h.runToEnd();
      const done = structuredClone(h.record().value);
      fn(done);
      const h2 = await harness({ initial: done });
      h2.authority.getGeneration.mockResolvedValue(h.registered());
      return h2;
    };
    for (const fn of [
      (v: any) => (v.writerAuthorityChanged = true),
      (v: any) => (v.cutover = {}),
      (v: any) => (v.proof = {}),
    ]) {
      const h2 = await mk(fn);
      await expect(h2.run()).rejects.toThrow(CONFLICT);
    }
  });
  it('rejects tampered recorded generation fields', async () => {
    const h = await harness();
    await h.runToEnd();
    const base = structuredClone(h.record().value);
    const reg = h.registered();
    const tampers: Array<(v: any) => void> = [
      (v) => (v.generation.sourceFenceRevision = 1),
      (v) => (v.generation.sourceOperationId = 'other'),
      (v) => (v.generation.sourcePlanSha256 = 'f'.repeat(64)),
      (v) => (v.generation.epoch = 3),
      (v) => (v.generation.deploymentId = 'other'),
      (v) => (v.generation.sourceDeploymentId = 'other'),
      (v) => (v.generation.generationId = '22222222-2222-4222-8222-222222222222'),
      (v) => (v.generation = undefined),
      (v) => (v.generation.digestSha256 = 'f'.repeat(64)),
      (v) => (v.generation.children[0].restoreId = v.children[1].restoreId),
      (v) => (v.generation.children[0].capturedAtMs += 1),
      (v) => (v.generation.children[0].verificationSha256 = 'e'.repeat(64)),
      (v) => (v.generation.children[0].tenantId = 'x'),
      (v) => (v.generation.inventory.capturedAtMs += 1),
      (v) => (v.inventory.observedAtMs += 1),
    ];
    for (const fn of tampers) {
      const v = structuredClone(base);
      fn(v);
      const h2 = await harness({ initial: v });
      h2.authority.getGeneration.mockResolvedValue(reg);
      await expect(h2.run()).rejects.toThrow();
      expect(h2.authority.registerGeneration).not.toHaveBeenCalled();
    }
  });
  it('rejects a cancelled journal', async () => {
    const h = await harness();
    await h.runToEnd();
    const v = { ...structuredClone(h.record().value), phase: 'cancelled' };
    const h2 = await harness({ initial: v });
    await expect(h2.run()).rejects.toThrow(CONFLICT);
    expect(h2.events).toEqual([]);
  });
});

describe('operation guards', () => {
  it('rejects unsupported modes and out-of-range snapshot ages', async () => {
    const h = await harness();
    h.deps.expectedPlan = { ...h.plan, mode: 'failover' };
    await expect(h.run()).rejects.toThrow(CONFLICT);
    for (const age of [999, 1.5, Number.NaN]) {
      const h2 = await harness();
      h2.deps.maximumSnapshotAgeMs = age;
      await expect(h2.run()).rejects.toThrow(CONFLICT);
      expect(h2.events).toEqual([]);
    }
    const h3 = await harness();
    h3.deps.maximumSnapshotAgeMs = 1000;
    h3.authority.get.mockResolvedValue(activeState({ phase: 'draining' }));
    await expect(h3.run()).rejects.toThrow(CONFLICT);
    expect(h3.authority.get).toHaveBeenCalled();
  });
  it('requires the source to be active and unchanged to begin', async () => {
    for (const over of [
      { phase: 'draining' },
      { ownerDeploymentId: 'aws-a' },
      { epoch: 2 },
      { pairId: 'x' },
      { environmentId: 'x' },
    ]) {
      const h = await harness();
      h.authority.get.mockResolvedValue(activeState(over));
      await expect(h.run()).rejects.toThrow(CONFLICT);
      expect(h.deps.source.inventory).not.toHaveBeenCalled();
    }
  });
  it('rejects inventories for another environment, pair or deployment, or older than required', async () => {
    for (const fn of [
      async (v: any) => (v.environmentId = 'other'),
      async (v: any) => (v.pairId = 'other'),
      async (v: any) => (v.sourceDeploymentId = 'other'),
    ]) {
      const h = await harness();
      h.deps.source.inventory.mockImplementation(async () => {
        const v = await inventory();
        await fn(v);
        v.inventorySha256 = await replicationInventoryDigest(
          (({ observedAtMs: _t, inventorySha256: _d, ...b }) => b)(v)
        );
        return v;
      });
      await expect(h.run()).rejects.toThrow(CONFLICT);
      expect(h.checkpoint.save).not.toHaveBeenCalled();
    }
  });
  it('accepts an inventory observed exactly at the required minimum', async () => {
    const h = await harness();
    h.deps.source.inventory.mockResolvedValue(await inventory(0));
    await expect(h.run()).resolves.toBeTruthy();
  });
  it('rejects malformed stored progress before any remote call', async () => {
    const base = async () => {
      const h = await harness();
      await h.run();
      return structuredClone(h.record().value);
    };
    const tampers: Array<(v: any) => void> = [
      (v) => (v.formatVersion = 1),
      (v) => (v.plan.operationId = 'other'),
      (v) => (v.generationId = 'not-a-uuid'),
      (v) => (v.generationId = `x${v.generationId}`),
      (v) => (v.generationId = `${v.generationId}x`),
      (v) => (v.children = 'x'),
      (v) => (v.phase = 'whatever'),
      (v) => (v.writerAuthorityChanged = true),
      (v) => (v.inventory = undefined),
      (v) => (v.inventory.pairId = 'x'),
      (v) => (v.inventory.environmentId = 'x'),
      (v) => (v.inventory.sourceDeploymentId = 'x'),
      (v) => (v.children = v.children.slice(0, 1)),
      (v) => (v.children[0].tenantId = 'other'),
      (v) => (v.children[1].restoreId = v.children[0].restoreId),
      (v) => (v.children[0].restoreId = 'bad'),
      (v) => (v.children[0].attempt = 0),
      (v) => (v.children[0].attempt = 1.5),
      (v) => (v.children[0].phase = 'weird'),
      (v) => (v.children[0].phase = 'downloaded'),
      (v) => (v.children[0].phase = 'restoring'),
      (v) => (v.children[0].destination = { generation: {}, verificationSha256: 'x' }),
    ];
    for (const fn of tampers) {
      const v = await base();
      fn(v);
      const h = await harness({ initial: v });
      await expect(h.run()).rejects.toThrow();
      expect(h.events).toEqual([]);
    }
    const pending: Array<(v: any) => void> = [
      (v) => (v.children = [{}]),
      (v) => (v.inventory = {}),
      (v) => (v.generation = {}),
      (v) => (v.cutover = {}),
      (v) => (v.proof = {}),
    ];
    for (const fn of pending) {
      const h0 = await harness();
      const v = structuredClone(h0.record().value);
      fn(v);
      const h = await harness({ initial: v });
      await expect(h.run()).rejects.toThrow();
      expect(h.events).toEqual([]);
    }
  });
  it('rejects too many children', async () => {
    const h0 = await harness();
    await h0.run();
    const v = structuredClone(h0.record().value);
    v.children = Array.from({ length: 17 }, () => v.children[0]);
    const h = await harness({ initial: v });
    await expect(h.run()).rejects.toThrow(CONFLICT);
  });
  it('validates stored child snapshots and verified destinations', async () => {
    const h0 = await harness();
    await h0.runToEnd();
    const done = h0.record().value;
    const tampers: Array<(v: any) => void> = [
      (v) => (v.children[0].snapshot.publication.operationId = 'x'),
      (v) => (v.children[0].snapshot.publication.receipt.source.tenantId = 'x'),
      (v) => (v.children[0].snapshot.publication.receipt.source.issuer = 'https://x.example.test'),
      (v) => (v.children[0].snapshot.publicationSha256 = 'f'.repeat(64)),
      (v) => (v.children[0].source = undefined),
      (v) => (v.children[0].snapshot = undefined),
      (v) => (v.children[0].destination = undefined),
      (v) => (v.children[0].destination.generation.pairId = 'x'),
      (v) => (v.children[0].destination.generation.tenantId = 'x'),
      (v) => (v.children[0].destination.generation.deploymentId = 'x'),
      (v) => (v.children[0].destination.generation.generationId = 'x'),
      (v) => (v.children[0].destination.generation.epoch = 1),
      (v) =>
        (v.children[0].destination.generation.location.issuerOrigin = 'https://x.example.test'),
      (v) => (v.children[0].destination.verificationSha256 = 'x'),
      (v) => (v.children[0].destination.verificationSha256 = `x${'d'.repeat(64)}`),
      (v) => (v.children[0].destination.verificationSha256 = `${'d'.repeat(64)}x`),
    ];
    for (const fn of tampers) {
      const v = structuredClone(done);
      fn(v);
      const h = await harness({ initial: v });
      await expect(h.run()).rejects.toThrow();
      expect(h.events.filter((e) => e.startsWith('advance') || e.startsWith('restore'))).toEqual(
        []
      );
    }
    // a pending child may not carry a destination
    const v = structuredClone(done);
    v.phase = 'exporting';
    v.generation = undefined;
    v.children[0].phase = 'exporting';
    const h = await harness({ initial: v });
    await expect(h.run()).rejects.toThrow(CONFLICT);
  });
});

describe('per-child steps', () => {
  it('stops after saving the source when it is not ready', async () => {
    const h = await harness();
    h.deps.source.advance.mockResolvedValue({
      id: 'exp-1',
      state: 'running',
      phase: 'exporting',
      revision: 1,
    });
    await h.run();
    const result = await h.run();
    expect(result.phase).toBe('exporting');
    expect(result.children[0].phase).toBe('exporting');
    expect(h.deps.source.download).not.toHaveBeenCalled();
  });
  it('rejects a changed export operation for the same child', async () => {
    const h = await harness();
    h.deps.source.advance.mockResolvedValue({
      id: 'exp-1',
      state: 'running',
      phase: 'exporting',
      revision: 1,
    });
    await h.run();
    await h.run();
    h.deps.source.advance.mockResolvedValue({
      id: 'exp-2',
      state: 'running',
      phase: 'exporting',
      revision: 1,
    });
    await expect(h.run()).rejects.toThrow(CONFLICT);
  });
  it('accepts the same export operation again', async () => {
    const h = await harness();
    h.deps.source.advance.mockResolvedValue({
      id: 'exp-1',
      state: 'running',
      phase: 'exporting',
      revision: 1,
    });
    await h.run();
    await h.run();
    await expect(h.run()).resolves.toBeTruthy();
  });
  it('allocates a fresh restore id and attempt after an interrupted restore', async () => {
    const h = await harness();
    h.deps.target.restore.mockImplementationOnce(async () => {
      throw new Error('crash');
    });
    await expect(h.run()).rejects.toThrow('crash');
    const interrupted = h.record().value;
    expect(interrupted.children[0].phase).toBe('restoring');
    const firstRestore = interrupted.children[0].restoreId;
    const next = await h.run();
    expect(next.children[0].restoreId).not.toBe(firstRestore);
    expect(next.children[0].attempt).toBe(2);
    expect(next.children[0].phase).toBe('verified');
  });
  it('requires the authority to be unchanged around a restore', async () => {
    for (const second of [
      activeState({ epoch: 2 }),
      activeState({ ownerDeploymentId: 'aws-a' }),
      activeState({ phase: 'draining', activeOperationId: 'op-sync' }),
      activeState({ activeOperationId: 'zzz' }),
    ]) {
      const h = await harness();
      let n = 0;
      h.authority.get.mockImplementation(async () => (n++ < 2 ? activeState() : second));
      await expect(h.run()).rejects.toThrow(CONFLICT);
      expect(h.record().value.children[0].phase).toBe('restoring');
    }
  });
  it('rejects the whole aggregate when a snapshot is too old, from the future, or before the minimum', async () => {
    const run = async (now: number, boundary = BOUNDARY, mutate?: (h: any) => void) => {
      const h = await harness();
      h.deps.now = () => now;
      h.deps.source.download.mockImplementation(async (t: string, id: string) => {
        const s = snapshotFor(t, id);
        s.publication.boundaryUnixMs = boundary;
        s.publicationSha256 = restoreEvidenceDigest(s.publication);
        return s;
      });
      mutate?.(h);
      return h.runToEnd();
    };
    await expect(run(BOUNDARY + MAX_AGE)).resolves.toMatchObject({ phase: 'complete' });
    await expect(run(BOUNDARY + MAX_AGE + 1)).rejects.toThrow(CONFLICT);
    await expect(run(BOUNDARY - 30_000)).resolves.toMatchObject({ phase: 'complete' });
    await expect(run(BOUNDARY - 30_001)).rejects.toThrow(CONFLICT);
  });
  it('detects a changed inventory at the end of the export', async () => {
    const h = await harness();
    let calls = 0;
    h.deps.source.inventory.mockImplementation(async () =>
      inventory(5000, calls++ === 0 ? TENANTS : [...TENANTS, 'tenant-c'])
    );
    await expect(h.runToEnd()).rejects.toThrow();
    expect(h.authority.registerGeneration).not.toHaveBeenCalled();
  });
  it('detects an inventory with a different digest at the end of the export', async () => {
    const h = await harness();
    let calls = 0;
    h.deps.source.inventory.mockImplementation(async () => {
      const v = await inventory(5000);
      if (calls++ === 0) return v;
      const body = { ...v, writerCoverageSha256: 'e'.repeat(64) };
      const { observedAtMs: _t, inventorySha256: _d, ...rest } = body;
      return { ...body, inventorySha256: await replicationInventoryDigest(rest) };
    });
    await expect(h.runToEnd()).rejects.toThrow(CONFLICT);
  });
});

describe('switch operation', () => {
  it('drains, exports at the drained boundary, registers, verifies and promotes', async () => {
    const h = await harness({ mode: 'switch' });
    h.authority.get.mockImplementation(async () =>
      h.record().value.phase === 'pending' ? activeState() : drainingState('switch')
    );
    const result = await h.runToEnd();
    expect(result.phase).toBe('complete');
    expect(result.writerAuthorityChanged).toBe(true);
    expect(h.authority.beginDrain).toHaveBeenCalledWith({
      ...identityFor('switch'),
      kind: 'planned',
      sourceDeploymentId: 'cf-a',
      destinationDeploymentId: 'aws-a',
      expectedEpoch: 1,
      expectedRevision: 3,
    });
    expect(h.deps.source.inventory.mock.calls.map((c: any) => c[0])).toEqual([0, 4000, 4000]);
    for (const t of TENANTS)
      expect(h.deps.source.download).toHaveBeenCalledWith(t, `exp-${t}`, 4000);
    expect(h.registered().sourceFenceRevision).toBe(4);
    const proof = {
      generationId: result.generationId,
      digestSha256: h.registered().digestSha256,
      acceptedDataLoss: null,
    };
    expect(h.authority.verifyGeneration).toHaveBeenCalledWith(identityFor('switch'), proof);
    expect(h.authority.promote).toHaveBeenCalledWith(identityFor('switch'));
    expect(result.proof).toEqual(proof);
    expect(result.cutover.state).toBe('promoted');
    expect(h.events.indexOf('registerGeneration')).toBeLessThan(
      h.events.indexOf('verifyGeneration')
    );
    expect(h.events.indexOf('verifyGeneration')).toBeLessThan(h.events.indexOf('promote'));
  });
  // Drive a switch journal to the 'draining' phase by reporting an outstanding permit.
  async function drainingJournal() {
    const h = await harness({ mode: 'switch' });
    h.authority.get.mockImplementation(async () =>
      h.record().value.phase === 'pending'
        ? activeState()
        : drainingState('switch', { outstandingPermits: 1 })
    );
    const first = await h.run();
    expect(first.phase).toBe('draining');
    return h;
  }
  it('stays draining while permits remain or no drain time is known', async () => {
    for (const [state, op] of [
      [drainingState('switch', { outstandingPermits: 1 }), undefined],
      [drainingState('switch', { drainedAtMs: null }), undefined],
      [drainingState('switch'), { drainedAtMs: null }],
    ] as const) {
      const h = await drainingJournal();
      h.authority.get.mockResolvedValue(state);
      if (op)
        h.authority.getOperation.mockResolvedValue({
          ...identityFor('switch'),
          ...op,
          state: 'draining',
        });
      const result = await h.run();
      expect(result.phase).toBe('draining');
      expect(h.deps.source.advance).not.toHaveBeenCalled();
    }
  });
  it('requires the authority to be draining this operation', async () => {
    for (const over of [
      activeState(),
      drainingState('switch', { activeOperationId: 'other' }),
      drainingState('switch', { epoch: 2 }),
      drainingState('switch', { ownerDeploymentId: 'aws-a' }),
    ]) {
      const h = await drainingJournal();
      h.authority.get.mockResolvedValue(over);
      await expect(h.run()).rejects.toThrow(CONFLICT);
    }
  });
  it('rejects a drained inventory observed before the drain completed', async () => {
    const h = await drainingJournal();
    h.authority.get.mockResolvedValue(drainingState('switch'));
    h.deps.source.inventory.mockResolvedValue(await inventory(3999));
    await expect(h.run()).rejects.toThrow(CONFLICT);
    h.deps.source.inventory.mockClear();
    const ok = await drainingJournal();
    ok.authority.get.mockImplementation(async () => drainingState('switch'));
    ok.deps.source.inventory.mockResolvedValue(await inventory(4000));
    await expect(ok.run()).resolves.toBeTruthy();
    expect(ok.deps.source.inventory).toHaveBeenCalledWith(4000);
  });
  it('requires an unchanged inventory digest after the drain', async () => {
    const h = await harness({ mode: 'switch' });
    await h.run();
    h.authority.get.mockResolvedValue(drainingState('switch'));
    h.deps.source.inventory.mockResolvedValue(await inventory(5000, [...TENANTS, 'tenant-c']));
    await expect(h.run()).rejects.toThrow(CONFLICT);
  });
  it('exporting requires an exact drained state without permits', async () => {
    for (const over of [
      activeState(),
      drainingState('switch', { activeOperationId: 'other' }),
      drainingState('switch', { outstandingPermits: 1 }),
      drainingState('switch', { epoch: 2 }),
    ]) {
      const h = await harness({ mode: 'switch' });
      h.authority.get.mockImplementation(async () =>
        h.record().value.phase === 'pending' ? activeState() : drainingState('switch')
      );
      h.deps.source.advance.mockResolvedValue({
        id: 'exp-1',
        state: 'running',
        phase: 'exporting',
        revision: 1,
      });
      const first = await h.run();
      expect(first.phase).toBe('exporting');
      h.deps.source.advance.mockClear();
      h.authority.get.mockResolvedValue(over);
      await expect(h.run()).rejects.toThrow(CONFLICT);
      expect(h.deps.source.advance).not.toHaveBeenCalled();
    }
  });
  it('requires a cutover intent when draining', async () => {
    const h0 = await drainingJournal();
    const v = structuredClone(h0.record().value);
    expect(v.phase).toBe('draining');
    v.cutover = undefined;
    const h = await harness({ mode: 'switch', initial: v });
    await expect(h.run()).rejects.toThrow(CONFLICT);
    expect(h.authority.beginDrain).not.toHaveBeenCalled();
  });
  async function completedSwitch() {
    const h = await harness({ mode: 'switch' });
    h.authority.get.mockImplementation(async () =>
      h.record().value.phase === 'pending' ? activeState() : drainingState('switch')
    );
    await h.runToEnd();
    return { h, done: structuredClone(h.record().value), reg: h.registered() };
  }
  it('re-verifies a completed switch against the authority operation and proof', async () => {
    const { h, done, reg } = await completedSwitch();
    const again = await harness({ mode: 'switch', initial: done });
    again.authority.getGeneration.mockResolvedValue(reg);
    again.authority.getOperation.mockResolvedValue(done.cutover);
    await expect(again.run()).resolves.toMatchObject({ phase: 'complete' });
    expect(h.authority.promote).toHaveBeenCalledTimes(1);
    const tampers: Array<(v: any) => void> = [
      (v) => (v.writerAuthorityChanged = false),
      (v) => (v.cutover = undefined),
      (v) => (v.cutover.state = 'verified'),
      (v) => (v.cutover.kind = 'failover'),
      (v) => (v.cutover.sourceDeploymentId = 'x'),
      (v) => (v.cutover.destinationDeploymentId = 'x'),
      (v) => (v.cutover.expectedEpoch = 2),
      (v) => (v.cutover.promotedEpoch = 3),
      (v) => (v.proof.digestSha256 = 'f'.repeat(64)),
      (v) => (v.proof.acceptedDataLoss = {}),
      (v) => (v.cutover.generation = { ...v.proof, digestSha256: 'f'.repeat(64) }),
    ];
    for (const fn of tampers) {
      const v = structuredClone(done);
      fn(v);
      const h2 = await harness({ mode: 'switch', initial: v });
      h2.authority.getGeneration.mockResolvedValue(reg);
      h2.authority.getOperation.mockResolvedValue(done.cutover);
      await expect(h2.run()).rejects.toThrow();
    }
    const h3 = await harness({ mode: 'switch', initial: structuredClone(done) });
    h3.authority.getGeneration.mockResolvedValue(reg);
    h3.authority.getOperation.mockResolvedValue({ ...done.cutover, promotedEpoch: 3 });
    await expect(h3.run()).rejects.toThrow(CONFLICT);
  });
});

describe('failover', () => {
  async function standby() {
    const h = await harness();
    await h.runToEnd();
    const progress = structuredClone(h.record().value);
    return { progress, generation: h.registered() };
  }
  const failoverPlan = () => planFor('failover');
  function fo(
    progress: any,
    generation: any,
    over: Record<string, unknown> = {},
    initialValue?: any
  ) {
    const plan = failoverPlan();
    let record: any = {
      operationId: plan.operationId,
      planSha256: 'e'.repeat(64),
      revision: 1,
      value: initialValue ?? {
        formatVersion: 2,
        plan,
        phase: 'pending',
        generationId: '33333333-3333-4333-8333-333333333333',
        children: [],
        writerAuthorityChanged: false,
      },
    };
    const events: string[] = [];
    const foOp = (o: Record<string, unknown> = {}) => ({
      ...identityFor('failover'),
      kind: 'failover',
      sourceDeploymentId: 'cf-a',
      destinationDeploymentId: 'aws-a',
      expectedEpoch: 1,
      expectedRevision: 3,
      state: 'draining',
      drainRevision: 4,
      drainedAtMs: 4000,
      generation: null,
      promotedEpoch: null,
      ...o,
    });
    const authority: any = {
      get: vi.fn(
        async () => (
          events.push('get'),
          record.value.phase === 'pending' ? activeState() : drainingState('failover')
        )
      ),
      getGeneration: vi.fn(async () => generation),
      beginDrain: vi.fn(async () => (events.push('beginDrain'), foOp())),
      getOperation: vi.fn(
        async () => (
          events.push('getOperation'),
          record.value.cutover?.state === 'promoted' ? record.value.cutover : foOp()
        )
      ),
      verifyGeneration: vi.fn(async () => void events.push('verifyGeneration')),
      promote: vi.fn(async () => {
        events.push('promote');
        return foOp({ state: 'promoted', promotedEpoch: 2, generation: record.value.proof });
      }),
    };
    const checkpoint = {
      current: () => record,
      save: vi.fn(async (value: any) => {
        events.push(`save:${value.phase}`);
        record = { ...record, revision: record.revision + 1, value: structuredClone(value) };
        return record;
      }),
    };
    const input: any = {
      expectedPlan: plan,
      authority,
      checkpoint,
      reviewedStandby: { planSha256: PLAN_SHA, progress: structuredClone(progress) },
      maximumSnapshotAgeMs: MAX_AGE,
      ...over,
    };
    return {
      input,
      authority,
      checkpoint,
      events,
      record: () => record,
      run: () => advanceEnvironmentFailover(input),
    };
  }
  it('drains, records data-loss acceptance, verifies and promotes the reviewed standby', async () => {
    const { progress, generation } = await standby();
    const h = fo(progress, generation);
    const result = await h.run();
    expect(h.events).toEqual([
      'get',
      'save:draining',
      'beginDrain',
      'get',
      'save:draining',
      'getOperation',
      'save:verified',
      'verifyGeneration',
      'promote',
      'save:complete',
    ]);
    expect(result.phase).toBe('complete');
    expect(result.writerAuthorityChanged).toBe(true);
    expect(h.authority.getGeneration).toHaveBeenCalledWith({
      pairId: 'pair-1',
      environmentId: 'env-1',
      deploymentId: 'aws-a',
      generationId: generation.generationId,
      epoch: 2,
    });
    expect(h.authority.beginDrain).toHaveBeenCalledWith({
      ...identityFor('failover'),
      kind: 'failover',
      sourceDeploymentId: 'cf-a',
      destinationDeploymentId: 'aws-a',
      expectedEpoch: 1,
      expectedRevision: 3,
    });
    const proof = {
      generationId: generation.generationId,
      digestSha256: generation.digestSha256,
      acceptedDataLoss: {
        sourceSyncOperationId: 'op-sync',
        sourceSyncPlanSha256: PLAN_SHA,
        maximumSnapshotAgeMs: MAX_AGE,
        acceptedAtMs: 4000,
      },
    };
    expect(result.proof).toEqual(proof);
    expect(h.authority.verifyGeneration).toHaveBeenCalledWith(identityFor('failover'), proof);
    expect(h.authority.promote).toHaveBeenCalledWith(identityFor('failover'));
    expect(result.generationId).toBe(generation.generationId);
    expect(result.inventory).toEqual(progress.inventory);
    expect(result.children).toEqual(progress.children);
    expect(result.generation).toEqual(generation);
  });
  it('is idempotent when complete and cross-checks the authority operation', async () => {
    const { progress, generation } = await standby();
    const h = fo(progress, generation);
    const done = await h.run();
    const again = fo(progress, generation);
    again.checkpoint.current = () => ({ ...h.record(), value: structuredClone(done) });
    again.authority.getOperation.mockResolvedValue(done.cutover);
    await expect(again.run()).resolves.toMatchObject({ phase: 'complete' });
    again.authority.getOperation.mockResolvedValue({ ...done.cutover, promotedEpoch: 7 });
    await expect(again.run()).rejects.toThrow(CONFLICT);
  });
  it('rejects completed journals that do not carry the reviewed acceptance', async () => {
    const { progress, generation } = await standby();
    const h = fo(progress, generation);
    const done = await h.run();
    const tampers: Array<(v: any) => void> = [
      (v) => (v.writerAuthorityChanged = false),
      (v) => (v.cutover = undefined),
      (v) => (v.cutover.state = 'verified'),
      (v) => (v.proof.acceptedDataLoss.maximumSnapshotAgeMs = MAX_AGE + 1),
      (v) => (v.proof.acceptedDataLoss.sourceSyncPlanSha256 = 'f'.repeat(64)),
      (v) => (v.proof.acceptedDataLoss.sourceSyncOperationId = 'other'),
      (v) => (v.proof = { ...v.proof, digestSha256: 'f'.repeat(64) }),
      (v) => (v.generation.digestSha256 = 'f'.repeat(64)),
      (v) => (v.inventory.observedAtMs += 1),
      (v) => (v.children = v.children.slice(0, 1)),
      (v) => (v.generationId = '44444444-4444-4444-8444-444444444444'),
    ];
    for (const fn of tampers) {
      const v = structuredClone(done);
      fn(v);
      const again = fo(progress, generation, {}, v);
      again.authority.getOperation.mockResolvedValue(done.cutover);
      await expect(again.run()).rejects.toThrow();
    }
  });
  it('rejects a cancelled journal', async () => {
    const { progress, generation } = await standby();
    const h = fo(progress, generation);
    h.checkpoint.current = () => ({
      ...h.record(),
      value: { ...h.record().value, phase: 'cancelled' },
    });
    await expect(h.run()).rejects.toThrow(CONFLICT);
  });
  it('requires the source to be an active owner at the reviewed epoch', async () => {
    const { progress, generation } = await standby();
    for (const over of [{ phase: 'draining' }, { ownerDeploymentId: 'aws-a' }, { epoch: 2 }]) {
      const h = fo(progress, generation);
      h.authority.get.mockResolvedValue(activeState(over));
      await expect(h.run()).rejects.toThrow(CONFLICT);
      expect(h.checkpoint.save).not.toHaveBeenCalled();
    }
  });
  it('requires the drain to be this operation', async () => {
    const { progress, generation } = await standby();
    for (const over of [activeState(), drainingState('failover', { activeOperationId: 'other' })]) {
      const h = fo(progress, generation);
      await h.run().catch(() => undefined);
      // run again from saved draining state
      const h2 = fo(progress, generation);
      await h2.input.checkpoint.save({
        ...h2.record().value,
        phase: 'draining',
        generation,
        inventory: progress.inventory,
        children: progress.children,
        generationId: generation.generationId,
        cutover: {
          ...identityFor('failover'),
          kind: 'failover',
          sourceDeploymentId: 'cf-a',
          destinationDeploymentId: 'aws-a',
          expectedEpoch: 1,
          expectedRevision: 3,
          state: 'draining',
          drainRevision: 0,
          drainedAtMs: null,
          generation: null,
          promotedEpoch: null,
        },
      });
      h2.authority.get.mockResolvedValue(over);
      await expect(h2.run()).rejects.toThrow(CONFLICT);
    }
  });
  it('stays draining while permits remain or the drain time is unknown', async () => {
    const { progress, generation } = await standby();
    for (const [state, op] of [
      [drainingState('failover', { outstandingPermits: 1 }), null],
      [drainingState('failover', { drainedAtMs: null }), null],
      [drainingState('failover'), { drainedAtMs: null }],
    ] as const) {
      const h = fo(progress, generation);
      let first = true;
      h.authority.get.mockImplementation(async () =>
        first ? ((first = false), activeState()) : state
      );
      if (op)
        h.authority.getOperation.mockResolvedValue({
          ...identityFor('failover'),
          kind: 'failover',
          sourceDeploymentId: 'cf-a',
          destinationDeploymentId: 'aws-a',
          expectedEpoch: 1,
          expectedRevision: 3,
          state: 'draining',
          drainRevision: 4,
          generation: null,
          promotedEpoch: null,
          ...op,
        });
      const result = await h.run();
      expect(result.phase).toBe('draining');
      expect(h.authority.verifyGeneration).not.toHaveBeenCalled();
    }
  });
  it('rejects standby evidence that does not match the reviewed plan', async () => {
    const { progress, generation } = await standby();
    const tampers: Array<[string, (p: any, i: any) => void]> = [
      ['not complete', (p) => (p.phase = 'verified')],
      ['not a sync', (p) => (p.plan.mode = 'switch')],
      ['writer changed', (p) => (p.writerAuthorityChanged = true)],
      ['pair', (p) => (p.plan.pairId = 'x')],
      ['environment', (p) => (p.plan.environmentId = 'x')],
      ['source', (p) => (p.plan.sourceDeploymentId = 'x')],
      ['destination', (p) => (p.plan.destinationDeploymentId = 'x')],
      ['epoch', (p) => (p.plan.expectedEpoch = 2)],
      ['generation digest', (p) => (p.generation.digestSha256 = 'f'.repeat(64))],
      ['inventory', (p) => (p.inventory.inventorySha256 = 'f'.repeat(64))],
      ['child', (p) => (p.children[0].destination.verificationSha256 = 'e'.repeat(64))],
    ];
    for (const [, fn] of tampers) {
      const p = structuredClone(progress);
      fn(p, undefined);
      const h = fo(p, generation);
      await expect(h.run()).rejects.toThrow();
      expect(h.authority.beginDrain).not.toHaveBeenCalled();
    }
    for (const maximumSnapshotAgeMs of [999, 30 * 86_400_000 + 1, 1.5, Number.NaN]) {
      const h = fo(progress, generation, { maximumSnapshotAgeMs });
      await expect(h.run()).rejects.toThrow(CONFLICT);
      expect(h.authority.getGeneration).not.toHaveBeenCalled();
    }
    for (const maximumSnapshotAgeMs of [1000, 30 * 86_400_000]) {
      const h = fo(progress, generation, { maximumSnapshotAgeMs });
      await expect(h.run()).resolves.toBeTruthy();
    }
    const wrongMode = fo(progress, generation);
    wrongMode.input.expectedPlan = { ...failoverPlan(), mode: 'sync' };
    await expect(wrongMode.run()).rejects.toThrow(CONFLICT);
  });
  it('rejects when the authority holds a different standby generation', async () => {
    const { progress, generation } = await standby();
    const h = fo(progress, generation);
    h.authority.getGeneration.mockResolvedValue({ ...generation, epoch: 9 });
    await expect(h.run()).rejects.toThrow(CONFLICT);
    expect(h.authority.beginDrain).not.toHaveBeenCalled();
  });
  it('journals created for a different generation or standby content are rejected after pending', async () => {
    const { progress, generation } = await standby();
    const h = fo(progress, generation);
    await h.run();
    const done = h.record().value;
    for (const fn of [
      (v: any) => (v.generationId = '44444444-4444-4444-8444-444444444444'),
      (v: any) => (v.generation.digestSha256 = 'f'.repeat(64)),
      (v: any) => (v.inventory.writerCoverageSha256 = 'f'.repeat(64)),
      (v: any) => (v.children[0].attempt = 5),
    ]) {
      const v = structuredClone(done);
      v.phase = 'verified';
      v.writerAuthorityChanged = false;
      fn(v);
      const again = fo(progress, generation, {}, v);
      await expect(again.run()).rejects.toThrow();
      expect(again.authority.promote).not.toHaveBeenCalled();
    }
  });
  it('verified journals must carry the exact reviewed acceptance', async () => {
    const { progress, generation } = await standby();
    const h = fo(progress, generation);
    const done = await h.run();
    const verified = (fn: (v: any) => void) => {
      const v = structuredClone(done);
      v.phase = 'verified';
      v.writerAuthorityChanged = false;
      v.cutover = { ...v.cutover, state: 'draining', generation: null, promotedEpoch: null } as any;
      fn(v);
      const again = fo(progress, generation, {}, v);
      return again;
    };
    const ok = verified(() => {});
    await expect(ok.run()).resolves.toMatchObject({ phase: 'complete' });
    for (const fn of [
      (v: any) => (v.proof = undefined),
      (v: any) => (v.proof.generationId = 'other'),
      (v: any) => (v.proof.digestSha256 = 'f'.repeat(64)),
      (v: any) => (v.proof.acceptedDataLoss.maximumSnapshotAgeMs = 1),
      (v: any) => (v.proof.acceptedDataLoss.sourceSyncOperationId = 'other'),
      (v: any) => (v.proof.acceptedDataLoss.sourceSyncPlanSha256 = 'f'.repeat(64)),
    ]) {
      const bad = verified(fn);
      await expect(bad.run()).rejects.toThrow();
      expect(bad.authority.promote).not.toHaveBeenCalled();
    }
  });
});
