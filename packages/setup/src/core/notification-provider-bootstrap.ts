import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveNotificationInstallationId } from '@authrim/ar-lib-core/services/notification-installation-id';
import { PLATFORM_NOTIFICATION_NAMESPACE } from '@authrim/ar-lib-core/services/notification-intent-routing';
import type { AuthrimConfig } from './config.js';
import type { AuthrimLock } from './lock.js';
import { executeD1Command, putKVKeyByNamespaceId, queryD1Rows } from './cloudflare.js';

const RESEND_PLUGIN_ID = 'notifier-resend';
const CLOUDFLARE_PLUGIN_ID = 'notifier-cloudflare';
const RESEND_API_HOST = 'api.resend.com';
const PLUGIN_ENCRYPTION_SALT = 'authrim-plugin-config-v1';
type PluginCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

interface RouteReflectionRow extends Record<string, unknown> {
  tenant_id: string;
  channel: string;
  config_version: number | string;
  state: string;
  last_operation_id: string;
  order_fingerprint: string;
  installation_ids_json: string;
}

interface InstallationReflectionRow extends Record<string, unknown> {
  installation_id: string;
  tenant_id: string;
  plugin_id: string;
  backend_kind: string;
  script_name: string | null;
  state: string;
  config_version: number | string;
  credential_count: number | string;
}

export interface InitialNotificationProviderBootstrapResult {
  providerId: string | null;
  namespaces: string[];
}

export interface InitialNotificationProviderBootstrapInput {
  environmentId: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
  keysDir: string;
  now?: number;
  execute?: typeof executeD1Command;
  query?: typeof queryD1Rows;
  putKv?: typeof putKVKeyByNamespaceId;
}

function sqlText(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function derivePluginEncryptionKey(secret: string): Promise<PluginCryptoKey> {
  if (secret.length < 32) throw new Error('notification_provider_bootstrap_encryption_key_invalid');
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode(PLUGIN_ENCRYPTION_SALT),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
}

async function encryptPluginValue(
  value: string,
  key: PluginCryptoKey,
  additionalData?: Uint8Array
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, ...(additionalData ? { additionalData } : {}) },
    key,
    new TextEncoder().encode(value)
  );
  const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
  return `enc:v1:${base64(iv)}:${base64(new Uint8Array(ciphertext))}`;
}

function providerId(config: AuthrimConfig): string | null {
  switch (config.features.email.provider) {
    case 'none':
      return null;
    case 'cloudflare':
      return CLOUDFLARE_PLUGIN_ID;
    case 'resend':
      return RESEND_PLUGIN_ID;
    default:
      throw new Error('notification_provider_bootstrap_provider_unsupported');
  }
}

async function operationId(environmentId: string, namespaceId: string): Promise<string> {
  const digest = await sha256(
    JSON.stringify(['authrim-notification-order-bootstrap-v1', environmentId, namespaceId, 'email'])
  );
  return `notification-order-bootstrap-v1-${digest}`;
}

async function orderFingerprint(namespaceId: string, installationIds: string[]): Promise<string> {
  return sha256(
    JSON.stringify([
      'authrim-notification-provider-order-v1',
      namespaceId,
      'email',
      installationIds,
    ])
  );
}

async function resendCredentialSql(input: {
  namespaceId: string;
  installationId: string;
  operationId: string;
  apiKey: string;
  encryptionSecret: string;
  mutationHmacKey: string;
  now: number;
}): Promise<string> {
  const configVersion = 2;
  const credential = {
    configKey: 'apiKey',
    destinationHost: RESEND_API_HOST,
    injectionKind: 'bearer' as const,
    injectionName: 'Authorization',
    value: input.apiKey,
  };
  const canonical = JSON.stringify({
    operationId: input.operationId,
    tenantId: input.namespaceId,
    installationId: input.installationId,
    expectedConfigVersion: 1,
    credentials: [credential],
  });
  const requestFingerprint = await hmacHex(input.mutationHmacKey, canonical);
  const key = await derivePluginEncryptionKey(input.encryptionSecret);
  const encryptedValue = await encryptPluginValue(
    input.apiKey,
    key,
    new TextEncoder().encode(
      JSON.stringify([input.namespaceId, RESEND_PLUGIN_ID, 'apiKey', configVersion])
    )
  );
  const parts = encryptedValue.split(':');
  if (parts.length !== 4 || !parts[2]) {
    throw new Error('notification_provider_bootstrap_envelope_invalid');
  }
  const nonceFingerprint = await hmacHex(input.encryptionSecret, `v1:${parts[2]}`);
  return `
INSERT INTO plugin_runner_egress_allowed_hosts (
  plugin_id, rule_id, match_kind, host_pattern, created_at
) VALUES (
  ${sqlText(RESEND_PLUGIN_ID)}, 'resend-api', 'exact', ${sqlText(RESEND_API_HOST)}, ${input.now}
) ON CONFLICT(plugin_id, rule_id) DO NOTHING;
INSERT INTO plugin_runner_config_mutations (
  operation_id, installation_id, tenant_id, request_fingerprint, fingerprint_key_id,
  target_config_version, state, created_at, applied_at, updated_at
) VALUES (
  ${sqlText(input.operationId)}, ${sqlText(input.installationId)},
  ${sqlText(input.namespaceId)}, ${sqlText(requestFingerprint)}, 'mutation-v1',
  ${configVersion}, 'applied', ${input.now}, ${input.now}, ${input.now}
) ON CONFLICT(operation_id) DO NOTHING;
INSERT INTO plugin_runner_encrypted_configs (
  installation_id, config_key, config_version, injection_kind, injection_name,
  destination_host, encryption_key_id, encrypted_value, nonce_fingerprint,
  reencrypt_state, created_at, updated_at
) VALUES (
  ${sqlText(input.installationId)}, 'apiKey', ${configVersion}, 'bearer', 'Authorization',
  ${sqlText(RESEND_API_HOST)}, 'v1', ${sqlText(encryptedValue)},
  ${sqlText(nonceFingerprint)}, 'current', ${input.now}, ${input.now}
) ON CONFLICT(installation_id, config_key, config_version) DO NOTHING;`;
}

async function namespaceSql(input: {
  environmentId: string;
  namespaceId: string;
  providerId: string | null;
  apiKey?: string;
  encryptionSecret?: string;
  mutationHmacKey?: string;
  now: number;
}): Promise<{
  sql: string;
  operationId: string;
  orderFingerprint: string;
  installationIds: string[];
}> {
  const routeOperationId = await operationId(input.environmentId, input.namespaceId);
  const installationIds = input.providerId
    ? [
        await deriveNotificationInstallationId({
          environmentId: input.environmentId,
          tenantId: input.namespaceId,
          pluginId: input.providerId,
          purpose: 'email-provider',
        }),
      ]
    : [];
  const fingerprint = await orderFingerprint(input.namespaceId, installationIds);
  const installationId = installationIds[0];
  const configVersion = input.providerId === RESEND_PLUGIN_ID ? 2 : 1;
  let sql = '';
  if (input.providerId && installationId) {
    sql += `
INSERT INTO plugin_runner_installations (
  installation_id, tenant_id, plugin_id, backend_kind, script_name, state, config_version,
  platform_concurrency_cap, platform_rate_per_minute, created_at, updated_at
) VALUES (
  ${sqlText(installationId)}, ${sqlText(input.namespaceId)}, ${sqlText(input.providerId)},
  'in_process', NULL, 'enabled', ${configVersion}, 8, 120, ${input.now}, ${input.now}
) ON CONFLICT(installation_id) DO NOTHING;
INSERT INTO plugin_runner_hook_policies (
  plugin_id, capability, timeout_ms, failure_policy, max_attempts,
  async_retry_budget_seconds, circuit_breaker_threshold,
  circuit_breaker_cooldown_seconds, updated_at
) VALUES (
  ${sqlText(input.providerId)}, 'notifier.send', 30000, 'retry_async', 12,
  604800, 5, 60, ${input.now}
) ON CONFLICT(plugin_id, capability) DO NOTHING;`;
    if (input.providerId === RESEND_PLUGIN_ID) {
      if (!input.apiKey || !input.encryptionSecret || !input.mutationHmacKey) {
        throw new Error('notification_provider_bootstrap_resend_secret_missing');
      }
      sql += await resendCredentialSql({
        namespaceId: input.namespaceId,
        installationId,
        operationId: `notification-credentials-bootstrap-v1-${await sha256(
          `${input.environmentId}\0${input.namespaceId}\0${installationId}`
        )}`,
        apiKey: input.apiKey,
        encryptionSecret: input.encryptionSecret,
        mutationHmacKey: input.mutationHmacKey,
        now: input.now,
      });
    }
  }
  sql += `
INSERT INTO plugin_runner_notification_route_sets (
  tenant_id, channel, config_version, state, last_operation_id,
  order_fingerprint, created_at, updated_at
) VALUES (
  ${sqlText(input.namespaceId)}, 'email', 1,
  ${sqlText(installationIds.length > 0 ? 'enabled' : 'disabled')},
  ${sqlText(routeOperationId)}, ${sqlText(fingerprint)}, ${input.now}, ${input.now}
) ON CONFLICT(tenant_id, channel) DO NOTHING;`;
  if (installationId) {
    sql += `
INSERT INTO plugin_runner_notification_route_entries (
  tenant_id, channel, config_version, priority, installation_id, created_at
) VALUES (
  ${sqlText(input.namespaceId)}, 'email', 1, 0, ${sqlText(installationId)}, ${input.now}
) ON CONFLICT(tenant_id, channel, priority) DO NOTHING;`;
  }
  return {
    sql,
    operationId: routeOperationId,
    orderFingerprint: fingerprint,
    installationIds,
  };
}

async function reflectNamespace(input: {
  databaseName: string;
  namespaceId: string;
  providerId: string | null;
  operationId: string;
  orderFingerprint: string;
  installationIds: string[];
  query: typeof queryD1Rows;
}): Promise<void> {
  const routes = await input.query<RouteReflectionRow>(
    input.databaseName,
    `SELECT route.tenant_id, route.channel, route.config_version, route.state,
            route.last_operation_id, route.order_fingerprint,
            COALESCE((
              SELECT json_group_array(installation_id)
                FROM (
                  SELECT installation_id
                    FROM plugin_runner_notification_route_entries entry
                   WHERE entry.tenant_id = route.tenant_id AND entry.channel = route.channel
                   ORDER BY priority
                )
            ), '[]') AS installation_ids_json
       FROM plugin_runner_notification_route_sets route
      WHERE route.tenant_id = ${sqlText(input.namespaceId)} AND route.channel = 'email'`
  );
  const route = routes[0];
  if (
    routes.length !== 1 ||
    !route ||
    route.tenant_id !== input.namespaceId ||
    route.channel !== 'email' ||
    Number(route.config_version) !== 1 ||
    route.state !== (input.installationIds.length > 0 ? 'enabled' : 'disabled') ||
    route.last_operation_id !== input.operationId ||
    route.order_fingerprint !== input.orderFingerprint ||
    route.installation_ids_json !== JSON.stringify(input.installationIds)
  ) {
    throw new Error('notification_provider_bootstrap_route_reflection_invalid');
  }
  const installationId = input.installationIds[0];
  if (!input.providerId || !installationId) return;
  const installations = await input.query<InstallationReflectionRow>(
    input.databaseName,
    `SELECT installation.installation_id, installation.tenant_id, installation.plugin_id,
            installation.backend_kind, installation.script_name, installation.state,
            installation.config_version,
            (SELECT COUNT(*) FROM plugin_runner_encrypted_configs config
              WHERE config.installation_id = installation.installation_id
                AND config.config_version = installation.config_version) AS credential_count
       FROM plugin_runner_installations installation
      WHERE installation.installation_id = ${sqlText(installationId)}`
  );
  const installation = installations[0];
  if (
    installations.length !== 1 ||
    !installation ||
    installation.tenant_id !== input.namespaceId ||
    installation.plugin_id !== input.providerId ||
    installation.backend_kind !== 'in_process' ||
    installation.script_name !== null ||
    installation.state !== 'enabled' ||
    Number(installation.config_version) !== (input.providerId === RESEND_PLUGIN_ID ? 2 : 1) ||
    Number(installation.credential_count) !== (input.providerId === RESEND_PLUGIN_ID ? 1 : 0)
  ) {
    throw new Error('notification_provider_bootstrap_installation_reflection_invalid');
  }
}

export async function ensureInitialNotificationProviderConfiguration(
  input: InitialNotificationProviderBootstrapInput
): Promise<InitialNotificationProviderBootstrapResult> {
  const databaseIdentifier = input.lock.d1.PLUGIN_RUNNER_DB?.id?.trim();
  const authrimConfigNamespaceId = input.lock.kv.AUTHRIM_CONFIG?.id;
  const settingsNamespaceId = input.lock.kv.SETTINGS?.id;
  if (!databaseIdentifier) {
    throw new Error('notification_provider_bootstrap_database_id_missing');
  }
  if (!authrimConfigNamespaceId || !settingsNamespaceId) {
    throw new Error('notification_provider_bootstrap_kv_missing');
  }
  const initialTenantId = input.config.tenant.name;
  if (!initialTenantId || initialTenantId === PLATFORM_NOTIFICATION_NAMESPACE) {
    throw new Error('notification_provider_bootstrap_tenant_invalid');
  }
  const selectedProviderId = providerId(input.config);
  const fromAddress = input.config.features.email.fromAddress?.trim();
  if (selectedProviderId && !fromAddress) {
    throw new Error('notification_provider_bootstrap_from_address_missing');
  }
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new Error('notification_provider_bootstrap_now_invalid');
  }
  const execute = input.execute ?? executeD1Command;
  const query = input.query ?? queryD1Rows;
  const putKv = input.putKv ?? putKVKeyByNamespaceId;
  let apiKey: string | undefined;
  let encryptionSecret: string | undefined;
  let mutationHmacKey: string | undefined;
  if (selectedProviderId === RESEND_PLUGIN_ID) {
    [apiKey, encryptionSecret, mutationHmacKey] = await Promise.all([
      readFile(join(input.keysDir, 'resend_api_key.txt'), 'utf8').then((value) => value.trim()),
      readFile(join(input.keysDir, 'plugin_encryption_key.txt'), 'utf8').then((value) =>
        value.trim()
      ),
      readFile(join(input.keysDir, 'plugin_mutation_hmac_key.txt'), 'utf8').then((value) =>
        value.trim()
      ),
    ]);
    if (!apiKey || !encryptionSecret || !mutationHmacKey) {
      throw new Error('notification_provider_bootstrap_resend_secret_missing');
    }
  }

  const namespaces = [PLATFORM_NOTIFICATION_NAMESPACE, initialTenantId];
  for (const namespaceId of namespaces) {
    const plan = await namespaceSql({
      environmentId: input.environmentId,
      namespaceId,
      providerId: selectedProviderId,
      apiKey,
      encryptionSecret,
      mutationHmacKey,
      now,
    });
    await execute(databaseIdentifier, plan.sql);
    await reflectNamespace({
      databaseName: databaseIdentifier,
      namespaceId,
      providerId: selectedProviderId,
      operationId: plan.operationId,
      orderFingerprint: plan.orderFingerprint,
      installationIds: plan.installationIds,
      query,
    });
  }

  const providerOrder = selectedProviderId ? [selectedProviderId] : [];
  await putKv(
    authrimConfigNamespaceId,
    `settings:tenant:${initialTenantId}:email-settings`,
    JSON.stringify({ strategy: 'priority_failover', providerOrder })
  );
  if (selectedProviderId) {
    const pluginConfig: Record<string, unknown> = {
      defaultFrom: fromAddress,
      ...(input.config.features.email.fromName
        ? { fromName: input.config.features.email.fromName }
        : {}),
    };
    if (selectedProviderId === RESEND_PLUGIN_ID) {
      const key = await derivePluginEncryptionKey(encryptionSecret!);
      Object.assign(pluginConfig, {
        _encrypted: ['apiKey'],
        apiKey: await encryptPluginValue(apiKey!, key),
      });
    }
    await putKv(
      settingsNamespaceId,
      `plugins:config:${selectedProviderId}`,
      JSON.stringify(pluginConfig)
    );
    await putKv(settingsNamespaceId, `plugins:enabled:${selectedProviderId}`, 'true');
  }
  return { providerId: selectedProviderId, namespaces };
}
