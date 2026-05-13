/**
 * Hyperdrive Audit Storage Adapter
 *
 * Storage adapter for external PostgreSQL via Cloudflare Hyperdrive.
 * Used for enterprise deployments requiring external database storage.
 *
 * Features:
 * - Connection pooling via Hyperdrive
 * - PostgreSQL-specific query support
 * - Compatible with standard PostgreSQL client libraries
 *
 * Note: This adapter requires a PostgreSQL client library to be available.
 * The implementation uses raw SQL queries via the Hyperdrive socket.
 */

import type { EventLogEntry, PIILogEntry } from '../types';
import type { Client as NodePgClient } from 'pg';
import type {
  IAuditStorageAdapter,
  AuditStorageBackendType,
  AuditWriteResult,
  AuditQueryOptions,
  AuditQueryResult,
  AuditStorageHealth,
  AuditLogType,
} from './adapter';

/**
 * Hyperdrive adapter configuration.
 */
export interface HyperdriveAuditAdapterConfig {
  /** Unique identifier for this adapter */
  id: string;

  /** Hyperdrive binding (provides connection string) */
  hyperdrive: Hyperdrive;

  /** Schema name (default: 'audit') */
  schema: string;

  /** Whether this is for PII logs */
  isPiiDb: boolean;

  /**
   * Optional factory for tests or custom client wiring.
   * Receives the Hyperdrive-generated connection string.
   */
  clientFactory?: (connectionString: string) => Promise<PgClient> | PgClient;
}

/**
 * PostgreSQL query result type.
 */
interface PgQueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

/**
 * Simple PostgreSQL client interface.
 * This is a minimal interface for database operations.
 */
interface PgClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
  end(): Promise<void>;
}

function sanitizeIdentifier(identifier: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`invalid_sql_identifier:${identifier}`);
  }
  return identifier;
}

function buildInsertIfNotExistsSql(
  tableName: string,
  columns: string[],
  keyColumn: string,
  rowCount: number
): string {
  const cteColumns = columns.join(', ');
  const values = Array.from({ length: rowCount }, (_, idx) => {
    const offset = idx * columns.length;
    const placeholders = columns.map((_, columnIdx) => `$${offset + columnIdx + 1}`);
    return `(${placeholders.join(', ')})`;
  });
  const selects = columns.map((column) => `incoming.${column}`).join(', ');

  return `
    WITH incoming (${cteColumns}) AS (
      VALUES ${values.join(', ')}
    )
    INSERT INTO ${tableName} (${cteColumns})
    SELECT ${selects}
    FROM incoming
    WHERE NOT EXISTS (
      SELECT 1 FROM ${tableName} existing
      WHERE existing.${keyColumn} = incoming.${keyColumn}
    )
  `;
}

/**
 * Hyperdrive audit storage adapter implementation.
 *
 * Tables expected:
 * - {schema}.event_log - Same structure as D1 event_log
 * - {schema}.pii_log - Same structure as D1 pii_log
 */
export class HyperdriveAuditAdapter implements IAuditStorageAdapter {
  private readonly id: string;
  private readonly hyperdrive: Hyperdrive;
  private readonly schema: string;
  private readonly isPiiDb: boolean;
  private readonly clientFactory?: HyperdriveAuditAdapterConfig['clientFactory'];
  private client: PgClient | null = null;

  constructor(config: HyperdriveAuditAdapterConfig) {
    this.id = config.id;
    this.hyperdrive = config.hyperdrive;
    this.schema = sanitizeIdentifier(config.schema);
    this.isPiiDb = config.isPiiDb;
    this.clientFactory = config.clientFactory;
  }

  getBackendType(): AuditStorageBackendType {
    return 'HYPERDRIVE';
  }

  getIdentifier(): string {
    return this.id;
  }

  /**
   * Get or create a PostgreSQL client.
   * Note: In production, use a proper PostgreSQL client library like 'pg'.
   * This is a simplified implementation for demonstration.
   */
  private async getClient(): Promise<PgClient> {
    if (this.client) return this.client;

    const connectionString = this.hyperdrive.connectionString;

    if (this.clientFactory) {
      this.client = await this.clientFactory(connectionString);
      return this.client;
    }

    const { Client } = await import('pg');
    const rawClient: NodePgClient = new Client({
      connectionString,
      application_name: 'authrim-audit',
    });
    await rawClient.connect();

    this.client = {
      query: async <T = unknown>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>> => {
        const result = await rawClient.query(sql, params);
        return {
          rows: result.rows as T[],
          rowCount: result.rowCount ?? result.rows.length,
        };
      },
      end: async () => {
        await rawClient.end();
      },
    };

    return this.client;
  }

  // ---------------------------------------------------------------------------
  // Write Operations
  // ---------------------------------------------------------------------------

  async writeEventLog(entry: EventLogEntry): Promise<AuditWriteResult> {
    return this.writeEventLogBatch([entry]);
  }

  async writeEventLogBatch(entries: EventLogEntry[]): Promise<AuditWriteResult> {
    if (entries.length === 0) {
      return {
        success: true,
        entriesWritten: 0,
        backend: this.id,
        durationMs: 0,
      };
    }

    const startTime = Date.now();

    try {
      const client = await this.getClient();

      const values: unknown[] = [];
      const columns = [
        'id',
        'tenant_id',
        'event_type',
        'event_category',
        'result',
        'severity',
        'error_code',
        'error_message',
        'anonymized_user_id',
        'client_id',
        'session_id',
        'request_id',
        'duration_ms',
        'details_r2_key',
        'details_json',
        'retention_until',
        'created_at',
      ] as const;

      entries.forEach((e) => {
        values.push(
          e.id,
          e.tenantId,
          e.eventType,
          e.eventCategory,
          e.result,
          e.severity,
          e.errorCode ?? null,
          e.errorMessage ?? null,
          e.anonymizedUserId ?? null,
          e.clientId ?? null,
          e.sessionId ?? null,
          e.requestId ?? null,
          e.durationMs ?? null,
          e.detailsR2Key ?? null,
          e.detailsJson ?? null,
          e.retentionUntil ?? null,
          e.createdAt
        );
      });

      const sql = buildInsertIfNotExistsSql(
        `${this.schema}.event_log`,
        [...columns],
        'id',
        entries.length
      );

      await client.query(sql, values);

      return {
        success: true,
        entriesWritten: entries.length,
        backend: this.id,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        entriesWritten: 0,
        backend: this.id,
        durationMs: Date.now() - startTime,
        errorMessage: String(error),
      };
    }
  }

  async writePIILog(entry: PIILogEntry): Promise<AuditWriteResult> {
    return this.writePIILogBatch([entry]);
  }

  async writePIILogBatch(entries: PIILogEntry[]): Promise<AuditWriteResult> {
    if (entries.length === 0) {
      return {
        success: true,
        entriesWritten: 0,
        backend: this.id,
        durationMs: 0,
      };
    }

    const startTime = Date.now();

    try {
      const client = await this.getClient();

      const values: unknown[] = [];
      const columns = [
        'id',
        'tenant_id',
        'user_id',
        'anonymized_user_id',
        'change_type',
        'affected_fields',
        'values_r2_key',
        'values_encrypted',
        'encryption_key_id',
        'encryption_iv',
        'actor_user_id',
        'actor_type',
        'request_id',
        'legal_basis',
        'consent_reference',
        'retention_until',
        'created_at',
      ] as const;

      entries.forEach((e) => {
        values.push(
          e.id,
          e.tenantId,
          e.userId,
          e.anonymizedUserId,
          e.changeType,
          e.affectedFields,
          e.valuesR2Key ?? null,
          e.valuesEncrypted ?? null,
          e.encryptionKeyId,
          e.encryptionIv,
          e.actorUserId ?? null,
          e.actorType,
          e.requestId ?? null,
          e.legalBasis ?? null,
          e.consentReference ?? null,
          e.retentionUntil,
          e.createdAt
        );
      });

      const sql = buildInsertIfNotExistsSql(
        `${this.schema}.pii_log`,
        [...columns],
        'id',
        entries.length
      );

      await client.query(sql, values);

      return {
        success: true,
        entriesWritten: entries.length,
        backend: this.id,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        entriesWritten: 0,
        backend: this.id,
        durationMs: Date.now() - startTime,
        errorMessage: String(error),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Query Operations
  // ---------------------------------------------------------------------------

  async query(options: AuditQueryOptions): Promise<AuditQueryResult> {
    const startTime = Date.now();

    try {
      const client = await this.getClient();

      if (options.logType === 'event') {
        return this.queryEventLog(client, options, startTime);
      } else {
        return this.queryPIILog(client, options, startTime);
      }
    } catch (error) {
      return {
        eventEntries: options.logType === 'event' ? [] : undefined,
        piiEntries: options.logType === 'pii' ? [] : undefined,
        totalCount: 0,
        hasMore: false,
        durationMs: Date.now() - startTime,
        backend: this.id,
      };
    }
  }

  private async queryEventLog(
    client: PgClient,
    options: AuditQueryOptions,
    startTime: number
  ): Promise<AuditQueryResult> {
    const { sql, params } = this.buildEventLogQuery(options);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    // Query with limit + 1 to check hasMore
    const result = await client.query<EventLogDbRow>(
      `${sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit + 1, offset]
    );

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const entries = (hasMore ? rows.slice(0, limit) : rows).map((row) => this.mapEventLogRow(row));

    // Get total count
    let totalCount = entries.length + offset;
    if (hasMore || offset > 0) {
      const countSql = `SELECT COUNT(*) as count FROM ${this.schema}.event_log WHERE ${this.buildWhereClause(options, params).join(' AND ')}`;
      const countResult = await client.query<{ count: string }>(countSql, params);
      totalCount = parseInt(countResult.rows[0]?.count ?? '0', 10);
    }

    return {
      eventEntries: entries,
      totalCount,
      hasMore,
      durationMs: Date.now() - startTime,
      backend: this.id,
    };
  }

  private async queryPIILog(
    client: PgClient,
    options: AuditQueryOptions,
    startTime: number
  ): Promise<AuditQueryResult> {
    const { sql, params } = this.buildPIILogQuery(options);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const result = await client.query<PIILogDbRow>(
      `${sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit + 1, offset]
    );

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const entries = (hasMore ? rows.slice(0, limit) : rows).map((row) => this.mapPIILogRow(row));

    let totalCount = entries.length + offset;
    if (hasMore || offset > 0) {
      const countSql = `SELECT COUNT(*) as count FROM ${this.schema}.pii_log WHERE ${this.buildWhereClause(options, params).join(' AND ')}`;
      const countResult = await client.query<{ count: string }>(countSql, params);
      totalCount = parseInt(countResult.rows[0]?.count ?? '0', 10);
    }

    return {
      piiEntries: entries,
      totalCount,
      hasMore,
      durationMs: Date.now() - startTime,
      backend: this.id,
    };
  }

  private buildEventLogQuery(options: AuditQueryOptions): {
    sql: string;
    params: unknown[];
  } {
    const params: unknown[] = [];
    const conditions = this.buildWhereClause(options, params);

    const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const sql = `
      SELECT id, tenant_id, event_type, event_category, result, severity,
             error_code, error_message, anonymized_user_id, client_id,
             session_id, request_id, duration_ms, details_r2_key, details_json,
             retention_until, created_at
      FROM ${this.schema}.event_log
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ${sortOrder}
    `;

    return { sql, params };
  }

  private buildPIILogQuery(options: AuditQueryOptions): {
    sql: string;
    params: unknown[];
  } {
    const params: unknown[] = [];
    const conditions = this.buildWhereClause(options, params);

    const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const sql = `
      SELECT id, tenant_id, user_id, anonymized_user_id, change_type, affected_fields,
             values_r2_key, values_encrypted, encryption_key_id, encryption_iv,
             actor_user_id, actor_type, request_id, legal_basis, consent_reference,
             retention_until, created_at
      FROM ${this.schema}.pii_log
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ${sortOrder}
    `;

    return { sql, params };
  }

  private buildWhereClause(options: AuditQueryOptions, params: unknown[]): string[] {
    const conditions: string[] = [];

    params.push(options.tenantId);
    conditions.push(`tenant_id = $${params.length}`);

    if (options.startTime !== undefined) {
      params.push(options.startTime);
      conditions.push(`created_at >= $${params.length}`);
    }

    if (options.endTime !== undefined) {
      params.push(options.endTime);
      conditions.push(`created_at < $${params.length}`);
    }

    if (options.logType === 'event') {
      if (options.eventType) {
        params.push(options.eventType);
        conditions.push(`event_type = $${params.length}`);
      }

      if (options.eventCategory) {
        params.push(options.eventCategory);
        conditions.push(`event_category = $${params.length}`);
      }

      if (options.result) {
        params.push(options.result);
        conditions.push(`result = $${params.length}`);
      }

      if (options.clientId) {
        params.push(options.clientId);
        conditions.push(`client_id = $${params.length}`);
      }
    }

    if (options.logType === 'pii') {
      if (options.userId) {
        params.push(options.userId);
        conditions.push(`user_id = $${params.length}`);
      }

      if (options.changeType) {
        params.push(options.changeType);
        conditions.push(`change_type = $${params.length}`);
      }
    }

    if (options.anonymizedUserId) {
      params.push(options.anonymizedUserId);
      conditions.push(`anonymized_user_id = $${params.length}`);
    }

    if (options.requestId) {
      params.push(options.requestId);
      conditions.push(`request_id = $${params.length}`);
    }

    return conditions;
  }

  async count(options: Omit<AuditQueryOptions, 'limit' | 'offset'>): Promise<number> {
    try {
      const client = await this.getClient();
      const params: unknown[] = [];
      const conditions = this.buildWhereClause(options as AuditQueryOptions, params);
      const table = options.logType === 'event' ? 'event_log' : 'pii_log';

      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM ${this.schema}.${table} WHERE ${conditions.join(' AND ')}`,
        params
      );

      return parseInt(result.rows[0]?.count ?? '0', 10);
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Row Mappers
  // ---------------------------------------------------------------------------

  private mapEventLogRow(row: EventLogDbRow): EventLogEntry {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      eventType: row.event_type,
      eventCategory: row.event_category as EventLogEntry['eventCategory'],
      result: row.result as EventLogEntry['result'],
      severity: row.severity as EventLogEntry['severity'],
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      anonymizedUserId: row.anonymized_user_id ?? undefined,
      clientId: row.client_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      requestId: row.request_id ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      detailsR2Key: row.details_r2_key ?? undefined,
      detailsJson: row.details_json ?? undefined,
      retentionUntil: row.retention_until ?? undefined,
      createdAt: row.created_at,
    };
  }

  private mapPIILogRow(row: PIILogDbRow): PIILogEntry {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      anonymizedUserId: row.anonymized_user_id,
      changeType: row.change_type as PIILogEntry['changeType'],
      affectedFields: row.affected_fields,
      valuesR2Key: row.values_r2_key ?? undefined,
      valuesEncrypted: row.values_encrypted ?? undefined,
      encryptionKeyId: row.encryption_key_id,
      encryptionIv: row.encryption_iv,
      actorUserId: row.actor_user_id ?? undefined,
      actorType: row.actor_type as PIILogEntry['actorType'],
      requestId: row.request_id ?? undefined,
      legalBasis: row.legal_basis as PIILogEntry['legalBasis'] | undefined,
      consentReference: row.consent_reference ?? undefined,
      retentionUntil: row.retention_until,
      createdAt: row.created_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Maintenance Operations
  // ---------------------------------------------------------------------------

  async listTenantRetentionCandidates(
    logType: 'event',
    beforeTime: number,
    tenantId: string,
    batchSize?: number
  ): Promise<EventLogEntry[]>;
  async listTenantRetentionCandidates(
    logType: 'pii',
    beforeTime: number,
    tenantId: string,
    batchSize?: number
  ): Promise<PIILogEntry[]>;
  async listTenantRetentionCandidates(
    logType: AuditLogType,
    beforeTime: number,
    tenantId: string,
    batchSize?: number
  ): Promise<EventLogEntry[] | PIILogEntry[]> {
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) {
      throw new Error('Audit retention candidate listing requires tenantId');
    }
    return this.listRetentionCandidatesInternal(logType, beforeTime, normalizedTenantId, batchSize);
  }

  async listGlobalRetentionCandidates(
    logType: 'event',
    beforeTime: number,
    batchSize?: number
  ): Promise<EventLogEntry[]>;
  async listGlobalRetentionCandidates(
    logType: 'pii',
    beforeTime: number,
    batchSize?: number
  ): Promise<PIILogEntry[]>;
  async listGlobalRetentionCandidates(
    logType: AuditLogType,
    beforeTime: number,
    batchSize?: number
  ): Promise<EventLogEntry[] | PIILogEntry[]> {
    return this.listRetentionCandidatesInternal(logType, beforeTime, undefined, batchSize);
  }

  async deleteTenantByRetention(
    logType: AuditLogType,
    beforeTime: number,
    tenantId: string,
    batchSize?: number
  ): Promise<number> {
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) {
      throw new Error('Audit retention deletion requires tenantId');
    }
    return this.deleteByRetentionInternal(logType, beforeTime, normalizedTenantId, batchSize);
  }

  async deleteGlobalByRetention(
    logType: AuditLogType,
    beforeTime: number,
    batchSize?: number
  ): Promise<number> {
    return this.deleteByRetentionInternal(logType, beforeTime, undefined, batchSize);
  }

  private async listRetentionCandidatesInternal(
    logType: 'event',
    beforeTime: number,
    tenantId?: string,
    batchSize?: number
  ): Promise<EventLogEntry[]>;
  private async listRetentionCandidatesInternal(
    logType: 'pii',
    beforeTime: number,
    tenantId?: string,
    batchSize?: number
  ): Promise<PIILogEntry[]>;
  private async listRetentionCandidatesInternal(
    logType: AuditLogType,
    beforeTime: number,
    tenantId?: string,
    batchSize?: number
  ): Promise<EventLogEntry[] | PIILogEntry[]>;
  private async listRetentionCandidatesInternal(
    logType: AuditLogType,
    beforeTime: number,
    tenantId?: string,
    batchSize: number = 1000
  ): Promise<EventLogEntry[] | PIILogEntry[]> {
    try {
      const client = await this.getClient();
      const table = logType === 'event' ? 'event_log' : 'pii_log';
      const selectColumns =
        logType === 'event'
          ? `id, tenant_id, event_type, event_category, result, severity,
             error_code, error_message, anonymized_user_id, client_id,
             session_id, request_id, duration_ms, details_r2_key, details_json,
             retention_until, created_at`
          : `id, tenant_id, user_id, anonymized_user_id, change_type, affected_fields,
             values_r2_key, values_encrypted, encryption_key_id, encryption_iv,
             actor_user_id, actor_type, request_id, legal_basis, consent_reference,
             retention_until, created_at`;

      let sql: string;
      let params: unknown[];
      if (tenantId) {
        sql = `
          SELECT ${selectColumns}
          FROM ${this.schema}.${table}
          WHERE retention_until < $1 AND tenant_id = $2
          ORDER BY retention_until ASC, created_at ASC, id ASC
          LIMIT $3
        `;
        params = [beforeTime, tenantId, batchSize];
      } else {
        sql = `
          SELECT ${selectColumns}
          FROM ${this.schema}.${table}
          WHERE retention_until < $1
          ORDER BY retention_until ASC, created_at ASC, id ASC
          LIMIT $2
        `;
        params = [beforeTime, batchSize];
      }

      if (logType === 'event') {
        const result = await client.query<EventLogDbRow>(sql, params);
        return result.rows.map((row) => this.mapEventLogRow(row));
      }

      const result = await client.query<PIILogDbRow>(sql, params);
      return result.rows.map((row) => this.mapPIILogRow(row));
    } catch {
      return [];
    }
  }

  private async deleteByRetentionInternal(
    logType: AuditLogType,
    beforeTime: number,
    tenantId?: string,
    batchSize: number = 1000
  ): Promise<number> {
    try {
      const client = await this.getClient();
      const table = logType === 'event' ? 'event_log' : 'pii_log';

      let sql: string;
      let params: unknown[];

      if (tenantId) {
        sql = `
          WITH doomed AS (
            SELECT ctid
            FROM ${this.schema}.${table}
            WHERE retention_until < $1 AND tenant_id = $2
            ORDER BY retention_until ASC, created_at ASC, id ASC
            LIMIT $3
          )
          DELETE FROM ${this.schema}.${table}
          WHERE ctid IN (SELECT ctid FROM doomed)
        `;
        params = [beforeTime, tenantId, batchSize];
      } else {
        sql = `
          WITH doomed AS (
            SELECT ctid
            FROM ${this.schema}.${table}
            WHERE retention_until < $1
            ORDER BY retention_until ASC, created_at ASC, id ASC
            LIMIT $2
          )
          DELETE FROM ${this.schema}.${table}
          WHERE ctid IN (SELECT ctid FROM doomed)
        `;
        params = [beforeTime, batchSize];
      }

      const result = await client.query(sql, params);
      return result.rowCount;
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Health Check
  // ---------------------------------------------------------------------------

  async isHealthy(): Promise<AuditStorageHealth> {
    const startTime = Date.now();

    try {
      const client = await this.getClient();
      await client.query('SELECT 1');

      return {
        healthy: true,
        backend: this.id,
        backendType: 'HYPERDRIVE',
        latencyMs: Date.now() - startTime,
        details: {
          schema: this.schema,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        backend: this.id,
        backendType: 'HYPERDRIVE',
        latencyMs: Date.now() - startTime,
        errorMessage: String(error),
      };
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Database Row Types
// ---------------------------------------------------------------------------

interface EventLogDbRow {
  id: string;
  tenant_id: string;
  event_type: string;
  event_category: string;
  result: string;
  severity: string;
  error_code: string | null;
  error_message: string | null;
  anonymized_user_id: string | null;
  client_id: string | null;
  session_id: string | null;
  request_id: string | null;
  duration_ms: number | null;
  details_r2_key: string | null;
  details_json: string | null;
  retention_until: number | null;
  created_at: number;
}

interface PIILogDbRow {
  id: string;
  tenant_id: string;
  user_id: string;
  anonymized_user_id: string;
  change_type: string;
  affected_fields: string;
  values_r2_key: string | null;
  values_encrypted: string | null;
  encryption_key_id: string;
  encryption_iv: string;
  actor_user_id: string | null;
  actor_type: string;
  request_id: string | null;
  legal_basis: string | null;
  consent_reference: string | null;
  retention_until: number;
  created_at: number;
}

/**
 * Create a Hyperdrive audit adapter.
 */
export function createHyperdriveAuditAdapter(
  hyperdrive: Hyperdrive,
  options?: {
    id?: string;
    schema?: string;
    isPiiDb?: boolean;
    clientFactory?: HyperdriveAuditAdapterConfig['clientFactory'];
  }
): HyperdriveAuditAdapter {
  return new HyperdriveAuditAdapter({
    id: options?.id ?? 'hyperdrive-audit',
    hyperdrive,
    schema: options?.schema ?? 'audit',
    isPiiDb: options?.isPiiDb ?? false,
    clientFactory: options?.clientFactory,
  });
}
