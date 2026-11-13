/**
 * Who may use a capability the platform can turn off for tenants (category `tenant-capabilities`),
 * for the Admin API. One rule for every place that asks (the route gate, the common tenant
 * settings writer, the per-plugin handlers):
 *
 * - a caller with global platform authority (`hasGlobalPlatformAuthority(ctx, 'admin:*')`) is
 *   exempt: it may manage whatever the capability covers;
 * - while the capability is off, everyone else is refused: 403 `capability_disabled`;
 * - when the switch cannot be read, everyone else is refused: 503 `temporarily_unavailable`
 *   (never treated as on).
 *
 * This is about managing. Whether anything RUNS for a tenant is decided by the runtime entry
 * points, which stay closed while the capability is off, for every caller.
 */
import type { Context } from 'hono';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import {
  carriesMetadataUrl,
  decideTenantCapabilityAccess,
  getTenantCapabilityState,
  hasGlobalPlatformAuthority,
  tenantCapabilityDisabledRefusal,
  tenantCapabilityUnavailableRefusal,
  type AdminAuthContext,
  type EffectiveSettingsEnv,
  type TenantCapability,
  type TenantCapabilityRefusal,
} from '@authrim/ar-lib-core';

/** The settings categories whose writes belong to a capability. */
export const SETTINGS_CATEGORY_CAPABILITY: Readonly<Record<string, TenantCapability>> = {
  dcr: 'dynamic_client_registration',
  plugin: 'external_plugins',
  // The tenant e-mail settings (which provider the tenant's mail goes through) are a tenant
  // settings document too, so a tenant backup restore reaches them.
  'email-settings': 'email_provider_config',
  // Directory connector settings name endpoints the platform then calls. The generic settings API
  // has no such category (the connector routes write them), so this reaches a tenant backup
  // restore, which brings the document back as stored.
  'directory-connectors': 'directory_connectors',
};

/**
 * The restorable datasets (not settings documents) whose rows a capability covers, and the entry
 * of the requester's recorded authority that exempts a requester with global platform authority
 * (the same list as the settings categories above: `platformSettingsCategories`).
 */
export const RESTORE_DATASET_CAPABILITY: Readonly<
  Record<string, { capability: TenantCapability; exemption: string }>
> = {
  // Check API keys come back as stored (key hash, active flag, expiry): a usable key.
  'core.check_api_keys': {
    capability: 'machine_credentials',
    exemption: 'dataset-core-check-api-keys',
  },
  // External identity providers come back as stored (endpoints, client credentials, flags): a
  // provider the server would call once the capability is back on.
  'core.upstream_providers': {
    capability: 'external_identity_providers',
    exemption: 'dataset-core-upstream-providers',
  },
};

/** A restorable dataset whose rows are covered only when they carry what the capability governs. */
export interface RestoreRowCapability {
  capability: TenantCapability;
  /** The entry of the requester's recorded authority that exempts a global platform requester. */
  exemption: string;
  /**
   * Whether the row carries what the capability governs. A row whose columns cannot be read as
   * expected counts as carrying it.
   */
  carries(row: PortableSqliteRow): boolean;
}

/** A column's text: undefined when absent, null when null, or `unreadable` for any other shape. */
const UNREADABLE = Symbol('unreadable');
function columnText(row: PortableSqliteRow, column: string): string | null | undefined | symbol {
  if (!Object.hasOwn(row, column)) return undefined;
  const field = row[column];
  if (!Array.isArray(field) || field.length !== 2) return UNREADABLE;
  if (field[0] === 'null') return field[1] === null ? null : UNREADABLE;
  return field[0] === 'text' && typeof field[1] === 'string' ? field[1] : UNREADABLE;
}

function columnNonEmpty(row: PortableSqliteRow, column: string): boolean {
  const value = columnText(row, column);
  if (value === undefined || value === null) return false;
  return typeof value !== 'string' || value.trim() !== '';
}

/** The column's JSON object; null when empty, `UNREADABLE` when it cannot be read as one. */
function columnJsonObject(
  row: PortableSqliteRow,
  column: string
): Record<string, unknown> | null | typeof UNREADABLE {
  const value = columnText(row, column);
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return UNREADABLE;
  if (value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

/** Client columns only dynamic client registration (RFC 7591/7592) can set, and the server then calls. */
export const REGISTERED_CLIENT_ENDPOINT_COLUMNS = [
  'jwks_uri',
  'backchannel_logout_uri',
  'backchannel_client_notification_endpoint',
  'logout_webhook_uri',
] as const;

/**
 * Datasets restored row by row: a row is refused while its capability is not on (an unreadable
 * switch counts as not on) when it carries what the capability governs, unless the requester has
 * global platform authority.
 */
export const RESTORE_ROW_CAPABILITY: Readonly<Record<string, RestoreRowCapability>> = {
  // Client endpoints that only dynamic client registration can set (the Admin API has no field for
  // them) and that the server calls: a client row copies them as stored.
  'core.oauth_clients': {
    capability: 'dynamic_client_registration',
    exemption: 'dataset-core-oauth-clients-registered-endpoints',
    carries: (row) =>
      REGISTERED_CLIENT_ENDPOINT_COLUMNS.some((column) => columnNonEmpty(row, column)),
  },
  // SAML providers with a stored metadata URL are refreshed from it by the scheduled poller.
  'core.identity_providers': {
    capability: 'saml_metadata_url',
    exemption: 'dataset-core-identity-providers-metadata-url',
    carries: (row) => {
      const config = columnJsonObject(row, 'config_json');
      if (config === UNREADABLE) return true;
      return carriesMetadataUrl(config?.metadataUrl);
    },
  },
  // Federation sources with a metadata URL (or one exact metadata URL pattern, which the poller
  // also fetches) are refreshed from it by the scheduled poller.
  'admin.federation_trust_sources': {
    capability: 'saml_metadata_url',
    exemption: 'dataset-admin-federation-trust-sources-metadata-url',
    carries: (row) => {
      const payload = columnJsonObject(row, 'protocol_payload_json');
      if (payload === UNREADABLE) return true;
      if (!payload) return false;
      if (carriesMetadataUrl(payload.metadataUrl)) return true;
      const patterns = payload.metadataUrlPatterns;
      if (patterns === undefined || patterns === null) return false;
      if (!Array.isArray(patterns)) return true;
      return patterns.some((pattern) => typeof pattern !== 'string' || !pattern.includes('*'));
    },
  },
};

/**
 * The configuration and enabled state of the built-in e-mail notifier plugins come back as stored
 * (a plugin configuration record, not a settings document), so a restore of them is covered by
 * `email_provider_config` too; the exemption is recorded like the dataset ones above.
 */
export const RESTORE_BUILTIN_NOTIFIER_CAPABILITY: Readonly<{
  capability: TenantCapability;
  exemption: string;
}> = {
  capability: 'email_provider_config',
  exemption: 'dataset-integrations-builtin-notifiers',
};

export type CapabilityRefusal = TenantCapabilityRefusal;

export function capabilityDisabledRefusal(capability: TenantCapability): CapabilityRefusal {
  return tenantCapabilityDisabledRefusal(capability);
}

export function capabilityUnavailableRefusal(capability: TenantCapability): CapabilityRefusal {
  return tenantCapabilityUnavailableRefusal(capability);
}

/**
 * Null when the caller may manage the capability now, else how to refuse. The decision itself is
 * shared with the other Admin API surfaces (ar-lib-core `decideTenantCapabilityAccess`; the SAML
 * admin routes ask `tenantCapabilityRefusal`, which reads the switch the same way).
 */
export async function capabilityRefusal(
  env: EffectiveSettingsEnv,
  authContext: AdminAuthContext | undefined,
  capability: TenantCapability,
  options: {
    /**
     * Whether the caller passed the permission checks. An unreadable switch only refuses a caller
     * who would otherwise be allowed (the others get their own refusal).
     */
    permitted?: boolean;
  } = {}
): Promise<CapabilityRefusal | null> {
  // An exempt caller never reads the switch.
  if (hasGlobalPlatformAuthority(authContext, 'admin:*')) return null;
  const decision = decideTenantCapabilityAccess({
    state: await getTenantCapabilityState(env, capability),
    globalPlatformAuthority: false,
    permitted: options.permitted,
  });
  if (decision === 'disabled') return capabilityDisabledRefusal(capability);
  if (decision === 'unavailable') return capabilityUnavailableRefusal(capability);
  return null;
}

/**
 * For a handler that must refuse before it writes or sends anything: null when the caller may go
 * on, else the response (403 `capability_disabled`, or 503 with Retry-After when the switch cannot
 * be read). The caller is the signed-in administrator of the request; the decision does not look
 * at the path.
 */
export async function refuseWhileCapabilityOff(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<any, any, any>,
  capability: TenantCapability
): Promise<Response | null> {
  const authContext = (c as unknown as { get: (key: string) => unknown }).get('adminAuth') as
    | AdminAuthContext
    | undefined;
  const refusal = await capabilityRefusal(c.env as EffectiveSettingsEnv, authContext, capability);
  if (!refusal) return null;
  return c.json(refusal.body, refusal.status, refusal.status === 503 ? { 'Retry-After': '5' } : {});
}

/**
 * Whether the plugin is one of the built-in e-mail notifiers (`notifier-*`, not a dynamic worker):
 * which one is configured and enabled decides the provider and sender of the tenant's mail.
 */
export function isBuiltinNotifierPlugin(
  pluginId: string,
  entry: { backendKind?: string }
): boolean {
  return pluginId.startsWith('notifier-') && entry.backendKind !== 'dynamic_worker';
}
