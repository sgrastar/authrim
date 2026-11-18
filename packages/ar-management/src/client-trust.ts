import type { AdminStepUpLevel, DatabaseAdapter } from '@authrim/ar-lib-core';
import { requireAdminStepUp } from './admin-step-up-gate';

const DISPLAY_FIELDS = new Set([
  'client_name',
  'description',
  'logo_uri',
  'client_uri',
  'policy_uri',
  'tos_uri',
  'contacts',
]);
const INTERNAL_FIELDS = new Set([
  'client_id',
  'tenant_id',
  'created_at',
  'updated_at',
  'expected_updated_at',
  'enabled',
  'registration_access_token_hash',
  'agent_access_last_used_at',
]);
// Match the JSON columns serialized by ClientRepository; scalar strings keep their meaning.
const JSON_FIELDS = new Set([
  'redirect_uris',
  'grant_types',
  'response_types',
  'contacts',
  'post_logout_redirect_uris',
  'jwks',
  'claims_parameter_policy',
  'identity_mapping',
  'information_release_consent',
  'asc_allowed_transformed_claims',
  'allowed_subject_token_clients',
  'allowed_token_exchange_resources',
  'allowed_scopes',
  'requestable_scopes',
  'allowed_redirect_origins',
  'allowed_channels',
  'device_secret_revoke_trust_groups',
  'device_secret_introspection_trust_groups',
]);
const LOGOUT_FIELDS = new Set([
  'post_logout_redirect_uris',
  'frontchannel_logout_uri',
  'backchannel_logout_uri',
  'frontchannel_logout_session_required',
  'backchannel_logout_session_required',
]);

/** Object order is immaterial; array order remains part of the configuration. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    );
  }
  return value;
}

/** Decode repository JSON columns before applying the same patch used by the writer. */
export function clientTrustSettings(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key, v]) => v !== undefined && !DISPLAY_FIELDS.has(key) && !INTERNAL_FIELDS.has(key)
      )
      .map(([key, value]) => {
        if (JSON_FIELDS.has(key) && typeof value === 'string') {
          try {
            const decoded: unknown = JSON.parse(value);
            value = decoded;
          } catch {
            /* Preserve malformed stored values for comparison. */
          }
        }
        if (key === 'web_origin_registry' && value && typeof value === 'object') {
          const origins = (value as { origins?: Record<string, unknown>[] }).origins;
          if (origins)
            value = {
              origins: origins
                .map(({ client_ids: _ids, ...entry }) => entry)
                .sort((a, b) => String(a.origin).localeCompare(String(b.origin))),
            };
        }
        return [key, value];
      })
  );
}

export async function clientTrustDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(canonical(value)))
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decide trust once from the effective values, including logout settings used while disabled. */
export function classifyClientTrustTransition(input: {
  before?: Record<string, unknown>;
  after: Record<string, unknown>;
}): AdminStepUpLevel {
  const { before, after } = input;
  if (!before) return after.enabled !== false ? 'L2' : 'L0';
  const previous = clientTrustSettings(before);
  const next = clientTrustSettings(after);
  const changed = [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter(
    (key) => JSON.stringify(canonical(previous[key])) !== JSON.stringify(canonical(next[key]))
  );
  if (changed.some((key) => LOGOUT_FIELDS.has(key))) return 'L2';
  if (before.enabled !== false) {
    if (changed.length) return 'L2';
    return after.enabled === false ? 'L1' : 'L0';
  }
  return after.enabled !== false ? 'L2' : 'L0';
}

/** Read approval inputs from the primary, never from the browser-origin KV cache. */
export async function clientTrustPolicy(
  adapter: DatabaseAdapter,
  tenantId: string,
  clientId: string
) {
  return adapter.queryOne<Record<string, unknown>>(
    "SELECT * FROM client_trust_policies WHERE tenant_id = ? AND target_type = 'oidc_client' AND target_id = ?",
    [tenantId, clientId]
  );
}

export function requireClientTrustStepUp(
  c: unknown,
  input: {
    tenantId: string;
    targetIds?: string[];
    level: AdminStepUpLevel;
    resourceVersion?: string;
    params: Record<string, unknown>;
  }
): Promise<Response | null> {
  if (input.level === 'L0') return Promise.resolve(null);
  const target = {
    targetTenantId: input.tenantId,
    targetIds: input.targetIds,
    resourceVersion: input.resourceVersion,
    params: input.params,
  };
  return requireAdminStepUp(
    c as Parameters<typeof requireAdminStepUp>[0],
    input.level === 'L1'
      ? { operation: 'client.trust.disable', ...target }
      : { operation: 'client.trust.activate', ...target }
  );
}
