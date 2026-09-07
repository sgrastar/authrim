#!/usr/bin/env node

import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLookupBlindIndex } from '../../packages/ar-lib-core/src/services/lookup-directory/blind-index.js';
import {
  LOOKUP_MAX_VIRTUAL_BUCKET,
  LOOKUP_VIRTUAL_BUCKET_COUNT,
} from '../../packages/ar-lib-core/src/services/lookup-directory/contract.js';
import {
  validateAccountRouteProjection,
  type AccountRouteProjection,
} from '../../packages/ar-lib-core/src/services/control-plane/control-plane-contracts.js';
import {
  RUNTIME_REGISTRY_SNAPSHOT_VERSION,
  buildTenantRuntimeRegistryGenerationKey,
  buildTenantRuntimeRegistrySnapshotKey,
  loadTenantRuntimeRegistryVerificationKeysFromEnv,
  verifyTenantRuntimeRegistrySnapshotSignature,
  type TenantRuntimeRegistryGenerationDocument,
  type TenantRuntimeRegistrySnapshot,
  type TenantRuntimeRegistryStoreSnapshot,
} from '../../packages/ar-lib-core/src/services/tenant-runtime-registry-snapshot.js';
import type {
  CloudflareD1Query,
  CloudflareD1QueryResult,
} from '../../packages/ar-lib-core/src/services/control-plane/cloudflare-control-api-client.js';
import { getKVKeyByNamespaceId } from '../../packages/setup/src/core/cloudflare.js';
import { createSetupOperatorD1Client } from '../../packages/setup/src/core/control-operator-executor.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_STATE_DIR = resolve(REPO_ROOT, '.authrim/test');
const TEST_KEYS_DIR = resolve(REPO_ROOT, '.authrim-keys/test');
const WARMUP_RESERVED_ENTRIES = 2_000;
const MEASUREMENT_ENTRIES = 15_000;
const TOTAL_ENTRIES = WARMUP_RESERVED_ENTRIES + MEASUREMENT_ENTRIES;
export const PHASE0C_FIXTURE_ROWS_PER_STATEMENT = 8;
const STATEMENT_PAIRS_PER_BATCH = 20;
const FIXTURE_CODE = '739201';
const RUN_ID = /^phase0c-[0-9]{14}-[a-f0-9]{6}$/u;

interface FixtureOptions {
  env: 'test';
  mode: 'prepare' | 'cleanup';
  fixturePath: string;
  confirmTestData: boolean;
}

interface D1Resource {
  id: string;
  name: string;
}

interface FixtureLock {
  d1: Record<string, D1Resource>;
  kv: Record<string, D1Resource>;
  controlKeyState: {
    lookupHmac: { activeSlot: 'A' | 'B'; activeGeneration: number };
  };
}

interface FixtureConfig {
  cloudflare: { accountId: string };
  tenant: { name: string };
  urls: { api: { custom: string } };
}

interface BucketAssignment {
  virtualBucket: number;
  assignmentGeneration: number;
  bindingRef: string;
  databaseId: string;
}

export interface IdentifierFixtureEntry {
  challengeId: string;
  code: string;
  virtualBucket: number;
  assignmentGeneration: number;
  hmacKeyGeneration: number;
  digest: string;
  accountId: string;
  otpVerifier: string;
  databaseId: string;
}

export interface IdentifierFixtureFile {
  schemaVersion: 1;
  runId: string;
  environment: 'test';
  baseUrl: string;
  tenantId: string;
  createdAt: string;
  entries: Array<{ challengeId: string; code: string }>;
  cleanup: Array<{ databaseId: string; accountIdPrefix: string }>;
}

export interface RuntimeRoute {
  tenantId: string;
  routeGeneration: number;
  projection: AccountRouteProjection;
}

export interface RuntimeShardAssignment {
  tenantId: string;
  dataRole: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
  residencyPolicyId: string;
  residencyPartition: string;
  shardId: string;
  routeGeneration: number;
  bindingRef: string;
  databaseId: string;
}

export interface Phase0cRuntimeState {
  route: RuntimeRoute;
  defaultDatabaseId: string;
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(code);
  return value.trim();
}

function safeFixturePath(value: string): string {
  const path = resolve(value);
  if (!path.startsWith('/private/tmp/') && !path.startsWith('/tmp/')) {
    throw new Error('phase0c_fixture_must_use_temporary_directory');
  }
  return path;
}

export function parsePhase0cIdentifierFixtureArgs(argv: string[]): FixtureOptions {
  let env: string | undefined;
  let mode: FixtureOptions['mode'] | undefined;
  let fixturePath: string | undefined;
  let confirmTestData = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--env') env = argv[++index];
    else if (argument === '--prepare') mode = mode ? undefined : 'prepare';
    else if (argument === '--cleanup') mode = mode ? undefined : 'cleanup';
    else if (argument === '--fixture') fixturePath = argv[++index];
    else if (argument === '--confirm-test-data') confirmTestData = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (env !== 'test') throw new Error('phase0c_test_environment_required');
  if (!mode) throw new Error('phase0c_fixture_mode_required');
  if (!fixturePath) throw new Error('phase0c_fixture_path_required');
  if (!confirmTestData) throw new Error('phase0c_test_data_confirmation_required');
  return { env: 'test', mode, fixturePath: safeFixturePath(fixturePath), confirmTestData };
}

function strictFixtureLock(value: unknown): FixtureLock {
  const input = value as Partial<FixtureLock>;
  if (
    !input ||
    typeof input !== 'object' ||
    !input.d1 ||
    !input.kv ||
    !input.controlKeyState?.lookupHmac
  ) {
    throw new Error('phase0c_lock_invalid');
  }
  const lookup = input.controlKeyState.lookupHmac;
  if (
    (lookup.activeSlot !== 'A' && lookup.activeSlot !== 'B') ||
    !Number.isSafeInteger(lookup.activeGeneration) ||
    lookup.activeGeneration < 1
  ) {
    throw new Error('phase0c_lookup_key_state_invalid');
  }
  for (const resource of [...Object.values(input.d1), ...Object.values(input.kv)]) {
    if (!resource || typeof resource.id !== 'string' || typeof resource.name !== 'string') {
      throw new Error('phase0c_lock_invalid');
    }
  }
  return input as FixtureLock;
}

function strictFixtureConfig(value: unknown): FixtureConfig {
  const input = value as Partial<FixtureConfig>;
  const accountId = input.cloudflare?.accountId;
  const baseUrl = input.urls?.api?.custom;
  const tenantId = input.tenant?.name;
  if (typeof accountId !== 'string' || !/^[a-f0-9]{32}$/u.test(accountId)) {
    throw new Error('phase0c_account_id_invalid');
  }
  if (typeof tenantId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(tenantId)) {
    throw new Error('phase0c_tenant_id_invalid');
  }
  if (typeof baseUrl !== 'string' || new URL(baseUrl).protocol !== 'https:') {
    throw new Error('phase0c_base_url_invalid');
  }
  return input as FixtureConfig;
}

function rows<T extends Record<string, unknown>>(
  result: CloudflareD1QueryResult | undefined,
  code: string
): T[] {
  if (!result || result.success !== true || !Array.isArray(result.results)) throw new Error(code);
  return result.results.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(code);
    return row as T;
  });
}

function assertBatch(results: CloudflareD1QueryResult[], expected: number): void {
  if (results.length !== expected || results.some((result) => result.success !== true)) {
    throw new Error('phase0c_fixture_d1_batch_failed');
  }
}

function fixtureRunId(now = new Date(), nonce = randomUUID()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:.TZ]/gu, '')
    .slice(0, 14);
  const random = nonce
    .replace(/[^a-f0-9]/giu, '')
    .slice(0, 6)
    .toLowerCase();
  return `phase0c-${timestamp}-${random}`;
}

function otpVerifier(challengeId: string, code: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`discovery-otp-v1\0${challengeId}\0${code}`)
    .digest('hex');
}

export async function buildPhase0cIdentifierFixtureEntries(input: {
  runId: string;
  count: number;
  lookupSecret: string;
  lookupGeneration: number;
  otpSecret: string;
  assignments: ReadonlyMap<number, BucketAssignment>;
  randomId?: (index: number) => string;
}): Promise<IdentifierFixtureEntry[]> {
  if (!RUN_ID.test(input.runId)) throw new Error('phase0c_run_id_invalid');
  if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > TOTAL_ENTRIES) {
    throw new Error('phase0c_fixture_count_invalid');
  }
  const result: IdentifierFixtureEntry[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const blind = await createLookupBlindIndex(
      'email_exact',
      `${input.runId}-${index}@phase0c.invalid`,
      { generation: input.lookupGeneration, secret: input.lookupSecret }
    );
    const assignment = input.assignments.get(blind.virtualBucket);
    if (!assignment) throw new Error('phase0c_lookup_assignment_missing');
    const challengeId = `discovery-${blind.virtualBucket}-${assignment.assignmentGeneration}-${input.randomId?.(index) ?? randomUUID()}`;
    result.push({
      challengeId,
      code: FIXTURE_CODE,
      virtualBucket: blind.virtualBucket,
      assignmentGeneration: assignment.assignmentGeneration,
      hmacKeyGeneration: input.lookupGeneration,
      digest: blind.digest,
      accountId: `${input.runId}-${String(index).padStart(5, '0')}`,
      otpVerifier: otpVerifier(challengeId, FIXTURE_CODE, input.otpSecret),
      databaseId: assignment.databaseId,
    });
  }
  return result;
}

function placeholders(rows: number, columns: number): string {
  return Array.from({ length: rows }, () => `(${Array(columns).fill('?').join(',')})`).join(',');
}

export function buildPhase0cFixtureInsertQueries(input: {
  runId: string;
  entries: readonly IdentifierFixtureEntry[];
  route: RuntimeRoute;
  now: number;
}): CloudflareD1Query[] {
  const projection = JSON.stringify(input.route.projection);
  const requiredBindingGeneration = Math.max(
    ...input.route.projection.targets.map((target) => target.requiredBindingRouteGeneration)
  );
  const identifierParams = input.entries.flatMap((entry) => [
    entry.virtualBucket,
    entry.hmacKeyGeneration,
    entry.digest,
    input.route.tenantId,
    entry.accountId,
    input.route.projection.schemaVersion,
    input.route.routeGeneration,
    requiredBindingGeneration,
    input.route.projection.residencyPolicyId,
    projection,
    input.now,
    input.now,
  ]);
  const challengeParams = input.entries.flatMap((entry) => [
    entry.challengeId,
    entry.digest,
    entry.hmacKeyGeneration,
    entry.otpVerifier,
    input.now + 7_200,
    input.runId,
    input.now,
    input.now,
  ]);
  return [
    {
      sql: `INSERT INTO lookup_identifiers (
        virtual_bucket, index_kind, normalization_version, hmac_key_generation,
        identifier_blind_digest, tenant_id, account_id, route_schema_version,
        account_route_generation, required_binding_route_generation, residency_policy_id,
        route_projection_json, tenant_lifecycle_state, runtime_route_status, lifecycle_state,
        created_at, updated_at
      ) VALUES ${placeholders(input.entries.length, 17)}`.replaceAll(
        '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        "(?,'email_exact',1,?,?,?,?,?,?,?,?,?,'active','active','active',?,?)"
      ),
      params: identifierParams,
    },
    {
      sql: `INSERT INTO lookup_discovery_otp_challenges (
        challenge_id, normalization_version, email_blind_digest, hmac_key_generation,
        previous_email_blind_digest, previous_hmac_key_generation, previous_virtual_bucket,
        otp_verifier, delivery_state, attempt_count, attempt_limit, expires_at, consumed_at,
        rate_limit_ip_digest, rate_limit_device_digest, created_at, updated_at
      ) VALUES ${placeholders(input.entries.length, 17)}`.replaceAll(
        '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        "(?,1,?,?,NULL,NULL,NULL,?,'sent',0,5,?,NULL,NULL,?,?,?)"
      ),
      params: challengeParams,
    },
  ];
}

function parseFixtureFile(value: unknown): IdentifierFixtureFile {
  const input = value as Partial<IdentifierFixtureFile>;
  if (
    !input ||
    input.schemaVersion !== 1 ||
    typeof input.runId !== 'string' ||
    !RUN_ID.test(input.runId) ||
    input.environment !== 'test' ||
    typeof input.baseUrl !== 'string' ||
    typeof input.tenantId !== 'string' ||
    !Array.isArray(input.entries) ||
    !Array.isArray(input.cleanup)
  ) {
    throw new Error('phase0c_fixture_file_invalid');
  }
  if (
    input.cleanup.some(
      (item) =>
        !item || typeof item.databaseId !== 'string' || item.accountIdPrefix !== `${input.runId}-%`
    )
  ) {
    throw new Error('phase0c_fixture_cleanup_scope_invalid');
  }
  return input as IdentifierFixtureFile;
}

async function loadState(): Promise<{ lock: FixtureLock; config: FixtureConfig }> {
  const [lock, config] = await Promise.all([
    readFile(resolve(TEST_STATE_DIR, 'lock.json'), 'utf8'),
    readFile(resolve(TEST_STATE_DIR, 'config.json'), 'utf8'),
  ]);
  return {
    lock: strictFixtureLock(JSON.parse(lock) as unknown),
    config: strictFixtureConfig(JSON.parse(config) as unknown),
  };
}

function parseJsonObject(value: string, code: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code);
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(code);
  }
}

function runtimeStoreDataRole(
  store: TenantRuntimeRegistryStoreSnapshot
): RuntimeShardAssignment['dataRole'] | null {
  if (store.role === 'tenant_core' && store.shardGroup === 'default') {
    return 'tenant_core/default';
  }
  if (store.role === 'tenant_core' && store.shardGroup === 'users') {
    return 'tenant_core/users';
  }
  if (store.role === 'tenant_pii' && store.shardGroup === 'default') return 'tenant_pii';
  return null;
}

function strictRuntimeGeneration(
  value: string,
  nowMs: number
): TenantRuntimeRegistryGenerationDocument {
  const parsed = parseJsonObject(value, 'phase0c_runtime_generation_invalid');
  if (
    !Number.isSafeInteger(parsed.runtimeGeneration) ||
    Number(parsed.runtimeGeneration) < 1 ||
    parsed.routeStatus !== 'active' ||
    !Number.isSafeInteger(parsed.quarantineDenyGeneration) ||
    Number(parsed.quarantineDenyGeneration) < 0 ||
    typeof parsed.publishedAt !== 'string' ||
    typeof parsed.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.publishedAt)) ||
    !Number.isFinite(Date.parse(parsed.expiresAt)) ||
    Date.parse(parsed.expiresAt) <= nowMs
  ) {
    throw new Error('phase0c_runtime_generation_invalid');
  }
  return parsed as unknown as TenantRuntimeRegistryGenerationDocument;
}

function strictRuntimeSnapshot(
  value: string,
  tenantId: string,
  nowMs: number
): TenantRuntimeRegistrySnapshot {
  const parsed = parseJsonObject(value, 'phase0c_runtime_snapshot_invalid');
  const stores = parsed.stores;
  const metadata = parsed.metadata as Record<string, unknown> | undefined;
  if (
    parsed.version !== RUNTIME_REGISTRY_SNAPSHOT_VERSION ||
    parsed.tenantId !== tenantId ||
    parsed.snapshotScope !== 'tenant' ||
    parsed.deploymentTarget !== 'default' ||
    !Number.isSafeInteger(parsed.runtimeGeneration) ||
    Number(parsed.runtimeGeneration) < 1 ||
    parsed.routeStatus !== 'active' ||
    !Number.isSafeInteger(parsed.quarantineDenyGeneration) ||
    Number(parsed.quarantineDenyGeneration) < 0 ||
    typeof parsed.publishedAt !== 'string' ||
    typeof parsed.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.publishedAt)) ||
    !Number.isFinite(Date.parse(parsed.expiresAt)) ||
    Date.parse(parsed.expiresAt) <= nowMs ||
    !Array.isArray(stores) ||
    stores.length < 3 ||
    !metadata ||
    !Number.isSafeInteger(metadata.storeCount) ||
    Number(metadata.storeCount) !== stores.length
  ) {
    throw new Error('phase0c_runtime_snapshot_invalid');
  }
  return parsed as unknown as TenantRuntimeRegistrySnapshot;
}

export async function buildPhase0cRuntimeState(input: {
  tenantId: string;
  snapshotJson: string;
  generationJson: string;
  verificationJwks: string;
  shardAssignments: readonly RuntimeShardAssignment[];
  lockD1: Readonly<Record<string, D1Resource>>;
  nowMs?: number;
}): Promise<Phase0cRuntimeState> {
  const nowMs = input.nowMs ?? Date.now();
  const snapshot = strictRuntimeSnapshot(input.snapshotJson, input.tenantId, nowMs);
  const generation = strictRuntimeGeneration(input.generationJson, nowMs);
  if (
    generation.runtimeGeneration !== snapshot.runtimeGeneration ||
    generation.routeStatus !== snapshot.routeStatus ||
    generation.quarantineDenyGeneration !== snapshot.quarantineDenyGeneration
  ) {
    throw new Error('phase0c_runtime_generation_mismatch');
  }
  let signatureStatus: Awaited<ReturnType<typeof verifyTenantRuntimeRegistrySnapshotSignature>>;
  try {
    signatureStatus = await verifyTenantRuntimeRegistrySnapshotSignature(
      snapshot,
      loadTenantRuntimeRegistryVerificationKeysFromEnv({
        TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: input.verificationJwks,
      })
    );
  } catch {
    throw new Error('phase0c_runtime_snapshot_signature_invalid');
  }
  if (signatureStatus !== 'valid') {
    throw new Error('phase0c_runtime_snapshot_signature_invalid');
  }

  const assignmentsByBinding = new Map<string, RuntimeShardAssignment>();
  for (const assignment of input.shardAssignments) {
    if (
      assignment.tenantId !== input.tenantId ||
      !['tenant_core/default', 'tenant_core/users', 'tenant_pii'].includes(assignment.dataRole) ||
      !Number.isSafeInteger(assignment.routeGeneration) ||
      assignment.routeGeneration < 1 ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(assignment.bindingRef) ||
      !input.lockD1[assignment.bindingRef] ||
      input.lockD1[assignment.bindingRef]!.id !== assignment.databaseId ||
      assignmentsByBinding.has(assignment.bindingRef)
    ) {
      throw new Error('phase0c_runtime_shard_assignment_invalid');
    }
    assignmentsByBinding.set(assignment.bindingRef, assignment);
  }

  const selected = new Map<RuntimeShardAssignment['dataRole'], RuntimeShardAssignment>();
  const storeIdentity = new Set<string>();
  const orderedStores = [...snapshot.stores].sort(
    (left, right) => left.shardIndex - right.shardIndex
  );
  for (const store of orderedStores) {
    const dataRole = runtimeStoreDataRole(store);
    const identity = `${store.role}\0${store.shardGroup}\0${store.shardIndex}`;
    if (
      storeIdentity.has(identity) ||
      store.tenantId !== input.tenantId ||
      store.runtimeGeneration !== snapshot.runtimeGeneration ||
      !Number.isSafeInteger(store.generation) ||
      store.generation < 1 ||
      !Number.isSafeInteger(store.shardIndex) ||
      store.shardIndex < 0 ||
      !dataRole ||
      store.provider !== 'd1' ||
      store.driver !== 'd1' ||
      store.status !== 'active' ||
      store.healthStatus !== 'active' ||
      typeof store.bindingRef !== 'string' ||
      typeof store.databaseId !== 'string'
    ) {
      throw new Error('phase0c_runtime_snapshot_store_invalid');
    }
    storeIdentity.add(identity);
    const assignment = assignmentsByBinding.get(store.bindingRef);
    if (
      !assignment ||
      assignment.dataRole !== dataRole ||
      assignment.routeGeneration !== store.generation ||
      assignment.databaseId !== store.databaseId
    ) {
      throw new Error('phase0c_runtime_snapshot_store_mismatch');
    }
    if (!selected.has(dataRole)) selected.set(dataRole, assignment);
  }

  const defaultTarget = selected.get('tenant_core/default');
  const usersTarget = selected.get('tenant_core/users');
  const piiTarget = selected.get('tenant_pii');
  if (!defaultTarget || !usersTarget || !piiTarget) {
    throw new Error('phase0c_runtime_route_incomplete');
  }
  if (
    usersTarget.residencyPolicyId !== piiTarget.residencyPolicyId ||
    usersTarget.residencyPartition !== piiTarget.residencyPartition ||
    usersTarget.bindingRef === piiTarget.bindingRef ||
    usersTarget.shardId === piiTarget.shardId
  ) {
    throw new Error('phase0c_runtime_route_invalid');
  }
  const projection = validateAccountRouteProjection({
    schemaVersion: 1,
    accountRouteGeneration: 1,
    residencyPolicyId: usersTarget.residencyPolicyId,
    targets: [usersTarget, piiTarget].map((target) => ({
      dataRole: target.dataRole,
      residencyPartition: target.residencyPartition,
      shardId: target.shardId,
      bindingRef: target.bindingRef,
      requiredBindingRouteGeneration: target.routeGeneration,
    })),
  });
  return {
    route: {
      tenantId: input.tenantId,
      routeGeneration: projection.accountRouteGeneration,
      projection,
    },
    defaultDatabaseId: defaultTarget.databaseId,
  };
}

async function runtimeState(input: {
  client: Awaited<ReturnType<typeof createSetupOperatorD1Client>>;
  lock: FixtureLock;
  config: FixtureConfig;
}): Promise<{
  route: RuntimeRoute;
  defaultDatabaseId: string;
  assignments: Map<number, BucketAssignment>;
}> {
  const controlDatabaseId = requiredString(
    input.lock.d1.CONTROL_DB?.id,
    'phase0c_control_db_missing'
  );
  const results = await input.client.queryD1Batch(controlDatabaseId, [
    {
      sql: `SELECT assignment.tenant_id, assignment.data_role,
                   assignment.residency_policy_id, assignment.residency_partition,
                   shard.shard_id, shard.generation, shard.binding_ref,
                   observed.provider_resource_id AS database_id
              FROM control_tenant_shard_assignments assignment
              JOIN control_tenant_shards shard
                ON shard.environment_id = assignment.environment_id
               AND shard.shard_id = assignment.shard_id
              JOIN control_desired_resources desired
                ON desired.environment_id = shard.environment_id
               AND desired.desired_resource_id = shard.d1_desired_resource_id
              JOIN control_observed_resources observed
                ON observed.environment_id = desired.environment_id
               AND observed.observed_resource_id = desired.observed_resource_id
             WHERE assignment.environment_id = 'test' AND assignment.tenant_id = ?
               AND assignment.assignment_state = 'active' AND shard.status = 'active'
               AND shard.data_role = assignment.data_role
               AND shard.residency_policy_id = assignment.residency_policy_id
               AND shard.residency_partition = assignment.residency_partition
               AND desired.desired_state = 'present' AND desired.provisioning_state = 'ready'
               AND observed.observed_state = 'present'
             ORDER BY assignment.data_role, assignment.assignment_generation, shard.shard_id`,
      params: [input.config.tenant.name],
    },
    {
      sql: `SELECT assignment.virtual_bucket, assignment.assignment_generation,
                   shard.binding_ref
              FROM control_lookup_bucket_assignments assignment
              JOIN control_lookup_physical_shards shard
                ON shard.lookup_shard_id = assignment.lookup_shard_id
               AND shard.environment_id = assignment.environment_id
             WHERE assignment.environment_id = 'test' AND assignment.state = 'active'
               AND shard.status = 'active'
             ORDER BY assignment.virtual_bucket`,
    },
  ]);
  const shardAssignments = rows<{
    tenant_id: string;
    data_role: RuntimeShardAssignment['dataRole'];
    residency_policy_id: string;
    residency_partition: string;
    shard_id: string;
    generation: number | string;
    binding_ref: string;
    database_id: string;
  }>(results[0], 'phase0c_runtime_route_query_invalid').map((row) => ({
    tenantId: requiredString(row.tenant_id, 'phase0c_runtime_shard_assignment_invalid'),
    dataRole: row.data_role,
    residencyPolicyId: requiredString(
      row.residency_policy_id,
      'phase0c_runtime_shard_assignment_invalid'
    ),
    residencyPartition: requiredString(
      row.residency_partition,
      'phase0c_runtime_shard_assignment_invalid'
    ),
    shardId: requiredString(row.shard_id, 'phase0c_runtime_shard_assignment_invalid'),
    routeGeneration: Number(row.generation),
    bindingRef: requiredString(row.binding_ref, 'phase0c_runtime_shard_assignment_invalid'),
    databaseId: requiredString(row.database_id, 'phase0c_runtime_shard_assignment_invalid'),
  }));
  const runtimeRegistryId = requiredString(
    input.lock.kv.TENANT_RUNTIME_REGISTRY?.id,
    'phase0c_runtime_registry_missing'
  );
  const tenantId = input.config.tenant.name;
  const [snapshotJson, generationJson, verificationJwks] = await Promise.all([
    getKVKeyByNamespaceId(
      runtimeRegistryId,
      buildTenantRuntimeRegistrySnapshotKey(tenantId, 'default')
    ),
    getKVKeyByNamespaceId(
      runtimeRegistryId,
      buildTenantRuntimeRegistryGenerationKey(tenantId, 'default')
    ),
    readFile(resolve(TEST_KEYS_DIR, 'tenant_runtime_registry_verify.jwks.json'), 'utf8'),
  ]);
  const runtime = await buildPhase0cRuntimeState({
    tenantId,
    snapshotJson,
    generationJson,
    verificationJwks,
    shardAssignments,
    lockD1: input.lock.d1,
  });
  const assignments = new Map<number, BucketAssignment>();
  for (const row of rows<{
    virtual_bucket: number;
    assignment_generation: number;
    binding_ref: string;
  }>(results[1], 'phase0c_lookup_assignment_query_invalid')) {
    const bucket = Number(row.virtual_bucket);
    const generation = Number(row.assignment_generation);
    const resource = input.lock.d1[row.binding_ref];
    if (
      !Number.isSafeInteger(bucket) ||
      bucket < 0 ||
      bucket > LOOKUP_MAX_VIRTUAL_BUCKET ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !resource
    ) {
      throw new Error('phase0c_lookup_assignment_invalid');
    }
    assignments.set(bucket, {
      virtualBucket: bucket,
      assignmentGeneration: generation,
      bindingRef: row.binding_ref,
      databaseId: resource.id,
    });
  }
  if (assignments.size !== LOOKUP_VIRTUAL_BUCKET_COUNT) {
    throw new Error('phase0c_lookup_assignment_coverage_incomplete');
  }
  return {
    ...runtime,
    assignments,
  };
}

async function cleanupEntries(input: {
  client: Awaited<ReturnType<typeof createSetupOperatorD1Client>>;
  runId: string;
  databaseIds: readonly string[];
}): Promise<void> {
  for (const databaseId of new Set(input.databaseIds)) {
    const pattern = `${input.runId}-%`;
    const results = await input.client.queryD1Batch(databaseId, [
      {
        sql: 'DELETE FROM lookup_discovery_otp_challenges WHERE rate_limit_device_digest = ?',
        params: [input.runId],
      },
      { sql: 'DELETE FROM lookup_identifiers WHERE account_id LIKE ?', params: [pattern] },
      {
        sql: `SELECT
               (SELECT COUNT(*) FROM lookup_identifiers WHERE account_id LIKE ?) AS identifiers,
               (SELECT COUNT(*) FROM lookup_discovery_otp_challenges
                 WHERE rate_limit_device_digest = ?) AS challenges`,
        params: [pattern, input.runId],
      },
    ]);
    assertBatch(results, 3);
    const verification = rows<{ identifiers: number; challenges: number }>(
      results[2],
      'phase0c_fixture_cleanup_verification_invalid'
    )[0];
    if (Number(verification?.identifiers) !== 0 || Number(verification?.challenges) !== 0) {
      throw new Error('phase0c_fixture_cleanup_incomplete');
    }
  }
}

async function prepare(options: FixtureOptions): Promise<IdentifierFixtureFile> {
  const { lock, config } = await loadState();
  const client = await createSetupOperatorD1Client({
    expectedAccountId: config.cloudflare.accountId,
  });
  const { route, defaultDatabaseId, assignments } = await runtimeState({ client, lock, config });
  const tenantCheck = await client.queryD1(
    defaultDatabaseId,
    "SELECT id FROM tenants WHERE id = ? AND lifecycle_state = 'active'",
    [route.tenantId]
  );
  if (
    rows<{ id: string }>(tenantCheck[0], 'phase0c_tenant_check_invalid')[0]?.id !== route.tenantId
  ) {
    throw new Error('phase0c_tenant_destination_missing');
  }
  const activeSlot = lock.controlKeyState.lookupHmac.activeSlot.toLowerCase();
  const [lookupSecret, otpSecret] = await Promise.all([
    readFile(resolve(TEST_KEYS_DIR, `lookup_hmac_key_slot_${activeSlot}.txt`), 'utf8'),
    readFile(resolve(TEST_KEYS_DIR, 'otp_hmac_secret.txt'), 'utf8'),
  ]);
  if (new TextEncoder().encode(otpSecret.trim()).byteLength < 32) {
    throw new Error('phase0c_otp_secret_invalid');
  }
  const runId = fixtureRunId();
  const entries = await buildPhase0cIdentifierFixtureEntries({
    runId,
    count: TOTAL_ENTRIES,
    lookupSecret: lookupSecret.trim(),
    lookupGeneration: lock.controlKeyState.lookupHmac.activeGeneration,
    otpSecret: otpSecret.trim(),
    assignments,
  });
  const byDatabase = new Map<string, IdentifierFixtureEntry[]>();
  for (const entry of entries) {
    const existing = byDatabase.get(entry.databaseId);
    if (existing) existing.push(entry);
    else byDatabase.set(entry.databaseId, [entry]);
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    for (const [databaseId, databaseEntries] of byDatabase) {
      const batches: CloudflareD1Query[][] = [];
      for (
        let offset = 0;
        offset < databaseEntries.length;
        offset += PHASE0C_FIXTURE_ROWS_PER_STATEMENT
      ) {
        const pair = buildPhase0cFixtureInsertQueries({
          runId,
          entries: databaseEntries.slice(offset, offset + PHASE0C_FIXTURE_ROWS_PER_STATEMENT),
          route,
          now,
        });
        const current = batches.at(-1);
        if (!current || current.length >= STATEMENT_PAIRS_PER_BATCH * 2) batches.push([...pair]);
        else current.push(...pair);
      }
      for (const batch of batches) {
        assertBatch(await client.queryD1Batch(databaseId, batch), batch.length);
      }
    }
  } catch (error) {
    await cleanupEntries({ client, runId, databaseIds: [...byDatabase.keys()] }).catch(() => {});
    throw error;
  }
  const fixture: IdentifierFixtureFile = {
    schemaVersion: 1,
    runId,
    environment: 'test',
    baseUrl: config.urls.api.custom.replace(/\/$/u, ''),
    tenantId: route.tenantId,
    createdAt: new Date().toISOString(),
    entries: entries.map((entry) => ({ challengeId: entry.challengeId, code: entry.code })),
    cleanup: [...byDatabase.keys()].map((databaseId) => ({
      databaseId,
      accountIdPrefix: `${runId}-%`,
    })),
  };
  await mkdir(dirname(options.fixturePath), { recursive: true });
  const handle = await open(options.fixturePath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(fixture)}\n`);
  } finally {
    await handle.close();
  }
  return fixture;
}

async function cleanup(options: FixtureOptions): Promise<IdentifierFixtureFile> {
  const fixture = parseFixtureFile(
    JSON.parse(await readFile(options.fixturePath, 'utf8')) as unknown
  );
  const { config } = await loadState();
  const client = await createSetupOperatorD1Client({
    expectedAccountId: config.cloudflare.accountId,
  });
  await cleanupEntries({
    client,
    runId: fixture.runId,
    databaseIds: fixture.cleanup.map((item) => item.databaseId),
  });
  await rm(options.fixturePath, { force: true });
  return fixture;
}

async function main(): Promise<void> {
  try {
    const options = parsePhase0cIdentifierFixtureArgs(process.argv.slice(2));
    const fixture = options.mode === 'prepare' ? await prepare(options) : await cleanup(options);
    process.stdout.write(
      `${options.mode === 'prepare' ? 'Prepared' : 'Cleaned'} Phase 0c fixture ${fixture.runId}\n`
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'phase0c_fixture_failed'}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
