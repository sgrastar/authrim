import type { AuthrimConfig } from './config.js';

export function databaseTopologySnapshot(config: AuthrimConfig): object {
  return {
    database: config.database,
    controlPlane: config.controlPlane,
    initialTenantPlacement: config.tenant.placementPolicy,
    auditDefault: config.profiles.defaults.audit,
    auditProfiles: config.profiles.seed.audit,
    hyperdriveReferences: config.profiles.references.hyperdrive,
  };
}

export function hasDatabaseTopologyChange(current: AuthrimConfig, next: AuthrimConfig): boolean {
  return (
    JSON.stringify(databaseTopologySnapshot(current)) !==
    JSON.stringify(databaseTopologySnapshot(next))
  );
}
