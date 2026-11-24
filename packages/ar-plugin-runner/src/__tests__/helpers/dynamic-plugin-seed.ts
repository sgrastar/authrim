import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { derivePluginInstallationId } from '@authrim/ar-lib-core';

export const digest = (char: string): string => char.repeat(64);
export const VERSION_1 = digest('1');
export const VERSION_2 = digest('2');

export const basePolicy = (overrides: Record<string, unknown> = {}) => ({
  backend: 'dynamic_worker',
  resourceScope: 'tenant',
  visibility: 'tenant',
  capabilities: [{ name: 'flow.evaluate' }],
  credentials: [],
  egressAllowedHosts: [],
  hostInterfaces: [],
  resources: [],
  ...overrides,
});

export interface SlotSeed {
  configKey: string;
  required: boolean;
  destinationHost?: string;
  injectionKind?: 'header' | 'bearer';
  injectionName?: string;
}

export interface PluginSeed {
  pluginId?: string;
  version?: string;
  policy?: unknown;
  slots?: SlotSeed[];
  releaseState?: 'published' | 'revoked';
  manifestState?: 'staging' | 'active' | 'revoked';
  manifest?: boolean;
  capabilityDigest?: string;
  updatedAt?: number;
}

/** Inserts a release, optionally makes it the plugin's manifest, and its credential slots. */
export function seedPlugin(database: DatabaseSync, seed: PluginSeed = {}): void {
  const pluginId = seed.pluginId ?? 'plugin-a';
  const version = seed.version ?? VERSION_1;
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_releases (
         plugin_id, version_digest, code_sha256, code_object_key, source_manifest_hash,
         capability_manifest_digest, policy_json, state, published_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`
    )
    .run(
      pluginId,
      version,
      digest('b'),
      `plugins/${pluginId}/${version}.json`,
      digest('c'),
      seed.capabilityDigest ?? digest('d'),
      typeof seed.policy === 'string' ? seed.policy : JSON.stringify(seed.policy ?? basePolicy()),
      seed.releaseState ?? 'published'
    );
  let rule = 0;
  const seenHosts = new Set<string>();
  for (const slot of seed.slots ?? []) {
    const host = slot.destinationHost ?? 'api.example.com';
    if (!seenHosts.has(host)) {
      seenHosts.add(host);
      database
        .prepare(
          `INSERT INTO plugin_runner_dynamic_worker_egress_allowed_hosts (
             plugin_id, version_digest, rule_id, match_kind, host_pattern, created_at
           ) VALUES (?, ?, ?, 'exact', ?, 1)`
        )
        .run(pluginId, version, `manifest-${String(rule++).padStart(3, '0')}`, host);
    }
    database
      .prepare(
        `INSERT INTO plugin_runner_dynamic_worker_credential_slots (
           plugin_id, version_digest, config_key, required, destination_host,
           injection_kind, injection_name, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        pluginId,
        version,
        slot.configKey,
        slot.required ? 1 : 0,
        slot.destinationHost ?? 'api.example.com',
        slot.injectionKind ?? 'bearer',
        slot.injectionName ?? (slot.injectionKind === 'header' ? 'X-Key' : 'Authorization')
      );
  }
  if (seed.manifest !== false) {
    database
      .prepare(
        `INSERT INTO plugin_runner_dynamic_worker_manifests (
           plugin_id, active_version_digest, state, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET
           active_version_digest = excluded.active_version_digest,
           state = excluded.state, updated_at = excluded.updated_at`
      )
      .run(pluginId, version, seed.manifestState ?? 'active', seed.updatedAt ?? 7);
  }
}

export interface InstallationSeed {
  tenantId?: string;
  pluginId?: string;
  installationId?: string;
  state?: 'enabled' | 'disabled' | 'blocked';
  backendKind?: 'dynamic_worker' | 'in_process';
  scriptName?: string | null;
  configVersion?: number;
  pending?: string | null;
  environmentId?: string;
}

export async function installationIdFor(
  tenantId: string,
  pluginId = 'plugin-a',
  environmentId = 'test'
): Promise<string> {
  return derivePluginInstallationId({
    environmentId,
    tenantId,
    pluginId,
    purpose: 'dynamic-plugin',
  });
}

export async function seedInstallation(
  database: DatabaseSync,
  seed: InstallationSeed = {}
): Promise<string> {
  const tenantId = seed.tenantId ?? 'tenant-a';
  const pluginId = seed.pluginId ?? 'plugin-a';
  const installationId =
    seed.installationId ?? (await installationIdFor(tenantId, pluginId, seed.environmentId));
  const backendKind = seed.backendKind ?? 'dynamic_worker';
  database
    .prepare(
      `INSERT INTO plugin_runner_installations (
         installation_id, tenant_id, plugin_id, backend_kind, script_name, state,
         config_version, pending_activation_request_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`
    )
    .run(
      installationId,
      tenantId,
      pluginId,
      backendKind,
      seed.scriptName === undefined
        ? backendKind === 'in_process'
          ? null
          : pluginId
        : seed.scriptName,
      seed.state ?? 'disabled',
      seed.configVersion ?? 1,
      seed.pending ?? null
    );
  return installationId;
}

export function seedArtifact(
  database: DatabaseSync,
  installationId: string,
  version: string,
  state: 'active' | 'retired' | 'pending' = 'active',
  pluginId = 'plugin-a'
): string {
  const artifactId = artifactIdFor(installationId, version);
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_artifacts (
         artifact_id, installation_id, plugin_id, version_digest, state, activated_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(artifactId, installationId, pluginId, version, state, state === 'active' ? 1 : null);
  return artifactId;
}

export function artifactIdFor(installationId: string, version: string): string {
  return `plugin-artifact-v1-${createHash('sha256')
    .update(JSON.stringify([installationId, version]))
    .digest('hex')}`;
}

export function seedConfig(
  database: DatabaseSync,
  installationId: string,
  key: string,
  options: {
    version?: number;
    host?: string;
    kind?: 'header' | 'bearer';
    name?: string;
    nonce?: string;
  } = {}
): void {
  const kind = options.kind ?? 'bearer';
  database
    .prepare(
      `INSERT INTO plugin_runner_encrypted_configs (
         installation_id, config_key, config_version, injection_kind, injection_name,
         destination_host, encryption_key_id, encrypted_value, nonce_fingerprint,
         reencrypt_state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'k1', 'enc:v1:x', ?, 'current', 1, 1)`
    )
    .run(
      installationId,
      key,
      options.version ?? 1,
      kind,
      options.name ?? (kind === 'bearer' ? 'authorization' : 'X-Key'),
      options.host ?? 'api.example.com',
      options.nonce ??
        createHash('sha256')
          .update(`${installationId}/${key}/${options.version ?? 1}`)
          .digest('hex')
    );
}

export function rows<T>(
  database: DatabaseSync,
  sql: string,
  ...values: Array<string | number | null>
): T[] {
  return database.prepare(sql).all(...values) as T[];
}
