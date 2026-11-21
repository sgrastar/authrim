/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- mock call inspection */
import { describe, expect, it, vi } from 'vitest';
import { advanceReplicationOperation } from './coordinator';

const CONFLICT = 'replication_operation_conflict';
const PLAN_SHA = 'a'.repeat(64);
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
type Mode = 'sync' | 'switch';
const planFor = (mode: Mode | 'failover' = 'sync'): any => ({
  operationId: 'op-1',
  pairId: 'pair-1',
  tenantId: 'tenant-1',
  sourceDeploymentId: 'cf-a',
  destinationDeploymentId: 'aws-a',
  expectedEpoch: 1,
  mode,
});
const BOUNDARY = 5000;
const source = (): any => ({ id: 'exp-1', state: 'ready', phase: 'export_complete', revision: 1 });
const snapshot = (tenantId = 'tenant-1', boundary = BOUNDARY): any => ({
  publication: {
    operationId: 'exp-1',
    boundaryUnixMs: boundary,
    receipt: { source: { tenantId } },
  },
  publicationSha256: 'c'.repeat(64),
  partPaths: [],
  publicationPath: '/x',
});
const destination = (over: Record<string, unknown> = {}): any => ({
  generation: {
    pairId: 'pair-1',
    tenantId: 'tenant-1',
    deploymentId: 'aws-a',
    generationId: 'gen-1',
    epoch: 2,
    location: structuredClone(location),
  },
  verificationSha256: 'd'.repeat(64),
  ...over,
});
const draining = (over: Record<string, unknown> = {}): any => ({
  pairId: 'pair-1',
  tenantId: 'tenant-1',
  operationId: 'op-1',
  sourceDeploymentId: 'cf-a',
  destinationDeploymentId: 'aws-a',
  expectedEpoch: 1,
  expectedRevision: 3,
  kind: 'planned',
  acceptedDataLoss: null,
  state: 'draining',
  drainRevision: 0,
  drainedAtMs: null,
  generation: null,
  promotedEpoch: null,
  ...over,
});
const verifiedGeneration = (fence: number) => ({
  generationId: 'gen-1',
  sourceDeploymentId: 'cf-a',
  destinationDeploymentId: 'aws-a',
  sourceEpoch: 1,
  sourceFenceRevision: fence,
  capturedAtMs: BOUNDARY,
  manifestSha256: location.manifestSha256,
  verificationSha256: 'd'.repeat(64),
});
const standbyFor = (fence = 3): any => ({
  pairId: 'pair-1',
  tenantId: 'tenant-1',
  sourceSyncOperationId: 'op-1',
  sourceSyncPlanSha256: PLAN_SHA,
  generation: verifiedGeneration(fence),
});

type Phase =
  | 'pending'
  | 'draining'
  | 'exporting'
  | 'downloaded'
  | 'restoring'
  | 'verified'
  | 'complete';
const ORDER: Phase[] = [
  'pending',
  'draining',
  'exporting',
  'downloaded',
  'restoring',
  'verified',
  'complete',
];
function progress(phase: Phase, mode: Mode = 'sync', over: Record<string, unknown> = {}): any {
  const at = (p: Phase) => ORDER.indexOf(phase) >= ORDER.indexOf(p);
  const value: any = {
    formatVersion: 1,
    phase,
    plan: planFor(mode),
    generationId: 'gen-1',
    attempt: 1,
    writerAuthorityChanged: mode === 'switch' && phase === 'complete',
  };
  if (mode === 'switch' && phase !== 'pending') {
    value.cutover = draining({ drainedAtMs: at('exporting') ? 4000 : null });
    if (phase === 'complete')
      value.cutover = draining({
        drainedAtMs: 4000,
        drainRevision: 4,
        state: 'promoted',
        promotedEpoch: 2,
        generation: verifiedGeneration(4),
      });
  }
  if (at('downloaded')) {
    value.source = source();
    value.snapshot = snapshot();
  }
  if (at('verified')) value.destination = destination();
  if (mode === 'sync' && phase === 'complete') value.standby = standbyFor(3);
  return { ...value, ...over };
}

function authorityState(over: Record<string, unknown> = {}): any {
  return {
    pairId: 'pair-1',
    tenantId: 'tenant-1',
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

function harness(initial: any, mode: Mode | 'failover' = initial.plan?.mode ?? 'sync') {
  let record: any = { operationId: 'op-1', planSha256: PLAN_SHA, revision: 1, value: initial };
  const saves: any[] = [];
  const events: string[] = [];
  const authority: any = {
    get: vi.fn(async () => {
      events.push('get');
      return authorityState();
    }),
    beginDrain: vi.fn(async () => {
      events.push('beginDrain');
      return draining({ drainedAtMs: 4000 });
    }),
    getOperation: vi.fn(async () => {
      events.push('getOperation');
      return draining({ drainedAtMs: 4000, drainRevision: 4 });
    }),
    verifyGeneration: vi.fn(async () => {
      events.push('verifyGeneration');
    }),
    promote: vi.fn(async () => {
      events.push('promote');
      return draining({
        drainedAtMs: 4000,
        drainRevision: 4,
        state: 'promoted',
        promotedEpoch: 2,
        generation: verifiedGeneration(4),
      });
    }),
    registerStandbyGeneration: vi.fn(async () => {
      events.push('registerStandby');
    }),
  };
  const deps: any = {
    expectedPlan: planFor(mode),
    authority,
    checkpoint: {
      current: () => record,
      save: vi.fn(async (value: any) => {
        events.push(`save:${value.phase}`);
        saves.push(structuredClone(value));
        record = { ...record, revision: record.revision + 1, value: structuredClone(value) };
        return record;
      }),
    },
    source: {
      advance: vi.fn(async () => {
        events.push('advance');
        return source();
      }),
      download: vi.fn(async () => {
        events.push('download');
        return snapshot();
      }),
    },
    target: {
      restore: vi.fn(async () => {
        events.push('restore');
        return destination();
      }),
      register: vi.fn(async () => {
        events.push('register');
      }),
    },
  };
  return { deps, authority, saves, events, run: () => advanceReplicationOperation(deps) };
}

describe('progress validation rejects before any side effect', () => {
  type Tamper = [string, (p: any) => void, Mode?, Phase?];
  const tampers: Tamper[] = [
    ['formatVersion', (p) => (p.formatVersion = 2)],
    ['plan missing', (p) => (p.plan = undefined)],
    ['plan extra key', (p) => (p.plan.extra = 1)],
    ['plan operation differs from reviewed', (p) => (p.plan.operationId = 'op-2')],
    ['plan pair differs from reviewed', (p) => (p.plan.pairId = 'pair-2')],
    ['plan epoch differs from reviewed', (p) => (p.plan.expectedEpoch = 2)],
    ['generation id invalid', (p) => (p.generationId = 'bad id')],
    ['phase unknown', (p) => (p.phase = 'whatever')],
    ['attempt non-integer', (p) => (p.attempt = 1.5)],
    ['attempt negative', (p) => (p.attempt = -1)],
    ['sync writer authority changed', (p) => (p.writerAuthorityChanged = true)],
    ['sync draining phase', (p) => (p.phase = 'draining')],
    ['switch missing cutover', (p) => (p.cutover = undefined), 'switch', 'exporting'],
    [
      'switch writer flag without completion',
      (p) => (p.writerAuthorityChanged = true),
      'switch',
      'exporting',
    ],
    [
      'switch complete without writer flag',
      (p) => (p.writerAuthorityChanged = false),
      'switch',
      'complete',
    ],
    ['downloaded without snapshot', (p) => (p.snapshot = undefined), 'sync', 'downloaded'],
    ['downloaded without source', (p) => (p.source = undefined), 'sync', 'downloaded'],
    [
      'snapshot op differs from source',
      (p) => (p.snapshot.publication.operationId = 'exp-2'),
      'sync',
      'downloaded',
    ],
    ['source not ready', (p) => (p.source.state = 'running'), 'sync', 'downloaded'],
    [
      'source phase not export_complete',
      (p) => (p.source.phase = 'exporting'),
      'sync',
      'downloaded',
    ],
    [
      'snapshot tenant differs',
      (p) => (p.snapshot.publication.receipt.source.tenantId = 'other'),
      'sync',
      'downloaded',
    ],
    ['boundary zero', (p) => (p.snapshot.publication.boundaryUnixMs = 0), 'sync', 'downloaded'],
    [
      'boundary fractional',
      (p) => (p.snapshot.publication.boundaryUnixMs = 1.5),
      'sync',
      'downloaded',
    ],
    [
      'snapshot digest bad',
      (p) => (p.snapshot.publicationSha256 = 'C'.repeat(64)),
      'sync',
      'downloaded',
    ],
    [
      'snapshot digest prefix',
      (p) => (p.snapshot.publicationSha256 = `x${'c'.repeat(64)}`),
      'sync',
      'downloaded',
    ],
    [
      'snapshot digest suffix',
      (p) => (p.snapshot.publicationSha256 = `${'c'.repeat(64)}x`),
      'sync',
      'downloaded',
    ],
    ['restoring without snapshot', (p) => (p.snapshot = undefined), 'sync', 'restoring'],
    ['verified without destination', (p) => (p.destination = undefined), 'sync', 'verified'],
    ['destination pair', (p) => (p.destination.generation.pairId = 'x'), 'sync', 'verified'],
    ['destination tenant', (p) => (p.destination.generation.tenantId = 'x'), 'sync', 'verified'],
    [
      'destination deployment',
      (p) => (p.destination.generation.deploymentId = 'x'),
      'sync',
      'verified',
    ],
    [
      'destination generation',
      (p) => (p.destination.generation.generationId = 'x'),
      'sync',
      'verified',
    ],
    ['destination epoch', (p) => (p.destination.generation.epoch = 1), 'sync', 'verified'],
    [
      'destination verification digest',
      (p) => (p.destination.verificationSha256 = 'x'),
      'sync',
      'verified',
    ],
    [
      'destination digest prefix',
      (p) => (p.destination.verificationSha256 = `x${'d'.repeat(64)}`),
      'sync',
      'verified',
    ],
    [
      'destination digest suffix',
      (p) => (p.destination.verificationSha256 = `${'d'.repeat(64)}x`),
      'sync',
      'verified',
    ],
    [
      'destination location invalid',
      (p) => (p.destination.generation.location.region = 'nope'),
      'sync',
      'verified',
    ],
    ['sync complete without standby', (p) => (p.standby = undefined), 'sync', 'complete'],
    ['standby pair', (p) => (p.standby.pairId = 'x'), 'sync', 'complete'],
    ['standby tenant', (p) => (p.standby.tenantId = 'x'), 'sync', 'complete'],
    ['standby operation', (p) => (p.standby.sourceSyncOperationId = 'x'), 'sync', 'complete'],
    [
      'standby plan digest',
      (p) => (p.standby.sourceSyncPlanSha256 = 'f'.repeat(64)),
      'sync',
      'complete',
    ],
    ['standby generation id', (p) => (p.standby.generation.generationId = 'x'), 'sync', 'complete'],
    ['standby source', (p) => (p.standby.generation.sourceDeploymentId = 'x'), 'sync', 'complete'],
    [
      'standby destination',
      (p) => (p.standby.generation.destinationDeploymentId = 'x'),
      'sync',
      'complete',
    ],
    ['standby source epoch', (p) => (p.standby.generation.sourceEpoch = 2), 'sync', 'complete'],
    ['standby captured time', (p) => (p.standby.generation.capturedAtMs = 1), 'sync', 'complete'],
    [
      'standby manifest',
      (p) => (p.standby.generation.manifestSha256 = 'e'.repeat(64)),
      'sync',
      'complete',
    ],
    [
      'standby verification',
      (p) => (p.standby.generation.verificationSha256 = 'e'.repeat(64)),
      'sync',
      'complete',
    ],
    ['cutover kind', (p) => (p.cutover.kind = 'failover'), 'switch', 'exporting'],
    ['cutover accepted loss', (p) => (p.cutover.acceptedDataLoss = {}), 'switch', 'exporting'],
    ['cutover pair', (p) => (p.cutover.pairId = 'x'), 'switch', 'exporting'],
    ['cutover tenant', (p) => (p.cutover.tenantId = 'x'), 'switch', 'exporting'],
    ['cutover operation', (p) => (p.cutover.operationId = 'x'), 'switch', 'exporting'],
    ['cutover source', (p) => (p.cutover.sourceDeploymentId = 'x'), 'switch', 'exporting'],
    [
      'cutover destination',
      (p) => (p.cutover.destinationDeploymentId = 'x'),
      'switch',
      'exporting',
    ],
    ['cutover epoch', (p) => (p.cutover.expectedEpoch = 2), 'switch', 'exporting'],
    ['complete cutover not promoted', (p) => (p.cutover.state = 'verified'), 'switch', 'complete'],
    ['complete cutover epoch', (p) => (p.cutover.promotedEpoch = 3), 'switch', 'complete'],
    [
      'complete cutover generation id',
      (p) => (p.cutover.generation.generationId = 'x'),
      'switch',
      'complete',
    ],
    [
      'complete cutover fence',
      (p) => (p.cutover.generation.sourceFenceRevision = 9),
      'switch',
      'complete',
    ],
    [
      'complete cutover captured time',
      (p) => (p.cutover.generation.capturedAtMs = 1),
      'switch',
      'complete',
    ],
    [
      'complete cutover manifest',
      (p) => (p.cutover.generation.manifestSha256 = 'e'.repeat(64)),
      'switch',
      'complete',
    ],
    [
      'complete cutover verification',
      (p) => (p.cutover.generation.verificationSha256 = 'e'.repeat(64)),
      'switch',
      'complete',
    ],
    [
      'complete cutover source',
      (p) => (p.cutover.generation.sourceDeploymentId = 'x'),
      'switch',
      'complete',
    ],
  ];
  for (const [name, fn, mode = 'sync', phase = 'pending'] of tampers) {
    it(`rejects: ${name}`, async () => {
      const p = progress(phase, mode);
      fn(p);
      const h = harness(p, mode);
      const expected =
        name === 'generation id invalid'
          ? 'replication_transport_invalid'
          : name === 'destination location invalid'
            ? 'aws_deployment_config_invalid'
            : name === 'sync complete without standby'
              ? 'deployment_authority_invalid_input'
              : CONFLICT;
      await expect(h.run()).rejects.toThrow(expected);
      expect(h.events).toEqual([]);
    });
  }
  it('rejects plan field tampering via the reviewed plan, and bad modes/epochs', async () => {
    for (const fn of [
      (p: any) => (p.mode = 'failover'),
      (p: any) => (p.expectedEpoch = 0),
      (p: any) => (p.expectedEpoch = Number.MAX_SAFE_INTEGER),
      (p: any) => (p.expectedEpoch = 1.5),
      (p: any) => (p.destinationDeploymentId = 'cf-a'),
      (p: any) => (p.mode = 'bogus'),
    ]) {
      const p = progress('pending');
      fn(p.plan);
      const h = harness(p);
      h.deps.expectedPlan = structuredClone(p.plan);
      await expect(h.run()).rejects.toThrow(CONFLICT);
      expect(h.events).toEqual([]);
    }
  });
  it('accepts expected epoch 1 and large safe epochs below the maximum', async () => {
    const p = progress('complete');
    const h = harness(p);
    await expect(h.run()).resolves.toEqual(p);
  });
  it('treats non-sync/non-switch progress modes as invalid', async () => {
    const p = progress('pending');
    p.plan.mode = 'failover';
    const h = harness(p, 'failover');
    await expect(h.run()).rejects.toThrow(CONFLICT);
  });
});

describe('sync flow', () => {
  it('runs pending to complete with exact collaborator arguments and ordering', async () => {
    const h = harness(progress('pending'));
    const result = await h.run();
    expect(result.phase).toBe('complete');
    expect(result.writerAuthorityChanged).toBe(false);
    expect(h.events).toEqual([
      'get',
      'save:exporting',
      'get',
      'advance',
      'save:exporting',
      'download',
      'save:downloaded',
      'get',
      'save:restoring',
      'restore',
      'get',
      'save:verified',
      'register',
      'get',
      'registerStandby',
      'save:complete',
    ]);
    expect(h.authority.get).toHaveBeenCalledWith('pair-1', 'tenant-1');
    expect(h.deps.source.advance).toHaveBeenCalledWith('op-1');
    expect(h.deps.source.download).toHaveBeenCalledWith('exp-1', 0);
    expect(h.deps.target.restore).toHaveBeenCalledWith({
      snapshot: snapshot(),
      generationId: 'gen-1',
      servingEpoch: 2,
    });
    expect(h.deps.target.register).toHaveBeenCalledWith(destination().generation);
    expect(h.authority.registerStandbyGeneration).toHaveBeenCalledWith(standbyFor(3));
    expect(result.standby).toEqual(standbyFor(3));
    expect(result.destination).toEqual(destination());
    expect(result.snapshot).toEqual(snapshot());
    expect(h.authority.beginDrain).not.toHaveBeenCalled();
    expect(h.authority.promote).not.toHaveBeenCalled();
  });
  it('returns immediately when already complete', async () => {
    const h = harness(progress('complete'));
    await h.run();
    expect(h.events).toEqual([]);
  });
  it('fails if the source is not an active owner at start', async () => {
    for (const over of [
      { phase: 'draining' },
      { ownerDeploymentId: 'aws-a' },
      { epoch: 2 },
      { pairId: 'x' },
      { tenantId: 'x' },
    ]) {
      const h = harness(progress('pending'));
      h.authority.get.mockResolvedValue(authorityState(over));
      await expect(h.run()).rejects.toThrow(CONFLICT);
      expect(h.saves).toEqual([]);
    }
  });
  it('stops with the source operation saved when the export is not ready yet', async () => {
    for (const src of [
      { ...source(), state: 'running' },
      { ...source(), phase: 'exporting' },
    ]) {
      const h = harness(progress('exporting'));
      h.deps.source.advance.mockResolvedValue(src);
      const result = await h.run();
      expect(result.phase).toBe('exporting');
      expect(result.source).toEqual(src);
      expect(h.deps.source.download).not.toHaveBeenCalled();
    }
  });
  it('rejects an export for another tenant', async () => {
    const h = harness(progress('exporting'));
    h.deps.source.download.mockResolvedValue(snapshot('other'));
    await expect(h.run()).rejects.toThrow(CONFLICT);
    expect(h.deps.target.restore).not.toHaveBeenCalled();
  });
  it('requires the source to stay active throughout exporting', async () => {
    const h = harness(progress('exporting'));
    h.authority.get.mockResolvedValue(authorityState({ phase: 'draining' }));
    await expect(h.run()).rejects.toThrow(CONFLICT);
    expect(h.deps.source.advance).not.toHaveBeenCalled();
  });
  it('re-allocates a fresh generation and attempt after an interrupted restore', async () => {
    const p = progress('restoring');
    const h = harness(p);
    h.deps.target.restore.mockImplementation(async (a: any) =>
      destination({
        generation: { ...destination().generation, generationId: a.generationId },
      })
    );
    const result = await h.run();
    expect(h.saves[0]).toMatchObject({ phase: 'downloaded', attempt: 2 });
    expect(h.saves[0].generationId).not.toBe('gen-1');
    expect(h.saves[0].generationId.length).toBeGreaterThan(30);
    expect(h.saves[1].phase).toBe('restoring');
    expect(result.phase).toBe('complete');
    expect(h.deps.target.restore.mock.calls[0][0].generationId).toBe(h.saves[0].generationId);
  });
  it('requires an active source before and after restoring', async () => {
    const h = harness(progress('downloaded'));
    h.authority.get.mockResolvedValue(authorityState({ phase: 'draining' }));
    await expect(h.run()).rejects.toThrow(CONFLICT);
    expect(h.deps.target.restore).not.toHaveBeenCalled();
    const h2 = harness(progress('downloaded'));
    let n = 0;
    h2.authority.get.mockImplementation(async () => authorityState(n++ === 0 ? {} : { epoch: 5 }));
    await expect(h2.run()).rejects.toThrow(CONFLICT);
    expect(h2.deps.target.restore).toHaveBeenCalledTimes(1);
    expect(h2.saves.map((s) => s.phase)).toEqual(['restoring']);
  });
  it('rejects a restore result that does not match this generation', async () => {
    const bads: Array<(d: any) => void> = [
      (d) => (d.generation.pairId = 'x'),
      (d) => (d.generation.tenantId = 'x'),
      (d) => (d.generation.deploymentId = 'x'),
      (d) => (d.generation.generationId = 'x'),
      (d) => (d.generation.epoch = 3),
      (d) => (d.verificationSha256 = 'nope'),
      (d) => (d.verificationSha256 = `x${'d'.repeat(64)}`),
      (d) => (d.verificationSha256 = `${'d'.repeat(64)}x`),
    ];
    for (const fn of bads) {
      const h = harness(progress('downloaded'));
      const d = destination();
      fn(d);
      h.deps.target.restore.mockResolvedValue(d);
      await expect(h.run()).rejects.toThrow(CONFLICT);
      expect(h.deps.target.register).not.toHaveBeenCalled();
      expect(h.saves.map((s) => s.phase)).toEqual(['restoring']);
    }
  });
  it('requires the source still active before recording the standby', async () => {
    const h = harness(progress('verified'));
    h.authority.get.mockResolvedValue(authorityState({ phase: 'draining' }));
    await expect(h.run()).rejects.toThrow(CONFLICT);
    expect(h.authority.registerStandbyGeneration).not.toHaveBeenCalled();
    const h2 = harness(progress('verified'));
    h2.authority.get.mockResolvedValue(authorityState({ ownerDeploymentId: 'aws-a' }));
    await expect(h2.run()).rejects.toThrow(CONFLICT);
  });
  it('records the standby with the live fence revision and the journal plan digest', async () => {
    const h = harness(progress('verified'));
    h.authority.get.mockResolvedValue(authorityState({ revision: 9 }));
    await h.run();
    expect(h.authority.registerStandbyGeneration.mock.calls[0][0]).toEqual(standbyFor(9));
    expect(h.deps.target.register).toHaveBeenCalledTimes(1);
  });
});

describe('switch flow', () => {
  it('runs pending to complete through drain, export, restore, verify and promote', async () => {
    const h = harness(progress('pending', 'switch'));
    let phase = 0;
    h.authority.get.mockImplementation(async () => {
      phase++;
      return phase === 1
        ? authorityState()
        : authorityState({
            phase: 'draining',
            activeOperationId: 'op-1',
            drainedAtMs: 4000,
            outstandingPermits: 0,
          });
    });
    const result = await h.run();
    expect(result.phase).toBe('complete');
    expect(result.writerAuthorityChanged).toBe(true);
    expect(h.saves[0].phase).toBe('draining');
    expect(h.saves[0].cutover).toEqual(draining({ expectedRevision: 3 }));
    expect(h.authority.beginDrain).toHaveBeenCalledWith({
      pairId: 'pair-1',
      tenantId: 'tenant-1',
      operationId: 'op-1',
      sourceDeploymentId: 'cf-a',
      destinationDeploymentId: 'aws-a',
      expectedEpoch: 1,
      expectedRevision: 3,
    });
    expect(h.authority.getOperation).toHaveBeenCalledWith({
      pairId: 'pair-1',
      tenantId: 'tenant-1',
      operationId: 'op-1',
    });
    expect(h.deps.source.download).toHaveBeenCalledWith('exp-1', 4000);
    expect(h.authority.verifyGeneration).toHaveBeenCalledWith(
      { pairId: 'pair-1', tenantId: 'tenant-1', operationId: 'op-1' },
      verifiedGeneration(4)
    );
    expect(h.authority.promote).toHaveBeenCalledWith({
      pairId: 'pair-1',
      tenantId: 'tenant-1',
      operationId: 'op-1',
    });
    expect(h.events.indexOf('verifyGeneration')).toBeGreaterThan(h.events.indexOf('register'));
    expect(h.events.indexOf('promote')).toBeGreaterThan(h.events.indexOf('verifyGeneration'));
    expect(h.authority.registerStandbyGeneration).not.toHaveBeenCalled();
    expect(result.cutover?.state).toBe('promoted');
  });
  it('returns while permits are outstanding or the drain is not yet complete', async () => {
    for (const over of [
      { outstandingPermits: 1, drainedAtMs: 4000 },
      { outstandingPermits: 0, drainedAtMs: null },
    ]) {
      const h = harness(progress('draining', 'switch'));
      h.authority.get.mockResolvedValue(
        authorityState({ phase: 'draining', activeOperationId: 'op-1', ...over })
      );
      const result = await h.run();
      expect(result.phase).toBe('draining');
      expect(h.deps.source.advance).not.toHaveBeenCalled();
      expect(h.authority.getOperation).not.toHaveBeenCalled();
    }
  });
  it('fails when the authority is not draining this operation', async () => {
    for (const over of [{ phase: 'active' }, { phase: 'draining', activeOperationId: 'other' }]) {
      const h = harness(progress('draining', 'switch'));
      h.authority.get.mockResolvedValue(authorityState(over));
      await expect(h.run()).rejects.toThrow(CONFLICT);
      expect(h.saves).toEqual([]);
    }
  });
  it('requires a pinned cutover intent before draining', async () => {
    const p = progress('draining', 'switch');
    p.cutover = undefined;
    const h = harness(p);
    await expect(h.run()).rejects.toThrow(CONFLICT);
  });
  it('exporting requires an exact drained state with no permits', async () => {
    const good = {
      phase: 'draining',
      activeOperationId: 'op-1',
      outstandingPermits: 0,
      drainedAtMs: 4000,
    };
    for (const over of [
      { phase: 'active' },
      { activeOperationId: 'other' },
      { outstandingPermits: 1 },
    ]) {
      const h = harness(progress('exporting', 'switch'));
      h.authority.get.mockResolvedValue(authorityState({ ...good, ...over }));
      await expect(h.run()).rejects.toThrow(CONFLICT);
      expect(h.deps.source.advance).not.toHaveBeenCalled();
    }
    const ok = harness(progress('exporting', 'switch'));
    ok.authority.get.mockResolvedValue(authorityState(good));
    const result = await ok.run();
    expect(result.phase).toBe('complete');
  });
  it('requires a drain timestamp to download and enforces the boundary lower bound', async () => {
    const p = progress('exporting', 'switch');
    p.cutover.drainedAtMs = null;
    const h = harness(p);
    h.authority.get.mockResolvedValue(
      authorityState({ phase: 'draining', activeOperationId: 'op-1', outstandingPermits: 0 })
    );
    await expect(h.run()).rejects.toThrow(CONFLICT);
    const h2 = harness(progress('exporting', 'switch'));
    h2.authority.get.mockResolvedValue(
      authorityState({
        phase: 'draining',
        activeOperationId: 'op-1',
        outstandingPermits: 0,
        drainedAtMs: 4000,
      })
    );
    h2.deps.source.download.mockResolvedValue(snapshot('tenant-1', 3999));
    await expect(h2.run()).rejects.toThrow(CONFLICT);
    const h3 = harness(progress('exporting', 'switch'));
    h3.authority.get.mockResolvedValue(
      authorityState({
        phase: 'draining',
        activeOperationId: 'op-1',
        outstandingPermits: 0,
        drainedAtMs: 4000,
      })
    );
    h3.deps.source.download.mockResolvedValue(snapshot('tenant-1', 4000));
    await h3.run().catch(() => undefined);
    expect(h3.deps.target.restore).toHaveBeenCalledTimes(1);
    expect(h2.deps.target.restore).not.toHaveBeenCalled();
  });
  it('source checks during restore require the exact drained state', async () => {
    const drainedGood = {
      phase: 'draining',
      activeOperationId: 'op-1',
      outstandingPermits: 0,
      drainedAtMs: 4000,
    };
    for (const over of [
      { phase: 'active' },
      { activeOperationId: 'other' },
      { outstandingPermits: 2 },
      { drainedAtMs: null },
    ]) {
      const h = harness(progress('downloaded', 'switch'));
      h.authority.get.mockResolvedValue(authorityState({ ...drainedGood, ...over }));
      await expect(h.run()).rejects.toThrow(CONFLICT);
      expect(h.deps.target.restore).not.toHaveBeenCalled();
    }
  });
  it('verified switch must register, verify with the live drain revision, then promote', async () => {
    const h = harness(progress('verified', 'switch'));
    const result = await h.run();
    expect(h.events).toEqual([
      'register',
      'getOperation',
      'verifyGeneration',
      'promote',
      'save:complete',
    ]);
    expect(result.cutover?.promotedEpoch).toBe(2);
    expect(h.authority.verifyGeneration.mock.calls[0][1].sourceFenceRevision).toBe(4);
  });
  it('requires a destination and snapshot to verify a switch', async () => {
    const p = progress('verified', 'switch');
    p.destination = undefined;
    await expect(harness(p).run()).rejects.toThrow(CONFLICT);
  });
});

describe('checkpoint discipline', () => {
  it('validates every saved progress against the reviewed plan', async () => {
    const h = harness(progress('pending'));
    h.deps.checkpoint.save.mockImplementation(async () => {
      throw new Error('storage');
    });
    await expect(h.run()).rejects.toThrow('storage');
    const h2 = harness(progress('exporting'));
    // a corrupt journal reply must stop the run: the saved value comes back with a foreign plan
    h2.deps.checkpoint.save.mockImplementation(async (value: any) => ({
      operationId: 'op-1',
      planSha256: PLAN_SHA,
      revision: 2,
      value: { ...value, plan: { ...value.plan, operationId: 'x' } },
    }));
    h2.authority.get.mockResolvedValue(authorityState());
    await expect(h2.run()).rejects.toThrow(CONFLICT);
  });
});
