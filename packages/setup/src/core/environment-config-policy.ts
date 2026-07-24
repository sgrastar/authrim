import type { AuthrimConfig } from './config.js';

export function databaseTopologySnapshot(config: AuthrimConfig): object {
  return {
    database: config.database,
    tenantD1: config.tenantD1,
    storageDefault: config.profiles.defaults.storage,
    auditDefault: config.profiles.defaults.audit,
    storageProfiles: config.profiles.seed.storage,
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
