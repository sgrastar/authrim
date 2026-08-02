export type PluginProvisionedResourceKind = 'd1' | 'kv_namespace' | 'r2_bucket';

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ENVIRONMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

export function managedPluginResourceName(
  environmentId: string,
  ownershipFingerprint: string,
  kind: PluginProvisionedResourceKind
): string {
  if (!SAFE_ENVIRONMENT_ID.test(environmentId) || !SHA256.test(ownershipFingerprint)) {
    throw new Error('plugin_resource_identity_invalid');
  }
  const environment = environmentId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 12);
  if (!environment) throw new Error('plugin_resource_identity_invalid');
  const suffix = kind === 'kv_namespace' ? 'kv' : kind === 'r2_bucket' ? 'r2' : 'd1';
  return `authrim-${environment}-${ownershipFingerprint.slice(0, 32)}-${suffix}`;
}

export function pluginResourceHostBindingRef(
  kind: PluginProvisionedResourceKind,
  ownershipFingerprint: string
): string {
  if (!SHA256.test(ownershipFingerprint)) {
    throw new Error('plugin_resource_binding_fingerprint_invalid');
  }
  const prefix = kind === 'd1' ? 'PRES_D1_' : kind === 'kv_namespace' ? 'PRES_KV_' : 'PRES_R2_';
  return `${prefix}${ownershipFingerprint.slice(0, 24).toUpperCase()}`;
}
