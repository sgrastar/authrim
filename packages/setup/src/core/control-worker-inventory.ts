import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { executeD1Command } from './cloudflare.js';
import {
  WORKER_BINDING_KINDS,
  WORKER_DATA_ROLES,
  compileDesiredWorkerInventory,
  loadWorkerCapabilityManifests,
  type DesiredWorkerInventoryRecord,
  type WorkerInventoryComponent,
} from './worker-capabilities.js';

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_RESIDENCY_PARTITION = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SAFE_SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SAFE_PACKAGE_NAME = /^@authrim\/(ar-[a-z0-9-]+)$/u;
const SAFE_BINDING_NAME = /^[A-Z][A-Z0-9_]*$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const ALLOWED_DATA_ROLES = new Set<string>(WORKER_DATA_ROLES);
const ALLOWED_BINDING_KINDS = new Set<string>([...WORKER_BINDING_KINDS, 'secret']);

export interface ControlWorkerInventoryRegistrationPlan {
  aggregateDigest: string;
  operationId: string;
  bootstrapSql: string;
  workerSql: Array<{ workerScriptName: string; sql: string }>;
}

export interface ControlEnvironmentBootstrapInput {
  defaultResidencyPolicyId: string;
  defaultResidencyPartition?: string;
  automaticProvisioning?: boolean;
}

export async function compileControlWorkerInventoryFromArtifacts(input: {
  baseDir: string;
  environmentId: string;
  environmentName: string;
  components: readonly WorkerInventoryComponent[];
  artifactPaths: readonly string[];
  deploymentTarget?: string;
}): Promise<DesiredWorkerInventoryRecord[]> {
  const manifests = await loadWorkerCapabilityManifests({
    baseDir: input.baseDir,
    components: input.components,
  });
  const pathsByComponent = new Map(
    input.artifactPaths.map((path) => {
      const artifactName = basename(path, '.toml');
      return [artifactName === 'wrangler' ? basename(dirname(path)) : artifactName, path];
    })
  );
  const generatedArtifactHashes: Record<string, string> = {};
  for (const component of input.components) {
    const path = pathsByComponent.get(component);
    if (!path) throw new Error(`worker_capability_generated_artifact_missing:${component}`);
    generatedArtifactHashes[component] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  }
  return compileDesiredWorkerInventory({
    environmentId: input.environmentId,
    environmentName: input.environmentName,
    manifests,
    generatedArtifactHashes,
    deploymentTarget: input.deploymentTarget,
  });
}

function sqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function requiredSafeIdentifier(value: string, field: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error(`invalid_${field}`);
  return value;
}

function requiredResidencyPartition(value: string): string {
  if (!SAFE_RESIDENCY_PARTITION.test(value)) {
    throw new Error('invalid_default_residency_partition');
  }
  return value;
}

function requiredSafeScriptName(value: string): string {
  if (!SAFE_SCRIPT_NAME.test(value)) throw new Error('invalid_worker_script_name');
  return value;
}

function requiredDigest(value: string, field: string): string {
  if (!SHA256_HEX.test(value)) throw new Error(`invalid_${field}`);
  return value;
}

function stableInventoryDigest(records: readonly DesiredWorkerInventoryRecord[]): string {
  const payload = records
    .map((record) => ({
      environmentId: record.environmentId,
      environmentName: record.environmentName,
      workerScriptName: record.workerScriptName,
      packageName: record.packageName,
      deploymentTarget: record.deploymentTarget,
      capabilityManifestDigest: record.capabilityManifestDigest,
      sourceManifestHash: record.sourceManifestHash,
      generatedArtifactHash: record.generatedArtifactHash,
      requiredDataRoles: record.requiredDataRoles,
      bindings: record.bindings,
    }))
    .sort((left, right) => left.workerScriptName.localeCompare(right.workerScriptName));
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function validateInventory(records: readonly DesiredWorkerInventoryRecord[]): {
  environmentId: string;
  environmentName: string;
} {
  if (records.length === 0) throw new Error('worker_inventory_empty');
  const environmentId = requiredSafeIdentifier(records[0].environmentId, 'environment_id');
  const environmentName = requiredSafeIdentifier(records[0].environmentName, 'environment_name');
  const workers = new Set<string>();
  for (const record of records) {
    if (record.environmentId !== environmentId || record.environmentName !== environmentName) {
      throw new Error('worker_inventory_mixed_environment');
    }
    requiredSafeScriptName(record.workerScriptName);
    const packageMatch = SAFE_PACKAGE_NAME.exec(record.packageName);
    if (!packageMatch) throw new Error('invalid_worker_inventory_package_name');
    const component = packageMatch[1];
    const expectedScriptName = `${environmentName}-${component}`;
    if (record.workerScriptName !== expectedScriptName) {
      throw new Error(`worker_inventory_script_name_mismatch:${record.workerScriptName}`);
    }
    const expectedManifestPath = `packages/${component}/authrim.worker-capabilities.json`;
    if (record.sourceManifestPath !== expectedManifestPath) {
      throw new Error(`worker_inventory_source_path_mismatch:${record.workerScriptName}`);
    }
    requiredSafeIdentifier(record.deploymentTarget, 'deployment_target');
    requiredDigest(record.capabilityManifestDigest, 'capability_manifest_digest');
    requiredDigest(record.sourceManifestHash, 'source_manifest_hash');
    requiredDigest(record.generatedArtifactHash, 'generated_artifact_hash');
    if (
      record.sourceReference !==
      `authrim.worker-capabilities.json#sha256:${record.sourceManifestHash}`
    ) {
      throw new Error(`worker_inventory_source_reference_mismatch:${record.workerScriptName}`);
    }
    const roles = new Set<string>();
    for (const role of record.requiredDataRoles) {
      if (!ALLOWED_DATA_ROLES.has(role)) {
        throw new Error(`worker_inventory_invalid_data_role:${record.workerScriptName}:${role}`);
      }
      if (roles.has(role)) {
        throw new Error(`worker_inventory_duplicate_data_role:${record.workerScriptName}:${role}`);
      }
      roles.add(role);
    }
    const bindingNames = new Set<string>();
    for (const binding of record.bindings) {
      if (!SAFE_BINDING_NAME.test(binding.name)) {
        throw new Error(`worker_inventory_invalid_binding_name:${record.workerScriptName}`);
      }
      if (!ALLOWED_BINDING_KINDS.has(binding.kind)) {
        throw new Error(`worker_inventory_invalid_binding_kind:${record.workerScriptName}`);
      }
      if (bindingNames.has(binding.name)) {
        throw new Error(
          `worker_inventory_duplicate_binding:${record.workerScriptName}:${binding.name}`
        );
      }
      bindingNames.add(binding.name);
      if (binding.dataRole !== null && !roles.has(binding.dataRole)) {
        throw new Error(
          `worker_inventory_binding_role_not_declared:${record.workerScriptName}:${binding.name}`
        );
      }
      if (binding.kind === 'secret' && !binding.capability) {
        throw new Error(`worker_inventory_secret_capability_missing:${record.workerScriptName}`);
      }
    }
    if (workers.has(record.workerScriptName)) {
      throw new Error(`duplicate_worker_inventory_entry:${record.workerScriptName}`);
    }
    workers.add(record.workerScriptName);
  }
  return { environmentId, environmentName };
}

function buildWorkerRegistrationSql(input: {
  record: DesiredWorkerInventoryRecord;
  operationId: string;
  aggregateDigest: string;
  registeredBy: string;
  now: number;
}): string {
  const { record } = input;
  const environment = sqlString(record.environmentId);
  const script = sqlString(record.workerScriptName);
  const operation = sqlString(input.operationId);
  const manifestHash = sqlString(record.sourceManifestHash);
  const eventIdPrefix = sqlString(
    `inventory:activate:${input.aggregateDigest.slice(0, 16)}:${record.sourceManifestHash.slice(0, 16)}:`
  );
  const sourceReference = sqlString(record.sourceReference);
  const desiredBindingNames = record.bindings.map((binding) => sqlString(binding.name));
  const desiredDataRoles = record.requiredDataRoles.map(sqlString);

  const bindingUpserts = record.bindings
    .map((binding) => {
      const desiredSpec = JSON.stringify({
        required: binding.required,
        capability: binding.capability,
      });
      return `INSERT INTO control_worker_desired_bindings (
  environment_id, worker_script_name, binding_name, binding_kind, data_role,
  logical_resource_id, secret_capability, plugin_dynamic_capability,
  desired_spec_json, updated_at
) VALUES (
  ${environment}, ${script}, ${sqlString(binding.name)}, ${sqlString(binding.kind)},
  ${binding.dataRole ? sqlString(binding.dataRole) : 'NULL'}, NULL,
  ${binding.kind === 'secret' && binding.capability ? sqlString(binding.capability) : 'NULL'},
  NULL, ${sqlString(desiredSpec)}, ${input.now}
)
ON CONFLICT(environment_id, worker_script_name, binding_name) DO UPDATE SET
  binding_kind = excluded.binding_kind,
  data_role = excluded.data_role,
  logical_resource_id = excluded.logical_resource_id,
  secret_capability = excluded.secret_capability,
  plugin_dynamic_capability = excluded.plugin_dynamic_capability,
  desired_spec_json = excluded.desired_spec_json,
  updated_at = excluded.updated_at;`;
    })
    .join('\n');

  const staleBindingDelete =
    desiredBindingNames.length > 0
      ? `DELETE FROM control_worker_desired_bindings
WHERE environment_id = ${environment}
  AND worker_script_name = ${script}
  AND binding_name NOT IN (${desiredBindingNames.join(', ')});`
      : `DELETE FROM control_worker_desired_bindings
WHERE environment_id = ${environment} AND worker_script_name = ${script};`;

  const roleUpserts = record.requiredDataRoles
    .map(
      (dataRole) => `INSERT INTO control_worker_required_data_roles (
  environment_id, worker_script_name, data_role, source_manifest_hash, updated_at
) VALUES (
  ${environment}, ${script}, ${sqlString(dataRole)}, ${manifestHash}, ${input.now}
)
ON CONFLICT(environment_id, worker_script_name, data_role) DO UPDATE SET
  source_manifest_hash = excluded.source_manifest_hash,
  updated_at = excluded.updated_at;`
    )
    .join('\n');
  const staleRoleDelete =
    desiredDataRoles.length > 0
      ? `DELETE FROM control_worker_required_data_roles
WHERE environment_id = ${environment}
  AND worker_script_name = ${script}
  AND data_role NOT IN (${desiredDataRoles.join(', ')});`
      : `DELETE FROM control_worker_required_data_roles
WHERE environment_id = ${environment} AND worker_script_name = ${script};`;

  return `
INSERT OR IGNORE INTO control_desired_worker_inventory (
  environment_id, worker_script_name, package_name, deployment_target,
  capability_manifest_digest, source_manifest_path, source_manifest_hash,
  generated_artifact_hash, source_kind, source_reference, registration_mode,
  status, review_state, registered_by_operation_id, registered_by, registered_at
) VALUES (
  ${environment}, ${script}, ${sqlString(record.packageName)},
  ${sqlString(record.deploymentTarget)}, ${sqlString(record.capabilityManifestDigest)},
  ${sqlString(record.sourceManifestPath)}, ${manifestHash},
  ${sqlString(record.generatedArtifactHash)}, 'core_manifest', ${sourceReference}, 'auto',
  'active', 'auto_registered', ${operation}, ${sqlString(input.registeredBy)}, ${input.now}
);

INSERT OR IGNORE INTO control_worker_inventory_change_events (
  event_id, environment_id, worker_script_name, operation_id,
  previous_manifest_hash, next_manifest_hash, diff_json, review_state, created_at
)
SELECT
  ${eventIdPrefix} || registered_at || ':' || worker_script_name,
  environment_id, worker_script_name, ${operation},
  CASE WHEN registered_by_operation_id = ${operation} THEN NULL ELSE source_manifest_hash END,
  ${manifestHash},
  json_object(
    'source_kind', 'core_manifest',
    'package_name', ${sqlString(record.packageName)},
    'binding_count', ${record.bindings.length},
    'generated_artifact_hash', ${sqlString(record.generatedArtifactHash)},
    'previous_status', CASE WHEN registered_by_operation_id = ${operation} THEN NULL ELSE status END,
    'next_status', 'active'
  ),
  'auto_registered', ${input.now}
FROM control_desired_worker_inventory
WHERE environment_id = ${environment} AND worker_script_name = ${script}
  AND (
    changes() = 1 OR
    status <> 'active' OR
    package_name <> ${sqlString(record.packageName)} OR
    deployment_target <> ${sqlString(record.deploymentTarget)} OR
    capability_manifest_digest <> ${sqlString(record.capabilityManifestDigest)} OR
    source_manifest_hash <> ${manifestHash} OR
    generated_artifact_hash <> ${sqlString(record.generatedArtifactHash)}
  );

UPDATE control_desired_worker_inventory
SET package_name = ${sqlString(record.packageName)},
    deployment_target = ${sqlString(record.deploymentTarget)},
    capability_manifest_digest = ${sqlString(record.capabilityManifestDigest)},
    source_manifest_path = ${sqlString(record.sourceManifestPath)},
    source_manifest_hash = ${manifestHash},
    generated_artifact_hash = ${sqlString(record.generatedArtifactHash)},
    source_kind = 'core_manifest',
    source_reference = ${sourceReference},
    registration_mode = 'auto',
    status = 'active',
    registered_by_operation_id = ${operation},
    registered_by = ${sqlString(input.registeredBy)},
    registered_at = ${input.now}
WHERE environment_id = ${environment} AND worker_script_name = ${script};

${bindingUpserts}
${staleBindingDelete}
${roleUpserts}
${staleRoleDelete}`.trim();
}

export function buildControlWorkerInventoryRegistrationPlan(input: {
  records: readonly DesiredWorkerInventoryRecord[];
  environmentBootstrap?: ControlEnvironmentBootstrapInput;
  registeredBy?: string;
  disableMissing?: boolean;
  now?: number;
}): ControlWorkerInventoryRegistrationPlan {
  const { environmentId, environmentName } = validateInventory(input.records);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now <= 0)
    throw new Error('invalid_inventory_registration_time');
  const registeredBy = input.registeredBy ?? 'setup:auto';
  requiredSafeIdentifier(registeredBy, 'registered_by');
  const aggregateDigest = stableInventoryDigest(input.records);
  const operationId = `op_inventory_${aggregateDigest.slice(0, 32)}`;
  const scripts = input.records.map((record) => sqlString(record.workerScriptName));
  const deploymentTargets = [
    ...new Set(
      input.records.map((record) =>
        requiredSafeIdentifier(record.deploymentTarget, 'deployment_target')
      )
    ),
  ].map(sqlString);
  const residencyPolicyId = requiredSafeIdentifier(
    input.environmentBootstrap?.defaultResidencyPolicyId ?? 'builtin:residency:default',
    'default_residency_policy_id'
  );
  const residencyPartition = requiredResidencyPartition(
    input.environmentBootstrap?.defaultResidencyPartition ?? 'default'
  );
  const lookupCapacityDomainId = requiredSafeIdentifier(
    `lookup:${residencyPolicyId}:${residencyPartition}`,
    'lookup_capacity_domain_id'
  );
  const automaticProvisioning = input.environmentBootstrap?.automaticProvisioning === true;
  const disableMissingSql =
    input.disableMissing === false
      ? ''
      : `INSERT OR IGNORE INTO control_worker_inventory_change_events (
  event_id, environment_id, worker_script_name, operation_id,
  previous_manifest_hash, next_manifest_hash, diff_json, review_state, created_at
)
SELECT
  'inventory:disable:${operationId}:' || registered_at || ':' || worker_script_name,
  environment_id, worker_script_name, ${sqlString(operationId)},
  source_manifest_hash, source_manifest_hash,
  json_object('previous_status', status, 'next_status', 'disabled'),
  'auto_registered', ${now}
FROM control_desired_worker_inventory
WHERE environment_id = ${sqlString(environmentId)}
  AND source_kind = 'core_manifest'
  AND deployment_target IN (${deploymentTargets.join(', ')})
  AND status <> 'disabled'
  AND worker_script_name NOT IN (${scripts.join(', ')});

UPDATE control_desired_worker_inventory
SET status = 'disabled', registered_by_operation_id = ${sqlString(operationId)},
    registered_by = ${sqlString(registeredBy)}, registered_at = ${now}
WHERE environment_id = ${sqlString(environmentId)}
  AND source_kind = 'core_manifest'
  AND deployment_target IN (${deploymentTargets.join(', ')})
  AND worker_script_name NOT IN (${scripts.join(', ')});`;

  const bootstrapSql = `
INSERT INTO control_environments (
  environment_id, environment_name, issuer, lifecycle_state,
  automatic_provisioning_enabled, provisioning_token_ownership,
  provisioning_capability_state, created_at, updated_at
) VALUES (
  ${sqlString(environmentId)}, ${sqlString(environmentName)},
  ${sqlString(`urn:authrim:control:${environmentId}`)}, 'creating',
  ${automaticProvisioning ? 1 : 0}, 'none',
  ${sqlString(automaticProvisioning ? 'pending' : 'disabled')}, ${now}, ${now}
)
ON CONFLICT(environment_id) DO UPDATE SET
  environment_name = excluded.environment_name,
  issuer = excluded.issuer,
  automatic_provisioning_enabled = excluded.automatic_provisioning_enabled,
  provisioning_token_ownership = CASE
    WHEN excluded.automatic_provisioning_enabled = 0 THEN 'none'
    ELSE control_environments.provisioning_token_ownership
  END,
  provisioning_capability_state = CASE
    WHEN excluded.automatic_provisioning_enabled = 0 THEN 'disabled'
    WHEN control_environments.provisioning_token_ownership = 'none' THEN 'pending'
    ELSE control_environments.provisioning_capability_state
  END,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO control_environment_resource_policies (
  environment_id, max_concurrent_provisioning, max_ready_spares,
  max_d1_resources, daily_d1_create_budget, target_account_count,
  created_at, updated_at
) VALUES (
  ${sqlString(environmentId)}, 2, 2, 1000, 20, 100000, ${now}, ${now}
);

INSERT INTO control_residency_partitions (
  environment_id, residency_policy_id, residency_partition,
  jurisdiction, location_hint, status, created_at, updated_at,
  lookup_capacity_domain_id
) VALUES (
  ${sqlString(environmentId)}, ${sqlString(residencyPolicyId)},
  ${sqlString(residencyPartition)}, NULL, NULL, 'active', ${now}, ${now},
  ${sqlString(lookupCapacityDomainId)}
)
ON CONFLICT(environment_id, residency_policy_id, residency_partition) DO UPDATE SET
  lookup_capacity_domain_id = COALESCE(
    control_residency_partitions.lookup_capacity_domain_id,
    excluded.lookup_capacity_domain_id
  ),
  updated_at = CASE
    WHEN control_residency_partitions.lookup_capacity_domain_id IS NULL THEN excluded.updated_at
    ELSE control_residency_partitions.updated_at
  END;

INSERT OR IGNORE INTO control_operations (
  operation_id, environment_id, operation_kind, idempotency_key, status,
  requested_by_type, requested_by_id, attempt_count, created_at, completed_at, updated_at
) VALUES (
  ${sqlString(operationId)}, ${sqlString(environmentId)}, 'register_worker_inventory',
  ${sqlString(`worker-inventory:${aggregateDigest}`)}, 'succeeded', 'setup',
  ${sqlString(registeredBy)}, 1, ${now}, ${now}, ${now}
);

${disableMissingSql}

INSERT OR IGNORE INTO control_audit_events (
  event_id, environment_id, operation_id, event_type, actor_type, actor_id,
  resource_kind, resource_id, outcome, redacted_payload_json, created_at
) VALUES (
  ${sqlString(`audit:${operationId}`)}, ${sqlString(environmentId)}, ${sqlString(operationId)},
  'control.worker_inventory.registered', 'setup', ${sqlString(registeredBy)},
  'worker_inventory', ${sqlString(environmentId)}, 'succeeded',
  ${sqlString(JSON.stringify({ aggregate_digest: aggregateDigest, worker_count: input.records.length }))},
  ${now}
);`.trim();

  return {
    aggregateDigest,
    operationId,
    bootstrapSql,
    workerSql: input.records
      .map((record) => ({
        workerScriptName: record.workerScriptName,
        sql: buildWorkerRegistrationSql({
          record,
          operationId,
          aggregateDigest,
          registeredBy,
          now,
        }),
      }))
      .sort((left, right) => left.workerScriptName.localeCompare(right.workerScriptName)),
  };
}

export async function registerControlWorkerInventory(input: {
  controlDatabaseName: string;
  records: readonly DesiredWorkerInventoryRecord[];
  environmentBootstrap?: ControlEnvironmentBootstrapInput;
  registeredBy?: string;
  disableMissing?: boolean;
  now?: number;
  dryRun?: boolean;
  execute?: typeof executeD1Command;
  onProgress?: (message: string) => void;
}): Promise<ControlWorkerInventoryRegistrationPlan> {
  const plan = buildControlWorkerInventoryRegistrationPlan(input);
  if (input.dryRun) return plan;
  const execute = input.execute ?? executeD1Command;
  await execute(input.controlDatabaseName, plan.bootstrapSql, {
    onProgress: input.onProgress,
  });
  for (const worker of plan.workerSql) {
    input.onProgress?.(`Registering desired inventory for ${worker.workerScriptName}`);
    await execute(input.controlDatabaseName, worker.sql, {
      onProgress: input.onProgress,
    });
  }
  return plan;
}

export async function registerUiWorkerInventoryFromArtifacts(input: {
  baseDir: string;
  environmentId: string;
  environmentName: string;
  controlDatabaseName: string;
  components: readonly Extract<WorkerInventoryComponent, 'ar-admin-ui' | 'ar-login-ui'>[];
  environmentBootstrap: ControlEnvironmentBootstrapInput;
  registeredBy: string;
  disableMissing?: boolean;
  onProgress?: (message: string) => void;
}): Promise<ControlWorkerInventoryRegistrationPlan> {
  const records = await compileControlWorkerInventoryFromArtifacts({
    baseDir: input.baseDir,
    environmentId: input.environmentId,
    environmentName: input.environmentName,
    components: input.components,
    artifactPaths: input.components.map((component) =>
      join(input.baseDir, 'packages', component, 'wrangler.toml')
    ),
    deploymentTarget: 'ui',
  });
  return registerControlWorkerInventory({
    controlDatabaseName: input.controlDatabaseName,
    records,
    environmentBootstrap: input.environmentBootstrap,
    registeredBy: input.registeredBy,
    disableMissing: input.disableMissing,
    onProgress: input.onProgress,
  });
}
