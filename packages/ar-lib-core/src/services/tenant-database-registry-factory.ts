import { ensureDatabaseAdapter, type DatabaseSource } from '../db/adapter-source';
import { TenantDatabaseRegistryRepository } from '../repositories/admin/tenant-database-registry';

export interface TenantDatabaseRegistryRepositoryEnv {
  DB_ADMIN?: DatabaseSource;
}

export function createTenantDatabaseRegistryRepository(
  env: TenantDatabaseRegistryRepositoryEnv,
  partition: string = 'tenant-database-registry'
): TenantDatabaseRegistryRepository {
  if (!env.DB_ADMIN) {
    throw new Error('DB_ADMIN is required to resolve tenant database registry');
  }
  return new TenantDatabaseRegistryRepository(ensureDatabaseAdapter(env.DB_ADMIN, partition));
}
