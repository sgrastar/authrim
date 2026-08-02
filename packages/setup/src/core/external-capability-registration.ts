import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { executeD1Command } from './cloudflare.js';
import {
  aggregateExternalCapabilities,
  loadPluginWorkerCapabilityManifests,
  loadProjectExtensionCapabilityManifest,
  type AggregatedExternalCapabilitySource,
} from './external-capabilities.js';

const EXTENSION_MANIFEST = 'authrim.extension-capabilities.json';
const PLUGIN_MANIFEST = 'authrim.plugin-worker-capabilities.json';
const MAX_DISCOVERED_DIRECTORIES = 512;
const MAX_PLUGIN_MANIFESTS = 128;
const IGNORED_DISCOVERY_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.authrim',
  '.git',
]);

function sqlString(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function discoverPluginManifestPaths(baseDir: string): Promise<string[]> {
  const roots = [join(baseDir, 'plugins'), join(baseDir, 'packages')].filter(existsSync);
  const queue = roots.map((path) => ({ path, depth: 0 }));
  const found = new Set<string>();
  let visited = 0;
  const rootManifest = join(baseDir, PLUGIN_MANIFEST);
  if (existsSync(rootManifest)) found.add(rootManifest);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    visited += 1;
    if (visited > MAX_DISCOVERED_DIRECTORIES) {
      throw new Error('external_capability_discovery_directory_limit');
    }
    const entries = await readdir(current.path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(current.path, entry.name);
      if (entry.isFile() && entry.name === PLUGIN_MANIFEST) {
        found.add(path);
        if (found.size > MAX_PLUGIN_MANIFESTS) {
          throw new Error('external_capability_discovery_manifest_limit');
        }
      } else if (
        entry.isDirectory() &&
        current.depth < 4 &&
        !IGNORED_DISCOVERY_DIRECTORIES.has(entry.name)
      ) {
        queue.push({ path, depth: current.depth + 1 });
      }
    }
  }
  return [...found].sort((left, right) => left.localeCompare(right));
}

export async function discoverExternalCapabilities(input: {
  baseDir: string;
}): Promise<AggregatedExternalCapabilitySource[]> {
  const baseDir = resolve(input.baseDir);
  const extensionPath = join(baseDir, EXTENSION_MANIFEST);
  const [extension, pluginPaths] = await Promise.all([
    existsSync(extensionPath)
      ? loadProjectExtensionCapabilityManifest({ baseDir, path: extensionPath })
      : undefined,
    discoverPluginManifestPaths(baseDir),
  ]);
  const plugins = await loadPluginWorkerCapabilityManifests({ baseDir, paths: pluginPaths });
  return aggregateExternalCapabilities({ extension, plugins });
}

export interface ExternalCapabilityRegistrationPlan {
  operationId: string;
  aggregateDigest: string;
  sourceCount: number;
  sql: string;
}

export function buildExternalCapabilityRegistrationPlan(input: {
  environmentId: string;
  sources: readonly AggregatedExternalCapabilitySource[];
  registeredBy: string;
  now: number;
}): ExternalCapabilityRegistrationPlan {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(input.environmentId)) {
    throw new Error('invalid_external_capability_environment_id');
  }
  if (!Number.isSafeInteger(input.now) || input.now <= 0) {
    throw new Error('invalid_external_capability_registration_time');
  }
  const sourceKeys = new Set<string>();
  const extensionScripts = new Set<string>();
  for (const source of input.sources) {
    const key = `${source.sourceKind}:${source.sourceId}`;
    if (sourceKeys.has(key)) throw new Error(`duplicate_external_capability_source:${key}`);
    sourceKeys.add(key);
    if (source.sourceKind !== 'extension_manifest') continue;
    for (const worker of source.workers) {
      if (!worker.scriptName) throw new Error('extension_worker_script_name_required');
      if (extensionScripts.has(worker.scriptName)) {
        throw new Error(`duplicate_extension_worker_script:${worker.scriptName}`);
      }
      extensionScripts.add(worker.scriptName);
    }
  }
  if (!input.registeredBy.trim() || input.registeredBy.length > 200) {
    throw new Error('invalid_external_capability_registered_by');
  }
  const serialized = JSON.stringify(input.sources);
  if (/-----BEGIN (?:EC |RSA )?PRIVATE KEY-----|Bearer\s+\S+/iu.test(serialized)) {
    throw new Error('external_capability_sensitive_value_forbidden');
  }
  const aggregateDigest = digest(`${input.environmentId}\0${serialized}`);
  const operationId = `op_external_${aggregateDigest.slice(0, 32)}`;
  const activeSourceKeys = input.sources.map((source) => `${source.sourceKind}:${source.sourceId}`);
  const extensionReferences = input.sources
    .filter((source) => source.sourceKind === 'extension_manifest')
    .map((source) => `extension:${source.sourceId}`);
  const statements: string[] = [
    `INSERT OR IGNORE INTO control_operations (
       operation_id, environment_id, operation_kind, idempotency_key, status,
       requested_by_type, attempt_count, created_at, completed_at, updated_at
     ) VALUES (
       ${sqlString(operationId)}, ${sqlString(input.environmentId)},
       'register_external_capabilities', ${sqlString(`external-capabilities:${aggregateDigest}`)},
       'succeeded', 'setup', 1, ${input.now}, ${input.now}, ${input.now}
     )`,
    `UPDATE control_external_capability_sources
        SET status = 'disabled', registered_at = ${input.now}
      WHERE environment_id = ${sqlString(input.environmentId)}
        ${
          activeSourceKeys.length > 0
            ? `AND (source_kind || ':' || source_id) NOT IN (${activeSourceKeys.map(sqlString).join(', ')})`
            : ''
        }`,
    `UPDATE control_desired_worker_inventory
        SET status = 'disabled', registered_at = ${input.now}
      WHERE environment_id = ${sqlString(input.environmentId)}
        AND source_kind = 'extension_manifest'
        ${
          extensionReferences.length > 0
            ? `AND source_reference NOT IN (${extensionReferences.map(sqlString).join(', ')})`
            : ''
        }`,
  ];

  for (const source of input.sources) {
    const aggregateJson = JSON.stringify(source);
    statements.push(
      `INSERT INTO control_external_capability_sources (
         environment_id, source_kind, source_id, source_manifest_path, source_manifest_hash,
         capability_manifest_digest, aggregate_json, status, review_state,
         registered_by_operation_id, registered_at
       ) VALUES (
         ${sqlString(input.environmentId)}, ${sqlString(source.sourceKind)},
         ${sqlString(source.sourceId)}, ${sqlString(source.sourceManifestPath)},
         ${sqlString(source.sourceManifestHash)}, ${sqlString(source.capabilityManifestDigest)},
         ${sqlString(aggregateJson)}, 'active', 'auto_registered',
         ${sqlString(operationId)}, ${input.now}
       )
       ON CONFLICT(environment_id, source_kind, source_id) DO UPDATE SET
         source_manifest_path = excluded.source_manifest_path,
         review_state = CASE
           WHEN control_external_capability_sources.source_manifest_hash = excluded.source_manifest_hash
             THEN control_external_capability_sources.review_state
           ELSE 'auto_registered'
         END,
         reviewed_by = CASE
           WHEN control_external_capability_sources.source_manifest_hash = excluded.source_manifest_hash
             THEN control_external_capability_sources.reviewed_by
           ELSE NULL
         END,
         reviewed_at = CASE
           WHEN control_external_capability_sources.source_manifest_hash = excluded.source_manifest_hash
             THEN control_external_capability_sources.reviewed_at
           ELSE NULL
         END,
         review_note = CASE
           WHEN control_external_capability_sources.source_manifest_hash = excluded.source_manifest_hash
             THEN control_external_capability_sources.review_note
           ELSE NULL
         END,
         source_manifest_hash = excluded.source_manifest_hash,
         capability_manifest_digest = excluded.capability_manifest_digest,
         aggregate_json = excluded.aggregate_json,
         status = 'active',
         registered_by_operation_id = excluded.registered_by_operation_id,
         registered_at = excluded.registered_at`,
      `DELETE FROM control_external_capability_bindings
        WHERE environment_id = ${sqlString(input.environmentId)}
          AND source_kind = ${sqlString(source.sourceKind)}
          AND source_id = ${sqlString(source.sourceId)}`
    );

    for (const worker of source.workers) {
      for (const binding of worker.bindings) {
        statements.push(
          `INSERT INTO control_external_capability_bindings (
             environment_id, source_kind, source_id, worker_reference, worker_script_name,
             binding_name, binding_kind, capability, capability_scope, reason, updated_at
           ) VALUES (
             ${sqlString(input.environmentId)}, ${sqlString(source.sourceKind)},
             ${sqlString(source.sourceId)}, ${sqlString(worker.workerReference)},
             ${sqlString(worker.scriptName)}, ${sqlString(binding.name)},
             ${sqlString(binding.kind)}, ${sqlString(binding.capability)},
             ${sqlString(binding.scope)}, ${sqlString(binding.reason)}, ${input.now}
           )`
        );
      }
    }

    if (source.sourceKind !== 'extension_manifest') continue;
    for (const worker of source.workers) {
      if (!worker.scriptName) throw new Error('extension_worker_script_name_required');
      const sourceReference = `extension:${source.sourceId}`;
      statements.push(
        `INSERT INTO control_desired_worker_inventory (
           environment_id, worker_script_name, package_name, deployment_target,
           capability_manifest_digest, source_manifest_path, source_manifest_hash,
           generated_artifact_hash, source_kind, source_reference, registration_mode,
           status, review_state, registered_by_operation_id, registered_by, registered_at
         ) VALUES (
           ${sqlString(input.environmentId)}, ${sqlString(worker.scriptName)},
           ${sqlString(`extension:${source.sourceId}`)}, 'extension',
           ${sqlString(source.capabilityManifestDigest)}, ${sqlString(source.sourceManifestPath)},
           ${sqlString(source.sourceManifestHash)}, ${sqlString(aggregateDigest)},
           'extension_manifest', ${sqlString(sourceReference)}, 'auto', 'active',
           'auto_registered', ${sqlString(operationId)}, ${sqlString(input.registeredBy)}, ${input.now}
         )
         ON CONFLICT(environment_id, worker_script_name) DO UPDATE SET
           package_name = excluded.package_name,
           deployment_target = excluded.deployment_target,
           capability_manifest_digest = excluded.capability_manifest_digest,
           source_manifest_path = excluded.source_manifest_path,
           source_manifest_hash = excluded.source_manifest_hash,
           generated_artifact_hash = excluded.generated_artifact_hash,
           source_kind = excluded.source_kind,
           source_reference = excluded.source_reference,
           status = 'active',
           review_state = CASE
             WHEN control_desired_worker_inventory.source_manifest_hash = excluded.source_manifest_hash
               THEN control_desired_worker_inventory.review_state
             ELSE 'auto_registered'
           END,
           registered_by_operation_id = excluded.registered_by_operation_id,
           registered_by = excluded.registered_by,
           registered_at = excluded.registered_at`,
        `DELETE FROM control_worker_desired_bindings
          WHERE environment_id = ${sqlString(input.environmentId)}
            AND worker_script_name = ${sqlString(worker.scriptName)}`
      );
      for (const binding of worker.bindings) {
        statements.push(
          `INSERT INTO control_worker_desired_bindings (
             environment_id, worker_script_name, binding_name, binding_kind,
             logical_resource_id, secret_capability, desired_spec_json, updated_at
           ) VALUES (
             ${sqlString(input.environmentId)}, ${sqlString(worker.scriptName)},
             ${sqlString(binding.name)}, ${sqlString(binding.kind)},
             ${binding.kind === 'secret' ? 'NULL' : sqlString(binding.capability)},
             ${binding.kind === 'secret' ? sqlString(binding.capability) : 'NULL'},
             ${sqlString(JSON.stringify({ scope: binding.scope, reason: binding.reason }))},
             ${input.now}
           )`
        );
      }
    }
  }

  return {
    operationId,
    aggregateDigest,
    sourceCount: input.sources.length,
    sql: `${statements.join(';\n')};`,
  };
}

export async function registerExternalCapabilities(input: {
  controlDatabaseName: string;
  environmentId: string;
  sources: readonly AggregatedExternalCapabilitySource[];
  registeredBy: string;
  now?: number;
  dryRun?: boolean;
  execute?: typeof executeD1Command;
}): Promise<ExternalCapabilityRegistrationPlan> {
  if (!input.controlDatabaseName.trim()) throw new Error('control_database_name_required');
  const plan = buildExternalCapabilityRegistrationPlan({
    environmentId: input.environmentId,
    sources: input.sources,
    registeredBy: input.registeredBy,
    now: input.now ?? Math.floor(Date.now() / 1000),
  });
  if (!input.dryRun) {
    await (input.execute ?? executeD1Command)(input.controlDatabaseName, plan.sql);
  }
  return plan;
}
