import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PortableDynamicPluginConfiguration } from '@authrim/ar-lib-core';
import { D1PluginConfigStore } from '../../config-store';
import { D1DynamicPluginInstallationStore } from '../../dynamic-worker-installations';
import { DynamicPluginTenantBackupService } from '../../tenant-backup';
import type { PluginRunnerEnv } from '../../types';
import { seedPlugin, VERSION_1 } from './dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './sqlite-d1';

export const MUTATION_KEY = 'plugin-runner-mutation-hmac-key-value';
export const SOURCE_KEY = 'source-plugin-runner-encryption-key-value';
export const TARGET_KEY = 'target-plugin-runner-encryption-key-value';

export interface BackupWorld {
  database: DatabaseSync;
  env: PluginRunnerEnv;
  calls: ReturnType<typeof createD1>['calls'];
  installations: D1DynamicPluginInstallationStore;
  service: (now?: () => number) => DynamicPluginTenantBackupService;
}

export function backupWorld(
  environmentId = 'source',
  key = SOURCE_KEY,
  options: D1Options = {},
  extraEnv: Record<string, unknown> = {}
): BackupWorld {
  const database = openRunnerDatabase();
  seedPlugin(database, { slots: [{ configKey: 'apiKey', required: true }] });
  database.exec(
    "INSERT INTO plugin_runner_approved_mutation_scopes (plugin_id, mutation_scope, approved_at) VALUES ('plugin-a', 'account.metadata.write', 1)"
  );
  const d1 = createD1(database, options);
  const env = {
    PLUGIN_RUNNER_DB: d1.db,
    AUTHRIM_ENVIRONMENT_NAME: environmentId,
    PLUGIN_ENCRYPTION_KEY: key,
    PLUGIN_MUTATION_HMAC_KEY: MUTATION_KEY,
    ...extraEnv,
  } as PluginRunnerEnv;
  return {
    database,
    env,
    calls: d1.calls,
    installations: new D1DynamicPluginInstallationStore(d1.db, environmentId, () => 10),
    service: (now = () => 20) => new DynamicPluginTenantBackupService(env, now),
  };
}

/** A disabled installation holding the credential, optionally with the metadata scope. */
export async function seedSourceInstallation(
  world: BackupWorld,
  options: {
    enabled?: boolean;
    scope?: boolean;
    key?: string;
    value?: string;
    keyId?: string;
  } = {}
): Promise<string> {
  const created = await world.installations.configure({
    tenantId: 'tenant-a',
    pluginId: 'plugin-a',
    enabled: false,
  });
  await new D1PluginConfigStore(
    world.env.PLUGIN_RUNNER_DB,
    options.key ?? world.env.PLUGIN_ENCRYPTION_KEY,
    MUTATION_KEY,
    () => 11
  ).replaceCredentials({
    operationId: 'source-credential',
    tenantId: 'tenant-a',
    installationId: created.installationId,
    expectedConfigVersion: 1,
    credentials: [
      {
        configKey: 'apiKey',
        destinationHost: 'api.example.com',
        injectionKind: 'bearer',
        injectionName: 'Authorization',
        value: options.value ?? 'source-secret',
      },
    ],
  });
  if (options.scope) {
    world.database
      .prepare(
        "INSERT INTO plugin_runner_installation_mutation_scopes (installation_id, mutation_scope, state, updated_at) VALUES (?, 'account.metadata.write', 'enabled', 12)"
      )
      .run(created.installationId);
  }
  if (options.enabled) {
    await world.installations.configure({
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
    });
  }
  return created.installationId;
}

export function configuration(
  over: Partial<PortableDynamicPluginConfiguration> = {}
): PortableDynamicPluginConfiguration {
  return {
    tenantId: 'tenant-a',
    sourceInstallationId: 'source-installation',
    pluginId: 'plugin-a',
    versionDigest: VERSION_1,
    contractVersion: 1,
    enabled: false,
    credentials: {},
    resources: [],
    mutationScopes: [],
    ...over,
  };
}

export function restoreOperationId(
  operationId: string,
  tenantId = 'tenant-a',
  pluginId = 'plugin-a',
  versionDigest = VERSION_1
): string {
  return `backup-plugin-${createHash('sha256')
    .update(JSON.stringify([operationId, tenantId, pluginId, versionDigest]))
    .digest('hex')}`;
}
