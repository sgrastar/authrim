/**
 * D1 Audit Storage Adapter
 *
 * Storage adapter for Cloudflare D1 (SQLite).
 * Used for hot data storage with fast query access.
 *
 * Features:
 * - Idempotent writes using ON CONFLICT DO NOTHING
 * - Batch operations for efficiency
 * - Index-optimized queries
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { EventLogEntry, PIILogEntry } from '../types';
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
 * D1 adapter configuration.
 */
export interface D1AuditAdapterConfig {
  /** Unique identifier for this adapter */
  id: string;

  /** Database binding */
  db: D1Database;

  /** Whether this is a PII database */
  isPiiDb: boolean;
}

/**
 * D1 audit storage adapter implementation.
 */
export class D1AuditAdapter implements IAuditStorageAdapter {
  private readonly id: string;
  private readonly db: D1Database;
  private readonly isPiiDb: boolean;

  constructor(config: D1AuditAdapterConfig) {
    this.id = config.id;
    this.db = config.db;
    this.isPiiDb = config.isPiiDb;
  }

  getBackendType(): AuditStorageBackendType {
    return 'D1';
  }

  getIdentifier(): string {
    return this.id;
  }

  // ---------------------------------------------------------------------------
  // Event Log Operations
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
      const stmt = this.db.prepare(`
        INSERT INTO event_log (
          id, tenant_id, event_type, event_category, result, severity,
          error_code, error_message, anonymized_user_id, client_id,
          session_id, request_id, duration_ms, details_r2_key, details_json,
          retention_until, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `);

      const batch = entries.map((e) =>
        stmt.bind(
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
        )
      );

      await this.db.batch(batch);

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
  // PII Log Operations
  // ---------------------------------------------------------------------------

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
      const stmt = this.db.prepare(`
        INSERT INTO pii_log (
          id, tenant_id, user_id, anonymized_user_id, change_type, affected_fields,
          values_r2_key, values_encrypted, encryption_key_id, encryption_iv,
          actor_user_id, actor_type, request_id, legal_basis, consent_reference,
          retention_until, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `);

      const batch = entries.map((e) =>
        stmt.bind(
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
        )
      );

      await this.db.batch(batch);

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

    if (options.logType === 'event') {
      return this.queryEventLog(options, startTime);
    } else {
      return this.queryPIILog(options, startTime);
    }
  }

  private async queryEventLog(
    options: AuditQueryOptions,
    startTime: number
  ): Promise<AuditQueryResult> {
    const { sql, params } = this.buildEventLogQuery(options);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    try {
      // Execute query with limit + 1 to check hasMore
      const results = await this.db
        .prepare(`${sql} LIMIT ? OFFSET ?`)
        .bind(...params, limit + 1, offset)
        .all<{
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
        }>();

      const rows = results.results ?? [];
      const hasMore = rows.length > limit;
      const entries = (hasMore ? rows.slice(0, limit) : rows).map((row) =>
        this.mapEventLogRow(row)
      );

      // Get total count (only if pagination is used)
      let totalCount = entries.length + offset;
      if (hasMore || offset > 0) {
        const countSql = sql.replace(/^SELECT .* FROM/, 'SELECT COUNT(*) as count FROM');
        const countResult = await this.db
          .prepare(countSql)
          .bind(...params)
          .first<{ count: number }>();
        totalCount = countResult?.count ?? 0;
      }

      return {
        eventEntries: entries,
        totalCount,
        hasMore,
        durationMs: Date.now() - startTime,
        backend: this.id,
      };
    } catch (error) {
      return {
        eventEntries: [],
        totalCount: 0,
        hasMore: false,
        durationMs: Date.now() - startTime,
        backend: this.id,
      };
    }
  }

  private async queryPIILog(
    options: AuditQueryOptions,
    startTime: number
  ): Promise<AuditQueryResult> {
    const { sql, params } = this.buildPIILogQuery(options);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    try {
      const results = await this.db
        .prepare(`${sql} LIMIT ? OFFSET ?`)
        .bind(...params, limit + 1, offset)
        .all<{
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
        }>();

      const rows = results.results ?? [];
      const hasMore = rows.length > limit;
      const entries = (hasMore ? rows.slice(0, limit) : rows).map((row) => this.mapPIILogRow(row));

      let totalCount = entries.length + offset;
      if (hasMore || offset > 0) {
        const countSql = sql.replace(/^SELECT .* FROM/, 'SELECT COUNT(*) as count FROM');
        const countResult = await this.db
          .prepare(countSql)
          .bind(...params)
          .first<{ count: number }>();
        totalCount = countResult?.count ?? 0;
      }

      return {
        piiEntries: entries,
        totalCount,
        hasMore,
        durationMs: Date.now() - startTime,
        backend: this.id,
      };
    } catch (error) {
      return {
        piiEntries: [],
        totalCount: 0,
        hasMore: false,
        durationMs: Date.now() - startTime,
        backend: this.id,
      };
    }
  }

  private buildEventLogQuery(options: AuditQueryOptions): {
    sql: string;
    params: unknown[];
  } {
    const conditions: string[] = ['tenant_id = ?'];
    const params: unknown[] = [options.tenantId];

    if (options.startTime !== undefined) {
      conditions.push('created_at >= ?');
      params.push(options.startTime);
    }

    if (options.endTime !== undefined) {
      conditions.push('created_at < ?');
      params.push(options.endTime);
    }

    if (options.eventType) {
      conditions.push('event_type = ?');
      params.push(options.eventType);
    }

    if (options.eventCategory) {
      conditions.push('event_category = ?');
      params.push(options.eventCategory);
    }

    if (options.result) {
      conditions.push('result = ?');
      params.push(options.result);
    }

    if (options.anonymizedUserId) {
      conditions.push('anonymized_user_id = ?');
      params.push(options.anonymizedUserId);
    }

    if (options.clientId) {
      conditions.push('client_id = ?');
      params.push(options.clientId);
    }

    if (options.requestId) {
      conditions.push('request_id = ?');
      params.push(options.requestId);
    }

    const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const sql = `
      SELECT id, tenant_id, event_type, event_category, result, severity,
             error_code, error_message, anonymized_user_id, client_id,
             session_id, request_id, duration_ms, details_r2_key, details_json,
             retention_until, created_at
      FROM event_log
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ${sortOrder}
    `;

    return { sql, params };
  }

  private buildPIILogQuery(options: AuditQueryOptions): {
    sql: string;
    params: unknown[];
  } {
    const conditions: string[] = ['tenant_id = ?'];
    const params: unknown[] = [options.tenantId];

    if (options.startTime !== undefined) {
      conditions.push('created_at >= ?');
      params.push(options.startTime);
    }

    if (options.endTime !== undefined) {
      conditions.push('created_at < ?');
      params.push(options.endTime);
    }

    if (options.userId) {
      conditions.push('user_id = ?');
      params.push(options.userId);
    }

    if (options.anonymizedUserId) {
      conditions.push('anonymized_user_id = ?');
      params.push(options.anonymizedUserId);
    }

    if (options.changeType) {
      conditions.push('change_type = ?');
      params.push(options.changeType);
    }

    if (options.requestId) {
      conditions.push('request_id = ?');
      params.push(options.requestId);
    }

    const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const sql = `
      SELECT id, tenant_id, user_id, anonymized_user_id, change_type, affected_fields,
             values_r2_key, values_encrypted, encryption_key_id, encryption_iv,
             actor_user_id, actor_type, request_id, legal_basis, consent_reference,
             retention_until, created_at
      FROM pii_log
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ${sortOrder}
    `;

    return { sql, params };
  }

  private mapEventLogRow(row: {
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
  }): EventLogEntry {
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

  private mapPIILogRow(row: {
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
  }): PIILogEntry {
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
  // Count Operation
  // ---------------------------------------------------------------------------

  async count(options: Omit<AuditQueryOptions, 'limit' | 'offset'>): Promise<number> {
    try {
      if (options.logType === 'event') {
        const { sql, params } = this.buildEventLogQuery(options as AuditQueryOptions);
        const countSql = sql.replace(/^[\s\S]*?FROM/, 'SELECT COUNT(*) as count FROM');
        const result = await this.db
          .prepare(countSql)
          .bind(...params)
          .first<{ count: number }>();
        return result?.count ?? 0;
      } else {
        const { sql, params } = this.buildPIILogQuery(options as AuditQueryOptions);
        const countSql = sql.replace(/^[\s\S]*?FROM/, 'SELECT COUNT(*) as count FROM');
        const result = await this.db
          .prepare(countSql)
          .bind(...params)
          .first<{ count: number }>();
        return result?.count ?? 0;
      }
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Maintenance Operations
  // ---------------------------------------------------------------------------

  async deleteByRetention(
    logType: AuditLogType,
    beforeTime: number,
    tenantId?: string,
    batchSize: number = 1000
  ): Promise<number> {
    const table = logType === 'event' ? 'event_log' : 'pii_log';

    const sql = tenantId
      ? `DELETE FROM ${table} WHERE retention_until < ? AND tenant_id = ? LIMIT ?`
      : `DELETE FROM ${table} WHERE retention_until < ? LIMIT ?`;

    const params = tenantId ? [beforeTime, tenantId, batchSize] : [beforeTime, batchSize];

    try {
      const result = await this.db
        .prepare(sql)
        .bind(...params)
        .run();
      return result.meta?.changes ?? 0;
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
      // Simple query to check connectivity
      await this.db.prepare('SELECT 1').first();

      return {
        healthy: true,
        backend: this.id,
        backendType: 'D1',
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        healthy: false,
        backend: this.id,
        backendType: 'D1',
        latencyMs: Date.now() - startTime,
        errorMessage: String(error),
      };
    }
  }

  async close(): Promise<void> {
    // D1 doesn't require explicit connection closing
  }
}

/**
 * Create a D1 audit adapter for the core database (event logs).
 */
export function createD1EventLogAdapter(db: D1Database, id?: string): D1AuditAdapter {
  return new D1AuditAdapter({
    id: id ?? 'd1-core',
    db,
    isPiiDb: false,
  });
}

/**
 * Create a D1 audit adapter for the PII database.
 */
export function createD1PIILogAdapter(db: D1Database, id?: string): D1AuditAdapter {
  return new D1AuditAdapter({
    id: id ?? 'd1-pii',
    db,
    isPiiDb: true,
  });
}
