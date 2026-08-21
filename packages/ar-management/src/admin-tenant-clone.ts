import type { Context } from 'hono';
import { z } from 'zod';
import type { ControlTenantDefaultRouteAllocation, Env } from '@authrim/ar-lib-core';
import {
  ALL_CATEGORY_META,
  ADMIN_PERMISSIONS,
  CATEGORY_SCOPE_CONFIG,
  AR_ERROR_CODES,
  buildContractKey,
  createAuditLog,
  createAuditLogFromContext,
  createAuthContextFromHono,
  createErrorResponse,
  getLogger,
  requireAdminDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import { requirePlatformTenantManagementAuthority } from './admin-tenant-access';
import {
  createSingleTenantMutationError,
  ensureSupportedTenantId,
  isSingleTenantMode,
} from './single-tenant-guard';
import type { TenantProvisioningOperationView } from './tenant-provisioning-operation';
import {
  ensureActiveTenantDiscoveryAliasDirectory,
  resolveTenantDiscoveryAliasDirectoryInput,
} from './tenant-alias-directory';

const TENANT_ID_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// Keep synchronous clone work below the lowest Workers/D1 invocation budgets. Larger copies must
// be split by category instead of creating a partially cloned tenant.
const MAX_SYNCHRONOUS_CLONE_DATABASE_QUERIES = 40;
const MAX_SYNCHRONOUS_CLONE_KV_KEYS = 10;
const MAX_SYNCHRONOUS_CLONE_KV_VALUE_BYTES = 256 * 1024;
const MAX_REGISTERED_PLUGINS_FOR_CLONE = 128;
const MAX_KV_BULK_READ_KEYS = 50;
const MAX_CONCURRENT_KV_WRITES = 6;

const CloneOptionsSchema = z
  .object({
    settings: z.boolean().default(true),
    secret_settings: z.boolean().default(false),
    clients: z.boolean().default(false),
    client_credentials: z.boolean().default(false),
    roles: z.boolean().default(true),
    admin_access: z.boolean().default(false),
    webhooks: z.boolean().default(false),
    webhook_secrets: z.boolean().default(false),
  })
  .strict();

const CloneSourceSnapshotSchema = z
  .object({
    tenant_updated_at: z.number().int().nonnegative(),
    database_version: z.string().regex(/^[a-f0-9]{64}$/),
    kv_version: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const TenantCloneRequestSchema = z
  .object({
    id: z.string().min(1).max(63).regex(TENANT_ID_REGEX),
    tenant_code: z.string().min(1).max(63).regex(TENANT_ID_REGEX).optional(),
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    isolation_policy: z.enum(['shared_pool', 'tenant_exclusive']).default('tenant_exclusive'),
    copy: CloneOptionsSchema.optional(),
    // Legacy flags remain accepted for existing API callers.
    include_clients: z.boolean().optional(),
    include_roles: z.boolean().optional(),
    include_webhooks: z.boolean().optional(),
  })
  .strict();

type CloneOptions = z.infer<typeof CloneOptionsSchema>;

export interface TenantCloneInternalExecution {
  sourceTenantId: string;
  requestBody: z.infer<typeof TenantCloneRequestSchema>;
  sourceAdapter: DatabaseAdapter;
  targetAdapter: DatabaseAdapter;
  adminAdapter: DatabaseAdapter;
  actorId: string;
}

export const OAUTH_CLIENT_CLONE_COLUMNS = [
  'client_id',
  'client_name',
  'description',
  'redirect_uris',
  'grant_types',
  'response_types',
  'scope',
  'logo_uri',
  'client_uri',
  'policy_uri',
  'tos_uri',
  'contacts',
  'subject_type',
  'sector_identifier_uri',
  'token_endpoint_auth_method',
  'tls_client_certificate_bound_access_tokens',
  'token_exchange_allowed',
  'allowed_subject_token_clients',
  'allowed_token_exchange_resources',
  'delegation_mode',
  'client_credentials_allowed',
  'allowed_scopes',
  'default_scope',
  'default_audience',
  'default_resource',
  'is_trusted',
  'skip_consent',
  'allow_claims_without_scope',
  'claims_parameter_policy',
  'identity_mapping',
  'attribute_release_consent',
  'asc_enabled',
  'asc_protected_request_required',
  'asc_sao_enabled',
  'asc_transformed_claims_enabled',
  'asc_allowed_transformed_claims',
  'backchannel_token_delivery_mode',
  'backchannel_client_notification_endpoint',
  'backchannel_authentication_request_signing_alg',
  'backchannel_user_code_parameter',
  'jwks',
  'jwks_uri',
  'token_endpoint_auth_signing_alg',
  'userinfo_signed_response_alg',
  'post_logout_redirect_uris',
  'allowed_redirect_origins',
  'backchannel_logout_uri',
  'backchannel_logout_session_required',
  'frontchannel_logout_uri',
  'frontchannel_logout_session_required',
  'logout_webhook_uri',
  'logout_webhook_secret_encrypted',
  'registration_access_token_hash',
  'initiate_login_uri',
  'login_ui_url',
  'id_token_signed_response_alg',
  'request_object_signing_alg',
  'authorization_signed_response_alg',
  'authorization_encrypted_response_alg',
  'authorization_encrypted_response_enc',
  'client_secret_hash',
  'software_id',
  'software_version',
  'requestable_scopes',
  'require_pkce',
  'application_type',
  'trust_group',
  'trust_group_id',
  'browser_public_client_mode',
  'browser_refresh_token_policy',
  'native_sso_enabled',
  'native_channel_allowed',
  'allowed_channels',
  'device_secret_revoke_enabled',
  'device_secret_revoke_trust_groups',
  'device_secret_introspection_enabled',
  'device_secret_introspection_trust_groups',
] as const;

/**
 * Per-connection Agent Access state is bound to the source tenant, Admin consent, and client
 * lifecycle. It must never be materialized as an ordinary OAuth client in another tenant.
 */
export const OAUTH_CLIENT_NON_CLONE_COLUMNS: ReadonlySet<string> = new Set([
  'agent_access_registration_mode',
  'agent_access_expires_at',
  'agent_access_last_used_at',
  'agent_access_registration_slot',
  'client_metadata_url',
  'client_metadata_hash',
  'client_metadata_fetched_at',
]);

export const CLIENT_CREDENTIAL_COLUMNS: ReadonlySet<string> = new Set([
  'client_secret_hash',
  'registration_access_token_hash',
  'logout_webhook_secret_encrypted',
]);

export const CLIENT_NON_CREDENTIAL_COLUMNS: ReadonlySet<string> = new Set(
  OAUTH_CLIENT_CLONE_COLUMNS.filter((column) => !CLIENT_CREDENTIAL_COLUMNS.has(column))
);

const ADDITIONAL_SAFE_TENANT_SETTINGS_CATEGORIES = new Set([
  'agent-access',
  'certification-profile',
  'directory-connectors',
  'email-settings',
  'saml',
  'step-up',
]);
const CONFIDENTIAL_SETTINGS_CATEGORIES = new Set([
  'credentials',
  'dr-backup',
  'encryption',
  'external-idp',
  'federation',
  'plugin',
]);

type SettingsClassification = 'safe' | 'secret' | 'unclassified';
interface KvCloneBudget {
  remaining: number;
}

interface KvRollbackEntry {
  kv: KVNamespace;
  key: string;
  previousValue: string | null;
}

interface SettingsCopyContext {
  targetTenantId: string;
  targetTenantName: string;
  includeClients: boolean;
}

function consumeKvCloneBudget(budget: KvCloneBudget, count = 1): void {
  budget.remaining -= count;
  if (budget.remaining < 0) throw new Error('tenant_clone_kv_budget_exceeded');
}

async function putTrackedKv(
  kv: KVNamespace,
  key: string,
  value: string,
  rollbackEntries: KvRollbackEntry[],
  options?: KVNamespacePutOptions
): Promise<void> {
  const previousValue = await kv.get(key);
  await kv.put(key, value, options);
  rollbackEntries.push({ kv, key, previousValue });
}

async function rollbackKvWrites(entries: KvRollbackEntry[]): Promise<boolean> {
  let succeeded = true;
  for (const { kv, key, previousValue } of [...entries].reverse()) {
    try {
      if (previousValue === null) await kv.delete(key);
      else await kv.put(key, previousValue);
    } catch {
      succeeded = false;
    }
  }
  return succeeded;
}

function assertCloneKvValueSize(value: string): string;
function assertCloneKvValueSize(value: null): null;
function assertCloneKvValueSize(value: string | null): string | null;
function assertCloneKvValueSize(value: string | null): string | null {
  if (
    value !== null &&
    new TextEncoder().encode(value).byteLength > MAX_SYNCHRONOUS_CLONE_KV_VALUE_BYTES
  ) {
    throw new Error('tenant_clone_kv_value_too_large');
  }
  return value;
}

async function readKvTextValues(
  kv: KVNamespace,
  keys: string[]
): Promise<Map<string, string | null>> {
  const values = new Map<string, string | null>();
  for (let offset = 0; offset < keys.length; offset += MAX_KV_BULK_READ_KEYS) {
    const batch = keys.slice(offset, offset + MAX_KV_BULK_READ_KEYS);
    const result = await kv.get(batch);
    for (const key of batch) {
      values.set(key, assertCloneKvValueSize(result.get(key) ?? null));
    }
  }
  return values;
}

export function classifySettingsKey(key: string, prefix: string): SettingsClassification {
  const category = key.slice(prefix.length).toLowerCase();
  if (
    category === 'directory-connector-secret' ||
    category.startsWith('directory-connector-secret:')
  ) {
    return 'secret';
  }
  if (CONFIDENTIAL_SETTINGS_CATEGORIES.has(category)) return 'secret';
  if (ADDITIONAL_SAFE_TENANT_SETTINGS_CATEGORIES.has(category)) return 'safe';
  if (Object.hasOwn(ALL_CATEGORY_META, category)) {
    const scope = prefix.startsWith('settings:client:') ? 'client' : 'tenant';
    return CATEGORY_SCOPE_CONFIG[
      category as keyof typeof CATEGORY_SCOPE_CONFIG
    ].allowedScopes.includes(scope)
      ? 'safe'
      : 'unclassified';
  }
  return 'unclassified';
}

function parseSettingsRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Remove source-tenant identity, key, and resource references from otherwise portable settings. */
export function sanitizeCopiedSettingsValue(
  category: string,
  value: string,
  includeSecrets: boolean,
  context: SettingsCopyContext
): string | null {
  const record = parseSettingsRecord(value);
  if (!record) return null;

  if (category === 'directory-connectors' && !includeSecrets) {
    return JSON.stringify({ ...record, enabled: false });
  }

  if (category === 'tenant') {
    for (const key of [
      'tenant.allowed_domains',
      'tenant.allowed_identifiers',
      'tenant.allowed_origins',
      'tenant.audit_profile_id',
      'tenant.base_domain',
      'tenant.residency_profile_id',
    ]) {
      delete record[key];
    }
    record['tenant.default_id'] = context.targetTenantId;
    record['tenant.name'] = context.targetTenantName;
  }

  if (category === 'security') {
    // Redirect trust is an identity boundary, not a portable policy value.
    record['security.trusted_redirect_origins'] = '[]';
  }

  if (category === 'tokens') {
    // The clone receives an isolated KeyManager namespace and a newly generated key.
    record['tokens.access_token_signing_key_id'] = '';
    record['tokens.id_token_signing_key_id'] = '';
    record['tokens.userinfo_signing_key_id'] = '';
  }

  if (category === 'saml') {
    // SAML key references and published certificates are bound to the source KeyManager.
    record.signingKeyPolicies = {};
    record.certificateSubjectAlternativeNames = {
      includeGeneratedDnsNames: true,
      dnsNames: [],
    };
    delete record.updatedAt;
  }

  if (category === 'authentication-methods') {
    const requirementPolicy = record['authentication-methods.totp.requirement_policy'];
    if (typeof requirementPolicy === 'string') {
      const parsedPolicy = parseSettingsRecord(requirementPolicy);
      if (parsedPolicy) {
        parsedPolicy.user_ids = [];
        parsedPolicy.group_ids = [];
        record['authentication-methods.totp.requirement_policy'] = JSON.stringify(parsedPolicy);
      }
    }
    if (!includeSecrets) {
      record['authentication-methods.directory_password.enabled'] = false;
      record['authentication-methods.directory_password.auto_provision'] = false;
      record['authentication-methods.human_verification.login_enabled'] = false;
      record['authentication-methods.human_verification.signup_enabled'] = false;
      record['authentication-methods.human_verification.reauth_enabled'] = false;
    }
  }

  if (category === 'login-entry') {
    const behavior = record['login-entry.post_login_behavior'];
    const redirectUrl = record['login-entry.post_login_redirect_url'];
    const sourceBoundCustomRedirect =
      behavior === 'custom_url' &&
      typeof redirectUrl === 'string' &&
      /^https:\/\//i.test(redirectUrl.trim());
    if (sourceBoundCustomRedirect || (behavior === 'app_login' && !context.includeClients)) {
      record['login-entry.post_login_behavior'] = 'account';
      record['login-entry.post_login_redirect_url'] = '/';
    }
    if (!context.includeClients) {
      record['login-entry.app_login_client_id'] = '';
      record['login-entry.app_login_redirect_uri'] = '';
      record['login-entry.app_login_final_return_to'] = '';
    }
  }

  if (category === 'diagnostic-logging' && !context.includeClients) {
    record['diagnostic-logging.storage_mode.by_client'] = '{}';
  }

  return JSON.stringify(record);
}

function normalizeOptions(input: z.infer<typeof TenantCloneRequestSchema>): CloneOptions {
  const parsed = CloneOptionsSchema.parse(input.copy ?? {});
  return {
    ...parsed,
    clients: input.include_clients ?? parsed.clients,
    roles: input.include_roles ?? parsed.roles,
    webhooks: input.include_webhooks ?? parsed.webhooks,
  };
}

function validateOptionDependencies(options: CloneOptions): string | null {
  if (options.secret_settings && !options.settings) return 'secret_settings requires settings';
  if (options.client_credentials && !options.clients) return 'client_credentials requires clients';
  if (options.webhook_secrets && !options.webhooks) return 'webhook_secrets requires webhooks';
  return null;
}

async function estimateSelectedDatabaseQueries(
  source: DatabaseAdapter,
  admin: DatabaseAdapter | null,
  tenantId: string,
  options: CloneOptions
): Promise<{ estimatedQueries: number; sourceVersion: string }> {
  const counts = await source.queryOne<Record<string, unknown>>(
    `SELECT
       (SELECT COUNT(*) FROM oauth_clients WHERE tenant_id = ?) AS clients,
       (SELECT MAX(updated_at) FROM oauth_clients WHERE tenant_id = ?) AS clients_updated,
       (SELECT COUNT(*) FROM web_origin_registry WHERE tenant_id = ?) AS web_origins,
       (SELECT MAX(updated_at) FROM web_origin_registry WHERE tenant_id = ?) AS web_origins_updated,
       (SELECT COUNT(*) FROM client_trust_policies WHERE tenant_id = ?) AS trust_policies,
       (SELECT MAX(updated_at) FROM client_trust_policies WHERE tenant_id = ?) AS trust_updated,
       (SELECT COUNT(*) FROM client_consent_overrides WHERE tenant_id = ?) AS consent_overrides,
       (SELECT MAX(updated_at) FROM client_consent_overrides WHERE tenant_id = ?) AS consent_updated,
       (SELECT COUNT(*) FROM flow_assignments
         WHERE tenant_id = ? AND target_type = 'oidc_client') AS flow_assignments,
       (SELECT MAX(updated_at) FROM flow_assignments
         WHERE tenant_id = ? AND target_type = 'oidc_client') AS flows_updated,
       (SELECT COUNT(*) FROM roles WHERE tenant_id = ? AND is_system = 0) AS roles,
       (SELECT MAX(updated_at) FROM roles WHERE tenant_id = ? AND is_system = 0) AS roles_updated,
       (SELECT COUNT(*) FROM role_assignment_rules WHERE tenant_id = ?) AS role_rules,
       (SELECT MAX(updated_at) FROM role_assignment_rules WHERE tenant_id = ?) AS rules_updated,
       (SELECT COUNT(*) FROM webhook_configs WHERE tenant_id = ?) AS webhooks,
       (SELECT MAX(updated_at) FROM webhook_configs WHERE tenant_id = ?) AS webhooks_updated`,
    Array.from({ length: 16 }, () => tenantId)
  );
  const count = (field: string) => Number(counts?.[field] ?? 0);
  let total = 0;
  const sourceState: Record<string, unknown> = {};
  if (options.clients) total += count('clients') + count('web_origins') + count('trust_policies');
  if (options.clients) {
    Object.assign(sourceState, {
      clients: count('clients'),
      clients_updated: counts?.clients_updated ?? null,
      web_origins: count('web_origins'),
      web_origins_updated: counts?.web_origins_updated ?? null,
      trust_policies: count('trust_policies'),
      trust_updated: counts?.trust_updated ?? null,
      consent_overrides: count('consent_overrides'),
      consent_updated: counts?.consent_updated ?? null,
      flow_assignments: count('flow_assignments'),
      flows_updated: counts?.flows_updated ?? null,
    });
  }
  // Custom roles and admin roles require a second pass to restore inheritance.
  if (options.roles) total += count('roles') * 2 + count('role_rules');
  if (options.roles) {
    Object.assign(sourceState, {
      roles: count('roles'),
      roles_updated: counts?.roles_updated ?? null,
      role_rules: count('role_rules'),
      rules_updated: counts?.rules_updated ?? null,
    });
  }
  if (options.webhooks) total += count('webhooks');
  if (options.webhooks) {
    Object.assign(sourceState, {
      webhooks: count('webhooks'),
      webhooks_updated: counts?.webhooks_updated ?? null,
    });
  }

  if (options.admin_access && admin) {
    const adminCounts = await admin.queryOne<Record<string, unknown>>(
      `SELECT
         (SELECT COUNT(*) FROM admin_roles WHERE tenant_id = ? AND is_system = 0) AS roles,
         (SELECT MAX(updated_at) FROM admin_roles
           WHERE tenant_id = ? AND is_system = 0) AS roles_updated,
         (SELECT COUNT(*) FROM admin_role_assignments
           WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)) AS assignments,
         (SELECT MAX(created_at) FROM admin_role_assignments
           WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)) AS assignments_updated`,
      [tenantId, tenantId, tenantId, Date.now(), tenantId, Date.now()]
    );
    total += Number(adminCounts?.roles ?? 0) * 2 + Number(adminCounts?.assignments ?? 0);
    Object.assign(sourceState, {
      admin_roles: Number(adminCounts?.roles ?? 0),
      admin_roles_updated: adminCounts?.roles_updated ?? null,
      admin_assignments: Number(adminCounts?.assignments ?? 0),
      admin_assignments_updated: adminCounts?.assignments_updated ?? null,
    });
  }
  // Provisioning, source reads, activation, and the two-phase audit trail consume a fixed budget.
  return { estimatedQueries: total + 15, sourceVersion: JSON.stringify(sourceState) };
}

async function countKvKeys(kv: KVNamespace | undefined, prefix: string): Promise<number> {
  if (!kv) return 0;
  let cursor: string | undefined;
  let total = 0;
  do {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    total += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return total;
}

interface TenantPluginSettingEntry {
  sourceKey: string;
  targetKey: string;
  value: string;
  kind: 'config' | 'enabled';
}

async function readTenantPluginSettings(
  kv: KVNamespace | undefined,
  sourceTenantId: string,
  targetTenantId: string
): Promise<TenantPluginSettingEntry[]> {
  if (!kv) return [];
  const registryRaw = assertCloneKvValueSize(await kv.get('plugins:registry'));
  if (!registryRaw) return [];
  const registry = parseSettingsRecord(registryRaw);
  if (!registry) throw new Error('tenant_clone_plugin_registry_invalid');
  const pluginIds = Object.keys(registry)
    .filter((pluginId) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pluginId))
    .sort();
  if (pluginIds.length > MAX_REGISTERED_PLUGINS_FOR_CLONE) {
    throw new Error('tenant_clone_plugin_registry_too_large');
  }
  const candidates = pluginIds.flatMap((pluginId) =>
    (
      [
        ['config', `plugins:config:${pluginId}:tenant:`],
        ['enabled', `plugins:enabled:${pluginId}:tenant:`],
      ] as const
    ).map(([kind, prefix]) => ({
      kind,
      sourceKey: `${prefix}${sourceTenantId}`,
      targetKey: `${prefix}${targetTenantId}`,
    }))
  );
  const values = await readKvTextValues(
    kv,
    candidates.map(({ sourceKey }) => sourceKey)
  );
  const entries: TenantPluginSettingEntry[] = [];
  for (const candidate of candidates) {
    const value = values.get(candidate.sourceKey) ?? null;
    if (value === null) continue;
    entries.push({ ...candidate, value });
  }
  return entries.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}

async function copyTenantPluginSettings(
  kv: KVNamespace | undefined,
  includeSecrets: boolean,
  entries: TenantPluginSettingEntry[],
  writtenKvKeys: KvRollbackEntry[],
  budget: KvCloneBudget
): Promise<{ copied: number; skippedSecrets: number; skippedUnclassified: number }> {
  if (!kv) return { copied: 0, skippedSecrets: 0, skippedUnclassified: 0 };
  consumeKvCloneBudget(budget, entries.length);
  if (!includeSecrets) {
    return { copied: 0, skippedSecrets: entries.length, skippedUnclassified: 0 };
  }

  let copied = 0;
  let skippedUnclassified = 0;
  for (const entry of entries) {
    const valid =
      entry.kind === 'enabled'
        ? entry.value === 'true' || entry.value === 'false'
        : parseSettingsRecord(entry.value) !== null;
    if (!valid) {
      skippedUnclassified += 1;
      continue;
    }
    await putTrackedKv(kv, entry.targetKey, entry.value, writtenKvKeys);
    copied += 1;
  }
  return { copied, skippedSecrets: 0, skippedUnclassified };
}

async function captureKvPrefixState(
  kv: KVNamespace | undefined,
  prefix: string,
  budget: KvCloneBudget
): Promise<Array<[string, string | null]>> {
  if (!kv) return [];
  let cursor: string | undefined;
  const names: string[] = [];
  do {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    names.push(...page.keys.map((key) => key.name));
    consumeKvCloneBudget(budget, page.keys.length);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  names.sort();
  const values = await readKvTextValues(kv, names);
  return names.map((name) => [name, values.get(name) ?? null]);
}

async function captureSourceKvVersion(
  env: Env,
  tenantId: string,
  options: CloneOptions,
  knownPluginSettings?: TenantPluginSettingEntry[]
): Promise<string> {
  const state: Record<string, unknown> = {};
  const budget: KvCloneBudget = { remaining: MAX_SYNCHRONOUS_CLONE_KV_KEYS };
  if (options.settings) {
    state.tenantSettings = await captureKvPrefixState(
      env.SETTINGS,
      `settings:tenant:${tenantId}:`,
      budget
    );
    state.tenantConfigSettings = await captureKvPrefixState(
      env.AUTHRIM_CONFIG,
      `settings:tenant:${tenantId}:`,
      budget
    );
    const pluginSettings =
      knownPluginSettings ?? (await readTenantPluginSettings(env.SETTINGS, tenantId, tenantId));
    consumeKvCloneBudget(budget, pluginSettings.length);
    state.tenantPluginSettings = pluginSettings.map(({ sourceKey, value }) => [sourceKey, value]);
    consumeKvCloneBudget(budget);
    state.tenantContract = assertCloneKvValueSize(
      (await env.AUTHRIM_CONFIG?.get(buildContractKey(env, 'tenant', tenantId))) ?? null
    );
  }
  if (options.clients) {
    state.clientSettings = await captureKvPrefixState(
      env.SETTINGS,
      `settings:client:${tenantId}:`,
      budget
    );
    state.clientContracts = await captureKvPrefixState(
      env.AUTHRIM_CONFIG,
      `${env.ENVIRONMENT || 'dev'}:contract:client:${tenantId}:`,
      budget
    );
  }
  return sha256Hex(JSON.stringify(state));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deleteKvPrefix(kv: KVNamespace | undefined, prefix: string): Promise<void> {
  if (!kv) return;
  let cursor: string | undefined;
  const names: string[] = [];
  do {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    names.push(...page.keys.map(({ name }) => name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  for (let offset = 0; offset < names.length; offset += 25) {
    await Promise.all(names.slice(offset, offset + 25).map((name) => kv.delete(name)));
  }
}

export async function cleanupTenantCloneKvArtifacts(env: Env, tenantId: string): Promise<void> {
  const registryRaw = assertCloneKvValueSize((await env.SETTINGS?.get('plugins:registry')) ?? null);
  const registry = registryRaw ? parseSettingsRecord(registryRaw) : {};
  if (!registry) throw new Error('tenant_provisioning_clone_cleanup_failed');
  const pluginIds = Object.keys(registry).filter((pluginId) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pluginId)
  );
  if (pluginIds.length > MAX_REGISTERED_PLUGINS_FOR_CLONE) {
    throw new Error('tenant_provisioning_clone_cleanup_failed');
  }
  const results = await Promise.allSettled([
    deleteKvPrefix(env.SETTINGS, `settings:tenant:${tenantId}:`),
    deleteKvPrefix(env.SETTINGS, `settings:client:${tenantId}:`),
    deleteKvPrefix(env.AUTHRIM_CONFIG, `settings:tenant:${tenantId}:`),
    deleteKvPrefix(env.AUTHRIM_CONFIG, `${env.ENVIRONMENT || 'dev'}:contract:client:${tenantId}:`),
    env.AUTHRIM_CONFIG?.delete(buildContractKey(env, 'tenant', tenantId)),
    ...pluginIds.flatMap((pluginId) => [
      env.SETTINGS?.delete(`plugins:config:${pluginId}:tenant:${tenantId}`),
      env.SETTINGS?.delete(`plugins:enabled:${pluginId}:tenant:${tenantId}`),
    ]),
  ]);
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error('tenant_provisioning_clone_cleanup_failed');
  }
}

async function copyKvPrefix(
  kv: KVNamespace | undefined,
  sourcePrefix: string,
  targetPrefix: string,
  includeSecrets: boolean,
  writtenKvKeys: KvRollbackEntry[],
  budget: KvCloneBudget,
  context: SettingsCopyContext,
  excludedCategories: ReadonlySet<string> = new Set()
): Promise<{ copied: number; skippedSecrets: number; skippedUnclassified: number }> {
  if (!kv) return { copied: 0, skippedSecrets: 0, skippedUnclassified: 0 };
  let cursor: string | undefined;
  let copied = 0;
  let skippedSecrets = 0;
  let skippedUnclassified = 0;
  do {
    const page = await kv.list({ prefix: sourcePrefix, cursor, limit: 1000 });
    for (let offset = 0; offset < page.keys.length; offset += MAX_CONCURRENT_KV_WRITES) {
      const batch = page.keys.slice(offset, offset + MAX_CONCURRENT_KV_WRITES);
      await Promise.all(
        batch.map(async (key) => {
          const category = key.name.slice(sourcePrefix.length).toLowerCase();
          if (excludedCategories.has(category)) return;
          consumeKvCloneBudget(budget);
          const classification = classifySettingsKey(key.name, sourcePrefix);
          if (classification === 'unclassified') {
            skippedUnclassified += 1;
            return;
          }
          if (!includeSecrets && classification === 'secret') {
            skippedSecrets += 1;
            return;
          }
          const value = assertCloneKvValueSize(await kv.get(key.name));
          if (value === null) return;
          const copiedValue = sanitizeCopiedSettingsValue(category, value, includeSecrets, context);
          if (copiedValue === null) {
            skippedUnclassified += 1;
            return;
          }
          const targetKey = `${targetPrefix}${key.name.slice(sourcePrefix.length)}`;
          await putTrackedKv(
            kv,
            targetKey,
            copiedValue,
            writtenKvKeys,
            key.metadata ? { metadata: key.metadata } : undefined
          );
          copied += 1;
        })
      );
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { copied, skippedSecrets, skippedUnclassified };
}

function remapJsonReferences(value: unknown, idMap: Map<string, string>): string | null {
  if (typeof value !== 'string') return null;
  try {
    const remap = (node: unknown): unknown => {
      if (typeof node === 'string') return idMap.get(node) ?? node;
      if (Array.isArray(node)) return node.map(remap);
      if (node && typeof node === 'object') {
        return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, remap(child)]));
      }
      return node;
    };
    return JSON.stringify(remap(JSON.parse(value) as unknown));
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function containsUncopiedScopeReference(serialized: string): boolean {
  const visit = (node: unknown, key = ''): boolean => {
    const normalizedKey = key.toLowerCase().replaceAll('_', '');
    const hasValue = node !== null && node !== undefined && node !== '';
    if (
      hasValue &&
      ['orgid', 'organizationid', 'resourceid', 'scopetarget', 'tenantid'].includes(normalizedKey)
    ) {
      return true;
    }
    if (normalizedKey === 'scopetype' && node !== 'global') return true;
    if (Array.isArray(node)) return node.some((child) => visit(child, key));
    if (!node || typeof node !== 'object') return false;
    const record = node as Record<string, unknown>;
    if (typeof record.type === 'string' && record.type.toLowerCase() === 'join_org') return true;
    return Object.entries(record).some(([childKey, child]) => visit(child, childKey));
  };
  return visit(JSON.parse(serialized) as unknown);
}

export function sanitizeClientJwks(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as { keys?: unknown[] };
    if (!Array.isArray(parsed.keys)) return null;
    const privateMembers = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);
    const keys = parsed.keys
      .filter(
        (key): key is Record<string, unknown> =>
          Boolean(key) && typeof key === 'object' && !Array.isArray(key)
      )
      .filter((key) => key.kty !== 'oct')
      .map((key) =>
        Object.fromEntries(Object.entries(key).filter(([member]) => !privateMembers.has(member)))
      );
    return JSON.stringify({ ...parsed, keys });
  } catch {
    return null;
  }
}

function sanitizeContractKeyMaterial(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeContractKeyMaterial).filter((entry) => entry !== null);
  }
  if (!node || typeof node !== 'object') return node;
  const object = node as Record<string, unknown>;
  if (typeof object.kty === 'string') {
    if (object.kty === 'oct') return null;
    const privateMembers = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);
    return Object.fromEntries(
      Object.entries(object)
        .filter(([member]) => !privateMembers.has(member))
        .map(([member, value]) => [member, sanitizeContractKeyMaterial(value)])
    );
  }
  return Object.fromEntries(
    Object.entries(object).map(([member, value]) => [member, sanitizeContractKeyMaterial(value)])
  );
}

async function cloneClients(
  source: DatabaseAdapter,
  target: DatabaseAdapter,
  sourceTenantId: string,
  targetTenantId: string,
  includeCredentials: boolean,
  now: number
): Promise<{ clients: number; clientIds: Set<string>; webOrigins: number; trustPolicies: number }> {
  const selectedColumns = OAUTH_CLIENT_CLONE_COLUMNS.map((column) =>
    !includeCredentials && CLIENT_CREDENTIAL_COLUMNS.has(column) ? `NULL AS ${column}` : column
  );
  const clients = await source.query<Record<string, unknown>>(
    `SELECT ${selectedColumns.join(', ')} FROM oauth_clients
      WHERE tenant_id = ? AND agent_access_registration_mode IS NULL`,
    [sourceTenantId]
  );
  const clientIds = new Set(clients.map((client) => String(client.client_id)));
  const columns = ['tenant_id', ...OAUTH_CLIENT_CLONE_COLUMNS, 'created_at', 'updated_at'];
  const placeholders = columns.map(() => '?').join(', ');
  for (const client of clients) {
    await target.execute(
      `INSERT INTO oauth_clients (${columns.join(', ')}) VALUES (${placeholders})`,
      [
        targetTenantId,
        ...OAUTH_CLIENT_CLONE_COLUMNS.map((column) => {
          if (!includeCredentials && CLIENT_CREDENTIAL_COLUMNS.has(column)) return null;
          if (column === 'jwks') return sanitizeClientJwks(client[column]);
          return client[column];
        }),
        now,
        now,
      ]
    );
  }

  const webOrigins = await source.query<Record<string, unknown>>(
    `SELECT client_id, origin, cors_allowed, csp_frame_ancestors, handoff_allowed,
            iframe_allowed, environment, is_active
       FROM web_origin_registry WHERE tenant_id = ?`,
    [sourceTenantId]
  );
  let copiedWebOrigins = 0;
  for (const origin of webOrigins) {
    if (!clientIds.has(String(origin.client_id))) continue;
    await target.execute(
      `INSERT INTO web_origin_registry (
         id, tenant_id, client_id, origin, cors_allowed, csp_frame_ancestors, handoff_allowed,
         iframe_allowed, environment, is_active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        targetTenantId,
        origin.client_id,
        origin.origin,
        origin.cors_allowed,
        origin.csp_frame_ancestors,
        origin.handoff_allowed,
        origin.iframe_allowed,
        origin.environment,
        origin.is_active,
        now,
        now,
      ]
    );
    copiedWebOrigins += 1;
  }

  const trustPolicies = await source.query<Record<string, unknown>>(
    `SELECT name, display_name, description, target_id, first_party, trusted,
            skip_authorization_consent, is_active
       FROM client_trust_policies
      WHERE tenant_id = ? AND target_type = 'oidc_client'`,
    [sourceTenantId]
  );
  let copiedTrustPolicies = 0;
  for (const policy of trustPolicies) {
    if (!clientIds.has(String(policy.target_id))) continue;
    await target.execute(
      `INSERT INTO client_trust_policies (
         id, tenant_id, name, display_name, description, target_type, target_id, first_party,
         trusted, skip_authorization_consent, is_active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'oidc_client', ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        targetTenantId,
        policy.name,
        policy.display_name,
        policy.description,
        policy.target_id,
        policy.first_party,
        policy.trusted,
        policy.skip_authorization_consent,
        policy.is_active,
        now,
        now,
      ]
    );
    copiedTrustPolicies += 1;
  }

  return {
    clients: clients.length,
    clientIds,
    webOrigins: copiedWebOrigins,
    trustPolicies: copiedTrustPolicies,
  };
}

async function cloneClientKvConfiguration(
  env: Env,
  sourceTenantId: string,
  targetTenantId: string,
  targetTenantName: string,
  clientIds: Set<string>,
  includeCredentials: boolean,
  writtenKvKeys: KvRollbackEntry[],
  budget: KvCloneBudget
): Promise<{
  settings: number;
  contracts: number;
  secretSettingsSkipped: number;
  unclassifiedSettingsSkipped: number;
}> {
  let settings = 0;
  let contracts = 0;
  let secretSettingsSkipped = 0;
  let unclassifiedSettingsSkipped = 0;

  for (const clientId of clientIds) {
    const copiedSettings = await copyKvPrefix(
      env.SETTINGS,
      `settings:client:${sourceTenantId}:${clientId}:`,
      `settings:client:${targetTenantId}:${clientId}:`,
      includeCredentials,
      writtenKvKeys,
      budget,
      {
        targetTenantId,
        targetTenantName,
        includeClients: true,
      }
    );
    settings += copiedSettings.copied;
    secretSettingsSkipped += copiedSettings.skippedSecrets;
    unclassifiedSettingsSkipped += copiedSettings.skippedUnclassified;
    if (!env.AUTHRIM_CONFIG) continue;
    const sourceKey = buildContractKey(env, 'client', sourceTenantId, clientId);
    const serialized = assertCloneKvValueSize(await env.AUTHRIM_CONFIG.get(sourceKey));
    if (!serialized) continue;
    consumeKvCloneBudget(budget);
    const parsedContract = parseSettingsRecord(serialized);
    if (!parsedContract) throw new Error('tenant_clone_client_contract_invalid');
    const contract = sanitizeContractKeyMaterial(parsedContract) as Record<string, unknown>;
    const timestamp = new Date().toISOString();
    contract.clientId = clientId;
    contract.version = 1;
    contract.tenantContractVersion = 1;
    contract.metadata = {
      ...(contract.metadata && typeof contract.metadata === 'object' ? contract.metadata : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: 'tenant-clone',
      status: 'active',
    };
    const targetKey = buildContractKey(env, 'client', targetTenantId, clientId);
    await putTrackedKv(env.AUTHRIM_CONFIG, targetKey, JSON.stringify(contract), writtenKvKeys);
    contracts += 1;
  }

  return { settings, contracts, secretSettingsSkipped, unclassifiedSettingsSkipped };
}

async function cloneRoles(
  source: DatabaseAdapter,
  target: DatabaseAdapter,
  sourceTenantId: string,
  targetTenantId: string,
  now: number
): Promise<{
  roles: number;
  rules: number;
  unresolvedRoleReferences: number;
  skippedRules: number;
}> {
  const ruleNow = Math.floor(now / 1000);
  const roles = await source.query<Record<string, unknown>>(
    `SELECT id, name, description, permissions_json, role_type, hierarchy_level,
            is_assignable, parent_role_id, display_name
       FROM roles WHERE tenant_id = ? AND is_system = 0`,
    [sourceTenantId]
  );
  const idMap = new Map(roles.map((role) => [String(role.id), crypto.randomUUID()]));
  const [sourceSystemRoles, targetSystemRoles] = await Promise.all([
    source.query<Record<string, unknown>>(
      'SELECT id, name FROM roles WHERE tenant_id = ? AND is_system = 1',
      [sourceTenantId]
    ),
    target.query<Record<string, unknown>>(
      'SELECT id, name FROM roles WHERE tenant_id = ? AND is_system = 1',
      [targetTenantId]
    ),
  ]);
  const targetSystemRoleByName = new Map(
    targetSystemRoles.map((role) => [String(role.name), String(role.id)])
  );
  for (const role of sourceSystemRoles) {
    const targetId = targetSystemRoleByName.get(String(role.name));
    if (targetId) idMap.set(String(role.id), targetId);
  }
  for (const role of roles) {
    await target.execute(
      `INSERT INTO roles (
         id, tenant_id, name, description, permissions_json, role_type, hierarchy_level,
         is_assignable, parent_role_id, display_name, is_system, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        idMap.get(String(role.id)),
        targetTenantId,
        role.name,
        role.description,
        role.permissions_json,
        role.role_type,
        role.hierarchy_level ?? 0,
        role.is_assignable ?? 1,
        null,
        role.display_name,
        now,
        now,
      ]
    );
  }
  let unresolvedRoleReferences = 0;
  for (const role of roles) {
    const sourceParentRoleId = nonEmptyString(role.parent_role_id);
    const parentRoleId = sourceParentRoleId ? (idMap.get(sourceParentRoleId) ?? null) : null;
    if (sourceParentRoleId && !parentRoleId) unresolvedRoleReferences += 1;
    if (parentRoleId) {
      await target.execute('UPDATE roles SET parent_role_id = ? WHERE tenant_id = ? AND id = ?', [
        parentRoleId,
        targetTenantId,
        idMap.get(String(role.id)),
      ]);
    }
  }

  const rules = await source.query<Record<string, unknown>>(
    `SELECT name, description, role_id, scope_type, scope_target, conditions_json, actions_json,
            priority, stop_processing, is_active, valid_from, valid_until
       FROM role_assignment_rules WHERE tenant_id = ?`,
    [sourceTenantId]
  );
  let copiedRules = 0;
  let skippedRules = 0;
  for (const rule of rules) {
    const mappedRoleId = idMap.get(String(rule.role_id));
    const conditions = remapJsonReferences(rule.conditions_json, idMap);
    const actions = remapJsonReferences(rule.actions_json, idMap);
    if (!mappedRoleId || !conditions || !actions) {
      skippedRules += 1;
      if (!mappedRoleId) unresolvedRoleReferences += 1;
      continue;
    }
    if (
      rule.scope_type !== 'global' ||
      (rule.scope_target !== null &&
        rule.scope_target !== undefined &&
        (typeof rule.scope_target !== 'string' || rule.scope_target !== '')) ||
      containsUncopiedScopeReference(conditions) ||
      containsUncopiedScopeReference(actions)
    ) {
      skippedRules += 1;
      continue;
    }
    await target.execute(
      `INSERT INTO role_assignment_rules (
         id, tenant_id, name, description, role_id, scope_type, scope_target, conditions_json,
         actions_json, priority, stop_processing, is_active, valid_from, valid_until,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        targetTenantId,
        rule.name,
        rule.description,
        mappedRoleId,
        rule.scope_type,
        rule.scope_target,
        conditions,
        actions,
        rule.priority,
        rule.stop_processing,
        rule.is_active,
        rule.valid_from,
        rule.valid_until,
        'tenant-clone',
        ruleNow,
        ruleNow,
      ]
    );
    copiedRules += 1;
  }
  return {
    roles: roles.length,
    rules: copiedRules,
    unresolvedRoleReferences,
    skippedRules,
  };
}

async function cloneAdminAccess(
  adapter: DatabaseAdapter,
  sourceTenantId: string,
  targetTenantId: string,
  now: number
): Promise<{
  roles: number;
  assignments: number;
  skippedAssignments: number;
  unresolvedInheritance: number;
}> {
  const roles = await adapter.query<Record<string, unknown>>(
    `SELECT id, name, display_name, description, permissions_json, hierarchy_level, role_type,
            inherits_from
       FROM admin_roles WHERE tenant_id = ? AND is_system = 0`,
    [sourceTenantId]
  );
  const idMap = new Map(roles.map((role) => [String(role.id), crypto.randomUUID()]));
  for (const role of roles) {
    await adapter.execute(
      `INSERT INTO admin_roles (
         id, tenant_id, name, display_name, description, permissions_json, hierarchy_level,
         role_type, is_system, created_at, updated_at, inherits_from
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
      [
        idMap.get(String(role.id)),
        targetTenantId,
        role.name,
        role.display_name,
        role.description,
        role.permissions_json,
        role.hierarchy_level,
        role.role_type,
        now,
        now,
      ]
    );
  }
  const systemRoles = await adapter.query<Record<string, unknown>>(
    'SELECT id FROM admin_roles WHERE is_system = 1'
  );
  const systemRoleIds = new Set(systemRoles.map((role) => String(role.id)));
  let unresolvedInheritance = 0;
  for (const role of roles) {
    const sourceParent = nonEmptyString(role.inherits_from);
    if (!sourceParent) continue;
    const targetParent =
      idMap.get(sourceParent) ?? (systemRoleIds.has(sourceParent) ? sourceParent : null);
    if (!targetParent) {
      unresolvedInheritance += 1;
      continue;
    }
    await adapter.execute(
      'UPDATE admin_roles SET inherits_from = ? WHERE tenant_id = ? AND id = ?',
      [targetParent, targetTenantId, idMap.get(String(role.id))]
    );
  }

  const assignments = await adapter.query<Record<string, unknown>>(
    `SELECT a.admin_user_id, a.admin_role_id, a.scope_type, a.scope_id, a.expires_at,
            a.assigned_by, r.is_system
       FROM admin_role_assignments a
       JOIN admin_roles r ON r.id = a.admin_role_id
      WHERE a.tenant_id = ? AND (a.expires_at IS NULL OR a.expires_at > ?)`,
    [sourceTenantId, now]
  );
  let copied = 0;
  let skipped = 0;
  for (const assignment of assignments) {
    if (
      assignment.scope_type !== 'tenant' ||
      nonEmptyString(assignment.scope_id) !== sourceTenantId
    ) {
      skipped += 1;
      continue;
    }
    const roleId =
      Number(assignment.is_system) === 1
        ? String(assignment.admin_role_id)
        : idMap.get(String(assignment.admin_role_id));
    if (!roleId) continue;
    await adapter.execute(
      `INSERT INTO admin_role_assignments (
         id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, expires_at,
         assigned_by, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        targetTenantId,
        assignment.admin_user_id,
        roleId,
        'tenant',
        targetTenantId,
        assignment.expires_at,
        assignment.assigned_by,
        now,
      ]
    );
    copied += 1;
  }
  return {
    roles: roles.length,
    assignments: copied,
    skippedAssignments: skipped,
    unresolvedInheritance,
  };
}

async function cloneWebhooks(
  source: DatabaseAdapter,
  target: DatabaseAdapter,
  sourceTenantId: string,
  targetTenantId: string,
  includeSecrets: boolean,
  clonedClientIds: Set<string>,
  nowIso: string
): Promise<{ copied: number; skippedClientWebhooks: number }> {
  const secretColumns = includeSecrets
    ? 'secret_encrypted, headers'
    : 'NULL AS secret_encrypted, NULL AS headers';
  const webhooks = await source.query<Record<string, unknown>>(
    `SELECT client_id, scope, name, url, events, ${secretColumns}, retry_policy,
            timeout_ms, active
       FROM webhook_configs WHERE tenant_id = ? AND scope IN ('tenant', 'client')`,
    [sourceTenantId]
  );
  let copied = 0;
  let skippedClientWebhooks = 0;
  for (const webhook of webhooks) {
    const isClientScope = webhook.scope === 'client';
    if (isClientScope && !clonedClientIds.has(String(webhook.client_id))) {
      skippedClientWebhooks += 1;
      continue;
    }
    await target.execute(
      `INSERT INTO webhook_configs (
         id, tenant_id, client_id, scope, name, url, events, secret_encrypted, headers,
         retry_policy, timeout_ms, active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        targetTenantId,
        isClientScope ? webhook.client_id : null,
        isClientScope ? 'client' : 'tenant',
        webhook.name,
        webhook.url,
        webhook.events,
        includeSecrets ? webhook.secret_encrypted : null,
        includeSecrets ? webhook.headers : '{}',
        webhook.retry_policy,
        webhook.timeout_ms,
        includeSecrets ? webhook.active : 0,
        nowIso,
        nowIso,
      ]
    );
    copied += 1;
  }
  return { copied, skippedClientWebhooks };
}

async function cleanupInternalCloneDatabaseRows(
  targetAdapter: DatabaseAdapter,
  targetTenantId: string
): Promise<void> {
  const tables = [
    'role_assignment_rules',
    'role_assignments',
    'user_roles',
    'roles',
    'webhook_configs',
    'client_consent_overrides',
    'client_trust_policies',
    'web_origin_registry',
    'oauth_clients',
    'custom_claim_schemas',
  ] as const;
  for (const table of tables) {
    await targetAdapter.execute(`DELETE FROM ${table} WHERE tenant_id = ?`, [targetTenantId]);
  }
}

async function executeTenantCloneHandler(
  c: Context<{ Bindings: Env }>,
  internal?: TenantCloneInternalExecution
) {
  if (!internal) {
    const platformError = await requirePlatformTenantManagementAuthority(
      c,
      ADMIN_PERMISSIONS.TENANT_LIFECYCLE_STANDARD
    );
    if (platformError) return platformError;
  }

  // Keep the provisioning saga's static dependency graph one-way: admin-tenants owns the saga and
  // imports this module's clone preparation callback. The public clone route loads its lifecycle
  // helpers only after both modules have initialized.
  const { beginTenantProvisioning, formatTenantProvisioningOperation } =
    await import('./admin-tenants');

  const sourceTenantId = internal?.sourceTenantId ?? c.req.param('id');
  if (!internal) {
    const blocked = await ensureSupportedTenantId(c, sourceTenantId);
    if (blocked) return blocked;
    if (isSingleTenantMode(c.env)) return createSingleTenantMutationError(c, 'tenant');
  }
  if (!sourceTenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  let targetTenantId: string | null = null;
  let provisioned = false;
  let adminAccessTouched = false;
  const writtenKvKeys: KvRollbackEntry[] = [];
  try {
    let requestBody: unknown;
    try {
      requestBody = internal?.requestBody ?? (await c.req.json<unknown>());
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'body', reason: 'Request body must be valid JSON' },
      });
    }
    const parsed = TenantCloneRequestSchema.safeParse(requestBody);
    if (!parsed.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'body', reason: parsed.error.issues.map((i) => i.message).join(', ') },
      });
    }
    const options = normalizeOptions(parsed.data);
    const dependencyError = validateOptionDependencies(options);
    if (dependencyError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'copy', reason: dependencyError },
      });
    }

    targetTenantId = parsed.data.id;
    if (targetTenantId === sourceTenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'id', reason: 'Destination tenant must differ from source tenant' },
      });
    }
    const sourceAdapter =
      internal?.sourceAdapter ?? createAuthContextFromHono(c, sourceTenantId).coreAdapter;
    const sourceTenant = await sourceAdapter.queryOne<{
      id: string;
      name: string;
      lifecycle_state: string;
      updated_at: number;
    }>('SELECT id, name, lifecycle_state, updated_at FROM tenants WHERE id = ?', [sourceTenantId]);
    if (!sourceTenant) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'source tenant' },
      });
    }
    if (sourceTenant.lifecycle_state !== 'active') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'source_tenant',
          reason: `Source tenant must be active (current state: ${sourceTenant.lifecycle_state})`,
        },
      });
    }

    const adminAdapter = options.admin_access
      ? (internal?.adminAdapter ?? requireAdminDatabaseAdapter(c.env, 'tenant-clone-preflight'))
      : null;
    const sourceDatabaseSnapshot = await estimateSelectedDatabaseQueries(
      sourceAdapter,
      adminAdapter,
      sourceTenantId,
      options
    );
    if (sourceDatabaseSnapshot.estimatedQueries > MAX_SYNCHRONOUS_CLONE_DATABASE_QUERIES) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'copy',
          reason: `Selected configuration is estimated to require ${sourceDatabaseSnapshot.estimatedQueries} database queries; the synchronous clone limit is ${MAX_SYNCHRONOUS_CLONE_DATABASE_QUERIES}. Select fewer categories and retry.`,
        },
      });
    }

    const tenantPluginSettings = options.settings
      ? await readTenantPluginSettings(c.env.SETTINGS, sourceTenantId, targetTenantId)
      : [];
    const kvKeyCount =
      (options.settings
        ? await countKvKeys(c.env.SETTINGS, `settings:tenant:${sourceTenantId}:`)
        : 0) +
      (options.settings
        ? await countKvKeys(c.env.AUTHRIM_CONFIG, `settings:tenant:${sourceTenantId}:`)
        : 0) +
      (options.clients
        ? await countKvKeys(c.env.SETTINGS, `settings:client:${sourceTenantId}:`)
        : 0) +
      (options.clients
        ? await countKvKeys(
            c.env.AUTHRIM_CONFIG,
            `${c.env.ENVIRONMENT || 'dev'}:contract:client:${sourceTenantId}:`
          )
        : 0) +
      tenantPluginSettings.length +
      (options.settings ? 1 : 0);
    if (kvKeyCount > MAX_SYNCHRONOUS_CLONE_KV_KEYS) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'copy',
          reason: `Selected configuration contains ${kvKeyCount} KV records; the synchronous clone limit is ${MAX_SYNCHRONOUS_CLONE_KV_KEYS}. Select fewer categories and retry.`,
        },
      });
    }
    const sourceKvVersion = await captureSourceKvVersion(
      c.env,
      sourceTenantId,
      options,
      tenantPluginSettings
    );

    if (!internal) {
      const sourceSnapshot = {
        tenant_updated_at: sourceTenant.updated_at,
        database_version: await sha256Hex(sourceDatabaseSnapshot.sourceVersion),
        kv_version: sourceKvVersion,
      };
      const started = await beginTenantProvisioning(c, {
        id: targetTenantId,
        tenantCode: parsed.data.tenant_code ?? targetTenantId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        isolationPolicy: parsed.data.isolation_policy,
        operationKind: 'clone',
        sourceTenantId,
        preparationPayload: { copy: options, source_snapshot: sourceSnapshot },
      });
      if (started instanceof Response) return started;
      await createAuditLogFromContext(c, 'tenant.clone.requested', 'tenant', targetTenantId, {
        source_tenant_id: sourceTenantId,
        operation_id: started.operation.operationId,
        options,
      });
      return c.json(
        {
          ...started.tenant,
          source_tenant_id: sourceTenantId,
          source_tenant_name: sourceTenant.name,
          copy: options,
          provisioning: {
            mode: 'control-plane',
            ...formatTenantProvisioningOperation(started.operation),
          },
        },
        202
      );
    }

    provisioned = true;

    const targetAdapter =
      internal?.targetAdapter ?? createAuthContextFromHono(c, targetTenantId).coreAdapter;
    const kvBudget: KvCloneBudget = { remaining: MAX_SYNCHRONOUS_CLONE_KV_KEYS };
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const summary = {
      settings: 0,
      secret_settings_skipped: 0,
      unclassified_settings_skipped: 0,
      clients: 0,
      client_settings: 0,
      client_contracts: 0,
      client_web_origins: 0,
      client_trust_policies: 0,
      client_consent_overrides_skipped: 0,
      client_flow_assignments_skipped: 0,
      roles: 0,
      role_assignment_rules: 0,
      role_references_unresolved: 0,
      role_assignment_rules_skipped: 0,
      admin_roles: 0,
      admin_role_assignments: 0,
      admin_role_assignments_skipped: 0,
      admin_role_inheritance_unresolved: 0,
      webhooks: 0,
      client_webhooks_skipped: 0,
    };
    let clonedClientIds = new Set<string>();

    if (options.settings) {
      const copied = await copyKvPrefix(
        c.env.SETTINGS,
        `settings:tenant:${sourceTenantId}:`,
        `settings:tenant:${targetTenantId}:`,
        options.secret_settings,
        writtenKvKeys,
        kvBudget,
        {
          targetTenantId,
          targetTenantName: parsed.data.name,
          includeClients: options.clients,
        }
      );
      summary.settings += copied.copied;
      summary.secret_settings_skipped += copied.skippedSecrets;
      summary.unclassified_settings_skipped += copied.skippedUnclassified;
      const copiedConfigSettings = await copyKvPrefix(
        c.env.AUTHRIM_CONFIG,
        `settings:tenant:${sourceTenantId}:`,
        `settings:tenant:${targetTenantId}:`,
        options.secret_settings,
        writtenKvKeys,
        kvBudget,
        {
          targetTenantId,
          targetTenantName: parsed.data.name,
          includeClients: options.clients,
        },
        new Set(['tenant'])
      );
      summary.settings += copiedConfigSettings.copied;
      summary.secret_settings_skipped += copiedConfigSettings.skippedSecrets;
      summary.unclassified_settings_skipped += copiedConfigSettings.skippedUnclassified;

      const copiedPluginSettings = await copyTenantPluginSettings(
        c.env.SETTINGS,
        options.secret_settings,
        tenantPluginSettings,
        writtenKvKeys,
        kvBudget
      );
      summary.settings += copiedPluginSettings.copied;
      summary.secret_settings_skipped += copiedPluginSettings.skippedSecrets;
      summary.unclassified_settings_skipped += copiedPluginSettings.skippedUnclassified;

      const sourceTenantSettingsKey = `settings:tenant:${sourceTenantId}:tenant`;
      const targetTenantSettingsKey = `settings:tenant:${targetTenantId}:tenant`;
      const [tenantSettings, targetDefaults] = await Promise.all([
        c.env.AUTHRIM_CONFIG?.get(sourceTenantSettingsKey),
        c.env.AUTHRIM_CONFIG?.get(targetTenantSettingsKey),
      ]);
      if (tenantSettings && c.env.AUTHRIM_CONFIG) {
        consumeKvCloneBudget(kvBudget);
        const sourceValues = parseSettingsRecord(assertCloneKvValueSize(tenantSettings));
        const targetValues = targetDefaults
          ? parseSettingsRecord(assertCloneKvValueSize(targetDefaults))
          : {};
        if (!sourceValues || !targetValues) {
          throw new Error('tenant_clone_tenant_settings_invalid');
        }
        const destinationIdentityKeys = [
          'tenant.allowed_domains',
          'tenant.allowed_identifiers',
          'tenant.allowed_origins',
          'tenant.audit_profile_id',
          'tenant.base_domain',
          'tenant.residency_profile_id',
        ] as const;
        const mergedValues: Record<string, unknown> = { ...sourceValues };
        for (const key of destinationIdentityKeys) {
          if (key in targetValues) mergedValues[key] = targetValues[key];
          else delete mergedValues[key];
        }
        mergedValues['tenant.default_id'] = targetTenantId;
        mergedValues['tenant.name'] = parsed.data.name;
        await putTrackedKv(
          c.env.AUTHRIM_CONFIG,
          targetTenantSettingsKey,
          JSON.stringify(mergedValues),
          writtenKvKeys
        );
        summary.settings += 1;
      }

      const sourceContract = assertCloneKvValueSize(
        (await c.env.AUTHRIM_CONFIG?.get(buildContractKey(c.env, 'tenant', sourceTenantId))) ?? null
      );
      if (sourceContract && c.env.AUTHRIM_CONFIG) {
        consumeKvCloneBudget(kvBudget);
        const parsedContract = parseSettingsRecord(sourceContract);
        if (!parsedContract) throw new Error('tenant_clone_tenant_contract_invalid');
        const contract = sanitizeContractKeyMaterial(parsedContract) as Record<string, unknown>;
        const timestamp = new Date().toISOString();
        contract.tenantId = targetTenantId;
        contract.version = 1;
        contract.metadata = {
          ...(contract.metadata && typeof contract.metadata === 'object' ? contract.metadata : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: 'tenant-clone',
          status: 'active',
        };
        const targetContractKey = buildContractKey(c.env, 'tenant', targetTenantId);
        await putTrackedKv(
          c.env.AUTHRIM_CONFIG,
          targetContractKey,
          JSON.stringify(contract),
          writtenKvKeys
        );
        summary.settings += 1;
      }
    }

    if (options.clients) {
      const dependencyCounts = await sourceAdapter.queryOne<Record<string, unknown>>(
        `SELECT
           (SELECT COUNT(*) FROM client_consent_overrides WHERE tenant_id = ?) AS consent_overrides,
           (SELECT COUNT(*) FROM flow_assignments
             WHERE tenant_id = ? AND target_type = 'oidc_client') AS flow_assignments`,
        [sourceTenantId, sourceTenantId]
      );
      summary.client_consent_overrides_skipped = Number(dependencyCounts?.consent_overrides ?? 0);
      summary.client_flow_assignments_skipped = Number(dependencyCounts?.flow_assignments ?? 0);
      const clonedClients = await cloneClients(
        sourceAdapter,
        targetAdapter,
        sourceTenantId,
        targetTenantId,
        options.client_credentials,
        now
      );
      clonedClientIds = clonedClients.clientIds;
      for (const clientId of clonedClientIds) {
        const discoveryAlias = await resolveTenantDiscoveryAliasDirectoryInput(c.env, {
          tenantId: targetTenantId,
          aliasKind: 'client_id',
          aliasValue: clientId,
        });
        await ensureActiveTenantDiscoveryAliasDirectory(c.env, discoveryAlias);
      }
      summary.clients = clonedClients.clients;
      summary.client_web_origins = clonedClients.webOrigins;
      summary.client_trust_policies = clonedClients.trustPolicies;
      const clientKv = await cloneClientKvConfiguration(
        c.env,
        sourceTenantId,
        targetTenantId,
        parsed.data.name,
        clonedClientIds,
        options.client_credentials,
        writtenKvKeys,
        kvBudget
      );
      summary.client_settings = clientKv.settings;
      summary.client_contracts = clientKv.contracts;
      summary.secret_settings_skipped += clientKv.secretSettingsSkipped;
      summary.unclassified_settings_skipped += clientKv.unclassifiedSettingsSkipped;
    }
    if (options.roles) {
      const cloned = await cloneRoles(
        sourceAdapter,
        targetAdapter,
        sourceTenantId,
        targetTenantId,
        now
      );
      summary.roles = cloned.roles;
      summary.role_assignment_rules = cloned.rules;
      summary.role_references_unresolved = cloned.unresolvedRoleReferences;
      summary.role_assignment_rules_skipped = cloned.skippedRules;
    }
    if (options.admin_access) {
      adminAccessTouched = true;
      if (!adminAdapter) throw new Error('tenant_clone_admin_adapter_missing');
      const cloned = await cloneAdminAccess(adminAdapter, sourceTenantId, targetTenantId, now);
      summary.admin_roles = cloned.roles;
      summary.admin_role_assignments = cloned.assignments;
      summary.admin_role_assignments_skipped = cloned.skippedAssignments;
      summary.admin_role_inheritance_unresolved = cloned.unresolvedInheritance;
    }
    if (options.webhooks) {
      const cloned = await cloneWebhooks(
        sourceAdapter,
        targetAdapter,
        sourceTenantId,
        targetTenantId,
        options.webhook_secrets,
        clonedClientIds,
        nowIso
      );
      summary.webhooks = cloned.copied;
      summary.client_webhooks_skipped = cloned.skippedClientWebhooks;
    }

    const warnings = [
      'Tenant signing private keys were not copied; a new isolated signing key was generated.',
      ...(options.settings || options.clients
        ? [
            'KV-backed configuration is eventually consistent across regions; allow propagation before directing production traffic to the new tenant.',
          ]
        : []),
      ...(options.settings
        ? [
            'Destination-bound redirect trust, token signing-key selections, SAML signing references, and tenant identity values were reset for the new tenant.',
            'User- and group-specific TOTP requirement subjects were omitted because users and groups are not copied.',
          ]
        : []),
      ...(options.settings && !options.clients
        ? ['App Login and diagnostic-logging client references were omitted.']
        : []),
      ...(!options.client_credentials && options.clients
        ? ['Client secret hashes and credential tokens were omitted.']
        : []),
      ...(!options.webhook_secrets && options.webhooks
        ? ['Webhook secrets and headers were omitted, and copied webhooks were disabled.']
        : []),
      ...(summary.secret_settings_skipped > 0
        ? [`${summary.secret_settings_skipped} secret settings entries were omitted.`]
        : []),
      ...(summary.unclassified_settings_skipped > 0
        ? [
            `${summary.unclassified_settings_skipped} unclassified settings entries were omitted by the fail-closed settings policy.`,
          ]
        : []),
      ...(!options.secret_settings && options.settings
        ? [
            'Copied directory connectors and authentication methods that require connector or human-verification secrets were disabled until their secrets are configured.',
          ]
        : []),
      ...(summary.role_references_unresolved > 0
        ? [`${summary.role_references_unresolved} role references could not be resolved.`]
        : []),
      ...(summary.role_assignment_rules_skipped > 0
        ? [
            `${summary.role_assignment_rules_skipped} role assignment rules were omitted because they were malformed or referenced tenant, organization, or resource scope data that was not copied.`,
          ]
        : []),
      ...(summary.admin_role_inheritance_unresolved > 0
        ? [
            `${summary.admin_role_inheritance_unresolved} Admin role inheritance references could not be resolved.`,
          ]
        : []),
      ...(summary.admin_role_assignments_skipped > 0
        ? [
            `${summary.admin_role_assignments_skipped} Admin assignments outside the source tenant scope were omitted.`,
          ]
        : []),
      ...(summary.client_webhooks_skipped > 0
        ? [
            `${summary.client_webhooks_skipped} client-scoped webhooks were omitted because their clients were not copied.`,
          ]
        : []),
      ...(summary.client_consent_overrides_skipped > 0
        ? [
            `${summary.client_consent_overrides_skipped} client consent overrides were omitted because consent statements and policies are separate tenant resources.`,
          ]
        : []),
      ...(summary.client_flow_assignments_skipped > 0
        ? [
            `${summary.client_flow_assignments_skipped} client flow assignments were omitted because flows and screens are separate tenant resources.`,
          ]
        : []),
      ...(options.roles
        ? [
            'End-user role assignments were not copied because end-user accounts are not part of tenant cloning.',
          ]
        : []),
    ];

    const currentDatabaseSnapshot = await estimateSelectedDatabaseQueries(
      sourceAdapter,
      adminAdapter,
      sourceTenantId,
      options
    );
    const currentKvVersion = await captureSourceKvVersion(c.env, sourceTenantId, options);
    const currentSource = await sourceAdapter.queryOne<{
      lifecycle_state: string;
      updated_at: number;
    }>('SELECT lifecycle_state, updated_at FROM tenants WHERE id = ?', [sourceTenantId]);
    if (
      currentSource?.lifecycle_state !== 'active' ||
      currentSource.updated_at !== sourceTenant.updated_at ||
      currentDatabaseSnapshot.sourceVersion !== sourceDatabaseSnapshot.sourceVersion ||
      currentKvVersion !== sourceKvVersion
    ) {
      throw new Error('source_tenant_changed_during_clone');
    }

    const keyManager = c.env.KEY_MANAGER.get(c.env.KEY_MANAGER.idFromName(`${targetTenantId}-v3`));
    await keyManager.rotateKeysRpc();
    await createAuditLog(c.env, {
      tenantId: targetTenantId,
      userId: internal.actorId,
      action: 'tenant.clone.prepared',
      resource: 'tenant',
      resourceId: targetTenantId,
      ipAddress: 'internal',
      userAgent: 'tenant-provisioning-saga',
      metadata: JSON.stringify({
        source_tenant_id: sourceTenantId,
        options,
        cloned_items: summary,
        signing_keys: 'generated',
        operation: 'control-plane-provisioning',
      }),
      severity: 'info',
    });
    const activatedTenant: Record<string, unknown> = {
      id: targetTenantId,
      tenant_code: parsed.data.tenant_code ?? targetTenantId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      lifecycle_state: 'provisioning',
      is_default: false,
    };

    return c.json(
      {
        ...activatedTenant,
        source_tenant_id: sourceTenantId,
        source_tenant_name: sourceTenant.name,
        copy: options,
        cloned_items: summary,
        signing_keys: { copied: false, generated: true },
        warnings,
      },
      201
    );
  } catch (error) {
    if (
      !provisioned &&
      error instanceof Error &&
      (error.message === 'tenant_clone_kv_value_too_large' ||
        error.message === 'tenant_clone_plugin_registry_too_large')
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'copy',
          reason:
            error.message === 'tenant_clone_kv_value_too_large'
              ? `A selected KV record exceeds the synchronous clone value limit of ${MAX_SYNCHRONOUS_CLONE_KV_VALUE_BYTES} bytes.`
              : `The plugin registry exceeds the synchronous clone limit of ${MAX_REGISTERED_PLUGINS_FOR_CLONE} registered plugins.`,
        },
      });
    }
    if (provisioned && targetTenantId && internal) {
      await rollbackKvWrites(writtenKvKeys);
      try {
        await cleanupInternalCloneDatabaseRows(internal.targetAdapter, targetTenantId);
      } catch {
        // The provisioning operation remains blocked and cleanup can be retried safely.
      }
      if (adminAccessTouched) {
        try {
          await internal.adminAdapter.execute(
            'DELETE FROM admin_role_assignments WHERE tenant_id = ?',
            [targetTenantId]
          );
          await internal.adminAdapter.execute(
            'DELETE FROM admin_roles WHERE tenant_id = ? AND is_system = 0',
            [targetTenantId]
          );
        } catch {
          // The destination is not active; the next attempt repeats cleanup before copying.
        }
      }
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    if (!internal) {
      getLogger(c)
        .module('ADMIN-TENANT-CLONE')
        .error('Failed to clone tenant', { sourceTenantId, targetTenantId }, error as Error);
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Executes the bounded clone copy after Control Plane provisioning has allocated both routes.
 * This is intentionally not exposed as an HTTP route; the provisioning saga is its only runtime
 * caller. Exporting the boundary keeps the copy/rollback behavior independently testable.
 */
export async function executePreparedTenantClone(
  c: Context<{ Bindings: Env }>,
  internal: TenantCloneInternalExecution
) {
  return executeTenantCloneHandler(c, internal);
}

export async function adminTenantCloneHandler(c: Context<{ Bindings: Env }>) {
  return executeTenantCloneHandler(c);
}

export async function prepareTenantCloneForProvisioning(
  env: Env,
  operation: TenantProvisioningOperationView,
  route: ControlTenantDefaultRouteAllocation
): Promise<Record<string, unknown>> {
  if (
    operation.operationKind !== 'clone' ||
    !operation.sourceTenantId ||
    operation.sourceTenantId === operation.tenantId ||
    !operation.preparationPayload ||
    Object.keys(operation.preparationPayload).length !== 2
  ) {
    throw new Error('tenant_provisioning_clone_payload_invalid');
  }
  const options = CloneOptionsSchema.safeParse(operation.preparationPayload.copy);
  const sourceSnapshot = CloneSourceSnapshotSchema.safeParse(
    operation.preparationPayload.source_snapshot
  );
  if (!options.success || !sourceSnapshot.success) {
    throw new Error('tenant_provisioning_clone_payload_invalid');
  }
  const dependencyError = validateOptionDependencies(options.data);
  if (dependencyError) throw new Error('tenant_provisioning_clone_payload_invalid');
  const boundTarget = (env as unknown as Record<string, unknown>)[route.target.bindingRef];
  if (!boundTarget) throw new Error('tenant_provisioning_clone_binding_unavailable');

  const [sourceAdapter, targetAdapter] = await Promise.all([
    resolveAuthCorePersistenceAdapterFromEnv(env, 'tenant-clone-source', {
      tenantId: operation.sourceTenantId,
    }),
    resolveAuthCorePersistenceAdapterFromEnv(env, 'tenant-clone-target', {
      tenantId: operation.tenantId,
    }),
  ]);
  const adminAdapter = requireAdminDatabaseAdapter(env, 'tenant-clone-provisioning');
  const [currentSource, currentDatabaseSnapshot, currentKvVersion] = await Promise.all([
    sourceAdapter.queryOne<{ lifecycle_state: string; updated_at: number }>(
      'SELECT lifecycle_state, updated_at FROM tenants WHERE id = ?',
      [operation.sourceTenantId]
    ),
    estimateSelectedDatabaseQueries(
      sourceAdapter,
      options.data.admin_access ? adminAdapter : null,
      operation.sourceTenantId,
      options.data
    ),
    captureSourceKvVersion(env, operation.sourceTenantId, options.data),
  ]);
  if (
    currentSource?.lifecycle_state !== 'active' ||
    currentSource.updated_at !== sourceSnapshot.data.tenant_updated_at ||
    (await sha256Hex(currentDatabaseSnapshot.sourceVersion)) !==
      sourceSnapshot.data.database_version ||
    currentKvVersion !== sourceSnapshot.data.kv_version
  ) {
    throw new Error('tenant_provisioning_clone_source_conflict');
  }
  await cleanupInternalCloneDatabaseRows(targetAdapter, operation.tenantId);
  await adminAdapter.execute('DELETE FROM admin_role_assignments WHERE tenant_id = ?', [
    operation.tenantId,
  ]);
  await adminAdapter.execute('DELETE FROM admin_roles WHERE tenant_id = ? AND is_system = 0', [
    operation.tenantId,
  ]);

  const requestBody: z.infer<typeof TenantCloneRequestSchema> = {
    id: operation.tenantId,
    tenant_code: operation.tenantCode,
    name: operation.tenantName,
    description: operation.tenantDescription ?? undefined,
    isolation_policy: operation.isolationPolicy,
    copy: options.data,
  };
  const internalContext = {
    env,
    req: {
      param: (name: string) => (name === 'id' ? operation.sourceTenantId! : undefined),
      json: async () => requestBody,
      header: (_name: string) => undefined,
    },
    get: (name: string) => {
      if (name === 'adminAuth') return { userId: operation.createdBy };
      if (name === 'tenantId') return operation.tenantId;
      return undefined;
    },
    json: (body: unknown, status: number = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context<{ Bindings: Env }>;
  const response = await executePreparedTenantClone(internalContext, {
    sourceTenantId: operation.sourceTenantId,
    requestBody,
    sourceAdapter,
    targetAdapter,
    adminAdapter,
    actorId: operation.createdBy,
  });
  if (response.status !== 201) {
    throw new Error('tenant_provisioning_clone_prepare_failed');
  }
  const result = (await response.json()) as Record<string, unknown>;
  if (
    result.source_tenant_id !== operation.sourceTenantId ||
    !result.cloned_items ||
    typeof result.cloned_items !== 'object' ||
    !Array.isArray(result.warnings)
  ) {
    throw new Error('tenant_provisioning_clone_result_invalid');
  }
  return {
    source_tenant_id: operation.sourceTenantId,
    copy: options.data,
    cloned_items: result.cloned_items,
    signing_keys: { copied: false, generated: true },
    warnings: result.warnings,
  };
}
