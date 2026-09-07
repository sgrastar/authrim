import {
  activeWorkerDeployment,
  assertControlPlaneRecordIsSecretFree,
  buildRemovingWorkerBindingsSettingsPatch,
  ensureManagedPluginResourceDeleted,
  verifyWorkerSettingsBindingsRemoved,
  type CloudflareControlApiClient,
  type CloudflareD1Query,
  type CloudflareD1QueryResult,
  type CloudflareWorkerBinding,
} from '@authrim/ar-lib-core/control-plane';
import {
  createSetupOperatorD1Client,
  type SetupOperatorExecutionResult,
} from './control-operator-executor.js';
import type { PendingPluginControlCleanupOperation } from './control-operator-operations.js';

type CleanupOperatorClient = CloudflareControlApiClient;
type SqlRow = Record<string, unknown>;

const OPERATION_LEASE_SECONDS = 5 * 60;
const WORKER_LEASE_SECONDS = 15 * 60;
const DRAIN_SECONDS = 30 * 60;

interface CleanupLease {
  operationId: string;
  environmentId: string;
  ownerId: string;
  fencingToken: number;
}

interface WorkerLease {
  environmentId: string;
  workerScriptName: string;
  operationId: string;
  fencingToken: number;
  expectedSourceVersionId: string;
}

function rows<T extends SqlRow>(result: CloudflareD1QueryResult | undefined): T[] {
  if (!result?.success || !Array.isArray(result.results)) {
    throw new Error('control_plugin_cleanup_operator_control_query_failed');
  }
  return result.results as T[];
}

async function batch(
  client: CleanupOperatorClient,
  databaseId: string,
  queries: readonly CloudflareD1Query[]
): Promise<CloudflareD1QueryResult[]> {
  const results = await client.queryD1Batch(databaseId, queries);
  if (results.length !== queries.length || results.some((result) => !result.success)) {
    throw new Error('control_plugin_cleanup_operator_control_query_failed');
  }
  return results;
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^(?:control_plugin_cleanup_operator|control_worker_deployment_lease)_[a-z0-9_]+$/u.test(
    message
  )
    ? message
    : 'control_plugin_cleanup_operator_provider_failed';
}

async function claimOperation(input: {
  client: CleanupOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlCleanupOperation;
  ownerId: string;
  now: number;
}): Promise<CleanupLease | null> {
  const result = await input.client.queryD1(
    input.controlDatabaseId,
    `UPDATE control_operations
        SET status = 'running', lock_owner = ?, lock_expires_at = ?,
            fencing_token = fencing_token + 1, attempt_count = attempt_count + 1,
            next_attempt_at = NULL, last_error_code = NULL, last_error_redacted = NULL,
            started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE operation_id = ? AND environment_id = ?
        AND operation_kind = 'cleanup_plugin_resources'
        AND status = 'blocked' AND last_error_code IN (
          'operator_action_required', 'control_destructive_operations_disabled'
        )
        AND (lock_owner IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ?)
      RETURNING operation_id, environment_id, lock_owner, fencing_token`,
    [
      input.ownerId,
      input.now + OPERATION_LEASE_SECONDS,
      input.now,
      input.now,
      input.operation.operationId,
      input.operation.environmentId,
      input.now,
    ]
  );
  const row = rows<{
    operation_id: string;
    environment_id: string;
    lock_owner: string;
    fencing_token: number;
  }>(result[0])[0];
  if (!row) return null;
  if (
    row.operation_id !== input.operation.operationId ||
    row.environment_id !== input.operation.environmentId ||
    row.lock_owner !== input.ownerId ||
    !Number.isSafeInteger(row.fencing_token) ||
    row.fencing_token < 1
  ) {
    throw new Error('control_plugin_cleanup_operator_lease_invalid');
  }
  return {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    ownerId: row.lock_owner,
    fencingToken: row.fencing_token,
  };
}

function operationFence(lease: CleanupLease): { sql: string; params: unknown[] } {
  return {
    sql: `EXISTS (
      SELECT 1 FROM control_operations operation
       WHERE operation.operation_id = ? AND operation.environment_id = ?
         AND operation.status = 'running' AND operation.lock_owner = ?
         AND operation.fencing_token = ?
    )`,
    params: [lease.operationId, lease.environmentId, lease.ownerId, lease.fencingToken],
  };
}

async function acquireWorkerLease(input: {
  client: CleanupOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlCleanupOperation;
  expectedSourceVersionId: string;
  now: number;
}): Promise<WorkerLease | null> {
  const workerScriptName = input.operation.workerScriptName;
  if (!workerScriptName) throw new Error('control_plugin_cleanup_operator_worker_invalid');
  const result = await input.client.queryD1(
    input.controlDatabaseId,
    `INSERT INTO control_worker_deployment_leases (
       environment_id, worker_script_name, owner_operation_id, fencing_token,
       lease_expires_at, expected_source_version_id, mutation_started, updated_at
     ) VALUES (?, ?, ?, 1, ?, ?, 1, ?)
     ON CONFLICT(environment_id, worker_script_name) DO UPDATE SET
       owner_operation_id = excluded.owner_operation_id,
       fencing_token = control_worker_deployment_leases.fencing_token + 1,
       lease_expires_at = excluded.lease_expires_at,
       expected_source_version_id = excluded.expected_source_version_id,
       mutation_started = 1, updated_at = excluded.updated_at
     WHERE control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
        OR control_worker_deployment_leases.lease_expires_at <= ?
     RETURNING fencing_token`,
    [
      input.operation.environmentId,
      workerScriptName,
      input.operation.operationId,
      input.now + WORKER_LEASE_SECONDS,
      input.expectedSourceVersionId,
      input.now,
      input.now,
    ]
  );
  const row = rows<{ fencing_token: number }>(result[0])[0];
  return row
    ? {
        environmentId: input.operation.environmentId,
        workerScriptName,
        operationId: input.operation.operationId,
        fencingToken: row.fencing_token,
        expectedSourceVersionId: input.expectedSourceVersionId,
      }
    : null;
}

async function workerLeaseIsCurrent(input: {
  client: CleanupOperatorClient;
  controlDatabaseId: string;
  lease: WorkerLease;
  now: number;
}): Promise<boolean> {
  const result = await input.client.queryD1(
    input.controlDatabaseId,
    `SELECT 1 AS active FROM control_worker_deployment_leases
      WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
        AND fencing_token = ? AND expected_source_version_id = ? AND lease_expires_at > ?`,
    [
      input.lease.environmentId,
      input.lease.workerScriptName,
      input.lease.operationId,
      input.lease.fencingToken,
      input.lease.expectedSourceVersionId,
      input.now,
    ]
  );
  return rows<{ active: number }>(result[0])[0]?.active === 1;
}

async function releaseWorkerLease(input: {
  client: CleanupOperatorClient;
  controlDatabaseId: string;
  lease: WorkerLease;
}): Promise<void> {
  await input.client.queryD1(
    input.controlDatabaseId,
    `DELETE FROM control_worker_deployment_leases
      WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
        AND fencing_token = ?`,
    [
      input.lease.environmentId,
      input.lease.workerScriptName,
      input.lease.operationId,
      input.lease.fencingToken,
    ]
  );
}

async function markCurrentStepRunning(input: {
  client: CleanupOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlCleanupOperation;
  lease: CleanupLease;
  now: number;
}): Promise<void> {
  const stepKey =
    input.operation.currentStep === 'binding'
      ? 'remove_plugin_resource_bindings'
      : input.operation.currentStep === 'quarantine'
        ? 'plugin_resource_quarantine_drain'
        : 'delete_managed_plugin_resources';
  const fence = operationFence(input.lease);
  const result = await input.client.queryD1(
    input.controlDatabaseId,
    `UPDATE control_operation_steps
        SET status = 'running', attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, ?), next_attempt_at = NULL,
            last_error_code = NULL, last_error_redacted = NULL, updated_at = ?
      WHERE operation_id = ? AND step_key = ?
        AND status IN ('blocked', 'queued', 'waiting_retry') AND ${fence.sql}
      RETURNING step_key`,
    [input.now, input.now, input.operation.operationId, stepKey, ...fence.params]
  );
  if (rows<{ step_key: string }>(result[0]).length !== 1) {
    throw new Error('control_plugin_cleanup_operator_step_fence_lost');
  }
}

async function removeBindings(input: {
  client: CleanupOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlCleanupOperation;
  now: number;
}): Promise<void> {
  if (input.operation.bindingNames.length === 0) return;
  const workerScriptName = input.operation.workerScriptName;
  if (!workerScriptName) throw new Error('control_plugin_cleanup_operator_worker_invalid');
  const deployments = await input.client.listWorkerDeployments(workerScriptName);
  const active = activeWorkerDeployment(deployments);
  const lease = await acquireWorkerLease({
    ...input,
    expectedSourceVersionId: active.versionId,
  });
  if (!lease) throw new Error('control_worker_deployment_lease_busy');
  try {
    const fencedActive = activeWorkerDeployment(
      await input.client.listWorkerDeployments(workerScriptName)
    );
    if (fencedActive.versionId !== active.versionId) {
      throw new Error('control_plugin_cleanup_operator_worker_source_changed');
    }
    if (!(await workerLeaseIsCurrent({ ...input, lease }))) {
      throw new Error('control_worker_deployment_lease_lost');
    }
    const before = await input.client.getWorkerSettings(workerScriptName);
    const currentNames = new Set(
      (before.bindings ?? []).map((binding: CloudflareWorkerBinding) => binding.name)
    );
    const present = input.operation.bindingNames.filter((name) => currentNames.has(name));
    if (
      input.operation.bindingPresenceRequired &&
      present.length !== input.operation.bindingNames.length
    ) {
      throw new Error('control_plugin_cleanup_operator_binding_presence_mismatch');
    }
    if (present.length === 0) return;
    const patch = buildRemovingWorkerBindingsSettingsPatch({
      currentSettings: before,
      sourceVersionId: active.versionId,
      bindingNames: present,
    });
    try {
      await input.client.patchWorkerSettings(workerScriptName, patch);
    } catch (error) {
      const reflected = await input.client.getWorkerSettings(workerScriptName);
      if (
        (reflected.bindings ?? []).some((binding: CloudflareWorkerBinding) =>
          present.includes(binding.name)
        )
      ) {
        throw error;
      }
    }
    const reflected = await input.client.getWorkerSettings(workerScriptName);
    const reflectedDeployments = await input.client.listWorkerDeployments(workerScriptName);
    const reflectedActive = activeWorkerDeployment(reflectedDeployments);
    if (reflectedActive.versionId === active.versionId) {
      throw new Error('control_plugin_cleanup_operator_binding_propagating');
    }
    const ordered = reflectedDeployments
      .slice()
      .sort((left, right) => Date.parse(right.created_on) - Date.parse(left.created_on));
    if (ordered[0]?.id !== reflectedActive.deploymentId || ordered[1]?.id !== active.deploymentId) {
      throw new Error('control_plugin_cleanup_operator_concurrent_deployment');
    }
    if (
      verifyWorkerSettingsBindingsRemoved({ before, after: reflected, bindingNames: present })
        .length > 0 ||
      (reflected.bindings ?? []).some((binding: CloudflareWorkerBinding) =>
        input.operation.bindingNames.includes(binding.name)
      )
    ) {
      throw new Error('control_plugin_cleanup_operator_binding_reflection_mismatch');
    }
  } finally {
    await releaseWorkerLease({ ...input, lease });
  }
}

async function markQuarantined(input: {
  client: CleanupOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlCleanupOperation;
  lease: CleanupLease;
  now: number;
}): Promise<SetupOperatorExecutionResult> {
  const fence = operationFence(input.lease);
  const drainNotBefore = input.now + DRAIN_SECONDS;
  const results = await batch(input.client, input.controlDatabaseId, [
    {
      sql: `UPDATE control_plugin_resource_cleanup_operations
               SET state = 'quarantined', drain_not_before = ?, last_error_code = NULL,
                   updated_at = ?
             WHERE operation_id = ? AND state IN ('requested', 'removing_bindings')
               AND ${fence.sql}`,
      params: [drainNotBefore, input.now, input.operation.operationId, ...fence.params],
    },
    {
      sql: `UPDATE control_plugin_resource_cleanup_items
               SET state = 'quarantined', last_error_code = NULL, updated_at = ?
             WHERE operation_id = ? AND state = 'pending'`,
      params: [input.now, input.operation.operationId],
    },
    {
      sql: `UPDATE control_plugin_desired_resources
               SET status = 'deleting', updated_at = ?
             WHERE environment_id = ? AND plugin_installation_id = ?
               AND lifecycle_generation = ? AND status <> 'deleted'`,
      params: [
        input.now,
        input.operation.environmentId,
        input.operation.pluginInstallationId,
        input.operation.lifecycleGeneration,
      ],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'succeeded', completed_at = ?, last_error_code = NULL,
                   last_error_redacted = NULL, updated_at = ?
             WHERE operation_id = ? AND step_key = 'remove_plugin_resource_bindings'
               AND status IN ('blocked', 'queued', 'running', 'waiting_retry')`,
      params: [input.now, input.now, input.operation.operationId],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'blocked', next_attempt_at = ?,
                   last_error_code = 'operator_action_required',
                   last_error_redacted = 'operator_action_required', updated_at = ?
             WHERE operation_id = ? AND step_key = 'plugin_resource_quarantine_drain'
               AND status IN ('queued', 'running', 'waiting_retry', 'blocked')`,
      params: [drainNotBefore, input.now, input.operation.operationId],
    },
    {
      sql: `UPDATE control_operations
               SET status = 'blocked', next_attempt_at = ?, lock_owner = NULL,
                   lock_expires_at = NULL, last_error_code = 'operator_action_required',
                   last_error_redacted = 'operator_action_required', updated_at = ?
             WHERE operation_id = ? AND environment_id = ? AND lock_owner = ?
               AND fencing_token = ? AND status = 'running'`,
      params: [
        drainNotBefore,
        input.now,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
  ]);
  if (
    Number(results[0]?.meta?.changes ?? 0) !== 1 ||
    Number(results[5]?.meta?.changes ?? 0) !== 1
  ) {
    throw new Error('control_plugin_cleanup_operator_fence_lost');
  }
  return {
    operationId: input.operation.operationId,
    state: 'awaiting_quarantine',
    errorCode: null,
    nextAttemptAt: drainNotBefore,
  };
}

async function executeDelete(input: {
  client: CleanupOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlCleanupOperation;
  lease: CleanupLease;
  now: number;
}): Promise<SetupOperatorExecutionResult> {
  const fence = operationFence(input.lease);
  await batch(input.client, input.controlDatabaseId, [
    {
      sql: `UPDATE control_plugin_resource_cleanup_operations
               SET state = 'deleting_resources', updated_at = ?
             WHERE operation_id = ? AND state IN ('quarantined', 'deleting_resources',
                                                   'verifying_absence')
               AND ${fence.sql}`,
      params: [input.now, input.operation.operationId, ...fence.params],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'running', attempt_count = attempt_count + 1,
                   started_at = COALESCE(started_at, ?), next_attempt_at = NULL,
                   last_error_code = NULL, last_error_redacted = NULL, updated_at = ?
             WHERE operation_id = ? AND step_key = 'delete_managed_plugin_resources'
               AND status IN ('blocked', 'queued', 'waiting_retry')`,
      params: [input.now, input.now, input.operation.operationId],
    },
  ]);
  for (const item of input.operation.resources) {
    if (item.state === 'deleted' || item.state === 'detached') continue;
    if (item.lifecycleMode === 'existing') {
      await input.client.queryD1(
        input.controlDatabaseId,
        `UPDATE control_plugin_resource_cleanup_items
            SET state = 'detached', completed_at = ?, last_error_code = NULL, updated_at = ?
          WHERE operation_id = ? AND plugin_resource_id = ?
            AND lifecycle_mode = 'existing' AND delete_provider_resource = 0
            AND state IN ('pending', 'quarantined', 'deleting') AND ${fence.sql}`,
        [input.now, input.now, input.operation.operationId, item.pluginResourceId, ...fence.params]
      );
      continue;
    }
    if (!item.deleteProviderResource) {
      throw new Error('control_plugin_cleanup_operator_managed_delete_forbidden');
    }
    await ensureManagedPluginResourceDeleted({
      resource: {
        kind: item.kind,
        providerResourceId: item.providerResourceId,
        providerName: item.providerName,
      },
      api: {
        d1: input.client,
        kv: input.client,
        r2: input.client,
      },
    });
    const reflected = await input.client.queryD1(
      input.controlDatabaseId,
      `UPDATE control_plugin_resource_cleanup_items
          SET state = 'deleted', completed_at = ?, last_error_code = NULL, updated_at = ?
        WHERE operation_id = ? AND plugin_resource_id = ?
          AND lifecycle_mode = 'managed' AND delete_provider_resource = 1
          AND provider_resource_id = ? AND provider_name = ?
          AND ownership_fingerprint = ?
          AND state IN ('pending', 'quarantined', 'deleting') AND ${fence.sql}
        RETURNING plugin_resource_id`,
      [
        input.now,
        input.now,
        input.operation.operationId,
        item.pluginResourceId,
        item.providerResourceId,
        item.providerName,
        item.ownershipFingerprint,
        ...fence.params,
      ]
    );
    if (rows<{ plugin_resource_id: string }>(reflected[0]).length !== 1) {
      throw new Error('control_plugin_cleanup_operator_item_fence_lost');
    }
  }
  const incomplete = await input.client.queryD1(
    input.controlDatabaseId,
    `SELECT COUNT(*) AS count FROM control_plugin_resource_cleanup_items
      WHERE operation_id = ? AND state NOT IN ('deleted', 'detached')`,
    [input.operation.operationId]
  );
  if (Number(rows<{ count: number }>(incomplete[0])[0]?.count ?? -1) !== 0) {
    throw new Error('control_plugin_cleanup_operator_items_incomplete');
  }
  const results = await batch(input.client, input.controlDatabaseId, [
    {
      sql: `DELETE FROM control_plugin_desired_resources
             WHERE environment_id = ? AND plugin_installation_id = ?
               AND lifecycle_generation = ? AND status = 'deleting' AND ${fence.sql}`,
      params: [
        input.operation.environmentId,
        input.operation.pluginInstallationId,
        input.operation.lifecycleGeneration,
        ...fence.params,
      ],
    },
    {
      sql: `UPDATE control_plugin_resource_cleanup_operations
               SET state = 'succeeded', last_error_code = NULL, completed_at = ?, updated_at = ?
             WHERE operation_id = ?
               AND state IN ('quarantined', 'deleting_resources', 'verifying_absence')
               AND ${fence.sql}`,
      params: [input.now, input.now, input.operation.operationId, ...fence.params],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'succeeded', completed_at = ?, next_attempt_at = NULL,
                   last_error_code = NULL, last_error_redacted = NULL, updated_at = ?
             WHERE operation_id = ?
               AND step_key IN ('plugin_resource_quarantine_drain',
                                'delete_managed_plugin_resources')
               AND status IN ('blocked', 'queued', 'running', 'waiting_retry')`,
      params: [input.now, input.now, input.operation.operationId],
    },
    {
      sql: `UPDATE control_operations
               SET status = 'succeeded', completed_at = ?, next_attempt_at = NULL,
                   lock_owner = NULL, lock_expires_at = NULL, last_error_code = NULL,
                   last_error_redacted = NULL, updated_at = ?
             WHERE operation_id = ? AND environment_id = ? AND status = 'running'
               AND lock_owner = ? AND fencing_token = ?`,
      params: [
        input.now,
        input.now,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) < 1 || Number(results[3]?.meta?.changes ?? 0) !== 1) {
    throw new Error('control_plugin_cleanup_operator_completion_fence_lost');
  }
  return {
    operationId: input.operation.operationId,
    state: 'succeeded',
    errorCode: null,
    nextAttemptAt: null,
  };
}

async function recordFailure(input: {
  client: CleanupOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlCleanupOperation;
  lease: CleanupLease;
  now: number;
}): Promise<void> {
  await batch(input.client, input.controlDatabaseId, [
    {
      sql: `UPDATE control_operation_steps
               SET status = 'blocked', next_attempt_at = NULL,
                   last_error_code = 'operator_action_required',
                   last_error_redacted = 'operator_action_required', updated_at = ?
             WHERE operation_id = ? AND status IN ('queued', 'running', 'waiting_retry')`,
      params: [input.now, input.operation.operationId],
    },
    {
      sql: `UPDATE control_plugin_resource_cleanup_operations
               SET last_error_code = 'operator_action_required', updated_at = ?
             WHERE operation_id = ? AND state <> 'succeeded'`,
      params: [input.now, input.operation.operationId],
    },
    {
      sql: `UPDATE control_operations
               SET status = 'blocked', next_attempt_at = NULL, lock_owner = NULL,
                   lock_expires_at = NULL, last_error_code = 'operator_action_required',
                   last_error_redacted = 'operator_action_required', updated_at = ?
             WHERE operation_id = ? AND environment_id = ? AND status = 'running'
               AND lock_owner = ? AND fencing_token = ?`,
      params: [
        input.now,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
  ]);
}

async function releaseForQuarantine(input: {
  client: CleanupOperatorClient;
  controlDatabaseId: string;
  operation: PendingPluginControlCleanupOperation;
  lease: CleanupLease;
  now: number;
  drainNotBefore: number;
}): Promise<void> {
  const fence = operationFence(input.lease);
  const results = await batch(input.client, input.controlDatabaseId, [
    {
      sql: `UPDATE control_operation_steps
               SET status = 'blocked', next_attempt_at = ?,
                   last_error_code = 'operator_action_required',
                   last_error_redacted = 'operator_action_required', updated_at = ?
             WHERE operation_id = ? AND step_key = 'plugin_resource_quarantine_drain'
               AND status = 'running' AND ${fence.sql}`,
      params: [input.drainNotBefore, input.now, input.operation.operationId, ...fence.params],
    },
    {
      sql: `UPDATE control_operations
               SET status = 'blocked', next_attempt_at = ?, lock_owner = NULL,
                   lock_expires_at = NULL, last_error_code = 'operator_action_required',
                   last_error_redacted = 'operator_action_required', updated_at = ?
             WHERE operation_id = ? AND environment_id = ? AND status = 'running'
               AND lock_owner = ? AND fencing_token = ?`,
      params: [
        input.drainNotBefore,
        input.now,
        input.operation.operationId,
        input.operation.environmentId,
        input.lease.ownerId,
        input.lease.fencingToken,
      ],
    },
  ]);
  if (
    Number(results[0]?.meta?.changes ?? 0) !== 1 ||
    Number(results[1]?.meta?.changes ?? 0) !== 1
  ) {
    throw new Error('control_plugin_cleanup_operator_fence_lost');
  }
}

export async function executeSetupPluginCleanupOperator(input: {
  controlDatabaseId: string;
  operation: PendingPluginControlCleanupOperation;
  client?: CleanupOperatorClient;
  expectedAccountId?: string;
  executionId?: string;
  now?: () => number;
}): Promise<SetupOperatorExecutionResult> {
  const client =
    input.client ??
    (await createSetupOperatorD1Client({ expectedAccountId: input.expectedAccountId }));
  const timestamp = (input.now ?? (() => Math.floor(Date.now() / 1_000)))();
  const lease = await claimOperation({
    client,
    controlDatabaseId: input.controlDatabaseId,
    operation: input.operation,
    ownerId: `setup-plugin-cleanup:${input.executionId ?? crypto.randomUUID()}`,
    now: timestamp,
  });
  if (!lease) {
    return {
      operationId: input.operation.operationId,
      state: 'lease_unavailable',
      errorCode: 'control_concurrency_limited',
      nextAttemptAt: null,
    };
  }
  try {
    let result: SetupOperatorExecutionResult;
    if (input.operation.state === 'blocked') {
      const resumedState = input.operation.drainNotBefore === null ? 'requested' : 'quarantined';
      const resumed = await client.queryD1(
        input.controlDatabaseId,
        `UPDATE control_plugin_resource_cleanup_operations
            SET state = ?, last_error_code = NULL, updated_at = ?
          WHERE operation_id = ? AND environment_id = ? AND state = 'blocked'
            AND ${operationFence(lease).sql}
          RETURNING operation_id`,
        [
          resumedState,
          timestamp,
          input.operation.operationId,
          input.operation.environmentId,
          ...operationFence(lease).params,
        ]
      );
      if (rows<{ operation_id: string }>(resumed[0]).length !== 1) {
        throw new Error('control_plugin_cleanup_operator_resume_fence_lost');
      }
    }
    await markCurrentStepRunning({
      client,
      controlDatabaseId: input.controlDatabaseId,
      operation: input.operation,
      lease,
      now: timestamp,
    });
    if (input.operation.currentStep === 'binding') {
      await removeBindings({
        client,
        controlDatabaseId: input.controlDatabaseId,
        operation: input.operation,
        now: timestamp,
      });
      result = await markQuarantined({
        client,
        controlDatabaseId: input.controlDatabaseId,
        operation: input.operation,
        lease,
        now: timestamp,
      });
    } else if (
      input.operation.currentStep === 'quarantine' &&
      timestamp < (input.operation.drainNotBefore ?? Number.MAX_SAFE_INTEGER)
    ) {
      const drainNotBefore = input.operation.drainNotBefore;
      if (drainNotBefore === null) {
        throw new Error('control_plugin_cleanup_operator_drain_missing');
      }
      await releaseForQuarantine({
        client,
        controlDatabaseId: input.controlDatabaseId,
        operation: input.operation,
        lease,
        now: timestamp,
        drainNotBefore,
      });
      result = {
        operationId: input.operation.operationId,
        state: 'awaiting_quarantine',
        errorCode: null,
        nextAttemptAt: drainNotBefore,
      };
    } else {
      result = await executeDelete({
        client,
        controlDatabaseId: input.controlDatabaseId,
        operation: input.operation,
        lease,
        now: timestamp,
      });
    }
    assertControlPlaneRecordIsSecretFree(result);
    return result;
  } catch (error) {
    await recordFailure({
      client,
      controlDatabaseId: input.controlDatabaseId,
      operation: input.operation,
      lease,
      now: timestamp,
    });
    throw new Error(safeErrorCode(error));
  }
}
