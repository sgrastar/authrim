#!/usr/bin/env node

import { chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertControlPlaneRecordIsSecretFree } from '../../packages/ar-lib-core/src/services/control-plane/control-plane-contracts.js';
import { derivePluginInstallationId } from '../../packages/ar-lib-core/src/services/plugin-installation-id.js';
import { AuthrimConfigSchema } from '../../packages/setup/src/core/config.js';
import {
  discoverExternalCapabilities,
  registerExternalCapabilities,
} from '../../packages/setup/src/core/external-capability-registration.js';
import { publishDynamicPluginWorkerBundles } from '../../packages/setup/src/core/dynamic-plugin-publication.js';
import { requestAdminMachineAccessToken } from '../../packages/setup/src/core/admin-machine-access.js';
import { queryD1Rows } from '../../packages/setup/src/core/cloudflare.js';
import { executeSetupPluginControlOperator } from '../../packages/setup/src/core/plugin-control-operator-executor.js';
import { listPendingPluginControlOperatorOperations } from '../../packages/setup/src/core/control-operator-operations.js';
import {
  fetchWithTimeout,
  readResponseJsonWithLimit,
  readResponseTextWithLimit,
} from '../../packages/setup/src/core/http-limits.js';
import { withEphemeralSetupMachineAccess } from '../../packages/setup/src/core/setup-machine-access-lifecycle.js';
import { resolveIssuerUrl } from '../../packages/setup/src/core/url-config.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_ROOT = resolve(
  REPO_ROOT,
  'scripts/control-plane/fixtures/phase2-plugin-resource-live'
);
const PLUGIN_ID = 'phase2-resource-live';
const SAFE_TENANT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_RESULT_PATH = /^\/(?:private\/)?tmp\/[^\0]+\.json$/u;
const MAX_RESPONSE_BYTES = 256 * 1024;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60 * 1_000;

interface LiveOptions {
  environment: 'test';
  tenantId: string;
  resultPath: string;
  mode: 'on' | 'off';
}

interface PluginDetailResponse {
  plugin?: { id?: unknown; backendKind?: unknown; resources?: unknown };
  status?: {
    enabled?: unknown;
    provisioning?: { operationId?: unknown; state?: unknown; kind?: unknown };
  };
}

interface PluginEnableResponse {
  success?: unknown;
  pluginId?: unknown;
  tenantId?: unknown;
  enabled?: unknown;
  provisioning?: { operationId?: unknown; state?: unknown; kind?: unknown };
}

interface LockFile {
  d1?: Record<string, { id?: unknown; name?: unknown }>;
  r2?: Record<string, { name?: unknown }>;
}

function requiredName(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new Error(code);
  }
  return value;
}

export function parseOptions(argv: readonly string[]): LiveOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error('phase2_plugin_resource_live_arguments_invalid');
    }
    if (values.has(key)) throw new Error('phase2_plugin_resource_live_arguments_invalid');
    values.set(key, value);
    index += 1;
  }
  if (
    values.size !== 4 ||
    values.get('--env') !== 'test' ||
    !['on', 'off'].includes(values.get('--mode') ?? '') ||
    !SAFE_TENANT.test(values.get('--tenant') ?? '')
  ) {
    throw new Error('phase2_plugin_resource_live_arguments_invalid');
  }
  const resultPath = resolve(values.get('--result') ?? '');
  if (!SAFE_RESULT_PATH.test(resultPath)) {
    throw new Error('phase2_plugin_resource_live_result_path_invalid');
  }
  return {
    environment: 'test',
    tenantId: values.get('--tenant')!,
    resultPath,
    mode: values.get('--mode') as 'on' | 'off',
  };
}

function apiBaseUrl(config: ReturnType<typeof AuthrimConfigSchema.parse>): string {
  const value = resolveIssuerUrl(config, { env: 'test' });
  if (!value?.startsWith('https://')) throw new Error('phase2_plugin_resource_live_api_invalid');
  return value.replace(/\/+$/u, '');
}

async function adminJson<T>(input: {
  baseUrl: string;
  token: string;
  tenantId: string;
  path: string;
  method?: 'GET' | 'PUT';
  body?: unknown;
  acceptedStatuses: readonly number[];
}): Promise<{ status: number; body: T }> {
  const response = await fetchWithTimeout(
    `${input.baseUrl}${input.path}`,
    {
      method: input.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.token}`,
        'X-Tenant-Id': input.tenantId,
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      redirect: 'manual',
    },
    30_000
  );
  if (!input.acceptedStatuses.includes(response.status)) {
    const detail = await readResponseTextWithLimit(response, 16 * 1024);
    throw new Error(
      `phase2_plugin_resource_live_admin_http_${response.status}:${detail.slice(0, 512)}`
    );
  }
  return {
    status: response.status,
    body: await readResponseJsonWithLimit<T>(response, MAX_RESPONSE_BYTES),
  };
}

function validatePluginDetail(
  value: PluginDetailResponse,
  tenantId: string
): {
  enabled: boolean;
  operationId: string | null;
} {
  if (
    value.plugin?.id !== PLUGIN_ID ||
    value.plugin.backendKind !== 'dynamic_worker' ||
    !Array.isArray(value.plugin.resources) ||
    value.plugin.resources.length !== 3 ||
    typeof value.status?.enabled !== 'boolean'
  ) {
    throw new Error('phase2_plugin_resource_live_plugin_detail_invalid');
  }
  const provisioning = value.status.provisioning;
  if (provisioning === undefined) return { enabled: value.status.enabled, operationId: null };
  if (
    typeof provisioning.operationId !== 'string' ||
    provisioning.kind !== 'provisioning' ||
    !['pending', 'blocked'].includes(String(provisioning.state))
  ) {
    throw new Error('phase2_plugin_resource_live_plugin_detail_invalid');
  }
  if (!SAFE_TENANT.test(tenantId)) throw new Error('phase2_plugin_resource_live_tenant_invalid');
  return { enabled: value.status.enabled, operationId: provisioning.operationId };
}

export function classifyActivationPoll(input: {
  enabled: boolean;
  operationId: string | null;
  expectedOperationId: string;
}): 'complete' | 'waiting' | 'changed' {
  if (input.enabled && input.operationId === null) return 'complete';
  if (input.operationId !== null && input.operationId !== input.expectedOperationId) {
    return 'changed';
  }
  return 'waiting';
}

export function parseReflectedResourceBindings(value: string): Array<{
  name: string;
  type: 'd1' | 'kv_namespace' | 'r2_bucket';
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('phase2_plugin_resource_live_binding_reflection_invalid');
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw new Error('phase2_plugin_resource_live_binding_reflection_invalid');
  }
  const bindings = parsed.map((binding) => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new Error('phase2_plugin_resource_live_binding_reflection_invalid');
    }
    const record = binding as Record<string, unknown>;
    if (
      typeof record.name !== 'string' ||
      !/^PRES_(?:D1|KV|R2)_[A-F0-9]{24}$/u.test(record.name) ||
      !['d1', 'kv_namespace', 'r2_bucket'].includes(String(record.type))
    ) {
      throw new Error('phase2_plugin_resource_live_binding_reflection_invalid');
    }
    return {
      name: record.name,
      type: record.type as 'd1' | 'kv_namespace' | 'r2_bucket',
    };
  });
  if (
    new Set(bindings.map((binding) => binding.name)).size !== 3 ||
    new Set(bindings.map((binding) => binding.type)).size !== 3
  ) {
    throw new Error('phase2_plugin_resource_live_binding_reflection_invalid');
  }
  return bindings.sort((left, right) => left.name.localeCompare(right.name));
}

async function pollActivation(input: {
  baseUrl: string;
  token: string;
  tenantId: string;
  expectedOperationId: string;
}): Promise<number> {
  const startedAt = Date.now();
  let polls = 0;
  while (Date.now() - startedAt <= POLL_TIMEOUT_MS) {
    polls += 1;
    const response = await adminJson<PluginDetailResponse>({
      baseUrl: input.baseUrl,
      token: input.token,
      tenantId: input.tenantId,
      path: `/api/admin/plugins/${PLUGIN_ID}`,
      acceptedStatuses: [200],
    });
    const detail = validatePluginDetail(response.body, input.tenantId);
    const state = classifyActivationPoll({
      ...detail,
      expectedOperationId: input.expectedOperationId,
    });
    if (state === 'complete') return polls;
    if (state === 'changed') {
      throw new Error('phase2_plugin_resource_live_operation_changed');
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
  throw new Error('phase2_plugin_resource_live_activation_timeout');
}

async function executeOperatorProvisioning(input: {
  controlDatabaseId: string;
  controlDatabaseName: string;
  migrationReleaseBucketName: string;
  operationId: string;
  expectedAccountId: string;
}): Promise<string[]> {
  const states: string[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pending = await listPendingPluginControlOperatorOperations({
      controlDatabaseName: input.controlDatabaseName,
      operationId: input.operationId,
    });
    const operation = pending[0];
    if (!operation) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
      continue;
    }
    const result = await executeSetupPluginControlOperator({
      controlDatabaseId: input.controlDatabaseId,
      migrationReleaseBucketName: input.migrationReleaseBucketName,
      operation,
      expectedAccountId: input.expectedAccountId,
      executionId: `phase2-live-${attempt}`,
    });
    states.push(result.state);
    if (result.state === 'awaiting_smoke') return states;
    if (!['awaiting_migration', 'awaiting_worker_bindings'].includes(result.state)) {
      throw new Error(`phase2_plugin_resource_live_operator_${result.state}`);
    }
  }
  throw new Error('phase2_plugin_resource_live_operator_timeout');
}

async function findSucceededProvisioningOperation(input: {
  controlDatabaseName: string;
  tenantId: string;
  pluginInstallationId: string;
}): Promise<string> {
  const operations = await queryD1Rows<{ operation_id: string }>(
    input.controlDatabaseName,
    `SELECT DISTINCT operation.operation_id
       FROM control_operations operation
       JOIN control_plugin_desired_resources resource
         ON resource.operation_id = operation.operation_id
        AND resource.environment_id = operation.environment_id
      WHERE operation.environment_id = 'test'
        AND operation.operation_kind = 'provision_plugin_resources'
        AND operation.status = 'succeeded'
        AND resource.tenant_id = '${input.tenantId}'
        AND resource.plugin_installation_id = '${input.pluginInstallationId}'
      ORDER BY operation.completed_at DESC
      LIMIT 1`
  );
  if (operations.length !== 1) {
    throw new Error('phase2_plugin_resource_live_succeeded_operation_missing');
  }
  return requiredName(
    operations[0]?.operation_id,
    'phase2_plugin_resource_live_succeeded_operation_invalid'
  );
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const config = AuthrimConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, '.authrim/test/config.json'), 'utf8'))
  );
  const expectedAccountId = requiredName(
    config.cloudflare.accountId,
    'phase2_plugin_resource_live_account_missing'
  );
  const pluginInstallationId = await derivePluginInstallationId({
    environmentId: options.environment,
    tenantId: options.tenantId,
    pluginId: PLUGIN_ID,
    purpose: 'dynamic-plugin',
  });
  if (config.controlPlane.automaticProvisioning !== (options.mode === 'on')) {
    throw new Error('phase2_plugin_resource_live_automatic_provisioning_mode_mismatch');
  }
  if (
    config.features.pluginDynamicWorkers.enabled !== true ||
    config.features.r2.enabled !== true
  ) {
    throw new Error('phase2_plugin_resource_live_dynamic_worker_capability_required');
  }
  const lock = JSON.parse(
    await readFile(resolve(REPO_ROOT, '.authrim/test/lock.json'), 'utf8')
  ) as LockFile;
  const controlDatabaseName = requiredName(
    lock.d1?.CONTROL_DB?.name,
    'phase2_plugin_resource_live_control_database_missing'
  );
  const controlDatabaseId = requiredName(
    lock.d1?.CONTROL_DB?.id,
    'phase2_plugin_resource_live_control_database_missing'
  );
  const pluginRunnerDatabaseName = requiredName(
    lock.d1?.PLUGIN_RUNNER_DB?.name,
    'phase2_plugin_resource_live_plugin_database_missing'
  );
  const bucketName = requiredName(
    lock.r2?.PLUGIN_BUNDLES?.name,
    'phase2_plugin_resource_live_bundle_bucket_missing'
  );
  const migrationReleaseBucketName = requiredName(
    lock.r2?.MIGRATION_RELEASES?.name,
    'phase2_plugin_resource_live_migration_bucket_missing'
  );
  const keysDir = resolve(config.keys.secretsPath);
  const sources = await discoverExternalCapabilities({ baseDir: FIXTURE_ROOT });
  const publication = await publishDynamicPluginWorkerBundles({
    baseDir: FIXTURE_ROOT,
    enabled: true,
    sources,
    bucketName,
    pluginRunnerDatabaseName,
  });
  if (publication.published.length !== 1 || publication.published[0]?.pluginId !== PLUGIN_ID) {
    throw new Error('phase2_plugin_resource_live_publication_invalid');
  }
  const registration = await registerExternalCapabilities({
    controlDatabaseName,
    environmentId: options.environment,
    sources,
    registeredBy: 'phase2-plugin-resource-live',
  });
  const activation = await withEphemeralSetupMachineAccess({
    baseDir: REPO_ROOT,
    env: options.environment,
    config,
    keysDir,
    action: async () => {
      const token = await requestAdminMachineAccessToken({
        apiBaseUrl: apiBaseUrl(config),
        keysDir,
        scopes: ['admin:settings:read', 'admin:settings:write'],
      });
      const enable = await adminJson<PluginEnableResponse>({
        baseUrl: apiBaseUrl(config),
        token: token.accessToken,
        tenantId: options.tenantId,
        path: `/api/admin/plugins/${PLUGIN_ID}/enable`,
        method: 'PUT',
        body: { tenant_id: options.tenantId },
        acceptedStatuses: [200, 202],
      });
      if (
        enable.body.success !== true ||
        enable.body.pluginId !== PLUGIN_ID ||
        enable.body.tenantId !== options.tenantId
      ) {
        throw new Error('phase2_plugin_resource_live_enable_response_invalid');
      }
      if (enable.status === 200) {
        if (enable.body.enabled !== true || enable.body.provisioning !== undefined) {
          throw new Error('phase2_plugin_resource_live_enable_response_invalid');
        }
        return {
          operationId: await findSucceededProvisioningOperation({
            controlDatabaseName,
            tenantId: options.tenantId,
            pluginInstallationId,
          }),
          polls: 1,
          operatorStates: ['adopted_succeeded'],
          responseLossAdopted: true,
        };
      }
      if (
        enable.body.enabled !== false ||
        typeof enable.body.provisioning?.operationId !== 'string' ||
        enable.body.provisioning.kind !== 'provisioning'
      ) {
        throw new Error('phase2_plugin_resource_live_enable_response_invalid');
      }
      const operationId = enable.body.provisioning.operationId;
      const operatorStates =
        options.mode === 'off'
          ? await executeOperatorProvisioning({
              controlDatabaseId,
              controlDatabaseName,
              migrationReleaseBucketName,
              operationId,
              expectedAccountId,
            })
          : [];
      const polls = await pollActivation({
        baseUrl: apiBaseUrl(config),
        token: token.accessToken,
        tenantId: options.tenantId,
        expectedOperationId: operationId,
      });
      return { operationId, polls, operatorStates, responseLossAdopted: false };
    },
  });

  const resources = await queryD1Rows<{
    logical_resource_id: string;
    resource_kind: string;
    lifecycle_mode: string;
    provider_resource_id: string | null;
    provider_name: string | null;
    status: string;
  }>(
    controlDatabaseName,
    `SELECT logical_resource_id, resource_kind, lifecycle_mode, provider_resource_id,
            provider_name, status
       FROM control_plugin_desired_resources
      WHERE environment_id = 'test' AND tenant_id = '${options.tenantId}'
        AND plugin_installation_id = '${pluginInstallationId}'
      ORDER BY logical_resource_id`
  );
  const operation = await queryD1Rows<{
    status: string;
    attempt_count: number;
    last_error_code: string | null;
  }>(
    controlDatabaseName,
    `SELECT status, attempt_count, last_error_code FROM control_operations
      WHERE operation_id = '${activation.operationId}' AND environment_id = 'test'`
  );
  const bindingReconciliations = await queryD1Rows<{
    worker_script_name: string;
    state: string;
    desired_bindings_json: string;
    consecutive_smoke_successes: number;
    completed_at: number | null;
  }>(
    controlDatabaseName,
    `SELECT worker_script_name, state, desired_bindings_json,
            consecutive_smoke_successes, completed_at
       FROM control_plugin_resource_binding_reconciliations
      WHERE environment_id = 'test' AND operation_id = '${activation.operationId}'
        AND plugin_installation_id = '${pluginInstallationId}'`
  );
  const reflectedBindings =
    bindingReconciliations.length === 1
      ? parseReflectedResourceBindings(bindingReconciliations[0]!.desired_bindings_json)
      : [];
  if (
    resources.length !== 3 ||
    resources.some(
      (resource) =>
        resource.lifecycle_mode !== 'managed' ||
        resource.status !== 'active' ||
        !resource.provider_resource_id ||
        !resource.provider_name
    ) ||
    new Set(resources.map((resource) => resource.resource_kind)).size !== 3 ||
    operation.length !== 1 ||
    operation[0]?.status !== 'succeeded' ||
    operation[0].last_error_code !== null ||
    bindingReconciliations.length !== 1 ||
    bindingReconciliations[0]?.worker_script_name !== 'test-ar-plugin-runner' ||
    bindingReconciliations[0].state !== 'succeeded' ||
    bindingReconciliations[0].consecutive_smoke_successes < 3 ||
    bindingReconciliations[0].completed_at === null ||
    reflectedBindings.length !== 3
  ) {
    throw new Error('phase2_plugin_resource_live_reflection_invalid');
  }

  const evidence = {
    schemaVersion: 1,
    environment: options.environment,
    tenantId: options.tenantId,
    scenario: `automatic_provisioning_${options.mode}_plugin_resources`,
    pluginId: PLUGIN_ID,
    pluginInstallationId,
    registrationOperationId: registration.operationId,
    provisioningOperationId: activation.operationId,
    pollCount: activation.polls,
    setupOperatorStates: activation.operatorStates,
    responseLossAdopted: activation.responseLossAdopted,
    publication: publication.published[0],
    operation: operation[0],
    resources,
    bindingReconciliation: {
      workerScriptName: bindingReconciliations[0]!.worker_script_name,
      state: bindingReconciliations[0]!.state,
      consecutiveSmokeSuccesses: bindingReconciliations[0]!.consecutive_smoke_successes,
      completedAt: bindingReconciliations[0]!.completed_at,
      bindings: reflectedBindings,
    },
    temporaryMachineAccess: 'deleted',
    tokenEvidence: 'not_persisted',
  };
  assertControlPlaneRecordIsSecretFree(evidence);
  await writeFile(options.resultPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(options.resultPath, 0o600);
  process.stdout.write(
    `Phase 2 plugin resource ${options.mode.toUpperCase()} evidence written to ${options.resultPath}\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'unknown_error'}\n`);
    process.exitCode = 1;
  });
}
