import type { D1Database } from '@cloudflare/workers-types';
import {
  createD1ConsistencyRequest,
  validateAccountRouteProjection,
  validateTenantAliasRouteProjection,
  type AccountRouteProjection,
  type D1ConsistencyRequest,
  type LookupLifecycleState,
  type TenantAliasRouteProjection,
} from '../control-plane/control-plane-contracts';
import type { LookupAliasIndex, LookupBlindIndex } from './blind-index';
import { D1SessionReadRepository } from './d1-session-repository';

const MAX_EXACT_MEMBERSHIPS = 100;
const MAX_ALIAS_RESULTS = 128;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

export interface LookupIdentifierRow {
  virtual_bucket: number | string;
  index_kind: string;
  normalization_version: number | string;
  hmac_key_generation: number | string;
  identifier_blind_digest: string;
  tenant_id: string;
  account_id: string;
  route_schema_version: number | string;
  account_route_generation: number | string;
  required_binding_route_generation: number | string;
  residency_policy_id: string;
  route_projection_json: string;
  tenant_lifecycle_state: string;
  runtime_route_status: string;
  lifecycle_state: LookupLifecycleState;
}

interface LookupAliasRow {
  virtual_bucket: number | string;
  alias_kind: string;
  alias_sha256_digest: string;
  tenant_id: string;
  route_schema_version: number | string;
  route_projection_json: string;
  tenant_lifecycle_state: string;
  runtime_route_status: string;
  lifecycle_state: LookupLifecycleState;
}

export interface ResolvedLookupMembership {
  tenantId: string;
  accountId: string;
  routeProjection: AccountRouteProjection;
  accountRouteGeneration: number;
  hmacKeyGeneration: number;
  normalizationVersion: number;
}

export interface ResolvedLookupAlias {
  tenantId: string;
  routeProjection: TenantAliasRouteProjection;
}

function decodeActiveLookupAliasRows(
  rows: readonly LookupAliasRow[],
  index: LookupAliasIndex,
  maximumResults: number
): ResolvedLookupAlias[] {
  if (rows.length > maximumResults) throw new Error('lookup_alias_result_limit_exceeded');
  return rows.map((row) => {
    const routeProjection = decodeTenantAliasProjection(row.route_projection_json);
    if (
      !SAFE_IDENTIFIER.test(row.tenant_id) ||
      strictBucket(row.virtual_bucket) !== index.virtualBucket ||
      row.alias_kind !== index.aliasKind ||
      row.alias_sha256_digest !== index.digest ||
      row.lifecycle_state !== 'active' ||
      row.tenant_lifecycle_state !== 'active' ||
      row.runtime_route_status !== 'active' ||
      routeProjection.schemaVersion !==
        strictPositiveInteger(row.route_schema_version, 'lookup_route_schema_version_invalid')
    ) {
      throw new Error('lookup_alias_row_inconsistent');
    }
    return { tenantId: row.tenant_id, routeProjection };
  });
}

export function decodeActiveLookupMembershipRows(
  rows: readonly LookupIdentifierRow[],
  index: LookupBlindIndex
): ResolvedLookupMembership[] {
  if (rows.length > MAX_EXACT_MEMBERSHIPS) {
    throw new Error('lookup_exact_membership_limit_exceeded');
  }
  return rows.map((row) => decodeMembership(row, index));
}

function strictPositiveInteger(value: number | string, code: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(code);
  return number;
}

function strictBucket(value: number | string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 4095) {
    throw new Error('lookup_row_bucket_invalid');
  }
  return number;
}

function decodeProjection(value: string): AccountRouteProjection {
  if (value.length > 16_384) throw new Error('lookup_route_projection_too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('lookup_route_projection_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('lookup_route_projection_invalid');
  }
  return validateAccountRouteProjection(parsed as AccountRouteProjection);
}

function decodeTenantAliasProjection(value: string): TenantAliasRouteProjection {
  if (value.length > 16_384) throw new Error('lookup_route_projection_too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('lookup_route_projection_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('lookup_route_projection_invalid');
  }
  return validateTenantAliasRouteProjection(parsed as TenantAliasRouteProjection);
}

function decodeMembership(
  row: LookupIdentifierRow,
  expected: LookupBlindIndex
): ResolvedLookupMembership {
  const routeProjection = decodeProjection(row.route_projection_json);
  const accountRouteGeneration = strictPositiveInteger(
    row.account_route_generation,
    'lookup_account_route_generation_invalid'
  );
  const requiredGeneration = strictPositiveInteger(
    row.required_binding_route_generation,
    'lookup_binding_route_generation_invalid'
  );
  const maximumTargetGeneration = Math.max(
    ...routeProjection.targets.map((target) => target.requiredBindingRouteGeneration)
  );
  if (
    !SAFE_IDENTIFIER.test(row.tenant_id) ||
    !SAFE_IDENTIFIER.test(row.account_id) ||
    strictBucket(row.virtual_bucket) !== expected.virtualBucket ||
    row.index_kind !== expected.indexKind ||
    strictPositiveInteger(row.normalization_version, 'lookup_normalization_version_invalid') !==
      expected.normalizationVersion ||
    strictPositiveInteger(row.hmac_key_generation, 'lookup_hmac_key_generation_invalid') !==
      expected.hmacKeyGeneration ||
    row.identifier_blind_digest !== expected.digest ||
    row.lifecycle_state !== 'active' ||
    row.tenant_lifecycle_state !== 'active' ||
    row.runtime_route_status !== 'active' ||
    routeProjection.schemaVersion !==
      strictPositiveInteger(row.route_schema_version, 'lookup_route_schema_version_invalid') ||
    routeProjection.accountRouteGeneration !== accountRouteGeneration ||
    routeProjection.residencyPolicyId !== row.residency_policy_id ||
    maximumTargetGeneration !== requiredGeneration
  ) {
    throw new Error('lookup_identifier_row_inconsistent');
  }
  return {
    tenantId: row.tenant_id,
    accountId: row.account_id,
    routeProjection,
    accountRouteGeneration,
    hmacKeyGeneration: expected.hmacKeyGeneration,
    normalizationVersion: expected.normalizationVersion,
  };
}

function projectionIdentity(value: ResolvedLookupMembership): string {
  return JSON.stringify({
    tenantId: value.tenantId,
    accountId: value.accountId,
    accountRouteGeneration: value.accountRouteGeneration,
    routeProjection: value.routeProjection,
  });
}

export class LookupDirectoryRepository {
  private readonly sessions: D1SessionReadRepository;

  constructor(db: Pick<D1Database, 'withSession'>) {
    this.sessions = new D1SessionReadRepository(db);
  }

  async findActiveMemberships(
    index: LookupBlindIndex,
    consistency: D1ConsistencyRequest = createD1ConsistencyRequest('replica_eligible')
  ): Promise<{ memberships: ResolvedLookupMembership[]; primaryRechecked: boolean }> {
    const result = await this.sessions.query<LookupIdentifierRow>({
      sql: `SELECT virtual_bucket, index_kind, normalization_version, hmac_key_generation,
                   identifier_blind_digest, tenant_id, account_id, route_schema_version,
                   account_route_generation, required_binding_route_generation,
                   residency_policy_id, route_projection_json, tenant_lifecycle_state,
                   runtime_route_status, lifecycle_state
              FROM lookup_identifiers
             WHERE virtual_bucket = ? AND index_kind = ? AND normalization_version = ?
               AND hmac_key_generation = ? AND identifier_blind_digest = ?
               AND lifecycle_state = 'active'
             ORDER BY tenant_id, account_id
             LIMIT ?`,
      params: [
        index.virtualBucket,
        index.indexKind,
        index.normalizationVersion,
        index.hmacKeyGeneration,
        index.digest,
        MAX_EXACT_MEMBERSHIPS + 1,
      ],
      consistency,
      primaryRecheckOnEmpty: true,
    });
    return {
      memberships: decodeActiveLookupMembershipRows(result.rows, index),
      primaryRechecked: result.primaryRechecked,
    };
  }

  async findActiveAlias(
    index: LookupAliasIndex,
    consistency: D1ConsistencyRequest = createD1ConsistencyRequest('replica_eligible')
  ): Promise<{ aliases: ResolvedLookupAlias[]; primaryRechecked: boolean }> {
    const result = await this.sessions.query<LookupAliasRow>({
      sql: `SELECT virtual_bucket, alias_kind, alias_sha256_digest, tenant_id,
                   route_schema_version, route_projection_json, tenant_lifecycle_state,
                   runtime_route_status, lifecycle_state
              FROM lookup_tenant_aliases
             WHERE virtual_bucket = ? AND alias_kind = ? AND alias_sha256_digest = ?
               AND lifecycle_state = 'active'
             ORDER BY tenant_id
             LIMIT 2`,
      params: [index.virtualBucket, index.aliasKind, index.digest],
      consistency,
      primaryRecheckOnEmpty: true,
    });
    if (result.rows.length > 1) throw new Error('lookup_alias_not_unique');
    return {
      aliases: decodeActiveLookupAliasRows(result.rows, index, 1),
      primaryRechecked: result.primaryRechecked,
    };
  }

  async findActiveAliases(
    index: LookupAliasIndex,
    maximumResults: number,
    consistency: D1ConsistencyRequest = createD1ConsistencyRequest('replica_eligible'),
    afterTenantId?: string
  ): Promise<{ aliases: ResolvedLookupAlias[]; primaryRechecked: boolean }> {
    if (
      !Number.isSafeInteger(maximumResults) ||
      maximumResults < 1 ||
      maximumResults > MAX_ALIAS_RESULTS
    ) {
      throw new Error('lookup_alias_result_limit_invalid');
    }
    if (afterTenantId !== undefined && !SAFE_IDENTIFIER.test(afterTenantId)) {
      throw new Error('lookup_alias_cursor_invalid');
    }
    const cursorClause = afterTenantId === undefined ? '' : 'AND tenant_id > ?';
    const params = [index.virtualBucket, index.aliasKind, index.digest];
    if (afterTenantId !== undefined) params.push(afterTenantId);
    params.push(maximumResults + 1);
    const result = await this.sessions.query<LookupAliasRow>({
      sql: `SELECT virtual_bucket, alias_kind, alias_sha256_digest, tenant_id,
                   route_schema_version, route_projection_json, tenant_lifecycle_state,
                   runtime_route_status, lifecycle_state
              FROM lookup_tenant_aliases
             WHERE virtual_bucket = ? AND alias_kind = ? AND alias_sha256_digest = ?
               AND lifecycle_state = 'active'
               ${cursorClause}
             ORDER BY tenant_id
             LIMIT ?`,
      params,
      consistency,
      primaryRecheckOnEmpty: true,
    });
    return {
      aliases: decodeActiveLookupAliasRows(result.rows, index, maximumResults),
      primaryRechecked: result.primaryRechecked,
    };
  }
}

export function mergeRotatingLookupMemberships(
  resultSets: readonly (readonly ResolvedLookupMembership[])[]
): ResolvedLookupMembership[] {
  if (resultSets.length < 1 || resultSets.length > 2) {
    throw new Error('lookup_rotation_result_set_count_invalid');
  }
  const merged = new Map<string, ResolvedLookupMembership>();
  for (const membership of resultSets.flat()) {
    const key = `${membership.tenantId}\0${membership.accountId}`;
    const existing = merged.get(key);
    if (existing && projectionIdentity(existing) !== projectionIdentity(membership)) {
      throw new Error('lookup_rotation_route_conflict');
    }
    if (!existing || membership.hmacKeyGeneration > existing.hmacKeyGeneration) {
      merged.set(key, membership);
    }
  }
  return Array.from(merged.values()).sort(
    (left, right) =>
      left.tenantId.localeCompare(right.tenantId) || left.accountId.localeCompare(right.accountId)
  );
}
