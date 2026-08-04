#!/usr/bin/env node

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TotpProfile } from '../../packages/ar-lib-core/src/utils/totp.js';
import {
  buildSetupMachineAccessBootstrapSql,
  ensureSetupMachineKeyFiles,
  loadSetupMachinePublicJwk,
  requestAdminMachineAccessToken,
} from '../../packages/setup/src/core/admin-machine-access.js';
import { executeD1Command } from '../../packages/setup/src/core/cloudflare.js';
import {
  findPhase0cClientIdsByExactName,
  findPhase0cUserIdByExactEmail,
  hasExactPhase0cScope,
  parsePhase0cRateLimitOverride,
  phase0cAdminJson,
  readPhase0cJson,
  strictPhase0cAdminDatabaseName,
  strictPhase0cLiveConfig,
  waitForPhase0cRateLimitProfile,
} from './phase0c-mail-otp-live.js';
import {
  buildTotpSettingsRestorePatch,
  cleanupPhase0cMachinePrincipal,
  createPhase0cTotpRunId,
  createPhase0cTotpUser,
  isPhase0cAuthTimingName,
  isPhase0cTokenTimingName,
  runPhase0cTotpFullLogin,
  safePhase0cTotpExecutionError,
  strictPhase0cTotpCategorySettings,
  waitForPhase0cTotpSettings,
  waitForPhase0cTotpUserAbsent,
  waitForRestoredPhase0cTotpSettings,
  type Phase0cTotpCategorySettings,
  type Phase0cTotpFullLoginEvidence,
} from './phase0c-totp-smoke-live.js';
import { resolvePhase0cTenantApiBaseUrl } from './phase0c-live-url.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_CONFIG_PATH = resolve(REPO_ROOT, '.authrim/test/config.json');
const TEST_LOCK_PATH = resolve(REPO_ROOT, '.authrim/test/lock.json');
const REQUEST_TIMEOUT_MS = 20_000;
const RATE_LIMIT_OVERRIDE_TTL_SECONDS = 20 * 60;
const RESULT_PATH_PATTERN = /^\/(?:private\/)?tmp\/[^\0]+\.json$/u;
const RUN_ID_PATTERN = /^phase0c-totp-[0-9]{14}-[a-f0-9]{6}$/u;
const MACHINE_PERMISSIONS = [
  'admin:clients:*',
  'admin:users:*',
  'admin:security:write',
  'admin:settings:read',
  'admin:settings:write',
] as const;

export const PHASE0C_TOTP_LOAD_PROFILES = Object.freeze({
  sample: Object.freeze({
    ratePerSecond: 1,
    warmupSeconds: 3,
    measurementSeconds: 10,
    userCount: 16,
    maximumConcurrency: 16,
    provisioningConcurrency: 1,
  }),
  gate: Object.freeze({
    ratePerSecond: 25,
    warmupSeconds: 30,
    measurementSeconds: 300,
    userCount: 1_003,
    maximumConcurrency: 512,
    provisioningConcurrency: 4,
  }),
});

export type Phase0cTotpLoadProfileName = keyof typeof PHASE0C_TOTP_LOAD_PROFILES;

export function phase0cTotpReuseIntervalSeconds(profile: Phase0cTotpLoadProfileName): number {
  const policy = PHASE0C_TOTP_LOAD_PROFILES[profile];
  return policy.userCount / policy.ratePerSecond;
}

export interface Phase0cTotpLoadOptions {
  environment: 'test';
  confirmTestData: true;
  profile: Phase0cTotpLoadProfileName;
  resultPath: string;
}

interface TotpLoadUser {
  email: string;
  userId: string;
  secret: string;
  profile: TotpProfile;
}

type TotpLoadStage =
  | 'machine_setup'
  | 'settings_setup'
  | 'client_setup'
  | 'rate_limit_setup'
  | 'fixture_setup'
  | 'measurement_setup'
  | 'cold_samples'
  | 'warmup'
  | 'measurement'
  | 'cleanup';

const TOTP_SETTING_KEYS = [
  'authentication-methods.totp.login_enabled',
  'authentication-methods.totp.signup_enabled',
  'authentication-methods.totp.preset',
  'authentication-methods.human_verification.signup_enabled',
] as const;
const LOAD_CLEANUP_CODES = new Set([
  'machine_token_refresh_failed',
  'rate_limit_override_cleanup_failed',
  'user_cleanup_failed',
  'user_reconciliation_failed',
  'client_reconciliation_failed',
  'client_cleanup_failed',
  'settings_cleanup_failed',
  'machine_principal_cleanup_failed',
]);

function reportStage(stage: TotpLoadStage): void {
  process.stdout.write(`Phase 0c production TOTP load stage: ${stage}\n`);
}

export function safePhase0cTotpLoadExecutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cleanup = /^phase0c_totp_load_cleanup_incomplete:([a-z0-9_,]+)(?::(.+))?$/u.exec(message);
  if (cleanup) {
    const codes = cleanup[1].split(',');
    if (codes.every((code) => LOAD_CLEANUP_CODES.has(code))) {
      const execution = cleanup[2]
        ? `:${safePhase0cTotpLoadExecutionError(new Error(cleanup[2]))}`
        : '';
      return `phase0c_totp_load_cleanup_incomplete:${codes.join(',')}${execution}`;
    }
  }
  const stage = /^phase0c_totp_load_stage_[a-z0-9_]+_failed$/u.exec(message);
  if (stage) return stage[0];
  return safePhase0cTotpExecutionError(error);
}

function hasTemporaryTotpOverride(settings: Phase0cTotpCategorySettings): boolean {
  return (
    settings.values['authentication-methods.totp.login_enabled'] === true &&
    settings.values['authentication-methods.totp.signup_enabled'] === true &&
    settings.values['authentication-methods.totp.preset'] === 'compatible' &&
    settings.values['authentication-methods.human_verification.signup_enabled'] === false &&
    TOTP_SETTING_KEYS.every((key) => settings.sources[key] === 'kv')
  );
}

interface ArrivalResult {
  scheduledIterations: number;
  successCount: number;
  failureCount: number;
  droppedIterations: number;
  latenciesMs: Record<TotpLatencySegment, number[]>;
  diagnosticTimingMs: DiagnosticTimingSamples;
  errors: {
    routing5xx: number;
    timeouts: number;
    d1Overloaded: number;
  };
}

type TotpLatencySegment = keyof Phase0cTotpFullLoginEvidence['latencyMs'];
const DIAGNOSTIC_TIMING_PHASES = [
  'authorizeInit',
  'totpStart',
  'totpVerify',
  'authorizeCode',
  'token',
] as const;
type DiagnosticTimingPhase = (typeof DIAGNOSTIC_TIMING_PHASES)[number];
type DiagnosticTimingSamples = Record<DiagnosticTimingPhase, Record<string, number[]>>;

const TOTP_LATENCY_SEGMENTS = [
  'authorizeInit',
  'totpStart',
  'totpVerify',
  'authorizeCode',
  'token',
  'totpCompletion',
  'fullFlow',
] as const satisfies readonly TotpLatencySegment[];

interface LatencyPercentiles {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

type DiagnosticTimingPercentiles = Record<
  DiagnosticTimingPhase,
  Record<string, LatencyPercentiles>
>;

function emptyLatencySamples(): Record<TotpLatencySegment, number[]> {
  const samples = {} as Record<TotpLatencySegment, number[]>;
  for (const segment of TOTP_LATENCY_SEGMENTS) samples[segment] = [];
  return samples;
}

function emptyDiagnosticTimingSamples(): DiagnosticTimingSamples {
  return { authorizeInit: {}, totpStart: {}, totpVerify: {}, authorizeCode: {}, token: {} };
}

function appendDiagnosticTimingSamples(
  target: DiagnosticTimingSamples,
  evidence: Phase0cTotpFullLoginEvidence
): void {
  for (const phase of DIAGNOSTIC_TIMING_PHASES) {
    for (const [name, durationMs] of Object.entries(evidence.diagnosticTimingMs?.[phase] ?? {})) {
      const nameAllowed =
        phase === 'token' ? isPhase0cTokenTimingName(name) : isPhase0cAuthTimingName(name);
      if (!nameAllowed || !Number.isFinite(durationMs) || durationMs < 0) continue;
      (target[phase][name] ??= []).push(durationMs);
    }
  }
}

function diagnosticTimingPercentiles(
  samples: DiagnosticTimingSamples
): DiagnosticTimingPercentiles {
  return Object.fromEntries(
    DIAGNOSTIC_TIMING_PHASES.map((phase) => [
      phase,
      Object.fromEntries(
        Object.entries(samples[phase]).map(([name, values]) => [name, latencyPercentiles(values)])
      ),
    ])
  ) as DiagnosticTimingPercentiles;
}

function latencyPercentiles(values: readonly number[]): LatencyPercentiles {
  return {
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
  };
}

export interface Phase0cTotpLoadEvidence {
  schemaVersion: 2;
  runId: string;
  tenantId: string;
  scenario: 'production_totp_full_login_load';
  profile: Phase0cTotpLoadProfileName;
  authenticationBypass: false;
  testInbox: false;
  readReplication: 'disabled';
  userPool: {
    count: number;
    sameTimeStepReuse: false;
  };
  scenarioResult: {
    warmup: {
      durationSeconds: number;
      excludedFromMeasurement: true;
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
    latencyMs: Record<TotpLatencySegment, LatencyPercentiles>;
    diagnosticTimingMs?: DiagnosticTimingPercentiles;
    errors: ArrivalResult['errors'];
    coldSamples: Array<{
      latencyMs: number;
      servedByRegion: 'unknown';
      servedByPrimary: true;
    }>;
  };
  cleanup: {
    users: 'absent';
    client: 'deleted';
    settings: 'restored';
    machinePrincipal: 'deleted';
  };
}

function safeResultPath(value: string): string {
  const path = resolve(value);
  if (!RESULT_PATH_PATTERN.test(path)) {
    throw new Error('phase0c_totp_load_result_must_use_temporary_json_path');
  }
  return path;
}

export function parsePhase0cTotpLoadArgs(argv: string[]): Phase0cTotpLoadOptions {
  let environment: string | undefined;
  let profile: string | undefined;
  let resultPath: string | undefined;
  let confirmTestData = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--env') environment = argv[++index];
    else if (argument === '--profile') profile = argv[++index];
    else if (argument === '--result') resultPath = argv[++index];
    else if (argument === '--confirm-test-data') confirmTestData = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (environment !== 'test') throw new Error('phase0c_totp_load_test_environment_required');
  if (!confirmTestData) throw new Error('phase0c_totp_load_test_data_confirmation_required');
  if (profile !== 'sample' && profile !== 'gate') {
    throw new Error('phase0c_totp_load_profile_required');
  }
  if (!resultPath) throw new Error('phase0c_totp_load_result_path_required');
  return {
    environment: 'test',
    confirmTestData: true,
    profile,
    resultPath: safeResultPath(resultPath),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (firstError === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await operation(values[index], index);
      } catch (error) {
        firstError ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return results;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1);
  return Math.round(sorted[index] * 100) / 100;
}

function classifyFailure(error: unknown, errors: ArrivalResult['errors']): void {
  const message = error instanceof Error ? error.message : '';
  if (
    (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) ||
    /timeout|timed_out/iu.test(message)
  ) {
    errors.timeouts += 1;
  }
  if (/d1[_ ]?overload|overloaded/iu.test(message)) errors.d1Overloaded += 1;
  if (/:5\d\d(?:\D|$)/u.test(message)) errors.routing5xx += 1;
}

export async function runPhase0cTotpArrivalWindow(input: {
  ratePerSecond: number;
  durationSeconds: number;
  maximumConcurrency: number;
  users: readonly TotpLoadUser[];
  startingUserIndex: number;
  operation: (user: TotpLoadUser) => Promise<Phase0cTotpFullLoginEvidence>;
}): Promise<ArrivalResult> {
  const scheduledIterations = input.ratePerSecond * input.durationSeconds;
  const intervalMs = 1_000 / input.ratePerSecond;
  const start = performance.now();
  const activeUsers = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  const latenciesMs = emptyLatencySamples();
  const diagnosticTimingMs = emptyDiagnosticTimingSamples();
  const errors = { routing5xx: 0, timeouts: 0, d1Overloaded: 0 };
  let successCount = 0;
  let failureCount = 0;
  let droppedIterations = 0;

  for (let iteration = 0; iteration < scheduledIterations; iteration += 1) {
    const target = start + iteration * intervalMs;
    const remaining = target - performance.now();
    if (remaining > 0) await delay(remaining);
    const drift = performance.now() - target;
    const user = input.users[(input.startingUserIndex + iteration) % input.users.length];
    if (
      drift > intervalMs * 2 ||
      inFlight.size >= input.maximumConcurrency ||
      activeUsers.has(user.userId)
    ) {
      droppedIterations += 1;
      continue;
    }

    activeUsers.add(user.userId);
    const task = input
      .operation(user)
      .then((evidence) => {
        successCount += 1;
        for (const segment of TOTP_LATENCY_SEGMENTS) {
          latenciesMs[segment].push(evidence.latencyMs[segment]);
        }
        appendDiagnosticTimingSamples(diagnosticTimingMs, evidence);
      })
      .catch((error: unknown) => {
        failureCount += 1;
        classifyFailure(error, errors);
      })
      .finally(() => {
        activeUsers.delete(user.userId);
        inFlight.delete(task);
      });
    inFlight.add(task);
  }
  await Promise.all(inFlight);
  return {
    scheduledIterations,
    successCount,
    failureCount,
    droppedIterations,
    latenciesMs,
    diagnosticTimingMs,
    errors,
  };
}

export function validatePhase0cTotpLoadEvidence(input: {
  evidence: unknown;
  runId: string;
  tenantId: string;
  forbiddenValues: readonly string[];
}): Phase0cTotpLoadEvidence {
  const evidence = input.evidence as Partial<Phase0cTotpLoadEvidence>;
  const profile =
    evidence.profile === 'sample' || evidence.profile === 'gate'
      ? PHASE0C_TOTP_LOAD_PROFILES[evidence.profile]
      : null;
  const result = evidence.scenarioResult;
  const diagnosticTiming = result?.diagnosticTimingMs;
  if (
    evidence.schemaVersion !== 2 ||
    evidence.runId !== input.runId ||
    evidence.tenantId !== input.tenantId ||
    evidence.scenario !== 'production_totp_full_login_load' ||
    !profile ||
    evidence.authenticationBypass !== false ||
    evidence.testInbox !== false ||
    evidence.readReplication !== 'disabled' ||
    evidence.userPool?.count !== profile.userCount ||
    evidence.userPool.sameTimeStepReuse !== false ||
    result?.warmup.durationSeconds !== profile.warmupSeconds ||
    result.warmup.excludedFromMeasurement !== true ||
    result.measurement.durationSeconds !== profile.measurementSeconds ||
    result.measurement.ratePerSecond !== profile.ratePerSecond ||
    result.measurement.successCount +
      result.measurement.failureCount +
      result.measurement.droppedIterations !==
      profile.ratePerSecond * profile.measurementSeconds ||
    !result.latencyMs ||
    TOTP_LATENCY_SEGMENTS.some((segment) => {
      const latency = result.latencyMs[segment];
      return (
        !latency ||
        !Number.isFinite(latency.p50Ms) ||
        !Number.isFinite(latency.p95Ms) ||
        !Number.isFinite(latency.p99Ms) ||
        latency.p50Ms < 0 ||
        latency.p50Ms > latency.p95Ms ||
        latency.p95Ms > latency.p99Ms
      );
    }) ||
    (diagnosticTiming !== undefined &&
      (Object.keys(diagnosticTiming).length !== DIAGNOSTIC_TIMING_PHASES.length ||
        DIAGNOSTIC_TIMING_PHASES.some((phase) => {
          const metrics = diagnosticTiming[phase];
          return (
            !metrics ||
            Object.keys(metrics).length > 64 ||
            Object.entries(metrics).some(([name, latency]) => {
              return (
                !(phase === 'token'
                  ? isPhase0cTokenTimingName(name)
                  : isPhase0cAuthTimingName(name)) ||
                !latency ||
                !Number.isFinite(latency.p50Ms) ||
                !Number.isFinite(latency.p95Ms) ||
                !Number.isFinite(latency.p99Ms) ||
                latency.p50Ms < 0 ||
                latency.p50Ms > latency.p95Ms ||
                latency.p95Ms > latency.p99Ms
              );
            })
          );
        }))) ||
    result.coldSamples.length !== 3 ||
    result.coldSamples.some(
      (sample) =>
        !Number.isFinite(sample.latencyMs) ||
        sample.latencyMs < 0 ||
        sample.servedByRegion !== 'unknown' ||
        sample.servedByPrimary !== true
    ) ||
    evidence.cleanup?.users !== 'absent' ||
    evidence.cleanup.client !== 'deleted' ||
    evidence.cleanup.settings !== 'restored' ||
    evidence.cleanup.machinePrincipal !== 'deleted'
  ) {
    throw new Error('phase0c_totp_load_evidence_invalid');
  }
  const serialized = JSON.stringify(evidence);
  if (input.forbiddenValues.some((value) => value.length >= 4 && serialized.includes(value))) {
    throw new Error('phase0c_totp_load_evidence_contains_forbidden_value');
  }
  if (
    /"(?:authorization|bearer|client_secret|access_token|sessionId|challenge_id)"\s*:|@test\.authrim\.internal/iu.test(
      serialized
    )
  ) {
    throw new Error('phase0c_totp_load_evidence_contains_sensitive_key');
  }
  return evidence as Phase0cTotpLoadEvidence;
}

async function main(): Promise<void> {
  const options = parsePhase0cTotpLoadArgs(process.argv.slice(2));
  const policy = PHASE0C_TOTP_LOAD_PROFILES[options.profile];
  const config = strictPhase0cLiveConfig(await readPhase0cJson(TEST_CONFIG_PATH));
  const lock = await readPhase0cJson(TEST_LOCK_PATH);
  const adminDatabaseName = strictPhase0cAdminDatabaseName(lock);
  const tenantId = config.tenant.name;
  const baseUrl = resolvePhase0cTenantApiBaseUrl(config, options.environment);
  const runId = createPhase0cTotpRunId();
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('phase0c_totp_load_run_id_invalid');

  const tempDir = await mkdtemp('/private/tmp/authrim-phase0c-totp-load-');
  await chmod(tempDir, 0o700);
  const machineClientId = `authrim-${runId}`;
  const principalId = `amp_${runId.replace(/-/gu, '_')}`;
  const clientName = `Phase 0c production TOTP ${options.profile} ${runId}`;
  const redirectUri = 'https://localhost:3000/callback';
  const plannedEmails = Array.from(
    { length: policy.userCount },
    (_, index) => `${runId}-${String(index).padStart(4, '0')}@test.authrim.internal`
  );
  const startedEmails: string[] = [];

  let machinePrincipalCreated = false;
  let adminToken = '';
  let oauthClientId = '';
  let oauthClientSecret = '';
  let originalSettings: Phase0cTotpCategorySettings | null = null;
  let settingsMutated = false;
  let previousRateLimitOverride: ReturnType<typeof parsePhase0cRateLimitOverride> | undefined;
  let rateLimitOverrideMutated = false;
  let users: TotpLoadUser[] = [];
  const createdUsers: TotpLoadUser[] = [];
  const deletedEmails = new Set<string>();
  let scenarioResult: Phase0cTotpLoadEvidence['scenarioResult'] | null = null;
  let executionError: unknown = null;
  let executionStage: TotpLoadStage = 'machine_setup';
  const cleanupErrors: string[] = [];

  try {
    reportStage(executionStage);
    await ensureSetupMachineKeyFiles(tempDir, `${runId}-key`);
    const publicJwk = await loadSetupMachinePublicJwk(tempDir);
    machinePrincipalCreated = true;
    await executeD1Command(
      adminDatabaseName,
      buildSetupMachineAccessBootstrapSql(config, publicJwk, {
        clientId: machineClientId,
        principalId,
        permissions: MACHINE_PERMISSIONS,
        displayName: clientName,
        description: 'Ephemeral production TOTP Phase 0c load principal.',
        principalType: 'automation',
        tokenTtlSeconds: 15 * 60,
        createdByActorId: runId,
      })
    );
    const machineToken = await requestAdminMachineAccessToken({
      apiBaseUrl: baseUrl,
      keysDir: tempDir,
      tenantId,
      clientId: machineClientId,
      scopes: MACHINE_PERMISSIONS,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!hasExactPhase0cScope(machineToken.scope, MACHINE_PERMISSIONS)) {
      throw new Error('phase0c_totp_load_machine_token_scope_invalid');
    }
    adminToken = machineToken.accessToken;

    executionStage = 'settings_setup';
    reportStage(executionStage);
    originalSettings = strictPhase0cTotpCategorySettings(
      await phase0cAdminJson({
        baseUrl,
        path: `/api/admin/tenants/${encodeURIComponent(tenantId)}/settings/authentication-methods`,
        token: adminToken,
        tenantId,
      })
    );
    if (hasTemporaryTotpOverride(originalSettings)) {
      throw new Error('phase0c_totp_load_baseline_requires_repair');
    }
    settingsMutated = true;
    await phase0cAdminJson({
      baseUrl,
      path: `/api/admin/tenants/${encodeURIComponent(tenantId)}/settings/authentication-methods`,
      method: 'PATCH',
      token: adminToken,
      tenantId,
      body: {
        ifMatch: originalSettings.version,
        set: {
          'authentication-methods.totp.login_enabled': true,
          'authentication-methods.totp.signup_enabled': true,
          'authentication-methods.totp.preset': 'compatible',
          'authentication-methods.human_verification.signup_enabled': false,
        },
      },
    });
    await waitForPhase0cTotpSettings({ baseUrl, tenantId, token: adminToken });

    executionStage = 'client_setup';
    reportStage(executionStage);
    const clientPayload = (await phase0cAdminJson({
      baseUrl,
      path: '/api/admin/clients',
      method: 'POST',
      token: adminToken,
      tenantId,
      idempotencyKey: `phase0c-totp-load-client-${runId}`,
      body: {
        client_name: clientName,
        description: 'Disposable production TOTP Phase 0c load client.',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
        require_pkce: true,
        default_resource: baseUrl,
      },
    })) as { client?: { client_id?: unknown; client_secret?: unknown } };
    oauthClientId = String(clientPayload.client?.client_id ?? '');
    oauthClientSecret = String(clientPayload.client?.client_secret ?? '');
    if (!oauthClientId || !oauthClientSecret) throw new Error('phase0c_totp_load_client_invalid');
    const clientSettings = (await phase0cAdminJson({
      baseUrl,
      path: `/api/admin/clients/${encodeURIComponent(oauthClientId)}/settings`,
      token: adminToken,
      tenantId,
    })) as { version?: unknown };
    if (typeof clientSettings.version !== 'string' || !clientSettings.version) {
      throw new Error('phase0c_totp_load_client_settings_invalid');
    }
    await phase0cAdminJson({
      baseUrl,
      path: `/api/admin/clients/${encodeURIComponent(oauthClientId)}/settings`,
      method: 'PATCH',
      token: adminToken,
      tenantId,
      body: { ifMatch: clientSettings.version, set: { 'client.sso_enabled': true } },
    });
    await phase0cAdminJson({
      baseUrl,
      path: '/api/admin/client-trust-policies',
      method: 'PUT',
      token: adminToken,
      tenantId,
      body: {
        target_type: 'oidc_client',
        target_id: oauthClientId,
        display_name: `${clientName} trust policy`,
        description: 'Disposable production TOTP Phase 0c no-consent policy.',
        first_party: true,
        trusted: true,
        skip_authorization_consent: true,
        is_active: true,
      },
    });

    executionStage = 'rate_limit_setup';
    reportStage(executionStage);
    previousRateLimitOverride = parsePhase0cRateLimitOverride(
      await phase0cAdminJson({
        baseUrl,
        path: '/api/admin/settings/rate-limits/profile-override',
        token: adminToken,
        tenantId,
      })
    );
    rateLimitOverrideMutated = true;
    await phase0cAdminJson({
      baseUrl,
      path: '/api/admin/settings/rate-limits/profile-override',
      method: 'PUT',
      token: adminToken,
      tenantId,
      body: { profile: 'loadTest', expires_in: RATE_LIMIT_OVERRIDE_TTL_SECONDS },
    });
    await waitForPhase0cRateLimitProfile({ baseUrl, clientId: oauthClientId, profile: 'loadTest' });

    executionStage = 'fixture_setup';
    reportStage(executionStage);
    users = await mapConcurrent(
      plannedEmails,
      policy.provisioningConcurrency,
      async (email): Promise<TotpLoadUser> => {
        startedEmails.push(email);
        const user = await createPhase0cTotpUser({ baseUrl, tenantId, email });
        if (user.profile.period !== 30 || user.profile.window < 1) {
          throw new Error('phase0c_totp_load_profile_not_replay_safe');
        }
        const created = { email, ...user };
        createdUsers.push(created);
        return created;
      }
    );

    executionStage = 'measurement_setup';
    reportStage(executionStage);
    const measurementToken = await requestAdminMachineAccessToken({
      apiBaseUrl: baseUrl,
      keysDir: tempDir,
      tenantId,
      clientId: machineClientId,
      scopes: MACHINE_PERMISSIONS,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!hasExactPhase0cScope(measurementToken.scope, MACHINE_PERMISSIONS)) {
      throw new Error('phase0c_totp_load_machine_token_scope_invalid');
    }
    adminToken = measurementToken.accessToken;
    await phase0cAdminJson({
      baseUrl,
      path: '/api/admin/settings/rate-limits/profile-override',
      method: 'PUT',
      token: adminToken,
      tenantId,
      body: { profile: 'loadTest', expires_in: RATE_LIMIT_OVERRIDE_TTL_SECONDS },
    });
    await waitForPhase0cRateLimitProfile({ baseUrl, clientId: oauthClientId, profile: 'loadTest' });

    const login = (user: TotpLoadUser) =>
      runPhase0cTotpFullLogin({
        baseUrl,
        tenantId,
        email: user.email,
        secret: user.secret,
        profile: user.profile,
        clientId: oauthClientId,
        clientSecret: oauthClientSecret,
        redirectUri,
        diagnosticSessionId: runId,
      });

    executionStage = 'cold_samples';
    reportStage(executionStage);
    const coldSamples = [];
    for (let index = 0; index < 3; index += 1) {
      const cold = await login(users[index]);
      coldSamples.push({
        latencyMs: cold.latencyMs.fullFlow,
        servedByRegion: 'unknown' as const,
        servedByPrimary: true as const,
      });
    }
    let nextUserIndex = 3;
    executionStage = 'warmup';
    reportStage(executionStage);
    await runPhase0cTotpArrivalWindow({
      ratePerSecond: policy.ratePerSecond,
      durationSeconds: policy.warmupSeconds,
      maximumConcurrency: policy.maximumConcurrency,
      users,
      startingUserIndex: nextUserIndex,
      operation: login,
    });
    nextUserIndex += policy.ratePerSecond * policy.warmupSeconds;
    executionStage = 'measurement';
    reportStage(executionStage);
    const measurement = await runPhase0cTotpArrivalWindow({
      ratePerSecond: policy.ratePerSecond,
      durationSeconds: policy.measurementSeconds,
      maximumConcurrency: policy.maximumConcurrency,
      users,
      startingUserIndex: nextUserIndex,
      operation: login,
    });
    scenarioResult = {
      warmup: { durationSeconds: policy.warmupSeconds, excludedFromMeasurement: true },
      measurement: {
        durationSeconds: policy.measurementSeconds,
        ratePerSecond: policy.ratePerSecond,
        successCount: measurement.successCount,
        failureCount: measurement.failureCount,
        droppedIterations: measurement.droppedIterations,
        p50Ms: percentile(measurement.latenciesMs.fullFlow, 0.5),
        p95Ms: percentile(measurement.latenciesMs.fullFlow, 0.95),
        p99Ms: percentile(measurement.latenciesMs.fullFlow, 0.99),
      },
      latencyMs: Object.fromEntries(
        TOTP_LATENCY_SEGMENTS.map((segment) => [
          segment,
          latencyPercentiles(measurement.latenciesMs[segment]),
        ])
      ) as Record<TotpLatencySegment, LatencyPercentiles>,
      diagnosticTimingMs: diagnosticTimingPercentiles(measurement.diagnosticTimingMs),
      errors: measurement.errors,
      coldSamples,
    };
  } catch (error) {
    executionError =
      safePhase0cTotpLoadExecutionError(error) === 'phase0c_totp_execution_failed'
        ? new Error(`phase0c_totp_load_stage_${executionStage}_failed`)
        : error;
    process.stderr.write(
      `Phase 0c production TOTP load failure: ${safePhase0cTotpLoadExecutionError(executionError)}\n`
    );
  } finally {
    executionStage = 'cleanup';
    reportStage(executionStage);
    if (machinePrincipalCreated) {
      try {
        const refreshed = await requestAdminMachineAccessToken({
          apiBaseUrl: baseUrl,
          keysDir: tempDir,
          tenantId,
          clientId: machineClientId,
          scopes: MACHINE_PERMISSIONS,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (!hasExactPhase0cScope(refreshed.scope, MACHINE_PERMISSIONS)) {
          throw new Error('phase0c_totp_load_machine_token_scope_invalid');
        }
        adminToken = refreshed.accessToken;
      } catch {
        cleanupErrors.push('machine_token_refresh_failed');
      }
    }
    if (adminToken) {
      if (rateLimitOverrideMutated && previousRateLimitOverride !== undefined) {
        try {
          await phase0cAdminJson({
            baseUrl,
            path: '/api/admin/settings/rate-limits/profile-override',
            method: previousRateLimitOverride === null ? 'DELETE' : 'PUT',
            token: adminToken,
            tenantId,
            ...(previousRateLimitOverride === null
              ? {}
              : { body: { profile: previousRateLimitOverride } }),
          });
          await waitForPhase0cRateLimitProfile({
            baseUrl,
            clientId: oauthClientId,
            profile: previousRateLimitOverride,
          });
        } catch {
          cleanupErrors.push('rate_limit_override_cleanup_failed');
        }
      }
      const cleanupConcurrency = Math.min(16, Math.max(1, startedEmails.length));
      await mapConcurrent(createdUsers, cleanupConcurrency, async (user) => {
        try {
          await phase0cAdminJson({
            baseUrl,
            path: `/api/admin/users/${encodeURIComponent(user.userId)}`,
            method: 'DELETE',
            token: adminToken,
            tenantId,
          });
          deletedEmails.add(user.email);
        } catch {
          // The exact-email reconciliation below is the authoritative response-loss cleanup pass.
        }
      });
      const unresolvedEmails = startedEmails.filter((email) => !deletedEmails.has(email));
      await mapConcurrent(unresolvedEmails, cleanupConcurrency, async (email) => {
        let reconciled: string | null = null;
        try {
          reconciled = await findPhase0cUserIdByExactEmail({
            baseUrl,
            token: adminToken,
            tenantId,
            email,
          });
        } catch {
          // The bounded absence check below retries transient Admin reads.
        }
        if (reconciled) {
          try {
            await phase0cAdminJson({
              baseUrl,
              path: `/api/admin/users/${encodeURIComponent(reconciled)}`,
              method: 'DELETE',
              token: adminToken,
              tenantId,
            });
          } catch {
            // A lost delete response is resolved by the authoritative absence check below.
          }
        }
        try {
          await waitForPhase0cTotpUserAbsent({ baseUrl, token: adminToken, tenantId, email });
        } catch {
          cleanupErrors.push('user_reconciliation_failed');
        }
      });
      let clientIds = oauthClientId ? [oauthClientId] : [];
      try {
        clientIds = [
          ...new Set([
            ...clientIds,
            ...(await findPhase0cClientIdsByExactName({
              baseUrl,
              token: adminToken,
              tenantId,
              clientName,
            })),
          ]),
        ];
      } catch {
        cleanupErrors.push('client_reconciliation_failed');
      }
      for (const clientId of clientIds) {
        try {
          await phase0cAdminJson({
            baseUrl,
            path: `/api/admin/clients/${encodeURIComponent(clientId)}`,
            method: 'DELETE',
            token: adminToken,
            tenantId,
          });
        } catch {
          cleanupErrors.push('client_cleanup_failed');
        }
      }
      if (settingsMutated && originalSettings) {
        try {
          const current = strictPhase0cTotpCategorySettings(
            await phase0cAdminJson({
              baseUrl,
              path: `/api/admin/tenants/${encodeURIComponent(tenantId)}/settings/authentication-methods`,
              token: adminToken,
              tenantId,
            })
          );
          await phase0cAdminJson({
            baseUrl,
            path: `/api/admin/tenants/${encodeURIComponent(tenantId)}/settings/authentication-methods`,
            method: 'PATCH',
            token: adminToken,
            tenantId,
            body: buildTotpSettingsRestorePatch(originalSettings, current.version),
          });
          await waitForRestoredPhase0cTotpSettings({
            baseUrl,
            tenantId,
            token: adminToken,
            original: originalSettings,
          });
        } catch {
          cleanupErrors.push('settings_cleanup_failed');
        }
      }
    }
    if (machinePrincipalCreated) {
      try {
        await cleanupPhase0cMachinePrincipal({
          adminDatabaseName,
          clientId: machineClientId,
          principalId,
          principalType: 'automation',
        });
      } catch {
        cleanupErrors.push('machine_principal_cleanup_failed');
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  }

  if (cleanupErrors.length > 0) {
    const execution = executionError ? `:${safePhase0cTotpLoadExecutionError(executionError)}` : '';
    throw new Error(
      `phase0c_totp_load_cleanup_incomplete:${[...new Set(cleanupErrors)].join(',')}${execution}`
    );
  }
  if (executionError) throw executionError;
  if (!scenarioResult) throw new Error('phase0c_totp_load_evidence_missing');

  const evidence: Phase0cTotpLoadEvidence = {
    schemaVersion: 2,
    runId,
    tenantId,
    scenario: 'production_totp_full_login_load',
    profile: options.profile,
    authenticationBypass: false,
    testInbox: false,
    readReplication: 'disabled',
    userPool: { count: policy.userCount, sameTimeStepReuse: false },
    scenarioResult,
    cleanup: {
      users: 'absent',
      client: 'deleted',
      settings: 'restored',
      machinePrincipal: 'deleted',
    },
  };
  const sensitiveValues = [
    adminToken,
    oauthClientSecret,
    ...users.map((user) => user.secret),
    ...startedEmails,
    ...plannedEmails,
  ];
  const validatedEvidence = validatePhase0cTotpLoadEvidence({
    evidence,
    runId,
    tenantId,
    forbiddenValues: sensitiveValues,
  });

  // Drop all live secret/identifier references before the validated evidence crosses the file boundary.
  adminToken = '';
  oauthClientSecret = '';
  sensitiveValues.fill('');
  startedEmails.fill('');
  deletedEmails.clear();
  for (const user of users) {
    user.email = '';
    user.secret = '';
  }
  for (const user of createdUsers) {
    user.email = '';
    user.secret = '';
  }
  users = [];

  await writeFile(options.resultPath, `${JSON.stringify(validatedEvidence, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(options.resultPath, 0o600);
  process.stdout.write(
    `Phase 0c production TOTP ${options.profile} evidence: ${options.resultPath}\n`
  );
}

export function isPhase0cTotpLoadEntrypoint(
  argv1: string | undefined,
  repositoryRoot = REPO_ROOT
): boolean {
  return (
    argv1 !== undefined &&
    resolve(argv1) === resolve(repositoryRoot, 'scripts/control-plane/phase0c-totp-load-live.ts')
  );
}

if (isPhase0cTotpLoadEntrypoint(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${safePhase0cTotpLoadExecutionError(error)}\n`);
    process.exitCode = 1;
  }
}
