export type TenantBackupBindingKind = 'KVNamespace' | 'R2Bucket' | 'DurableObjectNamespace';
export type TenantBackupBindingDisposition =
  | 'canonical'
  | 'mixed'
  | 'rebuild'
  | 'ephemeral'
  | 'external';

export interface TenantBackupBindingPolicy {
  kind: TenantBackupBindingKind;
  name: string;
  disposition: TenantBackupBindingDisposition;
  reason: string;
}

// Binding-level inventory is not sufficient for a portable export. Mixed bindings require
// per-key/object/DO-state adapters, and canonical bindings still require tenant ownership checks.
const groups: Array<{
  kind: TenantBackupBindingKind;
  disposition: TenantBackupBindingDisposition;
  names: string;
  reason: string;
}> = [
  {
    kind: 'KVNamespace',
    disposition: 'mixed',
    names: 'AUTHRIM_CONFIG KV SETTINGS STATE_STORE',
    reason:
      'Classify canonical configuration, secrets, transient state, and derived caches per key namespace.',
  },
  {
    kind: 'KVNamespace',
    disposition: 'mixed',
    names: 'INITIAL_ACCESS_TOKENS',
    reason:
      'IAT keys and metadata lack tenant ownership. Require proven binding ownership and capture single-use consumption denials before restoring any credential; never export the namespace by tenant prefix inference.',
  },
  {
    kind: 'KVNamespace',
    disposition: 'canonical',
    names: 'POLICY_FLAGS_KV',
    reason:
      'Resolve shared feature flags and policy limits as authorized effective configuration; binding presence does not prove tenant ownership.',
  },
  {
    kind: 'KVNamespace',
    disposition: 'rebuild',
    names:
      'CHECK_CACHE_KV CLIENTS_CACHE CONSENT_CACHE JWKS_CACHE REBAC_CACHE REBAC_CACHE_KV TENANT_RUNTIME_REGISTRY USER_CACHE',
    reason:
      'Rebuild from restored canonical data and target placement; do not import stale caches or physical routes.',
  },
  {
    kind: 'KVNamespace',
    disposition: 'ephemeral',
    names: 'MAGIC_LINKS NONCE_STORE',
    reason: 'Do not restore in-flight login credentials or nonce state as active authentication.',
  },
  {
    kind: 'R2Bucket',
    disposition: 'mixed',
    names:
      'AUDIT_ARCHIVE DIAGNOSTIC_LOGS EXPORT_ARTIFACTS IMPORT_ARTIFACTS PUBLIC_ASSETS SENSITIVE_DETAILS',
    reason:
      'Select tenant records/assets with dependencies, log scope, sensitive-detail permission, and artifact policy; never copy a shared bucket wholesale.',
  },
  {
    kind: 'R2Bucket',
    disposition: 'external',
    names: 'MIGRATION_RELEASES PLUGIN_BUNDLES',
    reason:
      'Resolve trusted release/plugin distribution by pinned version and digest, without executing code supplied by the backup.',
  },
  {
    kind: 'DurableObjectNamespace',
    disposition: 'canonical',
    names: 'KEY_MANAGER TOKEN_REVOCATION_STORE',
    reason:
      'Preserve authorized signing-key material and current token-denial state; shared keys need platform authority.',
  },
  {
    kind: 'DurableObjectNamespace',
    disposition: 'mixed',
    names:
      'AGENT_ACCESS_MCP DIRECTORY_CONNECTOR_RELAY REFRESH_TOKEN_ROTATOR SESSION_REVOCATION_STORE',
    reason:
      'Separate persistent jobs, revocation and credential counters from sessions, transport state, and in-flight credentials.',
  },
  {
    kind: 'DurableObjectNamespace',
    disposition: 'mixed',
    names: 'RATE_LIMITER',
    reason:
      'Ordinary rate counters are transient, but iat-consume claims deny reuse of single-use registration credentials. Preserve those denials or refuse credential restoration; do not reinitialize the whole binding.',
  },
  {
    kind: 'DurableObjectNamespace',
    disposition: 'rebuild',
    names: 'DEVICE_SECRET_ROUTE_STORE REBAC_CLOSURE',
    reason:
      'Rebuild routing hints and closure from restored canonical records and target topology.',
  },
  {
    kind: 'DurableObjectNamespace',
    disposition: 'external',
    names: 'VERSION_MANAGER',
    reason:
      'Provision target runtime through setup; do not activate source Worker bundles from a tenant backup.',
  },
  {
    kind: 'DurableObjectNamespace',
    disposition: 'ephemeral',
    names:
      'AUTHORIZATION_CODE_STORE AUTH_CODE_STORE CHALLENGE_STORE CIBA_REQUEST_STORE CREDENTIAL_OFFER_STORE DEVICE_CODE_STORE DPOP_JTI_STORE FLOW_STATE_STORE PAR_REQUEST_STORE PERMISSION_CHANGE_HUB SAML_AGGREGATE_METADATA_STORE SAML_REQUEST_STORE SESSION_CLIENT_STORE SESSION_STORE USER_CODE_RATE_LIMITER VP_REQUEST_STORE',
    reason:
      'Reinitialize transient protocol/transport state. Restored credential/issuance policy must not reactivate old sessions or in-flight requests.',
  },
];

export const TENANT_BACKUP_BINDING_POLICIES: readonly TenantBackupBindingPolicy[] = groups.flatMap(
  ({ names, ...policy }) => names.split(/\s+/).map((name) => ({ ...policy, name }))
);

export function checkTenantBackupBindingCoverage(
  bindings: readonly { name: string; kind: TenantBackupBindingKind }[]
): { unclassified: string[]; stale: string[]; duplicates: string[] } {
  const actual = new Set(bindings.map((binding) => `${binding.kind}:${binding.name}`));
  const declared = new Set<string>();
  const duplicates = new Set<string>();
  for (const policy of TENANT_BACKUP_BINDING_POLICIES) {
    const key = `${policy.kind}:${policy.name}`;
    if (declared.has(key)) duplicates.add(key);
    declared.add(key);
  }
  return {
    unclassified: [...actual].filter((key) => !declared.has(key)).sort(),
    stale: [...declared].filter((key) => !actual.has(key)).sort(),
    duplicates: [...duplicates].sort(),
  };
}
