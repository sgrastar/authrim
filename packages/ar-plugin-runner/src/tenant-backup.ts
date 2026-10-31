import type { D1DatabaseSession } from '@cloudflare/workers-types';
import { deriveEncryptionKey, decryptValue } from '@authrim/ar-lib-plugin';
import type {
  PortableDynamicPluginConfiguration,
  RestoreDynamicPluginBackupInput,
  RestoreDynamicPluginBackupResult,
} from '@authrim/ar-lib-core';
import { D1PluginConfigStore } from './config-store';
import { D1DynamicPluginInstallationStore } from './dynamic-worker-installations';
import { pluginEncryptionKeyringFromEnv, pluginEncryptionSecretFor } from './encryption-keyring';
import type { PluginRunnerEnv } from './types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_CONFIG_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_LOGICAL_RESOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_ITEMS = 16;

interface CredentialRow {
  config_key: string;
  config_version: number | string;
  encryption_key_id: string;
  encrypted_value: string;
}

interface ResourceRow {
  tenant_id: string;
  plugin_id: string;
  logical_resource_id: string;
  logical_binding_name: string;
  resource_kind: string;
  access_mode: string;
}

interface ScopeRow {
  mutation_scope: string;
}

function invalid(): never {
  throw new Error('plugin_dynamic_backup_input_invalid');
}

function primary(env: PluginRunnerEnv): D1DatabaseSession {
  if (typeof env.PLUGIN_RUNNER_DB.withSession !== 'function') {
    throw new Error('plugin_dynamic_backup_d1_session_required');
  }
  return env.PLUGIN_RUNNER_DB.withSession('first-primary');
}

function integer(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) invalid();
  return parsed;
}

function assertQuery(input: unknown): asserts input is { tenantId: string; pluginId: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'pluginId,tenantId' ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    typeof value.pluginId !== 'string' ||
    !SAFE_PLUGIN_ID.test(value.pluginId)
  )
    invalid();
}

function assertConfiguration(input: unknown): asserts input is PortableDynamicPluginConfiguration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const value = input as Partial<PortableDynamicPluginConfiguration>;
  if (
    Object.keys(input).sort().join(',') !==
      'contractVersion,credentials,enabled,mutationScopes,pluginId,resources,sourceInstallationId,tenantId,versionDigest' ||
    value.contractVersion !== 1 ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    typeof value.sourceInstallationId !== 'string' ||
    !SAFE_ID.test(value.sourceInstallationId) ||
    typeof value.pluginId !== 'string' ||
    !SAFE_PLUGIN_ID.test(value.pluginId) ||
    typeof value.versionDigest !== 'string' ||
    !SHA256.test(value.versionDigest) ||
    typeof value.enabled !== 'boolean' ||
    !value.credentials ||
    typeof value.credentials !== 'object' ||
    Array.isArray(value.credentials) ||
    !Array.isArray(value.resources) ||
    !Array.isArray(value.mutationScopes)
  )
    invalid();
  const credentials = Object.entries(value.credentials);
  if (
    credentials.length > MAX_ITEMS ||
    credentials.some(
      ([key, secret]) =>
        !SAFE_CONFIG_KEY.test(key) ||
        typeof secret !== 'string' ||
        secret.length < 1 ||
        secret.length > 8_192
    )
  )
    invalid();
  const resources = value.resources;
  if (
    resources.length > MAX_ITEMS ||
    resources.some(
      (resource) =>
        !resource ||
        typeof resource !== 'object' ||
        Array.isArray(resource) ||
        Object.keys(resource).sort().join(',') !== 'access,binding,kind,logicalResourceId' ||
        !SAFE_LOGICAL_RESOURCE_ID.test(resource.logicalResourceId) ||
        !SAFE_BINDING.test(resource.binding) ||
        !['d1', 'kv_namespace', 'r2_bucket'].includes(resource.kind) ||
        !['read_only', 'read_write'].includes(resource.access)
    ) ||
    new Set(resources.map((resource) => resource.logicalResourceId)).size !== resources.length ||
    new Set(resources.map((resource) => resource.binding)).size !== resources.length
  )
    invalid();
  if (
    value.mutationScopes.length > MAX_ITEMS ||
    value.mutationScopes.some(
      (scope) => typeof scope !== 'string' || scope !== 'account.metadata.write'
    ) ||
    new Set(value.mutationScopes).size !== value.mutationScopes.length
  )
    invalid();
}

function aad(input: {
  tenantId: string;
  pluginId: string;
  configKey: string;
  configVersion: number;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([input.tenantId, input.pluginId, input.configKey, input.configVersion])
  );
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function operationId(input: RestoreDynamicPluginBackupInput): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        input.operationId,
        input.configuration.tenantId,
        input.configuration.pluginId,
        input.configuration.versionDigest,
      ])
    )
  );
  return `backup-plugin-${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}

export class DynamicPluginTenantBackupService {
  constructor(
    private readonly env: PluginRunnerEnv,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000)
  ) {}

  async export(input: unknown): Promise<PortableDynamicPluginConfiguration | null> {
    assertQuery(input);
    const installations = new D1DynamicPluginInstallationStore(
      this.env.PLUGIN_RUNNER_DB,
      this.env.AUTHRIM_ENVIRONMENT_NAME,
      this.now
    );
    const status = await installations.status(input);
    if (status.state === 'absent') return null;
    if (status.state === 'blocked') throw new Error('plugin_dynamic_backup_source_blocked');
    const approved = (await installations.listApproved()).find(
      (plugin) => plugin.pluginId === input.pluginId
    );
    if (!approved) throw new Error('plugin_dynamic_backup_version_unavailable');
    const versionDigest = status.pinnedVersionDigest ?? approved.activeVersionDigest;
    if (!SHA256.test(versionDigest)) throw new Error('plugin_dynamic_backup_version_unavailable');
    const session = primary(this.env);
    const [credentialRows, resourceRows, scopeRows] = await Promise.all([
      session
        .prepare(
          `SELECT config_key, config_version, encryption_key_id, encrypted_value
             FROM plugin_runner_encrypted_configs
            WHERE installation_id = ? AND config_version = ?
            ORDER BY config_key LIMIT 17`
        )
        .bind(status.installationId, status.configVersion)
        .all<CredentialRow>(),
      session
        .prepare(
          `SELECT tenant_id, plugin_id, logical_resource_id, logical_binding_name,
                  resource_kind, access_mode
             FROM plugin_runner_dynamic_worker_resources
            WHERE installation_id = ? ORDER BY logical_resource_id LIMIT 17`
        )
        .bind(status.installationId)
        .all<ResourceRow>(),
      session
        .prepare(
          `SELECT mutation_scope FROM plugin_runner_installation_mutation_scopes
            WHERE installation_id = ? AND state = 'enabled'
            ORDER BY mutation_scope LIMIT 17`
        )
        .bind(status.installationId)
        .all<ScopeRow>(),
    ]);
    if (
      credentialRows.results.length > MAX_ITEMS ||
      resourceRows.results.length > MAX_ITEMS ||
      scopeRows.results.length > MAX_ITEMS
    )
      invalid();
    const keyring = pluginEncryptionKeyringFromEnv(this.env);
    const derived = new Map<string, Promise<CryptoKey>>();
    const credentials = Object.fromEntries(
      await Promise.all(
        credentialRows.results.map(async (row) => {
          if (!SAFE_CONFIG_KEY.test(row.config_key)) invalid();
          const configVersion = integer(row.config_version);
          let key = derived.get(row.encryption_key_id);
          if (!key) {
            key = deriveEncryptionKey(pluginEncryptionSecretFor(keyring, row.encryption_key_id));
            derived.set(row.encryption_key_id, key);
          }
          return [
            row.config_key,
            await decryptValue(
              row.encrypted_value,
              await key,
              aad({
                tenantId: input.tenantId,
                pluginId: input.pluginId,
                configKey: row.config_key,
                configVersion,
              })
            ),
          ] as const;
        })
      )
    );
    const configuration: PortableDynamicPluginConfiguration = {
      tenantId: input.tenantId,
      sourceInstallationId: status.installationId,
      pluginId: input.pluginId,
      versionDigest,
      contractVersion: 1,
      enabled: status.state === 'enabled',
      credentials,
      resources: resourceRows.results.map((row) => {
        if (row.tenant_id !== input.tenantId || row.plugin_id !== input.pluginId) invalid();
        return {
          logicalResourceId: row.logical_resource_id,
          binding: row.logical_binding_name,
          kind: row.resource_kind as 'd1' | 'kv_namespace' | 'r2_bucket',
          access: row.access_mode as 'read_only' | 'read_write',
        };
      }),
      mutationScopes: scopeRows.results.map((row) => row.mutation_scope),
    };
    assertConfiguration(configuration);
    return configuration;
  }

  async restore(input: unknown): Promise<RestoreDynamicPluginBackupResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
    const value = input as Partial<RestoreDynamicPluginBackupInput>;
    if (
      Object.keys(input).sort().join(',') !== 'configuration,operationId' ||
      typeof value.operationId !== 'string' ||
      !SAFE_ID.test(value.operationId)
    )
      invalid();
    assertConfiguration(value.configuration);
    const configuration = value.configuration;
    const installations = new D1DynamicPluginInstallationStore(
      this.env.PLUGIN_RUNNER_DB,
      this.env.AUTHRIM_ENVIRONMENT_NAME,
      this.now
    );
    const approved = (await installations.listApproved()).find(
      (plugin) => plugin.pluginId === configuration.pluginId
    );
    if (!approved || approved.activeVersionDigest !== configuration.versionDigest) {
      throw new Error('plugin_dynamic_backup_version_mismatch');
    }
    let status = await installations.status({
      tenantId: configuration.tenantId,
      pluginId: configuration.pluginId,
    });
    const session = primary(this.env);
    const resources = await this.resources(session, status.installationId, configuration);
    if (!same(resources, configuration.resources)) {
      throw new Error('plugin_dynamic_backup_resources_required');
    }
    if (status.state === 'blocked') throw new Error('plugin_dynamic_backup_target_blocked');
    if (status.state === 'absent') {
      if (configuration.resources.length) {
        throw new Error('plugin_dynamic_backup_resources_required');
      }
      await installations.configure({
        tenantId: configuration.tenantId,
        pluginId: configuration.pluginId,
        enabled: false,
      });
      status = await installations.status({
        tenantId: configuration.tenantId,
        pluginId: configuration.pluginId,
      });
    }
    const currentCredentials = await this.credentials(session, status, configuration);
    if (
      Object.keys(currentCredentials).length &&
      !same(currentCredentials, configuration.credentials)
    ) {
      throw new Error('plugin_dynamic_backup_target_conflict');
    }
    if (!Object.keys(currentCredentials).length && Object.keys(configuration.credentials).length) {
      const mapped = await installations.credentialInputs({
        tenantId: configuration.tenantId,
        pluginId: configuration.pluginId,
        credentials: configuration.credentials,
      });
      await new D1PluginConfigStore(
        this.env.PLUGIN_RUNNER_DB,
        pluginEncryptionKeyringFromEnv(this.env),
        this.env.PLUGIN_MUTATION_HMAC_KEY,
        this.now
      ).replaceCredentials({
        operationId: await operationId(value as RestoreDynamicPluginBackupInput),
        tenantId: configuration.tenantId,
        installationId: status.installationId,
        expectedConfigVersion: status.configVersion,
        credentials: mapped.values,
      });
      status = await installations.status({
        tenantId: configuration.tenantId,
        pluginId: configuration.pluginId,
      });
    }
    await this.restoreScopes(session, status.installationId, configuration);
    const reflected = await installations.configure({
      tenantId: configuration.tenantId,
      pluginId: configuration.pluginId,
      enabled: configuration.enabled,
    });
    if (!(await this.verify({ configuration }))) {
      throw new Error('plugin_dynamic_backup_verification_failed');
    }
    return {
      installationId: reflected.installationId,
      state: reflected.state,
      configVersion: reflected.configVersion,
    };
  }

  async verify(input: unknown): Promise<boolean> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
    const value = input as { configuration?: unknown };
    if (Object.keys(input).join(',') !== 'configuration') invalid();
    assertConfiguration(value.configuration);
    const configuration = value.configuration;
    const installations = new D1DynamicPluginInstallationStore(
      this.env.PLUGIN_RUNNER_DB,
      this.env.AUTHRIM_ENVIRONMENT_NAME,
      this.now
    );
    const status = await installations.status({
      tenantId: configuration.tenantId,
      pluginId: configuration.pluginId,
    });
    if (status.state !== (configuration.enabled ? 'enabled' : 'disabled')) return false;
    const session = primary(this.env);
    const [credentials, resources, scopes] = await Promise.all([
      this.credentials(session, status, configuration),
      this.resources(session, status.installationId, configuration),
      this.scopes(session, status.installationId),
    ]);
    return (
      same(credentials, configuration.credentials) &&
      same(resources, configuration.resources) &&
      same(scopes, configuration.mutationScopes)
    );
  }

  private async credentials(
    session: D1DatabaseSession,
    status: { installationId: string; configVersion: number },
    configuration: PortableDynamicPluginConfiguration
  ): Promise<Record<string, string>> {
    const rows = await session
      .prepare(
        `SELECT config_key, config_version, encryption_key_id, encrypted_value
           FROM plugin_runner_encrypted_configs
          WHERE installation_id = ? AND config_version = ? ORDER BY config_key LIMIT 17`
      )
      .bind(status.installationId, status.configVersion)
      .all<CredentialRow>();
    if (rows.results.length > MAX_ITEMS) invalid();
    const keyring = pluginEncryptionKeyringFromEnv(this.env);
    const derived = new Map<string, Promise<CryptoKey>>();
    return Object.fromEntries(
      await Promise.all(
        rows.results.map(async (row) => {
          let key = derived.get(row.encryption_key_id);
          if (!key) {
            key = deriveEncryptionKey(pluginEncryptionSecretFor(keyring, row.encryption_key_id));
            derived.set(row.encryption_key_id, key);
          }
          return [
            row.config_key,
            await decryptValue(
              row.encrypted_value,
              await key,
              aad({
                tenantId: configuration.tenantId,
                pluginId: configuration.pluginId,
                configKey: row.config_key,
                configVersion: integer(row.config_version),
              })
            ),
          ] as const;
        })
      )
    );
  }

  private async resources(
    session: D1DatabaseSession,
    installationId: string,
    configuration: PortableDynamicPluginConfiguration
  ) {
    const rows = await session
      .prepare(
        `SELECT tenant_id, plugin_id, logical_resource_id, logical_binding_name,
                resource_kind, access_mode
           FROM plugin_runner_dynamic_worker_resources
          WHERE installation_id = ? ORDER BY logical_resource_id LIMIT 17`
      )
      .bind(installationId)
      .all<ResourceRow>();
    if (rows.results.length > MAX_ITEMS) invalid();
    return rows.results.map((row) => {
      if (row.tenant_id !== configuration.tenantId || row.plugin_id !== configuration.pluginId)
        invalid();
      return {
        logicalResourceId: row.logical_resource_id,
        binding: row.logical_binding_name,
        kind: row.resource_kind,
        access: row.access_mode,
      };
    });
  }

  private async scopes(session: D1DatabaseSession, installationId: string): Promise<string[]> {
    const rows = await session
      .prepare(
        `SELECT mutation_scope FROM plugin_runner_installation_mutation_scopes
          WHERE installation_id = ? AND state = 'enabled'
          ORDER BY mutation_scope LIMIT 17`
      )
      .bind(installationId)
      .all<ScopeRow>();
    if (rows.results.length > MAX_ITEMS) invalid();
    return rows.results.map((row) => row.mutation_scope);
  }

  private async restoreScopes(
    session: D1DatabaseSession,
    installationId: string,
    configuration: PortableDynamicPluginConfiguration
  ): Promise<void> {
    const current = await this.scopes(session, installationId);
    if (current.length && !same(current, configuration.mutationScopes)) {
      throw new Error('plugin_dynamic_backup_target_conflict');
    }
    if (!configuration.mutationScopes.length || current.length) return;
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 1) invalid();
    for (const scope of configuration.mutationScopes) {
      const approved = await session
        .prepare(
          `SELECT 1 AS approved FROM plugin_runner_approved_mutation_scopes
            WHERE plugin_id = ? AND mutation_scope = ?`
        )
        .bind(configuration.pluginId, scope)
        .first<{ approved: number }>();
      if (!approved) throw new Error('plugin_dynamic_backup_scope_unapproved');
      await session
        .prepare(
          `INSERT INTO plugin_runner_installation_mutation_scopes (
             installation_id, mutation_scope, state, updated_at
           ) VALUES (?, ?, 'enabled', ?)
           ON CONFLICT(installation_id, mutation_scope) DO UPDATE SET
             state = 'enabled', updated_at = excluded.updated_at
           WHERE plugin_runner_installation_mutation_scopes.state = 'disabled'`
        )
        .bind(installationId, scope, now)
        .run();
    }
  }
}
