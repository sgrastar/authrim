import { ensureDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import { createTenantPlacementMigrationSagaDependencies } from './tenant-placement-migration-dependencies';
import { TenantPlacementMigrationJobRepository } from './tenant-placement-migration-job';
import { runTenantPlacementMigrationSaga } from './tenant-placement-migration-orchestrator';

export async function processNextTenantPlacementMigration(env: Env): Promise<boolean> {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId) throw new Error('tenant_placement_migration_environment_missing');
  if (!env.DB_ADMIN) throw new Error('tenant_placement_migration_admin_db_missing');

  const platformAdapter = ensureDatabaseAdapter(env.DB, 'tenant-placement-migration-platform');
  const adminAdapter = ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-placement-migration-admin');
  const repository = new TenantPlacementMigrationJobRepository(adminAdapter);
  const lease = await repository.claimNext(
    environmentId,
    `management:${crypto.randomUUID()}`,
    Math.floor(Date.now() / 1000)
  );
  if (!lease) return false;

  await runTenantPlacementMigrationSaga({
    env,
    repository,
    lease,
    dependencies: createTenantPlacementMigrationSagaDependencies(
      env,
      platformAdapter,
      adminAdapter
    ),
    now: () => Math.floor(Date.now() / 1000),
  });
  return true;
}
