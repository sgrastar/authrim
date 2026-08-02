import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  loadVerifiedLookupBucketAssignmentProvider,
  type ControlTenantDeletionLookupShardTarget,
  type Env,
} from '@authrim/ar-lib-core';

const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

interface RemainingLookupRows {
  live_identifier_count: number;
  live_alias_count: number;
  live_reservation_count: number;
}

function primarySession(env: Env, bindingRef: string): D1DatabaseSession {
  if (!SAFE_BINDING.test(bindingRef)) {
    throw new Error('tenant_deletion_lookup_binding_invalid');
  }
  const value = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!value || typeof value !== 'object') {
    throw new Error('tenant_deletion_lookup_binding_unavailable');
  }
  const database = value as Partial<D1Database>;
  if (typeof database.withSession !== 'function') {
    throw new Error('tenant_deletion_lookup_binding_unavailable');
  }
  const session = database.withSession('first-primary');
  if (typeof session.prepare !== 'function' || typeof session.batch !== 'function') {
    throw new Error('tenant_deletion_lookup_binding_unavailable');
  }
  return session;
}

function strictShardRows(
  rows: ControlTenantDeletionLookupShardTarget[]
): ControlTenantDeletionLookupShardTarget[] {
  if (rows.length < 1) throw new Error('tenant_deletion_lookup_shards_unavailable');
  const shardIds = new Set<string>();
  const bindingRefs = new Set<string>();
  return rows.map((row) => {
    if (
      !SAFE_ID.test(row.lookupShardId) ||
      !SAFE_BINDING.test(row.bindingRef) ||
      (row.status !== 'ready' && row.status !== 'active' && row.status !== 'draining') ||
      shardIds.has(row.lookupShardId) ||
      bindingRefs.has(row.bindingRef)
    ) {
      throw new Error('tenant_deletion_lookup_shards_invalid');
    }
    shardIds.add(row.lookupShardId);
    bindingRefs.add(row.bindingRef);
    return row;
  });
}

async function disableTenantRowsOnShard(
  session: D1DatabaseSession,
  tenantId: string,
  now: number
): Promise<void> {
  await session.batch([
    session
      .prepare(
        `UPDATE lookup_identifiers
            SET tenant_lifecycle_state = 'disabled',
                runtime_route_status = 'disabled',
                lifecycle_state = 'disabled',
                disabled_at = COALESCE(disabled_at, ?),
                updated_at = ?
          WHERE tenant_id = ? AND (
                tenant_lifecycle_state <> 'disabled' OR
                runtime_route_status <> 'disabled' OR
                lifecycle_state <> 'disabled'
          )`
      )
      .bind(now, now, tenantId),
    session
      .prepare(
        `UPDATE lookup_tenant_aliases
            SET tenant_lifecycle_state = 'disabled',
                runtime_route_status = 'disabled',
                lifecycle_state = 'disabled',
                updated_at = ?
          WHERE tenant_id = ? AND (
                tenant_lifecycle_state <> 'disabled' OR
                runtime_route_status <> 'disabled' OR
                lifecycle_state <> 'disabled'
          )`
      )
      .bind(now, tenantId),
    session
      .prepare(
        `UPDATE lookup_identifier_reservations
            SET reservation_state = 'released',
                lease_expires_at = NULL,
                released_at = COALESCE(released_at, ?),
                updated_at = ?
          WHERE tenant_id = ? AND reservation_state <> 'released'`
      )
      .bind(now, now, tenantId),
  ]);

  const remaining = await session
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM lookup_identifiers
           WHERE tenant_id = ? AND (
             tenant_lifecycle_state <> 'disabled' OR
             runtime_route_status <> 'disabled' OR
             lifecycle_state <> 'disabled'
           )) AS live_identifier_count,
         (SELECT COUNT(*) FROM lookup_tenant_aliases
           WHERE tenant_id = ? AND (
             tenant_lifecycle_state <> 'disabled' OR
             runtime_route_status <> 'disabled' OR
             lifecycle_state <> 'disabled'
           )) AS live_alias_count,
         (SELECT COUNT(*) FROM lookup_identifier_reservations
           WHERE tenant_id = ? AND reservation_state <> 'released') AS live_reservation_count`
    )
    .bind(tenantId, tenantId, tenantId)
    .first<RemainingLookupRows>();

  if (
    !remaining ||
    remaining.live_identifier_count !== 0 ||
    remaining.live_alias_count !== 0 ||
    remaining.live_reservation_count !== 0
  ) {
    throw new Error('tenant_deletion_lookup_cleanup_not_reflected');
  }
}

/**
 * Disables every runtime-discoverable row before authoritative tenant data is purged.
 * The control inventory includes migration mirrors that may not be present in the active snapshot.
 */
export async function disableTenantLookupDirectory(
  env: Env,
  inventoryRows: ControlTenantDeletionLookupShardTarget[],
  tenantId: string
): Promise<void> {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (
    !environmentId ||
    !SAFE_ID.test(environmentId) ||
    !SAFE_ID.test(tenantId) ||
    !env.TENANT_RUNTIME_REGISTRY ||
    !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS
  ) {
    throw new Error('tenant_deletion_lookup_cleanup_unavailable');
  }

  const assignments = await loadVerifiedLookupBucketAssignmentProvider({
    store: env.TENANT_RUNTIME_REGISTRY,
    environmentId,
    publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
  });
  const rows = strictShardRows(inventoryRows);

  const inventory = new Map(rows.map((row) => [row.lookupShardId, row.bindingRef]));
  for (const range of assignments.listActiveRanges()) {
    if (inventory.get(range.lookupShardId) !== range.bindingRef) {
      throw new Error('tenant_deletion_lookup_registry_inventory_mismatch');
    }
  }

  const sessions = rows.map((row) => primarySession(env, row.bindingRef));
  const now = Math.floor(Date.now() / 1000);
  for (const session of sessions) {
    await disableTenantRowsOnShard(session, tenantId, now);
  }
}
