#!/usr/bin/env node

import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUTPUT_DIR = resolve(
  REPO_ROOT,
  'private/docs/implementation/unified-control-plane/performance'
);

export const PHASE0C_GATE = Object.freeze({
  environment: 'test',
  warmupSeconds: 30,
  measurementSeconds: 300,
  coldSampleCount: 3,
  scenarios: Object.freeze({
    identifierDiscovery: Object.freeze({
      ratePerSecond: 50,
      minimumSuccessRate: 0.999,
      maximumP95Ms: 400,
      maximumP99Ms: 750,
      maximumDroppedIterations: 0,
    }),
    totpFullLogin: Object.freeze({
      ratePerSecond: 25,
      minimumSuccessRate: 0.995,
      maximumP95Ms: 5_000,
      stepMaximumP95Ms: Object.freeze({
        authorizeInit: 1_000,
        totpStart: 1_000,
        totpVerify: 1_500,
        authorizeCode: 1_000,
        token: 1_500,
      }),
      stepMaximumP99Ms: 2_000,
      totpCompletionMaximumP95Ms: 3_000,
      maximumDroppedIterations: 0,
    }),
  }),
});

export type Phase0cScenarioName = keyof typeof PHASE0C_GATE.scenarios;
export type Phase0cTotpStepName =
  keyof (typeof PHASE0C_GATE.scenarios.totpFullLogin)['stepMaximumP95Ms'];
export type Phase0cTotpLatencySegment = Phase0cTotpStepName | 'totpCompletion' | 'fullFlow';

export interface Phase0cLatencyPercentiles {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface Phase0cColdSample {
  latencyMs: number;
  servedByRegion: string;
  servedByPrimary: boolean;
}

export interface Phase0cScenarioResult {
  warmup: {
    durationSeconds: number;
    excludedFromMeasurement: boolean;
  };
  measurement: {
    durationSeconds: number;
    ratePerSecond: number;
    successCount: number;
    failureCount: number;
    droppedIterations: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  errors: {
    routing5xx: number;
    timeouts: number;
    d1Overloaded: number;
  };
  latencyMs?: Record<Phase0cTotpLatencySegment, Phase0cLatencyPercentiles>;
  coldSamples: Phase0cColdSample[];
  trace?: {
    requestOrIsolateP95Ms: number;
    lookupD1QueryP95Ms: number;
    primaryRecheckCount: number;
  };
}

export interface Phase0cPerformanceEvidence {
  schemaVersion: 4;
  runId: string;
  executedAt: string;
  commit: string;
  environment: 'test';
  sourceRegion: string;
  scenarios: Record<Phase0cScenarioName, Phase0cScenarioResult>;
  invariants: {
    controlWorkerHotPathCalls: number;
    cloudflareRestHotPathCalls: number;
    identifierMaxPhysicalLookupD1Reads: number;
    accountRouteKvReads: number;
    accountRouteKvWrites: number;
    routeFailOpenCount: number;
  };
}

export interface Phase0cGateCheck {
  id: string;
  passed: boolean;
  observed: string;
  required: string;
}

export interface Phase0cGateEvaluation {
  passed: boolean;
  checks: Phase0cGateCheck[];
  scenarioSummaries: Record<
    Phase0cScenarioName,
    {
      scheduledIterations: number;
      successRate: number;
      p95Ms: number;
      p99Ms: number;
    }
  >;
}

const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

interface CliOptions {
  env: 'test';
  inputPath: string;
  outputDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid_phase0c_evidence:${path}`);
  return value;
}

function requiredString(value: unknown, path: string, maximumLength = 200): string {
  if (typeof value !== 'string') throw new Error(`invalid_phase0c_evidence:${path}`);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`invalid_phase0c_evidence:${path}`);
  }
  return normalized;
}

function requiredFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid_phase0c_evidence:${path}`);
  }
  return value;
}

function requiredCount(value: unknown, path: string): number {
  const number = requiredFiniteNumber(value, path);
  if (!Number.isSafeInteger(number)) throw new Error(`invalid_phase0c_evidence:${path}`);
  return number;
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`invalid_phase0c_evidence:${path}`);
  return value;
}

function parseColdSample(value: unknown, path: string): Phase0cColdSample {
  const input = requiredRecord(value, path);
  return {
    latencyMs: requiredFiniteNumber(input.latencyMs, `${path}.latencyMs`),
    servedByRegion: requiredString(input.servedByRegion, `${path}.servedByRegion`, 100),
    servedByPrimary: requiredBoolean(input.servedByPrimary, `${path}.servedByPrimary`),
  };
}

const TOTP_LATENCY_SEGMENTS = [
  'authorizeInit',
  'totpStart',
  'totpVerify',
  'authorizeCode',
  'token',
  'totpCompletion',
  'fullFlow',
] as const satisfies readonly Phase0cTotpLatencySegment[];

function parseLatencyPercentiles(value: unknown, path: string): Phase0cLatencyPercentiles {
  const input = requiredRecord(value, path);
  const result = {
    p50Ms: requiredFiniteNumber(input.p50Ms, `${path}.p50Ms`),
    p95Ms: requiredFiniteNumber(input.p95Ms, `${path}.p95Ms`),
    p99Ms: requiredFiniteNumber(input.p99Ms, `${path}.p99Ms`),
  };
  if (result.p50Ms > result.p95Ms || result.p95Ms > result.p99Ms) {
    throw new Error(`invalid_phase0c_evidence:${path}.percentiles`);
  }
  return result;
}

function parseScenario(
  value: unknown,
  path: string,
  requireTotpLatency = false
): Phase0cScenarioResult {
  const input = requiredRecord(value, path);
  const warmup = requiredRecord(input.warmup, `${path}.warmup`);
  const measurement = requiredRecord(input.measurement, `${path}.measurement`);
  const errors = requiredRecord(input.errors, `${path}.errors`);
  if (!Array.isArray(input.coldSamples)) {
    throw new Error(`invalid_phase0c_evidence:${path}.coldSamples`);
  }

  const result: Phase0cScenarioResult = {
    warmup: {
      durationSeconds: requiredFiniteNumber(
        warmup.durationSeconds,
        `${path}.warmup.durationSeconds`
      ),
      excludedFromMeasurement: requiredBoolean(
        warmup.excludedFromMeasurement,
        `${path}.warmup.excludedFromMeasurement`
      ),
    },
    measurement: {
      durationSeconds: requiredFiniteNumber(
        measurement.durationSeconds,
        `${path}.measurement.durationSeconds`
      ),
      ratePerSecond: requiredFiniteNumber(
        measurement.ratePerSecond,
        `${path}.measurement.ratePerSecond`
      ),
      successCount: requiredCount(measurement.successCount, `${path}.measurement.successCount`),
      failureCount: requiredCount(measurement.failureCount, `${path}.measurement.failureCount`),
      droppedIterations: requiredCount(
        measurement.droppedIterations,
        `${path}.measurement.droppedIterations`
      ),
      p50Ms: requiredFiniteNumber(measurement.p50Ms, `${path}.measurement.p50Ms`),
      p95Ms: requiredFiniteNumber(measurement.p95Ms, `${path}.measurement.p95Ms`),
      p99Ms: requiredFiniteNumber(measurement.p99Ms, `${path}.measurement.p99Ms`),
    },
    errors: {
      routing5xx: requiredCount(errors.routing5xx, `${path}.errors.routing5xx`),
      timeouts: requiredCount(errors.timeouts, `${path}.errors.timeouts`),
      d1Overloaded: requiredCount(errors.d1Overloaded, `${path}.errors.d1Overloaded`),
    },
    coldSamples: input.coldSamples.map((sample, index) =>
      parseColdSample(sample, `${path}.coldSamples[${index}]`)
    ),
  };

  if (input.trace !== undefined) {
    const trace = requiredRecord(input.trace, `${path}.trace`);
    result.trace = {
      requestOrIsolateP95Ms: requiredFiniteNumber(
        trace.requestOrIsolateP95Ms,
        `${path}.trace.requestOrIsolateP95Ms`
      ),
      lookupD1QueryP95Ms: requiredFiniteNumber(
        trace.lookupD1QueryP95Ms,
        `${path}.trace.lookupD1QueryP95Ms`
      ),
      primaryRecheckCount: requiredCount(
        trace.primaryRecheckCount,
        `${path}.trace.primaryRecheckCount`
      ),
    };
  }
  if (requireTotpLatency) {
    const latency = requiredRecord(input.latencyMs, `${path}.latencyMs`);
    result.latencyMs = Object.fromEntries(
      TOTP_LATENCY_SEGMENTS.map((segment) => [
        segment,
        parseLatencyPercentiles(latency[segment], `${path}.latencyMs.${segment}`),
      ])
    ) as Record<Phase0cTotpLatencySegment, Phase0cLatencyPercentiles>;
  } else if (input.latencyMs !== undefined) {
    throw new Error(`invalid_phase0c_evidence:${path}.latencyMs`);
  }
  return result;
}

export function parsePhase0cEvidence(value: unknown): Phase0cPerformanceEvidence {
  const input = requiredRecord(value, 'root');
  if (input.schemaVersion !== 4) throw new Error('invalid_phase0c_evidence:schemaVersion');
  const executedAt = requiredString(input.executedAt, 'executedAt', 50);
  if (!ISO_TIMESTAMP.test(executedAt) || !Number.isFinite(Date.parse(executedAt))) {
    throw new Error('invalid_phase0c_evidence:executedAt');
  }
  const commit = requiredString(input.commit, 'commit', 40);
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('invalid_phase0c_evidence:commit');
  if (input.environment !== PHASE0C_GATE.environment) {
    throw new Error('invalid_phase0c_evidence:environment');
  }
  const scenarios = requiredRecord(input.scenarios, 'scenarios');
  const invariants = requiredRecord(input.invariants, 'invariants');

  const runId = requiredString(input.runId, 'runId', 100);
  if (!SAFE_RUN_ID.test(runId)) throw new Error('invalid_phase0c_evidence:runId');
  const evidence: Phase0cPerformanceEvidence = {
    schemaVersion: 4,
    runId,
    executedAt,
    commit,
    environment: 'test',
    sourceRegion: requiredString(input.sourceRegion, 'sourceRegion', 100),
    scenarios: {
      identifierDiscovery: parseScenario(
        scenarios.identifierDiscovery,
        'scenarios.identifierDiscovery'
      ),
      totpFullLogin: parseScenario(scenarios.totpFullLogin, 'scenarios.totpFullLogin', true),
    },
    invariants: {
      controlWorkerHotPathCalls: requiredCount(
        invariants.controlWorkerHotPathCalls,
        'invariants.controlWorkerHotPathCalls'
      ),
      cloudflareRestHotPathCalls: requiredCount(
        invariants.cloudflareRestHotPathCalls,
        'invariants.cloudflareRestHotPathCalls'
      ),
      identifierMaxPhysicalLookupD1Reads: requiredCount(
        invariants.identifierMaxPhysicalLookupD1Reads,
        'invariants.identifierMaxPhysicalLookupD1Reads'
      ),
      accountRouteKvReads: requiredCount(
        invariants.accountRouteKvReads,
        'invariants.accountRouteKvReads'
      ),
      accountRouteKvWrites: requiredCount(
        invariants.accountRouteKvWrites,
        'invariants.accountRouteKvWrites'
      ),
      routeFailOpenCount: requiredCount(
        invariants.routeFailOpenCount,
        'invariants.routeFailOpenCount'
      ),
    },
  };
  for (const [name, scenario] of Object.entries(evidence.scenarios)) {
    if (
      scenario.measurement.p50Ms > scenario.measurement.p95Ms ||
      scenario.measurement.p95Ms > scenario.measurement.p99Ms
    ) {
      throw new Error(`invalid_phase0c_evidence:scenarios.${name}.measurement.percentiles`);
    }
  }
  return evidence;
}

function addCheck(
  checks: Phase0cGateCheck[],
  id: string,
  passed: boolean,
  observed: string | number | boolean,
  required: string
): void {
  checks.push({ id, passed, observed: String(observed), required });
}

export function evaluatePhase0cEvidence(
  evidence: Phase0cPerformanceEvidence
): Phase0cGateEvaluation {
  const checks: Phase0cGateCheck[] = [];
  const scenarioSummaries = {} as Phase0cGateEvaluation['scenarioSummaries'];

  for (const scenarioName of Object.keys(PHASE0C_GATE.scenarios) as Phase0cScenarioName[]) {
    const scenario = evidence.scenarios[scenarioName];
    const policy = PHASE0C_GATE.scenarios[scenarioName];
    const scheduledIterations =
      scenario.measurement.successCount +
      scenario.measurement.failureCount +
      scenario.measurement.droppedIterations;
    const successRate =
      scheduledIterations === 0 ? 0 : scenario.measurement.successCount / scheduledIterations;
    scenarioSummaries[scenarioName] = {
      scheduledIterations,
      successRate,
      p95Ms: scenario.measurement.p95Ms,
      p99Ms: scenario.measurement.p99Ms,
    };
    addCheck(
      checks,
      `${scenarioName}.warmup_duration`,
      scenario.warmup.durationSeconds === PHASE0C_GATE.warmupSeconds,
      scenario.warmup.durationSeconds,
      `${PHASE0C_GATE.warmupSeconds}s`
    );
    addCheck(
      checks,
      `${scenarioName}.warmup_excluded`,
      scenario.warmup.excludedFromMeasurement,
      scenario.warmup.excludedFromMeasurement,
      'true'
    );
    addCheck(
      checks,
      `${scenarioName}.measurement_duration`,
      scenario.measurement.durationSeconds === PHASE0C_GATE.measurementSeconds,
      scenario.measurement.durationSeconds,
      `${PHASE0C_GATE.measurementSeconds}s`
    );
    addCheck(
      checks,
      `${scenarioName}.rate`,
      scenario.measurement.ratePerSecond === policy.ratePerSecond,
      scenario.measurement.ratePerSecond,
      `${policy.ratePerSecond}/s`
    );
    addCheck(
      checks,
      `${scenarioName}.scheduled_iterations`,
      scheduledIterations === policy.ratePerSecond * PHASE0C_GATE.measurementSeconds,
      scheduledIterations,
      String(policy.ratePerSecond * PHASE0C_GATE.measurementSeconds)
    );
    addCheck(
      checks,
      `${scenarioName}.success_rate`,
      successRate >= policy.minimumSuccessRate,
      successRate.toFixed(6),
      `>=${policy.minimumSuccessRate}`
    );
    addCheck(
      checks,
      `${scenarioName}.p95`,
      scenario.measurement.p95Ms <= policy.maximumP95Ms,
      `${scenario.measurement.p95Ms}ms`,
      `<=${policy.maximumP95Ms}ms`
    );
    if ('maximumP99Ms' in policy) {
      addCheck(
        checks,
        `${scenarioName}.p99`,
        scenario.measurement.p99Ms <= policy.maximumP99Ms,
        `${scenario.measurement.p99Ms}ms`,
        `<=${policy.maximumP99Ms}ms`
      );
    }
    if (scenarioName === 'totpFullLogin') {
      const latency = scenario.latencyMs;
      const totpPolicy = PHASE0C_GATE.scenarios.totpFullLogin;
      addCheck(
        checks,
        'totpFullLogin.latency_breakdown',
        latency !== undefined,
        latency !== undefined,
        'true'
      );
      if (latency) {
        for (const [step, maximumP95Ms] of Object.entries(totpPolicy.stepMaximumP95Ms) as Array<
          [Phase0cTotpStepName, number]
        >) {
          addCheck(
            checks,
            `totpFullLogin.${step}.p95`,
            latency[step].p95Ms <= maximumP95Ms,
            `${latency[step].p95Ms}ms`,
            `<=${maximumP95Ms}ms`
          );
          addCheck(
            checks,
            `totpFullLogin.${step}.p99`,
            latency[step].p99Ms <= totpPolicy.stepMaximumP99Ms,
            `${latency[step].p99Ms}ms`,
            `<=${totpPolicy.stepMaximumP99Ms}ms`
          );
        }
        addCheck(
          checks,
          'totpFullLogin.totpCompletion.p95',
          latency.totpCompletion.p95Ms <= totpPolicy.totpCompletionMaximumP95Ms,
          `${latency.totpCompletion.p95Ms}ms`,
          `<=${totpPolicy.totpCompletionMaximumP95Ms}ms`
        );
        addCheck(
          checks,
          'totpFullLogin.fullFlow.p95_consistent',
          latency.fullFlow.p95Ms === scenario.measurement.p95Ms,
          `${latency.fullFlow.p95Ms}ms`,
          `${scenario.measurement.p95Ms}ms`
        );
        addCheck(
          checks,
          'totpFullLogin.fullFlow.p99_consistent',
          latency.fullFlow.p99Ms === scenario.measurement.p99Ms,
          `${latency.fullFlow.p99Ms}ms`,
          `${scenario.measurement.p99Ms}ms`
        );
      }
    }
    addCheck(
      checks,
      `${scenarioName}.dropped_iterations`,
      scenario.measurement.droppedIterations <= policy.maximumDroppedIterations,
      scenario.measurement.droppedIterations,
      `<=${policy.maximumDroppedIterations}`
    );
    for (const [errorName, count] of Object.entries(scenario.errors)) {
      addCheck(checks, `${scenarioName}.${errorName}`, count === 0, count, '0');
    }
    addCheck(
      checks,
      `${scenarioName}.cold_samples`,
      scenario.coldSamples.length === PHASE0C_GATE.coldSampleCount,
      scenario.coldSamples.length,
      String(PHASE0C_GATE.coldSampleCount)
    );
  }

  const invariantRequirements: Array<[keyof Phase0cPerformanceEvidence['invariants'], number]> = [
    ['controlWorkerHotPathCalls', 0],
    ['cloudflareRestHotPathCalls', 0],
    ['identifierMaxPhysicalLookupD1Reads', 1],
    ['accountRouteKvReads', 0],
    ['accountRouteKvWrites', 0],
    ['routeFailOpenCount', 0],
  ];
  for (const [name, maximum] of invariantRequirements) {
    const value = evidence.invariants[name];
    addCheck(checks, `invariant.${name}`, value <= maximum, value, `<=${maximum}`);
  }

  return { passed: checks.every((check) => check.passed), checks, scenarioSummaries };
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/\|/gu, '\\|')
    .replace(/[\r\n]+/gu, ' ');
}

export function renderPhase0cChecklist(
  evidence: Phase0cPerformanceEvidence,
  evaluation: Phase0cGateEvaluation
): string {
  const lines = [
    '# Phase 0c Manual Performance Gate',
    '',
    `- Run: \`${escapeMarkdown(evidence.runId)}\``,
    `- Executed: \`${evidence.executedAt}\``,
    `- Commit: \`${evidence.commit}\``,
    `- Environment: \`${evidence.environment}\``,
    `- Source region: \`${escapeMarkdown(evidence.sourceRegion)}\``,
    `- Result: **${evaluation.passed ? 'PASS' : 'BLOCKED'}**`,
    '',
    '| Check | Observed | Required | Result |',
    '| --- | ---: | ---: | --- |',
    ...evaluation.checks.map(
      (check) =>
        `| ${escapeMarkdown(check.id)} | ${escapeMarkdown(check.observed)} | ${escapeMarkdown(check.required)} | ${check.passed ? 'PASS' : 'FAIL'} |`
    ),
    '',
    '## Cold / Semi-cold Observations',
    '',
    '| Scenario | Sample | Latency | Region | Primary |',
    '| --- | ---: | ---: | --- | --- |',
  ];
  for (const scenarioName of Object.keys(PHASE0C_GATE.scenarios) as Phase0cScenarioName[]) {
    evidence.scenarios[scenarioName].coldSamples.forEach((sample, index) => {
      lines.push(
        `| ${scenarioName} | ${index + 1} | ${sample.latencyMs}ms | ${escapeMarkdown(sample.servedByRegion)} | ${sample.servedByPrimary ? 'yes' : 'no'} |`
      );
    });
  }
  lines.push(
    '',
    '## Failure Handling',
    '',
    '- A blocked result blocks the main PR and external public release.',
    '- Do not relax thresholds before identifying the failing request/isolate, Lookup D1 query, and primary-recheck component.',
    '- Consider a KV route cache only when traces show the Lookup D1 hop is dominant after query and index fixes.',
    ''
  );
  return `${lines.join('\n')}\n`;
}

function safeOutputDirectory(value: string): string {
  const output = resolve(value);
  if (output === '/' || output === resolve(tmpdir())) throw new Error('unsafe_phase0c_output_dir');
  return output;
}

export function parsePhase0cGateArgs(argv: string[]): CliOptions {
  let env: string | undefined;
  let inputPath: string | undefined;
  let outputDir = DEFAULT_OUTPUT_DIR;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--env') env = argv[++index];
    else if (argument === '--input') inputPath = argv[++index];
    else if (argument === '--output-dir') outputDir = argv[++index];
    else if (argument === '--help' || argument === '-h') throw new Error('help_requested');
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (env !== PHASE0C_GATE.environment) throw new Error('phase0c_test_environment_required');
  if (!inputPath?.trim()) throw new Error('phase0c_input_required');
  if (!outputDir?.trim()) throw new Error('phase0c_output_dir_required');
  return { env: 'test', inputPath: resolve(inputPath), outputDir: safeOutputDirectory(outputDir) };
}

export async function runPhase0cGate(options: CliOptions): Promise<{
  evidencePath: string;
  checklistPath: string;
  evaluation: Phase0cGateEvaluation;
}> {
  const evidence = parsePhase0cEvidence(JSON.parse(await readFile(options.inputPath, 'utf8')));
  const evaluation = evaluatePhase0cEvidence(evidence);
  await mkdir(options.outputDir, { recursive: true });
  const evidencePath = resolve(options.outputDir, `${evidence.runId}.json`);
  const checklistPath = resolve(options.outputDir, `${evidence.runId}.md`);
  let evidenceCreated = false;
  let checklistCreated = false;
  try {
    const evidenceFile = await open(evidencePath, 'wx', 0o600);
    evidenceCreated = true;
    try {
      const checklistFile = await open(checklistPath, 'wx', 0o600);
      checklistCreated = true;
      try {
        await Promise.all([
          evidenceFile.writeFile(`${JSON.stringify({ evidence, evaluation }, null, 2)}\n`),
          checklistFile.writeFile(renderPhase0cChecklist(evidence, evaluation)),
        ]);
      } finally {
        await checklistFile.close();
      }
    } finally {
      await evidenceFile.close();
    }
  } catch (error) {
    if (evidenceCreated) await rm(evidencePath, { force: true });
    if (checklistCreated) await rm(checklistPath, { force: true });
    throw error;
  }
  return { evidencePath, checklistPath, evaluation };
}

function printUsage(): void {
  process.stdout.write(`Unified D1 Control Plane Phase 0c performance gate\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(
    `  pnpm control-plane:phase0c-gate --env test --input <normalized-result.json>\n`
  );
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parsePhase0cGateArgs(process.argv.slice(2));
  } catch (error) {
    printUsage();
    if (error instanceof Error && error.message === 'help_requested') return;
    throw error;
  }
  const result = await runPhase0cGate(options);
  process.stdout.write(`Evidence: ${result.evidencePath}\n`);
  process.stdout.write(`Checklist: ${result.checklistPath}\n`);
  process.stdout.write(`Result: ${result.evaluation.passed ? 'PASS' : 'BLOCKED'}\n`);
  if (!result.evaluation.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
