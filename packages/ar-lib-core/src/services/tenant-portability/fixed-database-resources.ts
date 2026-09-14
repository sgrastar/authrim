import { ensureDatabaseAdapter, isDatabaseSource } from '../../db/adapter-source';
import type { DatabaseAdapter } from '../../db/adapter';
import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract';
import type { TenantBackupExecutionInventory } from './execution-inventory';

const FAMILIES = {
  DB: 'core',
  DB_PII: 'pii',
  DB_ADMIN: 'admin',
  CONTROL_DB: 'control',
  LOOKUP_DB: 'lookup',
  PLUGIN_RUNNER_DB: 'plugin_runner',
} as const satisfies Record<string, MigrationSchemaFamily>;
export type FixedBackupDatabaseBinding = keyof typeof FAMILIES;
export interface FixedBackupDatabaseResource {
  binding: FixedBackupDatabaseBinding;
  family: MigrationSchemaFamily;
  databaseId: string;
  database: DatabaseAdapter;
}
/** Resolve only bindings owned by the calling Worker, using Setup's generated resource identities. */
export function resolveFixedBackupDatabaseResources(
  env: { AUTHRIM_FIXED_DATABASE_IDS?: string },
  requested: readonly FixedBackupDatabaseBinding[]
): FixedBackupDatabaseResource[] {
  if (
    !requested.length ||
    requested.length > 6 ||
    new Set(requested).size !== requested.length ||
    requested.some((binding) => !Object.hasOwn(FAMILIES, binding))
  )
    throw new Error('backup_fixed_database_invalid_request');
  const raw = env.AUTHRIM_FIXED_DATABASE_IDS;
  if (!raw || raw.length > 4096) throw new Error('backup_fixed_database_metadata_missing');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('backup_fixed_database_metadata_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('backup_fixed_database_metadata_invalid');
  const metadata = value as Record<string, unknown>;
  if (
    Object.keys(metadata).length !== 2 ||
    metadata.version !== 1 ||
    !metadata.databases ||
    typeof metadata.databases !== 'object' ||
    Array.isArray(metadata.databases)
  )
    throw new Error('backup_fixed_database_metadata_invalid');
  const ids = metadata.databases as Record<string, unknown>;
  if (
    Object.keys(ids).length > 6 ||
    Object.entries(ids).some(
      ([binding, id]) =>
        !Object.hasOwn(FAMILIES, binding) ||
        typeof id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(id)
    )
  )
    throw new Error('backup_fixed_database_metadata_invalid');
  const resources = requested.map((binding) => {
    const source = (env as Record<string, unknown>)[binding];
    const databaseId = ids[binding];
    if (typeof databaseId !== 'string' || !isDatabaseSource(source))
      throw new Error('backup_fixed_database_binding_missing');
    const database = ensureDatabaseAdapter(source, 'tenant-backup-fixed');
    if (database.getType() !== 'd1') throw new Error('backup_fixed_database_provider_mismatch');
    return {
      binding,
      family: FAMILIES[binding],
      databaseId,
      database,
    };
  });
  if (new Set(resources.map((resource) => resource.databaseId)).size !== resources.length)
    throw new Error('backup_fixed_database_role_conflict');
  return resources.sort((a, b) => a.binding.localeCompare(b.binding));
}

/** Keep provider identity separate from portable tenant data and reject changed bindings on retry. */
export async function persistFixedBackupDatabaseResources(
  inventory: TenantBackupExecutionInventory,
  firstOrdinal: number,
  resources: readonly FixedBackupDatabaseResource[]
): Promise<number> {
  if (
    !Number.isInteger(firstOrdinal) ||
    firstOrdinal < 0 ||
    !resources.length ||
    resources.length > 6 ||
    firstOrdinal + resources.length > 4096 ||
    new Set(resources.map((resource) => resource.binding)).size !== resources.length
  )
    throw new Error('backup_fixed_database_invalid_inventory');
  for (const [offset, resource] of [...resources]
    .sort((a, b) => a.binding.localeCompare(b.binding))
    .entries())
    await inventory.append(
      firstOrdinal + offset,
      `fixed-database:${resource.binding}`,
      fixedBackupDatabaseResourceDescriptor(resource)
    );
  return firstOrdinal + resources.length;
}

export function fixedBackupDatabaseResourceDescriptor(
  resource: FixedBackupDatabaseResource
): string {
  return JSON.stringify({
    version: 1,
    binding: resource.binding,
    family: resource.family,
    databaseId: resource.databaseId,
  });
}
