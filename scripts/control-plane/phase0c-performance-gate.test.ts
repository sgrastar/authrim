import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PHASE0C_GATE,
  evaluatePhase0cEvidence,
  parsePhase0cEvidence,
  parsePhase0cGateArgs,
  renderPhase0cChecklist,
  runPhase0cGate,
  type Phase0cPerformanceEvidence,
  type Phase0cScenarioResult,
} from './phase0c-performance-gate.js';

function scenario(
  scenarioName: keyof typeof PHASE0C_GATE.scenarios,
  p95Ms: number,
  p99Ms = p95Ms * 1.1
): Phase0cScenarioResult {
  const ratePerSecond = PHASE0C_GATE.scenarios[scenarioName].ratePerSecond;
  const result: Phase0cScenarioResult = {
    warmup: { durationSeconds: 30, excludedFromMeasurement: true },
    measurement: {
      durationSeconds: 300,
      ratePerSecond,
      successCount: ratePerSecond * PHASE0C_GATE.measurementSeconds,
      failureCount: 0,
      droppedIterations: 0,
      p50Ms: p95Ms / 2,
      p95Ms,
      p99Ms,
    },
    errors: { routing5xx: 0, timeouts: 0, d1Overloaded: 0 },
    coldSamples: [1, 2, 3].map((index) => ({
      latencyMs: p95Ms + index,
      servedByRegion: 'NRT',
      servedByPrimary: index === 1,
    })),
  };
  if (scenarioName === 'totpFullLogin') {
    result.latencyMs = {
      authorizeInit: { p50Ms: 500, p95Ms: 1_000, p99Ms: 2_000 },
      totpStart: { p50Ms: 500, p95Ms: 1_000, p99Ms: 2_000 },
      totpVerify: { p50Ms: 750, p95Ms: 1_500, p99Ms: 2_000 },
      authorizeCode: { p50Ms: 500, p95Ms: 1_000, p99Ms: 2_000 },
      token: { p50Ms: 750, p95Ms: 1_500, p99Ms: 2_000 },
      totpCompletion: { p50Ms: 1_500, p95Ms: 3_000, p99Ms: 4_000 },
      fullFlow: { p50Ms: p95Ms / 2, p95Ms, p99Ms },
    };
  }
  return result;
}

function evidence(): Phase0cPerformanceEvidence {
  return {
    schemaVersion: 4,
    runId: 'phase0c-test-20260729',
    executedAt: '2026-07-29T01:02:03.000Z',
    commit: 'a'.repeat(40),
    environment: 'test',
    sourceRegion: 'apac-northeast-1',
    scenarios: {
      identifierDiscovery: scenario('identifierDiscovery', 400, 750),
      totpFullLogin: scenario('totpFullLogin', 5_000, 5_500),
    },
    invariants: {
      controlWorkerHotPathCalls: 0,
      cloudflareRestHotPathCalls: 0,
      identifierMaxPhysicalLookupD1Reads: 1,
      accountRouteKvReads: 0,
      accountRouteKvWrites: 0,
      routeFailOpenCount: 0,
    },
  };
}

describe('Phase 0c performance gate', () => {
  it('pins the release thresholds and accepts their exact boundaries', () => {
    expect(PHASE0C_GATE).toMatchObject({
      environment: 'test',
      warmupSeconds: 30,
      measurementSeconds: 300,
      coldSampleCount: 3,
      scenarios: {
        identifierDiscovery: {
          ratePerSecond: 50,
          minimumSuccessRate: 0.999,
          maximumP95Ms: 400,
          maximumP99Ms: 750,
          maximumDroppedIterations: 0,
        },
        totpFullLogin: {
          ratePerSecond: 25,
          minimumSuccessRate: 0.995,
          maximumP95Ms: 5_000,
          stepMaximumP95Ms: {
            authorizeInit: 1_000,
            totpStart: 1_000,
            totpVerify: 1_500,
            authorizeCode: 1_000,
            token: 1_500,
          },
          stepMaximumP99Ms: 2_000,
          totpCompletionMaximumP95Ms: 3_000,
          maximumDroppedIterations: 0,
        },
      },
    });
    expect(evaluatePhase0cEvidence(evidence()).passed).toBe(true);
  });

  it('fails closed when a user-visible TOTP segment misses its UX budget', () => {
    const input = evidence();
    input.scenarios.totpFullLogin.latencyMs!.totpVerify.p95Ms = 1_501;
    input.scenarios.totpFullLogin.latencyMs!.token.p99Ms = 2_001;
    input.scenarios.totpFullLogin.latencyMs!.totpCompletion.p95Ms = 3_001;

    const failed = evaluatePhase0cEvidence(input)
      .checks.filter((check) => !check.passed)
      .map((check) => check.id);
    expect(failed).toEqual(
      expect.arrayContaining([
        'totpFullLogin.totpVerify.p95',
        'totpFullLogin.token.p99',
        'totpFullLogin.totpCompletion.p95',
      ])
    );
  });

  it('counts dropped iterations against success and requires the full fixed load', () => {
    const input = evidence();
    input.scenarios.identifierDiscovery.measurement.successCount = 14_984;
    input.scenarios.identifierDiscovery.measurement.droppedIterations = 16;
    const result = evaluatePhase0cEvidence(input);
    expect(result.scenarioSummaries.identifierDiscovery.successRate).toBeCloseTo(0.998933, 6);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: 'identifierDiscovery.success_rate', passed: false })
    );
    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: 'identifierDiscovery.dropped_iterations', passed: false })
    );

    input.scenarios.identifierDiscovery.measurement.droppedIterations = 0;
    expect(evaluatePhase0cEvidence(input).checks).toContainEqual(
      expect.objectContaining({ id: 'identifierDiscovery.scheduled_iterations', passed: false })
    );
  });

  it('fails closed for routing errors and hot-path architecture violations', () => {
    const input = evidence();
    input.scenarios.totpFullLogin.errors.routing5xx = 1;
    input.scenarios.identifierDiscovery.errors.timeouts = 1;
    input.scenarios.identifierDiscovery.errors.d1Overloaded = 1;
    input.invariants.controlWorkerHotPathCalls = 1;
    input.invariants.cloudflareRestHotPathCalls = 1;
    input.invariants.identifierMaxPhysicalLookupD1Reads = 2;
    input.invariants.accountRouteKvReads = 1;
    input.invariants.accountRouteKvWrites = 1;
    input.invariants.routeFailOpenCount = 1;
    const result = evaluatePhase0cEvidence(input);
    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'totpFullLogin.routing5xx',
        'identifierDiscovery.timeouts',
        'identifierDiscovery.d1Overloaded',
        'invariant.controlWorkerHotPathCalls',
        'invariant.cloudflareRestHotPathCalls',
        'invariant.identifierMaxPhysicalLookupD1Reads',
        'invariant.accountRouteKvReads',
        'invariant.accountRouteKvWrites',
        'invariant.routeFailOpenCount',
      ])
    );
  });

  it('rejects incomplete metadata, unobserved cold routing, and non-test evidence', () => {
    const input = evidence() as unknown as Record<string, unknown>;
    expect(() => parsePhase0cEvidence({ ...input, environment: 'conformance' })).toThrow(
      'invalid_phase0c_evidence:environment'
    );
    expect(() => parsePhase0cEvidence({ ...input, commit: 'deadbeef' })).toThrow(
      'invalid_phase0c_evidence:commit'
    );
    expect(() => parsePhase0cEvidence({ ...input, runId: '../replace-evidence' })).toThrow(
      'invalid_phase0c_evidence:runId'
    );
    expect(() => parsePhase0cEvidence({ ...input, executedAt: 'July 29 2026' })).toThrow(
      'invalid_phase0c_evidence:executedAt'
    );
    const missingRegion = evidence() as unknown as {
      scenarios: { identifierDiscovery: { coldSamples: Array<Record<string, unknown>> } };
    };
    delete missingRegion.scenarios.identifierDiscovery.coldSamples[0].servedByRegion;
    expect(() => parsePhase0cEvidence(missingRegion)).toThrow(
      'invalid_phase0c_evidence:scenarios.identifierDiscovery.coldSamples[0].servedByRegion'
    );
  });

  it('rejects internally inconsistent latency percentiles', () => {
    const input = evidence();
    input.scenarios.identifierDiscovery.measurement.p50Ms = 800;
    expect(() => parsePhase0cEvidence(input)).toThrow(
      'invalid_phase0c_evidence:scenarios.identifierDiscovery.measurement.percentiles'
    );
  });

  it('permits only test input and has no threshold override arguments', () => {
    expect(
      parsePhase0cGateArgs(['--env', 'test', '--input', './result.json', '--output-dir', './out'])
    ).toMatchObject({ env: 'test' });
    expect(() => parsePhase0cGateArgs(['--env', 'production', '--input', './result.json'])).toThrow(
      'phase0c_test_environment_required'
    );
    expect(() =>
      parsePhase0cGateArgs([
        '--env',
        'test',
        '--input',
        './result.json',
        '--minimum-success-rate',
        '0.5',
      ])
    ).toThrow('unknown_argument:--minimum-success-rate');
  });

  it('renders an explicit release block and investigation guidance', () => {
    const input = evidence();
    input.scenarios.identifierDiscovery.measurement.p95Ms = 401;
    const checklist = renderPhase0cChecklist(input, evaluatePhase0cEvidence(input));
    expect(checklist).toContain('Result: **BLOCKED**');
    expect(checklist).toContain('blocks the main PR and external public release');
    expect(checklist).toContain('Lookup D1 query');
    expect(checklist).toContain('KV route cache');
  });

  it('blocks a Lookup result above the fixed p99 boundary', () => {
    const input = evidence();
    input.scenarios.identifierDiscovery.measurement.p99Ms = 751;
    expect(evaluatePhase0cEvidence(input).checks).toContainEqual(
      expect.objectContaining({ id: 'identifierDiscovery.p99', passed: false })
    );
  });

  it('persists only normalized fields and does not carry arbitrary secret input', async () => {
    const directory = resolve('/private/tmp', `authrim-phase0c-${crypto.randomUUID()}`);
    const inputPath = resolve(directory, 'input.json');
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        inputPath,
        JSON.stringify({
          ...evidence(),
          authorization: 'Bearer should-not-persist',
          scenarios: {
            ...evidence().scenarios,
            identifierDiscovery: {
              ...evidence().scenarios.identifierDiscovery,
              apiToken: 'should-not-persist',
            },
          },
        })
      );
      const result = await runPhase0cGate({
        env: 'test',
        inputPath,
        outputDir: resolve(directory, 'out'),
      });
      const persisted = await readFile(result.evidencePath, 'utf8');
      expect(result.evaluation.passed).toBe(true);
      expect(persisted).not.toContain('Bearer should-not-persist');
      expect(persisted).not.toContain('should-not-persist');
      expect(await readFile(result.checklistPath, 'utf8')).toContain('Result: **PASS**');
      await expect(
        runPhase0cGate({ env: 'test', inputPath, outputDir: resolve(directory, 'out') })
      ).rejects.toMatchObject({ code: 'EEXIST' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
