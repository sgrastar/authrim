import type { PreparedStatement } from '../db/adapter';

// Portable row validation and target-local SQL only. Keep backend adapters, bindings and
// physical-source authorization in guest-pii-erasure so Node restoration tools stay portable.
/** Raw authentication/profile sources. Historical delivery records retain their existing TTL. */
export const GUEST_PII_ERASURE_TABLES = [
  'users_pii',
  'identity_sensitive_values',
  'linked_identities',
  'subject_identifiers',
  'pairwise_subject_identifiers',
  'guest_upgrade_operations',
  'identity_identifier_replacement_challenges',
  'identity_identifier_replacement_operations',
  'identity_identifier_replacement_history',
  'identity_identifier_replacement_outbox',
  'external_identifier_unlink_operations',
  // Guest cleanup can remove its exact mapping; the general mapping API is not frozen.
  'user_anonymization_map',
] as const;
export type GuestPiiErasureTable = (typeof GUEST_PII_ERASURE_TABLES)[number];

export interface GuestPiiErasureMarker {
  schema_version: 1;
  tenant_id: string;
  user_id: string;
  account_id: string;
  account_route_generation: number;
  state: 'erasing' | 'deleted';
  revision: number;
  operation_id: string | null;
  boundary_id: string | null;
  source_started_at_ms: number | null;
  permit_table: GuestPiiErasureTable | null;
  permit_keys_json: string | null;
}

const MARKER = 'guest_pii_erasure_markers';
const EPOCH = 'guest_pii_mutation_epoch';
const rejected = (code: string): never => {
  throw new Error(`guest_pii_erasure_${code}`);
};
function id(value: unknown, maximum = 256): string {
  if (
    typeof value !== 'string' ||
    !value ||
    new TextEncoder().encode(value).byteLength > maximum ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return rejected('identity_invalid');
  return value;
}
function integer(value: unknown, minimum = 1): number {
  const number =
    typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < minimum)
    return rejected('revision_invalid');
  return number;
}
export function normalizeGuestPiiErasureMarker(
  row: Record<string, unknown>
): GuestPiiErasureMarker {
  const marker: GuestPiiErasureMarker = {
    schema_version: integer(row.schema_version) as 1,
    tenant_id: id(row.tenant_id),
    user_id: id(row.user_id),
    account_id: id(row.account_id, 512),
    account_route_generation: integer(row.account_route_generation),
    state: row.state as GuestPiiErasureMarker['state'],
    revision: integer(row.revision),
    operation_id: row.operation_id === null ? null : id(row.operation_id),
    boundary_id: row.boundary_id === null ? null : id(row.boundary_id),
    source_started_at_ms:
      row.source_started_at_ms === null ? null : integer(row.source_started_at_ms),
    permit_table: row.permit_table as GuestPiiErasureTable | null,
    permit_keys_json: row.permit_keys_json as string | null,
  };
  if (
    marker.schema_version !== 1 ||
    !['erasing', 'deleted'].includes(marker.state) ||
    (marker.state === 'deleted' &&
      [
        marker.operation_id,
        marker.boundary_id,
        marker.source_started_at_ms,
        marker.permit_table,
        marker.permit_keys_json,
      ].some((value) => value !== null)) ||
    (marker.state === 'erasing' &&
      [marker.operation_id, marker.boundary_id, marker.source_started_at_ms].some(
        (value) => value === null
      )) ||
    marker.permit_table !== null ||
    marker.permit_keys_json !== null
  )
    return rejected('marker_invalid');
  return marker;
}
function sqlGuard(sql: string, params: unknown[]): PreparedStatement {
  return {
    sql: `UPDATE ${EPOCH} SET revision=CASE WHEN (${sql}) THEN revision+1 ELSE NULL END WHERE id=1`,
    params,
  };
}
export type GuestPiiDeletedMarker = GuestPiiErasureMarker & { state: 'deleted' };
const MARKER_COLUMNS = [
  'schema_version',
  'tenant_id',
  'user_id',
  'account_id',
  'account_route_generation',
  'state',
  'revision',
  'operation_id',
  'boundary_id',
  'source_started_at_ms',
  'permit_table',
  'permit_keys_json',
] as const;

/** Closed DR row: no timestamps, operation identifiers or permits survive terminal compaction. */
export function normalizeGuestPiiDeletedMarker(value: unknown): GuestPiiDeletedMarker {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== MARKER_COLUMNS.length ||
    Object.keys(value).some((key) => !(MARKER_COLUMNS as readonly string[]).includes(key))
  )
    return rejected('terminal_invalid');
  const marker = normalizeGuestPiiErasureMarker(value as Record<string, unknown>);
  if (marker.state !== 'deleted') return rejected('terminal_invalid');
  return { ...marker, state: 'deleted' };
}

/** Trusted target-local lease predicate only; never accept HTTP SQL or an historical source permit. */
export function prepareRestoredGuestPiiDeletedMarker(
  value: unknown,
  targetGuard: { where: string; params: unknown[] }
): PreparedStatement[] {
  const marker = normalizeGuestPiiDeletedMarker(value);
  if (!targetGuard.where.trim()) return rejected('restore_guard_invalid');
  const identity = `schema_version=1 AND tenant_id=? AND user_id=? AND account_id=? AND account_route_generation=? AND state='deleted' AND revision=? AND operation_id IS NULL AND boundary_id IS NULL AND source_started_at_ms IS NULL AND permit_table IS NULL AND permit_keys_json IS NULL`;
  const exact = [
    marker.tenant_id,
    marker.user_id,
    marker.account_id,
    marker.account_route_generation,
    marker.revision,
  ];
  const collision = `tenant_id=? AND (user_id=? OR account_id=?)`;
  const collisionParams = [marker.tenant_id, marker.user_id, marker.account_id];
  return [
    sqlGuard(
      `(${targetGuard.where}) AND NOT EXISTS(SELECT 1 FROM ${MARKER} WHERE ${collision} AND NOT (${identity}))`,
      [...targetGuard.params, ...collisionParams, ...exact]
    ),
    {
      sql: `INSERT INTO ${MARKER}(${MARKER_COLUMNS.join(',')}) SELECT 1,?,?,?,?,'deleted',?,NULL,NULL,NULL,NULL,NULL WHERE (${targetGuard.where}) AND NOT EXISTS(SELECT 1 FROM ${MARKER} WHERE ${collision})`,
      params: [...exact, ...targetGuard.params, ...collisionParams],
    },
    sqlGuard(`(${targetGuard.where}) AND EXISTS(SELECT 1 FROM ${MARKER} WHERE ${identity})`, [
      ...targetGuard.params,
      ...exact,
    ]),
  ];
}
