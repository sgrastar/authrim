import { ensureDatabaseAdapter, type DatabaseSource } from '../../db/adapter-source';
import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantDatabaseRole } from '../../repositories/admin/tenant-database-registry';
import {
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  type ResolvedTenantDatabaseSource,
  type TenantDatabaseResolverEnv,
} from '../tenant-database-resolver';

export interface BackupDatabaseAssignment {
  role: TenantDatabaseRole;
  dataRole: string;
  residencyPartition: string;
  shardId: string;
  assignmentGeneration: number;
  bindingRouteGeneration: number;
  generation: number;
  schemaVersion: number;
  bindingRef: string;
}
export interface BackupDatabaseResource {
  databaseId: string;
  runtimeGeneration: number;
  deploymentTarget: string | null;
  assignments: BackupDatabaseAssignment[];
  database: DatabaseAdapter;
}

/**
 * Resolve only the roles required by the installed module plan, from signed runtime inventory.
 * No binding-name guesses or fallback to a default DB. Fixed Admin/Control resources and external
 * databases require their own authorized resolvers; this function never silently substitutes them.
 */
export async function resolveBackupTenantDatabaseResources(
  env: TenantDatabaseResolverEnv,
  input: { tenantId: string; roles: readonly TenantDatabaseRole[]; signal: AbortSignal }
): Promise<BackupDatabaseResource[]> {
  if (
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(input.tenantId) ||
    !input.roles.length ||
    input.roles.length > 4 ||
    new Set(input.roles).size !== input.roles.length ||
    input.roles.some(
      (role) => !['tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom'].includes(role)
    )
  )
    throw new Error('backup_resource_invalid_request');
  const resources = new Map<string, BackupDatabaseResource>();
  const bindings = new Map<string, string>();
  const routes = new Set<string>();
  let generation: number | undefined;
  let target: string | null | undefined;
  let count = 0;
  for (const role of [...input.roles].sort()) {
    input.signal.throwIfAborted();
    const stores = await resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
      tenantId: input.tenantId,
      role,
      maxStores: 64,
      concurrency: 4,
    });
    for (const store of stores) {
      input.signal.throwIfAborted();
      const id = store.registryRow.database_id;
      if (
        !id ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
        store.tenantId !== input.tenantId ||
        store.role !== role ||
        store.driver !== 'd1' ||
        store.registryRow.provider !== 'd1' ||
        store.healthStatus !== 'active' ||
        store.resolutionSource !== 'runtime_registry'
      )
        throw new Error('backup_resource_invalid_assignment');
      if (++count > 64) throw new Error('backup_resource_limit');
      if (
        generation !== undefined &&
        (generation !== store.runtimeGeneration || target !== store.deploymentTarget)
      )
        throw new Error('backup_resource_generation_changed');
      generation = store.runtimeGeneration;
      target = store.deploymentTarget;
      if (bindings.has(store.bindingRef) && bindings.get(store.bindingRef) !== id)
        throw new Error('backup_resource_binding_conflict');
      bindings.set(store.bindingRef, id);
      const assignment = describeAssignment(store);
      const route = JSON.stringify([
        assignment.role,
        assignment.dataRole,
        assignment.residencyPartition,
        assignment.shardId,
      ]);
      if (routes.has(route)) throw new Error('backup_resource_duplicate_assignment');
      routes.add(route);
      const resource = resources.get(id);
      if (resource) resource.assignments.push(assignment);
      else
        resources.set(id, {
          databaseId: id,
          runtimeGeneration: store.runtimeGeneration,
          deploymentTarget: store.deploymentTarget,
          assignments: [assignment],
          database: adapt(store.source),
        });
    }
  }
  input.signal.throwIfAborted();
  if (!resources.size) throw new Error('backup_resource_missing_assignment');
  return [...resources.values()]
    .sort((a, b) => a.databaseId.localeCompare(b.databaseId))
    .map((resource) => ({
      ...resource,
      assignments: resource.assignments.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      ),
    }));
}
function adapt(source: DatabaseSource): DatabaseAdapter {
  return ensureDatabaseAdapter(source, 'tenant-backup');
}
function describeAssignment(store: ResolvedTenantDatabaseSource): BackupDatabaseAssignment {
  return {
    role: store.role,
    dataRole: store.dataRole,
    residencyPartition: store.residencyPartition,
    shardId: store.shardId,
    assignmentGeneration: store.assignmentGeneration,
    bindingRouteGeneration: store.bindingRouteGeneration,
    generation: store.generation,
    schemaVersion: store.schemaVersion,
    bindingRef: store.bindingRef,
  };
}

/** Private operation metadata; live adapter handles and signing/connection secrets are excluded. */
export function backupDatabaseResourceDescriptor(resource: BackupDatabaseResource): string {
  return JSON.stringify({
    version: 1,
    databaseId: resource.databaseId,
    runtimeGeneration: resource.runtimeGeneration,
    deploymentTarget: resource.deploymentTarget,
    assignments: resource.assignments,
  });
}

/** Persist descriptors before table inventories; retries must resolve exactly the same assignments. */
export async function persistBackupDatabaseResources(
  inventory: import('./execution-inventory').TenantBackupExecutionInventory,
  firstOrdinal: number,
  resources: readonly BackupDatabaseResource[]
): Promise<number> {
  if (
    !Number.isInteger(firstOrdinal) ||
    firstOrdinal < 0 ||
    !resources.length ||
    resources.length > 64 ||
    firstOrdinal + resources.length > 4096 ||
    new Set(resources.map((resource) => resource.databaseId)).size !== resources.length
  )
    throw new Error('backup_resource_invalid_inventory');
  for (const [offset, resource] of [...resources]
    .sort((a, b) => a.databaseId.localeCompare(b.databaseId))
    .entries())
    await inventory.append(
      firstOrdinal + offset,
      `database:${resource.databaseId}`,
      backupDatabaseResourceDescriptor(resource)
    );
  return firstOrdinal + resources.length;
}
