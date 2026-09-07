import {
  activeWorkerDeployment,
  assertControlPlaneRecordIsSecretFree,
  buildRemovingWorkerBindingsSettingsPatch,
  ensureManagedPluginResourceDeleted,
  verifyWorkerSettingsBindingsRemoved,
  type ControlPluginResourceCleanupRequest,
  type ControlPluginResourceCleanupView,
} from '@authrim/ar-lib-core/control-plane';
import { derivePluginInstallationId } from '@authrim/ar-lib-core';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type {
  ControlD1ApiClient,
  ControlKvApiClient,
  ControlR2ApiClient,
  ControlWorkersApiClient,
} from './control-api-clients';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_HOST_BINDING = /^PRES_(?:D1|KV|R2)_[A-F0-9]{24}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DRAIN_SECONDS = 30 * 60;
const LEASE_SECONDS = 15 * 60;
const RETRY_SECONDS = 30;
const RETRY_BUDGET_SECONDS = 2 * 60 * 60;

type CleanupState = ControlPluginResourceCleanupView['state'];

interface ResourceRow {
  plugin_resource_id: string;
  operation_id: string;
  resource_kind: 'd1' | 'kv_namespace' | 'r2_bucket';
  lifecycle_mode: 'managed' | 'existing';
  provider_resource_id: string | null;
  provider_name: string | null;
  desired_spec_json: string;
  lifecycle_generation: number;
}

interface BindingRow {
  worker_script_name: string;
  resource_map_json: string;
  state: string;
}

interface CleanupRow {
  operation_id: string;
  environment_id: string;
  plugin_installation_id: string;
  tenant_id: string;
  plugin_id: string;
  source_operation_id: string;
  lifecycle_generation: number;
  reason: 'uninstall' | 'canceled_pre_activation';
  state: CleanupState;
  worker_script_name: string | null;
  binding_names_json: string;
  binding_presence_required: number;
  expected_source_version_id: string | null;
  previous_deployment_id: string | null;
  previous_restore_settings_json: string | null;
  drain_not_before: number | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  managed_resource_count: number;
  detached_resource_count: number;
}

interface CleanupItemRow {
  operation_id: string;
  plugin_resource_id: string;
  resource_kind: 'd1' | 'kv_namespace' | 'r2_bucket';
  lifecycle_mode: 'managed' | 'existing';
  provider_resource_id: string;
  provider_name: string;
  ownership_fingerprint: string;
  delete_provider_resource: number;
  state: 'pending' | 'quarantined' | 'deleting' | 'deleted' | 'detached' | 'blocked';
}

interface DesiredSpec {
  ownershipFingerprint: string;
  ownership: 'authrim_managed' | 'external_reference';
  deleteProviderResource: boolean;
}

interface DeploymentLease {
  environmentId: string;
  workerScriptName: string;
  operationId: string;
  fencingToken: number;
  expectedSourceVersionId: string;
}

export interface PluginResourceCleanupClients {
  d1: Pick<ControlD1ApiClient, 'getD1Database' | 'deleteD1Database'>;
  kv: Pick<ControlKvApiClient, 'listKvNamespaces' | 'deleteKvNamespace'>;
  r2: Pick<ControlR2ApiClient, 'listR2Buckets' | 'deleteR2Bucket'>;
  workers: Pick<
    ControlWorkersApiClient,
    'getWorkerSettings' | 'patchWorkerSettings' | 'listWorkerDeployments'
  >;
}

function safeId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function parseRequest(input: unknown): ControlPluginResourceCleanupRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('control_plugin_cleanup_request_invalid');
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(',');
  if (
    keys !== 'idempotencyKey,pluginId,reason,requestedById,tenantId' &&
    keys !== 'idempotencyKey,pluginId,reason,requestedById,sourceOperationId,tenantId'
  ) {
    throw new Error('control_plugin_cleanup_request_invalid');
  }
  if (
    typeof value.pluginId !== 'string' ||
    !SAFE_PLUGIN_ID.test(value.pluginId) ||
    (value.reason !== 'uninstall' && value.reason !== 'canceled_pre_activation') ||
    (value.reason === 'canceled_pre_activation') !== (value.sourceOperationId !== undefined)
  ) {
    throw new Error('control_plugin_cleanup_request_invalid');
  }
  return {
    tenantId: safeId(value.tenantId, 'control_plugin_cleanup_request_invalid'),
    pluginId: value.pluginId,
    reason: value.reason,
    requestedById: safeId(value.requestedById, 'control_plugin_cleanup_request_invalid'),
    idempotencyKey: safeId(value.idempotencyKey, 'control_plugin_cleanup_request_invalid'),
    ...(value.sourceOperationId === undefined
      ? {}
      : {
          sourceOperationId: safeId(
            value.sourceOperationId,
            'control_plugin_cleanup_request_invalid'
          ),
        }),
  };
}

function parseDesiredSpec(row: ResourceRow): DesiredSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.desired_spec_json);
  } catch {
    throw new Error('control_plugin_cleanup_desired_spec_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('control_plugin_cleanup_desired_spec_invalid');
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.ownershipFingerprint !== 'string' ||
    !SHA256.test(value.ownershipFingerprint) ||
    (value.ownership !== 'authrim_managed' && value.ownership !== 'external_reference') ||
    typeof value.deleteProviderResource !== 'boolean' ||
    (row.lifecycle_mode === 'managed') !== (value.ownership === 'authrim_managed') ||
    (row.lifecycle_mode === 'managed') !== value.deleteProviderResource
  ) {
    throw new Error('control_plugin_cleanup_desired_spec_invalid');
  }
  return value as unknown as DesiredSpec;
}

function parseBindingNames(serialized: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('control_plugin_cleanup_binding_plan_invalid');
  }
  if (!Array.isArray(parsed) || parsed.length > 16) {
    throw new Error('control_plugin_cleanup_binding_plan_invalid');
  }
  const names = parsed.map((value) => {
    if (typeof value !== 'string' || !SAFE_HOST_BINDING.test(value)) {
      throw new Error('control_plugin_cleanup_binding_plan_invalid');
    }
    return value;
  });
  if (new Set(names).size !== names.length) {
    throw new Error('control_plugin_cleanup_binding_plan_invalid');
  }
  return names.sort();
}

function bindingNamesFromMap(serialized: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('control_plugin_cleanup_binding_plan_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('control_plugin_cleanup_binding_plan_invalid');
  }
  const resources = (parsed as Record<string, unknown>).resources;
  if (!Array.isArray(resources) || resources.length > 16) {
    throw new Error('control_plugin_cleanup_binding_plan_invalid');
  }
  return parseBindingNames(
    JSON.stringify(
      resources.map((entry) =>
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).hostBindingRef
          : null
      )
    )
  );
}

async function digest(parts: readonly unknown[]): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(parts))
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function view(row: CleanupRow): ControlPluginResourceCleanupView {
  const result: ControlPluginResourceCleanupView = {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    pluginInstallationId: row.plugin_installation_id,
    tenantId: row.tenant_id,
    pluginId: row.plugin_id,
    sourceOperationId: row.source_operation_id,
    lifecycleGeneration: Number(row.lifecycle_generation),
    reason: row.reason,
    state: row.state,
    drainNotBefore: row.drain_not_before,
    managedResourceCount: Number(row.managed_resource_count),
    detachedResourceCount: Number(row.detached_resource_count),
    lastErrorCode: row.last_error_code,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at,
  };
  assertControlPlaneRecordIsSecretFree(result);
  return result;
}

const VIEW_SQL = `SELECT cleanup.*,
  (SELECT COUNT(*) FROM control_plugin_resource_cleanup_items item
    WHERE item.operation_id = cleanup.operation_id AND item.lifecycle_mode = 'managed')
    AS managed_resource_count,
  (SELECT COUNT(*) FROM control_plugin_resource_cleanup_items item
    WHERE item.operation_id = cleanup.operation_id AND item.lifecycle_mode = 'existing')
    AS detached_resource_count
FROM control_plugin_resource_cleanup_operations cleanup`;

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^cloudflare_[a-z0-9_]+_token_required_for:/u.test(message)) {
    return 'control_plugin_cleanup_capability_unavailable';
  }
  return /^(?:control_plugin_cleanup|control_worker_deployment_lease|worker_settings)_[a-z0-9_]+$/u.test(
    message
  )
    ? message
    : 'control_plugin_cleanup_provider_failed';
}

export class PluginResourceCleanupService {
  constructor(
    private readonly database: D1Database,
    private readonly clients: PluginResourceCleanupClients,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
    private readonly providerDeletionEnabled = true
  ) {}

  async request(
    expectedEnvironmentId: string,
    input: unknown
  ): Promise<ControlPluginResourceCleanupView | null> {
    const environmentId = safeId(
      expectedEnvironmentId,
      'control_plugin_cleanup_environment_invalid'
    );
    const request = parseRequest(input);
    const installationId = await derivePluginInstallationId({
      environmentId,
      tenantId: request.tenantId,
      pluginId: request.pluginId,
      purpose: 'dynamic-plugin',
    });
    const active = await this.getByInstallation(environmentId, installationId, true);
    if (active) {
      if (active.reason !== request.reason) {
        throw new Error('control_plugin_cleanup_request_conflict');
      }
      if (active.state === 'blocked') {
        return this.retryBlocked(active, request.requestedById, request.idempotencyKey);
      }
      return active;
    }

    const resources = await this.database
      .prepare(
        `SELECT plugin_resource_id, operation_id, resource_kind, lifecycle_mode,
                provider_resource_id, provider_name, desired_spec_json, lifecycle_generation
           FROM control_plugin_desired_resources
          WHERE environment_id = ? AND plugin_installation_id = ? AND tenant_id = ?
            AND status <> 'deleted'
          ORDER BY logical_resource_id`
      )
      .bind(environmentId, installationId, request.tenantId)
      .all<ResourceRow>();
    if (resources.results.length === 0) return null;
    const sourceOperationIds = new Set(resources.results.map((row) => row.operation_id));
    const generations = new Set(resources.results.map((row) => Number(row.lifecycle_generation)));
    if (sourceOperationIds.size !== 1 || generations.size !== 1) {
      throw new Error('control_plugin_cleanup_resource_set_invalid');
    }
    const sourceOperationId = [...sourceOperationIds][0];
    const lifecycleGeneration = [...generations][0];
    if (sourceOperationId === undefined || lifecycleGeneration === undefined) {
      throw new Error('control_plugin_cleanup_resource_set_invalid');
    }
    if (request.sourceOperationId && request.sourceOperationId !== sourceOperationId) {
      throw new Error('control_plugin_cleanup_source_operation_mismatch');
    }
    const source = await this.database
      .prepare(
        `SELECT status FROM control_operations
          WHERE operation_id = ? AND environment_id = ?
            AND operation_kind = 'provision_plugin_resources'`
      )
      .bind(sourceOperationId, environmentId)
      .first<{ status: string }>();
    if (!source) throw new Error('control_plugin_cleanup_source_operation_invalid');
    if (
      request.reason === 'canceled_pre_activation' &&
      !['blocked', 'canceled'].includes(source.status)
    ) {
      throw new Error('control_plugin_cleanup_source_operation_not_canceled');
    }

    const binding = await this.database
      .prepare(
        `SELECT worker_script_name, resource_map_json, state
           FROM control_plugin_resource_binding_reconciliations
          WHERE operation_id = ? AND environment_id = ? AND plugin_installation_id = ?`
      )
      .bind(sourceOperationId, environmentId, installationId)
      .first<BindingRow>();
    const bindingNames = binding ? bindingNamesFromMap(binding.resource_map_json) : [];
    const bindingPresenceRequired =
      request.reason === 'uninstall' && binding?.state === 'succeeded' ? 1 : 0;
    const operationDigest = await digest([
      'authrim-plugin-resource-cleanup-v1',
      environmentId,
      installationId,
      lifecycleGeneration,
      request.reason,
      request.idempotencyKey,
    ]);
    const operationId = `op_plugin_cleanup_${operationDigest.slice(0, 32)}`;
    const now = this.now();
    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_operations (
             operation_id, environment_id, operation_kind, idempotency_key, status,
             requested_by_type, requested_by_id, attempt_count, created_at, updated_at
           ) VALUES (?, ?, 'cleanup_plugin_resources', ?, 'queued', 'admin', ?, 0, ?, ?)`
        )
        .bind(
          operationId,
          environmentId,
          `plugin-cleanup:${request.idempotencyKey}`,
          request.requestedById,
          now,
          now
        ),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_plugin_resource_cleanup_operations (
             operation_id, environment_id, plugin_installation_id, tenant_id, plugin_id,
             source_operation_id, lifecycle_generation, reason, state, worker_script_name,
             binding_names_json, binding_presence_required, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?)`
        )
        .bind(
          operationId,
          environmentId,
          installationId,
          request.tenantId,
          request.pluginId,
          sourceOperationId,
          lifecycleGeneration,
          request.reason,
          binding?.worker_script_name ?? null,
          JSON.stringify(bindingNames),
          bindingPresenceRequired,
          now,
          now
        ),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_operation_steps (
             operation_id, step_key, display_order, status, attempt_count, updated_at
           ) VALUES (?, 'remove_plugin_resource_bindings', 10, 'queued', 0, ?)`
        )
        .bind(operationId, now),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_operation_steps (
             operation_id, step_key, display_order, status, attempt_count, updated_at
           ) VALUES (?, 'plugin_resource_quarantine_drain', 20, 'queued', 0, ?)`
        )
        .bind(operationId, now),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_operation_steps (
             operation_id, step_key, display_order, status, attempt_count, updated_at
           ) VALUES (?, 'delete_managed_plugin_resources', 30, 'queued', 0, ?)`
        )
        .bind(operationId, now),
    ];
    for (const resource of resources.results) {
      const desired = parseDesiredSpec(resource);
      if (!resource.provider_resource_id || !resource.provider_name) continue;
      statements.push(
        this.database
          .prepare(
            `INSERT OR IGNORE INTO control_plugin_resource_cleanup_items (
               operation_id, plugin_resource_id, resource_kind, lifecycle_mode,
               provider_resource_id, provider_name, ownership_fingerprint,
               delete_provider_resource, state, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
          )
          .bind(
            operationId,
            resource.plugin_resource_id,
            resource.resource_kind,
            resource.lifecycle_mode,
            resource.provider_resource_id,
            resource.provider_name,
            desired.ownershipFingerprint,
            desired.deleteProviderResource ? 1 : 0,
            now
          )
      );
    }
    statements.push(
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'plugin.resources.cleanup.requested', 'admin', ?,
             'plugin_installation', ?, 'attempted', ?, ?)`
        )
        .bind(
          `audit_plugin_cleanup_${operationDigest.slice(0, 32)}`,
          environmentId,
          operationId,
          request.requestedById,
          installationId,
          JSON.stringify({
            reason: request.reason,
            lifecycleGeneration,
            managedResourceCount: resources.results.filter(
              (row) => row.lifecycle_mode === 'managed' && row.provider_resource_id
            ).length,
            existingResourceCount: resources.results.filter(
              (row) => row.lifecycle_mode === 'existing'
            ).length,
          }),
          now
        )
    );
    await this.database.batch(statements);
    const reflected = await this.getByOperation(environmentId, operationId);
    if (!reflected) throw new Error('control_plugin_cleanup_request_reflection_failed');
    return reflected;
  }

  async requestCanceledProvisioning(
    expectedEnvironmentId: string,
    input: { sourceOperationId: string; requestedById: string; idempotencyKey: string }
  ): Promise<ControlPluginResourceCleanupView> {
    const environmentId = safeId(
      expectedEnvironmentId,
      'control_plugin_cleanup_environment_invalid'
    );
    const sourceOperationId = safeId(
      input.sourceOperationId,
      'control_plugin_cleanup_source_operation_invalid'
    );
    const requestedById = safeId(input.requestedById, 'control_plugin_cleanup_request_invalid');
    const idempotencyKey = safeId(input.idempotencyKey, 'control_plugin_cleanup_request_invalid');
    const rows = await this.database
      .prepare(
        `SELECT DISTINCT tenant_id, json_extract(desired_spec_json, '$.pluginId') AS plugin_id
           FROM control_plugin_desired_resources
          WHERE environment_id = ? AND operation_id = ? AND status <> 'deleted'`
      )
      .bind(environmentId, sourceOperationId)
      .all<{ tenant_id: string; plugin_id: string | null }>();
    const sourceResource = rows.results[0];
    if (
      rows.results.length !== 1 ||
      !sourceResource ||
      !SAFE_ID.test(sourceResource.tenant_id) ||
      !sourceResource.plugin_id ||
      !SAFE_PLUGIN_ID.test(sourceResource.plugin_id)
    ) {
      throw new Error('control_plugin_cleanup_source_operation_invalid');
    }
    const result = await this.request(environmentId, {
      tenantId: sourceResource.tenant_id,
      pluginId: sourceResource.plugin_id,
      reason: 'canceled_pre_activation',
      sourceOperationId,
      requestedById,
      idempotencyKey,
    });
    if (!result) throw new Error('control_plugin_cleanup_source_operation_invalid');
    return result;
  }

  async get(
    expectedEnvironmentId: string,
    input: unknown
  ): Promise<ControlPluginResourceCleanupView | null> {
    const environmentId = safeId(
      expectedEnvironmentId,
      'control_plugin_cleanup_environment_invalid'
    );
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('control_plugin_cleanup_lookup_invalid');
    }
    const value = input as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'pluginId,tenantId') {
      throw new Error('control_plugin_cleanup_lookup_invalid');
    }
    const tenantId = safeId(value.tenantId, 'control_plugin_cleanup_lookup_invalid');
    if (typeof value.pluginId !== 'string' || !SAFE_PLUGIN_ID.test(value.pluginId)) {
      throw new Error('control_plugin_cleanup_lookup_invalid');
    }
    const installationId = await derivePluginInstallationId({
      environmentId,
      tenantId,
      pluginId: value.pluginId,
      purpose: 'dynamic-plugin',
    });
    return this.getByInstallation(environmentId, installationId, false);
  }

  async reconcile(limit = 10): Promise<number> {
    const now = this.now();
    const rows = await this.database
      .prepare(
        `${VIEW_SQL}
          JOIN control_operations operation
            ON operation.operation_id = cleanup.operation_id
           AND operation.environment_id = cleanup.environment_id
         WHERE cleanup.state IN ('requested', 'removing_bindings', 'quarantined',
                                  'deleting_resources', 'verifying_absence')
           AND operation.status IN ('queued', 'running', 'waiting_retry')
           AND (operation.next_attempt_at IS NULL OR operation.next_attempt_at <= ?)
         ORDER BY cleanup.created_at, cleanup.operation_id LIMIT ?`
      )
      .bind(now, Math.max(1, Math.min(25, Math.floor(limit))))
      .all<CleanupRow>();
    let processed = 0;
    for (const row of rows.results) {
      if (await this.reconcileOne(row)) processed += 1;
    }
    return processed;
  }

  private async reconcileOne(row: CleanupRow): Promise<boolean> {
    const now = this.now();
    const claimed = await this.database
      .prepare(
        `UPDATE control_operations
            SET status = 'running', lock_owner = 'plugin-resource-cleanup',
                lock_expires_at = ?, fencing_token = fencing_token + 1,
                attempt_count = attempt_count + 1, next_attempt_at = NULL,
                started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE operation_id = ? AND environment_id = ?
            AND status IN ('queued', 'running', 'waiting_retry')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (lock_owner IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ?)
          RETURNING fencing_token`
      )
      .bind(now + LEASE_SECONDS, now, now, row.operation_id, row.environment_id, now, now)
      .first<{ fencing_token: number }>();
    if (!claimed) return false;
    try {
      if (row.state === 'requested' || row.state === 'removing_bindings') {
        await this.removeBindings(row);
        await this.markQuarantined(row, now);
        return true;
      }
      const drainNotBefore = row.drain_not_before;
      if (row.state === 'quarantined' && drainNotBefore !== null && now < drainNotBefore) {
        await this.wait(row, drainNotBefore, 'control_plugin_cleanup_drain_pending');
        return true;
      }
      if (!this.providerDeletionEnabled) {
        await this.block(row, 'control_destructive_operations_disabled');
        return true;
      }
      await this.deleteResources(row);
      await this.complete(row);
      return true;
    } catch (error) {
      const code = errorCode(error);
      const permanent =
        code.includes('_invalid') ||
        code.includes('_mismatch') ||
        code.includes('_forbidden') ||
        code.includes('_disabled') ||
        code.includes('_unavailable') ||
        this.retryBudgetExpired(row);
      if (permanent) await this.block(row, code);
      else await this.wait(row, this.now() + RETRY_SECONDS, code);
      return true;
    }
  }

  private async removeBindings(row: CleanupRow): Promise<void> {
    const names = parseBindingNames(row.binding_names_json);
    if (names.length === 0) return;
    if (!row.worker_script_name || !SAFE_ID.test(row.worker_script_name)) {
      throw new Error('control_plugin_cleanup_worker_invalid');
    }
    const deployments = await this.clients.workers.listWorkerDeployments(row.worker_script_name);
    const active = activeWorkerDeployment(deployments);
    const lease = await this.acquireLease(row, active.versionId);
    if (!lease) throw new Error('control_worker_deployment_lease_busy');
    try {
      const fencedActive = activeWorkerDeployment(
        await this.clients.workers.listWorkerDeployments(row.worker_script_name)
      );
      if (fencedActive.versionId !== lease.expectedSourceVersionId) {
        throw new Error('control_plugin_cleanup_worker_source_changed');
      }
      if (!(await this.leaseIsCurrent(lease))) {
        throw new Error('control_worker_deployment_lease_lost');
      }
      const before = await this.clients.workers.getWorkerSettings(row.worker_script_name);
      const currentNames = new Set((before.bindings ?? []).map((binding) => binding.name));
      const present = names.filter((name) => currentNames.has(name));
      if (row.binding_presence_required === 1 && present.length !== names.length) {
        throw new Error('control_plugin_cleanup_binding_presence_mismatch');
      }
      if (present.length === 0) return;
      const patch = buildRemovingWorkerBindingsSettingsPatch({
        currentSettings: before,
        sourceVersionId: active.versionId,
        bindingNames: present,
      });
      await this.database
        .prepare(
          `UPDATE control_plugin_resource_cleanup_operations
              SET state = 'removing_bindings', expected_source_version_id = ?,
                  previous_deployment_id = ?, previous_restore_settings_json = ?, updated_at = ?
            WHERE operation_id = ? AND state IN ('requested', 'removing_bindings')`
        )
        .bind(
          active.versionId,
          active.deploymentId,
          JSON.stringify(before),
          this.now(),
          row.operation_id
        )
        .run();
      if (!(await this.leaseIsCurrent(lease))) {
        throw new Error('control_worker_deployment_lease_lost');
      }
      try {
        await this.clients.workers.patchWorkerSettings(row.worker_script_name, patch);
      } catch (error) {
        const reflected = await this.clients.workers.getWorkerSettings(row.worker_script_name);
        if ((reflected.bindings ?? []).some((binding) => present.includes(binding.name)))
          throw error;
      }
      const reflected = await this.clients.workers.getWorkerSettings(row.worker_script_name);
      const reflectedDeployments = await this.clients.workers.listWorkerDeployments(
        row.worker_script_name
      );
      const reflectedActive = activeWorkerDeployment(reflectedDeployments);
      if (reflectedActive.versionId === active.versionId) {
        throw new Error('control_plugin_cleanup_binding_propagating');
      }
      const ordered = reflectedDeployments
        .slice()
        .sort((left, right) => Date.parse(right.created_on) - Date.parse(left.created_on));
      if (
        ordered[0]?.id !== reflectedActive.deploymentId ||
        ordered[1]?.id !== active.deploymentId
      ) {
        throw new Error('control_plugin_cleanup_concurrent_deployment');
      }
      const issues = verifyWorkerSettingsBindingsRemoved({
        before,
        after: reflected,
        bindingNames: present,
      });
      if (issues.length > 0) throw new Error('control_plugin_cleanup_binding_reflection_mismatch');
      if ((reflected.bindings ?? []).some((binding) => names.includes(binding.name))) {
        throw new Error('control_plugin_cleanup_binding_reflection_mismatch');
      }
    } finally {
      await this.releaseLease(lease);
    }
  }

  private async markQuarantined(row: CleanupRow, now: number): Promise<void> {
    const drainNotBefore = now + DRAIN_SECONDS;
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND step_key = 'remove_plugin_resource_bindings'
              AND status = 'queued'`
        )
        .bind(now, now, row.operation_id),
      this.database
        .prepare(
          `UPDATE control_plugin_resource_cleanup_operations
              SET state = 'quarantined', drain_not_before = ?, last_error_code = NULL,
                  updated_at = ?
            WHERE operation_id = ? AND state IN ('requested', 'removing_bindings')`
        )
        .bind(drainNotBefore, now, row.operation_id),
      this.database
        .prepare(
          `UPDATE control_plugin_resource_cleanup_items
              SET state = 'quarantined', last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND state = 'pending'`
        )
        .bind(now, row.operation_id),
      this.database
        .prepare(
          `UPDATE control_plugin_desired_resources
              SET status = 'deleting', updated_at = ?
            WHERE environment_id = ? AND plugin_installation_id = ?
              AND lifecycle_generation = ? AND status <> 'deleted'`
        )
        .bind(now, row.environment_id, row.plugin_installation_id, row.lifecycle_generation),
      this.database
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'succeeded', completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND step_key = 'remove_plugin_resource_bindings'
              AND status IN ('queued', 'running', 'waiting_retry')`
        )
        .bind(now, now, row.operation_id),
      this.database
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND step_key = 'plugin_resource_quarantine_drain'
              AND status = 'queued'`
        )
        .bind(now, now, row.operation_id),
      this.database
        .prepare(
          `UPDATE control_operations
              SET status = 'waiting_retry', next_attempt_at = ?, lock_owner = NULL,
                  lock_expires_at = NULL, last_error_code = NULL, last_error_redacted = NULL,
                  updated_at = ?
            WHERE operation_id = ? AND status = 'running'`
        )
        .bind(drainNotBefore, now, row.operation_id),
    ]);
  }

  private async deleteResources(row: CleanupRow): Promise<void> {
    const now = this.now();
    await this.database
      .prepare(
        `UPDATE control_plugin_resource_cleanup_operations
            SET state = 'deleting_resources', updated_at = ?
          WHERE operation_id = ? AND state IN ('quarantined', 'deleting_resources',
                                                'verifying_absence')`
      )
      .bind(now, row.operation_id)
      .run();
    await this.database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'succeeded', completed_at = ?, updated_at = ?
          WHERE operation_id = ? AND step_key = 'plugin_resource_quarantine_drain'
            AND status = 'running'`
      )
      .bind(now, now, row.operation_id)
      .run();
    await this.database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE operation_id = ? AND step_key = 'delete_managed_plugin_resources'
            AND status = 'queued'`
      )
      .bind(now, now, row.operation_id)
      .run();
    const items = await this.database
      .prepare(
        `SELECT operation_id, plugin_resource_id, resource_kind, lifecycle_mode,
                provider_resource_id, provider_name, ownership_fingerprint,
                delete_provider_resource, state
           FROM control_plugin_resource_cleanup_items
          WHERE operation_id = ? AND state IN ('pending', 'quarantined', 'deleting')
          ORDER BY plugin_resource_id`
      )
      .bind(row.operation_id)
      .all<CleanupItemRow>();
    for (const item of items.results) {
      if (item.lifecycle_mode === 'existing') {
        await this.markItemTerminal(item, 'detached');
        continue;
      }
      if (item.delete_provider_resource !== 1) {
        throw new Error('control_plugin_cleanup_managed_delete_forbidden');
      }
      await this.database
        .prepare(
          `UPDATE control_plugin_resource_cleanup_items
              SET state = 'deleting', updated_at = ?
            WHERE operation_id = ? AND plugin_resource_id = ?
              AND state IN ('pending', 'quarantined', 'deleting')`
        )
        .bind(this.now(), item.operation_id, item.plugin_resource_id)
        .run();
      await this.deleteManaged(item);
      await this.markItemTerminal(item, 'deleted');
    }
    await this.database
      .prepare(
        `UPDATE control_plugin_resource_cleanup_operations
            SET state = 'verifying_absence', updated_at = ?
          WHERE operation_id = ? AND state = 'deleting_resources'`
      )
      .bind(this.now(), row.operation_id)
      .run();
  }

  private async deleteManaged(item: CleanupItemRow): Promise<void> {
    await ensureManagedPluginResourceDeleted({
      resource: {
        kind: item.resource_kind,
        providerResourceId: item.provider_resource_id,
        providerName: item.provider_name,
      },
      api: this.clients,
    });
  }

  private async markItemTerminal(
    item: CleanupItemRow,
    state: 'deleted' | 'detached'
  ): Promise<void> {
    const now = this.now();
    await this.database
      .prepare(
        `UPDATE control_plugin_resource_cleanup_items
            SET state = ?, last_error_code = NULL, completed_at = ?, updated_at = ?
          WHERE operation_id = ? AND plugin_resource_id = ?
            AND state IN ('pending', 'quarantined', 'deleting')`
      )
      .bind(state, now, now, item.operation_id, item.plugin_resource_id)
      .run();
  }

  private async complete(row: CleanupRow): Promise<void> {
    const incomplete = await this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM control_plugin_resource_cleanup_items
          WHERE operation_id = ? AND state NOT IN ('deleted', 'detached')`
      )
      .bind(row.operation_id)
      .first<{ count: number }>();
    if (Number(incomplete?.count ?? 0) !== 0) {
      throw new Error('control_plugin_cleanup_items_incomplete');
    }
    const now = this.now();
    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `DELETE FROM control_plugin_desired_resources
            WHERE environment_id = ? AND plugin_installation_id = ?
              AND lifecycle_generation = ? AND status = 'deleting'`
        )
        .bind(row.environment_id, row.plugin_installation_id, row.lifecycle_generation),
      this.database
        .prepare(
          `UPDATE control_plugin_resource_cleanup_operations
              SET state = 'succeeded', last_error_code = NULL, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND state IN ('deleting_resources', 'verifying_absence')`
        )
        .bind(now, now, row.operation_id),
      this.database
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'succeeded', completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND step_key = 'delete_managed_plugin_resources'
              AND status IN ('queued', 'running', 'waiting_retry')`
        )
        .bind(now, now, row.operation_id),
      this.database
        .prepare(
          `UPDATE control_operations
              SET status = 'succeeded', completed_at = ?, lock_owner = NULL,
                  lock_expires_at = NULL, next_attempt_at = NULL, last_error_code = NULL,
                  last_error_redacted = NULL, updated_at = ?
            WHERE operation_id = ? AND status = 'running'`
        )
        .bind(now, now, row.operation_id),
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'plugin.resources.cleanup.completed', 'worker', 'ar-control',
             'plugin_installation', ?, 'succeeded', ?, ?)`
        )
        .bind(
          `audit_plugin_cleanup_complete_${row.operation_id.slice(-48)}`,
          row.environment_id,
          row.operation_id,
          row.plugin_installation_id,
          JSON.stringify({
            reason: row.reason,
            lifecycleGeneration: row.lifecycle_generation,
          }),
          now
        ),
    ];
    const results = await this.database.batch(statements);
    if (Number(results[0]?.meta?.changes ?? 0) < 1) {
      throw new Error('control_plugin_cleanup_desired_state_not_removed');
    }
  }

  private async wait(row: CleanupRow, nextAttemptAt: number, code: string): Promise<void> {
    const now = this.now();
    await this.database
      .prepare(
        `UPDATE control_operations
            SET status = 'waiting_retry', next_attempt_at = ?, lock_owner = NULL,
                lock_expires_at = NULL, last_error_code = ?, last_error_redacted = ?, updated_at = ?
          WHERE operation_id = ? AND status = 'running'`
      )
      .bind(nextAttemptAt, code, code, now, row.operation_id)
      .run();
  }

  private retryBudgetExpired(row: CleanupRow): boolean {
    const startedAt = row.drain_not_before ?? row.created_at;
    return this.now() - startedAt >= RETRY_BUDGET_SECONDS;
  }

  private async block(row: CleanupRow, code: string): Promise<void> {
    const now = this.now();
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'blocked', next_attempt_at = NULL,
                  last_error_code = ?, last_error_redacted = ?, updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'running', 'waiting_retry')`
        )
        .bind(code, code, now, row.operation_id),
      this.database
        .prepare(
          `UPDATE control_plugin_resource_cleanup_operations
              SET state = 'blocked', last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND state <> 'succeeded'`
        )
        .bind(code, now, row.operation_id),
      this.database
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', next_attempt_at = NULL, lock_owner = NULL,
                  lock_expires_at = NULL, last_error_code = ?, last_error_redacted = ?, updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'running', 'waiting_retry')`
        )
        .bind(code, code, now, row.operation_id),
    ]);
  }

  private async retryBlocked(
    cleanup: ControlPluginResourceCleanupView,
    requestedById: string,
    idempotencyKey: string
  ): Promise<ControlPluginResourceCleanupView> {
    const now = this.now();
    const nextState = cleanup.drainNotBefore === null ? 'requested' : 'quarantined';
    const idempotencyDigest = await digest([idempotencyKey]);
    const eventId = `audit_plugin_cleanup_retry_${cleanup.operationId.slice(-32)}_${idempotencyDigest.slice(0, 16)}`;
    await this.database.batch([
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'plugin.resources.cleanup.retry_requested', 'admin', ?,
             'plugin_installation', ?, 'attempted', ?, ?)`
        )
        .bind(
          eventId,
          cleanup.environmentId,
          cleanup.operationId,
          requestedById,
          cleanup.pluginInstallationId,
          JSON.stringify({
            idempotencyDigest,
            previousErrorCode: cleanup.lastErrorCode,
          }),
          now
        ),
      this.database
        .prepare(
          `UPDATE control_plugin_resource_cleanup_operations
              SET state = ?, last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND state = 'blocked'
              AND EXISTS (SELECT 1 FROM control_audit_events WHERE event_id = ?)`
        )
        .bind(nextState, now, cleanup.operationId, cleanup.environmentId, eventId),
      this.database
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', next_attempt_at = NULL, last_error_code = NULL,
                  last_error_redacted = NULL, started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND status = 'blocked'
              AND step_key = CASE WHEN ? = 'requested'
                THEN 'remove_plugin_resource_bindings'
                WHEN ? = 'quarantined' THEN 'delete_managed_plugin_resources'
                ELSE step_key END
              AND EXISTS (SELECT 1 FROM control_audit_events WHERE event_id = ?)`
        )
        .bind(now, now, cleanup.operationId, nextState, nextState, eventId),
      this.database
        .prepare(
          `UPDATE control_operations
              SET status = 'running', next_attempt_at = NULL, lock_owner = NULL,
                  lock_expires_at = NULL, last_error_code = NULL, last_error_redacted = NULL,
                  updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'blocked'
              AND EXISTS (SELECT 1 FROM control_audit_events WHERE event_id = ?)`
        )
        .bind(now, cleanup.operationId, cleanup.environmentId, eventId),
    ]);
    const reflected = await this.getByOperation(cleanup.environmentId, cleanup.operationId);
    if (!reflected || reflected.state !== nextState) {
      throw new Error('control_plugin_cleanup_retry_conflict');
    }
    return reflected;
  }

  private async acquireLease(
    row: CleanupRow,
    expectedSourceVersionId: string
  ): Promise<DeploymentLease | null> {
    const workerScriptName = row.worker_script_name;
    if (!workerScriptName) throw new Error('control_plugin_cleanup_worker_invalid');
    const now = this.now();
    const lease = await this.database
      .prepare(
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
         RETURNING fencing_token`
      )
      .bind(
        row.environment_id,
        workerScriptName,
        row.operation_id,
        now + LEASE_SECONDS,
        expectedSourceVersionId,
        now,
        now
      )
      .first<{ fencing_token: number }>();
    return lease
      ? {
          environmentId: row.environment_id,
          workerScriptName,
          operationId: row.operation_id,
          fencingToken: Number(lease.fencing_token),
          expectedSourceVersionId,
        }
      : null;
  }

  private async releaseLease(lease: DeploymentLease): Promise<void> {
    await this.database
      .prepare(
        `DELETE FROM control_worker_deployment_leases
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND fencing_token = ?`
      )
      .bind(lease.environmentId, lease.workerScriptName, lease.operationId, lease.fencingToken)
      .run();
  }

  private async leaseIsCurrent(lease: DeploymentLease): Promise<boolean> {
    const row = await this.database
      .prepare(
        `SELECT 1 AS active FROM control_worker_deployment_leases
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND fencing_token = ? AND lease_expires_at > ?`
      )
      .bind(
        lease.environmentId,
        lease.workerScriptName,
        lease.operationId,
        lease.fencingToken,
        this.now()
      )
      .first<{ active: number }>();
    return row?.active === 1;
  }

  private async getByOperation(
    environmentId: string,
    operationId: string
  ): Promise<ControlPluginResourceCleanupView | null> {
    const row = await this.database
      .prepare(`${VIEW_SQL} WHERE cleanup.environment_id = ? AND cleanup.operation_id = ?`)
      .bind(environmentId, operationId)
      .first<CleanupRow>();
    return row ? view(row) : null;
  }

  private async getByInstallation(
    environmentId: string,
    installationId: string,
    onlyActive: boolean
  ): Promise<ControlPluginResourceCleanupView | null> {
    const row = await this.database
      .prepare(
        `${VIEW_SQL} WHERE cleanup.environment_id = ? AND cleanup.plugin_installation_id = ?
          ${onlyActive ? "AND cleanup.state <> 'succeeded'" : ''}
          ORDER BY cleanup.lifecycle_generation DESC, cleanup.created_at DESC LIMIT 1`
      )
      .bind(environmentId, installationId)
      .first<CleanupRow>();
    return row ? view(row) : null;
  }
}
