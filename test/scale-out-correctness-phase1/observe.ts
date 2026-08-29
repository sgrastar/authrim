#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  CloudflareControlApiError,
  CloudflareControlApiClient,
  type CloudflareD1QueryResult,
} from '../../packages/ar-lib-core/src/services/control-plane/index.js';
import {
  PHASE1_SCHEMA_VERSION,
  assertPhase1EvidenceIsSecretFree,
  parsePhase1HarnessConfig,
  resolvePhase1Secret,
  stableJson,
  type Phase1ControlSnapshot,
  type Phase1HarnessConfig,
  type Phase1ProviderSnapshot,
} from './schemas.js';

const CONTROL_QUERIES = [
  `SELECT e.environment_id, e.environment_name, e.lifecycle_state,
          e.automatic_provisioning_enabled, e.provisioning_token_ownership,
          e.provisioning_capability_state, e.provisioning_capability_checked_at,
          p.max_concurrent_provisioning, p.max_ready_spares, p.max_d1_resources,
          p.daily_d1_create_budget, p.target_account_count,
          p.lookup_rebalance_concurrency, p.lookup_forecast_horizon_seconds,
          p.lookup_target_active_route_count, p.lookup_scale_out_headroom_bps,
          p.lookup_registration_ewma_alpha_bps, p.lookup_scale_out_policy_generation
          ,(SELECT COUNT(*) FROM control_tenant_placement_policies tenants
             WHERE tenants.environment_id = e.environment_id
               AND tenants.policy_state = 'active') AS active_tenant_count
          ,(SELECT COUNT(*) FROM control_desired_resources desired
             WHERE desired.environment_id = e.environment_id
               AND desired.resource_kind = 'd1'
               AND desired.desired_state = 'present') AS current_environment_d1_count
          ,(SELECT COUNT(*) FROM control_d1_create_budget_reservations reservation
             WHERE reservation.environment_id = e.environment_id
               AND reservation.budget_day = CAST(unixepoch() / 86400 AS INTEGER))
             AS daily_d1_create_used
     FROM control_environments e
     LEFT JOIN control_environment_resource_policies p
       ON p.environment_id = e.environment_id
    WHERE e.environment_id = ?`,
  `SELECT environment_id, tenant_id, isolation_policy, policy_generation,
          policy_state, activated_at, updated_at
     FROM control_tenant_placement_policies
    WHERE environment_id = ? AND tenant_id = ?`,
  `SELECT environment_id, residency_policy_id, residency_partition, jurisdiction,
          location_hint, lookup_capacity_domain_id, status, updated_at
     FROM control_residency_partitions
    WHERE environment_id = ?
    ORDER BY residency_policy_id, residency_partition`,
  `SELECT s.shard_id, s.data_role, s.residency_policy_id, s.residency_partition,
          s.generation, s.logical_shard_id, s.binding_ref, s.status, s.d1_desired_resource_id,
          s.allocation_scope, s.owner_tenant_id,
          c.target_account_count, c.allocated_account_count, c.observed_account_count,
          c.health_status, c.allocation_status, c.storage_bytes, c.checked_at, c.updated_at,
          r.deterministic_name, o.provider_resource_id
     FROM control_tenant_shards s
     JOIN control_shard_capacity c ON c.shard_id = s.shard_id
     JOIN control_desired_resources r ON r.desired_resource_id = s.d1_desired_resource_id
     LEFT JOIN control_observed_resources o
       ON o.desired_resource_id = r.desired_resource_id AND o.observed_state = 'present'
    WHERE s.environment_id = ?
    ORDER BY s.data_role, s.generation, s.shard_id`,
  `SELECT environment_id, tenant_id, data_role, residency_policy_id,
          residency_partition, shard_id, assignment_generation, assignment_state,
          source_operation_id, activated_at, retired_at, updated_at
     FROM control_tenant_shard_assignments
    WHERE environment_id = ? AND tenant_id = ?
    ORDER BY data_role, assignment_generation, shard_id`,
  `SELECT operation_id, operation_kind, idempotency_key, status, requested_by_type,
          attempt_count, next_attempt_at, last_error_code, created_at, started_at,
          completed_at, updated_at
     FROM control_operations
    WHERE environment_id = ?
    ORDER BY created_at, operation_id`,
  `SELECT s.operation_id, s.step_key, s.parent_step_key, s.display_order, s.status,
          s.attempt_count, s.next_attempt_at, s.last_error_code, s.observed_resource_id,
          s.progress_current, s.progress_total, s.started_at, s.completed_at, s.updated_at
     FROM control_operation_steps s
     JOIN control_operations o ON o.operation_id = s.operation_id
    WHERE o.environment_id = ?
    ORDER BY o.created_at, s.display_order, s.step_key`,
  `SELECT desired_resource_id, resource_kind, logical_shard_id, resource_scope,
          tenant_id, deterministic_name, desired_state, provisioning_state,
          origin_operation_id, observed_resource_id, created_at, updated_at
     FROM control_desired_resources
    WHERE environment_id = ?
    ORDER BY created_at, desired_resource_id`,
  `SELECT observed_resource_id, desired_resource_id, provider_resource_id,
          provider_name, resource_kind, observed_state, observed_at
     FROM control_observed_resources
    WHERE environment_id = ?
    ORDER BY observed_at, observed_resource_id`,
  `SELECT environment_id, lookup_capacity_domain_id, residency_policy_id,
          residency_partition, policy_generation, observed_at,
          observed_active_route_count, observed_successful_publication_count,
          sample_interval_seconds, sample_rate_microrows_per_second,
          ewma_rate_microrows_per_second, forecast_horizon_seconds,
          forecast_new_route_count, projected_active_route_count,
          usable_capacity_route_count, capacity_unit_count, decision_generation,
          decision_state, snapshot_digest, capacity_request_idempotency_key,
          requested_operation_id, last_error_code, updated_at
     FROM control_lookup_scale_out_forecasts
    WHERE environment_id = ?
    ORDER BY lookup_capacity_domain_id`,
  `SELECT s.lookup_shard_id, s.residency_partition, s.binding_ref, s.status,
          s.capacity_weight, s.d1_desired_resource_id, s.created_at, s.updated_at,
          r.deterministic_name, r.provisioning_state, r.desired_spec_json,
          o.provider_resource_id, o.observed_state
     FROM control_lookup_physical_shards s
     JOIN control_desired_resources r ON r.desired_resource_id = s.d1_desired_resource_id
     LEFT JOIN control_observed_resources o
       ON o.desired_resource_id = r.desired_resource_id AND o.observed_state = 'present'
    WHERE s.environment_id = ?
    ORDER BY s.created_at, s.lookup_shard_id`,
  `SELECT virtual_bucket, lookup_shard_id, assignment_generation, state,
          target_lookup_shard_id, source_row_count, target_row_count, updated_at
     FROM control_lookup_bucket_assignments
    WHERE environment_id = ?
    ORDER BY virtual_bucket
    LIMIT ? OFFSET ?`,
  `SELECT finding_id, worker_script_name, finding_kind, severity, review_state,
          first_observed_at, last_observed_at, resolved_at
     FROM control_worker_inventory_drift_findings
    WHERE environment_id = ? AND review_state <> 'resolved'
    ORDER BY severity, worker_script_name, finding_kind`,
  `WITH scoped AS (
       SELECT a.data_role, a.selected_shard_id, a.reservation_state,
              a.account_id_blind_digest, a.capacity_counted_at,
              s.data_role AS selected_shard_role, s.status AS selected_shard_status
         FROM control_tenant_shard_allocations a
         LEFT JOIN control_tenant_shards s ON s.shard_id = a.selected_shard_id
        WHERE a.environment_id = ? AND a.tenant_id = ?
          AND a.data_role IN ('tenant_core/users', 'tenant_pii')
          AND ? = 1
     ), account_integrity AS (
       SELECT account_id_blind_digest
         FROM scoped
        GROUP BY account_id_blind_digest
       HAVING COUNT(*) <> 2
           OR COUNT(DISTINCT data_role) <> 2
           OR SUM(CASE WHEN data_role IN ('tenant_core/users', 'tenant_pii') THEN 1 ELSE 0 END) <> 2
     )
   SELECT 'summary' AS row_kind, NULL AS data_role, NULL AS selected_shard_id,
          NULL AS reservation_state, COUNT(*) AS allocation_count,
          COUNT(DISTINCT account_id_blind_digest) AS distinct_account_count,
          COALESCE(SUM(CASE WHEN reservation_state <> 'committed' THEN 1 ELSE 0 END), 0)
            AS invalid_state_count,
          COALESCE(SUM(CASE WHEN capacity_counted_at IS NULL THEN 1 ELSE 0 END), 0)
            AS missing_capacity_count,
          COALESCE(SUM(CASE WHEN selected_shard_role IS NULL
                              OR selected_shard_role <> data_role
                              OR selected_shard_status IS NULL
                              OR selected_shard_status <> 'active' THEN 1 ELSE 0 END), 0)
            AS invalid_shard_count,
          (SELECT COUNT(*) FROM account_integrity) AS invalid_account_role_count
     FROM scoped
    UNION ALL
   SELECT 'distribution' AS row_kind, data_role, selected_shard_id, reservation_state,
          COUNT(*) AS allocation_count,
          COUNT(DISTINCT account_id_blind_digest) AS distinct_account_count,
          COALESCE(SUM(CASE WHEN reservation_state <> 'committed' THEN 1 ELSE 0 END), 0)
            AS invalid_state_count,
          COALESCE(SUM(CASE WHEN capacity_counted_at IS NULL THEN 1 ELSE 0 END), 0)
            AS missing_capacity_count,
          COALESCE(SUM(CASE WHEN selected_shard_role IS NULL
                              OR selected_shard_role <> data_role
                              OR selected_shard_status IS NULL
                              OR selected_shard_status <> 'active' THEN 1 ELSE 0 END), 0)
            AS invalid_shard_count,
          0 AS invalid_account_role_count
     FROM scoped
    GROUP BY data_role, selected_shard_id, reservation_state
    ORDER BY row_kind DESC, data_role, selected_shard_id, reservation_state`,
] as const;

const CONTROL_QUERY_BATCH_SIZE = 4;
const LOOKUP_ASSIGNMENT_QUERY_INDEX = 11;
const LOOKUP_ASSIGNMENT_PAGE_SIZE = 1_024;
const LOOKUP_ASSIGNMENT_BUCKET_COUNT = 4_096;

export interface Phase1ObservationClient {
  queryD1Batch(
    databaseId: string,
    batch: ReadonlyArray<{ sql: string; params?: unknown[] }>
  ): Promise<CloudflareD1QueryResult[]>;
  listD1Databases(): Promise<
    Array<{ uuid: string; name: string; created_at?: string; file_size?: number }>
  >;
}

function rows(results: CloudflareD1QueryResult[], index: number): Record<string, unknown>[] {
  const result = results[index];
  if (!result || result.success === false || !Array.isArray(result.results)) {
    throw new Error(`phase1_control_query_failed:${index}`);
  }
  return result.results.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`phase1_control_query_row_invalid:${index}`);
    }
    return entry as Record<string, unknown>;
  });
}

export function buildControlQueryBatch(
  config: Phase1HarnessConfig,
  options: { includeTenantAllocations?: boolean } = {}
) {
  const environmentId = config.environment.environmentId;
  const tenantId = config.environment.tenantId;
  return CONTROL_QUERIES.map((sql, index) => ({
    sql,
    params:
      index === LOOKUP_ASSIGNMENT_QUERY_INDEX
        ? [environmentId, LOOKUP_ASSIGNMENT_PAGE_SIZE, 0]
        : index === 13
          ? [environmentId, tenantId, options.includeTenantAllocations === false ? 0 : 1]
          : index === 1 || index === 4
            ? [environmentId, tenantId]
            : [environmentId],
  }));
}

export async function collectControlSnapshot(input: {
  config: Phase1HarnessConfig;
  client: Phase1ObservationClient;
  now?: () => Date;
  includeTenantAllocations?: boolean;
}): Promise<Phase1ControlSnapshot> {
  const batch = buildControlQueryBatch(input.config, {
    includeTenantAllocations: input.includeTenantAllocations,
  });
  const assignmentQuery = batch[LOOKUP_ASSIGNMENT_QUERY_INDEX];
  const regularBatch = batch.filter((_, index) => index !== LOOKUP_ASSIGNMENT_QUERY_INDEX);
  const groups = Array.from(
    { length: Math.ceil(regularBatch.length / CONTROL_QUERY_BATCH_SIZE) },
    (_, index) =>
      regularBatch.slice(index * CONTROL_QUERY_BATCH_SIZE, (index + 1) * CONTROL_QUERY_BATCH_SIZE)
  );
  const regularResults = (
    await Promise.all(
      groups.map((group) =>
        input.client.queryD1Batch(input.config.environment.controlDatabaseId, group)
      )
    )
  ).flat();
  const assignmentPageResults = await Promise.all(
    Array.from(
      { length: LOOKUP_ASSIGNMENT_BUCKET_COUNT / LOOKUP_ASSIGNMENT_PAGE_SIZE },
      (_, page) =>
        input.client.queryD1Batch(input.config.environment.controlDatabaseId, [
          {
            sql: assignmentQuery.sql,
            params: [
              input.config.environment.environmentId,
              LOOKUP_ASSIGNMENT_PAGE_SIZE,
              page * LOOKUP_ASSIGNMENT_PAGE_SIZE,
            ],
          },
        ])
    )
  );
  const assignmentRows = assignmentPageResults.flatMap((page) => rows(page, 0));
  const results = regularResults.slice();
  results.splice(LOOKUP_ASSIGNMENT_QUERY_INDEX, 0, {
    success: true,
    results: assignmentRows,
  });
  if (results.length !== CONTROL_QUERIES.length) {
    throw new Error('phase1_control_query_result_count_mismatch');
  }
  const snapshot: Phase1ControlSnapshot = {
    schemaVersion: PHASE1_SCHEMA_VERSION,
    observedAt: (input.now ?? (() => new Date()))().toISOString(),
    environment: rows(results, 0)[0] ?? null,
    resourcePolicy: rows(results, 0)[0] ?? null,
    tenantPolicy: rows(results, 1)[0] ?? null,
    residencyPartitions: rows(results, 2),
    shardCapacities: rows(results, 3),
    tenantAssignments: rows(results, 4),
    tenantAllocations: rows(results, 13),
    operations: rows(results, 5),
    operationSteps: rows(results, 6),
    desiredResources: rows(results, 7),
    observedResources: rows(results, 8),
    lookupForecasts: rows(results, 9),
    lookupShards: rows(results, 10),
    lookupAssignments: rows(results, 11),
    workerBindingDrift: rows(results, 12),
  };
  assertPhase1EvidenceIsSecretFree(snapshot);
  return snapshot;
}

export async function collectProviderSnapshot(input: {
  client: Phase1ObservationClient;
  now?: () => Date;
}): Promise<Phase1ProviderSnapshot> {
  const databases = await input.client.listD1Databases();
  const snapshot: Phase1ProviderSnapshot = {
    schemaVersion: PHASE1_SCHEMA_VERSION,
    observedAt: (input.now ?? (() => new Date()))().toISOString(),
    databases: databases
      .map((database) => ({
        uuid: database.uuid,
        name: database.name,
        createdAt: database.created_at ?? null,
        fileSize:
          typeof database.file_size === 'number' && Number.isSafeInteger(database.file_size)
            ? database.file_size
            : null,
      }))
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.uuid.localeCompare(right.uuid)
      ),
  };
  assertPhase1EvidenceIsSecretFree(snapshot);
  return snapshot;
}

const ENTITY_KEYS: Record<
  keyof Omit<
    Phase1ControlSnapshot,
    'schemaVersion' | 'observedAt' | 'environment' | 'resourcePolicy' | 'tenantPolicy'
  >,
  string[]
> = {
  residencyPartitions: ['residency_policy_id', 'residency_partition'],
  shardCapacities: ['shard_id'],
  tenantAssignments: ['data_role', 'assignment_generation', 'shard_id'],
  tenantAllocations: ['row_kind', 'data_role', 'selected_shard_id', 'reservation_state'],
  operations: ['operation_id'],
  operationSteps: ['operation_id', 'step_key'],
  desiredResources: ['desired_resource_id'],
  observedResources: ['observed_resource_id'],
  lookupForecasts: ['lookup_capacity_domain_id'],
  lookupShards: ['lookup_shard_id'],
  lookupAssignments: ['virtual_bucket'],
  workerBindingDrift: ['finding_id'],
};

function entityKey(row: Record<string, unknown>, keys: string[]): string {
  return keys
    .map((key) => {
      const value = row[key];
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '';
    })
    .join(':');
}

export function diffControlSnapshots(
  previous: Phase1ControlSnapshot,
  current: Phase1ControlSnapshot
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const singleton of ['environment', 'resourcePolicy', 'tenantPolicy'] as const) {
    if (stableJson(previous[singleton]) !== stableJson(current[singleton])) {
      events.push({
        entity: singleton,
        key: singleton,
        previous: previous[singleton],
        current: current[singleton],
      });
    }
  }
  for (const [entity, keys] of Object.entries(ENTITY_KEYS) as Array<
    [keyof typeof ENTITY_KEYS, string[]]
  >) {
    const oldRows = new Map(previous[entity].map((row) => [entityKey(row, keys), row]));
    const newRows = new Map(current[entity].map((row) => [entityKey(row, keys), row]));
    const allKeys = [...new Set([...oldRows.keys(), ...newRows.keys()])].sort();
    for (const key of allKeys) {
      const oldRow = oldRows.get(key) ?? null;
      const newRow = newRows.get(key) ?? null;
      if (stableJson(oldRow) !== stableJson(newRow)) {
        events.push({ entity, key, previous: oldRow, current: newRow });
      }
    }
  }
  return events.map((event) => ({
    schemaVersion: PHASE1_SCHEMA_VERSION,
    kind: 'control_change',
    observedAt: current.observedAt,
    ...event,
  }));
}

export function diffProviderSnapshots(
  previous: Phase1ProviderSnapshot,
  current: Phase1ProviderSnapshot
): Array<Record<string, unknown>> {
  const oldRows = new Map(previous.databases.map((database) => [database.uuid, database]));
  const newRows = new Map(current.databases.map((database) => [database.uuid, database]));
  return [...new Set([...oldRows.keys(), ...newRows.keys()])].sort().flatMap((uuid) => {
    const oldRow = oldRows.get(uuid) ?? null;
    const newRow = newRows.get(uuid) ?? null;
    if (stableJson(oldRow) === stableJson(newRow)) return [];
    return [
      {
        schemaVersion: PHASE1_SCHEMA_VERSION,
        kind: 'provider_database_change',
        observedAt: current.observedAt,
        databaseUuid: uuid,
        previous: oldRow,
        current: newRow,
      },
    ];
  });
}

export interface ObservationLoopResult {
  latestControl: Phase1ControlSnapshot;
  latestProvider: Phase1ProviderSnapshot;
}

export function phase1ObservationRetryCode(error: unknown): string | null {
  if (error instanceof CloudflareControlApiError) {
    if (error.status === 408) return 'cloudflare_request_timeout';
    if (error.status === 429) return 'cloudflare_rate_limited';
    if (error.status >= 500) return 'cloudflare_server_error';
    return null;
  }
  if (!(error instanceof Error)) return null;
  if (/^Request timeout after \d+ms$/u.test(error.message) || error.name === 'AbortError') {
    return 'cloudflare_request_timeout';
  }
  if (error.message === 'fetch failed') return 'cloudflare_network_error';
  return null;
}

async function appendObservationRetry(input: {
  path: string;
  kind: 'control_observation_retry' | 'provider_observation_retry';
  retryCode: string;
}): Promise<void> {
  const event = {
    schemaVersion: PHASE1_SCHEMA_VERSION,
    kind: input.kind,
    observedAt: new Date().toISOString(),
    retryCode: input.retryCode,
  };
  assertPhase1EvidenceIsSecretFree(event);
  await appendFile(input.path, `${stableJson(event)}\n`, { mode: 0o600 });
}

export async function observePhase1(input: {
  config: Phase1HarnessConfig;
  client: Phase1ObservationClient;
  initialControl: Phase1ControlSnapshot;
  initialProvider: Phase1ProviderSnapshot;
  controlEventsPath: string;
  providerEventsPath: string;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<ObservationLoopResult> {
  const sleep =
    input.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(
              signal.reason instanceof Error ? signal.reason : new Error('phase1_observer_aborted')
            );
          },
          { once: true }
        );
      }));
  let latestControl = input.initialControl;
  let latestProvider = input.initialProvider;
  let lastProviderAt = Date.parse(latestProvider.observedAt);
  while (!input.signal.aborted) {
    try {
      await sleep(input.config.observation.controlIntervalMs, input.signal);
    } catch {
      if (input.signal.aborted) break;
      throw new Error('phase1_observer_sleep_failed');
    }
    let currentControl: Phase1ControlSnapshot;
    try {
      currentControl = await collectControlSnapshot({
        config: input.config,
        client: input.client,
        includeTenantAllocations: false,
      });
    } catch (error) {
      const retryCode = phase1ObservationRetryCode(error);
      if (!retryCode) throw error;
      await appendObservationRetry({
        path: input.controlEventsPath,
        kind: 'control_observation_retry',
        retryCode,
      });
      continue;
    }
    // Allocation integrity is deliberately collected only at preflight, quiescence, and final
    // verification. Re-scanning every account allocation on each observation interval would make
    // the observer part of the load under test and distort publishable scale-out measurements.
    currentControl.tenantAllocations = latestControl.tenantAllocations;
    const controlEvents = diffControlSnapshots(latestControl, currentControl);
    for (const event of controlEvents) {
      assertPhase1EvidenceIsSecretFree(event);
    }
    if (controlEvents.length > 0) {
      await appendFile(
        input.controlEventsPath,
        controlEvents.map((event) => `${stableJson(event)}\n`).join(''),
        { mode: 0o600 }
      );
    }
    latestControl = currentControl;
    if (
      Date.parse(currentControl.observedAt) - lastProviderAt >=
      input.config.observation.providerIntervalMs
    ) {
      let currentProvider: Phase1ProviderSnapshot;
      try {
        currentProvider = await collectProviderSnapshot({ client: input.client });
      } catch (error) {
        const retryCode = phase1ObservationRetryCode(error);
        if (!retryCode) throw error;
        await appendObservationRetry({
          path: input.providerEventsPath,
          kind: 'provider_observation_retry',
          retryCode,
        });
        continue;
      }
      const providerEvents = diffProviderSnapshots(latestProvider, currentProvider);
      for (const event of providerEvents) {
        assertPhase1EvidenceIsSecretFree(event);
      }
      if (providerEvents.length > 0) {
        await appendFile(
          input.providerEventsPath,
          providerEvents.map((event) => `${stableJson(event)}\n`).join(''),
          { mode: 0o600 }
        );
      }
      latestProvider = currentProvider;
      lastProviderAt = Date.parse(currentProvider.observedAt);
    }
  }
  return { latestControl, latestProvider };
}

function parseArgs(argv: string[]): { configPath: string; execute: boolean } {
  let configPath = '';
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--') continue;
    if (argv[index] === '--config') configPath = argv[++index] ?? '';
    else if (argv[index] === '--execute') execute = true;
    else throw new Error(`phase1_observe_unknown_argument:${argv[index]}`);
  }
  if (!configPath) throw new Error('phase1_config_path_required');
  return { configPath, execute };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.execute) throw new Error('phase1_observe_execute_flag_required');
  const config = parsePhase1HarnessConfig(JSON.parse(await readFile(options.configPath, 'utf8')));
  const accountId = resolvePhase1Secret(process.env, config.credentials.cloudflareAccountIdEnv);
  const d1 = resolvePhase1Secret(process.env, config.credentials.cloudflareD1ReadTokenEnv);
  const client = new CloudflareControlApiClient({ accountId, tokens: { d1, workers: d1 } });
  const [control, provider] = await Promise.all([
    collectControlSnapshot({ config, client }),
    collectProviderSnapshot({ client }),
  ]);
  process.stdout.write(`${stableJson({ control, provider })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'phase1_observe_failed'}\n`);
    process.exitCode = 1;
  });
}
