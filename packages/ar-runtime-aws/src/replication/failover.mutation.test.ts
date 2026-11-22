/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- mock call inspection */
import { describe, expect, it, vi } from 'vitest';
import { advanceReplicationFailover } from './failover';

const INVALID = 'replication_failover_invalid';
const KNOWN =
  /^(replication_failover_invalid|replication_transport_invalid|deployment_authority_invalid_input|replication_generation_invalid|aws_deployment_config_invalid)$/;
const SYNC_SHA = 'a'.repeat(64);
const location = {
  region: 'ap-northeast-1',
  issuerOrigin: 'https://idp.example.test',
  secretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:synthetic-abcdef',
  secretVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  bucket: 'authrim-local-replication',
  bucketOwner: '123456789012',
  manifestKey: 'generation/manifest.json',
  manifestVersionId: 'immutable-version',
  manifestSha256: 'b'.repeat(64),
};
const MAX_AGE = 60_000;
const failoverPlan = (): any => ({
  operationId: 'fo-1',
  pairId: 'pair-1',
  tenantId: 'tenant-1',
  sourceDeploymentId: 'cf-a',
  destinationDeploymentId: 'aws-a',
  expectedEpoch: 1,
  mode: 'failover',
});
const identity = { pairId: 'pair-1', tenantId: 'tenant-1', operationId: 'fo-1' };
const FENCE = 3;
const registeredGeneration = () => ({
  generationId: 'gen-1',
  sourceDeploymentId: 'cf-a',
  destinationDeploymentId: 'aws-a',
  sourceEpoch: 1,
  sourceFenceRevision: FENCE,
  capturedAtMs: 5000,
  manifestSha256: location.manifestSha256,
  verificationSha256: 'd'.repeat(64),
});
function standbyProgress(): any {
  return {
    formatVersion: 1,
    phase: 'complete',
    plan: { ...failoverPlan(), mode: 'sync', operationId: 'sync-1' },
    generationId: 'gen-1',
    attempt: 1,
    writerAuthorityChanged: false,
    source: { id: 'exp-1', state: 'ready', phase: 'export_complete' },
    snapshot: {
      publication: {
        operationId: 'exp-1',
        boundaryUnixMs: 5000,
        receipt: { source: { tenantId: 'tenant-1' } },
      },
      publicationSha256: 'c'.repeat(64),
    },
    destination: {
      generation: {
        pairId: 'pair-1',
        tenantId: 'tenant-1',
        deploymentId: 'aws-a',
        generationId: 'gen-1',
        epoch: 2,
        location: structuredClone(location),
      },
      verificationSha256: 'd'.repeat(64),
    },
    standby: {
      pairId: 'pair-1',
      tenantId: 'tenant-1',
      sourceSyncOperationId: 'sync-1',
      sourceSyncPlanSha256: SYNC_SHA,
      generation: registeredGeneration(),
    },
  };
}
const proofFor = (drainedAtMs: number) => ({
  generation: registeredGeneration(),
  acceptedDataLoss: {
    sourceSyncOperationId: 'sync-1',
    sourceSyncPlanSha256: SYNC_SHA,
    maximumSnapshotAgeMs: MAX_AGE,
    acceptedAtMs: drainedAtMs,
  },
});
const operation = (over: Record<string, unknown> = {}): any => ({
  ...identity,
  kind: 'failover',
  acceptedDataLoss: null,
  sourceDeploymentId: 'cf-a',
  destinationDeploymentId: 'aws-a',
  expectedEpoch: 1,
  expectedRevision: FENCE,
  state: 'draining',
  drainRevision: FENCE + 1,
  drainedAtMs: 4000,
  generation: null,
  promotedEpoch: null,
  ...over,
});
function journalProgress(
  phase: 'pending' | 'draining' | 'verified' | 'complete',
  over: Record<string, unknown> = {}
): any {
  const s = standbyProgress();
  const base: any = {
    formatVersion: 1,
    phase,
    plan: failoverPlan(),
    generationId: 'gen-fo',
    attempt: 0,
    writerAuthorityChanged: phase === 'complete',
  };
  if (phase !== 'pending') {
    base.generationId = 'gen-1';
    base.snapshot = s.snapshot;
    base.destination = s.destination;
    base.standby = s.standby;
  }
  if (phase === 'draining') base.cutover = operation({ drainRevision: 0, drainedAtMs: null });
  if (phase === 'verified') {
    base.cutover = operation();
    base.failoverProof = proofFor(4000);
  }
  if (phase === 'complete') {
    base.cutover = operation({
      state: 'promoted',
      promotedEpoch: 2,
      generation: registeredGeneration(),
      acceptedDataLoss: proofFor(4000).acceptedDataLoss,
    });
    base.failoverProof = proofFor(4000);
  }
  return { ...base, ...over };
}
const activeState = (over: Record<string, unknown> = {}): any => ({
  pairId: 'pair-1',
  tenantId: 'tenant-1',
  ownerDeploymentId: 'cf-a',
  selectedGenerationId: 'g0',
  epoch: 1,
  revision: FENCE,
  phase: 'active',
  activeOperationId: null,
  drainedAtMs: null,
  outstandingPermits: 0,
  ...over,
});
const drainingState = (over: Record<string, unknown> = {}) =>
  activeState({ phase: 'draining', activeOperationId: 'fo-1', drainedAtMs: 4000, ...over });

function harness(
  initial: any,
  over: { standby?: any; plan?: any; maxAge?: number; planSha?: string; record?: any } = {}
) {
  let record: any = over.record ?? {
    operationId: 'fo-1',
    planSha256: 'e'.repeat(64),
    revision: 1,
    value: initial,
  };
  const events: string[] = [];
  const saves: any[] = [];
  const authority: any = {
    get: vi.fn(async () => (events.push('get'), activeState())),
    beginFailoverDrain: vi.fn(async () => (events.push('beginFailoverDrain'), operation())),
    getOperation: vi.fn(async () => (events.push('getOperation'), operation())),
    verifyFailoverGeneration: vi.fn(async () => void events.push('verifyFailoverGeneration')),
    promote: vi.fn(async () => {
      events.push('promote');
      return operation({
        state: 'promoted',
        promotedEpoch: 2,
        generation: registeredGeneration(),
        acceptedDataLoss: proofFor(4000).acceptedDataLoss,
      });
    }),
  };
  const checkpoint = {
    current: () => record,
    save: vi.fn(async (value: any) => {
      events.push(`save:${value.phase}`);
      saves.push(structuredClone(value));
      record = { ...record, revision: record.revision + 1, value: structuredClone(value) };
      return record;
    }),
  };
  const input: any = {
    expectedPlan: over.plan ?? failoverPlan(),
    authority,
    checkpoint,
    reviewedStandby: {
      planSha256: over.planSha ?? SYNC_SHA,
      progress: over.standby ?? standbyProgress(),
    },
    maximumSnapshotAgeMs: over.maxAge ?? MAX_AGE,
  };
  return {
    input,
    authority,
    checkpoint,
    events,
    saves,
    run: () => advanceReplicationFailover(input),
  };
}

describe('input validation (no remote effects on failure)', () => {
  const planTampers: Array<[string, (p: any) => void]> = [
    ['extra plan key', (p) => (p.extra = 1)],
    ['missing plan key', (p) => delete p.tenantId],
    ['non-failover mode', (p) => (p.mode = 'sync')],
    ['same source and destination', (p) => (p.destinationDeploymentId = 'cf-a')],
    ['epoch zero', (p) => (p.expectedEpoch = 0)],
    ['epoch fractional', (p) => (p.expectedEpoch = 1.5)],
    ['epoch at maximum', (p) => (p.expectedEpoch = Number.MAX_SAFE_INTEGER)],
  ];
  for (const [name, fn] of planTampers) {
    it(`rejects plan with ${name}`, async () => {
      const plan = failoverPlan();
      fn(plan);
      const h = harness(journalProgress('pending'), { plan });
      await expect(h.run()).rejects.toThrow(KNOWN);
      expect(h.events).toEqual([]);
    });
  }
  it('rejects plan identifiers that are not valid', async () => {
    for (const key of [
      'operationId',
      'pairId',
      'tenantId',
      'sourceDeploymentId',
      'destinationDeploymentId',
    ]) {
      const plan = failoverPlan();
      plan[key] = 'bad id';
      const h = harness(journalProgress('pending'), { plan });
      await expect(h.run()).rejects.toThrow(KNOWN);
      expect(h.events).toEqual([]);
    }
  });
  const standbyTampers: Array<[string, (s: any) => void]> = [
    ['missing', () => {}],
    ['format version', (s) => (s.formatVersion = 2)],
    ['not complete', (s) => (s.phase = 'verified')],
    ['no plan', (s) => (s.plan = undefined)],
    ['plan not sync', (s) => (s.plan.mode = 'switch')],
    ['writer authority changed', (s) => (s.writerAuthorityChanged = true)],
    ['plan tenant differs', (s) => (s.plan.tenantId = 'x')],
    ['plan pair differs', (s) => (s.plan.pairId = 'x')],
    ['plan epoch differs', (s) => (s.plan.expectedEpoch = 2)],
    ['same operation id as failover', (s) => (s.plan.operationId = 'fo-1')],
    ['attempt fractional', (s) => (s.attempt = 0.5)],
    ['attempt negative', (s) => (s.attempt = -1)],
    ['has a cutover', (s) => (s.cutover = {})],
    ['no destination', (s) => (s.destination = undefined)],
    ['no snapshot', (s) => (s.snapshot = undefined)],
    ['no registered standby', (s) => (s.standby = undefined)],
    ['destination pair', (s) => (s.destination.generation.pairId = 'x')],
    ['destination tenant', (s) => (s.destination.generation.tenantId = 'x')],
    ['destination deployment', (s) => (s.destination.generation.deploymentId = 'x')],
    ['destination generation', (s) => (s.destination.generation.generationId = 'x')],
    ['destination epoch', (s) => (s.destination.generation.epoch = 1)],
    ['destination location', (s) => (s.destination.generation.location.region = 'x')],
    ['standby pair', (s) => (s.standby.pairId = 'x')],
    ['standby tenant', (s) => (s.standby.tenantId = 'x')],
    ['standby sync operation', (s) => (s.standby.sourceSyncOperationId = 'x')],
    ['standby plan digest', (s) => (s.standby.sourceSyncPlanSha256 = 'f'.repeat(64))],
    ['standby generation id', (s) => (s.standby.generation.generationId = 'x')],
    ['standby source', (s) => (s.standby.generation.sourceDeploymentId = 'x')],
    ['standby destination', (s) => (s.standby.generation.destinationDeploymentId = 'x')],
    ['standby epoch', (s) => (s.standby.generation.sourceEpoch = 2)],
    ['standby captured', (s) => (s.standby.generation.capturedAtMs = 1)],
    ['standby manifest', (s) => (s.standby.generation.manifestSha256 = 'e'.repeat(64))],
    ['standby verification', (s) => (s.standby.generation.verificationSha256 = 'e'.repeat(64))],
    [
      'sync operation id invalid',
      (s) => ((s.plan.operationId = 'bad id'), (s.standby.sourceSyncOperationId = 'bad id')),
    ],
  ];
  for (const [name, fn] of standbyTampers) {
    it(`rejects reviewed standby with ${name}`, async () => {
      const s = standbyProgress();
      fn(s);
      const h = harness(journalProgress('pending'), {
        standby: name === 'missing' ? undefined : s,
      });
      if (name === 'missing') h.input.reviewedStandby.progress = undefined;
      await expect(h.run()).rejects.toThrow(KNOWN);
      expect(h.events).toEqual([]);
      expect(h.authority.get).not.toHaveBeenCalled();
    });
  }
  it('rejects bad reviewed plan digest and maximum age values', async () => {
    for (const planSha of ['A'.repeat(64), 'a'.repeat(63), `x${SYNC_SHA}`, `${SYNC_SHA}x`]) {
      const h = harness(journalProgress('pending'), { planSha });
      await expect(h.run()).rejects.toThrow(KNOWN);
      expect(h.events).toEqual([]);
    }
    for (const maxAge of [999, 30 * 86_400_000 + 1, 1.5, Number.NaN]) {
      const h = harness(journalProgress('pending'), { maxAge });
      await expect(h.run()).rejects.toThrow(INVALID);
      expect(h.events).toEqual([]);
    }
  });
  it('accepts the 1000 ms and 30 day maximum-age boundaries', async () => {
    for (const maxAge of [1000, 30 * 86_400_000]) {
      const h = harness(journalProgress('pending'), { maxAge });
      h.authority.get.mockResolvedValue(activeState());
      await h.run().catch(() => undefined);
      expect(h.authority.get).toHaveBeenCalled();
    }
  });
  it('rejects a journal record for another operation or with a bad digest/revision', async () => {
    const make = (over: Record<string, unknown>) => ({
      operationId: 'fo-1',
      planSha256: 'e'.repeat(64),
      revision: 1,
      value: journalProgress('pending'),
      ...over,
    });
    for (const over of [
      { operationId: 'other' },
      { planSha256: 'E'.repeat(64) },
      { planSha256: `x${'e'.repeat(64)}` },
      { planSha256: `${'e'.repeat(64)}x` },
      { revision: 0 },
      { revision: 1.5 },
    ]) {
      const h = harness(null, { record: make(over) });
      await expect(h.run()).rejects.toThrow(INVALID);
      expect(h.events).toEqual([]);
    }
  });
  const progressTampers: Array<[string, (p: any) => void]> = [
    ['formatVersion', (p) => (p.formatVersion = 2)],
    ['plan', (p) => (p.plan.operationId = 'x')],
    ['phase', (p) => (p.phase = 'exporting')],
    ['attempt', (p) => (p.attempt = -1)],
    ['writer authority', (p) => (p.writerAuthorityChanged = true)],
    ['generation id', (p) => (p.generationId = 'bad id')],
    ['pending with cutover', (p) => (p.cutover = {})],
    ['pending with proof', (p) => (p.failoverProof = {})],
    ['pending with standby', (p) => (p.standby = {})],
    ['pending with snapshot', (p) => (p.snapshot = {})],
    ['pending with destination', (p) => (p.destination = {})],
  ];
  for (const [name, fn] of progressTampers) {
    it(`rejects stored pending progress with bad ${name}`, async () => {
      const p = journalProgress('pending');
      fn(p);
      const h = harness(p);
      await expect(h.run()).rejects.toThrow(KNOWN);
      expect(h.events).toEqual([]);
    });
  }
  it('rejects a null stored progress', async () => {
    const h = harness(null);
    await expect(h.run()).rejects.toThrow(KNOWN);
  });
});

describe('failover flow', () => {
  it('drains, records acceptance, verifies and promotes with exact arguments', async () => {
    const h = harness(journalProgress('pending'));
    let calls = 0;
    h.authority.get.mockImplementation(async () => {
      h.events.push('get');
      return calls++ === 0 ? activeState() : drainingState();
    });
    const result = await h.run();
    expect(result.phase).toBe('complete');
    expect(result.writerAuthorityChanged).toBe(true);
    expect(h.events).toEqual([
      'get',
      'save:draining',
      'beginFailoverDrain',
      'get',
      'save:draining',
      'getOperation',
      'save:verified',
      'verifyFailoverGeneration',
      'promote',
      'save:complete',
    ]);
    expect(h.saves[0].cutover).toEqual(
      operation({ drainRevision: 0, drainedAtMs: null, expectedRevision: FENCE })
    );
    expect(h.saves[0].generationId).toBe('gen-1');
    expect(h.saves[0].standby).toEqual(standbyProgress().standby);
    expect(h.saves[0].snapshot).toEqual(standbyProgress().snapshot);
    expect(h.saves[0].destination).toEqual(standbyProgress().destination);
    expect(h.authority.get).toHaveBeenCalledWith('pair-1', 'tenant-1');
    expect(h.authority.beginFailoverDrain).toHaveBeenCalledWith({
      ...identity,
      sourceDeploymentId: 'cf-a',
      destinationDeploymentId: 'aws-a',
      expectedEpoch: 1,
      expectedRevision: FENCE,
    });
    expect(h.authority.getOperation).toHaveBeenCalledWith(identity);
    expect(h.saves[2].failoverProof).toEqual(proofFor(4000));
    expect(h.authority.verifyFailoverGeneration).toHaveBeenCalledWith(identity, proofFor(4000));
    expect(h.authority.promote).toHaveBeenCalledWith(identity);
    expect(result.cutover?.state).toBe('promoted');
  });
  it('refuses to start unless the source is the active owner at the reviewed epoch', async () => {
    for (const over of [
      { phase: 'draining' },
      { ownerDeploymentId: 'aws-a' },
      { epoch: 2 },
      { pairId: 'x' },
      { tenantId: 'x' },
    ]) {
      const h = harness(journalProgress('pending'));
      h.authority.get.mockResolvedValue(activeState(over));
      await expect(h.run()).rejects.toThrow(INVALID);
      expect(h.saves).toEqual([]);
    }
  });
  it('refuses when the live fence differs from the reviewed standby fence', async () => {
    const h = harness(journalProgress('pending'));
    h.authority.get.mockResolvedValue(activeState({ revision: FENCE + 1 }));
    await expect(h.run()).rejects.toThrow(INVALID);
    expect(h.authority.beginFailoverDrain).not.toHaveBeenCalled();
  });
  it('requires the drain to be this operation on the same pair', async () => {
    for (const over of [
      { phase: 'active' },
      { activeOperationId: 'other' },
      { epoch: 2 },
      { ownerDeploymentId: 'aws-a' },
      { pairId: 'x' },
      { tenantId: 'x' },
    ]) {
      const h = harness(journalProgress('draining'));
      h.authority.get.mockResolvedValue(drainingState(over));
      h.authority.beginFailoverDrain.mockResolvedValue(operation({ drainedAtMs: null }));
      await expect(h.run()).rejects.toThrow(INVALID);
      expect(h.authority.promote).not.toHaveBeenCalled();
    }
  });
  it('stays draining while permits are outstanding or no drain time is known', async () => {
    for (const [stateOver, op] of [
      [{ outstandingPermits: 1 }, operation()],
      [{ drainedAtMs: null }, operation({ drainedAtMs: null })],
      [{}, operation({ drainedAtMs: null })],
    ] as const) {
      const h = harness(journalProgress('draining'));
      h.authority.get.mockResolvedValue(drainingState(stateOver));
      h.authority.beginFailoverDrain.mockResolvedValue(op);
      h.authority.getOperation.mockResolvedValue(op);
      const result = await h.run();
      expect(result.phase).toBe('draining');
      expect(h.authority.verifyFailoverGeneration).not.toHaveBeenCalled();
      expect(h.authority.promote).not.toHaveBeenCalled();
    }
  });
  it('rejects a fractional or non-positive drain time from the authority', async () => {
    for (const drainedAtMs of [0, -5, 1.5]) {
      const h = harness(journalProgress('draining'));
      h.authority.get.mockResolvedValue(drainingState());
      h.authority.beginFailoverDrain.mockResolvedValue(operation({ drainedAtMs }));
      await expect(h.run()).rejects.toThrow(INVALID);
    }
  });
  it('rejects an authority operation that deviates from the reviewed intent', async () => {
    const bads = [
      { kind: 'planned' },
      { sourceDeploymentId: 'x' },
      { destinationDeploymentId: 'x' },
      { expectedEpoch: 2 },
      { expectedRevision: 9 },
      { drainRevision: 0 },
      { drainRevision: FENCE },
      { acceptedDataLoss: {} },
      { generation: registeredGeneration() },
      { promotedEpoch: 2 },
      { state: 'verified' },
    ];
    for (const over of bads) {
      const h = harness(journalProgress('draining'));
      h.authority.get.mockResolvedValue(drainingState());
      h.authority.beginFailoverDrain.mockResolvedValue(operation(over));
      await expect(h.run()).rejects.toThrow(INVALID);
    }
  });
  it('resumes at verified: re-checks acceptance and promotes', async () => {
    const h = harness(journalProgress('verified'));
    const result = await h.run();
    expect(result.phase).toBe('complete');
    expect(h.events).toEqual(['verifyFailoverGeneration', 'promote', 'save:complete']);
  });
  it('rejects a verified journal whose acceptance deviates from the review', async () => {
    const tampers: Array<(p: any) => void> = [
      (p) => (p.failoverProof = undefined),
      (p) => (p.failoverProof.acceptedDataLoss.maximumSnapshotAgeMs = MAX_AGE + 1),
      (p) => (p.failoverProof.acceptedDataLoss.sourceSyncOperationId = 'other'),
      (p) => (p.failoverProof.acceptedDataLoss.sourceSyncPlanSha256 = 'f'.repeat(64)),
      (p) => (p.failoverProof.acceptedDataLoss.acceptedAtMs = 1),
      (p) => (p.failoverProof.generation.capturedAtMs = 1),
      (p) => (p.cutover.drainedAtMs = null),
      (p) => (p.cutover.state = 'promoted'),
      (p) => (p.cutover.generation = registeredGeneration()),
      (p) => (p.cutover.acceptedDataLoss = proofFor(4000).acceptedDataLoss),
      (p) => (p.cutover.promotedEpoch = 2),
      (p) => (p.cutover = undefined),
      (p) => (p.generationId = 'other'),
      (p) => (p.destination = undefined),
      (p) => (p.snapshot = undefined),
      (p) => (p.standby = undefined),
      (p) => (p.destination.verificationSha256 = 'e'.repeat(64)),
      (p) => (p.snapshot.publicationSha256 = 'e'.repeat(64)),
      (p) => (p.standby.generation.sourceFenceRevision = 9),
    ];
    for (const fn of tampers) {
      const p = journalProgress('verified');
      fn(p);
      const h = harness(p);
      await expect(h.run()).rejects.toThrow(KNOWN);
      expect(h.authority.verifyFailoverGeneration).not.toHaveBeenCalled();
      expect(h.authority.promote).not.toHaveBeenCalled();
    }
  });
  it('rejects a draining journal that already carries acceptance or a terminal cutover', async () => {
    const tampers: Array<(p: any) => void> = [
      (p) => (p.failoverProof = proofFor(4000)),
      (p) => (p.cutover.state = 'verified'),
      (p) => (p.cutover.generation = registeredGeneration()),
      (p) => (p.cutover.acceptedDataLoss = proofFor(4000).acceptedDataLoss),
      (p) => (p.cutover.promotedEpoch = 2),
      (p) => (p.cutover.drainedAtMs = 5),
      (p) => (p.cutover.kind = 'planned'),
      (p) => (p.cutover.expectedRevision = 9),
    ];
    for (const fn of tampers) {
      const p = journalProgress('draining');
      fn(p);
      const h = harness(p);
      await expect(h.run()).rejects.toThrow(KNOWN);
      expect(h.authority.beginFailoverDrain).not.toHaveBeenCalled();
    }
  });
  it('draining requires a cutover intent in the journal', async () => {
    const p = journalProgress('draining');
    p.cutover = undefined;
    const h = harness(p);
    await expect(h.run()).rejects.toThrow(INVALID);
  });
  it('accepts a draining journal whose cutover already has the authority drain revision', async () => {
    const p = journalProgress('draining', { cutover: operation({ drainedAtMs: null }) });
    const h = harness(p);
    h.authority.get.mockResolvedValue(drainingState({ outstandingPermits: 1 }));
    h.authority.beginFailoverDrain.mockResolvedValue(operation({ drainedAtMs: null }));
    await expect(h.run()).resolves.toMatchObject({ phase: 'draining' });
  });
});

describe('completed journals', () => {
  it('confirm with the authority that the recorded promotion exists', async () => {
    const p = journalProgress('complete');
    const h = harness(p);
    h.authority.getOperation.mockResolvedValue(p.cutover);
    const result = await h.run();
    expect(result).toEqual(p);
    expect(h.authority.getOperation).toHaveBeenCalledWith(identity);
    expect(h.authority.promote).not.toHaveBeenCalled();
    expect(h.saves).toEqual([]);
  });
  it('reject when the authority operation differs', async () => {
    const p = journalProgress('complete');
    const h = harness(p);
    h.authority.getOperation.mockResolvedValue({ ...p.cutover, promotedEpoch: 3 });
    await expect(h.run()).rejects.toThrow(INVALID);
  });
  it('reject locally inconsistent completion', async () => {
    const tampers: Array<(p: any) => void> = [
      (p) => (p.cutover.state = 'draining'),
      (p) => (p.cutover.promotedEpoch = 3),
      (p) => (p.cutover.generation.capturedAtMs = 1),
      (p) => (p.cutover.acceptedDataLoss.acceptedAtMs = 1),
      (p) => (p.writerAuthorityChanged = false),
      (p) => (p.failoverProof = undefined),
    ];
    for (const fn of tampers) {
      const p = journalProgress('complete');
      fn(p);
      const h = harness(p);
      h.authority.getOperation.mockResolvedValue(p.cutover);
      await expect(h.run()).rejects.toThrow(KNOWN);
      expect(h.authority.getOperation).not.toHaveBeenCalled();
    }
  });
});

describe('journal write-back validation', () => {
  it('rejects when the journal returns progress that no longer validates', async () => {
    const h = harness(journalProgress('pending'));
    h.authority.get.mockResolvedValue(activeState());
    h.checkpoint.save.mockImplementation(async (value: any) => ({
      operationId: 'fo-1',
      planSha256: 'e'.repeat(64),
      revision: 2,
      value: { ...value, plan: { ...value.plan, expectedEpoch: 7 } },
    }));
    await expect(h.run()).rejects.toThrow(INVALID);
    expect(h.authority.beginFailoverDrain).not.toHaveBeenCalled();
  });
  it('final progress must be complete or draining', async () => {
    const h = harness(journalProgress('verified'));
    h.checkpoint.save.mockImplementation(async () => ({
      operationId: 'fo-1',
      planSha256: 'e'.repeat(64),
      revision: 2,
      value: journalProgress('verified'),
    }));
    // save returns the unchanged verified progress: result phase is neither complete nor draining
    await expect(h.run()).rejects.toThrow(INVALID);
  });
});
