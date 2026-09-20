import type { Env, PortableDynamicPluginConfiguration } from '@authrim/ar-lib-core';
import {
  encodePortablePluginConfiguration,
  type PortablePluginConfiguration,
} from '@authrim/ar-lib-core/services/tenant-portability/phase5-record-datasets';
import {
  decryptSecretFields,
  encryptSecretFields,
  getPluginEncryptionKey,
  type EncryptedConfig,
} from '@authrim/ar-lib-plugin';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import { createEncryptedTenantBackupRecordSnapshotPort } from './tenant-backup-record-snapshot-port';

const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_CONFIG_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_LOGICAL_RESOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PLUGINS = 256;

interface RegistryEntry {
  id?: unknown;
  version?: unknown;
  backendKind?: unknown;
  activeVersionDigest?: unknown;
}

interface PortableKvPluginConfig {
  version: 1;
  backend: 'kv';
  enabled: boolean;
  value: Record<string, unknown>;
  secretFields: string[];
}

type PortablePluginConfig = PortableKvPluginConfig | PortableDynamicPluginConfiguration;

function invalid(): never {
  throw new Error('backup_plugin_configuration_invalid');
}

function kv(env: Pick<Env, 'SETTINGS'>): KVNamespace {
  return env.SETTINGS ?? invalid();
}

function configKey(pluginId: string, tenantId: string): string {
  return `plugins:config:${pluginId}:tenant:${tenantId}`;
}

function enabledKey(pluginId: string, tenantId: string): string {
  return `plugins:enabled:${pluginId}:tenant:${tenantId}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function registry(env: Env): Promise<Map<string, RegistryEntry>> {
  const raw = await kv(env).get('plugins:registry');
  let parsed: Record<string, unknown> = {};
  if (raw !== null) {
    try {
      parsed = record(JSON.parse(raw));
    } catch {
      return invalid();
    }
  }
  const entries = Object.entries(parsed);
  if (entries.length > MAX_PLUGINS) invalid();
  const result = new Map<string, RegistryEntry>();
  for (const [pluginId, value] of entries) {
    const entry = record(value) as RegistryEntry;
    if (!SAFE_PLUGIN_ID.test(pluginId) || (entry.id !== undefined && entry.id !== pluginId))
      invalid();
    result.set(pluginId, entry);
  }
  if (env.PLUGIN_RUNNER) {
    const dynamic = await env.PLUGIN_RUNNER.listApprovedDynamicPlugins();
    if (dynamic.length > MAX_PLUGINS) invalid();
    for (const plugin of dynamic) {
      if (!SAFE_PLUGIN_ID.test(plugin.pluginId) || !SHA256.test(plugin.activeVersionDigest))
        invalid();
      const existing = result.get(plugin.pluginId);
      if (
        existing &&
        (existing.backendKind !== 'dynamic_worker' ||
          (existing.activeVersionDigest !== undefined &&
            existing.activeVersionDigest !== plugin.activeVersionDigest))
      )
        invalid();
      result.set(plugin.pluginId, {
        id: plugin.pluginId,
        version: plugin.activeVersionDigest,
        backendKind: 'dynamic_worker',
        activeVersionDigest: plugin.activeVersionDigest,
      });
    }
  }
  return result;
}

async function versionDigest(pluginId: string, entry: RegistryEntry): Promise<string> {
  if (typeof entry.activeVersionDigest === 'string' && SHA256.test(entry.activeVersionDigest))
    return entry.activeVersionDigest;
  if (typeof entry.version !== 'string' || !entry.version || entry.version.length > 128) invalid();
  return sha256(
    JSON.stringify([
      'authrim-portable-kv-plugin-version-v1',
      pluginId,
      entry.version,
      entry.backendKind ?? 'in_process',
    ])
  );
}

function secretFields(value: Record<string, unknown>): string[] {
  const fields = value._encrypted;
  if (fields === undefined) return [];
  if (!Array.isArray(fields) || fields.length > 128) invalid();
  const normalized = fields.map((field) => {
    if (typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(field))
      return invalid();
    return field;
  });
  if (new Set(normalized).size !== normalized.length) invalid();
  return normalized.sort();
}

async function decryptConfig(
  env: Env,
  raw: string
): Promise<{
  value: Record<string, unknown>;
  secretFields: string[];
}> {
  let parsed: Record<string, unknown>;
  try {
    parsed = record(JSON.parse(raw));
  } catch {
    return invalid();
  }
  const fields = secretFields(parsed);
  if (!fields.length) return { value: parsed, secretFields: [] };
  try {
    const key = await getPluginEncryptionKey(env);
    return {
      value: record(await decryptSecretFields(parsed as EncryptedConfig, key)),
      secretFields: fields,
    };
  } catch {
    return invalid();
  }
}

function decodeConfig(configuration: PortablePluginConfiguration): PortablePluginConfig {
  const value = record(configuration.config);
  if (value.backend === 'dynamic_worker') {
    if (
      Object.keys(value).sort().join(',') !==
        'backend,credentials,enabled,mutationScopes,resources,version' ||
      value.version !== 1
    )
      invalid();
    if (
      typeof value.enabled !== 'boolean' ||
      !value.credentials ||
      typeof value.credentials !== 'object' ||
      Array.isArray(value.credentials) ||
      !Array.isArray(value.resources) ||
      !Array.isArray(value.mutationScopes)
    )
      invalid();
    const credentials = Object.entries(value.credentials);
    const resources = value.resources as Array<Record<string, unknown>>;
    const scopes = value.mutationScopes;
    if (
      credentials.length > 16 ||
      credentials.some(
        ([key, secret]) =>
          !SAFE_CONFIG_KEY.test(key) ||
          typeof secret !== 'string' ||
          secret.length < 1 ||
          secret.length > 8_192
      ) ||
      resources.length > 16 ||
      resources.some(
        (resource) =>
          !resource ||
          typeof resource !== 'object' ||
          Array.isArray(resource) ||
          Object.keys(resource).sort().join(',') !== 'access,binding,kind,logicalResourceId' ||
          typeof resource.logicalResourceId !== 'string' ||
          !SAFE_LOGICAL_RESOURCE_ID.test(resource.logicalResourceId) ||
          typeof resource.binding !== 'string' ||
          !SAFE_BINDING.test(resource.binding) ||
          typeof resource.kind !== 'string' ||
          !['d1', 'kv_namespace', 'r2_bucket'].includes(resource.kind) ||
          typeof resource.access !== 'string' ||
          !['read_only', 'read_write'].includes(resource.access)
      ) ||
      new Set(resources.map((resource) => resource.logicalResourceId)).size !== resources.length ||
      new Set(resources.map((resource) => resource.binding)).size !== resources.length ||
      scopes.length > 16 ||
      scopes.some((scope) => scope !== 'account.metadata.write') ||
      new Set(scopes).size !== scopes.length ||
      !SAFE_ID.test(configuration.installationId)
    )
      invalid();
    const dynamic: PortableDynamicPluginConfiguration = {
      tenantId: configuration.tenantId,
      sourceInstallationId: configuration.installationId,
      pluginId: configuration.pluginId,
      versionDigest: configuration.versionDigest,
      contractVersion: 1,
      enabled: value.enabled,
      credentials: value.credentials as Record<string, string>,
      resources: value.resources as PortableDynamicPluginConfiguration['resources'],
      mutationScopes: value.mutationScopes as string[],
    };
    return dynamic;
  }
  if (
    Object.keys(value).sort().join(',') !== 'backend,enabled,secretFields,value,version' ||
    value.version !== 1 ||
    value.backend !== 'kv' ||
    typeof value.enabled !== 'boolean'
  )
    invalid();
  const config = record(value.value);
  const fields = value.secretFields;
  if (!Array.isArray(fields) || fields.length > 128) invalid();
  const normalized = fields.map((field) => {
    if (
      typeof field !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(field) ||
      !Object.hasOwn(config, field)
    )
      return invalid();
    return field;
  });
  if (new Set(normalized).size !== normalized.length) invalid();
  return {
    version: 1,
    backend: 'kv',
    enabled: value.enabled,
    value: config,
    secretFields: normalized.sort(),
  };
}

async function installedEntry(env: Env, configuration: PortablePluginConfiguration) {
  const entry = (await registry(env)).get(configuration.pluginId) ?? invalid();
  const decoded = decodeConfig(configuration);
  if ('sourceInstallationId' in decoded) {
    if (
      entry.backendKind !== 'dynamic_worker' ||
      entry.activeVersionDigest !== configuration.versionDigest ||
      configuration.contractVersion !== 1 ||
      configuration.installationId !== decoded.sourceInstallationId ||
      !env.PLUGIN_RUNNER ||
      typeof env.PLUGIN_RUNNER.restoreDynamicPluginBackup !== 'function' ||
      typeof env.PLUGIN_RUNNER.verifyDynamicPluginBackup !== 'function'
    )
      invalid();
    return entry;
  }
  if (
    entry.backendKind === 'dynamic_worker' ||
    (await versionDigest(configuration.pluginId, entry)) !== configuration.versionDigest ||
    configuration.contractVersion !== 1 ||
    configuration.installationId !== `kv-plugin:${configuration.pluginId}`
  )
    invalid();
  return entry;
}

async function* capture(env: Env, context: AdapterContext): AsyncIterable<Uint8Array> {
  const tenantId = context.context.lease.tenantId;
  const installed = await registry(env);
  for (const [pluginId, entry] of [...installed.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    context.context.signal.throwIfAborted();
    if (entry.backendKind === 'dynamic_worker') {
      const runner = env.PLUGIN_RUNNER;
      if (!runner || typeof runner.exportDynamicPluginBackup !== 'function') invalid();
      const configuration = await runner.exportDynamicPluginBackup({ tenantId, pluginId });
      if (!configuration) continue;
      if (
        configuration.tenantId !== tenantId ||
        configuration.pluginId !== pluginId ||
        configuration.versionDigest !== entry.activeVersionDigest
      )
        invalid();
      yield encodePortablePluginConfiguration({
        tenantId,
        installationId: configuration.sourceInstallationId,
        pluginId,
        versionDigest: configuration.versionDigest,
        contractVersion: 1,
        config: {
          version: 1,
          backend: 'dynamic_worker',
          enabled: configuration.enabled,
          credentials: configuration.credentials,
          resources: configuration.resources,
          mutationScopes: configuration.mutationScopes,
        },
      });
      continue;
    }
    const [rawConfig, rawEnabled] = await Promise.all([
      kv(env).get(configKey(pluginId, tenantId)),
      kv(env).get(enabledKey(pluginId, tenantId)),
    ]);
    if (rawConfig === null && rawEnabled === null) continue;
    if (rawEnabled !== null && rawEnabled !== 'true' && rawEnabled !== 'false') invalid();
    const decoded =
      rawConfig === null ? { value: {}, secretFields: [] } : await decryptConfig(env, rawConfig);
    yield encodePortablePluginConfiguration({
      tenantId,
      installationId: `kv-plugin:${pluginId}`,
      pluginId,
      versionDigest: await versionDigest(pluginId, entry),
      contractVersion: 1,
      config: {
        version: 1,
        backend: 'kv',
        enabled: rawEnabled === 'true',
        value: decoded.value,
        secretFields: decoded.secretFields,
      } satisfies PortableKvPluginConfig,
    });
  }
}

async function normalizedTarget(env: Env, configuration: PortablePluginConfiguration) {
  const decoded = decodeConfig(configuration);
  if ('sourceInstallationId' in decoded) invalid();
  const raw = await kv(env).get(configKey(configuration.pluginId, configuration.tenantId));
  return {
    decoded,
    current: raw === null ? null : await decryptConfig(env, raw),
    enabled: await kv(env).get(enabledKey(configuration.pluginId, configuration.tenantId)),
  };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Tenant-owned legacy plugin KV configuration with target-environment secret re-encryption. */
export function createTenantBackupPluginConfigurationPorts(env: Env) {
  async function verifyPlugin(
    context: { signal: AbortSignal },
    configuration: PortablePluginConfiguration
  ): Promise<boolean> {
    context.signal.throwIfAborted();
    await installedEntry(env, configuration);
    const decoded = decodeConfig(configuration);
    if ('sourceInstallationId' in decoded) {
      return env.PLUGIN_RUNNER?.verifyDynamicPluginBackup({ configuration: decoded }) ?? false;
    }
    const { current, enabled } = await normalizedTarget(env, configuration);
    return (
      current !== null &&
      same(current.value, decoded.value) &&
      same(current.secretFields, decoded.secretFields) &&
      enabled === String(decoded.enabled)
    );
  }

  return {
    pluginConfiguration: createEncryptedTenantBackupRecordSnapshotPort({
      env,
      resourceId: 'plugin-configuration:tenant-kv',
      assertSource: async (context) => {
        for await (const record of capture(env, context)) if (!record.length) invalid();
      },
      capture: (context) => capture(env, context),
    }),
    async assertPluginSupported(configuration: PortablePluginConfiguration): Promise<void> {
      await installedEntry(env, configuration);
      decodeConfig(configuration);
    },
    async importPlugin(
      context: { signal: AbortSignal },
      configuration: PortablePluginConfiguration
    ): Promise<void> {
      context.signal.throwIfAborted();
      await installedEntry(env, configuration);
      const decodedConfiguration = decodeConfig(configuration);
      if ('sourceInstallationId' in decodedConfiguration) {
        const runner = env.PLUGIN_RUNNER ?? invalid();
        await runner.restoreDynamicPluginBackup({
          operationId: `backup-${configuration.tenantId}-${configuration.pluginId}`,
          configuration: decodedConfiguration,
        });
        if (!(await verifyPlugin(context, configuration))) invalid();
        return;
      }
      const { decoded, current, enabled } = await normalizedTarget(env, configuration);
      if (
        (current &&
          (!same(current.value, decoded.value) ||
            !same(current.secretFields, decoded.secretFields))) ||
        (enabled !== null && enabled !== String(decoded.enabled))
      )
        invalid();
      if (!current) {
        const stored = decoded.secretFields.length
          ? await encryptSecretFields(
              decoded.value,
              decoded.secretFields,
              await getPluginEncryptionKey(env)
            )
          : decoded.value;
        await kv(env).put(
          configKey(configuration.pluginId, configuration.tenantId),
          JSON.stringify(stored)
        );
      }
      if (enabled === null)
        await kv(env).put(
          enabledKey(configuration.pluginId, configuration.tenantId),
          String(decoded.enabled)
        );
      context.signal.throwIfAborted();
      if (!(await verifyPlugin(context, configuration))) invalid();
    },
    verifyPlugin,
  };
}
