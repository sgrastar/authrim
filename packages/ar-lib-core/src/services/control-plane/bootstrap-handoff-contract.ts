import { assertControlPlaneRecordIsSecretFree } from './control-plane-contracts';

export type ControlBootstrapResourceRole =
  | 'lookup'
  | 'tenant_core/default'
  | 'tenant_core/users'
  | 'tenant_pii';

export interface ControlBootstrapOwnershipResource {
  role: ControlBootstrapResourceRole;
  desiredResourceId: string;
  providerDatabaseId: string;
  providerName: string;
  ownershipFingerprint: string;
  bindingRef: string;
  manifestDigest: string;
}

const EXPECTED_ROLES: readonly ControlBootstrapResourceRole[] = [
  'lookup',
  'tenant_core/default',
  'tenant_core/users',
  'tenant_pii',
];
const SAFE_VALUE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function validateResource(resource: ControlBootstrapOwnershipResource): void {
  if (!EXPECTED_ROLES.includes(resource.role)) throw new Error('bootstrap_resource_role_invalid');
  for (const field of [
    'desiredResourceId',
    'providerDatabaseId',
    'providerName',
    'ownershipFingerprint',
    'bindingRef',
    'manifestDigest',
  ] as const) {
    const value = resource[field];
    if (typeof value !== 'string' || !SAFE_VALUE.test(value)) {
      throw new Error(`bootstrap_resource_${field}_invalid`);
    }
  }
  if (!SHA256.test(resource.ownershipFingerprint)) {
    throw new Error('bootstrap_resource_ownership_fingerprint_invalid');
  }
  if (!SHA256.test(resource.manifestDigest)) {
    throw new Error('bootstrap_resource_manifest_digest_invalid');
  }
}

export async function calculateControlBootstrapOwnershipFingerprint(
  resources: readonly ControlBootstrapOwnershipResource[]
): Promise<string> {
  if (resources.length !== EXPECTED_ROLES.length) {
    throw new Error('bootstrap_resource_set_incomplete');
  }
  const byRole = new Map<ControlBootstrapResourceRole, ControlBootstrapOwnershipResource>();
  for (const resource of resources) {
    validateResource(resource);
    if (byRole.has(resource.role)) throw new Error('bootstrap_resource_role_duplicate');
    byRole.set(resource.role, resource);
  }
  if (EXPECTED_ROLES.some((role) => !byRole.has(role))) {
    throw new Error('bootstrap_resource_set_incomplete');
  }
  const canonical = EXPECTED_ROLES.map((role) => {
    const resource = byRole.get(role)!;
    return [
      resource.role,
      resource.desiredResourceId,
      resource.providerDatabaseId,
      resource.providerName,
      resource.ownershipFingerprint,
      resource.bindingRef,
      resource.manifestDigest,
    ].join('\0');
  }).join('\n');
  assertControlPlaneRecordIsSecretFree(resources);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const CONTROL_BOOTSTRAP_RESOURCE_ROLES = EXPECTED_ROLES;
