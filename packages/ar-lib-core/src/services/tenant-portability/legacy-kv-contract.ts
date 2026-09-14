/** Reviewed legacy keys, not permission to read or copy a shared KV namespace. */
export const LEGACY_OAUTH_SETTING_NAMES = [
  'TOKEN_EXPIRY',
  'AUTH_CODE_TTL',
  'STATE_EXPIRY',
  'NONCE_EXPIRY',
  'REFRESH_TOKEN_EXPIRY',
  'REFRESH_TOKEN_ROTATION_ENABLED',
  'MAX_CODES_PER_USER',
  'CODE_SHARDS',
  'STATE_REQUIRED',
  'USERINFO_REQUIRE_OPENID_SCOPE',
  'USER_CACHE_TTL',
  'CONSENT_CACHE_TTL',
  'CONFIG_CACHE_TTL',
] as const;

export const LEGACY_VC_SETTING_NAMES = [
  'HAIP_POLICY_VERSION',
  'VP_REQUEST_EXPIRY_SECONDS',
  'NONCE_EXPIRY_SECONDS',
  'C_NONCE_EXPIRY_SECONDS',
  'CREDENTIAL_OFFER_EXPIRY_SECONDS',
  'POP_VALIDITY_SECONDS',
  'POP_CLOCK_SKEW_SECONDS',
  'DID_CACHE_TTL_SECONDS',
  'REQUIRE_HOLDER_BINDING',
  'REQUIRE_ISSUER_TRUST',
  'REQUIRE_STATUS_CHECK',
] as const;

const sharedConfigKeys = new Set<string>([
  ...LEGACY_OAUTH_SETTING_NAMES.map((name) => `oauth:config:${name}`),
  ...LEGACY_VC_SETTING_NAMES.map((name) => `vc:config:${name}`),
  'consent:granular_scopes',
  'consent:expiration_enabled',
  'consent:default_expiration_days',
  'consent:versioning_enabled',
  'consent:data_export_enabled',
  'consent:data_export_sync_threshold_kb',
  'v1:cache-mode:platform',
]);
const placementKeys = new Set(['code_shards', 'session_shards', 'challenge_shards']);

export type LegacyKvClassification =
  | { kind: 'shared_setting_dependency' }
  | { kind: 'placement_dependency' }
  | { kind: 'client_setting'; clientId: string }
  | { kind: 'tenant_secret'; category: 'users'; purpose: 'consent_ip_hash' }
  | { kind: 'foreign_tenant' }
  | { kind: 'unsupported' };

/**
 * Only the explicitly identified binding/key combinations are reviewed here.
 * The module still needs snapshot capture, ownership/permission checks, value
 * validation and target mapping. Unknown keys must never be silently omitted.
 */
export function classifyLegacyKvKey(
  binding: string,
  key: string,
  context: { tenantId: string; clientIds: ReadonlySet<string> }
): LegacyKvClassification {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(context.tenantId)) {
    throw new Error('backup_invalid_settings_tenant_id');
  }
  if (key.length > 512) return { kind: 'unsupported' };
  if (binding === 'AUTHRIM_CONFIG') {
    if (sharedConfigKeys.has(key)) return { kind: 'shared_setting_dependency' };
    if (placementKeys.has(key)) return { kind: 'placement_dependency' };
    const client = /^v1:cache-mode:client:([a-zA-Z0-9_-]{1,128})$/.exec(key)?.[1];
    if (client && context.clientIds.has(client))
      return { kind: 'client_setting', clientId: client };
  }
  if (binding === 'KV') {
    const tenant = /^consent:ip_salt:([a-zA-Z0-9_-]{1,128})$/.exec(key)?.[1];
    if (tenant) {
      return tenant === context.tenantId
        ? { kind: 'tenant_secret', category: 'users', purpose: 'consent_ip_hash' }
        : { kind: 'foreign_tenant' };
    }
  }
  return { kind: 'unsupported' };
}
