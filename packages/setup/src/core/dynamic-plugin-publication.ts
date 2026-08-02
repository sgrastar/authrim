import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { executeD1Command, putR2Object, queryD1Rows } from './cloudflare.js';
import type { AggregatedExternalCapabilitySource } from './external-capabilities.js';

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface DynamicPluginPublicationResult {
  published: Array<{
    pluginId: string;
    versionDigest: string;
    codeSha256: string;
    codeObjectKey: string;
    capabilityManifestDigest: string;
  }>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function calculateDynamicPluginVersionDigest(input: {
  codeSha256: string;
  capabilityManifestDigest: string;
  policy: unknown;
}): string {
  if (!SHA256_HEX.test(input.codeSha256) || !SHA256_HEX.test(input.capabilityManifestDigest)) {
    throw new Error('dynamic_plugin_version_digest_input_invalid');
  }
  return digest(
    new TextEncoder().encode(
      canonicalJson({
        schemaVersion: 1,
        codeSha256: input.codeSha256,
        capabilityManifestDigest: input.capabilityManifestDigest,
        policy: input.policy,
      })
    )
  );
}

function hookPolicySql(
  source: AggregatedExternalCapabilitySource,
  versionDigest: string,
  now: number
): string {
  const capabilities = source.pluginPolicy?.capabilities ?? [];
  const statements: string[] = [];
  for (const capability of capabilities) {
    const asynchronous = capability.execution === 'async';
    statements.push(
      `INSERT OR IGNORE INTO plugin_runner_dynamic_worker_hook_policies (
         plugin_id, version_digest, capability, timeout_ms, failure_policy, max_attempts,
         async_retry_budget_seconds, circuit_breaker_threshold,
         circuit_breaker_cooldown_seconds, updated_at
       ) VALUES (
         ${sqlText(source.sourceId)}, ${sqlText(versionDigest)}, ${sqlText(capability.name)},
         ${capability.timeoutMs},
         ${sqlText(capability.failurePolicy)}, ${asynchronous ? 8 : 1},
         ${asynchronous ? 86_400 : 60}, 5, 60, ${now}
       );`
    );
  }
  return statements.join('\n');
}

function egressPolicySql(
  source: AggregatedExternalCapabilitySource,
  versionDigest: string,
  now: number
): string {
  const entries = [...(source.pluginPolicy?.egressAllowedHosts ?? [])].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
  const statements: string[] = [];
  entries.forEach((entry, index) => {
    statements.push(
      `INSERT OR IGNORE INTO plugin_runner_dynamic_worker_egress_allowed_hosts (
         plugin_id, version_digest, rule_id, match_kind, host_pattern, created_at
       ) VALUES (
         ${sqlText(source.sourceId)}, ${sqlText(versionDigest)},
         ${sqlText(`manifest-${String(index).padStart(3, '0')}`)},
         ${sqlText(entry.kind)},
         ${sqlText(entry.kind === 'exact' ? entry.host : entry.suffix)}, ${now}
       );`
    );
  });
  return statements.join('\n');
}

function credentialPolicySql(
  source: AggregatedExternalCapabilitySource,
  versionDigest: string,
  now: number
): string {
  const credentials = [...(source.pluginPolicy?.credentials ?? [])].sort((left, right) =>
    left.configKey.localeCompare(right.configKey)
  );
  const statements: string[] = [];
  for (const credential of credentials) {
    statements.push(
      `INSERT OR IGNORE INTO plugin_runner_dynamic_worker_credential_slots (
         plugin_id, version_digest, config_key, required, destination_host, injection_kind,
         injection_name, updated_at
       ) VALUES (
         ${sqlText(source.sourceId)}, ${sqlText(versionDigest)},
         ${sqlText(credential.configKey)},
         ${credential.required ? 1 : 0}, ${sqlText(credential.destinationHost)},
         ${sqlText(credential.injectionKind)}, ${sqlText(credential.injectionName)}, ${now}
       );`
    );
  }
  return statements.join('\n');
}

export async function publishDynamicPluginWorkerBundles(input: {
  baseDir: string;
  enabled: boolean;
  sources: readonly AggregatedExternalCapabilitySource[];
  bucketName?: string;
  pluginRunnerDatabaseName?: string;
  now?: number;
  upload?: typeof putR2Object;
  execute?: typeof executeD1Command;
  query?: typeof queryD1Rows;
  onProgress?: (message: string) => void;
}): Promise<DynamicPluginPublicationResult> {
  const dynamicSources = input.sources.filter(
    (source) =>
      source.sourceKind === 'plugin_manifest' && source.pluginPolicy?.backend === 'dynamic_worker'
  );
  if (dynamicSources.length === 0) return { published: [] };
  if (!input.enabled) throw new Error('dynamic_plugin_worker_capability_disabled');
  if (!input.bucketName?.trim()) throw new Error('dynamic_plugin_worker_bundle_bucket_missing');
  if (!input.pluginRunnerDatabaseName?.trim()) {
    throw new Error('dynamic_plugin_worker_database_missing');
  }
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(now) || now < 1)
    throw new Error('dynamic_plugin_publication_time_invalid');
  const root = await realpath(resolve(input.baseDir));
  const upload = input.upload ?? putR2Object;
  const execute = input.execute ?? executeD1Command;
  const query = input.query ?? queryD1Rows;
  const published: DynamicPluginPublicationResult['published'] = [];

  for (const source of dynamicSources) {
    const artifact = source.pluginPolicy?.workerArtifact;
    if (!artifact || !SAFE_ID.test(source.sourceId) || !SHA256_HEX.test(artifact.codeSha256)) {
      throw new Error('dynamic_plugin_worker_artifact_invalid');
    }
    const expectedObjectKey = `plugins/${source.sourceId}/${artifact.codeSha256}.json`;
    if (artifact.codeObjectKey !== expectedObjectKey) {
      throw new Error('dynamic_plugin_worker_artifact_invalid');
    }
    const path = await realpath(resolve(root, artifact.sourceBundlePath));
    const relativePath = relative(root, path);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error('dynamic_plugin_worker_bundle_outside_project');
    }
    const bytes = await readFile(path);
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > MAX_BUNDLE_BYTES ||
      bytes.byteLength !== artifact.size ||
      digest(bytes) !== artifact.codeSha256
    ) {
      throw new Error('dynamic_plugin_worker_bundle_changed_after_discovery');
    }
    input.onProgress?.(`Publishing Dynamic Worker bundle ${source.sourceId}`);
    await upload({
      bucketName: input.bucketName,
      objectKey: artifact.codeObjectKey,
      bytes,
      contentType: 'application/json',
    });
    const approvedPolicy = source.pluginPolicy;
    if (!approvedPolicy) throw new Error('dynamic_plugin_worker_policy_missing');
    const policy = {
      backend: approvedPolicy.backend,
      resourceScope: approvedPolicy.resourceScope,
      visibility: approvedPolicy.visibility,
      capabilities: approvedPolicy.capabilities,
      credentials: approvedPolicy.credentials,
      egressAllowedHosts: approvedPolicy.egressAllowedHosts,
      hostInterfaces: approvedPolicy.hostInterfaces,
      resources: approvedPolicy.resources,
    };
    const policyJson = canonicalJson(policy);
    const versionDigest = calculateDynamicPluginVersionDigest({
      codeSha256: artifact.codeSha256,
      capabilityManifestDigest: source.capabilityManifestDigest,
      policy,
    });
    await execute(
      input.pluginRunnerDatabaseName,
      `INSERT OR IGNORE INTO plugin_runner_dynamic_worker_releases (
         plugin_id, version_digest, code_sha256, code_object_key, source_manifest_hash,
         capability_manifest_digest, policy_json, state, published_at, updated_at
       ) VALUES (
         ${sqlText(source.sourceId)}, ${sqlText(versionDigest)}, ${sqlText(artifact.codeSha256)},
         ${sqlText(artifact.codeObjectKey)}, ${sqlText(source.sourceManifestHash)},
         ${sqlText(source.capabilityManifestDigest)}, ${sqlText(policyJson)},
         'published', ${now}, ${now}
       );
       UPDATE plugin_runner_dynamic_worker_releases
          SET state = 'published', updated_at = ${now}
        WHERE plugin_id = ${sqlText(source.sourceId)}
          AND version_digest = ${sqlText(versionDigest)}
          AND code_sha256 = ${sqlText(artifact.codeSha256)}
          AND code_object_key = ${sqlText(artifact.codeObjectKey)}
          AND source_manifest_hash = ${sqlText(source.sourceManifestHash)}
          AND capability_manifest_digest = ${sqlText(source.capabilityManifestDigest)}
          AND policy_json = ${sqlText(policyJson)};
       INSERT INTO plugin_runner_dynamic_worker_manifests (
         plugin_id, active_version_digest, state, updated_at
       ) VALUES (
         ${sqlText(source.sourceId)}, ${sqlText(versionDigest)}, 'staging', ${now}
       ) ON CONFLICT(plugin_id) DO UPDATE SET
         active_version_digest = excluded.active_version_digest,
         state = 'staging',
         updated_at = excluded.updated_at;
       ${hookPolicySql(source, versionDigest, now)}
       ${egressPolicySql(source, versionDigest, now)}
       ${credentialPolicySql(source, versionDigest, now)}
       UPDATE plugin_runner_dynamic_worker_manifests
          SET state = 'active', updated_at = ${now}
        WHERE plugin_id = ${sqlText(source.sourceId)}
          AND active_version_digest = ${sqlText(versionDigest)};`
    );
    const rows = await query<{
      plugin_id: string;
      version_digest: string;
      code_sha256: string;
      code_object_key: string;
      state: string;
      source_manifest_hash: string;
      capability_manifest_digest: string;
      policy_json: string;
      active_version_digest: string;
      manifest_state: string;
      hook_count: number | string;
      egress_count: number | string;
      credential_count: number | string;
    }>(
      input.pluginRunnerDatabaseName,
      `SELECT release.plugin_id, release.version_digest, release.code_sha256,
              release.code_object_key, release.state, release.source_manifest_hash,
              release.capability_manifest_digest, release.policy_json,
              manifest.active_version_digest,
              manifest.state AS manifest_state,
              (SELECT COUNT(*) FROM plugin_runner_dynamic_worker_hook_policies hook
                WHERE hook.plugin_id = release.plugin_id
                  AND hook.version_digest = release.version_digest) AS hook_count,
              (SELECT COUNT(*) FROM plugin_runner_dynamic_worker_egress_allowed_hosts egress
                WHERE egress.plugin_id = release.plugin_id
                  AND egress.version_digest = release.version_digest) AS egress_count,
              (SELECT COUNT(*) FROM plugin_runner_dynamic_worker_credential_slots slot
                WHERE slot.plugin_id = release.plugin_id
                  AND slot.version_digest = release.version_digest) AS credential_count
         FROM plugin_runner_dynamic_worker_releases release
         JOIN plugin_runner_dynamic_worker_manifests manifest
           ON manifest.plugin_id = release.plugin_id
        WHERE release.plugin_id = ${sqlText(source.sourceId)}
          AND release.version_digest = ${sqlText(versionDigest)}`
    );
    if (
      rows.length !== 1 ||
      rows[0]?.plugin_id !== source.sourceId ||
      rows[0]?.version_digest !== versionDigest ||
      rows[0]?.code_sha256 !== artifact.codeSha256 ||
      rows[0]?.code_object_key !== artifact.codeObjectKey ||
      rows[0]?.state !== 'published' ||
      rows[0]?.source_manifest_hash !== source.sourceManifestHash ||
      rows[0]?.capability_manifest_digest !== source.capabilityManifestDigest ||
      rows[0]?.policy_json !== policyJson ||
      rows[0]?.active_version_digest !== versionDigest ||
      rows[0]?.manifest_state !== 'active' ||
      Number(rows[0]?.hook_count) !== policy.capabilities.length ||
      Number(rows[0]?.egress_count) !== policy.egressAllowedHosts.length ||
      Number(rows[0]?.credential_count) !== policy.credentials.length
    ) {
      throw new Error('dynamic_plugin_worker_publication_reflection_invalid');
    }
    published.push({
      pluginId: source.sourceId,
      versionDigest,
      codeSha256: artifact.codeSha256,
      codeObjectKey: artifact.codeObjectKey,
      capabilityManifestDigest: source.capabilityManifestDigest,
    });
  }
  return { published };
}
