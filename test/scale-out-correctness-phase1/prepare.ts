#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CloudflareControlApiClient,
  type CloudflareD1QueryResult,
} from '../../packages/ar-lib-core/src/services/control-plane/index.js';
import {
  PHASE1_SCHEMA_VERSION,
  assertPhase1EvidenceIsSecretFree,
  parsePhase1HarnessConfig,
  resolvePhase1Secret,
  stableJson,
  type Phase1HarnessConfig,
} from './schemas.js';

export const PHASE1_PREPARE_CONFIRMATION = 'AUTHRIM_PHASE1_PREPARE_SCALE_OUT_POLICY';

interface PreparationClient {
  queryD1Batch(
    databaseId: string,
    batch: ReadonlyArray<{ sql: string; params?: unknown[] }>
  ): Promise<CloudflareD1QueryResult[]>;
}

interface PolicyRow extends Record<string, unknown> {
  environment_id: string;
  lifecycle_state: string;
  target_account_count: number;
  max_concurrent_provisioning: number;
  max_ready_spares: number;
  max_d1_resources: number;
  daily_d1_create_budget: number;
  lookup_target_active_route_count: number;
  lookup_forecast_horizon_seconds: number;
  lookup_registration_ewma_alpha_bps: number;
  lookup_scale_out_headroom_bps: number;
  lookup_scale_out_policy_generation: number;
  account_forecast_horizon_seconds: number;
  account_registration_ewma_alpha_bps: number;
  account_scale_out_headroom_bps: number;
  account_scale_out_policy_generation: number;
}

interface CapacityRow extends Record<string, unknown> {
  shard_id: string;
  data_role: string;
  target_account_count: number;
}

export interface Phase1PolicyPreparation {
  schemaVersion: 1;
  environmentId: string;
  preparedAt: string;
  executed: boolean;
  previous: { policy: PolicyRow; shardCapacities: CapacityRow[] };
  requested: {
    targetAccountCount: number;
    maxConcurrentProvisioning: number;
    maxReadySpares: number;
    maxD1Resources: number;
    dailyD1CreateBudget: number;
    lookupTargetActiveRouteCount: number;
    lookupForecastHorizonSeconds: number;
    lookupEwmaAlphaBps: number;
    lookupHeadroomBps: number;
    lookupPolicyGeneration: number;
    accountForecastHorizonSeconds: number;
    accountEwmaAlphaBps: number;
    accountHeadroomBps: number;
    accountPolicyGeneration: number;
  };
  readback: { policy: PolicyRow; shardCapacities: CapacityRow[] } | null;
}

const READ_POLICY_SQL = `SELECT e.environment_id, e.lifecycle_state,
       p.target_account_count, p.max_concurrent_provisioning,
       p.max_ready_spares, p.max_d1_resources,
       p.daily_d1_create_budget,
       p.lookup_target_active_route_count, p.lookup_forecast_horizon_seconds,
       p.lookup_registration_ewma_alpha_bps, p.lookup_scale_out_headroom_bps,
       p.lookup_scale_out_policy_generation,
       p.account_forecast_horizon_seconds, p.account_registration_ewma_alpha_bps,
       p.account_scale_out_headroom_bps, p.account_scale_out_policy_generation
  FROM control_environments e
  JOIN control_environment_resource_policies p ON p.environment_id = e.environment_id
 WHERE e.environment_id = ?`;

const READ_CAPACITIES_SQL = `SELECT s.shard_id, s.data_role, c.target_account_count
 FROM control_tenant_shards s
  JOIN control_shard_capacity c ON c.shard_id = s.shard_id
 WHERE s.environment_id = ?
   AND s.allocation_scope = ?
   AND ((? = 'shared_pool' AND s.owner_tenant_id IS NULL) OR
        (? = 'tenant_exclusive' AND s.owner_tenant_id = ?))
   AND s.status <> 'deleted'
   AND s.data_role IN ('tenant_core/users', 'tenant_pii')
 ORDER BY s.data_role, s.shard_id`;

function successfulRows(
  results: CloudflareD1QueryResult[],
  index: number,
  error: string
): Record<string, unknown>[] {
  const result = results[index];
  if (!result || result.success === false || !Array.isArray(result.results)) {
    throw new Error(error);
  }
  return result.results.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(error);
    return row as Record<string, unknown>;
  });
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) throw new Error(`phase1_prepare_${key}_invalid`);
  return Number(value);
}

function string(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !value) throw new Error(`phase1_prepare_${key}_invalid`);
  return value;
}

function policyRow(row: Record<string, unknown>): PolicyRow {
  return {
    environment_id: string(row, 'environment_id'),
    lifecycle_state: string(row, 'lifecycle_state'),
    target_account_count: integer(row, 'target_account_count'),
    max_concurrent_provisioning: integer(row, 'max_concurrent_provisioning'),
    max_ready_spares: integer(row, 'max_ready_spares'),
    max_d1_resources: integer(row, 'max_d1_resources'),
    daily_d1_create_budget: integer(row, 'daily_d1_create_budget'),
    lookup_target_active_route_count: integer(row, 'lookup_target_active_route_count'),
    lookup_forecast_horizon_seconds: integer(row, 'lookup_forecast_horizon_seconds'),
    lookup_registration_ewma_alpha_bps: integer(row, 'lookup_registration_ewma_alpha_bps'),
    lookup_scale_out_headroom_bps: integer(row, 'lookup_scale_out_headroom_bps'),
    lookup_scale_out_policy_generation: integer(row, 'lookup_scale_out_policy_generation'),
    account_forecast_horizon_seconds: integer(row, 'account_forecast_horizon_seconds'),
    account_registration_ewma_alpha_bps: integer(row, 'account_registration_ewma_alpha_bps'),
    account_scale_out_headroom_bps: integer(row, 'account_scale_out_headroom_bps'),
    account_scale_out_policy_generation: integer(row, 'account_scale_out_policy_generation'),
  };
}

function capacityRows(rows: Record<string, unknown>[]): CapacityRow[] {
  return rows.map((row) => ({
    shard_id: string(row, 'shard_id'),
    data_role: string(row, 'data_role'),
    target_account_count: integer(row, 'target_account_count'),
  }));
}

async function readCurrent(input: {
  config: Phase1HarnessConfig;
  client: PreparationClient;
}): Promise<{ policy: PolicyRow; shardCapacities: CapacityRow[] }> {
  const results = await input.client.queryD1Batch(input.config.environment.controlDatabaseId, [
    { sql: READ_POLICY_SQL, params: [input.config.environment.environmentId] },
    {
      sql: READ_CAPACITIES_SQL,
      params: [
        input.config.environment.environmentId,
        input.config.environment.placementPolicy,
        input.config.environment.placementPolicy,
        input.config.environment.placementPolicy,
        input.config.environment.tenantId,
      ],
    },
  ]);
  const policies = successfulRows(results, 0, 'phase1_prepare_policy_read_failed');
  if (policies.length !== 1) throw new Error('phase1_prepare_policy_count_mismatch');
  const policy = policyRow(policies[0]);
  const shardCapacities = capacityRows(
    successfulRows(results, 1, 'phase1_prepare_capacity_read_failed')
  );
  const roles = new Set(shardCapacities.map((row) => row.data_role));
  if (
    shardCapacities.length < 2 ||
    roles.size !== 2 ||
    !roles.has('tenant_core/users') ||
    !roles.has('tenant_pii')
  ) {
    throw new Error('phase1_prepare_baseline_shards_mismatch');
  }
  return { policy, shardCapacities };
}

function requested(config: Phase1HarnessConfig): Phase1PolicyPreparation['requested'] {
  return {
    targetAccountCount: config.expectedPolicy.targetAccountCount,
    maxConcurrentProvisioning: config.expectedPolicy.maxConcurrentProvisioning,
    maxReadySpares: config.expectedPolicy.maxReadySpares,
    maxD1Resources: config.expectedPolicy.maxD1Resources,
    dailyD1CreateBudget: config.expectedPolicy.dailyD1CreateBudget,
    lookupTargetActiveRouteCount: config.expectedPolicy.lookupTargetActiveRouteCount,
    lookupForecastHorizonSeconds: config.expectedPolicy.lookupForecastHorizonSeconds,
    lookupEwmaAlphaBps: config.expectedPolicy.lookupEwmaAlphaBps,
    lookupHeadroomBps: config.expectedPolicy.lookupHeadroomBps,
    lookupPolicyGeneration: config.expectedPolicy.lookupPolicyGeneration,
    accountForecastHorizonSeconds: config.expectedPolicy.accountForecastHorizonSeconds,
    accountEwmaAlphaBps: config.expectedPolicy.accountEwmaAlphaBps,
    accountHeadroomBps: config.expectedPolicy.accountHeadroomBps,
    accountPolicyGeneration: config.expectedPolicy.accountPolicyGeneration,
  };
}

function assertReadback(
  value: { policy: PolicyRow; shardCapacities: CapacityRow[] },
  expected: Phase1PolicyPreparation['requested']
): void {
  const policy = value.policy;
  if (
    policy.target_account_count !== expected.targetAccountCount ||
    policy.max_concurrent_provisioning !== expected.maxConcurrentProvisioning ||
    policy.max_ready_spares !== expected.maxReadySpares ||
    policy.max_d1_resources !== expected.maxD1Resources ||
    policy.daily_d1_create_budget !== expected.dailyD1CreateBudget ||
    policy.lookup_target_active_route_count !== expected.lookupTargetActiveRouteCount ||
    policy.lookup_forecast_horizon_seconds !== expected.lookupForecastHorizonSeconds ||
    policy.lookup_registration_ewma_alpha_bps !== expected.lookupEwmaAlphaBps ||
    policy.lookup_scale_out_headroom_bps !== expected.lookupHeadroomBps ||
    policy.lookup_scale_out_policy_generation !== expected.lookupPolicyGeneration ||
    policy.account_forecast_horizon_seconds !== expected.accountForecastHorizonSeconds ||
    policy.account_registration_ewma_alpha_bps !== expected.accountEwmaAlphaBps ||
    policy.account_scale_out_headroom_bps !== expected.accountHeadroomBps ||
    policy.account_scale_out_policy_generation !== expected.accountPolicyGeneration ||
    value.shardCapacities.some(
      (capacity) => capacity.target_account_count !== expected.targetAccountCount
    )
  ) {
    throw new Error('phase1_prepare_readback_mismatch');
  }
}

export async function preparePhase1Policy(input: {
  config: Phase1HarnessConfig;
  client: PreparationClient;
  execute: boolean;
  confirmation?: string;
  now?: () => Date;
}): Promise<Phase1PolicyPreparation> {
  const previous = await readCurrent(input);
  if (
    previous.policy.environment_id !== input.config.environment.environmentId ||
    previous.policy.lifecycle_state !== 'active'
  ) {
    throw new Error('phase1_prepare_environment_not_active');
  }
  const desired = requested(input.config);
  if (
    desired.lookupPolicyGeneration !== previous.policy.lookup_scale_out_policy_generation + 1 ||
    desired.accountPolicyGeneration !== previous.policy.account_scale_out_policy_generation + 1
  ) {
    throw new Error('phase1_prepare_policy_generation_not_next');
  }
  const preparedAt = (input.now ?? (() => new Date()))().toISOString();
  if (!input.execute) {
    const plan: Phase1PolicyPreparation = {
      schemaVersion: PHASE1_SCHEMA_VERSION,
      environmentId: input.config.environment.environmentId,
      preparedAt,
      executed: false,
      previous,
      requested: desired,
      readback: null,
    };
    assertPhase1EvidenceIsSecretFree(plan);
    return plan;
  }
  if (input.confirmation !== PHASE1_PREPARE_CONFIRMATION) {
    throw new Error('phase1_prepare_confirmation_required');
  }

  const updateResults = await input.client.queryD1Batch(
    input.config.environment.controlDatabaseId,
    [
      {
        sql: `UPDATE control_environment_resource_policies
                 SET target_account_count = ?, max_concurrent_provisioning = ?,
                     max_ready_spares = ?,
                     max_d1_resources = ?, daily_d1_create_budget = ?,
                     lookup_target_active_route_count = ?, lookup_forecast_horizon_seconds = ?,
                     lookup_registration_ewma_alpha_bps = ?, lookup_scale_out_headroom_bps = ?,
                     lookup_scale_out_policy_generation = ?, account_forecast_horizon_seconds = ?,
                     account_registration_ewma_alpha_bps = ?, account_scale_out_headroom_bps = ?,
                     account_scale_out_policy_generation = ?, updated_at = ?
               WHERE environment_id = ? AND lookup_scale_out_policy_generation = ?
                 AND account_scale_out_policy_generation = ?`,
        params: [
          desired.targetAccountCount,
          desired.maxConcurrentProvisioning,
          desired.maxReadySpares,
          desired.maxD1Resources,
          desired.dailyD1CreateBudget,
          desired.lookupTargetActiveRouteCount,
          desired.lookupForecastHorizonSeconds,
          desired.lookupEwmaAlphaBps,
          desired.lookupHeadroomBps,
          desired.lookupPolicyGeneration,
          desired.accountForecastHorizonSeconds,
          desired.accountEwmaAlphaBps,
          desired.accountHeadroomBps,
          desired.accountPolicyGeneration,
          Math.floor(Date.parse(preparedAt) / 1000),
          input.config.environment.environmentId,
          previous.policy.lookup_scale_out_policy_generation,
          previous.policy.account_scale_out_policy_generation,
        ],
      },
      ...previous.shardCapacities.map((capacity) => ({
        sql: `UPDATE control_shard_capacity
                 SET target_account_count = ?, updated_at = ?
               WHERE shard_id = ? AND target_account_count = ?`,
        params: [
          desired.targetAccountCount,
          Math.floor(Date.parse(preparedAt) / 1000),
          capacity.shard_id,
          capacity.target_account_count,
        ],
      })),
    ]
  );
  if (
    updateResults.length !== previous.shardCapacities.length + 1 ||
    updateResults.some((result) => result.success === false)
  ) {
    throw new Error('phase1_prepare_update_failed');
  }
  const readback = await readCurrent(input);
  assertReadback(readback, desired);
  const evidence: Phase1PolicyPreparation = {
    schemaVersion: PHASE1_SCHEMA_VERSION,
    environmentId: input.config.environment.environmentId,
    preparedAt,
    executed: true,
    previous,
    requested: desired,
    readback,
  };
  assertPhase1EvidenceIsSecretFree(evidence);
  return evidence;
}

function parseArgs(argv: string[]): { configPath: string; outputPath: string; execute: boolean } {
  let configPath = '';
  let outputPath = '';
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--config') configPath = argv[++index] ?? '';
    else if (argument === '--output') outputPath = argv[++index] ?? '';
    else if (argument === '--execute') execute = true;
    else throw new Error(`phase1_prepare_unknown_argument:${argument}`);
  }
  if (!configPath) throw new Error('phase1_config_path_required');
  if (execute && !outputPath) throw new Error('phase1_prepare_output_path_required');
  return { configPath, outputPath, execute };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = parsePhase1HarnessConfig(JSON.parse(await readFile(options.configPath, 'utf8')));
  const accountId = resolvePhase1Secret(process.env, config.credentials.cloudflareAccountIdEnv);
  const d1 = resolvePhase1Secret(process.env, config.credentials.cloudflareD1WriteTokenEnv);
  const client = new CloudflareControlApiClient({ accountId, tokens: { d1 } });
  const evidence = await preparePhase1Policy({
    config,
    client,
    execute: options.execute,
    confirmation: process.env.AUTHRIM_PHASE1_PREPARE_CONFIRMATION,
  });
  const serialized = `${stableJson(evidence)}\n`;
  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, serialized, { mode: 0o600, flag: 'wx' });
  }
  process.stdout.write(serialized);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'phase1_prepare_failed'}\n`);
    process.exitCode = 1;
  });
}
