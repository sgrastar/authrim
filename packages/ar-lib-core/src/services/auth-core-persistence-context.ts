import { ensureDatabaseAdapter, type DatabaseAdapter, type DatabaseSource } from '../db';
import type { RuntimeProfileResolverEnv } from './runtime-profile-resolver';
import {
  resolveTenantDatabaseSourceFromRegistry,
  type TenantDatabaseRequestCache,
} from './tenant-database-resolver';

export interface AuthCorePersistenceEnv extends RuntimeProfileResolverEnv {
  DB: DatabaseSource;
  DB_PII?: DatabaseSource;
  DB_ADMIN?: DatabaseSource;
  TENANT_RUNTIME_REGISTRY?: { get(key: string): Promise<string | null> };
  AUTHRIM_DEPLOYMENT_TARGET?: string;
}

export interface AuthCorePersistenceResolveOptions {
  tenantId?: string;
  requestCache?: TenantDatabaseRequestCache;
}

export async function resolveAuthCorePersistenceSourceFromEnv(
  env: AuthCorePersistenceEnv,
  options: AuthCorePersistenceResolveOptions = {}
): Promise<DatabaseSource> {
  if (options.tenantId) {
    const resolved = await resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId: options.tenantId,
      role: 'tenant_core',
      dataRole: 'tenant_core/default',
      shardGroup: 'default',
      shardIndex: 0,
      deploymentTarget: env.AUTHRIM_DEPLOYMENT_TARGET,
      requestCache: options.requestCache,
    });
    return resolved.source;
  }
  if (!env.DB_ADMIN) throw new Error('auth_core_admin_database_required');
  return env.DB_ADMIN;
}

export async function resolveAuthCorePersistenceAdapterFromEnv(
  env: AuthCorePersistenceEnv,
  partition: string = 'auth-core',
  options: AuthCorePersistenceResolveOptions = {}
): Promise<DatabaseAdapter> {
  const source = await resolveAuthCorePersistenceSourceFromEnv(env, options);
  return ensureDatabaseAdapter(source, partition);
}

export async function resolveTenantUserStoreSourcesFromEnv(
  env: AuthCorePersistenceEnv,
  tenantId: string,
  requestCache?: TenantDatabaseRequestCache
): Promise<{ coreDb: DatabaseSource; piiDb: DatabaseSource }> {
  const [core, pii] = await Promise.all([
    resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId,
      role: 'tenant_core',
      dataRole: 'tenant_core/users',
      shardGroup: 'default',
      shardIndex: 0,
      deploymentTarget: env.AUTHRIM_DEPLOYMENT_TARGET,
      requestCache,
    }),
    resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId,
      role: 'tenant_pii',
      dataRole: 'tenant_pii',
      shardGroup: 'default',
      shardIndex: 0,
      deploymentTarget: env.AUTHRIM_DEPLOYMENT_TARGET,
      requestCache,
    }),
  ]);
  return { coreDb: core.source, piiDb: pii.source };
}

// Compatibility name for integrations that now resolve through the Control Plane registry.
export const resolveUserStoreRuntimeSourcesFromEnv = resolveTenantUserStoreSourcesFromEnv;
