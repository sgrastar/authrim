#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  getTenantDatabaseResourcePrefix,
  type CloudflareD1QueryResult,
} from '../../packages/ar-lib-core/src/services/control-plane/index.js';
import { planLookupScaleOut } from '../../packages/ar-control/src/lookup-scale-out-planner.js';
import {
  collectControlSnapshot,
  collectProviderSnapshot,
  phase1ObservationRetryCode,
  type Phase1ObservationClient,
} from './observe.js';
import {
  PHASE1_SCHEMA_VERSION,
  assertPhase1EvidenceIsSecretFree,
  deriveLogicalAccountIdentity,
  parsePhase1HarnessConfig,
  sha256,
  stableJson,
  type Phase1Baseline,
  type Phase1ControlSnapshot,
  type Phase1HarnessConfig,
  type Phase1IntegrityResult,
  type Phase1LookupBucketSnapshotRow,
  type Phase1ProviderSnapshot,
} from './schemas.js';
import type { Phase1AccountResult, Phase1RunnerResult } from './run.js';

export interface Phase1VerificationClient extends Phase1ObservationClient {
  queryD1(databaseId: string, sql: string, params?: unknown[]): Promise<CloudflareD1QueryResult[]>;
}

interface PhysicalRow {
  databaseId: string;
  id: string;
  tenantId: string;
  fieldDigest: string;
}

function resultRows(results: CloudflareD1QueryResult[], label: string): Record<string, unknown>[] {
  if (
    results.length !== 1 ||
    results[0]?.success === false ||
    !Array.isArray(results[0]?.results)
  ) {
    throw new Error(`phase1_verification_query_failed:${label}`);
  }
  return results[0].results.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`phase1_verification_row_invalid:${label}`);
    }
    return row as Record<string, unknown>;
  });
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    output.push(values.slice(index, index + size));
  return output;
}

export function normalizePhase1EpochSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value >= 100_000_000_000 ? Math.floor(value / 1_000) : value;
}

async function queryRowsInBatches(input: {
  client: Phase1VerificationClient;
  databaseId: string;
  statements: Array<{ sql: string; params?: unknown[] }>;
  label: string;
}): Promise<Record<string, unknown>[]> {
  const output: Record<string, unknown>[] = [];
  for (const [batchIndex, batch] of chunks(input.statements, 50).entries()) {
    const results = await input.client.queryD1Batch(input.databaseId, batch);
    if (results.length !== batch.length) {
      throw new Error(`phase1_verification_batch_count_mismatch:${input.label}`);
    }
    for (let index = 0; index < results.length; index += 1) {
      output.push(...resultRows([results[index]], `${input.label}:${batchIndex * 50 + index}`));
    }
  }
  return output;
}

export async function collectLookupBucketSnapshot(input: {
  client: Phase1VerificationClient;
  control: Phase1ControlSnapshot;
}): Promise<Phase1LookupBucketSnapshotRow[]> {
  const activeAssignments = input.control.lookupAssignments.filter((row) => row.state === 'active');
  const assignmentByBucket = new Map<number, Record<string, unknown>>();
  for (const assignment of activeAssignments) {
    const bucket = assignment.virtual_bucket;
    if (
      !Number.isSafeInteger(bucket) ||
      (bucket as number) < 0 ||
      (bucket as number) > 4_095 ||
      assignmentByBucket.has(bucket as number)
    ) {
      throw new Error('phase1_lookup_assignment_invalid');
    }
    assignmentByBucket.set(bucket as number, assignment);
  }
  if (assignmentByBucket.size !== 4_096) throw new Error('phase1_lookup_assignment_incomplete');

  const shardById = new Map(
    input.control.lookupShards.map((row) => [String(row.lookup_shard_id), row] as const)
  );
  const bucketsByDatabase = new Map<
    string,
    { lookupShardId: string; buckets: number[]; generations: Map<number, number> }
  >();
  for (const [bucket, assignment] of assignmentByBucket) {
    const lookupShardId = String(assignment.lookup_shard_id);
    const shard = shardById.get(lookupShardId);
    const databaseId =
      shard && typeof shard.provider_resource_id === 'string' ? shard.provider_resource_id : null;
    const generation = assignment.assignment_generation;
    if (!databaseId || !Number.isSafeInteger(generation) || (generation as number) < 1) {
      throw new Error('phase1_lookup_assignment_target_invalid');
    }
    const group = bucketsByDatabase.get(databaseId) ?? {
      lookupShardId,
      buckets: [],
      generations: new Map<number, number>(),
    };
    if (group.lookupShardId !== lookupShardId) {
      throw new Error('phase1_lookup_database_shared_by_multiple_shards');
    }
    group.buckets.push(bucket);
    group.generations.set(bucket, generation as number);
    bucketsByDatabase.set(databaseId, group);
  }

  const perDatabase = await boundedMap(
    [...bucketsByDatabase.entries()],
    4,
    async ([databaseId, group]) => {
      const statements = chunks(group.buckets, 90).map((buckets) => ({
        sql: `SELECT c.virtual_bucket, c.successful_route_publication_count,
                     (SELECT COUNT(*) FROM lookup_identifiers identifiers
                       WHERE identifiers.virtual_bucket = c.virtual_bucket
                         AND identifiers.lifecycle_state = 'active') AS active_route_count
                FROM lookup_bucket_counters c
               WHERE c.virtual_bucket IN (${buckets.map(() => '?').join(',')})
               ORDER BY c.virtual_bucket`,
        params: buckets,
      }));
      const rows = await queryRowsInBatches({
        client: input.client,
        databaseId,
        statements,
        label: `lookup_counters:${databaseId}`,
      });
      const seen = new Set<number>();
      const output = rows.map((row): Phase1LookupBucketSnapshotRow => {
        const bucket = row.virtual_bucket;
        const publications = row.successful_route_publication_count;
        const activeRoutes = row.active_route_count;
        const assignmentGeneration = group.generations.get(Number(bucket));
        if (
          !Number.isSafeInteger(bucket) ||
          !Number.isSafeInteger(assignmentGeneration) ||
          seen.has(bucket as number) ||
          !Number.isSafeInteger(publications) ||
          (publications as number) < 0 ||
          !Number.isSafeInteger(activeRoutes) ||
          (activeRoutes as number) < 0
        ) {
          throw new Error('phase1_lookup_counter_row_invalid');
        }
        seen.add(bucket as number);
        return {
          virtualBucket: bucket as number,
          lookupShardId: group.lookupShardId,
          databaseId,
          assignmentGeneration: assignmentGeneration as number,
          successfulRoutePublicationCount: publications as number,
          activeRouteCount: activeRoutes as number,
        };
      });
      if (seen.size !== group.buckets.length) throw new Error('phase1_lookup_counter_incomplete');
      return output;
    }
  );
  return perDatabase.flat().sort((left, right) => left.virtualBucket - right.virtualBucket);
}

async function boundedMap<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await operation(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function providerDatabaseIds(
  snapshot: Phase1ControlSnapshot,
  role: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii'
): string[] {
  const relevantShardIds =
    role === 'tenant_core/default'
      ? new Set(
          snapshot.tenantAssignments
            .filter((row) => row.data_role === role && row.assignment_state === 'active')
            .map((row) => String(row.shard_id))
        )
      : new Set(
          snapshot.tenantAllocations
            .filter(
              (row) =>
                row.row_kind === 'distribution' &&
                row.data_role === role &&
                row.reservation_state === 'committed'
            )
            .map((row) => String(row.selected_shard_id))
        );
  return snapshot.shardCapacities
    .filter(
      (row) =>
        row.data_role === role &&
        relevantShardIds.has(String(row.shard_id)) &&
        (row.status === 'active' || row.status === 'ready') &&
        typeof row.provider_resource_id === 'string'
    )
    .map((row) => String(row.provider_resource_id));
}

async function queryPhysicalRows(input: {
  client: Phase1VerificationClient;
  databaseIds: string[];
  storageRole: 'core' | 'pii';
  userIds: string[];
}): Promise<PhysicalRow[]> {
  const perDatabase = await boundedMap(
    input.databaseIds,
    4,
    async (databaseId): Promise<PhysicalRow[]> => {
      const statements = chunks(input.userIds, 90).map((ids) => {
        const placeholders = ids.map(() => '?').join(',');
        return {
          sql:
            input.storageRole === 'core'
              ? `SELECT account.legacy_user_id AS id, account.tenant_id,
                        CASE WHEN EXISTS (
                          SELECT 1 FROM contact_points contact
                           WHERE contact.tenant_id = account.tenant_id
                             AND contact.account_id = account.id
                             AND contact.contact_type = 'email'
                             AND contact.verification_state = 'verified'
                             AND contact.lifecycle_state = 'active'
                        ) THEN 1 ELSE 0 END AS email_verified,
                        CASE WHEN EXISTS (
                          SELECT 1 FROM contact_points contact
                           WHERE contact.tenant_id = account.tenant_id
                             AND contact.account_id = account.id
                             AND contact.contact_type = 'phone'
                             AND contact.verification_state = 'verified'
                             AND contact.lifecycle_state = 'active'
                        ) THEN 1 ELSE 0 END AS phone_number_verified,
                        CASE WHEN account.lifecycle_state = 'active' THEN 1 ELSE 0 END AS is_active,
                        CASE WHEN account.account_type = 'user' THEN 'end_user'
                             ELSE account.account_type END AS user_type
                   FROM identity_accounts account
                  WHERE account.legacy_user_id IN (${placeholders})`
              : `SELECT owner_id AS id, tenant_id,
                        MAX(CASE WHEN value_key = 'email' THEN value_json END) AS email_json,
                        MAX(CASE WHEN value_key = 'preferred_username' THEN value_json END)
                          AS preferred_username_json
                   FROM identity_sensitive_values
                  WHERE owner_type = 'runtime_user' AND lifecycle_state = 'active'
                    AND value_key IN ('email', 'preferred_username')
                    AND owner_id IN (${placeholders})
                  GROUP BY owner_id, tenant_id`,
          params: ids,
        };
      });
      const rows = await queryRowsInBatches({
        client: input.client,
        databaseId,
        statements,
        label: `${input.storageRole}:${databaseId}`,
      });
      return rows.map((row) => {
        if (typeof row.id !== 'string' || typeof row.tenant_id !== 'string') {
          throw new Error(`phase1_physical_row_invalid:${input.storageRole}`);
        }
        const email = typeof row.email_json === 'string' ? parseJsonString(row.email_json) : null;
        const preferredUsername =
          typeof row.preferred_username_json === 'string'
            ? parseJsonString(row.preferred_username_json)
            : null;
        const fieldDigest =
          input.storageRole === 'core'
            ? stableJson({
                emailVerified: row.email_verified,
                phoneNumberVerified: row.phone_number_verified,
                active: row.is_active,
                userType: row.user_type,
              })
            : email !== null
              ? stableJson({
                  emailDigest: sha256(email),
                  preferredUsername,
                })
              : '';
        return { databaseId, id: row.id, tenantId: row.tenant_id, fieldDigest };
      });
    }
  );
  return perDatabase.flat();
}

async function queryShardCounts(input: {
  client: Phase1VerificationClient;
  databaseIds: string[];
  storageRole: 'core' | 'pii';
}): Promise<Map<string, number>> {
  const entries = await boundedMap(input.databaseIds, 8, async (databaseId) => {
    const sql =
      input.storageRole === 'core'
        ? `SELECT COUNT(*) AS row_count FROM identity_accounts`
        : `SELECT COUNT(DISTINCT owner_id) AS row_count
             FROM identity_sensitive_values
            WHERE owner_type = 'runtime_user' AND value_key = 'email'
              AND lifecycle_state = 'active'`;
    const rows = resultRows(
      await input.client.queryD1(databaseId, sql),
      `count:${input.storageRole}:${databaseId}`
    );
    const count = rows[0]?.row_count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`phase1_shard_count_invalid:${input.storageRole}`);
    }
    return [databaseId, count] as const;
  });
  return new Map(entries);
}

function parseJsonString(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

async function queryPendingCoreState(input: {
  client: Phase1VerificationClient;
  operationDatabaseIds: string[];
  outboxDatabaseIds: string[];
  userIds: string[];
}): Promise<{ pendingOperations: number; pendingOutbox: number }> {
  const operationRows = (
    await boundedMap(input.operationDatabaseIds, 4, async (databaseId) => {
      const operationStatements = chunks(input.userIds, 90).map((ids) => ({
        sql: `SELECT account_id, status FROM account_creation_operations
              WHERE user_id IN (${ids.map(() => '?').join(',')})`,
        params: ids,
      }));
      return queryRowsInBatches({
        client: input.client,
        databaseId,
        statements: operationStatements,
        label: `account_operations:${databaseId}`,
      });
    })
  ).flat();
  const pendingOperations = operationRows.filter((row) => row.status !== 'succeeded').length;
  const accountIds = operationRows.flatMap((row) =>
    typeof row.account_id === 'string' ? [row.account_id] : []
  );
  const outboxRows = (
    await boundedMap(input.outboxDatabaseIds, 4, async (databaseId) => {
      const outboxStatements = chunks(accountIds, 90).map((accountIdChunk) => ({
        sql: `SELECT status FROM account_routing_outbox
              WHERE account_id IN (${accountIdChunk.map(() => '?').join(',')})
                AND status <> 'succeeded'`,
        params: accountIdChunk,
      }));
      return queryRowsInBatches({
        client: input.client,
        databaseId,
        statements: outboxStatements,
        label: `routing_outbox:${databaseId}`,
      });
    })
  ).flat();
  return { pendingOperations, pendingOutbox: outboxRows.length };
}

function occurrenceCounts(rows: PhysicalRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  return counts;
}

export async function verifyExactLookupRoutes(input: {
  config: Phase1HarnessConfig;
  runId: string;
  seed: string;
  token: string;
  accounts: Phase1AccountResult[];
  fetcher?: typeof fetch;
}): Promise<number> {
  const fetcher = input.fetcher ?? fetch;
  const mismatches = await boundedMap(
    input.accounts,
    Math.min(64, input.config.load.maximumInFlight),
    async (account) => {
      if (!account.userId) return 1;
      const identity = deriveLogicalAccountIdentity({
        seed: input.seed,
        runId: input.runId,
        accountIndex: account.accountIndex,
        emailDomain: input.config.environment.emailDomain,
      });
      try {
        const response = await fetcher(
          new URL(
            `/api/admin/users?search=${encodeURIComponent(identity.email)}`,
            input.config.environment.baseUrl
          ),
          {
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${input.token}`,
              'X-Tenant-Id': input.config.environment.tenantId,
            },
            redirect: 'error',
            signal: AbortSignal.timeout(input.config.load.requestTimeoutMs),
          }
        );
        if (!response.ok) return 1;
        const payload: unknown = await response.json();
        const users =
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as { users?: unknown }).users
            : null;
        const matches = Array.isArray(users)
          ? users.filter(
              (user) =>
                !!user &&
                typeof user === 'object' &&
                !Array.isArray(user) &&
                (user as { id?: unknown }).id === account.userId
            )
          : [];
        return matches.length === 1 ? 0 : 1;
      } catch {
        return 1;
      }
    }
  );
  return mismatches.reduce<number>((sum, value) => sum + value, 0);
}

export async function waitForExactLookupRouteReadiness(input: {
  config: Phase1HarnessConfig;
  runId: string;
  seed: string;
  account: Phase1AccountResult;
  getToken(): Promise<string>;
  fetcher?: typeof fetch;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  if (!input.account.userId) throw new Error('phase1_lookup_readiness_account_invalid');
  const fetcher = input.fetcher ?? fetch;
  const nowMs = input.nowMs ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline =
    nowMs() + Math.min(input.config.observation.quiescenceTimeoutSeconds, 30 * 60) * 1_000;
  const identity = deriveLogicalAccountIdentity({
    seed: input.seed,
    runId: input.runId,
    accountIndex: input.account.accountIndex,
    emailDomain: input.config.environment.emailDomain,
  });
  while (nowMs() <= deadline) {
    const response = await fetcher(
      new URL(
        `/api/admin/users?search=${encodeURIComponent(identity.email)}`,
        input.config.environment.baseUrl
      ),
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${await input.getToken()}`,
          'X-Tenant-Id': input.config.environment.tenantId,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(input.config.load.requestTimeoutMs),
      }
    );
    if (response.ok) {
      const payload: unknown = await response.json();
      const users =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as { users?: unknown }).users
          : null;
      if (
        Array.isArray(users) &&
        users.filter(
          (user) =>
            !!user &&
            typeof user === 'object' &&
            !Array.isArray(user) &&
            (user as { id?: unknown }).id === input.account.userId
        ).length === 1
      ) {
        return;
      }
      throw new Error('phase1_lookup_readiness_route_mismatch');
    }
    if (response.status !== 503) {
      throw new Error(`phase1_lookup_readiness_http_${response.status}`);
    }
    const retryAfter = Number(response.headers.get('Retry-After') ?? '5');
    await sleep(
      Math.max(1_000, Math.min(Number.isFinite(retryAfter) ? retryAfter * 1_000 : 5_000, 30_000))
    );
  }
  throw new Error('phase1_lookup_readiness_timeout');
}

function capacityVector(snapshot: Phase1ControlSnapshot): string {
  return stableJson({
    shards: snapshot.shardCapacities.map((row) => ({
      id: row.shard_id,
      allocated: row.allocated_account_count,
      observed: row.observed_account_count,
      status: row.status,
      allocation: row.allocation_status,
    })),
    lookup: snapshot.lookupShards.map((row) => ({ id: row.lookup_shard_id, status: row.status })),
    forecasts: snapshot.lookupForecasts.map((row) => ({
      domain: row.lookup_capacity_domain_id,
      state: row.decision_state,
      generation: row.decision_generation,
      operation: row.requested_operation_id,
    })),
  });
}

export function countInProgressControlOperations(snapshot: Phase1ControlSnapshot): number {
  return snapshot.operations.filter((row) =>
    ['queued', 'running', 'waiting_retry'].includes(String(row.status))
  ).length;
}

export function countLookupAssignmentTransitionsToNewShards(
  baseline: Phase1Baseline,
  current: Phase1ControlSnapshot
): number {
  const baselineShardIds = new Set(
    baseline.control.lookupShards.map((row) => String(row.lookup_shard_id))
  );
  const newShardIds = new Set(
    current.lookupShards
      .filter(
        (row) => row.status === 'active' && !baselineShardIds.has(String(row.lookup_shard_id))
      )
      .map((row) => String(row.lookup_shard_id))
  );
  const baselineAssignments = new Map(
    baseline.control.lookupAssignments.map((row) => [Number(row.virtual_bucket), row] as const)
  );
  return current.lookupAssignments.filter((row) => {
    const previous = baselineAssignments.get(Number(row.virtual_bucket));
    return (
      !!previous &&
      row.state === 'active' &&
      previous.lookup_shard_id !== row.lookup_shard_id &&
      Number(row.assignment_generation) > Number(previous.assignment_generation) &&
      newShardIds.has(String(row.lookup_shard_id))
    );
  }).length;
}

export async function waitForPhase1Quiescence(input: {
  config: Phase1HarnessConfig;
  client: Phase1ObservationClient;
  baseline?: Phase1Baseline;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  collectControl?: () => Promise<Phase1ControlSnapshot>;
}): Promise<Phase1ControlSnapshot> {
  const nowMs = input.nowMs ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = nowMs() + input.config.observation.quiescenceTimeoutSeconds * 1_000;
  let previousVector = '';
  let stableWindows = 0;
  let latest: Phase1ControlSnapshot | null = null;
  while (nowMs() <= deadline) {
    try {
      latest = input.collectControl
        ? await input.collectControl()
        : await collectControlSnapshot({ config: input.config, client: input.client });
    } catch (error) {
      if (!phase1ObservationRetryCode(error)) throw error;
      stableWindows = 0;
      await sleep(input.config.observation.controlIntervalMs);
      continue;
    }
    const inProgressOperations = countInProgressControlOperations(latest);
    const movingBuckets = latest.lookupAssignments.filter((row) => row.state !== 'active').length;
    const provisioningForecasts = latest.lookupForecasts.filter(
      (row) => row.decision_state === 'provisioning'
    ).length;
    const requiredLookupTransitionsReached =
      !input.baseline ||
      countLookupAssignmentTransitionsToNewShards(input.baseline, latest) >=
        input.config.expectedPolicy.minimumLookupUsedAssignmentTransitions;
    const vector = capacityVector(latest);
    if (
      inProgressOperations === 0 &&
      movingBuckets === 0 &&
      provisioningForecasts === 0 &&
      requiredLookupTransitionsReached &&
      vector === previousVector
    ) {
      stableWindows += 1;
      if (stableWindows >= input.config.observation.quiescenceStableWindows) return latest;
    } else {
      stableWindows = 0;
    }
    previousVector = vector;
    await sleep(input.config.observation.controlIntervalMs);
  }
  throw new Error(`phase1_quiescence_timeout:${latest?.observedAt ?? 'no_observation'}`);
}

export function recomputeLookupForecastTransition(input: {
  previous: Record<string, unknown> | null;
  current: Record<string, unknown>;
  policy: Record<string, unknown>;
  capacityWeightMilliunits: number;
}): boolean {
  const integer = (row: Record<string, unknown> | null, key: string): number | null => {
    const value = row?.[key];
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  };
  const plan = planLookupScaleOut({
    observedAt: integer(input.current, 'observed_at') ?? -1,
    observedActiveRouteCount: integer(input.current, 'observed_active_route_count') ?? -1,
    observedSuccessfulPublicationCount:
      integer(input.current, 'observed_successful_publication_count') ?? -1,
    previousObservedAt: integer(input.previous, 'observed_at'),
    previousSuccessfulPublicationCount: integer(
      input.previous,
      'observed_successful_publication_count'
    ),
    previousEwmaRateMicrorowsPerSecond: integer(input.previous, 'ewma_rate_microrows_per_second'),
    forecastHorizonSeconds: integer(input.policy, 'lookup_forecast_horizon_seconds') ?? -1,
    ewmaAlphaBps: integer(input.policy, 'lookup_registration_ewma_alpha_bps') ?? -1,
    headroomBps: integer(input.policy, 'lookup_scale_out_headroom_bps') ?? -1,
    targetActiveRouteCountPerUnit: integer(input.policy, 'lookup_target_active_route_count') ?? -1,
    capacityWeightMilliunits: input.capacityWeightMilliunits,
    capacityUnitCount: integer(input.current, 'capacity_unit_count') ?? -1,
  });
  return (
    plan.sampleIntervalSeconds === integer(input.current, 'sample_interval_seconds') &&
    plan.sampleRateMicrorowsPerSecond ===
      integer(input.current, 'sample_rate_microrows_per_second') &&
    plan.ewmaRateMicrorowsPerSecond === integer(input.current, 'ewma_rate_microrows_per_second') &&
    plan.forecastNewRouteCount === integer(input.current, 'forecast_new_route_count') &&
    plan.projectedActiveRouteCount === integer(input.current, 'projected_active_route_count') &&
    plan.usableCapacityRouteCount === integer(input.current, 'usable_capacity_route_count')
  );
}

export function verifyLookupForecastEvents(input: {
  events: Array<Record<string, unknown>>;
  policy: Record<string, unknown>;
}): number {
  let mismatches = 0;
  const lastPublicationCount = new Map<string, number>();
  for (const event of input.events) {
    if (event.entity !== 'lookupForecasts') continue;
    const current =
      event.current && typeof event.current === 'object' && !Array.isArray(event.current)
        ? (event.current as Record<string, unknown>)
        : null;
    const previous =
      event.previous && typeof event.previous === 'object' && !Array.isArray(event.previous)
        ? (event.previous as Record<string, unknown>)
        : null;
    if (!current) continue;
    const domain = current.lookup_capacity_domain_id;
    const publications = current.observed_successful_publication_count;
    const capacityUnits = current.capacity_unit_count;
    if (
      typeof domain !== 'string' ||
      typeof publications !== 'number' ||
      !Number.isSafeInteger(publications) ||
      typeof capacityUnits !== 'number' ||
      !Number.isSafeInteger(capacityUnits)
    ) {
      mismatches += 1;
      continue;
    }
    const last = lastPublicationCount.get(domain);
    if (last !== undefined && publications < last) mismatches += 1;
    lastPublicationCount.set(domain, publications);
    const currentObservedAt = current.observed_at;
    const previousObservedAt = previous?.observed_at;
    const sampleInterval = current.sample_interval_seconds;
    if (
      typeof currentObservedAt !== 'number' ||
      !Number.isSafeInteger(currentObservedAt) ||
      !Number.isSafeInteger(sampleInterval)
    ) {
      mismatches += 1;
      continue;
    }
    if (
      typeof previousObservedAt === 'number' &&
      Number.isSafeInteger(previousObservedAt) &&
      currentObservedAt < previousObservedAt
    ) {
      mismatches += 1;
      continue;
    }
    const isForecastObservation =
      !previous ||
      (typeof previousObservedAt === 'number' &&
        Number.isSafeInteger(previousObservedAt) &&
        currentObservedAt > previousObservedAt &&
        sampleInterval === currentObservedAt - previousObservedAt);
    if (!isForecastObservation) continue;
    try {
      if (
        !recomputeLookupForecastTransition({
          previous,
          current,
          policy: input.policy,
          capacityWeightMilliunits: capacityUnits * 1_000,
        })
      ) {
        mismatches += 1;
      }
    } catch {
      mismatches += 1;
    }
  }
  return mismatches;
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return source
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('phase1_control_event_invalid');
      }
      return value as Record<string, unknown>;
    });
}

export function duplicateForecastDecisions(snapshot: Phase1ControlSnapshot): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of snapshot.operations) {
    const key = row.idempotency_key;
    if (typeof key !== 'string' || !key.startsWith('lookup-forecast:')) continue;
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
  }
  return duplicates;
}

export function countNewBlockedCapacityOperations(
  baseline: Phase1ControlSnapshot,
  current: Phase1ControlSnapshot
): number {
  const baselineOperationIds = new Set(baseline.operations.map((row) => String(row.operation_id)));
  return current.operations.filter(
    (row) =>
      !baselineOperationIds.has(String(row.operation_id)) &&
      row.operation_kind === 'provision_shard' &&
      (row.status === 'blocked' || row.status === 'waiting_retry')
  ).length;
}

export function countRoleBoundaryCrossings(
  baseline: Phase1ControlSnapshot,
  current: Phase1ControlSnapshot,
  role: 'tenant_core/users' | 'tenant_pii'
): number {
  const count = (snapshot: Phase1ControlSnapshot) =>
    snapshot.tenantAssignments.filter(
      (row) => row.data_role === role && row.assignment_state === 'active'
    ).length;
  return Math.max(0, count(current) - count(baseline));
}

function roleInventory(
  snapshot: Phase1ControlSnapshot,
  config: Phase1HarnessConfig,
  role: 'tenant_core/users' | 'tenant_pii'
): Record<string, unknown>[] {
  return snapshot.shardCapacities.filter(
    (row) =>
      row.data_role === role &&
      row.allocation_scope === config.environment.placementPolicy &&
      (config.environment.placementPolicy === 'shared_pool'
        ? row.owner_tenant_id === null
        : row.owner_tenant_id === config.environment.tenantId) &&
      row.status !== 'deleted'
  );
}

export function evaluateRoleProvisioningBound(input: {
  baseline: Phase1ControlSnapshot;
  current: Phase1ControlSnapshot;
  config: Phase1HarnessConfig;
  role: 'tenant_core/users' | 'tenant_pii';
  submittedAccounts: number;
}): { physicalAdditions: number; maximumAdditions: number; excessProvisioning: number } {
  const baseline = roleInventory(input.baseline, input.config, input.role);
  const current = roleInventory(input.current, input.config, input.role);
  const allocated = baseline.reduce(
    (sum, row) =>
      sum + (typeof row.allocated_account_count === 'number' ? row.allocated_account_count : 0),
    0
  );
  const target = input.config.expectedPolicy.targetAccountCount;
  const minimumUnits = Math.ceil((allocated + input.submittedAccounts) / target);
  const minimumAdditions = Math.max(0, minimumUnits - baseline.length);
  const maxReadySpares =
    typeof input.current.resourcePolicy?.max_ready_spares === 'number'
      ? Math.max(0, input.current.resourcePolicy.max_ready_spares)
      : 0;
  const maximumAdditions = minimumAdditions + maxReadySpares;
  const physicalAdditions = Math.max(0, current.length - baseline.length);
  return {
    physicalAdditions,
    maximumAdditions,
    excessProvisioning: Math.max(0, physicalAdditions - maximumAdditions),
  };
}

export function reconcilePublicationCounterSeries(input: {
  observations: Array<{ at: number; counter: number; successfulEventIds: string[] }>;
}): { decreases: number; deltaMismatches: number; duplicateEventIds: number } {
  let decreases = 0;
  let deltaMismatches = 0;
  let duplicateEventIds = 0;
  for (let index = 0; index < input.observations.length; index += 1) {
    const current = input.observations[index];
    if (
      !Number.isSafeInteger(current.at) ||
      !Number.isSafeInteger(current.counter) ||
      current.counter < 0
    ) {
      throw new Error('phase1_publication_counter_observation_invalid');
    }
    const uniqueEvents = new Set(current.successfulEventIds);
    duplicateEventIds += current.successfulEventIds.length - uniqueEvents.size;
    if (index === 0) continue;
    const previous = input.observations[index - 1];
    if (current.at <= previous.at) throw new Error('phase1_publication_counter_time_invalid');
    const delta = current.counter - previous.counter;
    if (delta < 0) decreases += 1;
    if (delta !== uniqueEvents.size) deltaMismatches += 1;
  }
  return { decreases, deltaMismatches, duplicateEventIds };
}

const AUTOMATIC_ADMIN_OPERATION_PREFIXES = [
  'account-capacity:',
  'low-water:',
  'tenant-runtime-route:',
] as const;

export function countManualInterventions(input: {
  baseline: Phase1Baseline;
  finalControl: Phase1ControlSnapshot;
}): number {
  const baselineAt = Math.floor(Date.parse(input.baseline.capturedAt) / 1_000);
  const baselineOperationIds = new Set(
    input.baseline.control.operations.flatMap((row) =>
      typeof row.operation_id === 'string' ? [row.operation_id] : []
    )
  );
  return input.finalControl.operations.filter((row) => {
    if (row.requested_by_type !== 'admin' && row.requested_by_type !== 'setup') return false;
    if (typeof row.operation_id === 'string' && baselineOperationIds.has(row.operation_id)) {
      return false;
    }
    const idempotencyKey = typeof row.idempotency_key === 'string' ? row.idempotency_key : null;
    if (
      idempotencyKey !== null &&
      AUTOMATIC_ADMIN_OPERATION_PREFIXES.some((prefix) => idempotencyKey.startsWith(prefix))
    ) {
      return false;
    }
    const createdAt = normalizePhase1EpochSeconds(row.created_at);
    return createdAt !== null && createdAt >= baselineAt;
  }).length;
}

export async function verifyPhase1Run(input: {
  config: Phase1HarnessConfig;
  runId: string;
  seed: string;
  adminToken: string;
  baseline: Phase1Baseline;
  runner: Phase1RunnerResult;
  client: Phase1VerificationClient;
  fetcher?: typeof fetch;
  finalControl?: Phase1ControlSnapshot;
  finalProvider?: Phase1ProviderSnapshot;
  finalLookupBuckets?: Phase1LookupBucketSnapshotRow[];
  controlEventsPath?: string;
}): Promise<Phase1IntegrityResult> {
  const finalControl =
    input.finalControl ??
    (await waitForPhase1Quiescence({
      config: input.config,
      client: input.client,
      baseline: input.baseline,
    }));
  const finalProvider =
    input.finalProvider ?? (await collectProviderSnapshot({ client: input.client }));
  const finalLookupBuckets =
    input.finalLookupBuckets ??
    (await collectLookupBucketSnapshot({
      client: input.client,
      control: finalControl,
    }));
  const succeeded = input.runner.accounts.filter((account) => account.userId !== null);
  const submittedAccounts = input.runner.metrics.scheduled;
  const userIds = succeeded.flatMap((account) => (account.userId ? [account.userId] : []));
  const uniqueUserIds = new Set(userIds);
  const defaultCoreDatabaseIds = providerDatabaseIds(finalControl, 'tenant_core/default');
  const coreDatabaseIds = providerDatabaseIds(finalControl, 'tenant_core/users');
  const piiDatabaseIds = providerDatabaseIds(finalControl, 'tenant_pii');
  const [coreRows, piiRows, coreCounts, piiCounts, pending, lookupRouteMismatches] =
    await Promise.all([
      queryPhysicalRows({
        client: input.client,
        databaseIds: coreDatabaseIds,
        storageRole: 'core',
        userIds,
      }),
      queryPhysicalRows({
        client: input.client,
        databaseIds: piiDatabaseIds,
        storageRole: 'pii',
        userIds,
      }),
      queryShardCounts({
        client: input.client,
        databaseIds: coreDatabaseIds,
        storageRole: 'core',
      }),
      queryShardCounts({
        client: input.client,
        databaseIds: piiDatabaseIds,
        storageRole: 'pii',
      }),
      queryPendingCoreState({
        client: input.client,
        operationDatabaseIds: defaultCoreDatabaseIds,
        outboxDatabaseIds: coreDatabaseIds,
        userIds,
      }),
      verifyExactLookupRoutes({
        config: input.config,
        runId: input.runId,
        seed: input.seed,
        token: input.adminToken,
        accounts: succeeded,
        fetcher: input.fetcher,
      }),
    ]);
  const coreOccurrences = occurrenceCounts(coreRows);
  const piiOccurrences = occurrenceCounts(piiRows);
  const lostAccounts = userIds.filter((id) => (coreOccurrences.get(id) ?? 0) === 0).length;
  const duplicateCoreAccounts = userIds.filter((id) => (coreOccurrences.get(id) ?? 0) > 1).length;
  const duplicatePiiAccounts = userIds.filter((id) => (piiOccurrences.get(id) ?? 0) !== 1).length;
  const crossTenantWrites = [...coreRows, ...piiRows].filter(
    (row) => row.tenantId !== input.config.environment.tenantId
  ).length;
  const accountById = new Map(
    succeeded.flatMap((account) => (account.userId ? [[account.userId, account] as const] : []))
  );
  const expectedPiiFieldsById = new Map(
    succeeded.flatMap((account) => {
      if (!account.userId) return [];
      const identity = deriveLogicalAccountIdentity({
        seed: input.seed,
        runId: input.runId,
        accountIndex: account.accountIndex,
        emailDomain: input.config.environment.emailDomain,
      });
      return [
        [
          account.userId,
          stableJson({
            emailDigest: identity.emailDigest,
            preferredUsername: `phase1-${identity.emailDigest.slice(0, 24)}`,
          }),
        ] as const,
      ];
    })
  );
  const expectedCoreFields = stableJson({
    emailVerified: 1,
    phoneNumberVerified: 0,
    active: 1,
    userType: 'end_user',
  });
  const fieldLevelMismatches =
    coreRows.filter((row) => row.fieldDigest !== expectedCoreFields).length +
    piiRows.filter(
      (row) => !accountById.has(row.id) || expectedPiiFieldsById.get(row.id) !== row.fieldDigest
    ).length;

  const countMismatches = finalControl.shardCapacities.filter((row) => {
    const role = row.data_role;
    if (role !== 'tenant_core/users' && role !== 'tenant_pii') return false;
    const databaseId =
      typeof row.provider_resource_id === 'string' ? row.provider_resource_id : null;
    const relevantDatabaseIds = role === 'tenant_core/users' ? coreDatabaseIds : piiDatabaseIds;
    if (!databaseId || !relevantDatabaseIds.includes(databaseId)) return false;
    const physical =
      role === 'tenant_core/users' ? coreCounts.get(databaseId) : piiCounts.get(databaseId);
    return (
      physical === undefined ||
      (typeof row.observed_account_count === 'number' && row.observed_account_count !== physical) ||
      (typeof row.allocated_account_count === 'number' && row.allocated_account_count !== physical)
    );
  }).length;
  const allocationSummary =
    finalControl.tenantAllocations.find((row) => row.row_kind === 'summary') ?? null;
  const allocationNumber = (row: Record<string, unknown> | null, key: string): number | null => {
    const value = row?.[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  let allocationMismatches = 0;
  if (allocationNumber(allocationSummary, 'allocation_count') !== submittedAccounts * 2) {
    allocationMismatches += 1;
  }
  if (allocationNumber(allocationSummary, 'distinct_account_count') !== submittedAccounts) {
    allocationMismatches += 1;
  }
  for (const field of [
    'invalid_state_count',
    'missing_capacity_count',
    'invalid_shard_count',
    'invalid_account_role_count',
  ]) {
    if (allocationNumber(allocationSummary, field) !== 0) allocationMismatches += 1;
  }
  for (const role of ['tenant_core/users', 'tenant_pii']) {
    const roleCount = finalControl.tenantAllocations
      .filter((row) => row.row_kind === 'distribution' && row.data_role === role)
      .reduce((sum, row) => sum + (allocationNumber(row, 'allocation_count') ?? 0), 0);
    if (roleCount !== submittedAccounts) allocationMismatches += 1;
  }

  const coreBoundaryCrossings = countRoleBoundaryCrossings(
    input.baseline.control,
    finalControl,
    'tenant_core/users'
  );
  const piiBoundaryCrossings = countRoleBoundaryCrossings(
    input.baseline.control,
    finalControl,
    'tenant_pii'
  );
  const baselineLookup = new Set(
    input.baseline.control.lookupShards.map((row) => String(row.lookup_shard_id))
  );
  const newLookupShards = finalControl.lookupShards.filter(
    (row) => !baselineLookup.has(String(row.lookup_shard_id)) && row.status === 'active'
  );
  const baselineLookupBuckets = new Map(
    input.baseline.lookupBuckets.map((row) => [row.virtualBucket, row] as const)
  );
  const newLookupShardIds = new Set(newLookupShards.map((row) => String(row.lookup_shard_id)));
  let publicationCounterDecreases = 0;
  let publicationCounterDeltaMismatches = 0;
  for (const current of finalLookupBuckets) {
    const previous = baselineLookupBuckets.get(current.virtualBucket);
    if (!previous) {
      publicationCounterDeltaMismatches += 1;
      continue;
    }
    const publicationDelta =
      current.successfulRoutePublicationCount - previous.successfulRoutePublicationCount;
    const activeRouteDelta = current.activeRouteCount - previous.activeRouteCount;
    if (publicationDelta < 0) publicationCounterDecreases += 1;
    if (publicationDelta !== activeRouteDelta) publicationCounterDeltaMismatches += 1;
  }
  const lookupUsedAssignmentTransitions = finalLookupBuckets.filter((current) => {
    const previous = baselineLookupBuckets.get(current.virtualBucket);
    return (
      !!previous &&
      previous.lookupShardId !== current.lookupShardId &&
      current.assignmentGeneration > previous.assignmentGeneration &&
      newLookupShardIds.has(current.lookupShardId) &&
      current.activeRouteCount > 0
    );
  }).length;

  const baselineProvider = new Set(
    input.baseline.provider.databases.map((database) => database.uuid)
  );
  const environmentName =
    typeof finalControl.environment?.environment_name === 'string'
      ? finalControl.environment.environment_name
      : null;
  const providerPrefix = environmentName
    ? `${getTenantDatabaseResourcePrefix(environmentName)}-`
    : null;
  const providerAdditions = finalProvider.databases.filter(
    (database) =>
      !baselineProvider.has(database.uuid) &&
      providerPrefix !== null &&
      database.name.startsWith(providerPrefix)
  );
  const controlledProviderIds = new Set(
    [...finalControl.shardCapacities, ...finalControl.lookupShards].flatMap((row) =>
      typeof row.provider_resource_id === 'string' ? [row.provider_resource_id] : []
    )
  );
  const orphanD1Resources = providerAdditions.filter(
    (database) => !controlledProviderIds.has(database.uuid)
  ).length;
  const providerInventory = new Set(finalProvider.databases.map((database) => database.uuid));
  const logicalResources = [
    ...finalControl.shardCapacities
      .filter(
        (row) =>
          (row.data_role === 'tenant_core/users' || row.data_role === 'tenant_pii') &&
          (row.status === 'active' || row.status === 'ready')
      )
      .map((row) => ({
        logicalId: row.shard_id,
        desiredId: row.d1_desired_resource_id,
        providerId: row.provider_resource_id,
        deterministicName: row.deterministic_name,
      })),
    ...finalControl.lookupShards
      .filter((row) => row.status === 'active' || row.status === 'ready')
      .map((row) => ({
        logicalId: row.lookup_shard_id,
        desiredId: row.d1_desired_resource_id,
        providerId: row.provider_resource_id,
        deterministicName: row.deterministic_name,
      })),
  ];
  const desiredRows = new Map(
    finalControl.desiredResources.map((row) => [String(row.desired_resource_id), row] as const)
  );
  const observedByDesired = new Map<string, Record<string, unknown>[]>();
  for (const row of finalControl.observedResources) {
    if (row.observed_state !== 'present') continue;
    const desiredId = String(row.desired_resource_id);
    const rows = observedByDesired.get(desiredId) ?? [];
    rows.push(row);
    observedByDesired.set(desiredId, rows);
  }
  const desiredIds = new Set<string>();
  const logicalProviderIds = new Set<string>();
  const deterministicNames = new Set<string>();
  let resourceMappingMismatches = 0;
  if (providerPrefix === null) resourceMappingMismatches += 1;
  for (const resource of logicalResources) {
    if (
      typeof resource.logicalId !== 'string' ||
      typeof resource.desiredId !== 'string' ||
      typeof resource.providerId !== 'string' ||
      typeof resource.deterministicName !== 'string'
    ) {
      resourceMappingMismatches += 1;
      continue;
    }
    if (desiredIds.has(resource.desiredId)) resourceMappingMismatches += 1;
    if (logicalProviderIds.has(resource.providerId)) resourceMappingMismatches += 1;
    if (deterministicNames.has(resource.deterministicName)) resourceMappingMismatches += 1;
    desiredIds.add(resource.desiredId);
    logicalProviderIds.add(resource.providerId);
    deterministicNames.add(resource.deterministicName);
    const desired = desiredRows.get(resource.desiredId);
    const observed = observedByDesired.get(resource.desiredId) ?? [];
    if (
      desired?.deterministic_name !== resource.deterministicName ||
      observed.length !== 1 ||
      observed[0]?.provider_resource_id !== resource.providerId ||
      !providerInventory.has(resource.providerId)
    ) {
      resourceMappingMismatches += 1;
    }
  }
  const provisionedD1Resources = providerAdditions.length - orphanD1Resources;
  const manualIntervention = countManualInterventions({
    baseline: input.baseline,
    finalControl,
  });
  const blockedCapacityOperations = countNewBlockedCapacityOperations(
    input.baseline.control,
    finalControl
  );
  const duplicateProvisioningDecisions = duplicateForecastDecisions(finalControl);
  const coreProvisioning = evaluateRoleProvisioningBound({
    baseline: input.baseline.control,
    current: finalControl,
    config: input.config,
    role: 'tenant_core/users',
    submittedAccounts,
  });
  const piiProvisioning = evaluateRoleProvisioningBound({
    baseline: input.baseline.control,
    current: finalControl,
    config: input.config,
    role: 'tenant_pii',
    submittedAccounts,
  });
  let lookupForecastMismatches = finalControl.lookupForecasts.filter((row) => {
    const observed = row.observed_active_route_count;
    const forecast = row.forecast_new_route_count;
    const projected = row.projected_active_route_count;
    return (
      typeof observed !== 'number' ||
      typeof forecast !== 'number' ||
      typeof projected !== 'number' ||
      projected !== observed + forecast
    );
  }).length;
  if (input.controlEventsPath) {
    const events = await readJsonl(input.controlEventsPath);
    const transitionMismatches = verifyLookupForecastEvents({
      events,
      policy: finalControl.resourcePolicy ?? {},
    });
    lookupForecastMismatches += transitionMismatches;
    if (
      input.config.expectedPolicy.minimumLookupAdditions > 0 &&
      !events.some((event) => event.entity === 'lookupForecasts')
    ) {
      lookupForecastMismatches += 1;
    }
  }
  const terminalFailures = input.runner.metrics.terminalFailures;
  const succeededAccounts = succeeded.length;
  const checks = [
    [
      'eventual_success',
      succeededAccounts === submittedAccounts,
      `${succeededAccounts}:${submittedAccounts}`,
    ],
    [
      'unique_user_ids',
      uniqueUserIds.size === succeededAccounts,
      `${uniqueUserIds.size}:${succeededAccounts}`,
    ],
    ['terminal_failures', terminalFailures === 0, String(terminalFailures)],
    [
      'server_5xx_responses',
      input.runner.metrics.server5xx === 0,
      String(input.runner.metrics.server5xx),
    ],
    ['lost_accounts', lostAccounts === 0, String(lostAccounts)],
    ['duplicate_core_accounts', duplicateCoreAccounts === 0, String(duplicateCoreAccounts)],
    ['duplicate_pii_accounts', duplicatePiiAccounts === 0, String(duplicatePiiAccounts)],
    ['lookup_route_mismatches', lookupRouteMismatches === 0, String(lookupRouteMismatches)],
    ['cross_tenant_writes', crossTenantWrites === 0, String(crossTenantWrites)],
    ['orphan_d1_resources', orphanD1Resources === 0, String(orphanD1Resources)],
    [
      'resource_mapping_mismatches',
      resourceMappingMismatches === 0,
      String(resourceMappingMismatches),
    ],
    [
      'pending_account_operations',
      pending.pendingOperations === 0,
      String(pending.pendingOperations),
    ],
    ['pending_routing_outbox', pending.pendingOutbox === 0, String(pending.pendingOutbox)],
    [
      'blocked_capacity_operations',
      blockedCapacityOperations === 0,
      String(blockedCapacityOperations),
    ],
    [
      'duplicate_provisioning_decisions',
      duplicateProvisioningDecisions === 0,
      String(duplicateProvisioningDecisions),
    ],
    [
      'core_provisioning_bound',
      coreProvisioning.excessProvisioning === 0,
      `${coreProvisioning.physicalAdditions}:${coreProvisioning.maximumAdditions}`,
    ],
    [
      'pii_provisioning_bound',
      piiProvisioning.excessProvisioning === 0,
      `${piiProvisioning.physicalAdditions}:${piiProvisioning.maximumAdditions}`,
    ],
    [
      'publication_counter_decreases',
      publicationCounterDecreases === 0,
      String(publicationCounterDecreases),
    ],
    [
      'publication_counter_delta_mismatches',
      publicationCounterDeltaMismatches === 0,
      String(publicationCounterDeltaMismatches),
    ],
    [
      'lookup_forecast_mismatches',
      lookupForecastMismatches === 0,
      String(lookupForecastMismatches),
    ],
    ['control_physical_counts', countMismatches === 0, String(countMismatches)],
    ['control_allocations', allocationMismatches === 0, String(allocationMismatches)],
    ['field_level_comparison', fieldLevelMismatches === 0, String(fieldLevelMismatches)],
    [
      'core_boundary_crossings',
      coreBoundaryCrossings >= input.config.expectedPolicy.minimumRoleBoundaryCrossings,
      `${coreBoundaryCrossings}:${input.config.expectedPolicy.minimumRoleBoundaryCrossings}`,
    ],
    [
      'pii_boundary_crossings',
      piiBoundaryCrossings >= input.config.expectedPolicy.minimumRoleBoundaryCrossings,
      `${piiBoundaryCrossings}:${input.config.expectedPolicy.minimumRoleBoundaryCrossings}`,
    ],
    [
      'lookup_physical_additions',
      newLookupShards.length >= input.config.expectedPolicy.minimumLookupAdditions,
      `${newLookupShards.length}:${input.config.expectedPolicy.minimumLookupAdditions}`,
    ],
    [
      'lookup_used_assignment_transitions',
      lookupUsedAssignmentTransitions >=
        input.config.expectedPolicy.minimumLookupUsedAssignmentTransitions,
      `${lookupUsedAssignmentTransitions}:${input.config.expectedPolicy.minimumLookupUsedAssignmentTransitions}`,
    ],
    ['manual_intervention', manualIntervention === 0, String(manualIntervention)],
  ].map(([name, passed, detail]) => ({
    name: String(name),
    passed: Boolean(passed),
    detail: String(detail),
  }));
  const integrity: Phase1IntegrityResult = {
    schemaVersion: PHASE1_SCHEMA_VERSION,
    runId: input.runId,
    verifiedAt: new Date().toISOString(),
    submittedAccounts,
    succeededAccounts,
    uniqueUserIds: uniqueUserIds.size,
    terminalFailures,
    lostAccounts,
    duplicateCoreAccounts,
    duplicatePiiAccounts,
    lookupRouteMismatches,
    crossTenantWrites,
    orphanD1Resources,
    resourceMappingMismatches,
    pendingAccountOperations: pending.pendingOperations,
    pendingRoutingOutbox: pending.pendingOutbox,
    blockedCapacityOperations,
    duplicateProvisioningDecisions,
    publicationCounterDecreases,
    publicationCounterDeltaMismatches,
    lookupForecastMismatches,
    controlPhysicalCountMismatches: countMismatches,
    allocationMismatches,
    fieldLevelMismatches,
    coreBoundaryCrossings,
    piiBoundaryCrossings,
    corePhysicalAdditions: coreProvisioning.physicalAdditions,
    piiPhysicalAdditions: piiProvisioning.physicalAdditions,
    excessCoreProvisioning: coreProvisioning.excessProvisioning,
    excessPiiProvisioning: piiProvisioning.excessProvisioning,
    lookupPhysicalAdditions: newLookupShards.length,
    lookupUsedAssignmentTransitions,
    provisionedD1Resources,
    manualIntervention,
    checks,
    passed: checks.every((entry) => entry.passed),
  };
  assertPhase1EvidenceIsSecretFree(integrity);
  return integrity;
}

async function main(): Promise<void> {
  const configIndex = process.argv.indexOf('--config');
  if (configIndex < 0 || !process.argv[configIndex + 1])
    throw new Error('phase1_config_path_required');
  const config = parsePhase1HarnessConfig(
    JSON.parse(await readFile(process.argv[configIndex + 1], 'utf8'))
  );
  process.stdout.write(
    `${stableJson({ schemaVersion: PHASE1_SCHEMA_VERSION, profile: config.profile, valid: true })}\n`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'phase1_verify_failed'}\n`);
    process.exitCode = 1;
  });
}
