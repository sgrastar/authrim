#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import type { AuthrimConfig } from '../../packages/setup/src/core/config.js';
import {
  buildSetupMachineAccessBootstrapSql,
  buildSetupMachineAccessCleanupSql,
  ensureSetupMachineKeyFiles,
  loadSetupMachinePublicJwk,
  requestAdminMachineAccessToken,
} from '../../packages/setup/src/core/admin-machine-access.js';
import { executeD1Command, queryD1Rows } from '../../packages/setup/src/core/cloudflare.js';
import { resolvePhase0cTenantApiBaseUrl } from './phase0c-live-url.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_CONFIG_PATH = resolve(REPO_ROOT, '.authrim/test/config.json');
const TEST_LOCK_PATH = resolve(REPO_ROOT, '.authrim/test/lock.json');
const K6_SCRIPT = resolve(
  REPO_ROOT,
  'load-testing/scripts/benchmarks/test-mail-otp-full-login-benchmark.js'
);
const SAMPLE_USER_COUNT = 32;
const CONTENTION_USER_COUNT = 32;
const UNIQUE_LOAD_USER_COUNT = 1000;
const SEED_CONCURRENCY = 4;
const SEED_ATTEMPTS = 5;
const SEED_PROGRESS_INTERVAL_MS = 5_000;
const CLEANUP_CONCURRENCY = 4;
const MAX_INTERRUPTED_CLEANUP_USERS = 500;
const MAX_RESPONSE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const RATE_LIMIT_OVERRIDE_TTL_SECONDS = 20 * 60;
const RATE_LIMIT_PROPAGATION_TIMEOUT_MS = 6 * 60 * 1000;
const RUN_ID_PATTERN = /^phase0c-mail-[0-9]{14}-[a-f0-9]{6}$/u;
export const PHASE0C_MACHINE_PRINCIPAL_TYPE = 'automation' as const;

export type Phase0cMailOtpLiveOptions = {
  environment: 'test';
  confirmTestData: true;
} & (
  | { mode: 'sample'; resultPath: string }
  | { mode: 'pre_gate'; resultPath: string }
  | { mode: 'smoke'; resultPath: string }
  | { mode: 'contention'; resultPath: string }
  | { mode: 'load'; resultPath: string }
  | { mode: 'cleanup_interrupted'; resultPath?: never; cleanupRunId?: string }
);

interface LiveConfig {
  environment: { prefix: string };
  tenant: { name: string };
  urls: { api: { custom: string } };
}

interface LiveLock {
  d1: Record<string, { name?: string } | undefined> & { DB_ADMIN?: { name?: string } };
}

interface AdminClient {
  client_id?: unknown;
  client_secret?: unknown;
  client_name?: unknown;
}

interface AdminUser {
  id?: unknown;
  email?: unknown;
}

export interface Phase0cVerifiedRuntimeProfile {
  storageProfile: 'builtin:storage:tenant-d1';
  transientAuthMirrorMode: 'session-do-no-cold-mirror';
}

interface MailOtpEvidence {
  runId?: unknown;
  tenantId?: unknown;
  phase0c_sample?: {
    warmup?: {
      durationSeconds?: unknown;
      ratePerSecond?: unknown;
      excludedFromMeasurement?: unknown;
    };
    measurement?: {
      durationSeconds?: unknown;
      ratePerSecond?: unknown;
      successCount?: unknown;
      failureCount?: unknown;
      droppedIterations?: unknown;
      p95Ms?: unknown;
    };
    errors?: {
      rateLimited?: unknown;
      routing5xx?: unknown;
      timeouts?: unknown;
      d1Overloaded?: unknown;
    };
  };
  phase0c_pre_gate?: {
    warmup?: {
      durationSeconds?: unknown;
      ratePerSecond?: unknown;
      excludedFromMeasurement?: unknown;
    };
    measurement?: {
      durationSeconds?: unknown;
      ratePerSecond?: unknown;
      successCount?: unknown;
      failureCount?: unknown;
      droppedIterations?: unknown;
      p95Ms?: unknown;
    };
    errors?: {
      rateLimited?: unknown;
      routing5xx?: unknown;
      timeouts?: unknown;
      d1Overloaded?: unknown;
    };
  };
  metrics?: {
    iterations?: unknown;
    flow_success_rate?: unknown;
    errors?: {
      rate_limit?: unknown;
      server?: unknown;
      timeout?: unknown;
      d1_overloaded?: unknown;
    };
  };
}

export interface Phase0cStepFailure {
  step: string;
  status: number;
  code: string;
  count: number;
  firstTimestampMs: number;
  lastTimestampMs: number;
}

export interface Phase0cSeedProgress {
  completed: number;
  total: number;
  retries: number;
  recovered: number;
  elapsedMs: number;
  status: 'running' | 'complete' | 'aborted';
}

export interface Phase0cCleanupProgress {
  completed: number;
  total: number;
  errors: number;
  elapsedMs: number;
  status: 'running' | 'complete';
}

function formatDuration(seconds: number): string {
  const bounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(bounded / 60);
  const remainingSeconds = bounded % 60;
  return minutes > 0 ? `${minutes}m${String(remainingSeconds).padStart(2, '0')}s` : `${bounded}s`;
}

export function formatPhase0cSeedProgress(input: Phase0cSeedProgress): string {
  const percentage = input.total > 0 ? (input.completed / input.total) * 100 : 100;
  const elapsedSeconds = input.elapsedMs / 1_000;
  const rate = elapsedSeconds > 0 ? input.completed / elapsedSeconds : 0;
  const eta = rate > 0 ? formatDuration((input.total - input.completed) / rate) : '--';
  return (
    `[seed] ${input.completed}/${input.total} (${percentage.toFixed(1)}%)` +
    ` | status=${input.status} | retries=${input.retries} | recovered=${input.recovered}` +
    ` | rate=${rate.toFixed(1)} users/s | elapsed=${formatDuration(elapsedSeconds)} | ETA=${eta}`
  );
}

export function formatPhase0cCleanupProgress(input: Phase0cCleanupProgress): string {
  const percentage = input.total > 0 ? (input.completed / input.total) * 100 : 100;
  const elapsedSeconds = input.elapsedMs / 1_000;
  const rate = elapsedSeconds > 0 ? input.completed / elapsedSeconds : 0;
  const eta = rate > 0 ? formatDuration((input.total - input.completed) / rate) : '--';
  return (
    `[cleanup] ${input.completed}/${input.total} (${percentage.toFixed(1)}%)` +
    ` | status=${input.status} | errors=${input.errors}` +
    ` | rate=${rate.toFixed(1)} users/s | elapsed=${formatDuration(elapsedSeconds)} | ETA=${eta}`
  );
}

function createPhase0cSeedProgressReporter(total: number): {
  recordRetry(): void;
  recordRecovered(): void;
  recordCompleted(): void;
  finish(status: 'complete' | 'aborted'): void;
} {
  const startedAt = Date.now();
  const milestone = Math.max(1, Math.ceil(total / 20));
  let completed = 0;
  let retries = 0;
  let recovered = 0;
  let finished = false;
  const emit = (status: Phase0cSeedProgress['status']) => {
    console.log(
      formatPhase0cSeedProgress({
        completed,
        total,
        retries,
        recovered,
        elapsedMs: Date.now() - startedAt,
        status,
      })
    );
  };
  console.log(`[seed] Starting ${total} users with concurrency=${SEED_CONCURRENCY}`);
  emit('running');
  const heartbeat = setInterval(() => emit('running'), SEED_PROGRESS_INTERVAL_MS);
  heartbeat.unref();
  return {
    recordRetry: () => {
      retries += 1;
    },
    recordRecovered: () => {
      recovered += 1;
    },
    recordCompleted: () => {
      completed += 1;
      if (completed % milestone === 0 || completed === total) emit('running');
    },
    finish: (status) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      emit(status);
    },
  };
}

function createPhase0cCleanupProgressReporter(total: number): {
  recordCompleted(failed: boolean): void;
  finish(): void;
} {
  const startedAt = Date.now();
  const milestone = Math.max(1, Math.ceil(total / 20));
  let completed = 0;
  let errors = 0;
  let finished = false;
  const emit = (status: Phase0cCleanupProgress['status']) => {
    console.log(
      formatPhase0cCleanupProgress({
        completed,
        total,
        errors,
        elapsedMs: Date.now() - startedAt,
        status,
      })
    );
  };
  console.log(`[cleanup] Starting ${total} users with concurrency=${CLEANUP_CONCURRENCY}`);
  emit('running');
  const heartbeat = setInterval(() => emit('running'), SEED_PROGRESS_INTERVAL_MS);
  heartbeat.unref();
  return {
    recordCompleted: (failed) => {
      completed += 1;
      if (failed) errors += 1;
      if (completed % milestone === 0 || completed === total) emit('running');
    },
    finish: () => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      emit('complete');
    },
  };
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(code);
  return value.trim();
}

function safeResultPath(value: string): string {
  const path = resolve(value);
  if ((!path.startsWith('/private/tmp/') && !path.startsWith('/tmp/')) || !path.endsWith('.json')) {
    throw new Error('phase0c_mail_result_must_use_temporary_json_path');
  }
  return path;
}

export function parsePhase0cMailOtpLiveArgs(argv: string[]): Phase0cMailOtpLiveOptions {
  let environment: string | undefined;
  let resultPath: string | undefined;
  let confirmTestData = false;
  let cleanupInterrupted = false;
  let cleanupRunId: string | undefined;
  let smoke = false;
  let sample = false;
  let preGate = false;
  let contention = false;
  let load = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--env') environment = argv[++index];
    else if (argument === '--result') resultPath = argv[++index];
    else if (argument === '--confirm-test-data') confirmTestData = true;
    else if (argument === '--cleanup-interrupted') cleanupInterrupted = true;
    else if (argument === '--cleanup-run-id') {
      cleanupRunId = argv[++index];
      if (!cleanupRunId) throw new Error('phase0c_mail_cleanup_run_id_missing');
    } else if (argument === '--smoke') smoke = true;
    else if (argument === '--sample') sample = true;
    else if (argument === '--pre-gate') preGate = true;
    else if (argument === '--contention') contention = true;
    else if (argument === '--load') load = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (environment !== 'test') throw new Error('phase0c_mail_test_environment_required');
  if (!confirmTestData) throw new Error('phase0c_mail_test_data_confirmation_required');
  if (
    (cleanupInterrupted && (smoke || sample || preGate || contention || load)) ||
    Number(smoke) + Number(sample) + Number(preGate) + Number(contention) + Number(load) > 1
  ) {
    throw new Error('phase0c_mail_mode_conflict');
  }
  if (cleanupInterrupted && resultPath) {
    throw new Error('phase0c_mail_cleanup_result_not_allowed');
  }
  if (cleanupRunId !== undefined && !cleanupInterrupted) {
    throw new Error('phase0c_mail_cleanup_run_id_requires_cleanup_mode');
  }
  if (cleanupRunId !== undefined && !RUN_ID_PATTERN.test(cleanupRunId)) {
    throw new Error('phase0c_mail_cleanup_run_id_invalid');
  }
  if (cleanupInterrupted) {
    return {
      environment: 'test',
      confirmTestData: true,
      mode: 'cleanup_interrupted',
      ...(cleanupRunId ? { cleanupRunId } : {}),
    };
  }
  if (!resultPath) throw new Error('phase0c_mail_result_path_required');
  return {
    environment: 'test',
    confirmTestData: true,
    mode: smoke
      ? 'smoke'
      : sample
        ? 'sample'
        : preGate
          ? 'pre_gate'
          : contention
            ? 'contention'
            : load
              ? 'load'
              : 'pre_gate',
    resultPath: safeResultPath(resultPath),
  };
}

export function createPhase0cMailRunId(now = new Date(), nonce = randomUUID()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:.TZ]/gu, '')
    .slice(0, 14);
  const suffix = nonce
    .replace(/[^a-f0-9]/giu, '')
    .slice(0, 6)
    .toLowerCase();
  return `phase0c-mail-${timestamp}-${suffix}`;
}

export function resolvePhase0cMailRunId(
  options: Phase0cMailOtpLiveOptions,
  generatedRunId = createPhase0cMailRunId()
): string {
  return options.mode === 'cleanup_interrupted' && options.cleanupRunId
    ? options.cleanupRunId
    : generatedRunId;
}

export function isRunScopedPhase0cCleanup(options: Phase0cMailOtpLiveOptions): boolean {
  return options.mode === 'cleanup_interrupted' && options.cleanupRunId !== undefined;
}

export function buildPhase0cK6Environment(input: {
  baseUrl: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  userListPath: string;
  resultPath: string;
  runId: string;
  runtimeProfile: Phase0cVerifiedRuntimeProfile;
  preset?:
    | 'phase0c-sample'
    | 'phase0c-pre-gate'
    | 'phase0c-smoke'
    | 'phase0c-contention'
    | 'phase0c-load';
  parentEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const parent = input.parentEnv ?? process.env;
  return {
    PATH: parent.PATH,
    HOME: parent.HOME,
    TMPDIR: parent.TMPDIR,
    SSL_CERT_FILE: parent.SSL_CERT_FILE,
    SSL_CERT_DIR: parent.SSL_CERT_DIR,
    PRESET: input.preset ?? 'phase0c-pre-gate',
    BASE_URL: input.baseUrl,
    TENANT_ID: input.tenantId,
    CLIENT_ID: input.clientId,
    CLIENT_SECRET: input.clientSecret,
    ADMIN_MACHINE_ACCESS_TOKEN: input.accessToken,
    USER_LIST_PATH: input.userListPath,
    PHASE0C_RESULT: input.resultPath,
    PHASE0C_RUN_ID: input.runId,
    STORAGE_PROFILE: input.runtimeProfile.storageProfile,
    TRANSIENT_AUTH_MIRROR_MODE: input.runtimeProfile.transientAuthMirrorMode,
  };
}

export function validatePhase0cRuntimeProfile(payload: unknown): Phase0cVerifiedRuntimeProfile {
  const runtimeProfile = (payload as { runtime_profile?: unknown } | null)?.runtime_profile as
    | { storage_profile_id?: unknown; session_cold_persistence?: unknown }
    | undefined;
  if (runtimeProfile?.storage_profile_id !== 'builtin:storage:tenant-d1') {
    throw new Error('phase0c_mail_storage_profile_mismatch');
  }
  if (runtimeProfile.session_cold_persistence !== 'disabled') {
    throw new Error('phase0c_mail_session_cold_persistence_must_be_disabled');
  }
  return {
    storageProfile: 'builtin:storage:tenant-d1',
    transientAuthMirrorMode: 'session-do-no-cold-mirror',
  };
}

export function validatePhase0cMailSmokeEvidence(input: {
  evidence: unknown;
  runId: string;
  tenantId: string;
  forbiddenValues: readonly string[];
}): MailOtpEvidence {
  const evidence = input.evidence as MailOtpEvidence;
  const errors = evidence?.metrics?.errors;
  if (
    evidence?.runId !== input.runId ||
    evidence?.tenantId !== input.tenantId ||
    evidence?.metrics?.iterations !== 1 ||
    evidence?.metrics?.flow_success_rate !== 1 ||
    !errors ||
    errors.rate_limit !== 0 ||
    errors.server !== 0 ||
    errors.timeout !== 0 ||
    errors.d1_overloaded !== 0
  ) {
    throw new Error('phase0c_mail_smoke_evidence_invalid');
  }
  const serialized = JSON.stringify(evidence);
  if (
    input.forbiddenValues.some((value) => value.length >= 4 && serialized.includes(value)) ||
    /authorization|bearer|client_secret|access_token|otpSessionId|@test\.authrim\.internal/iu.test(
      serialized
    )
  ) {
    throw new Error('phase0c_mail_evidence_contains_sensitive_value');
  }
  return evidence;
}

export function validatePhase0cMailLoadEvidence(input: {
  evidence: unknown;
  runId: string;
  tenantId: string;
  forbiddenValues: readonly string[];
}): MailOtpEvidence {
  const evidence = input.evidence as MailOtpEvidence;
  if (
    evidence?.runId !== input.runId ||
    evidence?.tenantId !== input.tenantId ||
    typeof evidence?.metrics?.iterations !== 'number'
  ) {
    throw new Error('phase0c_mail_load_evidence_invalid');
  }
  const serialized = JSON.stringify(evidence);
  if (
    input.forbiddenValues.some((value) => value.length >= 4 && serialized.includes(value)) ||
    /authorization|bearer|client_secret|access_token|otpSessionId|@test\.authrim\.internal/iu.test(
      serialized
    )
  ) {
    throw new Error('phase0c_mail_evidence_contains_sensitive_value');
  }
  return evidence;
}

export function validatePhase0cMailSampleEvidence(input: {
  evidence: unknown;
  runId: string;
  tenantId: string;
  forbiddenValues: readonly string[];
}): MailOtpEvidence {
  const evidence = input.evidence as MailOtpEvidence;
  const warmup = evidence?.phase0c_sample?.warmup;
  const measurement = evidence?.phase0c_sample?.measurement;
  const errors = evidence?.phase0c_sample?.errors;
  if (
    evidence?.runId !== input.runId ||
    evidence?.tenantId !== input.tenantId ||
    warmup?.durationSeconds !== 15 ||
    warmup?.ratePerSecond !== 1 ||
    warmup?.excludedFromMeasurement !== true ||
    measurement?.durationSeconds !== 60 ||
    measurement?.ratePerSecond !== 1 ||
    typeof measurement?.successCount !== 'number' ||
    !Number.isSafeInteger(measurement.successCount) ||
    measurement.successCount < 60 ||
    measurement.successCount > 61 ||
    measurement?.failureCount !== 0 ||
    measurement?.droppedIterations !== 0 ||
    typeof measurement?.p95Ms !== 'number' ||
    !Number.isFinite(measurement.p95Ms) ||
    measurement.p95Ms <= 0 ||
    errors?.rateLimited !== 0 ||
    errors?.routing5xx !== 0 ||
    errors?.timeouts !== 0 ||
    errors?.d1Overloaded !== 0
  ) {
    throw new Error('phase0c_mail_sample_evidence_invalid');
  }
  const serialized = JSON.stringify(evidence);
  if (
    input.forbiddenValues.some((value) => value.length >= 4 && serialized.includes(value)) ||
    /authorization|bearer|client_secret|access_token|otpSessionId|@test\.authrim\.internal/iu.test(
      serialized
    )
  ) {
    throw new Error('phase0c_mail_evidence_contains_sensitive_value');
  }
  return evidence;
}

export function validatePhase0cMailPreGateEvidence(input: {
  evidence: unknown;
  runId: string;
  tenantId: string;
  forbiddenValues: readonly string[];
}): MailOtpEvidence {
  const evidence = input.evidence as MailOtpEvidence;
  const warmup = evidence?.phase0c_pre_gate?.warmup;
  const measurement = evidence?.phase0c_pre_gate?.measurement;
  const errors = evidence?.phase0c_pre_gate?.errors;
  if (
    evidence?.runId !== input.runId ||
    evidence?.tenantId !== input.tenantId ||
    warmup?.durationSeconds !== 15 ||
    warmup?.ratePerSecond !== 1 ||
    warmup?.excludedFromMeasurement !== true ||
    measurement?.durationSeconds !== 60 ||
    measurement?.ratePerSecond !== 2 ||
    typeof measurement?.successCount !== 'number' ||
    !Number.isSafeInteger(measurement.successCount) ||
    measurement.successCount < 120 ||
    measurement.successCount > 122 ||
    measurement?.failureCount !== 0 ||
    measurement?.droppedIterations !== 0 ||
    typeof measurement?.p95Ms !== 'number' ||
    !Number.isFinite(measurement.p95Ms) ||
    measurement.p95Ms <= 0 ||
    errors?.rateLimited !== 0 ||
    errors?.routing5xx !== 0 ||
    errors?.timeouts !== 0 ||
    errors?.d1Overloaded !== 0
  ) {
    throw new Error('phase0c_mail_pre_gate_evidence_invalid');
  }
  const serialized = JSON.stringify(evidence);
  if (
    input.forbiddenValues.some((value) => value.length >= 4 && serialized.includes(value)) ||
    /authorization|bearer|client_secret|access_token|otpSessionId|@test\.authrim\.internal/iu.test(
      serialized
    )
  ) {
    throw new Error('phase0c_mail_evidence_contains_sensitive_value');
  }
  return evidence;
}

export async function readPhase0cJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export function strictPhase0cLiveConfig(value: unknown): LiveConfig & AuthrimConfig {
  const config = value as Partial<LiveConfig>;
  const environment = requiredString(
    config.environment?.prefix,
    'phase0c_mail_environment_invalid'
  );
  const tenantId = requiredString(config.tenant?.name, 'phase0c_mail_tenant_invalid');
  const baseUrl = requiredString(config.urls?.api?.custom, 'phase0c_mail_base_url_invalid');
  if (environment !== 'test' || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(tenantId)) {
    throw new Error('phase0c_mail_config_invalid');
  }
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('phase0c_mail_base_url_invalid');
  }
  return value as LiveConfig & AuthrimConfig;
}

export function strictPhase0cAdminDatabaseName(value: unknown): string {
  const lock = value as Partial<LiveLock>;
  const name = requiredString(lock.d1?.DB_ADMIN?.name, 'phase0c_mail_admin_database_missing');
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(name)) {
    throw new Error('phase0c_mail_admin_database_invalid');
  }
  return name;
}

export function strictTenantUsersDatabaseNames(value: unknown): string[] {
  const lock = value as Partial<LiveLock>;
  if (!lock.d1 || typeof lock.d1 !== 'object') {
    throw new Error('phase0c_mail_users_databases_missing');
  }
  const names = Object.entries(lock.d1)
    .filter(([bindingRef]) => /^TDB_USERS_[A-Z0-9_]+_CORE$/u.test(bindingRef))
    .flatMap(([, resource]) =>
      typeof resource?.name === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(resource.name)
        ? [resource.name]
        : []
    );
  if (names.length === 0 || new Set(names).size !== names.length) {
    throw new Error('phase0c_mail_users_databases_invalid');
  }
  return names.sort();
}

export function strictTenantPiiDatabaseNames(value: unknown): string[] {
  const lock = value as Partial<LiveLock>;
  if (!lock.d1 || typeof lock.d1 !== 'object') {
    throw new Error('phase0c_mail_pii_databases_missing');
  }
  const names = Object.entries(lock.d1)
    .filter(([bindingRef]) => /^TDB_PII_[A-Z0-9_]+_PII$/u.test(bindingRef))
    .flatMap(([, resource]) =>
      typeof resource?.name === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(resource.name)
        ? [resource.name]
        : []
    );
  if (names.length === 0 || new Set(names).size !== names.length) {
    throw new Error('phase0c_mail_pii_databases_invalid');
  }
  return names.sort();
}

async function interruptedDeletionUserIds(input: {
  databaseNames: readonly string[];
  tenantId: string;
}): Promise<string[]> {
  const rows = (
    await Promise.all(
      input.databaseNames.map((databaseName) =>
        queryD1Rows<{ legacy_user_id?: unknown }>(
          databaseName,
          `SELECT legacy_user_id FROM identity_accounts
            WHERE tenant_id = '${input.tenantId}'
              AND lifecycle_state IN ('deleting', 'deleted')
              AND directory_publication_state = 'disabled'
              AND (
                NOT EXISTS (
                  SELECT 1 FROM account_routing_outbox AS deletion_outbox
                   WHERE deletion_outbox.tenant_id = identity_accounts.tenant_id
                     AND deletion_outbox.account_id = identity_accounts.id
                     AND deletion_outbox.event_kind = 'account_deleted'
                ) OR EXISTS (
                  SELECT 1 FROM account_routing_outbox AS deletion_outbox
                   WHERE deletion_outbox.tenant_id = identity_accounts.tenant_id
                     AND deletion_outbox.account_id = identity_accounts.id
                     AND deletion_outbox.event_kind = 'account_deleted'
                     AND deletion_outbox.status <> 'succeeded'
                )
              )
            ORDER BY legacy_user_id
            LIMIT ${MAX_INTERRUPTED_CLEANUP_USERS + 1}`
        )
      )
    )
  ).flat();
  const ids = [
    ...new Set(
      rows.map((row) => requiredString(row.legacy_user_id, 'phase0c_mail_cleanup_user_id_invalid'))
    ),
  ];
  if (ids.length > MAX_INTERRUPTED_CLEANUP_USERS) {
    throw new Error('phase0c_mail_cleanup_user_limit_exceeded');
  }
  return ids;
}

async function abandonedPhase0cUserIds(input: {
  databaseNames: readonly string[];
  tenantId: string;
  runId: string;
}): Promise<string[]> {
  const rows = (
    await Promise.all(
      input.databaseNames.map((databaseName) =>
        queryD1Rows<{ owner_id?: unknown }>(
          databaseName,
          `SELECT DISTINCT owner_id FROM identity_sensitive_values
            WHERE tenant_id = '${input.tenantId}'
              AND owner_type = 'runtime_user'
              AND value_key = 'email'
              AND instr(value_json, '"${input.runId}-') = 1
              AND substr(value_json, -length('@test.authrim.internal"')) = '@test.authrim.internal"'
            ORDER BY owner_id
            LIMIT ${MAX_INTERRUPTED_CLEANUP_USERS + 1}`
        )
      )
    )
  ).flat();
  const ids = [
    ...new Set(
      rows.map((row) => requiredString(row.owner_id, 'phase0c_mail_cleanup_user_id_invalid'))
    ),
  ];
  if (ids.length > MAX_INTERRUPTED_CLEANUP_USERS) {
    throw new Error('phase0c_mail_cleanup_user_limit_exceeded');
  }
  return ids;
}

async function readResponseJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('phase0c_mail_admin_response_too_large');
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('phase0c_mail_admin_response_too_large');
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

export function safeAdminErrorDetails(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'unspecified';
  const value = payload as Record<string, unknown>;
  return ['error', 'error_description', 'message', 'details']
    .map((key) => (typeof value[key] === 'string' ? value[key] : ''))
    .filter(Boolean)
    .join(':')
    .replace(/[\r\n\t]/gu, ' ')
    .replace(/[^\s@]+@[^\s@]+/gu, '[redacted-email]')
    .slice(0, 500);
}

export function safePhase0cExecutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.length > 0 &&
    message.length <= 512 &&
    /^[a-zA-Z0-9_:/?.-]+$/u.test(message) &&
    !/(?:authorization|bearer|token|secret|password|@)/iu.test(message)
  ) {
    return message;
  }
  return 'phase0c_mail_execution_failed';
}

export function safePhase0cCleanupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^phase0c_mail_admin_request_failed:DELETE:[^:]+:(\d{3}):([a-z0-9_-]+)/u.exec(
    message
  );
  return match ? `admin_delete_failed:${match[1]}:${match[2]}` : safePhase0cExecutionError(error);
}

export async function phase0cAdminJson(input: {
  baseUrl: string;
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  token: string;
  tenantId: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(input.path, input.baseUrl), {
      method: input.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.token}`,
        'X-Tenant-Id': input.tenantId,
        ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    });
    const payload = await readResponseJson(response).catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `phase0c_mail_admin_request_failed:${input.method ?? 'GET'}:${input.path}:${response.status}:${safeAdminErrorDetails(payload)}`
      );
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

const RATE_LIMIT_PROFILE_LIMITS = {
  strict: { authorize: 10, token: 10 },
  moderate: { authorize: 60, token: 60 },
  lenient: { authorize: 300, token: 300 },
  publicRead: { authorize: 600, token: 600 },
  loginStart: { authorize: 300, token: 300 },
  sendChallenge: { authorize: 30, token: 30 },
  loadTest: { authorize: 10_000, token: 10_000 },
} as const;

type RateLimitProfileName = keyof typeof RATE_LIMIT_PROFILE_LIMITS;

function rateLimitHeader(response: Response): number | null {
  const value = response.headers.get('x-ratelimit-limit');
  if (!value || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function probeRateLimitProfile(input: {
  baseUrl: string;
  clientId: string;
}): Promise<{ authorize: number | null; token: number | null }> {
  const nonce = randomUUID();
  const [authorize, token] = await Promise.all([
    fetch(
      `${input.baseUrl}/authorize?response_type=code&client_id=${encodeURIComponent(
        input.clientId
      )}&scope=openid&phase0c_probe=${encodeURIComponent(nonce)}`,
      { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    ),
    fetch(`${input.baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&code=phase0c-probe-${encodeURIComponent(nonce)}`,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  ]);
  return { authorize: rateLimitHeader(authorize), token: rateLimitHeader(token) };
}

export async function waitForPhase0cRateLimitProfile(input: {
  baseUrl: string;
  clientId: string;
  profile: RateLimitProfileName | null;
}): Promise<void> {
  const expected =
    input.profile === null
      ? { authorize: RATE_LIMIT_PROFILE_LIMITS.moderate.authorize, token: 10 }
      : RATE_LIMIT_PROFILE_LIMITS[input.profile];
  const deadline = Date.now() + RATE_LIMIT_PROPAGATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const observed = await probeRateLimitProfile(input).catch(() => ({
      authorize: null,
      token: null,
    }));
    if (observed.authorize === expected.authorize && observed.token === expected.token) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error('phase0c_mail_rate_limit_profile_propagation_timeout');
}

export function parsePhase0cRateLimitOverride(payload: unknown): RateLimitProfileName | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('phase0c_mail_rate_limit_override_invalid');
  }
  const value = (payload as { profile_override?: unknown }).profile_override;
  if (value === null) return null;
  if (typeof value === 'string' && value in RATE_LIMIT_PROFILE_LIMITS) {
    return value as RateLimitProfileName;
  }
  throw new Error('phase0c_mail_rate_limit_override_invalid');
}

async function createPhase0cUser(input: {
  baseUrl: string;
  token: string;
  tenantId: string;
  email: string;
  idempotencyKey: string;
}): Promise<string> {
  const payload = (await phase0cAdminJson({
    baseUrl: input.baseUrl,
    path: '/api/admin/users',
    method: 'POST',
    token: input.token,
    tenantId: input.tenantId,
    idempotencyKey: input.idempotencyKey,
    body: {
      email: input.email,
      preferred_username: input.email.split('@')[0],
      // Match the historical OTP benchmark seed contract. The load phase measures recurring
      // login work, not the one-time transition of a newly introduced email contact.
      email_verified: true,
      user_type: 'end_user',
    },
  })) as {
    user?: AdminUser;
    status?: unknown;
    state?: unknown;
    status_url?: unknown;
  };
  if (payload.user?.id) return requiredString(payload.user.id, 'phase0c_mail_seed_user_id_missing');
  if (payload.status !== 'pending') throw new Error('phase0c_mail_seed_user_response_invalid');

  const statusPath = requiredString(
    payload.status_url,
    'phase0c_mail_seed_user_status_url_missing'
  );
  if (!statusPath.startsWith('/api/admin/users/operations/')) {
    throw new Error('phase0c_mail_seed_user_status_url_invalid');
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    const status = (await phase0cAdminJson({
      baseUrl: input.baseUrl,
      path: statusPath,
      token: input.token,
      tenantId: input.tenantId,
    })) as { state?: unknown; user_id?: unknown };
    if (status.state === 'succeeded') {
      return requiredString(status.user_id, 'phase0c_mail_seed_user_id_missing');
    }
    if (status.state === 'failed' || status.state === 'blocked') {
      throw new Error(`phase0c_mail_seed_user_operation_${String(status.state)}`);
    }
  }
  throw new Error('phase0c_mail_seed_user_operation_timeout');
}

export async function findPhase0cClientIdsByExactName(input: {
  baseUrl: string;
  token: string;
  tenantId: string;
  clientName: string;
}): Promise<string[]> {
  const payload = (await phase0cAdminJson({
    ...input,
    path: '/api/admin/clients',
  })) as { clients?: AdminClient[] };
  if (!Array.isArray(payload.clients)) return [];
  return payload.clients.flatMap((client) =>
    client.client_name === input.clientName && typeof client.client_id === 'string'
      ? [client.client_id]
      : []
  );
}

export async function findPhase0cUserIdByExactEmail(input: {
  baseUrl: string;
  token: string;
  tenantId: string;
  email: string;
}): Promise<string | null> {
  const payload = (await phase0cAdminJson({
    ...input,
    path: `/api/admin/users?search=${encodeURIComponent(input.email)}`,
  })) as { users?: AdminUser[] };
  if (!Array.isArray(payload.users)) return null;
  const user = payload.users.find(
    (candidate) =>
      typeof candidate.email === 'string' &&
      candidate.email.toLowerCase() === input.email.toLowerCase()
  );
  return typeof user?.id === 'string' ? user.id : null;
}

export async function mapPhase0cBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('phase0c_bounded_concurrency_invalid');
  }
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (firstError === undefined && nextIndex < values.length) {
      const index = nextIndex++;
      try {
        output[index] = await operation(values[index], index);
      } catch (error) {
        firstError ??= error;
      }
    }
  });
  // Wait for every operation that was already admitted before surfacing the first error. This
  // prevents seed creation from continuing concurrently with the runner's cleanup phase.
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return output;
}

export function parsePhase0cStepFailure(line: string): Omit<Phase0cStepFailure, 'count'> | null {
  const match =
    /PHASE0C_STEP_FAILURE ts=(\d{13}) step=([a-z_]{1,40}) status=(\d{1,3}) code=([A-Za-z0-9_.:-]{1,80}) marker_end=1/u.exec(
      line
    );
  if (!match) return null;
  const timestampMs = Number(match[1]);
  const status = Number(match[3]);
  if (!Number.isSafeInteger(timestampMs) || !Number.isSafeInteger(status) || status > 599) {
    return null;
  }
  return {
    step: match[2],
    status,
    code: match[4],
    firstTimestampMs: timestampMs,
    lastTimestampMs: timestampMs,
  };
}

async function runK6(environment: NodeJS.ProcessEnv): Promise<{
  exitCode: number;
  stepFailures: Phase0cStepFailure[];
}> {
  return new Promise((resolveExit, reject) => {
    const child = spawn('k6', ['run', K6_SCRIPT], {
      cwd: REPO_ROOT,
      env: environment,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const failures = new Map<string, Phase0cStepFailure>();
    const collect = () => {
      let remainder = '';
      return (chunk: Buffer | null): void => {
        const input = remainder + (chunk?.toString('utf8') ?? '');
        const lines = input.split(/\r?\n/u);
        remainder = chunk ? (lines.pop() ?? '') : '';
        for (const line of lines) {
          const failure = parsePhase0cStepFailure(line);
          if (!failure) continue;
          const key = `${failure.step}\u0000${failure.status}\u0000${failure.code}`;
          const existing = failures.get(key);
          if (existing) {
            existing.count += 1;
            existing.firstTimestampMs = Math.min(
              existing.firstTimestampMs,
              failure.firstTimestampMs
            );
            existing.lastTimestampMs = Math.max(existing.lastTimestampMs, failure.lastTimestampMs);
          } else {
            failures.set(key, { ...failure, count: 1 });
          }
        }
      };
    };
    const stdoutCollector = collect();
    const stderrCollector = collect();
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      stdoutCollector(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrCollector(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`phase0c_mail_k6_signaled:${signal}`));
      else {
        stdoutCollector(null);
        stderrCollector(null);
        resolveExit({
          exitCode: code ?? 1,
          stepFailures: [...failures.values()].sort(
            (left, right) =>
              left.step.localeCompare(right.step) ||
              left.status - right.status ||
              left.code.localeCompare(right.code)
          ),
        });
      }
    });
  });
}

export function hasExactPhase0cScope(actual: string, expected: readonly string[]): boolean {
  const values = actual.split(/\s+/u).filter(Boolean);
  return values.length === expected.length && expected.every((scope) => values.includes(scope));
}

async function main(): Promise<void> {
  const options = parsePhase0cMailOtpLiveArgs(process.argv.slice(2));
  const config = strictPhase0cLiveConfig(await readPhase0cJson(TEST_CONFIG_PATH));
  const lock = await readPhase0cJson(TEST_LOCK_PATH);
  const adminDatabaseName = strictPhase0cAdminDatabaseName(lock);
  const usersDatabaseNames = strictTenantUsersDatabaseNames(lock);
  const piiDatabaseNames = strictTenantPiiDatabaseNames(lock);
  const tenantId = config.tenant.name;
  const baseUrl = resolvePhase0cTenantApiBaseUrl(config, options.environment);
  const runId = resolvePhase0cMailRunId(options);
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('phase0c_mail_run_id_invalid');

  const tempDir = await mkdtemp('/private/tmp/authrim-phase0c-mail-otp-');
  await chmod(tempDir, 0o700);
  const userListPath = resolve(tempDir, 'otp_user_list.txt');
  const principalId = `amp_${runId.replace(/-/gu, '_')}`;
  const clientId = `authrim-${runId}`;
  const principalType = PHASE0C_MACHINE_PRINCIPAL_TYPE;
  const permissions =
    options.mode === 'cleanup_interrupted'
      ? (['admin:users:*'] as const)
      : ([
          'admin:clients:*',
          'admin:users:*',
          'admin:security:write',
          'admin:settings:read',
          'admin:settings:write',
        ] as const);
  const clientName = `Phase 0c Mail OTP ${options.mode === 'smoke' ? 'Smoke ' : ''}${runId}`;
  const redirectUri = 'https://localhost:3000/callback';
  const userCount =
    options.mode === 'smoke'
      ? 1
      : options.mode === 'contention'
        ? CONTENTION_USER_COUNT
        : options.mode === 'load'
          ? UNIQUE_LOAD_USER_COUNT
          : SAMPLE_USER_COUNT;
  const emails = Array.from(
    { length: userCount },
    (_, index) => `${runId}-${String(index).padStart(3, '0')}@test.authrim.internal`
  );
  const createdUserIds: string[] = [];
  let adminToken = '';
  let oauthClientId = '';
  let oauthClientSecret = '';
  let principalMutationStarted = false;
  let previousRateLimitOverride: RateLimitProfileName | null | undefined;
  let rateLimitOverrideMutationStarted = false;
  let executionError: unknown = null;
  let runtimeProfile: Phase0cVerifiedRuntimeProfile | null = null;
  const cleanupErrors: string[] = [];

  try {
    await ensureSetupMachineKeyFiles(tempDir, `${runId}-key`);
    const publicJwk = await loadSetupMachinePublicJwk(tempDir);
    const bootstrapSql = buildSetupMachineAccessBootstrapSql(config, publicJwk, {
      clientId,
      principalId,
      permissions,
      displayName: clientName,
      description: 'Ephemeral Phase 0c Mail OTP load-test principal.',
      principalType,
      tokenTtlSeconds: 15 * 60,
      createdByActorId: runId,
    });
    principalMutationStarted = true;
    await executeD1Command(adminDatabaseName, bootstrapSql);

    const token = await requestAdminMachineAccessToken({
      apiBaseUrl: baseUrl,
      keysDir: tempDir,
      tenantId,
      clientId,
      scopes: permissions,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (token.expiresIn < 600 || !hasExactPhase0cScope(token.scope, permissions)) {
      throw new Error('phase0c_mail_machine_token_scope_invalid');
    }
    adminToken = token.accessToken;

    if (options.mode === 'cleanup_interrupted') {
      createdUserIds.push(
        ...(isRunScopedPhase0cCleanup(options)
          ? []
          : await interruptedDeletionUserIds({ databaseNames: usersDatabaseNames, tenantId })),
        ...(isRunScopedPhase0cCleanup(options) && options.cleanupRunId
          ? await abandonedPhase0cUserIds({
              databaseNames: piiDatabaseNames,
              tenantId,
              runId: options.cleanupRunId,
            })
          : [])
      );
    } else {
      const clientPayload = (await phase0cAdminJson({
        baseUrl,
        path: '/api/admin/clients',
        method: 'POST',
        token: adminToken,
        tenantId,
        idempotencyKey: `${runId}-oauth-client`,
        body: {
          client_name: clientName,
          description: 'Disposable Phase 0c Mail OTP benchmark client.',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_basic',
          require_pkce: true,
          default_resource: baseUrl,
        },
      })) as { client?: AdminClient };
      oauthClientId = requiredString(
        clientPayload.client?.client_id,
        'phase0c_mail_client_id_missing'
      );
      oauthClientSecret = requiredString(
        clientPayload.client?.client_secret,
        'phase0c_mail_client_secret_missing'
      );
      const clientSettings = (await phase0cAdminJson({
        baseUrl,
        path: `/api/admin/clients/${encodeURIComponent(oauthClientId)}/settings`,
        token: adminToken,
        tenantId,
      })) as { version?: unknown };
      await phase0cAdminJson({
        baseUrl,
        path: `/api/admin/clients/${encodeURIComponent(oauthClientId)}/settings`,
        method: 'PATCH',
        token: adminToken,
        tenantId,
        body: {
          ifMatch: requiredString(
            clientSettings.version,
            'phase0c_mail_client_settings_version_missing'
          ),
          set: {
            'client.sso_enabled': true,
          },
        },
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
          description: 'Disposable Phase 0c benchmark consent policy.',
          first_party: true,
          trusted: true,
          skip_authorization_consent: true,
          is_active: true,
        },
      });

      const seedProgress = createPhase0cSeedProgressReporter(emails.length);
      let seedCompleted = false;
      try {
        await mapPhase0cBounded(emails, SEED_CONCURRENCY, async (email, index) => {
          const idempotencyKey = `${runId}-user-${String(index).padStart(3, '0')}`;
          let userId: string | null = null;
          let lastError: unknown = new Error('phase0c_mail_seed_user_failed');
          for (let attempt = 0; attempt < SEED_ATTEMPTS && !userId; attempt += 1) {
            try {
              userId = await createPhase0cUser({
                baseUrl,
                token: adminToken,
                tenantId,
                email,
                idempotencyKey,
              });
            } catch (error) {
              seedProgress.recordRetry();
              lastError = error;
              userId = await findPhase0cUserIdByExactEmail({
                baseUrl,
                token: adminToken,
                tenantId,
                email,
              }).catch(() => null);
              if (userId) seedProgress.recordRecovered();
              if (!userId && attempt + 1 < SEED_ATTEMPTS) {
                await new Promise((resolveDelay) =>
                  setTimeout(resolveDelay, Math.min(2_000, 200 * 2 ** attempt))
                );
              }
            }
          }
          if (!userId) throw lastError;
          createdUserIds.push(userId);
          seedProgress.recordCompleted();
          return userId;
        });
        seedCompleted = true;
      } finally {
        seedProgress.finish(seedCompleted ? 'complete' : 'aborted');
      }
      await writeFile(userListPath, `${emails.join('\n')}\n`, { mode: 0o600 });
      await chmod(userListPath, 0o600);

      const measurementToken = await requestAdminMachineAccessToken({
        apiBaseUrl: baseUrl,
        keysDir: tempDir,
        tenantId,
        clientId,
        scopes: permissions,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (
        measurementToken.expiresIn < 600 ||
        !hasExactPhase0cScope(measurementToken.scope, permissions)
      ) {
        throw new Error('phase0c_mail_machine_token_scope_invalid');
      }
      adminToken = measurementToken.accessToken;

      runtimeProfile = validatePhase0cRuntimeProfile(
        await phase0cAdminJson({
          baseUrl,
          path: '/api/admin/test/email-codes',
          method: 'POST',
          token: adminToken,
          tenantId,
          body: { email: emails[0], create_user: false },
        })
      );

      if (
        options.mode === 'sample' ||
        options.mode === 'pre_gate' ||
        options.mode === 'contention' ||
        options.mode === 'load'
      ) {
        previousRateLimitOverride = parsePhase0cRateLimitOverride(
          await phase0cAdminJson({
            baseUrl,
            path: '/api/admin/settings/rate-limits/profile-override',
            token: adminToken,
            tenantId,
          })
        );
        rateLimitOverrideMutationStarted = true;
        await phase0cAdminJson({
          baseUrl,
          path: '/api/admin/settings/rate-limits/profile-override',
          method: 'PUT',
          token: adminToken,
          tenantId,
          body: { profile: 'loadTest', expires_in: RATE_LIMIT_OVERRIDE_TTL_SECONDS },
        });
        await waitForPhase0cRateLimitProfile({
          baseUrl,
          clientId: oauthClientId,
          profile: 'loadTest',
        });
      }

      const k6Run = await runK6(
        buildPhase0cK6Environment({
          baseUrl,
          tenantId,
          clientId: oauthClientId,
          clientSecret: oauthClientSecret,
          accessToken: adminToken,
          userListPath,
          resultPath: options.resultPath,
          runId,
          runtimeProfile,
          preset:
            options.mode === 'smoke'
              ? 'phase0c-smoke'
              : options.mode === 'sample'
                ? 'phase0c-sample'
                : options.mode === 'pre_gate'
                  ? 'phase0c-pre-gate'
                  : options.mode === 'contention'
                    ? 'phase0c-contention'
                    : 'phase0c-load',
        })
      );
      await chmod(options.resultPath, 0o600);
      const evidence = await readPhase0cJson(options.resultPath);
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        throw new Error('phase0c_mail_load_evidence_invalid');
      }
      const enrichedEvidence = {
        ...(evidence as Record<string, unknown>),
        step_http_failures: k6Run.stepFailures,
      };
      await writeFile(options.resultPath, `${JSON.stringify(enrichedEvidence, null, 2)}\n`, {
        mode: 0o600,
      });
      const validation = {
        evidence: enrichedEvidence,
        runId,
        tenantId,
        forbiddenValues: [adminToken, oauthClientSecret, ...emails],
      };
      if (options.mode === 'smoke') validatePhase0cMailSmokeEvidence(validation);
      else if (options.mode === 'sample') validatePhase0cMailSampleEvidence(validation);
      else if (options.mode === 'pre_gate') validatePhase0cMailPreGateEvidence(validation);
      else validatePhase0cMailLoadEvidence(validation);
      if (k6Run.exitCode !== 0) {
        throw new Error(`phase0c_mail_k6_gate_failed:${k6Run.exitCode}`);
      }
      console.log(`Phase 0c Mail OTP ${options.mode} evidence: ${options.resultPath}`);
    }
  } catch (error) {
    executionError = error;
  } finally {
    if (adminToken && options.mode !== 'cleanup_interrupted' && principalMutationStarted) {
      try {
        const refreshedToken = await requestAdminMachineAccessToken({
          apiBaseUrl: baseUrl,
          keysDir: tempDir,
          tenantId,
          clientId,
          scopes: permissions,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (
          refreshedToken.expiresIn < 600 ||
          !hasExactPhase0cScope(refreshedToken.scope, permissions)
        ) {
          throw new Error('phase0c_mail_machine_token_scope_invalid');
        }
        adminToken = refreshedToken.accessToken;
      } catch {
        cleanupErrors.push('machine_token_refresh_failed');
      }
    }
    if (adminToken && rateLimitOverrideMutationStarted && previousRateLimitOverride !== undefined) {
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
    if (adminToken) {
      const uniqueUserIds = [...new Set(createdUserIds)];
      const cleanupProgress = createPhase0cCleanupProgressReporter(uniqueUserIds.length);
      let deletionResults: Array<string | null> = [];
      try {
        deletionResults = await mapPhase0cBounded(
          uniqueUserIds,
          CLEANUP_CONCURRENCY,
          async (userId) => {
            let result: string | null = null;
            try {
              await phase0cAdminJson({
                baseUrl,
                path: `/api/admin/users/${encodeURIComponent(userId)}`,
                method: 'DELETE',
                token: adminToken,
                tenantId,
              });
            } catch (error) {
              result = safePhase0cCleanupError(error);
            }
            cleanupProgress.recordCompleted(result !== null);
            return result;
          }
        );
      } finally {
        cleanupProgress.finish();
      }
      const deletionErrors = deletionResults.filter((error): error is string => error !== null);
      if (deletionErrors.length > 0) {
        cleanupErrors.push(`user_cleanup_failed:${deletionErrors.length}:${deletionErrors[0]}`);
      }
      if (options.mode === 'cleanup_interrupted') {
        try {
          const remaining =
            isRunScopedPhase0cCleanup(options) && options.cleanupRunId
              ? await abandonedPhase0cUserIds({
                  databaseNames: piiDatabaseNames,
                  tenantId,
                  runId: options.cleanupRunId,
                })
              : await interruptedDeletionUserIds({
                  databaseNames: usersDatabaseNames,
                  tenantId,
                });
          if (remaining.length > 0) {
            cleanupErrors.push(`user_cleanup_reconciliation_failed:${remaining.length}`);
          }
        } catch {
          cleanupErrors.push('user_cleanup_reconciliation_failed');
        }
      }
      if (options.mode !== 'cleanup_interrupted') {
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
          if (!oauthClientId) cleanupErrors.push('client_reconciliation_failed');
        }
        for (const cleanupClientId of clientIds) {
          try {
            await phase0cAdminJson({
              baseUrl,
              path: `/api/admin/clients/${encodeURIComponent(cleanupClientId)}`,
              method: 'DELETE',
              token: adminToken,
              tenantId,
            });
          } catch {
            cleanupErrors.push('client_cleanup_failed');
          }
        }
      }
    }
    if (principalMutationStarted) {
      try {
        await executeD1Command(
          adminDatabaseName,
          buildSetupMachineAccessCleanupSql({ clientId, principalId, principalType })
        );
      } catch {
        cleanupErrors.push('machine_principal_cleanup_failed');
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  }

  if (cleanupErrors.length > 0) {
    const execution = executionError ? `:${safePhase0cExecutionError(executionError)}` : '';
    throw new Error(`phase0c_mail_cleanup_incomplete:${cleanupErrors.join(',')}${execution}`);
  }
  if (executionError) throw executionError;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
