import type { StorageDeploymentProfile, StorageProfile } from '../types/runtime-profile';

export type StorageProfileCapabilityState = 'supported' | 'partial' | 'unsupported' | 'planned';
export type StorageProfileCapabilityCriticality =
  | 'security_critical'
  | 'user_critical'
  | 'admin_critical'
  | 'non_critical';

export interface StorageProfileCapabilityStatusEntry {
  id: string;
  label: string;
  state: StorageProfileCapabilityState;
  criticality: StorageProfileCapabilityCriticality;
  detail: string;
}

export interface StorageProfileCapabilityStatus {
  profileId: string;
  deploymentProfile: StorageDeploymentProfile | 'legacy-custom';
  mvpReady: boolean;
  unsupportedCount: number;
  partialCount: number;
  capabilities: StorageProfileCapabilityStatusEntry[];
}

const TENANT_D1_UNSUPPORTED_ROUTE_CAPABILITIES: Array<{
  capabilityId: string;
  matches: (path: string) => boolean;
}> = [
  {
    capabilityId: 'device_ciba_cold_persistence',
    matches: (path) =>
      path === '/device_authorization' ||
      path === '/ciba' ||
      path.startsWith('/ciba/') ||
      path.startsWith('/api/ciba/'),
  },
  {
    capabilityId: 'admin_user_bulk_jobs',
    matches: (path) =>
      path === '/api/admin/jobs/users/import' ||
      path.startsWith('/api/admin/jobs/users/import/') ||
      path === '/api/admin/jobs/users/bulk-update',
  },
];

const SHARED_D1_CAPABILITIES: StorageProfileCapabilityStatusEntry[] = [
  {
    id: 'shared_d1_runtime',
    label: 'Shared D1 runtime persistence',
    state: 'supported',
    criticality: 'security_critical',
    detail: 'Existing runtime paths continue to use the deployment D1 bindings.',
  },
];

const TENANT_D1_CAPABILITIES: StorageProfileCapabilityStatusEntry[] = [
  {
    id: 'user_core_pii_resolution',
    label: 'User core and PII store resolution',
    state: 'supported',
    criticality: 'user_critical',
    detail: 'Request context resolves users_core and users_pii through the tenant DB registry.',
  },
  {
    id: 'tenant_database_health_and_stats',
    label: 'Tenant DB health and storage stats',
    state: 'supported',
    criticality: 'admin_critical',
    detail: 'Scheduled jobs collect tenant DB stats and deep health status into the control DB.',
  },
  {
    id: 'unsupported_runtime_guard',
    label: 'Unsupported storage profile guard',
    state: 'supported',
    criticality: 'security_critical',
    detail:
      'Tenant DB resolver failures return PII-free HTTP 409 responses instead of falling back.',
  },
  {
    id: 'session_clients',
    label: 'Session client tracking',
    state: 'supported',
    criticality: 'security_critical',
    detail:
      'SessionClientStore Durable Object is the primary logout-target index; D1 remains an optional mirror/fallback.',
  },
  {
    id: 'custom_claims',
    label: 'Custom claim durable storage',
    state: 'partial',
    criticality: 'user_critical',
    detail: 'Storage profile slices exist, but all runtime package paths are not fully routed yet.',
  },
  {
    id: 'device_ciba_cold_persistence',
    label: 'Device Flow and CIBA cold persistence',
    state: 'unsupported',
    criticality: 'security_critical',
    detail: 'Cold persistence still awaits deployment D1 and must be profile-controlled.',
  },
  {
    id: 'audit_hot_path',
    label: 'Audit hot-path routing',
    state: 'partial',
    criticality: 'admin_critical',
    detail:
      'Audit profiles exist, but legacy D1-first audit paths remain for high-volume deployments.',
  },
  {
    id: 'admin_user_bulk_jobs',
    label: 'Admin user import and bulk update jobs',
    state: 'unsupported',
    criticality: 'admin_critical',
    detail:
      'User import and bulk update jobs still need package-level tenant DB routing and must fail closed in tenant-d1 MVP.',
  },
  {
    id: 'transient_auth_state',
    label: 'Transient auth state D1 detach',
    state: 'planned',
    criticality: 'security_critical',
    detail:
      'Durable Objects own hot state, but D1 cold mirrors need profile-specific detachment policy.',
  },
];

const EXTERNAL_DURABLE_CAPABILITIES: StorageProfileCapabilityStatusEntry[] = [
  {
    id: 'external_core_pii_runtime',
    label: 'External core and PII runtime adapters',
    state: 'partial',
    criticality: 'security_critical',
    detail:
      'users_core and users_pii resolve through external database adapters, but the full route matrix is not production-certified yet.',
  },
  {
    id: 'external_custom_claims',
    label: 'External durable custom claims',
    state: 'supported',
    criticality: 'user_critical',
    detail:
      'Custom claim schema, non-PII field, and PII attribute reads resolve through external durable storage targets.',
  },
  {
    id: 'external_health_and_backup',
    label: 'External durable health and backup operations',
    state: 'partial',
    criticality: 'admin_critical',
    detail:
      'Storage target health probes exist. Database-native backup/replication remains operator-owned initially.',
  },
  {
    id: 'external_production_gates',
    label: 'External durable production gates',
    state: 'planned',
    criticality: 'admin_critical',
    detail:
      'Full route matrix certification, load validation, and operator runbooks remain before external-durable is MVP-ready.',
  },
];

function getDeploymentProfile(profile: StorageProfile): StorageDeploymentProfile | 'legacy-custom' {
  return profile.deploymentProfile ?? 'legacy-custom';
}

function capabilitiesForProfile(profile: StorageProfile): StorageProfileCapabilityStatusEntry[] {
  switch (getDeploymentProfile(profile)) {
    case 'shared-d1':
      return SHARED_D1_CAPABILITIES;
    case 'tenant-d1':
      return TENANT_D1_CAPABILITIES;
    case 'external-durable':
      return EXTERNAL_DURABLE_CAPABILITIES;
    default:
      return [
        {
          id: 'custom_profile_validation',
          label: 'Custom storage profile validation',
          state: 'planned',
          criticality: 'admin_critical',
          detail: 'Custom deployment profiles require explicit operator validation.',
        },
      ];
  }
}

export function describeStorageProfileCapabilityStatus(
  profile: StorageProfile
): StorageProfileCapabilityStatus {
  const capabilities = capabilitiesForProfile(profile);
  const unsupportedCount = capabilities.filter((item) => item.state === 'unsupported').length;
  const partialCount = capabilities.filter((item) => item.state === 'partial').length;
  const plannedCriticalCount = capabilities.filter(
    (item) => item.state === 'planned' && item.criticality !== 'non_critical'
  ).length;

  return {
    profileId: profile.id,
    deploymentProfile: getDeploymentProfile(profile),
    mvpReady: unsupportedCount === 0 && plannedCriticalCount === 0,
    unsupportedCount,
    partialCount,
    capabilities,
  };
}

export function findUnsupportedStorageProfileRouteCapability(
  profile: StorageProfile,
  path: string | undefined
): StorageProfileCapabilityStatusEntry | null {
  if (!path || getDeploymentProfile(profile) !== 'tenant-d1') {
    return null;
  }

  const capabilityStatus = describeStorageProfileCapabilityStatus(profile);
  for (const route of TENANT_D1_UNSUPPORTED_ROUTE_CAPABILITIES) {
    if (!route.matches(path)) {
      continue;
    }
    const capability = capabilityStatus.capabilities.find((item) => item.id === route.capabilityId);
    if (capability?.state === 'unsupported') {
      return capability;
    }
  }

  return null;
}
