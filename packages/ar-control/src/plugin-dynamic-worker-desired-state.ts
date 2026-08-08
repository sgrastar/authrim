import {
  assertControlPlaneRecordIsSecretFree,
  type ControlPluginDynamicWorkerBindingView,
  type ControlPluginDynamicWorkerDesiredStatePlan,
  type ControlPluginDynamicWorkerObservedStateRequest,
  type ControlPluginDynamicWorkerResourcePreparation,
  type ControlPluginDynamicWorkerStateView,
  type ControlPluginResourceSelection,
  type ControlPluginResourceView,
} from '@authrim/ar-lib-core/control-plane';
import { derivePluginInstallationId } from '@authrim/ar-lib-core';
import { parsePluginHostInterfaceBindings } from '@authrim/ar-lib-core/services/plugin-host-interface-contract';
import type { D1PreparedStatement } from '@cloudflare/workers-types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RAW_DATA_BINDING = /^(?:DB(?:_PII|_ADMIN)?|CONTROL_DB|LOOKUP_DB|PLUGIN_RUNNER_DB|[A-Z][A-Z0-9_]*_TDB_.+)$/u;
const CLOUDFLARE_TOKEN_BINDING = /^(?:CLOUDFLARE|CF)_.+_(?:API_)?TOKEN$/u;
const SAFE_LOGICAL_RESOURCE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_MIGRATION_STREAM = /^[a-z0-9][a-z0-9._/-]{0,199}$/u;

interface SourceRow {
  capability_manifest_digest: string;
  aggregate_json: string;
  review_state: 'auto_registered' | 'approved' | 'flagged' | 'rejected';
}

interface BindingRow {
  worker_reference: string;
  binding_name: string;
  binding_kind: string;
  capability: string;
  capability_scope: string;
}

interface ExistingPluginResourceRow {
  logical_resource_id: string;
  provider_resource_id: string;
  provider_name: string;
}

interface DesiredPluginResourceRow extends ExistingPluginResourceRow {
  operation_id: string;
  lifecycle_mode: 'managed' | 'existing';
  desired_spec_json: string;
  status: 'pending' | 'provisioning' | 'ready' | 'active' | 'failed' | 'deleting' | 'deleted';
  lifecycle_generation: number;
}

interface ActiveMigrationReleaseRow {
  stream_id: string;
  release_id: string;
  manifest_digest: string;
  manifest_r2_object_key: string;
}

interface AggregateBinding {
  name: string;
  kind: string;
  capability: string;
  scope: string;
  reason: unknown;
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  code: string
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(code);
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error(code);
  }
  return value;
}

function safeId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function desiredRequest(input: unknown): {
  tenantId: string;
  pluginId: string;
  enabled: boolean;
  resourceSelections: ControlPluginResourceSelection[];
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('control_plugin_desired_state_invalid');
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    (keys.join(',') !== 'enabled,pluginId,tenantId' &&
      keys.join(',') !== 'enabled,pluginId,resourceSelections,tenantId') ||
    (value.resourceSelections !== undefined && !Array.isArray(value.resourceSelections))
  ) {
    throw new Error('control_plugin_desired_state_invalid');
  }
  if (typeof value.enabled !== 'boolean') throw new Error('control_plugin_desired_state_invalid');
  const selectionIds = new Set<string>();
  const resourceSelections = (value.resourceSelections ?? []).map((entry) => {
    const selection = exactRecord(
      entry,
      ['logicalResourceId', 'mode', 'providerResourceId', 'providerName'],
      'control_plugin_resource_selection_invalid'
    );
    if (
      typeof selection.logicalResourceId !== 'string' ||
      !SAFE_LOGICAL_RESOURCE.test(selection.logicalResourceId) ||
      selection.mode !== 'existing' ||
      selectionIds.has(selection.logicalResourceId)
    ) {
      throw new Error('control_plugin_resource_selection_invalid');
    }
    selectionIds.add(selection.logicalResourceId);
    return {
      logicalResourceId: selection.logicalResourceId,
      mode: 'existing' as const,
      providerResourceId: safeId(
        selection.providerResourceId,
        'control_plugin_resource_selection_invalid'
      ),
      providerName: safeId(selection.providerName, 'control_plugin_resource_selection_invalid'),
    };
  });
  return {
    tenantId: safeId(value.tenantId, 'control_plugin_tenant_invalid'),
    pluginId: safeId(value.pluginId, 'control_plugin_id_invalid'),
    enabled: value.enabled,
    resourceSelections,
  };
}

function observedRequest(input: unknown): ControlPluginDynamicWorkerObservedStateRequest {
  const value = exactRecord(
    input,
    [
      'installationId',
      'tenantId',
      'pluginId',
      'state',
      'configVersion',
      'pinnedVersionDigest',
      'resourceSelections',
    ],
    'control_plugin_observed_state_invalid'
  );
  if (
    (value.state !== 'enabled' && value.state !== 'disabled') ||
    !Number.isSafeInteger(value.configVersion) ||
    (value.configVersion as number) < 1 ||
    (value.configVersion as number) > 2_147_483_647 ||
    (value.pinnedVersionDigest !== null &&
      (typeof value.pinnedVersionDigest !== 'string' || !SHA256.test(value.pinnedVersionDigest))) ||
    (value.state === 'enabled' && value.pinnedVersionDigest === null)
  ) {
    throw new Error('control_plugin_observed_state_invalid');
  }
  return {
    installationId: safeId(value.installationId, 'control_plugin_installation_invalid'),
    tenantId: safeId(value.tenantId, 'control_plugin_tenant_invalid'),
    pluginId: safeId(value.pluginId, 'control_plugin_id_invalid'),
    state: value.state,
    configVersion: value.configVersion as number,
    pinnedVersionDigest: value.pinnedVersionDigest,
    resourceSelections: desiredRequest({
      tenantId: value.tenantId,
      pluginId: value.pluginId,
      enabled: value.state === 'enabled',
      resourceSelections: value.resourceSelections,
    }).resourceSelections,
  };
}

function parseAggregateResources(
  policy: Record<string, unknown>,
  selections: readonly ControlPluginResourceSelection[]
): ControlPluginResourceView[] {
  if (!Array.isArray(policy.resources) || policy.resources.length > 16) {
    throw new Error('control_plugin_manifest_resource_invalid');
  }
  const byLogicalId = new Map(
    selections.map((selection) => [selection.logicalResourceId, selection])
  );
  const logicalIds = new Set<string>();
  const bindingNames = new Set<string>();
  const resources = policy.resources.map((entry) => {
    const resource = exactRecord(
      entry,
      [
        'schemaVersion',
        'logicalResourceId',
        'binding',
        'kind',
        'scope',
        'access',
        'provisioning',
        'migrationStream',
      ],
      'control_plugin_manifest_resource_invalid'
    );
    const provisioning = exactRecord(
      resource.provisioning,
      ['defaultMode', 'allowExisting'],
      'control_plugin_manifest_resource_invalid'
    );
    if (
      resource.schemaVersion !== 1 ||
      typeof resource.logicalResourceId !== 'string' ||
      !SAFE_LOGICAL_RESOURCE.test(resource.logicalResourceId) ||
      typeof resource.binding !== 'string' ||
      !SAFE_BINDING.test(resource.binding) ||
      RAW_DATA_BINDING.test(resource.binding) ||
      CLOUDFLARE_TOKEN_BINDING.test(resource.binding) ||
      !['d1', 'kv_namespace', 'r2_bucket'].includes(String(resource.kind)) ||
      resource.scope !== 'tenant' ||
      !['read_only', 'read_write'].includes(String(resource.access)) ||
      provisioning.defaultMode !== 'managed' ||
      typeof provisioning.allowExisting !== 'boolean' ||
      (resource.kind === 'd1') !==
        (typeof resource.migrationStream === 'string' &&
          SAFE_MIGRATION_STREAM.test(resource.migrationStream)) ||
      (resource.kind !== 'd1' && resource.migrationStream !== null) ||
      logicalIds.has(resource.logicalResourceId) ||
      bindingNames.has(resource.binding)
    ) {
      throw new Error('control_plugin_manifest_resource_invalid');
    }
    logicalIds.add(resource.logicalResourceId);
    bindingNames.add(resource.binding);
    const selection = byLogicalId.get(resource.logicalResourceId);
    if (selection && provisioning.allowExisting !== true) {
      throw new Error('control_plugin_existing_resource_forbidden');
    }
    byLogicalId.delete(resource.logicalResourceId);
    return {
      schemaVersion: 1 as const,
      logicalResourceId: resource.logicalResourceId,
      binding: resource.binding,
      kind: resource.kind as ControlPluginResourceView['kind'],
      scope: 'tenant' as const,
      access: resource.access as ControlPluginResourceView['access'],
      lifecycleMode: selection ? ('existing' as const) : ('managed' as const),
      allowExisting: provisioning.allowExisting,
      migrationStream: resource.migrationStream as string | null,
      providerResourceId: selection?.providerResourceId ?? null,
      providerName: selection?.providerName ?? null,
    };
  });
  if (byLogicalId.size > 0) throw new Error('control_plugin_resource_selection_unknown');
  return resources.sort((left, right) =>
    left.logicalResourceId.localeCompare(right.logicalResourceId)
  );
}

function parseAggregateBindings(input: {
  aggregateJson: string;
  pluginId: string;
  resourceSelections: readonly ControlPluginResourceSelection[];
}): {
  bindings: ControlPluginDynamicWorkerBindingView[];
  resources: ControlPluginResourceView[];
} {
  let aggregate: unknown;
  try {
    aggregate = JSON.parse(input.aggregateJson);
  } catch {
    throw new Error('control_plugin_manifest_invalid');
  }
  if (!aggregate || typeof aggregate !== 'object' || Array.isArray(aggregate)) {
    throw new Error('control_plugin_manifest_invalid');
  }
  const value = aggregate as Record<string, unknown>;
  const policy = value.pluginPolicy;
  const workersValue = value.workers;
  if (
    value.sourceKind !== 'plugin_manifest' ||
    value.sourceId !== input.pluginId ||
    !policy ||
    typeof policy !== 'object' ||
    Array.isArray(policy) ||
    (policy as Record<string, unknown>).backend !== 'dynamic_worker' ||
    (policy as Record<string, unknown>).resourceScope !== 'tenant' ||
    !Array.isArray(workersValue) ||
    workersValue.length !== 1
  ) {
    throw new Error('control_plugin_manifest_invalid');
  }
  const workers: unknown[] = workersValue;
  const worker = workers[0];
  if (!worker || typeof worker !== 'object' || Array.isArray(worker)) {
    throw new Error('control_plugin_manifest_invalid');
  }
  const workerRecord = worker as Record<string, unknown>;
  if (
    workerRecord.workerReference !== `plugin:${input.pluginId}` ||
    workerRecord.scriptName !== null ||
    !Array.isArray(workerRecord.bindings) ||
    workerRecord.bindings.length > 64
  ) {
    throw new Error('control_plugin_manifest_invalid');
  }
  const names = new Set<string>();
  const bindings = (workerRecord.bindings as AggregateBinding[])
    .map((binding) => {
      if (
        !binding ||
        typeof binding !== 'object' ||
        !SAFE_BINDING.test(binding.name) ||
        binding.kind !== 'plugin_interface' ||
        binding.scope !== 'tenant' ||
        binding.reason !== null ||
        RAW_DATA_BINDING.test(binding.name) ||
        CLOUDFLARE_TOKEN_BINDING.test(binding.name) ||
        names.has(binding.name)
      ) {
        throw new Error('control_plugin_manifest_binding_invalid');
      }
      names.add(binding.name);
      return { name: binding.name, interface: binding.capability, scope: 'tenant' as const };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const parsed = parsePluginHostInterfaceBindings(
    bindings,
    'control_plugin_manifest_binding_invalid'
  );
  const policyRecord = policy as Record<string, unknown>;
  const policyBindings = parsePluginHostInterfaceBindings(
    policyRecord.hostInterfaces,
    'control_plugin_manifest_binding_invalid'
  );
  if (JSON.stringify(parsed) !== JSON.stringify(policyBindings)) {
    throw new Error('control_plugin_manifest_binding_mismatch');
  }
  if (
    parsed.some((binding) => binding.interface === 'authrim.account_metadata.v1') &&
    (!Array.isArray(policyRecord.capabilities) ||
      !policyRecord.capabilities.some(
        (capability) =>
          capability &&
          typeof capability === 'object' &&
          Array.isArray((capability as Record<string, unknown>).mutationScopes) &&
          ((capability as Record<string, unknown>).mutationScopes as unknown[]).includes(
            'account.metadata.write'
          )
      ))
  ) {
    throw new Error('control_plugin_manifest_binding_invalid');
  }
  return {
    bindings: parsed,
    resources: parseAggregateResources(policyRecord, input.resourceSelections),
  };
}

function validateRegisteredBindings(
  rows: readonly BindingRow[],
  pluginId: string,
  aggregateBindings: readonly ControlPluginDynamicWorkerBindingView[]
): ControlPluginDynamicWorkerBindingView[] {
  const bindings = rows
    .map((row) => {
      if (
        row.worker_reference !== `plugin:${pluginId}` ||
        row.binding_kind !== 'plugin_interface' ||
        row.capability_scope !== 'tenant' ||
        !SAFE_BINDING.test(row.binding_name) ||
        RAW_DATA_BINDING.test(row.binding_name) ||
        CLOUDFLARE_TOKEN_BINDING.test(row.binding_name)
      ) {
        throw new Error('control_plugin_manifest_binding_invalid');
      }
      return { name: row.binding_name, interface: row.capability, scope: 'tenant' as const };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const parsed = parsePluginHostInterfaceBindings(
    bindings,
    'control_plugin_manifest_binding_invalid'
  );
  if (JSON.stringify(parsed) !== JSON.stringify(aggregateBindings)) {
    throw new Error('control_plugin_manifest_binding_mismatch');
  }
  return parsed;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function desiredResourceRecord(
  plan: ControlPluginDynamicWorkerDesiredStatePlan,
  resource: ControlPluginResourceView,
  lifecycleGeneration: number
) {
  const ownershipFingerprint = await sha256(
    JSON.stringify([
      'authrim-plugin-resource-ownership-v1',
      plan.environmentId,
      plan.installationId,
      plan.tenantId,
      resource.logicalResourceId,
      resource.kind,
    ])
  );
  const pluginResourceId = `plugin-resource-v1-${await sha256(
    JSON.stringify([
      plan.environmentId,
      plan.installationId,
      plan.tenantId,
      resource.logicalResourceId,
      lifecycleGeneration,
    ])
  )}`;
  const injectionPolicy = JSON.stringify({
    schemaVersion: 1,
    binding: resource.binding,
    access: resource.access,
    wrapperRequired: true,
  });
  const desiredSpec = JSON.stringify({
    ...resource,
    pluginId: plan.pluginId,
    capabilityManifestDigest: plan.capabilityManifestDigest,
    ownership: resource.lifecycleMode === 'managed' ? 'authrim_managed' : 'external_reference',
    ownershipFingerprint,
    deleteProviderResource: resource.lifecycleMode === 'managed',
    lifecycleGeneration,
  });
  return { pluginResourceId, injectionPolicy, desiredSpec, ownershipFingerprint };
}

export class PluginDynamicWorkerDesiredStateService {
  constructor(
    private readonly database: D1Database,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000)
  ) {}

  async plan(
    expectedEnvironmentId: string,
    input: unknown
  ): Promise<ControlPluginDynamicWorkerDesiredStatePlan> {
    const environmentId = safeId(expectedEnvironmentId, 'control_plugin_environment_invalid');
    const request = desiredRequest(input);
    const source = await this.database
      .prepare(
        `SELECT capability_manifest_digest, aggregate_json, review_state
           FROM control_external_capability_sources
          WHERE environment_id = ? AND source_kind = 'plugin_manifest' AND source_id = ?
            AND (status = 'active' OR ? = 0)`
      )
      .bind(environmentId, request.pluginId, request.enabled ? 1 : 0)
      .first<SourceRow>();
    if (
      !source ||
      (request.enabled && (source.review_state === 'flagged' || source.review_state === 'rejected'))
    ) {
      throw new Error('control_plugin_manifest_unavailable');
    }
    if (!SHA256.test(source.capability_manifest_digest)) {
      throw new Error('control_plugin_manifest_invalid');
    }
    const installationId = await derivePluginInstallationId({
      environmentId,
      tenantId: request.tenantId,
      pluginId: request.pluginId,
      purpose: 'dynamic-plugin',
    });
    let resourceSelections = request.resourceSelections;
    if (resourceSelections.length === 0) {
      const existing = await this.database
        .prepare(
          `SELECT logical_resource_id, provider_resource_id, provider_name
             FROM control_plugin_desired_resources
            WHERE environment_id = ? AND plugin_installation_id = ? AND tenant_id = ?
              AND lifecycle_mode = 'existing' AND status <> 'deleted'
            ORDER BY logical_resource_id`
        )
        .bind(environmentId, installationId, request.tenantId)
        .all<ExistingPluginResourceRow>();
      resourceSelections = existing.results.map((row) => ({
        logicalResourceId: safeId(row.logical_resource_id, 'control_plugin_resource_state_invalid'),
        mode: 'existing' as const,
        providerResourceId: safeId(
          row.provider_resource_id,
          'control_plugin_resource_state_invalid'
        ),
        providerName: safeId(row.provider_name, 'control_plugin_resource_state_invalid'),
      }));
    }
    const aggregate = parseAggregateBindings({
      aggregateJson: source.aggregate_json,
      pluginId: request.pluginId,
      resourceSelections,
    });
    const registered = await this.database
      .prepare(
        `SELECT worker_reference, binding_name, binding_kind, capability, capability_scope
           FROM control_external_capability_bindings
          WHERE environment_id = ? AND source_kind = 'plugin_manifest' AND source_id = ?
          ORDER BY binding_name ASC`
      )
      .bind(environmentId, request.pluginId)
      .all<BindingRow>();
    const bindings = validateRegisteredBindings(
      registered.results,
      request.pluginId,
      aggregate.bindings
    );
    const result: ControlPluginDynamicWorkerDesiredStatePlan = {
      environmentId,
      tenantId: request.tenantId,
      pluginId: request.pluginId,
      installationId,
      capabilityManifestDigest: source.capability_manifest_digest,
      enabled: request.enabled,
      bindings,
      resources: aggregate.resources,
    };
    assertControlPlaneRecordIsSecretFree(result);
    return result;
  }

  async prepare(
    expectedEnvironmentId: string,
    input: unknown
  ): Promise<ControlPluginDynamicWorkerResourcePreparation> {
    const plan = await this.plan(expectedEnvironmentId, input);
    if (!plan.enabled) throw new Error('control_plugin_resource_prepare_disabled');
    if (plan.resources.length === 0) {
      return { ...plan, operationId: null, readiness: 'not_required' };
    }

    const now = this.now();
    const cleanup = await this.database
      .prepare(
        `SELECT operation_id, state FROM control_plugin_resource_cleanup_operations
          WHERE environment_id = ? AND plugin_installation_id = ? AND state <> 'succeeded'
          ORDER BY lifecycle_generation DESC LIMIT 1`
      )
      .bind(plan.environmentId, plan.installationId)
      .first<{ operation_id: string; state: string }>();
    if (cleanup) {
      return { ...plan, operationId: cleanup.operation_id, readiness: 'blocked' };
    }
    const existing = await this.database
      .prepare(
        `SELECT operation_id, logical_resource_id, lifecycle_mode, provider_resource_id,
                provider_name, desired_spec_json, status, lifecycle_generation
           FROM control_plugin_desired_resources
          WHERE environment_id = ? AND plugin_installation_id = ? AND tenant_id = ?
            AND status <> 'deleted'
          ORDER BY logical_resource_id`
      )
      .bind(plan.environmentId, plan.installationId, plan.tenantId)
      .all<DesiredPluginResourceRow>();
    const existingGenerations = new Set(
      existing.results.map((row) => Number(row.lifecycle_generation))
    );
    if (existingGenerations.size > 1) {
      throw new Error('control_plugin_resource_generation_mismatch');
    }
    const existingGeneration = existingGenerations.values().next().value;
    const lifecycleGeneration =
      existingGenerations.size === 1 && existingGeneration !== undefined
        ? existingGeneration
        : Number(
            (
              await this.database
                .prepare(
                  `SELECT COALESCE(MAX(lifecycle_generation), 0) + 1 AS next_generation
                     FROM control_plugin_resource_cleanup_operations
                    WHERE environment_id = ? AND plugin_installation_id = ?`
                )
                .bind(plan.environmentId, plan.installationId)
                .first<{ next_generation: number }>()
            )?.next_generation ?? 1
          );
    if (!Number.isSafeInteger(lifecycleGeneration) || lifecycleGeneration < 1) {
      throw new Error('control_plugin_resource_generation_invalid');
    }
    const existingById = new Map(existing.results.map((row) => [row.logical_resource_id, row]));
    const records = [];
    for (const resource of plan.resources) {
      const record = await desiredResourceRecord(plan, resource, lifecycleGeneration);
      const current = existingById.get(resource.logicalResourceId);
      if (
        current &&
        (current.lifecycle_mode !== resource.lifecycleMode ||
          current.desired_spec_json !== record.desiredSpec ||
          (resource.lifecycleMode === 'existing' &&
            (current.provider_resource_id !== resource.providerResourceId ||
              current.provider_name !== resource.providerName)))
      ) {
        throw new Error('control_plugin_resource_immutable');
      }
      existingById.delete(resource.logicalResourceId);
      records.push({ resource, record });
    }
    if (existingById.size > 0) throw new Error('control_plugin_resource_set_immutable');

    if (existing.results.length > 0) {
      if (existing.results.length !== plan.resources.length) {
        throw new Error('control_plugin_resource_set_immutable');
      }
      const operationIds = new Set(existing.results.map((row) => row.operation_id));
      if (operationIds.size !== 1) throw new Error('control_plugin_resource_operation_mismatch');
      const readiness = existing.results.every((row) => row.status === 'active')
        ? 'ready'
        : existing.results.some((row) => row.status === 'failed')
          ? 'blocked'
          : 'pending';
      const operationId = operationIds.values().next().value;
      if (!operationId) throw new Error('control_plugin_resource_operation_mismatch');
      const result: ControlPluginDynamicWorkerResourcePreparation = {
        ...plan,
        operationId,
        readiness,
      };
      assertControlPlaneRecordIsSecretFree(result);
      return result;
    }

    const releases = new Map<string, ActiveMigrationReleaseRow>();
    for (const streamId of new Set(
      plan.resources.flatMap((resource) =>
        resource.kind === 'd1' && resource.migrationStream ? [resource.migrationStream] : []
      )
    )) {
      const release = await this.database
        .prepare(
          `SELECT stream_id, release_id, manifest_digest, manifest_r2_object_key
             FROM control_migration_release_catalog
            WHERE environment_id = ? AND stream_id = ? AND state = 'active'`
        )
        .bind(plan.environmentId, streamId)
        .first<ActiveMigrationReleaseRow>();
      if (!release) throw new Error('control_plugin_migration_release_unavailable');
      releases.set(streamId, release);
    }
    const canonical = JSON.stringify([
      'authrim-control-plugin-resource-prepare-v1',
      plan.environmentId,
      plan.installationId,
      plan.capabilityManifestDigest,
      lifecycleGeneration,
      plan.resources,
      [...releases.values()].sort((left, right) => left.stream_id.localeCompare(right.stream_id)),
    ]);
    const digest = await sha256(canonical);
    const operationId = `op_plugin_resources_${digest.slice(0, 32)}`;
    const idempotencyKey = `plugin-resources:${digest}`;

    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_operations (
             operation_id, environment_id, operation_kind, idempotency_key, status,
             requested_by_type, requested_by_id, attempt_count, created_at, updated_at
           ) VALUES (?, ?, 'provision_plugin_resources', ?, 'queued',
             'admin', 'ar-management', 0, ?, ?)`
        )
        .bind(operationId, plan.environmentId, idempotencyKey, now, now),
    ];
    for (const release of releases.values()) {
      statements.push(
        this.database
          .prepare(
            `INSERT OR IGNORE INTO control_operation_release_pins (
               operation_id, environment_id, stream_id, release_id, manifest_digest, pinned_at
             ) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(
            operationId,
            plan.environmentId,
            release.stream_id,
            release.release_id,
            release.manifest_digest,
            now
          )
      );
    }
    for (const [index, { resource, record }] of records.entries()) {
      const stepPrefix = `plugin_resource_${record.ownershipFingerprint.slice(0, 20)}`;
      statements.push(
        this.database
          .prepare(
            `INSERT OR IGNORE INTO control_operation_steps (
               operation_id, step_key, display_order, status, attempt_count, updated_at
             ) VALUES (?, ?, ?, 'queued', 0, ?)`
          )
          .bind(operationId, `${stepPrefix}_provider`, index * 30, now),
        this.database
          .prepare(
            `INSERT OR IGNORE INTO control_operation_steps (
               operation_id, step_key, display_order, status, attempt_count, updated_at
             ) VALUES (?, ?, ?, ?, 0, ?)`
          )
          .bind(
            operationId,
            `${stepPrefix}_migration`,
            index * 30 + 10,
            resource.kind === 'd1' ? 'queued' : 'skipped',
            now
          ),
        this.database
          .prepare(
            `INSERT OR IGNORE INTO control_operation_steps (
               operation_id, step_key, display_order, status, attempt_count, updated_at
             ) VALUES (?, ?, ?, 'queued', 0, ?)`
          )
          .bind(operationId, `${stepPrefix}_binding`, index * 30 + 20, now),
        this.database
          .prepare(
            `INSERT OR IGNORE INTO control_plugin_desired_resources (
               plugin_resource_id, environment_id, operation_id, plugin_installation_id,
               tenant_id, resource_scope, resource_kind, logical_resource_id, binding_name,
               lifecycle_mode, provider_resource_id, provider_name, encrypted_config_ref,
               injection_policy_json, desired_spec_json, status, updated_at, lifecycle_generation
             ) VALUES (?, ?, ?, ?, ?, 'tenant', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'pending', ?, ?)`
          )
          .bind(
            record.pluginResourceId,
            plan.environmentId,
            operationId,
            plan.installationId,
            plan.tenantId,
            resource.kind,
            resource.logicalResourceId,
            resource.binding,
            resource.lifecycleMode,
            resource.providerResourceId,
            resource.providerName,
            record.injectionPolicy,
            record.desiredSpec,
            now,
            lifecycleGeneration
          )
      );
      if (resource.kind === 'd1' && resource.migrationStream) {
        const release = releases.get(resource.migrationStream);
        if (!release) throw new Error('control_plugin_migration_release_unavailable');
        statements.push(
          this.database
            .prepare(
              `INSERT OR IGNORE INTO control_plugin_resource_migration_state (
                 plugin_resource_id, environment_id, operation_id, stream_id, release_id,
                 manifest_digest, state, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?)`
            )
            .bind(
              record.pluginResourceId,
              plan.environmentId,
              operationId,
              release.stream_id,
              release.release_id,
              release.manifest_digest,
              now
            )
        );
      }
    }
    const auditPayload = JSON.stringify({
      resourceCount: plan.resources.length,
      managedResourceCount: plan.resources.filter(
        (resource) => resource.lifecycleMode === 'managed'
      ).length,
      existingResourceCount: plan.resources.filter(
        (resource) => resource.lifecycleMode === 'existing'
      ).length,
    });
    statements.push(
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) SELECT ?, ?, ?, 'plugin.dynamic_worker.resources.requested', 'worker',
               'ar-management', 'plugin_installation', ?, 'attempted', ?, ?
             WHERE EXISTS (
               SELECT 1 FROM control_operations
                WHERE operation_id = ? AND environment_id = ? AND idempotency_key = ?
             )`
        )
        .bind(
          `audit_plugin_resources_${digest.slice(0, 32)}`,
          plan.environmentId,
          operationId,
          plan.installationId,
          auditPayload,
          now,
          operationId,
          plan.environmentId,
          idempotencyKey
        )
    );
    await this.database.batch(statements);
    const reflected = await this.database
      .prepare(
        `SELECT status FROM control_plugin_desired_resources
          WHERE environment_id = ? AND operation_id = ?
          ORDER BY logical_resource_id`
      )
      .bind(plan.environmentId, operationId)
      .all<{ status: DesiredPluginResourceRow['status'] }>();
    if (reflected.results.length !== plan.resources.length) {
      throw new Error('control_plugin_resource_prepare_reflection_failed');
    }
    const readiness = reflected.results.every((row) => row.status === 'active')
      ? 'ready'
      : reflected.results.some((row) => row.status === 'failed')
        ? 'blocked'
        : 'pending';
    const result: ControlPluginDynamicWorkerResourcePreparation = {
      ...plan,
      operationId,
      readiness,
    };
    assertControlPlaneRecordIsSecretFree(result);
    return result;
  }

  async getPreparation(
    expectedEnvironmentId: string,
    input: unknown
  ): Promise<ControlPluginDynamicWorkerResourcePreparation | null> {
    const plan = await this.plan(expectedEnvironmentId, input);
    if (!plan.enabled || plan.resources.length === 0) return null;
    const cleanup = await this.database
      .prepare(
        `SELECT operation_id FROM control_plugin_resource_cleanup_operations
          WHERE environment_id = ? AND plugin_installation_id = ? AND state <> 'succeeded'
          ORDER BY lifecycle_generation DESC LIMIT 1`
      )
      .bind(plan.environmentId, plan.installationId)
      .first<{ operation_id: string }>();
    if (cleanup) {
      return { ...plan, operationId: cleanup.operation_id, readiness: 'blocked' };
    }
    const rows = await this.database
      .prepare(
        `SELECT operation_id, logical_resource_id, lifecycle_mode, provider_resource_id,
                provider_name, desired_spec_json, status, lifecycle_generation
           FROM control_plugin_desired_resources
          WHERE environment_id = ? AND plugin_installation_id = ? AND tenant_id = ?
            AND status <> 'deleted'
          ORDER BY logical_resource_id`
      )
      .bind(plan.environmentId, plan.installationId, plan.tenantId)
      .all<DesiredPluginResourceRow>();
    if (rows.results.length === 0) return null;
    if (rows.results.length !== plan.resources.length) {
      throw new Error('control_plugin_resource_set_immutable');
    }
    const byId = new Map(rows.results.map((row) => [row.logical_resource_id, row]));
    for (const resource of plan.resources) {
      const row = byId.get(resource.logicalResourceId);
      const expected = await desiredResourceRecord(
        plan,
        resource,
        Number(row?.lifecycle_generation ?? 0)
      );
      if (
        !row ||
        row.lifecycle_mode !== resource.lifecycleMode ||
        row.desired_spec_json !== expected.desiredSpec ||
        (resource.lifecycleMode === 'existing' &&
          (row.provider_resource_id !== resource.providerResourceId ||
            row.provider_name !== resource.providerName))
      ) {
        throw new Error('control_plugin_resource_immutable');
      }
      byId.delete(resource.logicalResourceId);
    }
    if (byId.size > 0) throw new Error('control_plugin_resource_set_immutable');
    const operationIds = new Set(rows.results.map((row) => row.operation_id));
    if (operationIds.size !== 1) throw new Error('control_plugin_resource_operation_mismatch');
    const readiness = rows.results.every((row) => row.status === 'active')
      ? 'ready'
      : rows.results.some((row) => row.status === 'failed')
        ? 'blocked'
        : 'pending';
    const operationId = operationIds.values().next().value;
    if (!operationId) throw new Error('control_plugin_resource_operation_mismatch');
    const result: ControlPluginDynamicWorkerResourcePreparation = {
      ...plan,
      operationId,
      readiness,
    };
    assertControlPlaneRecordIsSecretFree(result);
    return result;
  }

  async sync(
    expectedEnvironmentId: string,
    input: unknown
  ): Promise<ControlPluginDynamicWorkerStateView> {
    const observed = observedRequest(input);
    const plan = await this.plan(expectedEnvironmentId, {
      tenantId: observed.tenantId,
      pluginId: observed.pluginId,
      enabled: observed.state === 'enabled',
      resourceSelections: observed.resourceSelections,
    });
    if (observed.installationId !== plan.installationId) {
      throw new Error('control_plugin_installation_mismatch');
    }
    if (observed.state === 'enabled' && plan.resources.length > 0) {
      const rows = await this.database
        .prepare(
          `SELECT operation_id, logical_resource_id, lifecycle_mode, provider_resource_id,
                  provider_name, desired_spec_json, status, lifecycle_generation
             FROM control_plugin_desired_resources
            WHERE environment_id = ? AND plugin_installation_id = ? AND tenant_id = ?
              AND status <> 'deleted'
            ORDER BY logical_resource_id`
        )
        .bind(plan.environmentId, plan.installationId, plan.tenantId)
        .all<DesiredPluginResourceRow>();
      const byId = new Map(rows.results.map((row) => [row.logical_resource_id, row]));
      for (const resource of plan.resources) {
        const row = byId.get(resource.logicalResourceId);
        const expected = await desiredResourceRecord(
          plan,
          resource,
          Number(row?.lifecycle_generation ?? 0)
        );
        if (
          !row ||
          row.status !== 'active' ||
          row.lifecycle_mode !== resource.lifecycleMode ||
          row.desired_spec_json !== expected.desiredSpec ||
          !row.provider_resource_id ||
          !row.provider_name
        ) {
          throw new Error('control_plugin_resources_not_ready');
        }
        if (resource.kind === 'd1') {
          const migration = await this.database
            .prepare(
              `SELECT state, provider_database_id
                 FROM control_plugin_resource_migration_state
                WHERE plugin_resource_id = ? AND environment_id = ? AND operation_id = ?`
            )
            .bind(expected.pluginResourceId, plan.environmentId, row.operation_id)
            .first<{ state: string; provider_database_id: string | null }>();
          if (
            !migration ||
            migration.state !== 'ready' ||
            migration.provider_database_id !== row.provider_resource_id
          ) {
            throw new Error('control_plugin_resources_not_ready');
          }
        }
        byId.delete(resource.logicalResourceId);
      }
      if (byId.size > 0) throw new Error('control_plugin_resource_set_immutable');
    }
    const canonical = JSON.stringify([
      'authrim-control-plugin-dynamic-worker-sync-v1',
      plan.environmentId,
      observed.installationId,
      observed.state,
      observed.configVersion,
      observed.pinnedVersionDigest,
      plan.capabilityManifestDigest,
      plan.bindings,
      plan.resources,
    ]);
    const digest = await sha256(canonical);
    const operationId = `op_plugin_sync_${digest.slice(0, 32)}`;
    const idempotencyKey = `plugin-sync:${digest}`;
    const now = this.now();
    const bindingStatus = observed.state === 'enabled' ? 'active' : 'deleted';
    const operation = this.database
      .prepare(
        `INSERT OR IGNORE INTO control_operations (
           operation_id, environment_id, operation_kind, idempotency_key, status,
           requested_by_type, requested_by_id, attempt_count,
           created_at, started_at, completed_at, updated_at
         ) VALUES (?, ?, 'sync_plugin_dynamic_worker_bindings', ?, 'succeeded',
           'admin', 'ar-management', 1, ?, ?, ?, ?)`
      )
      .bind(operationId, plan.environmentId, idempotencyKey, now, now, now, now);
    const statements: D1PreparedStatement[] = [operation];
    const bindingNames = plan.bindings.map((binding) => binding.name);
    for (const binding of plan.bindings) {
      const desiredSpec = JSON.stringify({
        schemaVersion: 1,
        kind: 'plugin_interface',
        pluginId: plan.pluginId,
        interface: binding.interface,
        scope: binding.scope,
        enabled: observed.state === 'enabled',
        capabilityManifestDigest: plan.capabilityManifestDigest,
      });
      const observedSpec = JSON.stringify({
        schemaVersion: 1,
        runnerState: observed.state,
        configVersion: observed.configVersion,
        pinnedVersionDigest: observed.pinnedVersionDigest,
      });
      statements.push(
        this.database
          .prepare(
            `INSERT INTO control_plugin_dynamic_worker_bindings (
               environment_id, plugin_installation_id, tenant_id, binding_name,
               desired_spec_json, observed_spec_json, status, updated_at
             ) SELECT ?, ?, ?, ?, ?, ?, ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM control_operations
                  WHERE operation_id = ? AND environment_id = ? AND idempotency_key = ?
               )
             ON CONFLICT(environment_id, plugin_installation_id, tenant_id, binding_name)
             DO UPDATE SET desired_spec_json = excluded.desired_spec_json,
               observed_spec_json = excluded.observed_spec_json,
               status = excluded.status, updated_at = excluded.updated_at`
          )
          .bind(
            plan.environmentId,
            plan.installationId,
            plan.tenantId,
            binding.name,
            desiredSpec,
            observedSpec,
            bindingStatus,
            now,
            operationId,
            plan.environmentId,
            idempotencyKey
          )
      );
    }
    const staleFilter =
      bindingNames.length === 0
        ? ''
        : ` AND binding_name NOT IN (${bindingNames.map(() => '?').join(', ')})`;
    statements.push(
      this.database
        .prepare(
          `UPDATE control_plugin_dynamic_worker_bindings
              SET status = 'deleted', updated_at = ?
            WHERE environment_id = ? AND plugin_installation_id = ? AND tenant_id = ?${staleFilter}
              AND EXISTS (
                SELECT 1 FROM control_operations
                 WHERE operation_id = ? AND environment_id = ? AND idempotency_key = ?
              )`
        )
        .bind(
          now,
          plan.environmentId,
          plan.installationId,
          plan.tenantId,
          ...bindingNames,
          operationId,
          plan.environmentId,
          idempotencyKey
        )
    );
    const auditPayload = JSON.stringify({
      state: observed.state,
      configVersion: observed.configVersion,
      capabilityManifestDigest: plan.capabilityManifestDigest,
      bindingCount: plan.bindings.length,
      resourceCount: plan.resources.length,
      existingResourceCount: plan.resources.filter(
        (resource) => resource.lifecycleMode === 'existing'
      ).length,
    });
    statements.push(
      this.database
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) SELECT ?, ?, ?, 'plugin.dynamic_worker.bindings.synced', 'worker', 'ar-management',
               'plugin_installation', ?, 'succeeded', ?, ?
             WHERE EXISTS (
               SELECT 1 FROM control_operations
                WHERE operation_id = ? AND environment_id = ? AND idempotency_key = ?
             )`
        )
        .bind(
          `audit_plugin_sync_${digest.slice(0, 32)}`,
          plan.environmentId,
          operationId,
          plan.installationId,
          auditPayload,
          now,
          operationId,
          plan.environmentId,
          idempotencyKey
        )
    );
    await this.database.batch(statements);
    const reflected = await this.database
      .prepare(
        `SELECT operation_id FROM control_operations
          WHERE operation_id = ? AND environment_id = ? AND idempotency_key = ?
            AND operation_kind = 'sync_plugin_dynamic_worker_bindings' AND status = 'succeeded'`
      )
      .bind(operationId, plan.environmentId, idempotencyKey)
      .first<{ operation_id: string }>();
    if (!reflected) throw new Error('control_plugin_sync_idempotency_conflict');
    const result: ControlPluginDynamicWorkerStateView = {
      ...plan,
      operationId,
      state: observed.state,
      configVersion: observed.configVersion,
      pinnedVersionDigest: observed.pinnedVersionDigest,
      bindingStatus,
    };
    assertControlPlaneRecordIsSecretFree(result);
    return result;
  }
}
