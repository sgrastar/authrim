/**
 * Trusted, read-only AWS account routing from a restored Lookup snapshot and PostgreSQL stores.
 * This is intentionally a small DR composition; it does not emulate D1 or the Control plane.
 */

import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import type { RuntimeDataPorts } from '@authrim/ar-lib-core/types/runtime-data-ports';
import {
  createLookupBlindIndexes,
  decodeActiveLookupMembershipRows,
  type LookupBlindIndex,
  type LookupBlindIndexKey,
  type LookupIdentifierRow,
  type ResolvedLookupMembership,
} from '@authrim/ar-lib-core/services/lookup-directory/index';
import { isValidPersistedUserId } from '@authrim/ar-lib-core/utils/id';

const TENANT_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const ACCOUNT_ID = /^account:[a-zA-Z0-9][a-zA-Z0-9._:-]{0,247}$/u;

export interface AwsDataTenantInventory {
  tenantId: string;
  allocationScope: 'shared_pool' | 'tenant_exclusive';
  /** PostgreSQL copy of the tenant metadata Core database. */
  metadataCoreDb: DatabaseAdapter;
  /** Explicit mapping from each imported Core route binding to its restored PostgreSQL copy. */
  accountCoreByBindingRef: Readonly<Record<string, DatabaseAdapter>>;
  /** Explicit mapping from each imported PII route binding to its restored PostgreSQL copy. */
  accountPiiByBindingRef: Readonly<Record<string, DatabaseAdapter>>;
  /** Active Lookup identifier rows imported from a consistent operator snapshot. */
  lookupRows: readonly LookupIdentifierRow[];
  /** Route generations independently copied from Core identity_accounts in that snapshot. */
  coreAccountRouteGenerations: Readonly<Record<string, number>>;
  /** Existing Lookup HMAC read keys for the same snapshot, including a rotation overlap key. */
  lookupReadKeys: readonly LookupBlindIndexKey[];
}

interface ActiveCoreAccountRow {
  id: string;
  legacy_user_id: string | null;
  lifecycle_state: string;
  directory_publication_state: string;
}

interface Target {
  bindingRef: string;
  residencyPartition: string;
  requiredBindingRouteGeneration: number;
}

function requirePostgres(db: DatabaseAdapter): void {
  if (db.getType() !== 'postgres') throw new Error('aws_data_postgres_required');
}

function normalizeAccountId(value: string): string {
  const accountId = value.startsWith('account:') ? value : `account:${value}`;
  if (!ACCOUNT_ID.test(accountId)) throw new Error('account_data_account_id_invalid');
  return accountId;
}

function lookupKey(index: LookupBlindIndex): string {
  return JSON.stringify([
    index.virtualBucket,
    index.indexKind,
    index.normalizationVersion,
    index.hmacKeyGeneration,
    index.digest,
  ]);
}

function chooseTarget(
  membership: ResolvedLookupMembership,
  role: 'tenant_core/users' | 'tenant_pii'
): Target {
  const targets = membership.routeProjection.targets.filter((target) => target.dataRole === role);
  // The first DR slice supports one destination of each role for an account. An ambiguous
  // multi-residency projection cannot silently choose a database.
  if (targets.length !== 1) throw new Error('aws_data_route_target_unsupported');
  return targets[0];
}

/**
 * Build the portability port from explicit database mappings and an already verified export.
 * The caller must verify snapshot integrity/freshness before serving traffic.
 */
export function createAwsRuntimeDataPorts(
  inventories: readonly AwsDataTenantInventory[]
): RuntimeDataPorts {
  if (inventories.length === 0) throw new Error('aws_data_inventory_required');
  const tenants = new Map<
    string,
    AwsDataTenantInventory & { rowsByIndex: Map<string, LookupIdentifierRow[]> }
  >();
  for (const inventory of inventories) {
    if (!TENANT_ID.test(inventory.tenantId) || tenants.has(inventory.tenantId)) {
      throw new Error('aws_data_tenant_inventory_invalid');
    }
    if (inventory.lookupReadKeys.length < 1 || inventory.lookupReadKeys.length > 2) {
      throw new Error('aws_data_lookup_key_inventory_invalid');
    }
    requirePostgres(inventory.metadataCoreDb);
    for (const db of Object.values(inventory.accountCoreByBindingRef)) requirePostgres(db);
    for (const db of Object.values(inventory.accountPiiByBindingRef)) requirePostgres(db);
    for (const [accountId, generation] of Object.entries(inventory.coreAccountRouteGenerations)) {
      if (!ACCOUNT_ID.test(accountId) || !Number.isSafeInteger(generation) || generation < 1) {
        throw new Error('aws_data_core_route_generation_invalid');
      }
    }
    const rowsByIndex = new Map<string, LookupIdentifierRow[]>();
    for (const row of inventory.lookupRows) {
      if (row.tenant_id !== inventory.tenantId) throw new Error('aws_data_lookup_tenant_mismatch');
      if (
        !Object.hasOwn(inventory.coreAccountRouteGenerations, row.account_id) ||
        inventory.coreAccountRouteGenerations[row.account_id] !==
          Number(row.account_route_generation)
      ) {
        throw new Error('aws_data_core_route_generation_mismatch');
      }
      const key = lookupKey({
        virtualBucket: Number(row.virtual_bucket),
        indexKind: row.index_kind as LookupBlindIndex['indexKind'],
        normalizationVersion: Number(row.normalization_version),
        hmacKeyGeneration: Number(row.hmac_key_generation),
        digest: row.identifier_blind_digest,
      });
      const rows = rowsByIndex.get(key) ?? [];
      rows.push(row);
      rowsByIndex.set(key, rows);
    }
    tenants.set(inventory.tenantId, { ...inventory, rowsByIndex });
  }

  function requireTenant(tenantId: string) {
    const tenant = tenants.get(tenantId);
    if (!tenant) throw new Error('aws_data_tenant_not_found');
    return tenant;
  }

  async function resolveMembership(input: Parameters<RuntimeDataPorts['resolveAccount']>[0]) {
    const tenant = requireTenant(input.tenantId);
    const indexes = await createLookupBlindIndexes(
      input.indexKind,
      input.identifier,
      tenant.lookupReadKeys
    );
    const matches = indexes.flatMap((index) =>
      decodeActiveLookupMembershipRows(tenant.rowsByIndex.get(lookupKey(index)) ?? [], index)
    );
    const unique = new Map<string, ResolvedLookupMembership>();
    for (const membership of matches) {
      if (membership.tenantId !== input.tenantId)
        throw new Error('aws_data_lookup_tenant_mismatch');
      if (
        tenant.coreAccountRouteGenerations[membership.accountId] !==
        membership.accountRouteGeneration
      ) {
        throw new Error('aws_data_core_route_generation_mismatch');
      }
      if (
        input.expectedAccountId !== undefined &&
        membership.accountId !== normalizeAccountId(input.expectedAccountId)
      ) {
        continue;
      }
      const prior = unique.get(membership.accountId);
      if (
        prior &&
        JSON.stringify(prior.routeProjection) !== JSON.stringify(membership.routeProjection)
      ) {
        throw new Error('account_data_route_ambiguous');
      }
      unique.set(membership.accountId, membership);
    }
    if (unique.size !== 1) {
      throw new Error(
        unique.size === 0 ? 'account_data_route_not_found' : 'account_data_route_ambiguous'
      );
    }
    return { tenant, membership: [...unique.values()][0] };
  }

  async function resolveCore(input: { tenantId: string; membership: ResolvedLookupMembership }) {
    const { tenantId, membership } = input;
    const tenant = requireTenant(tenantId);
    const target = chooseTarget(membership, 'tenant_core/users');
    const db = tenant.accountCoreByBindingRef[target.bindingRef];
    if (!db) throw new Error('aws_data_core_route_missing');
    const account = await db.queryOne<ActiveCoreAccountRow>(
      `SELECT id, legacy_user_id, lifecycle_state, directory_publication_state
         FROM identity_accounts WHERE tenant_id = ? AND id = ? LIMIT 1`,
      [tenantId, membership.accountId]
    );
    if (
      !account ||
      account.id !== membership.accountId ||
      account.lifecycle_state !== 'active' ||
      account.directory_publication_state !== 'active' ||
      !isValidPersistedUserId(account.legacy_user_id) ||
      account.id !== `account:${account.legacy_user_id}`
    ) {
      throw new Error('account_data_destination_account_inactive');
    }
    return { target, db, legacyUserId: account.legacy_user_id };
  }

  function resolvePii(input: { tenantId: string; membership: ResolvedLookupMembership }) {
    const tenant = requireTenant(input.tenantId);
    const target = chooseTarget(input.membership, 'tenant_pii');
    const db = tenant.accountPiiByBindingRef[target.bindingRef];
    if (!db) throw new Error('aws_data_pii_route_missing');
    return { target, db };
  }

  return {
    async resolveTenant(tenantId) {
      const tenant = requireTenant(tenantId);
      return {
        runtimeKind: 'portable',
        tenantId,
        coreDb: tenant.metadataCoreDb,
        route: { allocationScope: tenant.allocationScope },
      };
    },
    async resolveAccount(input) {
      const { membership } = await resolveMembership(input);
      const [core, pii] = await Promise.all([
        resolveCore({ tenantId: input.tenantId, membership }),
        Promise.resolve(resolvePii({ tenantId: input.tenantId, membership })),
      ]);
      return {
        tenantId: input.tenantId,
        accountId: membership.accountId,
        legacyUserId: core.legacyUserId,
        membership,
        coreDb: core.db,
        piiDb: pii.db,
        coreBindingRef: core.target.bindingRef,
        piiBindingRef: pii.target.bindingRef,
        coreResidencyPartition: core.target.residencyPartition,
        piiResidencyPartition: pii.target.residencyPartition,
        accountRouteGeneration: membership.accountRouteGeneration,
        userCacheScope: {
          routeGeneration: `account:${membership.accountRouteGeneration}`,
          bindingGeneration: `core:${core.target.requiredBindingRouteGeneration}:pii:${pii.target.requiredBindingRouteGeneration}`,
          schemaGeneration: `route:${membership.routeProjection.schemaVersion}`,
        },
        piiCacheMode: 'no_cross_request_pii',
      };
    },
    async resolveAccountCore(input) {
      const { membership } = await resolveMembership({
        tenantId: input.tenantId,
        indexKind: 'account_id',
        identifier: input.accountId,
        expectedAccountId: input.accountId,
        nowMs: input.nowMs,
      });
      const core = await resolveCore({ tenantId: input.tenantId, membership });
      return {
        tenantId: input.tenantId,
        accountId: membership.accountId,
        legacyUserId: core.legacyUserId,
        membership,
        coreDb: core.db,
        coreBindingRef: core.target.bindingRef,
        coreResidencyPartition: core.target.residencyPartition,
        accountRouteGeneration: membership.accountRouteGeneration,
      };
    },
    async resolveAccountPiiForAudit(input) {
      const { membership } = await resolveMembership({
        tenantId: input.tenantId,
        indexKind: 'account_id',
        identifier: input.accountId,
        expectedAccountId: input.accountId,
        nowMs: input.nowMs,
      });
      return resolvePii({ tenantId: input.tenantId, membership }).db;
    },
  };
}
