import type { DatabaseAdapter, PreparedStatement } from '../db/adapter';
import { PostgresAdapter } from '../db/adapters/postgres-adapter';
import {
  guestErasureBoundaryId,
  parseGuestPhysicalPinV2,
  type GuestErasureSourceReceipt,
  type GuestPhysicalPinV2,
  type GuestErasureDrainReceipt,
  type GuestErasureCompletionReceipt,
} from './guest-deletion-receipt';

import {
  GUEST_PII_ERASURE_TABLES,
  normalizeGuestPiiErasureMarker as normalizeMarker,
  normalizeGuestPiiDeletedMarker,
  type GuestPiiErasureTable,
  type GuestPiiErasureMarker,
  type GuestPiiDeletedMarker,
} from './guest-pii-erasure-marker';
export {
  GUEST_PII_ERASURE_TABLES,
  normalizeGuestPiiDeletedMarker,
  prepareRestoredGuestPiiDeletedMarker,
  type GuestPiiErasureTable,
  type GuestPiiErasureMarker,
  type GuestPiiDeletedMarker,
} from './guest-pii-erasure-marker';

export const GUEST_PII_ERASURE_PAGE_SIZE = 16;

export interface GuestPiiErasurePage {
  expectedRevision: number;
  table: GuestPiiErasureTable;
  /** Exact, non-null text primary keys captured by the authorized bounded Core page. */
  keys: readonly string[];
}
export interface GuestPiiErasurePort {
  tables(): Promise<readonly GuestPiiErasureTable[]>;
  listPage(
    receipt: GuestErasureSourceReceipt,
    request: GuestPiiKeyPageRequest
  ): Promise<GuestPiiKeyPage>;
  start(receipt: GuestErasureSourceReceipt): Promise<GuestPiiErasureMarker>;
  get(receipt: GuestErasureSourceReceipt): Promise<GuestPiiErasureMarker | null>;
  drainPage(
    receipt: GuestErasureDrainReceipt,
    page: GuestPiiErasurePage
  ): Promise<GuestPiiErasureMarker>;
  complete(
    receipt: GuestErasureCompletionReceipt,
    input: { expectedRevision: number }
  ): Promise<GuestPiiErasureMarker>;
}

const PG_TABLES: readonly GuestPiiErasureTable[] = GUEST_PII_ERASURE_TABLES.slice(0, 6);
// Closed PG profile 001..007. Workflow schemas added later need their own reviewed guards.
const PG_COLUMN_PROFILE: Readonly<Record<string, string>> = {
  users_pii:
    'id:text:NO,tenant_id:text:NO,pii_class:text:NO,email:text:NO,email_blind_index:text:YES,phone_number:text:YES,name:text:YES,given_name:text:YES,family_name:text:YES,middle_name:text:YES,nickname:text:YES,preferred_username:text:YES,profile:text:YES,picture:text:YES,website:text:YES,gender:text:YES,birthdate:text:YES,locale:text:YES,zoneinfo:text:YES,address_formatted:text:YES,address_street_address:text:YES,address_locality:text:YES,address_region:text:YES,address_postal_code:text:YES,address_country:text:YES,declared_residence:text:YES,custom_attributes_json:jsonb:YES,created_at:int8:NO,updated_at:int8:NO',
  identity_sensitive_values:
    'id:text:NO,tenant_id:text:NO,owner_type:text:NO,owner_id:text:NO,value_key:text:NO,value_json:jsonb:YES,value_hash:text:YES,classification:text:NO,lifecycle_state:text:NO,created_at:int8:NO,updated_at:int8:NO',
  linked_identities:
    'id:text:NO,tenant_id:text:NO,user_id:text:NO,provider_id:text:NO,provider_user_id:text:NO,provider_email:text:YES,provider_name:text:YES,raw_attributes:jsonb:YES,linked_at:int8:NO,last_used_at:int8:YES,email_verified:bool:NO,access_token_encrypted:text:YES,refresh_token_encrypted:text:YES,token_expires_at:int8:YES,raw_claims:jsonb:YES,profile_data:jsonb:YES,last_login_at:int8:YES,updated_at:int8:YES,provisioning_state:text:NO',
  pairwise_subject_identifiers:
    'id:text:NO,tenant_id:text:NO,user_id:text:NO,client_id:text:NO,sector_identifier:text:NO,subject:text:NO,created_at:int8:NO',
  subject_identifiers:
    'id:text:NO,tenant_id:text:NO,subject_id:text:NO,identifier_type:text:NO,identifier_value:text:NO,is_primary:bool:NO,verified_at:int8:YES,verification_method:text:YES,destination_type:text:NO,destination_id:text:NO,identifier_value_hash:text:YES,identifier_storage_ref:text:YES,lifecycle_state:text:NO,created_at:int8:NO,updated_at:int8:NO',
  guest_upgrade_operations:
    'operation_id:text:NO,tenant_id:text:NO,user_id:text:NO,client_id:text:NO,initiating_session_id:text:NO,request_token_hash:text:NO,method:text:NO,state:text:NO,proof_payload_json:text:YES,challenge_verifier:text:YES,reservation_publication_json:text:YES,attempt_count:int8:NO,expires_at:int8:NO,lease_owner:text:YES,lease_expires_at:int8:YES,completed_at:int8:YES,created_at:int8:NO,updated_at:int8:NO',
};
const PG_SCHEMA_TABLES = new Set([
  'audit_log_pii',
  'identity_sensitive_values',
  'linked_identities',
  'pairwise_subject_identifiers',
  'schema_migrations',
  'subject_identifiers',
  'totp_backup_codes',
  'totp_credentials',
  'users_pii',
  'users_pii_tombstone',
  'guest_upgrade_operations',
  'account_webhook_outbox',
  'account_webhook_snapshots',
  'account_webhook_delivery_fields',
  'service_group_inputs',
  'service_group_write_boundaries',
  'pii_log_purge_operations',
  'guest_pii_mutation_epoch',
  'guest_pii_erasure_markers',
  // Installation bookkeeping can exist in either provider profile.
  'authrim_migrations',
  'authrim_runtime_probes',
  'migration_metadata',
  'tenant_database_migration_state',
  'authrim_control_plane_shard_metadata',
]);
const MARKER = 'guest_pii_erasure_markers';
const EPOCH = 'guest_pii_mutation_epoch';
const PK: Record<GuestPiiErasureTable, string> = {
  users_pii: 'id',
  identity_sensitive_values: 'id',
  linked_identities: 'id',
  subject_identifiers: 'id',
  pairwise_subject_identifiers: 'id',
  guest_upgrade_operations: 'operation_id',
  identity_identifier_replacement_challenges: 'challenge_id',
  identity_identifier_replacement_operations: 'operation_id',
  identity_identifier_replacement_history: 'operation_id',
  identity_identifier_replacement_outbox: 'outbox_id',
  external_identifier_unlink_operations: 'operation_id',
  user_anonymization_map: 'id',
};
const PRIMARY = { consistencyClass: 'primary_required' } as const;
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
function exactPin(left: GuestPhysicalPinV2, right: GuestPhysicalPinV2): boolean {
  return (Object.keys(left) as Array<keyof GuestPhysicalPinV2>).every(
    (key) => left[key] === right[key]
  );
}
function matching(marker: GuestPiiErasureMarker, receipt: GuestErasureSourceReceipt): void {
  if (
    marker.tenant_id !== receipt.tenantId ||
    marker.user_id !== receipt.userId ||
    marker.account_id !== receipt.accountId ||
    marker.account_route_generation !== receipt.accountRouteGeneration ||
    (marker.state === 'erasing' &&
      (marker.operation_id !== receipt.operationId ||
        marker.boundary_id !== receipt.boundaryId ||
        marker.source_started_at_ms !== receipt.sourceStartedAtMs))
  )
    rejected('marker_identity_conflict');
}
function markerWhere(receipt: GuestErasureSourceReceipt, revision?: number) {
  return {
    sql: `tenant_id=? AND user_id=? AND account_id=? AND account_route_generation=? AND state='erasing'
      AND operation_id=? AND boundary_id=? AND source_started_at_ms=?${revision === undefined ? '' : ' AND revision=?'}`,
    params: [
      receipt.tenantId,
      receipt.userId,
      receipt.accountId,
      receipt.accountRouteGeneration,
      receipt.operationId,
      receipt.boundaryId,
      receipt.sourceStartedAtMs,
      ...(revision === undefined ? [] : [revision]),
    ],
  };
}
function ownerWhere(
  table: GuestPiiErasureTable,
  receipt: GuestErasureSourceReceipt,
  alias = 'source'
) {
  if (table === 'identity_identifier_replacement_history')
    return {
      sql: `EXISTS(SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=${alias}.operation_id AND owner.tenant_id=? AND owner.account_id=?)`,
      params: [receipt.tenantId, receipt.userId],
    };
  if (table === 'external_identifier_unlink_operations')
    return {
      sql: `${alias}.tenant_id=? AND ${alias}.user_id=? AND ${alias}.account_id=?`,
      params: [receipt.tenantId, receipt.userId, receipt.accountId],
    };
  const column =
    table === 'users_pii'
      ? 'id'
      : table === 'identity_sensitive_values'
        ? 'owner_id'
        : table === 'subject_identifiers'
          ? 'subject_id'
          : table.startsWith('identity_identifier_replacement_')
            ? 'account_id'
            : 'user_id';
  return {
    sql: `${alias}.tenant_id=? AND ${alias}.${column}=?${table === 'identity_sensitive_values' ? ` AND ${alias}.owner_type='runtime_user'` : ''}`,
    params: [receipt.tenantId, receipt.userId],
  };
}
function erased(table: GuestPiiErasureTable, alias = 'source'): string {
  switch (table) {
    case 'identity_sensitive_values':
      return `${alias}.value_json IS NULL AND ${alias}.value_hash IS NULL AND ${alias}.lifecycle_state='deleted'`;
    case 'guest_upgrade_operations':
      return `${alias}.state IN('completed','canceled') AND ${alias}.proof_payload_json IS NULL AND ${alias}.challenge_verifier IS NULL AND ${alias}.reservation_publication_json IS NULL AND ${alias}.lease_owner IS NULL AND ${alias}.lease_expires_at IS NULL`;
    case 'identity_identifier_replacement_challenges':
      return `${alias}.normalized_value_json='null' AND ${alias}.raw_value_erased_at IS NOT NULL`;
    case 'identity_identifier_replacement_operations':
      return `${alias}.state IN('completed','canceled') AND ${alias}.lease_owner IS NULL AND ${alias}.lease_expires_at IS NULL AND ${alias}.next_attempt_at IS NULL`;
    case 'identity_identifier_replacement_history':
      return `${alias}.old_value_json IS NULL AND ${alias}.new_value_json IS NULL AND ${alias}.raw_values_erased_at IS NOT NULL`;
    case 'identity_identifier_replacement_outbox':
      return `${alias}.status IN('succeeded','blocked') AND ${alias}.lease_owner IS NULL AND ${alias}.lease_expires_at IS NULL AND ${alias}.next_attempt_at IS NULL`;
    case 'external_identifier_unlink_operations':
      return `${alias}.issuer_json IS NULL AND ${alias}.subject_json IS NULL AND ${alias}.raw_values_erased_at IS NOT NULL AND ${alias}.state IN('completed','blocked') AND ${alias}.lease_owner IS NULL AND ${alias}.lease_expires_at IS NULL AND ${alias}.next_attempt_at IS NULL`;
    default:
      return '0=1';
  }
}
function effect(
  table: GuestPiiErasureTable,
  receipt: GuestErasureSourceReceipt,
  keys: readonly string[]
): PreparedStatement {
  const owner = ownerWhere(table, receipt);
  const predicate = `${owner.sql} AND source.${PK[table]} IN(${keys.map(() => '?').join(',')})`;
  const seconds = Math.floor(receipt.sourceStartedAtMs / 1000);
  let patch: string | undefined;
  switch (table) {
    case 'identity_sensitive_values':
      patch = "value_json=NULL,value_hash=NULL,lifecycle_state='deleted',updated_at=?";
      break;
    case 'guest_upgrade_operations':
      patch =
        "state=CASE WHEN state='completed' THEN state ELSE 'canceled' END,proof_payload_json=NULL,challenge_verifier=NULL,reservation_publication_json=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=?";
      break;
    case 'identity_identifier_replacement_challenges':
      patch =
        "normalized_value_json='null',raw_value_erased_at=COALESCE(raw_value_erased_at,?),updated_at=?";
      break;
    case 'identity_identifier_replacement_operations':
      patch =
        "state=CASE WHEN state='completed' THEN state ELSE 'canceled' END,error_code=CASE WHEN state='completed' THEN error_code ELSE 'account_deleted' END,lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?";
      break;
    case 'identity_identifier_replacement_history':
      patch = 'old_value_json=NULL,new_value_json=NULL,raw_values_erased_at=?';
      break;
    case 'identity_identifier_replacement_outbox':
      patch =
        "status=CASE WHEN status='succeeded' THEN status ELSE 'blocked' END,error_code=CASE WHEN status='succeeded' THEN error_code ELSE 'account_deleted' END,lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?";
      break;
    case 'external_identifier_unlink_operations':
      patch =
        "state=CASE WHEN state='completed' THEN state ELSE 'blocked' END,issuer_json=NULL,subject_json=NULL,raw_values_erased_at=COALESCE(raw_values_erased_at,?),error_code=CASE WHEN state='completed' THEN error_code ELSE 'account_deleted' END,lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?";
      break;
  }
  const timeParams = patch
    ? Array.from(patch.matchAll(/\?/gu), () =>
        table === 'identity_sensitive_values' ? receipt.sourceStartedAtMs : seconds
      )
    : [];
  return {
    sql: patch
      ? `UPDATE ${table} AS source SET ${patch} WHERE ${predicate} AND NOT (${erased(table)})`
      : `DELETE FROM ${table} AS source WHERE ${predicate}`,
    params: [...timeParams, ...owner.params, ...keys],
  };
}
function sqlGuard(sql: string, params: unknown[]): PreparedStatement {
  return {
    sql: `UPDATE ${EPOCH} SET revision=CASE WHEN (${sql}) THEN revision+1 ELSE NULL END WHERE id=1`,
    params,
  };
}
async function checkedBatch(
  database: DatabaseAdapter,
  statements: PreparedStatement[]
): Promise<void> {
  const results = await database.batch(statements);
  if (results.length !== statements.length || results.some((result) => !result.success))
    rejected('batch_unconfirmed');
}
async function assertPhysicalSchema(database: DatabaseAdapter): Promise<void> {
  if (database.getType() !== 'postgres') return;
  const names = [...PG_TABLES, MARKER, EPOCH].map((name) => `'${name}'`).join(',');
  const row = await database.queryOne<{ valid: boolean }>(
    `SELECT current_schema()='public' AND current_setting('session_replication_role')='origin' AND bool_and(COALESCE(to_regclass(name)=to_regclass('public.'||name),FALSE)) AS valid FROM unnest(ARRAY[${names}]) names(name)`,
    [],
    PRIMARY
  );
  if (row?.valid !== true) return rejected('schema_unsupported');
}
async function epoch(database: DatabaseAdapter): Promise<number> {
  const row = await database.queryOne<{ revision: number | string }>(
    `SELECT revision FROM ${EPOCH} WHERE id=1`,
    [],
    PRIMARY
  );
  if (!row) return rejected('schema_unsupported');
  return integer(row.revision, 0);
}

export interface GuestPiiKeyPageRequest {
  table: GuestPiiErasureTable;
  cursor?: string | null;
  highWater?: string | null;
  limit?: number;
}
export interface GuestPiiKeyPage {
  keys: string[];
  nextCursor: string | null;
  highWater: string | null;
}

/**
 * One bounded step in one invocation only: never keep this port globally or reuse it in another request.
 * The caller supplies a fresh signed-registry verified physical connection under environment/release
 * mutation admission, which excludes normal DDL for that step. Operator direct DDL is outside this
 * contract. Only immutable schema checks share an instance-local promise (including rejection);
 * primary epoch, marker, owner and atomic SQL fences remain live on every method.
 */
export function createGuestPiiErasurePort(
  database: DatabaseAdapter,
  verifiedPiiPin: GuestPhysicalPinV2
): GuestPiiErasurePort {
  const pin = Object.freeze(parseGuestPhysicalPinV2(verifiedPiiPin, 'tenant_pii'));
  const backend = database.getType();
  if (
    (backend !== 'd1' && backend !== 'postgres') ||
    (backend === 'postgres' && !(database instanceof PostgresAdapter))
  )
    return rejected('backend_unsupported');
  const profile = backend === 'postgres' ? PG_TABLES : GUEST_PII_ERASURE_TABLES;
  let schemaPreflight: Promise<void> | undefined;
  async function verifySchema(): Promise<void> {
    await assertPhysicalSchema(database);
    if (backend === 'postgres') {
      const installed = await database.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
        [],
        PRIMARY
      );
      const names = new Set(installed.map((row) => row.table_name));
      if (installed.some((row) => !PG_SCHEMA_TABLES.has(row.table_name)))
        rejected('schema_unsupported');
      if (GUEST_PII_ERASURE_TABLES.some((table) => names.has(table) !== profile.includes(table)))
        rejected('schema_unsupported');
      const columns = await database.query<{ table_name: string; columns: string }>(
        `SELECT table_name,string_agg(column_name||':'||udt_name||':'||is_nullable,',' ORDER BY ordinal_position) AS columns FROM information_schema.columns WHERE table_schema='public' GROUP BY table_name`,
        [],
        PRIMARY
      );
      if (
        profile.some(
          (table) =>
            !columns.some(
              (row) => row.table_name === table && row.columns === PG_COLUMN_PROFILE[table]
            )
        )
      )
        rejected('schema_unsupported');
      const primaryKeys = await database.query<{ table_name: string; key_columns: string }>(
        `SELECT relation.relname AS table_name,string_agg(attribute.attname,',' ORDER BY keys.ordinality) AS key_columns FROM pg_index idx JOIN pg_class relation ON relation.oid=idx.indrelid JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace CROSS JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY keys(attnum,ordinality) JOIN pg_attribute attribute ON attribute.attrelid=relation.oid AND attribute.attnum=keys.attnum WHERE namespace.nspname='public' AND idx.indisprimary GROUP BY relation.relname`,
        [],
        PRIMARY
      );
      if (
        profile.some(
          (table) =>
            !primaryKeys.some((row) => row.table_name === table && row.key_columns === PK[table])
        )
      )
        rejected('schema_unsupported');
      const triggers = await database.query<{
        name: string;
        table_name: string;
        function_name: string;
        trigger_type: number;
        function_schema: string;
      }>(
        `SELECT trigger.tgname AS name,relation.relname AS table_name,procedure.proname AS function_name,trigger.tgtype AS trigger_type,function_ns.nspname AS function_schema FROM pg_trigger trigger
         JOIN pg_class relation ON relation.oid=trigger.tgrelid JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         JOIN pg_proc procedure ON procedure.oid=trigger.tgfoid JOIN pg_namespace function_ns ON function_ns.oid=procedure.pronamespace
         WHERE namespace.nspname='public' AND NOT trigger.tgisinternal AND trigger.tgenabled IN('O','A')`,
        [],
        PRIMARY
      );
      for (const table of profile)
        if (
          !triggers.some(
            (trigger) =>
              trigger.name === `trg_guest_pii_${table}` &&
              trigger.function_name === 'authrim_guest_pii_source_guard' &&
              trigger.table_name === table &&
              trigger.trigger_type === 31 &&
              trigger.function_schema === 'public'
          )
        )
          rejected('schema_unsupported');
      for (const [name, table, func, type] of [
        ['trg_guest_pii_marker_guard', MARKER, 'authrim_guest_pii_marker_guard', 31],
        ['trg_guest_pii_epoch_immutable', EPOCH, 'authrim_guest_pii_epoch_guard', 27],
        ['trg_guest_pii_epoch_no_replace', EPOCH, 'authrim_guest_pii_epoch_insert_guard', 7],
      ] as const)
        if (
          !triggers.some(
            (trigger) =>
              trigger.name === name &&
              trigger.table_name === table &&
              trigger.function_name === func &&
              trigger.trigger_type === type
          )
        )
          rejected('schema_unsupported');
    } else {
      const triggers = await database.query<{ name: string; tbl_name: string }>(
        "SELECT name,tbl_name FROM sqlite_master WHERE type='trigger'",
        [],
        PRIMARY
      );
      for (const [name, table] of [
        ['trg_guest_pii_epoch_no_delete', EPOCH],
        ['trg_guest_pii_epoch_no_replace', EPOCH],
        ['trg_guest_pii_epoch_monotonic', EPOCH],
        ['trg_guest_pii_marker_no_delete', MARKER],
        ['trg_guest_pii_marker_insert', MARKER],
        ['trg_guest_pii_marker_update', MARKER],
      ])
        if (!triggers.some((trigger) => trigger.name === name && trigger.tbl_name === table))
          rejected('schema_unsupported');
      for (const table of profile.filter((table) => table !== 'user_anonymization_map')) {
        for (const event of ['insert', 'update', 'delete'])
          if (
            !triggers.some(
              (trigger) =>
                trigger.name === `trg_guest_pii_${table}_${event}` && trigger.tbl_name === table
            )
          )
            rejected('schema_unsupported');
      }
    }
  }
  async function preflight(): Promise<void> {
    await epoch(database);
    schemaPreflight ??= verifySchema();
    await schemaPreflight;
  }
  async function scope(input: GuestErasureSourceReceipt): Promise<GuestErasureSourceReceipt> {
    const receipt = { ...input, piiPin: parseGuestPhysicalPinV2(input.piiPin, 'tenant_pii') };
    for (const value of [receipt.tenantId, receipt.userId, receipt.operationId]) id(value);
    id(receipt.accountId, 512);
    if (
      typeof receipt.accountRouteGeneration !== 'number' ||
      typeof receipt.sourceStartedAtMs !== 'number'
    )
      return rejected('source_receipt_invalid');
    integer(receipt.accountRouteGeneration);
    integer(receipt.sourceStartedAtMs);
    if (
      !exactPin(receipt.piiPin, pin) ||
      receipt.boundaryId !== (await guestErasureBoundaryId(receipt.operationId))
    )
      rejected('source_receipt_invalid');
    await preflight();
    return receipt;
  }
  async function getCaptured(
    receipt: GuestErasureSourceReceipt
  ): Promise<GuestPiiErasureMarker | null> {
    const row = await database.queryOne<Record<string, unknown>>(
      `SELECT * FROM ${MARKER} WHERE tenant_id=? AND user_id=?`,
      [receipt.tenantId, receipt.userId],
      PRIMARY
    );
    if (!row) return null;
    const marker = normalizeMarker(row);
    matching(marker, receipt);
    return marker;
  }
  async function requireErasing(receipt: GuestErasureSourceReceipt, revision?: number) {
    const marker = await getCaptured(receipt);
    if (
      !marker ||
      marker.state !== 'erasing' ||
      (revision !== undefined && marker.revision !== revision)
    )
      rejected('revision_conflict');
    return marker;
  }
  return {
    async tables() {
      await preflight();
      return [...profile];
    },
    async get(input: GuestErasureSourceReceipt) {
      return getCaptured(await scope(input));
    },
    async start(input: GuestErasureSourceReceipt) {
      const receipt = await scope(input);
      const prior = await getCaptured(receipt);
      if (prior) return prior;
      try {
        await checkedBatch(database, [
          {
            sql: `INSERT INTO ${MARKER}(schema_version,tenant_id,user_id,account_id,account_route_generation,state,revision,operation_id,boundary_id,source_started_at_ms)
            SELECT 1,?,?,?,?,'erasing',1,?,?,? WHERE NOT EXISTS(SELECT 1 FROM ${MARKER} WHERE tenant_id=? AND (user_id=? OR account_id=?))`,
            params: [
              receipt.tenantId,
              receipt.userId,
              receipt.accountId,
              receipt.accountRouteGeneration,
              receipt.operationId,
              receipt.boundaryId,
              receipt.sourceStartedAtMs,
              receipt.tenantId,
              receipt.userId,
              receipt.accountId,
            ],
          },
        ]);
      } catch (error) {
        const committed = await getCaptured(receipt);
        if (committed) return committed;
        throw error;
      }
      const committed = await getCaptured(receipt);
      if (!committed) return rejected('start_unconfirmed');
      return committed;
    },
    async listPage(
      input: GuestErasureSourceReceipt,
      request: GuestPiiKeyPageRequest
    ): Promise<GuestPiiKeyPage> {
      const receipt = await scope(input);
      await requireErasing(receipt);
      if (!profile.includes(request.table)) return rejected('table_unsupported');
      const limit = integer(request.limit ?? GUEST_PII_ERASURE_PAGE_SIZE);
      if (limit > GUEST_PII_ERASURE_PAGE_SIZE) return rejected('page_budget_exceeded');
      const cursor =
        request.cursor === undefined || request.cursor === null ? null : id(request.cursor);
      // History has no tenant/user columns. Its immutable owning operation set survives cancellation.
      // Enumerate that indexed parent PK set, including operations without history; drain is idempotent
      // for a missing history row. A correlated history-first EXISTS would scan unrelated history.
      const keyTable =
        request.table === 'identity_identifier_replacement_history'
          ? 'identity_identifier_replacement_operations'
          : request.table;
      const owner = ownerWhere(keyTable, receipt);
      const highWater =
        request.highWater === undefined
          ? ((
              await database.queryOne<{ high_water: string | null }>(
                `SELECT MAX(source.${PK[keyTable]}) AS high_water FROM ${keyTable} source WHERE ${owner.sql}`,
                owner.params,
                PRIMARY
              )
            )?.high_water ?? null)
          : request.highWater === null
            ? null
            : id(request.highWater);
      if (highWater === null) {
        await requireErasing(receipt);
        return { keys: [], nextCursor: null, highWater: null };
      }
      if (cursor !== null && cursor > highWater) return rejected('cursor_invalid');
      const guard = markerWhere(receipt);
      const rows = await database.query<{ id: string }>(
        `SELECT source.${PK[keyTable]} AS id FROM ${keyTable} source WHERE ${owner.sql}
        AND source.${PK[keyTable]}<=? ${cursor === null ? '' : `AND source.${PK[keyTable]}>?`}
        AND EXISTS(SELECT 1 FROM ${MARKER} WHERE ${guard.sql}) ORDER BY source.${PK[keyTable]} LIMIT ?`,
        [
          ...owner.params,
          highWater,
          ...(cursor === null ? [] : [cursor]),
          ...guard.params,
          limit + 1,
        ],
        PRIMARY
      );
      await requireErasing(receipt);
      const keys = rows.slice(0, limit).map((row) => id(row.id));
      return {
        keys,
        nextCursor: rows.length > limit ? (keys.at(-1) ?? rejected('page_unconfirmed')) : null,
        highWater,
      };
    },
    async drainPage(input: GuestErasureDrainReceipt, page: GuestPiiErasurePage) {
      if (input.preparedComplete !== true) return rejected('capture_unconfirmed');
      const receipt = await scope(input);
      const revision = integer(page.expectedRevision);
      await requireErasing(receipt, revision);
      if (!profile.includes(page.table)) return rejected('table_unsupported');
      const keys = [...page.keys].map((key) => id(key));
      if (
        !keys.length ||
        keys.length > GUEST_PII_ERASURE_PAGE_SIZE ||
        new Set(keys).size !== keys.length
      )
        return rejected('page_budget_exceeded');
      const where = markerWhere(receipt, revision);
      const owner = ownerWhere(page.table, receipt);
      const placeholders = keys.map(() => '?').join(',');
      const permit = JSON.stringify(keys);
      await checkedBatch(database, [
        sqlGuard(
          `EXISTS(SELECT 1 FROM ${MARKER} WHERE ${where.sql} AND permit_table IS NULL AND permit_keys_json IS NULL)
          AND NOT EXISTS(SELECT 1 FROM ${page.table} source WHERE source.${PK[page.table]} IN(${placeholders}) AND NOT (${owner.sql}))`,
          [...where.params, ...keys, ...owner.params]
        ),
        {
          sql: `UPDATE ${MARKER} SET permit_table=?,permit_keys_json=? WHERE ${where.sql} AND permit_table IS NULL AND permit_keys_json IS NULL`,
          params: [page.table, permit, ...where.params],
        },
        effect(page.table, receipt, keys),
        sqlGuard(
          `EXISTS(SELECT 1 FROM ${MARKER} WHERE ${where.sql} AND permit_table=? AND permit_keys_json=?)
          AND NOT EXISTS(SELECT 1 FROM ${page.table} source WHERE source.${PK[page.table]} IN(${placeholders}) AND NOT (${erased(page.table)}))`,
          [...where.params, page.table, permit, ...keys]
        ),
        {
          sql: `UPDATE ${MARKER} SET permit_table=NULL,permit_keys_json=NULL,revision=revision+1 WHERE ${where.sql} AND permit_table=? AND permit_keys_json=?`,
          params: [...where.params, page.table, permit],
        },
      ]);
      const committed = await getCaptured(receipt);
      if (!committed || committed.revision !== revision + 1) return rejected('page_unconfirmed');
      return committed;
    },
    async complete(input: GuestErasureCompletionReceipt, options: { expectedRevision: number }) {
      if (input.preparedComplete !== true || input.coreCompleted !== true)
        return rejected('completion_unconfirmed');
      const receipt = await scope(input);
      const prior = await getCaptured(receipt);
      if (prior?.state === 'deleted') return prior;
      const revision = integer(options.expectedRevision);
      await requireErasing(receipt, revision);
      const where = markerWhere(receipt, revision);
      const checks = [];
      const params: unknown[] = [...where.params];
      for (const table of profile.filter((table) => table !== 'user_anonymization_map')) {
        if (table === 'identity_identifier_replacement_history') {
          checks.push(
            `NOT EXISTS(SELECT 1 FROM identity_identifier_replacement_operations owner CROSS JOIN identity_identifier_replacement_history source WHERE owner.tenant_id=? AND owner.account_id=? AND source.operation_id=owner.operation_id AND NOT (${erased(table)}))`
          );
          params.push(receipt.tenantId, receipt.userId);
        } else {
          const owner = ownerWhere(table, receipt);
          checks.push(
            `NOT EXISTS(SELECT 1 FROM ${table} source WHERE ${owner.sql} AND NOT (${erased(table)}))`
          );
          params.push(...owner.params);
        }
      }
      await checkedBatch(database, [
        sqlGuard(
          `EXISTS(SELECT 1 FROM ${MARKER} WHERE ${where.sql} AND permit_table IS NULL AND permit_keys_json IS NULL) AND ${checks.join(' AND ')}`,
          params
        ),
        {
          sql: `UPDATE ${MARKER} SET state='deleted',operation_id=NULL,boundary_id=NULL,source_started_at_ms=NULL,permit_table=NULL,permit_keys_json=NULL,revision=revision+1 WHERE ${where.sql} AND permit_table IS NULL AND permit_keys_json IS NULL`,
          params: where.params,
        },
      ]);
      const committed = await getCaptured(receipt);
      if (!committed || committed.state !== 'deleted') return rejected('completion_unconfirmed');
      return committed;
    },
  };
}

export interface GuestPiiMarkerAuthorityPage {
  markers: GuestPiiDeletedMarker[];
  nextCursor: string | null;
  epochRevision: number;
}

/** The source lease/pin authority stays with the caller and is rechecked around each bounded page. */
export async function listGuestPiiDeletionMarkers(
  database: DatabaseAdapter,
  input: {
    tenantId: string;
    afterUserId?: string | null;
    limit?: number;
    expectedEpochRevision?: number;
    authorize: () => Promise<void>;
  }
): Promise<GuestPiiMarkerAuthorityPage> {
  const tenant = id(input.tenantId);
  const cursor = input.afterUserId == null ? null : id(input.afterUserId);
  const limit = integer(input.limit ?? GUEST_PII_ERASURE_PAGE_SIZE);
  if (limit > GUEST_PII_ERASURE_PAGE_SIZE) return rejected('page_budget_exceeded');
  await input.authorize();
  await assertPhysicalSchema(database);
  const before = await epoch(database);
  if (
    input.expectedEpochRevision !== undefined &&
    before !== integer(input.expectedEpochRevision, 0)
  )
    return rejected('authority_changed');
  const held = await database.queryOne(
    `SELECT 1 FROM ${MARKER} WHERE tenant_id=? AND state<>'deleted' LIMIT 1`,
    [tenant],
    PRIMARY
  );
  if (held) return rejected('authority_held');
  const rows = await database.query<Record<string, unknown>>(
    `SELECT * FROM ${MARKER} WHERE tenant_id=? AND state='deleted' ${cursor === null ? '' : 'AND user_id>?'} ORDER BY user_id LIMIT ?`,
    [tenant, ...(cursor === null ? [] : [cursor]), limit + 1],
    PRIMARY
  );
  const markers = rows.slice(0, limit).map(normalizeGuestPiiDeletedMarker);
  const after = await epoch(database);
  await input.authorize();
  if (after !== before) return rejected('authority_changed');
  return {
    markers,
    nextCursor:
      rows.length > limit ? (markers.at(-1) ?? rejected('page_unconfirmed')).user_id : null,
    epochRevision: after,
  };
}
