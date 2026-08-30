import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { ControlLookupBucketMigrationView } from '@authrim/ar-lib-core';

const MAX_BATCH_ROWS = 100;
const ZERO_DIGEST = '0'.repeat(64);
const TABLE_NAMES = ['identifiers', 'aliases', 'reservations', 'replacements'] as const;
type TableName = (typeof TABLE_NAMES)[number];
type SqlValue = string | number | null | ArrayBuffer;

interface TableSpec {
  name: TableName;
  table: string;
  alias: string;
  columns: readonly string[];
  keyColumns: readonly string[];
  conflictColumns: readonly string[];
  bucketPredicate: string;
}

interface ScanCursor {
  schemaVersion: 1;
  mode: 'copy' | 'verify';
  table: TableName | 'done';
  after: SqlValue[];
  side?: 'source' | 'target';
  rollingDigest?: string;
  rowCount?: number;
  sourceDigest?: string;
  sourceRowCount?: number;
}

export interface LookupBucketCopyResult {
  cursor: string;
  processedRows: number;
  done: boolean;
}

export interface LookupBucketVerifyResult extends LookupBucketCopyResult {
  sourceRowCount: number | null;
  targetRowCount: number | null;
  verificationDigest: string | null;
}

const SPECS: readonly TableSpec[] = [
  {
    name: 'identifiers',
    table: 'lookup_identifiers',
    alias: 'row',
    columns: [
      'virtual_bucket',
      'index_kind',
      'normalization_version',
      'hmac_key_generation',
      'identifier_blind_digest',
      'tenant_id',
      'account_id',
      'route_schema_version',
      'account_route_generation',
      'required_binding_route_generation',
      'residency_policy_id',
      'route_projection_json',
      'tenant_lifecycle_state',
      'runtime_route_status',
      'lifecycle_state',
      'created_at',
      'updated_at',
      'disabled_at',
      'disabled_at',
    ],
    keyColumns: [
      'index_kind',
      'normalization_version',
      'hmac_key_generation',
      'identifier_blind_digest',
      'tenant_id',
      'account_id',
    ],
    conflictColumns: [
      'virtual_bucket',
      'index_kind',
      'normalization_version',
      'hmac_key_generation',
      'identifier_blind_digest',
      'tenant_id',
      'account_id',
    ],
    bucketPredicate: 'row.virtual_bucket = ?',
  },
  {
    name: 'aliases',
    table: 'lookup_tenant_aliases',
    alias: 'row',
    columns: [
      'virtual_bucket',
      'alias_kind',
      'alias_sha256_digest',
      'tenant_id',
      'route_schema_version',
      'route_projection_json',
      'tenant_lifecycle_state',
      'runtime_route_status',
      'lifecycle_state',
      'created_at',
      'updated_at',
    ],
    keyColumns: ['alias_kind', 'alias_sha256_digest', 'tenant_id'],
    conflictColumns: ['virtual_bucket', 'alias_kind', 'alias_sha256_digest', 'tenant_id'],
    bucketPredicate: 'row.virtual_bucket = ?',
  },
  {
    name: 'reservations',
    table: 'lookup_identifier_reservations',
    alias: 'row',
    columns: [
      'virtual_bucket',
      'tenant_id',
      'index_kind',
      'normalization_version',
      'hmac_key_generation',
      'identifier_blind_digest',
      'account_id',
      'reservation_state',
      'operation_id',
      'lease_expires_at',
      'created_at',
      'committed_at',
      'released_at',
      'updated_at',
    ],
    keyColumns: [
      'tenant_id',
      'index_kind',
      'normalization_version',
      'hmac_key_generation',
      'identifier_blind_digest',
    ],
    conflictColumns: [
      'virtual_bucket',
      'tenant_id',
      'index_kind',
      'normalization_version',
      'hmac_key_generation',
      'identifier_blind_digest',
    ],
    bucketPredicate: 'row.virtual_bucket = ?',
  },
  {
    name: 'replacements',
    table: 'lookup_identifier_replacements',
    alias: 'row',
    columns: [
      'replacement_id',
      'tenant_id',
      'account_id',
      'index_kind',
      'normalization_version',
      'hmac_key_generation',
      'old_virtual_bucket',
      'old_blind_digest',
      'new_virtual_bucket',
      'new_blind_digest',
      'gate_state',
      'authoritative_checked_at',
      'completed_at',
      'error_code',
      'created_at',
      'updated_at',
    ],
    keyColumns: ['replacement_id', 'hmac_key_generation'],
    conflictColumns: ['replacement_id', 'hmac_key_generation'],
    bucketPredicate: 'row.new_virtual_bucket = ?',
  },
];

function primitive(value: unknown): SqlValue {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    value === null ||
    value instanceof ArrayBuffer
  ) {
    return value;
  }
  throw new Error('lookup_bucket_migration_row_invalid');
}

function spec(name: TableName): TableSpec {
  const value = SPECS.find((candidate) => candidate.name === name);
  if (!value) throw new Error('lookup_bucket_migration_cursor_invalid');
  return value;
}

function nextTable(name: TableName): TableName | 'done' {
  const index = TABLE_NAMES.indexOf(name);
  return TABLE_NAMES[index + 1] ?? 'done';
}

function cursor(value: string | undefined, mode: 'copy' | 'verify'): ScanCursor {
  if (!value || value === '{}') {
    return {
      schemaVersion: 1,
      mode,
      table: TABLE_NAMES[0],
      after: [],
      ...(mode === 'verify' ? { side: 'source', rollingDigest: ZERO_DIGEST, rowCount: 0 } : {}),
    };
  }
  if (value.length > 4096) throw new Error('lookup_bucket_migration_cursor_invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('lookup_bucket_migration_cursor_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('lookup_bucket_migration_cursor_invalid');
  }
  const candidate = parsed as ScanCursor;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.mode !== mode ||
    ![...TABLE_NAMES, 'done'].includes(candidate.table) ||
    !Array.isArray(candidate.after) ||
    candidate.after.some((entry) => {
      try {
        primitive(entry);
        return false;
      } catch {
        return true;
      }
    })
  ) {
    throw new Error('lookup_bucket_migration_cursor_invalid');
  }
  if (candidate.table !== 'done' && candidate.after.length > 0) {
    if (candidate.after.length !== spec(candidate.table).keyColumns.length) {
      throw new Error('lookup_bucket_migration_cursor_invalid');
    }
  }
  if (
    mode === 'verify' &&
    ((candidate.side !== 'source' && candidate.side !== 'target') ||
      typeof candidate.rollingDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(candidate.rollingDigest) ||
      !Number.isSafeInteger(candidate.rowCount) ||
      (candidate.rowCount ?? -1) < 0)
  ) {
    throw new Error('lookup_bucket_migration_cursor_invalid');
  }
  return candidate;
}

function keyPredicate(value: TableSpec, hasCursor: boolean): string {
  if (!hasCursor) return '';
  const columns = value.keyColumns.map((column) => `${value.alias}.${column}`);
  return ` AND (${columns.join(', ')}) > (${columns.map(() => '?').join(', ')})`;
}

async function page(
  database: D1Database,
  value: TableSpec,
  virtualBucket: number,
  after: SqlValue[]
): Promise<Record<string, SqlValue>[]> {
  const rows = await database
    .withSession('first-primary')
    .prepare(
      `SELECT ${value.columns.map((column) => `${value.alias}.${column}`).join(', ')}
         FROM ${value.table} ${value.alias}
        WHERE ${value.bucketPredicate}${keyPredicate(value, after.length > 0)}
        ORDER BY ${value.keyColumns.map((column) => `${value.alias}.${column}`).join(', ')}
        LIMIT ?`
    )
    .bind(virtualBucket, ...after, MAX_BATCH_ROWS)
    .all<Record<string, unknown>>();
  return rows.results.map((row) =>
    Object.fromEntries(value.columns.map((column) => [column, primitive(row[column])]))
  );
}

function rowKey(value: TableSpec, row: Record<string, SqlValue>): SqlValue[] {
  return value.keyColumns.map((column) => primitive(row[column]));
}

function insertStatement(
  database: D1Database,
  value: TableSpec,
  row: Record<string, SqlValue>
): D1PreparedStatement {
  const mutableColumns = value.columns.filter((column) => !value.conflictColumns.includes(column));
  return database
    .prepare(
      `INSERT INTO ${value.table} (${value.columns.join(', ')})
       VALUES (${value.columns.map(() => '?').join(', ')})
       ON CONFLICT (${value.conflictColumns.join(', ')}) DO UPDATE SET
         ${mutableColumns.map((column) => `${column} = excluded.${column}`).join(', ')}
       WHERE ${value.table}.updated_at < excluded.updated_at`
    )
    .bind(...value.columns.map((column) => primitive(row[column])));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function extendDigest(
  current: string,
  value: TableSpec,
  rows: Record<string, SqlValue>[]
): Promise<string> {
  let digest = current;
  for (const row of rows) {
    digest = await sha256(
      `${digest}\n${value.name}\n${JSON.stringify(value.columns.map((column) => row[column]))}`
    );
  }
  return digest;
}

function assertRunnableMigration(view: ControlLookupBucketMigrationView): void {
  if (
    !view ||
    !Number.isSafeInteger(view.virtualBucket) ||
    view.virtualBucket < 0 ||
    view.virtualBucket > 4095 ||
    !['backfilling', 'verifying', 'grace'].includes(view.state)
  ) {
    throw new Error('lookup_bucket_migration_view_invalid');
  }
}

export class LookupBucketMigrationWorker {
  constructor(
    private readonly source: D1Database,
    private readonly target: D1Database,
    private readonly now: () => number
  ) {}

  async copyNext(
    view: ControlLookupBucketMigrationView,
    cursorJson = view.backfillCursor
  ): Promise<LookupBucketCopyResult> {
    assertRunnableMigration(view);
    if (view.state !== 'backfilling') throw new Error('lookup_bucket_migration_state_invalid');
    const position = cursor(cursorJson, 'copy');
    if (position.table === 'done')
      return { cursor: JSON.stringify(position), processedRows: 0, done: true };
    if (cursorJson === '{}' || cursorJson === undefined) {
      await this.resetTargetBucket(view.virtualBucket);
    }
    const table = spec(position.table);
    const rows = await page(this.source, table, view.virtualBucket, position.after);
    if (rows.length > 0) {
      await this.target.batch(rows.map((row) => insertStatement(this.target, table, row)));
    }
    const next: ScanCursor =
      rows.length < MAX_BATCH_ROWS
        ? { schemaVersion: 1, mode: 'copy', table: nextTable(table.name), after: [] }
        : {
            schemaVersion: 1,
            mode: 'copy',
            table: table.name,
            after: rowKey(table, rows[rows.length - 1]),
          };
    if (next.table === 'done') {
      const publicationCounter = await this.source
        .withSession('first-primary')
        .prepare(
          `SELECT successful_route_publication_count, publication_counter_updated_at
             FROM lookup_bucket_counters WHERE virtual_bucket = ?`
        )
        .bind(view.virtualBucket)
        .first<{
          successful_route_publication_count: number | string;
          publication_counter_updated_at: number | string;
        }>();
      const successfulRoutePublicationCount = Number(
        publicationCounter?.successful_route_publication_count
      );
      const publicationCounterUpdatedAt = Number(
        publicationCounter?.publication_counter_updated_at
      );
      if (
        !Number.isSafeInteger(successfulRoutePublicationCount) ||
        successfulRoutePublicationCount < 0 ||
        !Number.isSafeInteger(publicationCounterUpdatedAt) ||
        publicationCounterUpdatedAt < 0
      ) {
        throw new Error('lookup_bucket_migration_counter_invalid');
      }
      await this.reconcileCounter(this.target, view.virtualBucket, 'migration-copy', {
        successfulRoutePublicationCount,
        publicationCounterUpdatedAt,
      });
    }
    return {
      cursor: JSON.stringify(next),
      processedRows: rows.length,
      done: next.table === 'done',
    };
  }

  async verifyNext(
    view: ControlLookupBucketMigrationView,
    cursorJson?: string
  ): Promise<LookupBucketVerifyResult> {
    assertRunnableMigration(view);
    if (view.state !== 'verifying') throw new Error('lookup_bucket_migration_state_invalid');
    const position = cursor(cursorJson, 'verify');
    if (position.table === 'done') throw new Error('lookup_bucket_migration_cursor_invalid');
    const table = spec(position.table);
    const database = position.side === 'source' ? this.source : this.target;
    const rows = await page(database, table, view.virtualBucket, position.after);
    const rollingDigest = await extendDigest(position.rollingDigest!, table, rows);
    const rowCount = position.rowCount! + rows.length;
    let next: ScanCursor;
    if (rows.length === MAX_BATCH_ROWS) {
      next = {
        ...position,
        after: rowKey(table, rows[rows.length - 1]),
        rollingDigest,
        rowCount,
      };
    } else {
      const following = nextTable(table.name);
      if (following !== 'done') {
        next = {
          ...position,
          table: following,
          after: [],
          rollingDigest,
          rowCount,
        };
      } else if (position.side === 'source') {
        next = {
          schemaVersion: 1,
          mode: 'verify',
          side: 'target',
          table: TABLE_NAMES[0],
          after: [],
          rollingDigest: ZERO_DIGEST,
          rowCount: 0,
          sourceDigest: rollingDigest,
          sourceRowCount: rowCount,
        };
      } else {
        if (position.sourceDigest !== rollingDigest || position.sourceRowCount !== rowCount) {
          throw new Error('lookup_bucket_migration_verification_mismatch');
        }
        return {
          cursor: JSON.stringify({ ...position, table: 'done', after: [] }),
          processedRows: rows.length,
          done: true,
          sourceRowCount: rowCount,
          targetRowCount: rowCount,
          verificationDigest: rollingDigest,
        };
      }
    }
    return {
      cursor: JSON.stringify(next),
      processedRows: rows.length,
      done: false,
      sourceRowCount: next.sourceRowCount ?? null,
      targetRowCount: null,
      verificationDigest: null,
    };
  }

  async quarantineSource(view: ControlLookupBucketMigrationView): Promise<void> {
    assertRunnableMigration(view);
    if (view.state !== 'grace') throw new Error('lookup_bucket_migration_state_invalid');
    const now = this.now();
    if (view.graceExpiresAt === null || now < view.graceExpiresAt) {
      throw new Error('lookup_bucket_migration_grace_active');
    }
    const challenge = await this.source
      .withSession('first-primary')
      .prepare(
        `SELECT challenge_id FROM lookup_discovery_otp_challenges
          WHERE virtual_bucket = ? AND consumed_at IS NULL
            AND delivery_state = 'sent' AND expires_at >= ? LIMIT 1`
      )
      .bind(view.virtualBucket, now)
      .first<{ challenge_id: string }>();
    if (challenge) throw new Error('lookup_bucket_migration_challenge_grace_active');
    await this.source.batch([
      this.source
        .prepare(
          `UPDATE lookup_identifiers
              SET lifecycle_state = 'disabled', disabled_at = COALESCE(disabled_at, ?),
                  updated_at = ?
            WHERE virtual_bucket = ? AND lifecycle_state IN ('pending', 'active')`
        )
        .bind(now, now, view.virtualBucket),
      this.source
        .prepare(
          `UPDATE lookup_tenant_aliases SET lifecycle_state = 'disabled', updated_at = ?
            WHERE virtual_bucket = ? AND lifecycle_state IN ('pending', 'active')`
        )
        .bind(now, view.virtualBucket),
    ]);
    await this.reconcileCounter(this.source, view.virtualBucket, 'migration-quarantine');
  }

  private async reconcileCounter(
    database: D1Database,
    virtualBucket: number,
    cursor: string,
    publicationCounter?: {
      successfulRoutePublicationCount: number;
      publicationCounterUpdatedAt: number;
    }
  ): Promise<void> {
    const now = this.now();
    await database
      .prepare(
        `INSERT INTO lookup_bucket_counters (
           virtual_bucket, estimated_active_identifier_count, estimated_active_alias_count,
           exact_count_checked_at, reconciliation_cursor, reconciliation_error_code, updated_at,
           successful_route_publication_count, publication_counter_updated_at
         )
         SELECT ?,
                (SELECT COUNT(*) FROM lookup_identifiers
                  WHERE virtual_bucket = ? AND lifecycle_state = 'active'),
                (SELECT COUNT(*) FROM lookup_tenant_aliases
                  WHERE virtual_bucket = ? AND lifecycle_state = 'active'),
                ?, ?, NULL, ?,
                COALESCE(?, (SELECT successful_route_publication_count
                               FROM lookup_bucket_counters WHERE virtual_bucket = ?), 0),
                COALESCE(?, (SELECT publication_counter_updated_at
                               FROM lookup_bucket_counters WHERE virtual_bucket = ?), 0)
         ON CONFLICT(virtual_bucket) DO UPDATE SET
           estimated_active_identifier_count = excluded.estimated_active_identifier_count,
           estimated_active_alias_count = excluded.estimated_active_alias_count,
           exact_count_checked_at = excluded.exact_count_checked_at,
           reconciliation_cursor = excluded.reconciliation_cursor,
           reconciliation_error_code = NULL,
           updated_at = excluded.updated_at,
           successful_route_publication_count = MAX(
             lookup_bucket_counters.successful_route_publication_count,
             excluded.successful_route_publication_count
           ),
           publication_counter_updated_at = MAX(
             lookup_bucket_counters.publication_counter_updated_at,
             excluded.publication_counter_updated_at
           )`
      )
      .bind(
        virtualBucket,
        virtualBucket,
        virtualBucket,
        now,
        cursor,
        now,
        publicationCounter?.successfulRoutePublicationCount ?? null,
        virtualBucket,
        publicationCounter?.publicationCounterUpdatedAt ?? null,
        virtualBucket
      )
      .run();
  }

  private async resetTargetBucket(virtualBucket: number): Promise<void> {
    await this.target.batch([
      this.target
        .prepare(
          `DELETE FROM lookup_identifier_replacements
            WHERE new_virtual_bucket = ?`
        )
        .bind(virtualBucket),
      this.target
        .prepare(`DELETE FROM lookup_identifier_reservations WHERE virtual_bucket = ?`)
        .bind(virtualBucket),
      this.target
        .prepare(`DELETE FROM lookup_tenant_aliases WHERE virtual_bucket = ?`)
        .bind(virtualBucket),
      this.target
        .prepare(`DELETE FROM lookup_identifiers WHERE virtual_bucket = ?`)
        .bind(virtualBucket),
      this.target
        .prepare(`DELETE FROM lookup_bucket_counters WHERE virtual_bucket = ?`)
        .bind(virtualBucket),
    ]);
  }
}
