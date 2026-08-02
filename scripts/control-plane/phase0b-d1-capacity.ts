#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  redactControlPlaneEvidence,
  type CloudflareD1Database,
  type CloudflareD1Query,
  type CloudflareD1QueryResult,
} from '../../packages/ar-lib-core/src/services/control-plane/index.js';
import { splitMigrationSql } from '../../packages/ar-control/src/migration-sql.js';
import {
  RELEASE_MIGRATION_STREAM_DEFINITIONS,
  calculateReleaseMigrationChecksum,
  readReleaseMigrationManifest,
} from '../../packages/setup/src/core/release-migrations.js';
import { getAccountId } from '../../packages/setup/src/core/cloudflare.js';
import { createSetupOperatorD1Client } from '../../packages/setup/src/core/control-operator-executor.js';
import { renderPortableMigrationSql } from '../../packages/setup/src/core/sql-portability.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS_ROOT = resolve(REPO_ROOT, 'migrations');
const DEFAULT_MANIFEST_PATH = resolve(MIGRATIONS_ROOT, 'release-manifest.draft.json');
const DEFAULT_OUTPUT_DIR = resolve(
  REPO_ROOT,
  'private/docs/implementation/tenant-d1-control-plane/performance'
);
const RESOURCE_PREFIX = 'authrim-phase0b-capacity-test';
const REQUIRED_STREAMS = ['d1-core', 'd1-pii', 'd1-lookup'] as const;
const MINIMUM_MAX_ACCOUNTS = 200_000;
const MAXIMUM_MAX_ACCOUNTS = 10_000_000;
const SEED_CHUNK_SIZE = 5_000;
const QUERY_ITERATIONS = 30;
const CREATE_ITERATIONS = 10;
const CONTENTION_WRITERS = 5;
const D1_LOCATION_HINTS = new Set(['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']);
const CREATE_RECOVERY_ATTEMPTS = 5;
const CREATE_RECOVERY_DELAY_MS = 1_000;

type BenchmarkStream = (typeof REQUIRED_STREAMS)[number];

export interface Phase0bOptions {
  env: 'test';
  execute: boolean;
  confirmDisposable: boolean;
  accountId?: string;
  maxAccounts: number;
  manifestPath: string;
  outputDir: string;
  primaryLocationHint?: string;
}

export interface Phase0bDatabaseNames {
  suffix: string;
  core: string;
  pii: string;
  lookup: string;
}

export interface Phase0bMetric {
  attempts: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  rowsRead: number;
  rowsWritten: number;
}

interface LoadedMigrationStream {
  id: BenchmarkStream;
  files: Array<{ path: string; checksum: string; statements: string[] }>;
}

interface D1CapacityClient {
  createD1Database(input: {
    name: string;
    primary_location_hint?: string;
  }): Promise<CloudflareD1Database>;
  listD1Databases(): Promise<CloudflareD1Database[]>;
  deleteD1Database(databaseId: string): Promise<void>;
  getD1Database(databaseId: string): Promise<CloudflareD1Database>;
  queryD1(databaseId: string, sql: string, params?: unknown[]): Promise<CloudflareD1QueryResult[]>;
  queryD1Batch(
    databaseId: string,
    batch: readonly CloudflareD1Query[]
  ): Promise<CloudflareD1QueryResult[]>;
}

interface Phase0bEvidence {
  schemaVersion: 1;
  mode: 'dry-run' | 'execute';
  targetEnvironment: 'test';
  startedAt: string;
  finishedAt?: string;
  manifestPath: string;
  manifestProductVersion?: string;
  manifestDigest?: string;
  plannedAccountSteps: number[];
  resourceNames: Phase0bDatabaseNames;
  migration: Record<string, unknown>;
  measurements: Array<Record<string, unknown>>;
  cleanup: Array<Record<string, unknown>>;
  calibration: {
    targetAccountCount: null;
    requiresLiveResultReview: true;
    highestMeasuredAccountCount: number | null;
  };
  errorCode?: string;
}

function requiredValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name}_required`);
  return normalized;
}

function parseInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid_${name}`);
  return parsed;
}

function safeOutputDirectory(value: string): string {
  const output = resolve(value);
  if (output === '/' || output === resolve(tmpdir())) throw new Error('unsafe_output_directory');
  return output;
}

export function buildPhase0bAccountSteps(maxAccounts: number): number[] {
  if (
    !Number.isSafeInteger(maxAccounts) ||
    maxAccounts < MINIMUM_MAX_ACCOUNTS ||
    maxAccounts > MAXIMUM_MAX_ACCOUNTS
  ) {
    throw new Error('invalid_phase0b_max_accounts');
  }
  const multiplier = maxAccounts / 100_000;
  if (!Number.isInteger(Math.log2(multiplier))) {
    throw new Error('phase0b_max_accounts_must_be_geometric_step');
  }
  const steps = [10_000, 100_000];
  for (let count = 200_000; count <= maxAccounts; count *= 2) steps.push(count);
  return steps;
}

export function parsePhase0bArgs(argv: string[]): Phase0bOptions {
  let env: string | undefined;
  let execute = false;
  let confirmDisposable = false;
  let accountId: string | undefined;
  let maxAccounts = MINIMUM_MAX_ACCOUNTS;
  let manifestPath = DEFAULT_MANIFEST_PATH;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let primaryLocationHint: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--env') env = argv[++index];
    else if (argument === '--execute') execute = true;
    else if (argument === '--confirm-disposable') confirmDisposable = true;
    else if (argument === '--account-id') accountId = requiredValue(argv[++index], 'account_id');
    else if (argument === '--max-accounts') {
      maxAccounts = parseInteger(argv[++index], 'max_accounts');
    } else if (argument === '--manifest') {
      manifestPath = resolve(requiredValue(argv[++index], 'manifest'));
    } else if (argument === '--output-dir') {
      outputDir = safeOutputDirectory(requiredValue(argv[++index], 'output_dir'));
    } else if (argument === '--primary-location-hint') {
      primaryLocationHint = requiredValue(argv[++index], 'primary_location_hint');
    } else if (argument === '--help' || argument === '-h') throw new Error('help_requested');
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (env !== 'test') throw new Error('phase0b_test_environment_required');
  if (execute && !confirmDisposable) throw new Error('phase0b_disposable_confirmation_required');
  if (accountId !== undefined && !/^[a-f0-9]{32}$/u.test(accountId)) {
    throw new Error('invalid_cloudflare_account_id');
  }
  if (primaryLocationHint !== undefined && !D1_LOCATION_HINTS.has(primaryLocationHint)) {
    throw new Error('invalid_phase0b_primary_location_hint');
  }
  buildPhase0bAccountSteps(maxAccounts);
  return {
    env: 'test',
    execute,
    confirmDisposable,
    accountId,
    maxAccounts,
    manifestPath,
    outputDir: safeOutputDirectory(outputDir),
    primaryLocationHint,
  };
}

export function buildPhase0bNames(now = new Date(), nonce = randomUUID()): Phase0bDatabaseNames {
  const timestamp = now
    .toISOString()
    .replace(/[-:.TZ]/gu, '')
    .slice(0, 14)
    .toLowerCase();
  const random = nonce
    .replace(/[^a-z0-9]/giu, '')
    .slice(0, 6)
    .toLowerCase();
  const suffix = `${timestamp}-${random}`;
  return {
    suffix,
    core: `${RESOURCE_PREFIX}-${suffix}-core`,
    pii: `${RESOURCE_PREFIX}-${suffix}-pii`,
    lookup: `${RESOURCE_PREFIX}-${suffix}-lookup`,
  };
}

async function loadMigrationStreams(manifestPath: string): Promise<{
  productVersion: string;
  manifestDigest: string;
  streams: LoadedMigrationStream[];
}> {
  const manifestBytes = await readFile(manifestPath);
  const manifest = readReleaseMigrationManifest(manifestPath);
  const streams: LoadedMigrationStream[] = [];
  for (const streamId of REQUIRED_STREAMS) {
    const stream = manifest.streams.find((candidate) => candidate.id === streamId);
    const definition = RELEASE_MIGRATION_STREAM_DEFINITIONS.find(
      (candidate) => candidate.id === streamId
    );
    if (!stream || stream.dialect !== 'sqlite' || !definition) {
      throw new Error(`phase0b_required_migration_stream_missing:${streamId}`);
    }
    const streamRoot = resolve(MIGRATIONS_ROOT, definition.directory);
    const files: LoadedMigrationStream['files'] = [];
    for (const file of stream.files) {
      const path = resolve(streamRoot, file.path);
      if (path !== streamRoot && !path.startsWith(`${streamRoot}/`)) {
        throw new Error('phase0b_migration_path_escape');
      }
      const checksum = calculateReleaseMigrationChecksum(path, 'sqlite');
      if (checksum !== file.checksum) {
        throw new Error(`phase0b_migration_checksum_mismatch:${streamId}:${file.path}`);
      }
      const sql = renderPortableMigrationSql(await readFile(path, 'utf8'), 'sqlite');
      files.push({ path: file.path, checksum, statements: splitMigrationSql(sql) });
    }
    if (files.length === 0) throw new Error(`phase0b_required_migration_stream_empty:${streamId}`);
    streams.push({ id: streamId, files });
  }
  const digest = await crypto.subtle.digest('SHA-256', manifestBytes);
  const manifestDigest = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return { productVersion: manifest.productVersion, manifestDigest, streams };
}

function assertBatchSucceeded(results: CloudflareD1QueryResult[], expected: number): void {
  if (results.length !== expected || results.some((result) => result.success !== true)) {
    throw new Error('phase0b_d1_batch_failed');
  }
}

async function applyMigrationStream(
  client: D1CapacityClient,
  databaseId: string,
  stream: LoadedMigrationStream
): Promise<{ durationMs: number; files: number; statements: number }> {
  const started = performance.now();
  let statements = 0;
  for (const file of stream.files) {
    const batch = file.statements.map((sql) => ({ sql }));
    assertBatchSucceeded(await client.queryD1Batch(databaseId, batch), batch.length);
    statements += batch.length;
  }
  return { durationMs: performance.now() - started, files: stream.files.length, statements };
}

function recursiveSequence(): string {
  return 'WITH RECURSIVE benchmark_seq(n) AS (SELECT ? UNION ALL SELECT n + 1 FROM benchmark_seq WHERE n < ?)';
}

export function buildPhase0bSeedBatches(
  startExclusive: number,
  endInclusive: number
): {
  core: CloudflareD1Query[];
  pii: CloudflareD1Query[];
  lookup: CloudflareD1Query[];
} {
  if (
    !Number.isSafeInteger(startExclusive) ||
    !Number.isSafeInteger(endInclusive) ||
    startExclusive < 0 ||
    endInclusive <= startExclusive ||
    endInclusive - startExclusive > SEED_CHUNK_SIZE
  ) {
    throw new Error('invalid_phase0b_seed_range');
  }
  const params = [startExclusive + 1, endInclusive];
  const sequence = recursiveSequence();
  const id = "printf('%012d', n)";
  const account = `'account-' || ${id}`;
  const subject = `'subject-' || ${id}`;
  const now = '1700000000 + n';
  const digest = (offset: number) => `printf('%064x', n * 3 + ${offset})`;
  return {
    core: [
      {
        sql: `${sequence} INSERT INTO identity_subjects (
          id, tenant_id, subject_type, lifecycle_state, primary_account_id, created_at, updated_at
        ) SELECT ${subject}, 'benchmark-tenant', 'person', 'active', ${account}, ${now}, ${now}
          FROM benchmark_seq`,
        params,
      },
      {
        sql: `${sequence} INSERT INTO identity_accounts (
          id, tenant_id, account_type, lifecycle_state, primary_subject_id, created_at, updated_at,
          directory_publication_state, account_route_generation
        ) SELECT ${account}, 'benchmark-tenant', 'end_user', 'active', ${subject}, ${now}, ${now},
          'active', 1 FROM benchmark_seq`,
        params,
      },
      {
        sql: `${sequence} INSERT INTO subject_account_links (
          id, tenant_id, subject_id, account_id, link_type, lifecycle_state, created_at, updated_at
        ) SELECT 'link-' || ${id}, 'benchmark-tenant', ${subject}, ${account}, 'primary', 'active',
          ${now}, ${now} FROM benchmark_seq`,
        params,
      },
      {
        sql: `${sequence} INSERT INTO totp_credentials (
          id, tenant_id, user_id, secret_encrypted, status, created_at, activated_at
        ) SELECT 'credential-' || ${id}, 'benchmark-tenant', ${account},
          'synthetic-encrypted-secret', 'active', ${now}, ${now} FROM benchmark_seq`,
        params,
      },
    ],
    pii: [
      {
        sql: `${sequence} INSERT INTO users_pii (
          id, tenant_id, pii_class, email, email_blind_index, created_at, updated_at
        ) SELECT ${account}, 'benchmark-tenant', 'IDENTITY_CORE',
          'user-' || ${id} || '@benchmark.invalid', ${digest(1)}, ${now}, ${now}
          FROM benchmark_seq`,
        params,
      },
      {
        sql: `${sequence} INSERT INTO subject_identifiers (
          id, user_id, client_id, sector_identifier, subject, created_at
        ) SELECT 'pairwise-' || ${id}, ${account}, 'benchmark-client', 'benchmark.invalid',
          'pairwise-subject-' || ${id}, ${now} FROM benchmark_seq`,
        params,
      },
      {
        sql: `${sequence} INSERT INTO linked_identities (
          id, tenant_id, user_id, provider_id, provider_user_id, linked_at, last_used_at
        ) SELECT 'external-' || ${id}, 'benchmark-tenant', ${account}, 'benchmark-provider',
          'provider-subject-' || ${id}, ${now}, ${now} FROM benchmark_seq`,
        params,
      },
    ],
    lookup: [0, 1, 2].map((offset) => ({
      sql: `${sequence} INSERT INTO lookup_identifiers (
        virtual_bucket, index_kind, normalization_version, hmac_key_generation,
        identifier_blind_digest, tenant_id, account_id, route_schema_version,
        account_route_generation, required_binding_route_generation, residency_policy_id,
        route_projection_json, tenant_lifecycle_state, runtime_route_status, lifecycle_state,
        created_at, updated_at
      ) SELECT n % 4096,
        CASE ${offset} WHEN 0 THEN 'account_id' WHEN 1 THEN 'email_exact' ELSE 'external_subject' END,
        1, 1, ${digest(offset)}, 'benchmark-tenant', ${account}, 1, 1, 1, 'default',
        json_object('tenant_id', 'benchmark-tenant', 'account_id', ${account},
          'tenant_core_binding', 'TDB_CORE_0001', 'tenant_pii_binding', 'TDB_PII_0001',
          'residency_partition', 'default'),
        'active', 'active', 'active', ${now}, ${now} FROM benchmark_seq`,
      params,
    })),
  };
}

function numericMeta(results: CloudflareD1QueryResult[], key: string): number {
  return results.reduce((total, result) => {
    const value = result.meta?.[key];
    return total + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  }, 0);
}

export function summarizePhase0bMeasurements(
  samples: Array<{ durationMs: number; results?: CloudflareD1QueryResult[]; error?: string }>
): Phase0bMetric {
  if (samples.length === 0) throw new Error('phase0b_measurement_samples_required');
  const sorted = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const percentile = (ratio: number) => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
  const errors = samples.filter((sample) => sample.error !== undefined).length;
  return {
    attempts: samples.length,
    errors,
    errorRate: errors / samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    rowsRead: samples.reduce(
      (total, sample) => total + numericMeta(sample.results ?? [], 'rows_read'),
      0
    ),
    rowsWritten: samples.reduce(
      (total, sample) => total + numericMeta(sample.results ?? [], 'rows_written'),
      0
    ),
  };
}

async function measure(
  attempts: number,
  operation: (iteration: number) => Promise<CloudflareD1QueryResult[]>
): Promise<Phase0bMetric> {
  const samples: Array<{
    durationMs: number;
    results?: CloudflareD1QueryResult[];
    error?: string;
  }> = [];
  for (let iteration = 0; iteration < attempts; iteration += 1) {
    const started = performance.now();
    try {
      const results = await operation(iteration);
      if (results.length === 0 || results.some((result) => result.success !== true)) {
        throw new Error('phase0b_measurement_query_failed');
      }
      samples.push({ durationMs: performance.now() - started, results });
    } catch {
      samples.push({ durationMs: performance.now() - started, error: 'query_failed' });
    }
  }
  return summarizePhase0bMeasurements(samples);
}

function digestFor(accountNumber: number, offset: number): string {
  return BigInt(accountNumber * 3 + offset)
    .toString(16)
    .padStart(64, '0');
}

function accountId(accountNumber: number): string {
  return `account-${String(accountNumber).padStart(12, '0')}`;
}

async function seedToCount(
  client: D1CapacityClient,
  databases: Record<'core' | 'pii' | 'lookup', string>,
  startExclusive: number,
  endInclusive: number
): Promise<Phase0bMetric> {
  const samples: Array<{ durationMs: number; results: CloudflareD1QueryResult[] }> = [];
  for (let start = startExclusive; start < endInclusive; start += SEED_CHUNK_SIZE) {
    const end = Math.min(start + SEED_CHUNK_SIZE, endInclusive);
    const batches = buildPhase0bSeedBatches(start, end);
    for (const role of ['core', 'pii', 'lookup'] as const) {
      const started = performance.now();
      const results = await client.queryD1Batch(databases[role], batches[role]);
      assertBatchSucceeded(results, batches[role].length);
      samples.push({ durationMs: performance.now() - started, results });
    }
  }
  return summarizePhase0bMeasurements(samples);
}

function requireSingleRow(results: CloudflareD1QueryResult[]): CloudflareD1QueryResult[] {
  if (results.length !== 1 || results[0]?.results?.length !== 1) {
    throw new Error('phase0b_exact_query_result_invalid');
  }
  return results;
}

async function benchmarkAtCount(
  client: D1CapacityClient,
  databases: Record<'core' | 'pii' | 'lookup', string>,
  accountCount: number,
  seedMetric: Phase0bMetric
): Promise<Record<string, unknown>> {
  const pick = (iteration: number) => 1 + ((iteration * 7_919) % accountCount);
  const accountExact = await measure(QUERY_ITERATIONS, async (iteration) => {
    const number = pick(iteration);
    return requireSingleRow(
      await client.queryD1(
        databases.lookup,
        `SELECT tenant_id, account_id, route_projection_json
           FROM lookup_identifiers
          WHERE virtual_bucket = ? AND index_kind = 'account_id'
            AND normalization_version = 1 AND hmac_key_generation = 1
            AND identifier_blind_digest = ? AND lifecycle_state = 'active'`,
        [number % 4096, digestFor(number, 0)]
      )
    );
  });
  const emailExact = await measure(QUERY_ITERATIONS, async (iteration) => {
    const number = pick(iteration);
    return requireSingleRow(
      await client.queryD1(
        databases.lookup,
        `SELECT tenant_id, account_id, route_projection_json
           FROM lookup_identifiers
          WHERE virtual_bucket = ? AND index_kind = 'email_exact'
            AND normalization_version = 1 AND hmac_key_generation = 1
            AND identifier_blind_digest = ? AND lifecycle_state = 'active'`,
        [number % 4096, digestFor(number, 1)]
      )
    );
  });
  const externalSubjectExact = await measure(QUERY_ITERATIONS, async (iteration) => {
    const number = pick(iteration);
    return requireSingleRow(
      await client.queryD1(
        databases.lookup,
        `SELECT tenant_id, account_id, route_projection_json
           FROM lookup_identifiers
          WHERE virtual_bucket = ? AND index_kind = 'external_subject'
            AND normalization_version = 1 AND hmac_key_generation = 1
            AND identifier_blind_digest = ? AND lifecycle_state = 'active'`,
        [number % 4096, digestFor(number, 2)]
      )
    );
  });
  const tenantAccountRead = await measure(QUERY_ITERATIONS, async (iteration) =>
    requireSingleRow(
      await client.queryD1(
        databases.core,
        `SELECT id, primary_subject_id, lifecycle_state, directory_publication_state
           FROM identity_accounts WHERE tenant_id = ? AND id = ?`,
        ['benchmark-tenant', accountId(pick(iteration))]
      )
    )
  );
  const adminPagination = await measure(QUERY_ITERATIONS, () =>
    client.queryD1(
      databases.core,
      `SELECT id, primary_subject_id, created_at
         FROM identity_accounts
        WHERE tenant_id = ? AND directory_publication_state = 'active'
        ORDER BY created_at DESC, id DESC LIMIT 50`,
      ['benchmark-tenant']
    )
  );
  const accountCreateRoutingOutbox = await measure(CREATE_ITERATIONS, async (iteration) => {
    const suffix = accountCount + 1_000 + iteration;
    const account = `benchmark-create-${suffix}`;
    const subject = `benchmark-subject-${suffix}`;
    const now = 1_800_000_000 + iteration;
    return client.queryD1Batch(databases.core, [
      {
        sql: `INSERT INTO identity_subjects (id, tenant_id, subject_type, lifecycle_state,
          primary_account_id, created_at, updated_at) VALUES (?, ?, 'person', 'active', ?, ?, ?)`,
        params: [subject, 'benchmark-tenant', account, now, now],
      },
      {
        sql: `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state,
          primary_subject_id, created_at, updated_at, directory_publication_state,
          account_route_generation) VALUES (?, ?, 'end_user', 'active', ?, ?, ?,
          'active_pending_directory', 1)`,
        params: [account, 'benchmark-tenant', subject, now, now],
      },
      {
        sql: `INSERT INTO account_routing_outbox (outbox_id, tenant_id, account_id, event_kind,
          route_generation, route_schema_version, hmac_key_generation, payload_json, status,
          attempt_count, created_at, updated_at) VALUES (?, ?, ?, 'account_created', 1, 1, 1,
          '{"schema_version":1}', 'pending', 0, ?, ?)`,
        params: [`benchmark-outbox-${suffix}`, 'benchmark-tenant', account, now, now],
      },
    ]);
  });
  const contentionStarted = performance.now();
  const contentionResults = await Promise.allSettled(
    Array.from({ length: CONTENTION_WRITERS }, async (_, writer) => {
      const id = `contention-${accountCount}-${writer}`;
      return client.queryD1(
        databases.core,
        `INSERT INTO identity_subjects (id, tenant_id, subject_type, lifecycle_state,
          created_at, updated_at) VALUES (?, 'benchmark-tenant', 'service', 'active', ?, ?)`,
        [id, 1_900_000_000 + writer, 1_900_000_000 + writer]
      );
    })
  );
  const contention = {
    writers: CONTENTION_WRITERS,
    durationMs: performance.now() - contentionStarted,
    errors: contentionResults.filter(
      (result) =>
        result.status === 'rejected' ||
        result.value.length === 0 ||
        result.value.some((query) => query.success !== true)
    ).length,
  };
  const indexStarted = performance.now();
  const indexResults = await client.queryD1(
    databases.core,
    `CREATE INDEX benchmark_phase0b_account_generation
      ON identity_accounts(tenant_id, account_route_generation, updated_at, id)`
  );
  assertBatchSucceeded(indexResults, 1);
  const indexMigrationMs = performance.now() - indexStarted;
  const dropResults = await client.queryD1(
    databases.core,
    'DROP INDEX benchmark_phase0b_account_generation'
  );
  assertBatchSucceeded(dropResults, 1);
  const details = await Promise.all([
    client.getD1Database(databases.core),
    client.getD1Database(databases.pii),
    client.getD1Database(databases.lookup),
  ]);
  return {
    accountCount,
    seed: seedMetric,
    metrics: {
      accountExact,
      emailExact,
      externalSubjectExact,
      tenantAccountRead,
      accountCreateRoutingOutbox,
      adminPagination,
    },
    contention,
    indexMigrationMs,
    databaseSizeBytes: {
      core: typeof details[0]?.file_size === 'number' ? details[0].file_size : null,
      pii: typeof details[1]?.file_size === 'number' ? details[1].file_size : null,
      lookup: typeof details[2]?.file_size === 'number' ? details[2].file_size : null,
    },
  };
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[a-zA-Z0-9_.:-]{1,240}$/u.test(error.message)) {
    return error.message;
  }
  return 'phase0b_unexpected_error';
}

async function writeEvidence(options: Phase0bOptions, evidence: Phase0bEvidence): Promise<string> {
  await mkdir(options.outputDir, { recursive: true });
  const path = resolve(
    options.outputDir,
    `phase0b-d1-capacity-${evidence.resourceNames.suffix}.json`
  );
  await writeFile(path, `${JSON.stringify(redactControlPlaneEvidence(evidence), null, 2)}\n`, {
    mode: 0o600,
  });
  return path;
}

async function findDatabaseByName(
  client: D1CapacityClient,
  name: string,
  attempts: number
): Promise<CloudflareD1Database | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const database = (await client.listD1Databases()).find((candidate) => candidate.name === name);
    if (database) return database;
    if (attempt < attempts) {
      await new Promise((resolveWait) => setTimeout(resolveWait, CREATE_RECOVERY_DELAY_MS));
    }
  }
  return undefined;
}

export async function runPhase0bCapacity(
  options: Phase0bOptions,
  environment: NodeJS.ProcessEnv = process.env,
  clientOverride?: D1CapacityClient
): Promise<{ evidencePath: string; evidence: Phase0bEvidence }> {
  const names = buildPhase0bNames();
  const steps = buildPhase0bAccountSteps(options.maxAccounts);
  const evidence: Phase0bEvidence = {
    schemaVersion: 1,
    mode: options.execute ? 'execute' : 'dry-run',
    targetEnvironment: 'test',
    startedAt: new Date().toISOString(),
    manifestPath: options.manifestPath,
    plannedAccountSteps: steps,
    resourceNames: names,
    migration: {},
    measurements: [],
    cleanup: [],
    calibration: {
      targetAccountCount: null,
      requiresLiveResultReview: true,
      highestMeasuredAccountCount: null,
    },
  };
  if (!options.execute) {
    evidence.migration = { streams: REQUIRED_STREAMS, verified: false };
    evidence.finishedAt = new Date().toISOString();
    return { evidencePath: await writeEvidence(options, evidence), evidence };
  }

  const account = requiredValue(
    options.accountId ?? environment.CLOUDFLARE_ACCOUNT_ID ?? (await getAccountId()) ?? undefined,
    'cloudflare_account_id'
  );
  if (!/^[a-f0-9]{32}$/u.test(account)) throw new Error('invalid_cloudflare_account_id');
  const client =
    clientOverride ?? (await createSetupOperatorD1Client({ expectedAccountId: account }));
  const created: Array<{ role: 'core' | 'pii' | 'lookup'; id: string; name: string }> = [];
  let failed: unknown;
  try {
    const loaded = await loadMigrationStreams(options.manifestPath);
    evidence.manifestProductVersion = loaded.productVersion;
    evidence.manifestDigest = loaded.manifestDigest;
    const existingDatabases = await client.listD1Databases();
    const expectedNames = new Set([names.core, names.pii, names.lookup]);
    if (existingDatabases.some((database) => expectedNames.has(database.name))) {
      throw new Error('phase0b_disposable_database_name_collision');
    }
    for (const role of ['core', 'pii', 'lookup'] as const) {
      try {
        const database = await client.createD1Database({
          name: names[role],
          ...(options.primaryLocationHint
            ? { primary_location_hint: options.primaryLocationHint }
            : {}),
        });
        created.push({ role, id: database.uuid, name: names[role] });
      } catch (error) {
        const recovered = await findDatabaseByName(client, names[role], CREATE_RECOVERY_ATTEMPTS);
        if (recovered) created.push({ role, id: recovered.uuid, name: names[role] });
        throw error;
      }
    }
    const databaseIds = Object.fromEntries(
      created.map((database) => [database.role, database.id])
    ) as Record<'core' | 'pii' | 'lookup', string>;
    const migrationResults: Record<string, unknown> = {};
    const streamRole: Record<BenchmarkStream, 'core' | 'pii' | 'lookup'> = {
      'd1-core': 'core',
      'd1-pii': 'pii',
      'd1-lookup': 'lookup',
    };
    for (const stream of loaded.streams) {
      migrationResults[stream.id] = await applyMigrationStream(
        client,
        databaseIds[streamRole[stream.id]],
        stream
      );
    }
    evidence.migration = { checksumVerified: true, streams: migrationResults };
    let currentCount = 0;
    for (const step of steps) {
      const seedMetric = await seedToCount(client, databaseIds, currentCount, step);
      evidence.measurements.push(await benchmarkAtCount(client, databaseIds, step, seedMetric));
      evidence.calibration.highestMeasuredAccountCount = step;
      currentCount = step;
    }
  } catch (error) {
    failed = error;
    evidence.errorCode = errorCode(error);
  } finally {
    for (const database of created.reverse()) {
      try {
        await client.deleteD1Database(database.id);
        evidence.cleanup.push({ role: database.role, name: database.name, status: 'deleted' });
      } catch (error) {
        evidence.cleanup.push({
          role: database.role,
          name: database.name,
          status: 'delete_failed',
          errorCode: errorCode(error),
        });
      }
    }
    evidence.finishedAt = new Date().toISOString();
  }
  const evidencePath = await writeEvidence(options, evidence);
  if (failed) throw new Error(`phase0b_capacity_failed:${errorCode(failed)}:${evidencePath}`);
  if (evidence.cleanup.some((result) => result.status !== 'deleted')) {
    throw new Error(`phase0b_cleanup_incomplete:${evidencePath}`);
  }
  return { evidencePath, evidence };
}

function printUsage(): void {
  process.stdout.write(`Tenant D1 control-plane Phase 0b capacity calibration\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  pnpm control-plane:phase0b-capacity --env test\n`);
  process.stdout.write(
    `  pnpm control-plane:phase0b-capacity --env test --execute --confirm-disposable\n\n`
  );
  process.stdout.write(`Live execution uses the local Wrangler OAuth session.\n`);
  process.stdout.write(
    `The account is selected by --account-id, CLOUDFLARE_ACCOUNT_ID, or Wrangler (in that order).\n`
  );
}

async function main(): Promise<void> {
  let options: Phase0bOptions;
  try {
    options = parsePhase0bArgs(process.argv.slice(2));
  } catch (error) {
    printUsage();
    if (error instanceof Error && error.message === 'help_requested') return;
    throw error;
  }
  const result = await runPhase0bCapacity(options);
  process.stdout.write(`Phase 0b evidence: ${result.evidencePath}\n`);
  if (!options.execute) process.stdout.write('Dry run only; no D1 databases were created.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
