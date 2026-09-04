import {
  CloudflareControlApiError,
  activeWorkerDeployment,
  ensureWorkerBindingsPatched,
  pluginResourceHostBindingRef,
  verifyWorkerSettingsRestoreIntent,
  type CloudflareWorkerBinding,
  type CloudflareWorkerDeployment,
  type CloudflareWorkerSettings,
  type WorkerBindingPatchLease,
  type WorkerBindingPatchState,
} from '@authrim/ar-lib-core/control-plane';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { ControlEnv, RuntimeSmokeServiceBinding } from './types';
import {
  consumeServiceBindingInvocation,
  type ServiceBindingInvocationBudget,
} from './service-binding-invocation-budget';

const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_LOGICAL_RESOURCE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SAFE_HOST_BINDING = /^PRES_(?:D1|KV|R2)_[A-F0-9]{24}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RESOURCES = 16;
const RETRY_SECONDS = 15;
const STABILIZATION_SECONDS = 30;
const LEASE_SECONDS = 15 * 60;

type ResourceKind = 'd1' | 'kv_namespace' | 'r2_bucket';
type ResourceAccess = 'read_only' | 'read_write';

interface CandidateRow {
  operation_id: string;
  environment_id: string;
  environment_name: string;
  operation_status: string;
  plugin_installation_id: string;
  tenant_id: string;
  resource_kind: ResourceKind;
  logical_resource_id: string;
  binding_name: string;
  lifecycle_mode: 'managed' | 'existing';
  provider_resource_id: string | null;
  provider_name: string | null;
  provider_create_state: 'not_started' | 'issued' | 'identified' | 'legacy_unverified';
  provider_creation_date: string | null;
  provider_ownership_marker_key: string | null;
  provider_ownership_id: string | null;
  provider_identity_checkpointed_at: number | null;
  desired_spec_json: string;
  status: string;
  migration_state: string | null;
  migration_provider_database_id: string | null;
}

interface InventoryRow {
  worker_script_name: string;
}

interface TargetRow {
  operation_id: string;
  environment_id: string;
  environment_name: string;
  plugin_installation_id: string;
  tenant_id: string;
  worker_script_name: string;
  desired_bindings_json: string;
  resource_map_json: string;
  state: PluginResourceBindingTarget['state'];
  expected_source_version_id: string | null;
  previous_deployment_id: string | null;
  patch_result_version_id: string | null;
  patch_result_deployment_id: string | null;
  previous_restore_settings_json: string | null;
  smoke_attempt_count: number;
  consecutive_smoke_successes: number;
  stabilization_not_before: number | null;
  last_error_code: string | null;
}

interface DesiredSpec {
  pluginId: string;
  binding: string;
  kind: ResourceKind;
  access: ResourceAccess;
  ownershipFingerprint: string;
  capabilityManifestDigest: string;
}

export interface PluginResourceMapEntry {
  logicalResourceId: string;
  binding: string;
  hostBindingRef: string;
  kind: ResourceKind;
  access: ResourceAccess;
  ownershipFingerprint: string;
}

interface PluginResourceMap {
  schemaVersion: 1;
  pluginId: string;
  capabilityManifestDigest: string;
  resources: PluginResourceMapEntry[];
}

export interface PluginResourceBindingTarget {
  operationId: string;
  environmentId: string;
  environmentName: string;
  pluginInstallationId: string;
  tenantId: string;
  workerScriptName: string;
  desiredBindingsJson: string;
  resourceMapJson: string;
  state:
    | 'pending'
    | 'settings_patched'
    | 'smoke_verifying'
    | 'stabilizing'
    | 'succeeded'
    | 'rollback_required'
    | 'rolled_back'
    | 'blocked';
  expectedSourceVersionId: string | null;
  previousDeploymentId: string | null;
  patchResultVersionId: string | null;
  patchResultDeploymentId: string | null;
  previousRestoreSettingsJson: string | null;
  smokeAttemptCount: number;
  consecutiveSmokeSuccesses: number;
  stabilizationNotBefore: number | null;
  lastErrorCode: string | null;
}

interface DeploymentLease extends WorkerBindingPatchLease {
  environmentId: string;
  workerScriptName: string;
  ownerOperationId: string;
  fencingToken: number;
  leaseExpiresAt: number;
  patchResultVersionId: string | null;
  patchResultDeploymentId: string | null;
}

interface LeaseRow {
  environment_id: string;
  worker_script_name: string;
  owner_operation_id: string;
  fencing_token: number;
  lease_expires_at: number;
  expected_source_version_id: string;
  previous_deployment_id: string | null;
  patch_result_version_id: string | null;
  patch_result_deployment_id: string | null;
  mutation_started: number;
  mutation_started_at: number | null;
}

interface WorkerSettingsApi {
  getWorkerSettings(scriptName: string): Promise<CloudflareWorkerSettings>;
  patchWorkerSettings(
    scriptName: string,
    settings: CloudflareWorkerSettings
  ): Promise<CloudflareWorkerSettings>;
  listWorkerDeployments(scriptName: string): Promise<CloudflareWorkerDeployment[]>;
}

export interface PluginResourceBindingReconcilerResult {
  attempted: number;
  succeeded: number;
  deferred: number;
  blocked: number;
}

function target(row: TargetRow): PluginResourceBindingTarget {
  return {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    environmentName: row.environment_name,
    pluginInstallationId: row.plugin_installation_id,
    tenantId: row.tenant_id,
    workerScriptName: row.worker_script_name,
    desiredBindingsJson: row.desired_bindings_json,
    resourceMapJson: row.resource_map_json,
    state: row.state,
    expectedSourceVersionId: row.expected_source_version_id,
    previousDeploymentId: row.previous_deployment_id,
    patchResultVersionId: row.patch_result_version_id,
    patchResultDeploymentId: row.patch_result_deployment_id,
    previousRestoreSettingsJson: row.previous_restore_settings_json,
    smokeAttemptCount: Number(row.smoke_attempt_count),
    consecutiveSmokeSuccesses: Number(row.consecutive_smoke_successes),
    stabilizationNotBefore: row.stabilization_not_before,
    lastErrorCode: row.last_error_code,
  };
}

function lease(row: LeaseRow): DeploymentLease {
  return {
    environmentId: row.environment_id,
    workerScriptName: row.worker_script_name,
    ownerOperationId: row.owner_operation_id,
    fencingToken: Number(row.fencing_token),
    leaseExpiresAt: Number(row.lease_expires_at),
    expectedSourceVersionId: row.expected_source_version_id,
    previousDeploymentId: row.previous_deployment_id,
    patchResultVersionId: row.patch_result_version_id,
    patchResultDeploymentId: row.patch_result_deployment_id,
    mutationStarted: row.mutation_started === 1,
    mutationStartedAt: row.mutation_started_at,
  };
}

function parseJsonRecord(serialized: string, code: string): Record<string, unknown> {
  if (new TextEncoder().encode(serialized).byteLength > 1024 * 1024) throw new Error(code);
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error(code);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function desiredSpec(row: CandidateRow): DesiredSpec {
  const value = parseJsonRecord(row.desired_spec_json, 'plugin_resource_binding_spec_invalid');
  if (
    typeof value.pluginId !== 'string' ||
    !SAFE_PLUGIN_ID.test(value.pluginId) ||
    value.binding !== row.binding_name ||
    value.kind !== row.resource_kind ||
    (value.access !== 'read_only' && value.access !== 'read_write') ||
    typeof value.ownershipFingerprint !== 'string' ||
    !SHA256.test(value.ownershipFingerprint) ||
    typeof value.capabilityManifestDigest !== 'string' ||
    !SHA256.test(value.capabilityManifestDigest)
  ) {
    throw new Error('plugin_resource_binding_spec_invalid');
  }
  return value as unknown as DesiredSpec;
}

export { pluginResourceHostBindingRef } from '@authrim/ar-lib-core/control-plane';

function desiredBinding(row: CandidateRow, hostBindingRef: string): CloudflareWorkerBinding {
  if (!row.provider_resource_id || !row.provider_name) {
    throw new Error('plugin_resource_binding_provider_identity_missing');
  }
  if (row.resource_kind === 'd1') {
    return { name: hostBindingRef, type: 'd1', database_id: row.provider_resource_id };
  }
  if (row.resource_kind === 'kv_namespace') {
    return { name: hostBindingRef, type: 'kv_namespace', namespace_id: row.provider_resource_id };
  }
  return { name: hostBindingRef, type: 'r2_bucket', bucket_name: row.provider_name };
}

function parseDesiredBindings(serialized: string): CloudflareWorkerBinding[] {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('plugin_resource_binding_plan_invalid');
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RESOURCES) {
    throw new Error('plugin_resource_binding_plan_invalid');
  }
  const names = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('plugin_resource_binding_plan_invalid');
    }
    const binding = entry as CloudflareWorkerBinding;
    if (
      typeof binding.name !== 'string' ||
      !SAFE_HOST_BINDING.test(binding.name) ||
      names.has(binding.name) ||
      !['d1', 'kv_namespace', 'r2_bucket'].includes(binding.type)
    ) {
      throw new Error('plugin_resource_binding_plan_invalid');
    }
    if (
      (binding.type === 'd1' && typeof binding.database_id !== 'string') ||
      (binding.type === 'kv_namespace' && typeof binding.namespace_id !== 'string') ||
      (binding.type === 'r2_bucket' && typeof binding.bucket_name !== 'string')
    ) {
      throw new Error('plugin_resource_binding_plan_invalid');
    }
    names.add(binding.name);
    return binding;
  });
}

function parseResourceMap(serialized: string): PluginResourceMap {
  const value = parseJsonRecord(serialized, 'plugin_resource_binding_map_invalid');
  if (
    Object.keys(value).sort().join(',') !==
      'capabilityManifestDigest,pluginId,resources,schemaVersion' ||
    value.schemaVersion !== 1 ||
    typeof value.pluginId !== 'string' ||
    !SAFE_PLUGIN_ID.test(value.pluginId) ||
    typeof value.capabilityManifestDigest !== 'string' ||
    !SHA256.test(value.capabilityManifestDigest) ||
    !Array.isArray(value.resources) ||
    value.resources.length < 1 ||
    value.resources.length > MAX_RESOURCES
  ) {
    throw new Error('plugin_resource_binding_map_invalid');
  }
  const logicalIds = new Set<string>();
  const bindings = new Set<string>();
  const hostBindings = new Set<string>();
  const resources = value.resources.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('plugin_resource_binding_map_invalid');
    }
    const resource = entry as Record<string, unknown>;
    if (
      Object.keys(resource).sort().join(',') !==
        'access,binding,hostBindingRef,kind,logicalResourceId,ownershipFingerprint' ||
      typeof resource.logicalResourceId !== 'string' ||
      !SAFE_LOGICAL_RESOURCE.test(resource.logicalResourceId) ||
      typeof resource.binding !== 'string' ||
      !SAFE_BINDING.test(resource.binding) ||
      typeof resource.hostBindingRef !== 'string' ||
      !SAFE_HOST_BINDING.test(resource.hostBindingRef) ||
      (resource.kind !== 'd1' &&
        resource.kind !== 'kv_namespace' &&
        resource.kind !== 'r2_bucket') ||
      (resource.access !== 'read_only' && resource.access !== 'read_write') ||
      typeof resource.ownershipFingerprint !== 'string' ||
      !SHA256.test(resource.ownershipFingerprint) ||
      pluginResourceHostBindingRef(resource.kind, resource.ownershipFingerprint) !==
        resource.hostBindingRef ||
      logicalIds.has(resource.logicalResourceId) ||
      bindings.has(resource.binding) ||
      hostBindings.has(resource.hostBindingRef)
    ) {
      throw new Error('plugin_resource_binding_map_invalid');
    }
    logicalIds.add(resource.logicalResourceId);
    bindings.add(resource.binding);
    hostBindings.add(resource.hostBindingRef);
    return resource as unknown as PluginResourceMapEntry;
  });
  return {
    schemaVersion: 1,
    pluginId: value.pluginId,
    capabilityManifestDigest: value.capabilityManifestDigest,
    resources,
  };
}

function parseRestoreSettings(serialized: string | null): CloudflareWorkerSettings {
  return parseJsonRecord(serialized ?? '', 'plugin_resource_binding_restore_invalid');
}

function classify(error: unknown): { code: string; permanent: boolean } {
  if (error instanceof CloudflareControlApiError) {
    if (error.status === 401 || error.status === 403) {
      return { code: 'control_workers_capability_rejected', permanent: true };
    }
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      return { code: 'plugin_resource_binding_provider_rejected', permanent: true };
    }
    return { code: 'plugin_resource_binding_provider_failed', permanent: false };
  }
  const code = error instanceof Error ? error.message : '';
  if (
    code.startsWith('plugin_resource_binding_') &&
    code !== 'plugin_resource_binding_smoke_unavailable' &&
    code !== 'plugin_resource_binding_smoke_failed'
  ) {
    return { code, permanent: true };
  }
  if (
    code.startsWith('worker_settings_binding_') ||
    code.startsWith('worker_settings_payload_too_large') ||
    code === 'control_worker_active_deployment_ambiguous' ||
    code === 'control_worker_concurrent_deployment_detected'
  ) {
    return { code, permanent: true };
  }
  return { code: code || 'plugin_resource_binding_reconciliation_failed', permanent: false };
}

class PluginResourceBindingRepository implements WorkerBindingPatchState<
  PluginResourceBindingTarget,
  DeploymentLease
> {
  constructor(private readonly db: D1Database) {}

  async ensurePendingTargets(now: number): Promise<void> {
    const candidates = await this.db
      .prepare(
        `SELECT resource.operation_id, resource.environment_id, environment.environment_name,
                operation.status AS operation_status, resource.plugin_installation_id,
                resource.tenant_id, resource.resource_kind, resource.logical_resource_id,
                resource.binding_name, resource.lifecycle_mode,
                resource.provider_resource_id, resource.provider_name,
                resource.provider_create_state, resource.provider_creation_date,
                resource.provider_ownership_marker_key, resource.provider_ownership_id,
                resource.provider_identity_checkpointed_at,
                resource.desired_spec_json, resource.status,
                migration.state AS migration_state,
                migration.provider_database_id AS migration_provider_database_id
           FROM control_plugin_desired_resources resource
           JOIN control_operations operation
             ON operation.operation_id = resource.operation_id
            AND operation.environment_id = resource.environment_id
           JOIN control_environments environment
             ON environment.environment_id = resource.environment_id
           LEFT JOIN control_plugin_resource_migration_state migration
             ON migration.plugin_resource_id = resource.plugin_resource_id
            AND migration.operation_id = resource.operation_id
          WHERE operation.operation_kind = 'provision_plugin_resources'
            AND operation.status IN ('queued', 'running', 'waiting_retry')
            AND (operation.next_attempt_at IS NULL OR operation.next_attempt_at <= ?)
            AND resource.operation_id IN (
              SELECT candidate.operation_id
                FROM control_operations candidate
               WHERE candidate.operation_kind = 'provision_plugin_resources'
                 AND candidate.status IN ('queued', 'running', 'waiting_retry')
                 AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= ?)
               ORDER BY candidate.created_at, candidate.operation_id
               LIMIT 16
            )
            AND NOT EXISTS (
              SELECT 1 FROM control_plugin_resource_binding_reconciliations reconciliation
               WHERE reconciliation.operation_id = resource.operation_id
                 AND reconciliation.plugin_installation_id = resource.plugin_installation_id
            )
          ORDER BY resource.operation_id, resource.plugin_installation_id,
                   resource.logical_resource_id`
      )
      .bind(now, now)
      .all<CandidateRow>();
    const groups = new Map<string, CandidateRow[]>();
    for (const row of candidates.results) {
      const key = `${row.operation_id}\0${row.plugin_installation_id}`;
      const rows = groups.get(key) ?? [];
      rows.push(row);
      groups.set(key, rows);
    }
    for (const rows of groups.values()) {
      const first = rows[0];
      if (!first || rows.length > MAX_RESOURCES) continue;
      if (
        rows.some(
          (row) =>
            row.lifecycle_mode === 'managed' &&
            (row.provider_create_state !== 'identified' ||
              row.provider_identity_checkpointed_at === null ||
              (row.resource_kind === 'r2_bucket' &&
                (!row.provider_creation_date ||
                  !row.provider_ownership_marker_key ||
                  !row.provider_ownership_id)))
        )
      ) {
        await this.blockOperation(first, 'plugin_resource_provider_checkpoint_invalid', now);
        continue;
      }
      if (
        rows.some(
          (row) =>
            row.status !== 'ready' ||
            !row.provider_resource_id ||
            !row.provider_name ||
            (row.resource_kind === 'd1' &&
              (row.migration_state !== 'ready' ||
                row.migration_provider_database_id !== row.provider_resource_id)) ||
            (row.resource_kind !== 'd1' && row.migration_state !== null)
        )
      ) {
        continue;
      }
      try {
        await this.createPendingTarget(rows, now);
      } catch (error) {
        const code =
          error instanceof Error && error.message.startsWith('plugin_resource_binding_')
            ? error.message
            : 'plugin_resource_binding_group_invalid';
        await this.blockOperation(first, code, now);
      }
    }
  }

  private async createPendingTarget(rows: CandidateRow[], now: number): Promise<void> {
    const first = rows[0];
    if (!first) throw new Error('plugin_resource_binding_group_invalid');
    if (
      rows.some(
        (row) =>
          row.operation_id !== first.operation_id ||
          row.environment_id !== first.environment_id ||
          row.plugin_installation_id !== first.plugin_installation_id ||
          row.tenant_id !== first.tenant_id
      )
    ) {
      throw new Error('plugin_resource_binding_group_invalid');
    }
    const workers = await this.db
      .prepare(
        `SELECT worker_script_name
           FROM control_desired_worker_inventory
          WHERE environment_id = ? AND package_name = '@authrim/ar-plugin-runner'
            AND status = 'active'
          ORDER BY worker_script_name LIMIT 2`
      )
      .bind(first.environment_id)
      .all<InventoryRow>();
    if (workers.results.length !== 1) {
      await this.blockOperation(first, 'plugin_resource_binding_runner_inventory_invalid', now);
      return;
    }
    const worker = workers.results[0];
    if (!worker) {
      await this.blockOperation(first, 'plugin_resource_binding_runner_inventory_invalid', now);
      return;
    }
    const workerScriptName = worker.worker_script_name;
    if (workerScriptName !== `${first.environment_name}-ar-plugin-runner`) {
      await this.blockOperation(first, 'plugin_resource_binding_runner_inventory_invalid', now);
      return;
    }
    const resources: PluginResourceMapEntry[] = [];
    const desiredBindings: CloudflareWorkerBinding[] = [];
    let pluginId: string | null = null;
    let capabilityManifestDigest: string | null = null;
    const logicalIds = new Set<string>();
    const bindingNames = new Set<string>();
    const hostBindings = new Set<string>();
    for (const row of rows) {
      const spec = desiredSpec(row);
      pluginId ??= spec.pluginId;
      capabilityManifestDigest ??= spec.capabilityManifestDigest;
      const hostBindingRef = pluginResourceHostBindingRef(
        row.resource_kind,
        spec.ownershipFingerprint
      );
      if (
        pluginId !== spec.pluginId ||
        capabilityManifestDigest !== spec.capabilityManifestDigest ||
        logicalIds.has(row.logical_resource_id) ||
        bindingNames.has(row.binding_name) ||
        hostBindings.has(hostBindingRef)
      ) {
        throw new Error('plugin_resource_binding_group_invalid');
      }
      logicalIds.add(row.logical_resource_id);
      bindingNames.add(row.binding_name);
      hostBindings.add(hostBindingRef);
      resources.push({
        logicalResourceId: row.logical_resource_id,
        binding: row.binding_name,
        hostBindingRef,
        kind: row.resource_kind,
        access: spec.access,
        ownershipFingerprint: spec.ownershipFingerprint,
      });
      desiredBindings.push(desiredBinding(row, hostBindingRef));
    }
    resources.sort((left, right) => left.logicalResourceId.localeCompare(right.logicalResourceId));
    desiredBindings.sort((left, right) => left.name.localeCompare(right.name));
    if (!pluginId || !capabilityManifestDigest) {
      throw new Error('plugin_resource_binding_group_invalid');
    }
    const resourceMap: PluginResourceMap = {
      schemaVersion: 1,
      pluginId,
      capabilityManifestDigest,
      resources,
    };
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO control_plugin_resource_binding_reconciliations (
           operation_id, environment_id, plugin_installation_id, tenant_id,
           worker_script_name, desired_bindings_json, resource_map_json,
           state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(
        first.operation_id,
        first.environment_id,
        first.plugin_installation_id,
        first.tenant_id,
        workerScriptName,
        JSON.stringify(desiredBindings),
        JSON.stringify(resourceMap),
        now,
        now
      )
      .run();
    await this.db
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'running', attempt_count = attempt_count + 1,
                started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE operation_id = ? AND step_key LIKE 'plugin_resource_%_binding'
            AND status = 'queued'`
      )
      .bind(now, now, first.operation_id)
      .run();
  }

  private async blockOperation(row: CandidateRow, code: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE control_operations
            SET status = 'blocked', last_error_code = ?, last_error_redacted = ?, updated_at = ?
          WHERE operation_id = ? AND environment_id = ?
            AND status IN ('queued', 'running', 'waiting_retry')`
      )
      .bind(code, code, now, row.operation_id, row.environment_id)
      .run();
  }

  async listDueTargets(limit: number, now: number): Promise<PluginResourceBindingTarget[]> {
    const result = await this.db
      .prepare(
        `SELECT reconciliation.*, environment.environment_name
           FROM control_plugin_resource_binding_reconciliations reconciliation
           JOIN control_environments environment
             ON environment.environment_id = reconciliation.environment_id
           JOIN control_operations operation
             ON operation.operation_id = reconciliation.operation_id
            AND operation.environment_id = reconciliation.environment_id
          WHERE reconciliation.state IN ('pending', 'settings_patched', 'smoke_verifying',
                                          'stabilizing', 'rollback_required')
            AND operation.status IN ('queued', 'running', 'waiting_retry')
            AND (operation.next_attempt_at IS NULL OR operation.next_attempt_at <= ?)
            AND (reconciliation.state <> 'stabilizing'
                 OR reconciliation.stabilization_not_before <= ?)
          ORDER BY CASE reconciliation.state
                     WHEN 'stabilizing' THEN 0
                     WHEN 'smoke_verifying' THEN 1
                     WHEN 'settings_patched' THEN 2
                     WHEN 'rollback_required' THEN 3
                     ELSE 4
                   END, reconciliation.updated_at
          LIMIT ?`
      )
      .bind(now, now, Math.max(1, Math.min(25, Math.floor(limit))))
      .all<TargetRow>();
    return result.results.map(target);
  }

  async acquireDeploymentLease(
    targetValue: PluginResourceBindingTarget,
    expectedSourceVersionId: string,
    now: number
  ): Promise<DeploymentLease | null> {
    const row = await this.db
      .prepare(
        `INSERT INTO control_worker_deployment_leases (
           environment_id, worker_script_name, owner_operation_id, fencing_token,
           lease_expires_at, expected_source_version_id, mutation_started, updated_at
         ) VALUES (?, ?, ?, 1, ?, ?, 0, ?)
         ON CONFLICT(environment_id, worker_script_name) DO UPDATE SET
           owner_operation_id = excluded.owner_operation_id,
           fencing_token = control_worker_deployment_leases.fencing_token + 1,
           lease_expires_at = excluded.lease_expires_at,
           expected_source_version_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
              AND control_worker_deployment_leases.mutation_started = 1
             THEN control_worker_deployment_leases.expected_source_version_id
             ELSE excluded.expected_source_version_id END,
           mutation_started = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.mutation_started ELSE 0 END,
           mutation_started_at = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.mutation_started_at ELSE NULL END,
           previous_deployment_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.previous_deployment_id ELSE NULL END,
           patch_result_version_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.patch_result_version_id ELSE NULL END,
           patch_result_deployment_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.patch_result_deployment_id ELSE NULL END,
           updated_at = excluded.updated_at
         WHERE control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
            OR control_worker_deployment_leases.lease_expires_at <= ?
         RETURNING *`
      )
      .bind(
        targetValue.environmentId,
        targetValue.workerScriptName,
        targetValue.operationId,
        now + LEASE_SECONDS,
        expectedSourceVersionId,
        now,
        now
      )
      .first<LeaseRow>();
    return row ? lease(row) : null;
  }

  async leaseIsCurrent(value: DeploymentLease, now: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS active FROM control_worker_deployment_leases
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND fencing_token = ? AND lease_expires_at > ?`
      )
      .bind(
        value.environmentId,
        value.workerScriptName,
        value.ownerOperationId,
        value.fencingToken,
        now
      )
      .first<{ active: number }>();
    return row?.active === 1;
  }

  async releaseDeploymentLease(value: DeploymentLease): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM control_worker_deployment_leases
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND fencing_token = ?`
      )
      .bind(value.environmentId, value.workerScriptName, value.ownerOperationId, value.fencingToken)
      .run();
  }

  async recordAlreadySatisfied(input: {
    target: PluginResourceBindingTarget;
    lease: DeploymentLease;
    versionId: string;
    deploymentId: string;
    settingsJson: string;
    now: number;
  }): Promise<void> {
    const changed = await this.db
      .prepare(
        `UPDATE control_plugin_resource_binding_reconciliations
            SET state = 'settings_patched', expected_source_version_id = ?,
                previous_deployment_id = ?, patch_result_version_id = ?,
                patch_result_deployment_id = ?, previous_restore_settings_json = ?,
                last_error_code = NULL, updated_at = ?
          WHERE operation_id = ? AND plugin_installation_id = ? AND state = 'pending'
            AND EXISTS (
              SELECT 1 FROM control_worker_deployment_leases lease
               WHERE lease.environment_id = ? AND lease.worker_script_name = ?
                 AND lease.owner_operation_id = ? AND lease.fencing_token = ?
                 AND lease.lease_expires_at > ?
            )`
      )
      .bind(
        input.lease.expectedSourceVersionId,
        input.deploymentId,
        input.versionId,
        input.deploymentId,
        input.settingsJson,
        input.now,
        input.target.operationId,
        input.target.pluginInstallationId,
        input.lease.environmentId,
        input.lease.workerScriptName,
        input.lease.ownerOperationId,
        input.lease.fencingToken,
        input.now
      )
      .run();
    if (Number(changed.meta?.changes ?? 0) !== 1) {
      throw new Error('plugin_resource_binding_fence_lost');
    }
  }

  async recordPatchStarted(input: {
    target: PluginResourceBindingTarget;
    lease: DeploymentLease;
    previousDeploymentId: string;
    restoreSettingsJson: string;
    now: number;
  }): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_worker_deployment_leases
              SET mutation_started = 1, mutation_started_at = COALESCE(mutation_started_at, ?),
                  previous_deployment_id = ?, updated_at = ?
            WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
              AND fencing_token = ? AND lease_expires_at > ?`
        )
        .bind(
          input.now,
          input.previousDeploymentId,
          input.now,
          input.lease.environmentId,
          input.lease.workerScriptName,
          input.lease.ownerOperationId,
          input.lease.fencingToken,
          input.now
        ),
      this.db
        .prepare(
          `UPDATE control_plugin_resource_binding_reconciliations
              SET expected_source_version_id = ?, previous_deployment_id = ?,
                  previous_restore_settings_json = ?, updated_at = ?
            WHERE operation_id = ? AND plugin_installation_id = ? AND state = 'pending'
              AND EXISTS (
                SELECT 1 FROM control_worker_deployment_leases lease
                 WHERE lease.environment_id = ? AND lease.worker_script_name = ?
                   AND lease.owner_operation_id = ? AND lease.fencing_token = ?
                   AND lease.lease_expires_at > ?
              )`
        )
        .bind(
          input.lease.expectedSourceVersionId,
          input.previousDeploymentId,
          input.restoreSettingsJson,
          input.now,
          input.target.operationId,
          input.target.pluginInstallationId,
          input.lease.environmentId,
          input.lease.workerScriptName,
          input.lease.ownerOperationId,
          input.lease.fencingToken,
          input.now
        ),
    ]);
    if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
      throw new Error('plugin_resource_binding_fence_lost');
    }
  }

  async rearmPatchIntent(input: {
    target: PluginResourceBindingTarget;
    lease: DeploymentLease;
    now: number;
  }): Promise<boolean> {
    const changed = await this.db
      .prepare(
        `UPDATE control_worker_deployment_leases
            SET mutation_started = 0, mutation_started_at = NULL,
                previous_deployment_id = NULL, updated_at = ?
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND fencing_token = ? AND lease_expires_at > ?
            AND mutation_started = 1 AND patch_result_version_id IS NULL
            AND patch_result_deployment_id IS NULL`
      )
      .bind(
        input.now,
        input.lease.environmentId,
        input.lease.workerScriptName,
        input.lease.ownerOperationId,
        input.lease.fencingToken,
        input.now
      )
      .run();
    return Number(changed.meta?.changes ?? 0) === 1;
  }

  async recordPatchResult(input: {
    target: PluginResourceBindingTarget;
    lease: DeploymentLease;
    versionId: string;
    deploymentId: string;
    now: number;
  }): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_worker_deployment_leases
              SET patch_result_version_id = ?, patch_result_deployment_id = ?, updated_at = ?
            WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
              AND fencing_token = ? AND lease_expires_at > ?`
        )
        .bind(
          input.versionId,
          input.deploymentId,
          input.now,
          input.lease.environmentId,
          input.lease.workerScriptName,
          input.lease.ownerOperationId,
          input.lease.fencingToken,
          input.now
        ),
      this.db
        .prepare(
          `UPDATE control_plugin_resource_binding_reconciliations
              SET state = 'settings_patched', patch_result_version_id = ?,
                  patch_result_deployment_id = ?, last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND plugin_installation_id = ? AND state = 'pending'
              AND EXISTS (
                SELECT 1 FROM control_worker_deployment_leases lease
                 WHERE lease.environment_id = ? AND lease.worker_script_name = ?
                   AND lease.owner_operation_id = ? AND lease.fencing_token = ?
                   AND lease.lease_expires_at > ?
              )`
        )
        .bind(
          input.versionId,
          input.deploymentId,
          input.now,
          input.target.operationId,
          input.target.pluginInstallationId,
          input.lease.environmentId,
          input.lease.workerScriptName,
          input.lease.ownerOperationId,
          input.lease.fencingToken,
          input.now
        ),
    ]);
    if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
      throw new Error('plugin_resource_binding_fence_lost');
    }
  }

  async recordTransientError(
    targetValue: PluginResourceBindingTarget,
    errorCode: string,
    nextAttemptAt: number,
    now: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_plugin_resource_binding_reconciliations
              SET last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND plugin_installation_id = ?
              AND state NOT IN ('succeeded', 'rolled_back', 'blocked')`
        )
        .bind(errorCode, now, targetValue.operationId, targetValue.pluginInstallationId),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'waiting_retry', next_attempt_at = ?, last_error_code = ?,
                  last_error_redacted = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND status IN ('queued', 'running', 'waiting_retry')`
        )
        .bind(
          nextAttemptAt,
          errorCode,
          errorCode,
          now,
          targetValue.operationId,
          targetValue.environmentId
        ),
    ]);
  }

  async markRollbackRequired(
    targetValue: PluginResourceBindingTarget,
    errorCode: string,
    now: number
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE control_plugin_resource_binding_reconciliations
            SET state = 'rollback_required', last_error_code = ?, updated_at = ?
          WHERE operation_id = ? AND plugin_installation_id = ?
            AND state NOT IN ('succeeded', 'rolled_back', 'blocked')`
      )
      .bind(errorCode, now, targetValue.operationId, targetValue.pluginInstallationId)
      .run();
  }

  async markBlocked(
    targetValue: PluginResourceBindingTarget,
    errorCode: string,
    now: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_plugin_resource_binding_reconciliations
              SET state = 'blocked', last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND plugin_installation_id = ? AND state <> 'succeeded'`
        )
        .bind(errorCode, now, targetValue.operationId, targetValue.pluginInstallationId),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', next_attempt_at = NULL, last_error_code = ?,
                  last_error_redacted = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status <> 'succeeded'`
        )
        .bind(errorCode, errorCode, now, targetValue.operationId, targetValue.environmentId),
    ]);
  }

  async recordSmokeSuccess(
    targetValue: PluginResourceBindingTarget,
    attempt: number,
    consecutive: number,
    stabilizationNotBefore: number | null,
    now: number
  ): Promise<void> {
    const state = consecutive === 3 ? 'stabilizing' : 'smoke_verifying';
    const changed = await this.db
      .prepare(
        `UPDATE control_plugin_resource_binding_reconciliations
            SET state = ?, smoke_attempt_count = ?, consecutive_smoke_successes = ?,
                stabilization_not_before = ?, last_error_code = NULL, updated_at = ?
          WHERE operation_id = ? AND plugin_installation_id = ?
            AND smoke_attempt_count = ? AND consecutive_smoke_successes = ?
            AND state IN ('settings_patched', 'smoke_verifying')`
      )
      .bind(
        state,
        attempt,
        consecutive,
        stabilizationNotBefore,
        now,
        targetValue.operationId,
        targetValue.pluginInstallationId,
        attempt - 1,
        consecutive - 1
      )
      .run();
    if (Number(changed.meta?.changes ?? 0) !== 1) {
      throw new Error('plugin_resource_binding_smoke_fence_lost');
    }
  }

  async markSucceeded(
    targetValue: PluginResourceBindingTarget,
    value: DeploymentLease,
    resourceCount: number,
    now: number
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE control_plugin_resource_binding_reconciliations
              SET state = 'succeeded', smoke_attempt_count = smoke_attempt_count + 1,
                  last_error_code = NULL, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND plugin_installation_id = ? AND state = 'stabilizing'
              AND EXISTS (
                SELECT 1 FROM control_worker_deployment_leases lease
                 WHERE lease.environment_id = ? AND lease.worker_script_name = ?
                   AND lease.owner_operation_id = ? AND lease.fencing_token = ?
                   AND lease.lease_expires_at > ?
              )`
        )
        .bind(
          now,
          now,
          targetValue.operationId,
          targetValue.pluginInstallationId,
          value.environmentId,
          value.workerScriptName,
          value.ownerOperationId,
          value.fencingToken,
          now
        ),
      this.db
        .prepare(
          `UPDATE control_plugin_desired_resources
              SET status = 'active', updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND plugin_installation_id = ?
              AND tenant_id = ? AND status = 'ready'
              AND EXISTS (
                SELECT 1 FROM control_plugin_resource_binding_reconciliations reconciliation
                 WHERE reconciliation.operation_id = ?
                   AND reconciliation.plugin_installation_id = ?
                   AND reconciliation.state = 'succeeded'
              )`
        )
        .bind(
          now,
          targetValue.operationId,
          targetValue.environmentId,
          targetValue.pluginInstallationId,
          targetValue.tenantId,
          targetValue.operationId,
          targetValue.pluginInstallationId
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'succeeded', completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND step_key LIKE 'plugin_resource_%_binding'
              AND status = 'running'
              AND EXISTS (
                SELECT 1 FROM control_plugin_resource_binding_reconciliations reconciliation
                 WHERE reconciliation.operation_id = ?
                   AND reconciliation.plugin_installation_id = ?
                   AND reconciliation.state = 'succeeded'
              )`
        )
        .bind(
          now,
          now,
          targetValue.operationId,
          targetValue.operationId,
          targetValue.pluginInstallationId
        ),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'succeeded', next_attempt_at = NULL, last_error_code = NULL,
                  last_error_redacted = NULL, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM control_plugin_desired_resources resource
                 WHERE resource.operation_id = ? AND resource.status <> 'active'
              )
              AND NOT EXISTS (
                SELECT 1 FROM control_operation_steps step
                 WHERE step.operation_id = control_operations.operation_id
                   AND step.status NOT IN ('succeeded', 'skipped')
              )`
        )
        .bind(
          now,
          now,
          targetValue.operationId,
          targetValue.environmentId,
          targetValue.operationId
        ),
      this.db
        .prepare(
          `DELETE FROM control_worker_deployment_leases
            WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
              AND fencing_token = ?`
        )
        .bind(
          value.environmentId,
          value.workerScriptName,
          value.ownerOperationId,
          value.fencingToken
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) SELECT ?, ?, ?, 'plugin.resource_bindings.activated', 'worker', 'ar-control',
             'plugin_installation', ?, 'succeeded', ?, ?
             WHERE EXISTS (
               SELECT 1 FROM control_plugin_resource_binding_reconciliations reconciliation
                WHERE reconciliation.operation_id = ?
                  AND reconciliation.plugin_installation_id = ?
                  AND reconciliation.state = 'succeeded'
             )`
        )
        .bind(
          `audit_plugin_resource_bindings_${targetValue.operationId.slice(-32)}`,
          targetValue.environmentId,
          targetValue.operationId,
          targetValue.pluginInstallationId,
          JSON.stringify({ resourceCount, workerScriptName: targetValue.workerScriptName }),
          now,
          targetValue.operationId,
          targetValue.pluginInstallationId
        ),
    ];
    await this.db.batch(statements);
    const reflected = await this.db
      .prepare(
        `SELECT reconciliation.state, operation.status AS operation_status,
                (SELECT COUNT(*) FROM control_plugin_desired_resources resource
                  WHERE resource.operation_id = reconciliation.operation_id
                    AND resource.status = 'active') AS active_count
           FROM control_plugin_resource_binding_reconciliations reconciliation
           JOIN control_operations operation
             ON operation.operation_id = reconciliation.operation_id
            AND operation.environment_id = reconciliation.environment_id
          WHERE reconciliation.operation_id = ? AND reconciliation.plugin_installation_id = ?`
      )
      .bind(targetValue.operationId, targetValue.pluginInstallationId)
      .first<{ state: string; operation_status: string; active_count: number }>();
    if (
      reflected?.state !== 'succeeded' ||
      reflected.operation_status !== 'succeeded' ||
      Number(reflected.active_count) !== resourceCount
    ) {
      throw new Error('plugin_resource_binding_activation_reflection_failed');
    }
  }

  async activationPrerequisitesReady(
    targetValue: PluginResourceBindingTarget,
    resourceCount: number
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM control_plugin_desired_resources resource
             WHERE resource.operation_id = ? AND resource.environment_id = ?
               AND resource.plugin_installation_id = ? AND resource.tenant_id = ?) AS total_count,
           (SELECT COUNT(*) FROM control_plugin_desired_resources resource
             WHERE resource.operation_id = ? AND resource.environment_id = ?
               AND resource.plugin_installation_id = ? AND resource.tenant_id = ?
               AND resource.status = 'ready') AS ready_count,
           (SELECT COUNT(*) FROM control_operation_steps step
             WHERE step.operation_id = ? AND step.step_key LIKE 'plugin_resource_%_binding'
               AND step.status = 'running') AS binding_count,
           (SELECT COUNT(*) FROM control_operation_steps step
             WHERE step.operation_id = ? AND step.step_key LIKE 'plugin_resource_%'
               AND step.step_key NOT LIKE 'plugin_resource_%_binding'
               AND step.status NOT IN ('succeeded', 'skipped')) AS invalid_prior_count`
      )
      .bind(
        targetValue.operationId,
        targetValue.environmentId,
        targetValue.pluginInstallationId,
        targetValue.tenantId,
        targetValue.operationId,
        targetValue.environmentId,
        targetValue.pluginInstallationId,
        targetValue.tenantId,
        targetValue.operationId,
        targetValue.operationId
      )
      .first<{
        total_count: number;
        ready_count: number;
        binding_count: number;
        invalid_prior_count: number;
      }>();
    return (
      Number(row?.total_count) === resourceCount &&
      Number(row?.ready_count) === resourceCount &&
      Number(row?.binding_count) === resourceCount &&
      Number(row?.invalid_prior_count) === 0
    );
  }

  async markRolledBack(
    targetValue: PluginResourceBindingTarget,
    value: DeploymentLease,
    now: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_plugin_resource_binding_reconciliations
              SET state = 'rolled_back', last_error_code = 'plugin_resource_binding_rolled_back',
                  updated_at = ?
            WHERE operation_id = ? AND plugin_installation_id = ?
              AND state = 'rollback_required'`
        )
        .bind(now, targetValue.operationId, targetValue.pluginInstallationId),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', next_attempt_at = NULL,
                  last_error_code = 'plugin_resource_binding_rolled_back',
                  last_error_redacted = 'plugin_resource_binding_rolled_back', updated_at = ?
            WHERE operation_id = ? AND environment_id = ?`
        )
        .bind(now, targetValue.operationId, targetValue.environmentId),
      this.db
        .prepare(
          `DELETE FROM control_worker_deployment_leases
            WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
              AND fencing_token = ?`
        )
        .bind(
          value.environmentId,
          value.workerScriptName,
          value.ownerOperationId,
          value.fencingToken
        ),
    ]);
  }
}

export class PluginResourceBindingReconciler {
  private readonly repository: PluginResourceBindingRepository;

  constructor(
    database: D1Database,
    private readonly api: WorkerSettingsApi,
    private readonly env: ControlEnv,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly providerMutationEnabled = true,
    private readonly serviceBindingBudget?: ServiceBindingInvocationBudget
  ) {
    this.repository = new PluginResourceBindingRepository(database);
  }

  async reconcile(limit = 10): Promise<PluginResourceBindingReconcilerResult> {
    const now = this.now();
    await this.repository.ensurePendingTargets(now);
    const targets = await this.repository.listDueTargets(limit, now);
    const result: PluginResourceBindingReconcilerResult = {
      attempted: targets.length,
      succeeded: 0,
      deferred: 0,
      blocked: 0,
    };
    for (const targetValue of targets) {
      const outcome = await this.reconcileTarget(targetValue);
      result[outcome] += 1;
    }
    return result;
  }

  private async reconcileTarget(
    targetValue: PluginResourceBindingTarget
  ): Promise<'succeeded' | 'deferred' | 'blocked'> {
    const now = this.now();
    let deploymentLease: DeploymentLease | null = null;
    try {
      const map = parseResourceMap(targetValue.resourceMapJson);
      const desiredBindings = parseDesiredBindings(targetValue.desiredBindingsJson);
      if (
        desiredBindings.length !== map.resources.length ||
        desiredBindings.some(
          (binding) => !map.resources.some((item) => item.hostBindingRef === binding.name)
        )
      ) {
        throw new Error('plugin_resource_binding_plan_mismatch');
      }
      const smoke = this.env.SMOKE_AR_PLUGIN_RUNNER;
      if (!smoke || typeof smoke.smokePluginResourceBindings !== 'function') {
        throw new Error('plugin_resource_binding_smoke_unavailable');
      }
      if (
        targetValue.state === 'settings_patched' ||
        targetValue.state === 'smoke_verifying' ||
        targetValue.state === 'stabilizing'
      ) {
        if (!targetValue.expectedSourceVersionId) {
          throw new Error('plugin_resource_binding_patch_result_missing');
        }
        deploymentLease = await this.repository.acquireDeploymentLease(
          targetValue,
          targetValue.expectedSourceVersionId,
          now
        );
        if (!deploymentLease) {
          await this.repository.recordTransientError(
            targetValue,
            'control_worker_deployment_lease_busy',
            now + RETRY_SECONDS,
            now
          );
          return 'deferred';
        }
        return await (targetValue.state === 'stabilizing'
          ? this.finishStabilization(targetValue, deploymentLease, smoke, map)
          : this.runSmokeSeries(targetValue, deploymentLease, smoke, map));
      }
      if (!this.providerMutationEnabled) return 'deferred';
      const deployments = await this.api.listWorkerDeployments(targetValue.workerScriptName);
      const active = activeWorkerDeployment(deployments);
      deploymentLease = await this.repository.acquireDeploymentLease(
        targetValue,
        targetValue.expectedSourceVersionId ?? active.versionId,
        now
      );
      if (!deploymentLease) {
        await this.repository.recordTransientError(
          targetValue,
          'control_worker_deployment_lease_busy',
          now + RETRY_SECONDS,
          now
        );
        return 'deferred';
      }
      if (targetValue.state === 'rollback_required') {
        return await this.rollback(targetValue, deploymentLease, deployments, desiredBindings);
      }
      if (targetValue.state === 'pending') {
        const patched = await ensureWorkerBindingsPatched({
          target: targetValue,
          lease: deploymentLease,
          desiredBindings,
          deploymentsBefore: deployments,
          activeBefore: active,
          api: this.api,
          state: this.repository,
          now: this.now,
          retrySeconds: RETRY_SECONDS,
        });
        if (patched.state !== 'patched') return 'deferred';
        targetValue = patched.target;
      }
      return await this.runSmokeSeries(targetValue, deploymentLease, smoke, map);
    } catch (error) {
      const failure = classify(error);
      if (failure.permanent) {
        await this.repository.markBlocked(targetValue, failure.code, now);
        if (deploymentLease) await this.repository.releaseDeploymentLease(deploymentLease);
        return 'blocked';
      }
      await this.repository.recordTransientError(
        targetValue,
        failure.code,
        now + RETRY_SECONDS,
        now
      );
      if (
        deploymentLease &&
        error instanceof Error &&
        error.message === 'control_service_binding_invocation_budget_exhausted'
      ) {
        await this.repository.releaseDeploymentLease(deploymentLease);
      }
      return 'deferred';
    }
  }

  private smokeInput(
    targetValue: PluginResourceBindingTarget,
    map: PluginResourceMap,
    expectedVersionId: string
  ) {
    return {
      operationId: targetValue.operationId,
      tenantId: targetValue.tenantId,
      pluginId: map.pluginId,
      installationId: targetValue.pluginInstallationId,
      expectedVersionId,
      resources: map.resources,
    };
  }

  private async assertSmoke(
    targetValue: PluginResourceBindingTarget,
    smoke: RuntimeSmokeServiceBinding,
    map: PluginResourceMap,
    expectedVersionId: string
  ): Promise<void> {
    const smokePluginResourceBindings = smoke.smokePluginResourceBindings;
    if (!smokePluginResourceBindings) {
      throw new Error('plugin_resource_binding_smoke_unavailable');
    }
    if (!consumeServiceBindingInvocation(this.serviceBindingBudget)) {
      throw new Error('control_service_binding_invocation_budget_exhausted');
    }
    const result = await smokePluginResourceBindings(
      this.smokeInput(targetValue, map, expectedVersionId)
    );
    if (
      result.operationId !== targetValue.operationId ||
      result.installationId !== targetValue.pluginInstallationId ||
      result.observedVersionId !== expectedVersionId ||
      result.resourceCount !== map.resources.length
    ) {
      throw new Error('plugin_resource_binding_smoke_mismatch');
    }
  }

  private async runSmokeSeries(
    targetValue: PluginResourceBindingTarget,
    value: DeploymentLease,
    smoke: RuntimeSmokeServiceBinding,
    map: PluginResourceMap
  ): Promise<'deferred'> {
    if (!targetValue.patchResultVersionId) {
      throw new Error('plugin_resource_binding_patch_result_missing');
    }
    let attempt = targetValue.smokeAttemptCount;
    let consecutive = targetValue.consecutiveSmokeSuccesses;
    while (consecutive < 3) {
      if (!(await this.repository.leaseIsCurrent(value, this.now()))) {
        throw new Error('control_worker_deployment_lease_lost');
      }
      attempt += 1;
      try {
        await this.assertSmoke(targetValue, smoke, map, targetValue.patchResultVersionId);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === 'plugin_resource_binding_smoke_mismatch' ||
            error.message === 'control_service_binding_invocation_budget_exhausted')
        ) {
          throw error;
        }
        throw new Error('plugin_resource_binding_smoke_failed');
      }
      consecutive += 1;
      await this.repository.recordSmokeSuccess(
        targetValue,
        attempt,
        consecutive,
        consecutive === 3 ? this.now() + STABILIZATION_SECONDS : null,
        this.now()
      );
    }
    return 'deferred';
  }

  private async finishStabilization(
    targetValue: PluginResourceBindingTarget,
    value: DeploymentLease,
    smoke: RuntimeSmokeServiceBinding,
    map: PluginResourceMap
  ): Promise<'succeeded'> {
    if (!targetValue.patchResultVersionId || !targetValue.patchResultDeploymentId) {
      throw new Error('plugin_resource_binding_patch_result_missing');
    }
    if (!(await this.repository.leaseIsCurrent(value, this.now()))) {
      throw new Error('control_worker_deployment_lease_lost');
    }
    if (!(await this.repository.activationPrerequisitesReady(targetValue, map.resources.length))) {
      throw new Error('plugin_resource_binding_activation_prerequisite_invalid');
    }
    try {
      await this.assertSmoke(targetValue, smoke, map, targetValue.patchResultVersionId);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'plugin_resource_binding_smoke_mismatch' ||
          error.message === 'control_service_binding_invocation_budget_exhausted')
      ) {
        throw error;
      }
      throw new Error('plugin_resource_binding_stabilization_smoke_failed');
    }
    await this.repository.markSucceeded(targetValue, value, map.resources.length, this.now());
    return 'succeeded';
  }

  private async rollback(
    targetValue: PluginResourceBindingTarget,
    value: DeploymentLease,
    deployments: CloudflareWorkerDeployment[],
    desiredBindings: CloudflareWorkerBinding[]
  ): Promise<'blocked' | 'deferred'> {
    const active = activeWorkerDeployment(deployments);
    if (
      !targetValue.patchResultVersionId ||
      !targetValue.patchResultDeploymentId ||
      active.versionId !== targetValue.patchResultVersionId ||
      active.deploymentId !== targetValue.patchResultDeploymentId
    ) {
      await this.repository.markBlocked(
        targetValue,
        'plugin_resource_binding_newer_deployment_detected',
        this.now()
      );
      return 'blocked';
    }
    if (!(await this.repository.leaseIsCurrent(value, this.now()))) return 'deferred';
    const restore = parseRestoreSettings(targetValue.previousRestoreSettingsJson);
    await this.api.patchWorkerSettings(targetValue.workerScriptName, restore);
    const reflected = await this.api.getWorkerSettings(targetValue.workerScriptName);
    if (
      verifyWorkerSettingsRestoreIntent({
        restoreSettings: restore,
        after: reflected,
        desiredBindings,
      }).length > 0
    ) {
      await this.repository.markBlocked(
        targetValue,
        'plugin_resource_binding_rollback_failed',
        this.now()
      );
      return 'blocked';
    }
    await this.repository.markRolledBack(targetValue, value, this.now());
    return 'blocked';
  }
}
