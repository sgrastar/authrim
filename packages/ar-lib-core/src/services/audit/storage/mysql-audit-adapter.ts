import type { EventLogEntry, PIILogEntry } from '../types';
import {
  openMysqlConnection,
  type MysqlConnectionFactory,
  type MysqlConnectionLike,
} from '../../../db/adapters/mysql-connection';
import type {
  IAuditStorageAdapter,
  AuditStorageBackendType,
  AuditWriteResult,
  AuditQueryOptions,
  AuditQueryResult,
  AuditStorageHealth,
  AuditLogType,
} from './adapter';

export interface MysqlAuditAdapterConfig {
  id: string;
  hyperdrive: Hyperdrive;
  schema?: string;
  isPiiDb: boolean;
  clientFactory?: MysqlConnectionFactory;
}

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

function sanitizeIdentifier(identifier: string | undefined): string | null {
  if (!identifier) {
    return null;
  }
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`invalid_sql_identifier:${identifier}`);
  }
  return identifier;
}

function qualifyTable(schema: string | undefined, table: string): string {
  const safeSchema = sanitizeIdentifier(schema);
  const safeTable = sanitizeIdentifier(table);
  if (!safeTable) {
    throw new Error('invalid_sql_identifier:table');
  }
  if (!safeSchema) {
    return `\`${safeTable}\``;
  }
  return `\`${safeSchema}\`.\`${safeTable}\``;
}

function buildInsertIfNotExistsSql(
  tableName: string,
  columns: string[],
  keyColumn: string,
  rowCount: number
): string {
  const selectStatements = Array.from({ length: rowCount }, (_, rowIdx) => {
    const offset = rowIdx * columns.length;
    if (rowIdx === 0) {
      return `SELECT ${columns
        .map((column, columnIdx) => `? AS \`${column}\``)
        .join(', ')}`;
    }
    return `SELECT ${columns.map(() => '?').join(', ')}`;
  });

  const quotedColumns = columns.map((column) => `\`${column}\``).join(', ');
  const selectedColumns = columns.map((column) => `incoming.\`${column}\``).join(', ');

  return `
    INSERT INTO ${tableName} (${quotedColumns})
    SELECT ${selectedColumns}
    FROM (
      ${selectStatements.join('\n      UNION ALL\n      ')}
    ) incoming
    WHERE NOT EXISTS (
      SELECT 1 FROM ${tableName} existing
      WHERE existing.\`${keyColumn}\` = incoming.\`${keyColumn}\`
    )
  `;
}

export class MysqlAuditAdapter implements IAuditStorageAdapter {
  private readonly id: string;
  private readonly hyperdrive: Hyperdrive;
  private readonly schema?: string;
  private readonly isPiiDb: boolean;
  private readonly clientFactory?: MysqlAuditAdapterConfig['clientFactory'];
  private client: MysqlConnectionLike | null = null;

  constructor(config: MysqlAuditAdapterConfig) {
    this.id = config.id;
    this.hyperdrive = config.hyperdrive;
    this.schema = config.schema;
    this.isPiiDb = config.isPiiDb;
    this.clientFactory = config.clientFactory;
  }

  getBackendType(): AuditStorageBackendType {
    return 'HYPERDRIVE';
  }

  getIdentifier(): string {
    return this.id;
  }

  private async getClient(): Promise<MysqlConnectionLike> {
    if (this.client) {
      return this.client;
    }

    this.client = await openMysqlConnection(
      {
        hyperdrive: this.hyperdrive,
      },
      this.clientFactory
    );
    return this.client;
  }

  async writeEventLog(entry: EventLogEntry): Promise<AuditWriteResult> {
    return this.writeEventLogBatch([entry]);
  }

  async writeEventLogBatch(entries: EventLogEntry[]): Promise<AuditWriteResult> {
    if (entries.length === 0) {
      return { success: true, entriesWritten: 0, backend: this.id, durationMs: 0 };
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
      entries.forEach((entry) => {
        values.push(
          entry.id,
          entry.tenantId,
          entry.eventType,
          entry.eventCategory,
          entry.result,
          entry.severity,
          entry.errorCode ?? null,
          entry.errorMessage ?? null,
          entry.anonymizedUserId ?? null,
          entry.clientId ?? null,
          entry.sessionId ?? null,
          entry.requestId ?? null,
          entry.durationMs ?? null,
          entry.detailsR2Key ?? null,
          entry.detailsJson ?? null,
          entry.retentionUntil ?? null,
          entry.createdAt
        );
      });

      await client.execute(
        buildInsertIfNotExistsSql(
          qualifyTable(this.schema, 'event_log'),
          [...columns],
          'id',
          entries.length
        ),
        values
      );

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
      return { success: true, entriesWritten: 0, backend: this.id, durationMs: 0 };
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
      entries.forEach((entry) => {
        values.push(
          entry.id,
          entry.tenantId,
          entry.userId,
          entry.anonymizedUserId,
          entry.changeType,
          entry.affectedFields,
          entry.valuesR2Key ?? null,
          entry.valuesEncrypted ?? null,
          entry.encryptionKeyId,
          entry.encryptionIv,
          entry.actorUserId ?? null,
          entry.actorType,
          entry.requestId ?? null,
          entry.legalBasis ?? null,
          entry.consentReference ?? null,
          entry.retentionUntil,
          entry.createdAt
        );
      });

      await client.execute(
        buildInsertIfNotExistsSql(
          qualifyTable(this.schema, 'pii_log'),
          [...columns],
          'id',
          entries.length
        ),
        values
      );

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

  async query(options: AuditQueryOptions): Promise<AuditQueryResult> {
    const startTime = Date.now();

    try {
      const client = await this.getClient();
      if (options.logType === 'event') {
        return this.queryEventLog(client, options, startTime);
      }
      return this.queryPIILog(client, options, startTime);
    } catch {
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
    client: MysqlConnectionLike,
    options: AuditQueryOptions,
    startTime: number
  ): Promise<AuditQueryResult> {
    const { sql, params } = this.buildEventLogQuery(options);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const result = await client.query<EventLogDbRow>(
      `${sql} LIMIT ? OFFSET ?`,
      [...params, limit + 1, offset]
    );

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const entries = (hasMore ? rows.slice(0, limit) : rows).map((row) => this.mapEventLogRow(row));
    let totalCount = entries.length + offset;

    if (hasMore || offset > 0) {
      const countResult = await client.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${qualifyTable(this.schema, 'event_log')} WHERE ${this.buildWhereClause(options, []).conditions.join(' AND ')}`,
        params
      );
      totalCount = Number(countResult.rows[0]?.count ?? 0);
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
    client: MysqlConnectionLike,
    options: AuditQueryOptions,
    startTime: number
  ): Promise<AuditQueryResult> {
    const { sql, params } = this.buildPIILogQuery(options);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const result = await client.query<PIILogDbRow>(
      `${sql} LIMIT ? OFFSET ?`,
      [...params, limit + 1, offset]
    );

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const entries = (hasMore ? rows.slice(0, limit) : rows).map((row) => this.mapPIILogRow(row));
    let totalCount = entries.length + offset;

    if (hasMore || offset > 0) {
      const countResult = await client.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${qualifyTable(this.schema, 'pii_log')} WHERE ${this.buildWhereClause(options, []).conditions.join(' AND ')}`,
        params
      );
      totalCount = Number(countResult.rows[0]?.count ?? 0);
    }

    return {
      piiEntries: entries,
      totalCount,
      hasMore,
      durationMs: Date.now() - startTime,
      backend: this.id,
    };
  }

  private buildEventLogQuery(options: AuditQueryOptions): { sql: string; params: unknown[] } {
    const { conditions, params } = this.buildWhereClause(options, []);
    const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';
    return {
      sql: `
        SELECT id, tenant_id, event_type, event_category, result, severity,
               error_code, error_message, anonymized_user_id, client_id,
               session_id, request_id, duration_ms, details_r2_key, details_json,
               retention_until, created_at
        FROM ${qualifyTable(this.schema, 'event_log')}
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at ${sortOrder}
      `,
      params,
    };
  }

  private buildPIILogQuery(options: AuditQueryOptions): { sql: string; params: unknown[] } {
    const { conditions, params } = this.buildWhereClause(options, []);
    const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';
    return {
      sql: `
        SELECT id, tenant_id, user_id, anonymized_user_id, change_type, affected_fields,
               values_r2_key, values_encrypted, encryption_key_id, encryption_iv,
               actor_user_id, actor_type, request_id, legal_basis, consent_reference,
               retention_until, created_at
        FROM ${qualifyTable(this.schema, 'pii_log')}
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at ${sortOrder}
      `,
      params,
    };
  }

  private buildWhereClause(
    options: AuditQueryOptions,
    params: unknown[]
  ): { conditions: string[]; params: unknown[] } {
    const conditions: string[] = [];

    params.push(options.tenantId);
    conditions.push('tenant_id = ?');

    if (options.startTime !== undefined) {
      params.push(options.startTime);
      conditions.push('created_at >= ?');
    }

    if (options.endTime !== undefined) {
      params.push(options.endTime);
      conditions.push('created_at < ?');
    }

    if (options.logType === 'event') {
      if (options.eventType) {
        params.push(options.eventType);
        conditions.push('event_type = ?');
      }
      if (options.eventCategory) {
        params.push(options.eventCategory);
        conditions.push('event_category = ?');
      }
      if (options.result) {
        params.push(options.result);
        conditions.push('result = ?');
      }
      if (options.clientId) {
        params.push(options.clientId);
        conditions.push('client_id = ?');
      }
    }

    if (options.logType === 'pii') {
      if (options.userId) {
        params.push(options.userId);
        conditions.push('user_id = ?');
      }
      if (options.changeType) {
        params.push(options.changeType);
        conditions.push('change_type = ?');
      }
    }

    if (options.anonymizedUserId) {
      params.push(options.anonymizedUserId);
      conditions.push('anonymized_user_id = ?');
    }
    if (options.requestId) {
      params.push(options.requestId);
      conditions.push('request_id = ?');
    }

    return { conditions, params };
  }

  async count(options: Omit<AuditQueryOptions, 'limit' | 'offset'>): Promise<number> {
    try {
      const client = await this.getClient();
      const { conditions, params } = this.buildWhereClause(options as AuditQueryOptions, []);
      const table = options.logType === 'event' ? 'event_log' : 'pii_log';
      const result = await client.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${qualifyTable(this.schema, table)} WHERE ${conditions.join(' AND ')}`,
        params
      );
      return Number(result.rows[0]?.count ?? 0);
    } catch {
      return 0;
    }
  }

  async listRetentionCandidates(
    logType: 'event',
    beforeTime: number,
    tenantId?: string,
    batchSize?: number
  ): Promise<EventLogEntry[]>;
  async listRetentionCandidates(
    logType: 'pii',
    beforeTime: number,
    tenantId?: string,
    batchSize?: number
  ): Promise<PIILogEntry[]>;
  async listRetentionCandidates(
    logType: AuditLogType,
    beforeTime: number,
    tenantId?: string,
    batchSize: number = 1000
  ): Promise<EventLogEntry[] | PIILogEntry[]> {
    try {
      const client = await this.getClient();
      const table = qualifyTable(this.schema, logType === 'event' ? 'event_log' : 'pii_log');
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
      const where = tenantId ? 'retention_until < ? AND tenant_id = ?' : 'retention_until < ?';
      const params = tenantId ? [beforeTime, tenantId, batchSize] : [beforeTime, batchSize];
      const result = await client.query<EventLogDbRow | PIILogDbRow>(
        `SELECT ${selectColumns}
         FROM ${table}
         WHERE ${where}
         ORDER BY retention_until ASC, created_at ASC, id ASC
         LIMIT ?`,
        params
      );

      if (logType === 'event') {
        return result.rows.map((row) => this.mapEventLogRow(row as EventLogDbRow));
      }
      return result.rows.map((row) => this.mapPIILogRow(row as PIILogDbRow));
    } catch {
      return [];
    }
  }

  async deleteByRetention(
    logType: AuditLogType,
    beforeTime: number,
    tenantId?: string,
    batchSize: number = 1000
  ): Promise<number> {
    try {
      const client = await this.getClient();
      const table = qualifyTable(this.schema, logType === 'event' ? 'event_log' : 'pii_log');
      const params = tenantId ? [beforeTime, tenantId, batchSize] : [beforeTime, batchSize];
      const where = tenantId ? 'target.retention_until < ? AND target.tenant_id = ?' : 'target.retention_until < ?';
      const subqueryWhere = tenantId ? 'retention_until < ? AND tenant_id = ?' : 'retention_until < ?';
      const result = await client.execute(
        `DELETE target
         FROM ${table} target
         INNER JOIN (
           SELECT id
           FROM ${table}
           WHERE ${subqueryWhere}
           ORDER BY retention_until ASC, created_at ASC, id ASC
           LIMIT ?
         ) doomed ON doomed.id = target.id
         WHERE ${where}`,
        params
      );
      return result.affectedRows ?? 0;
    } catch {
      return 0;
    }
  }

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
          schema: this.schema ?? '(connection-default)',
          engine: 'mysql',
          isPiiDb: this.isPiiDb,
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
}

export function createMysqlAuditAdapter(
  hyperdrive: Hyperdrive,
  options?: {
    id?: string;
    schema?: string;
    isPiiDb?: boolean;
    clientFactory?: MysqlAuditAdapterConfig['clientFactory'];
  }
): MysqlAuditAdapter {
  return new MysqlAuditAdapter({
    id: options?.id ?? 'mysql-audit',
    hyperdrive,
    schema: options?.schema,
    isPiiDb: options?.isPiiDb ?? false,
    clientFactory: options?.clientFactory,
  });
}
