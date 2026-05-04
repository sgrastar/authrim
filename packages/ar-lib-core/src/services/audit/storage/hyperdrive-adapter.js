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
function sanitizeIdentifier(identifier) {
    if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
        throw new Error(`invalid_sql_identifier:${identifier}`);
    }
    return identifier;
}
function buildInsertIfNotExistsSql(tableName, columns, keyColumn, rowCount) {
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
export class HyperdriveAuditAdapter {
    id;
    hyperdrive;
    schema;
    isPiiDb;
    clientFactory;
    client = null;
    constructor(config) {
        this.id = config.id;
        this.hyperdrive = config.hyperdrive;
        this.schema = sanitizeIdentifier(config.schema);
        this.isPiiDb = config.isPiiDb;
        this.clientFactory = config.clientFactory;
    }
    getBackendType() {
        return 'HYPERDRIVE';
    }
    getIdentifier() {
        return this.id;
    }
    /**
     * Get or create a PostgreSQL client.
     * Note: In production, use a proper PostgreSQL client library like 'pg'.
     * This is a simplified implementation for demonstration.
     */
    async getClient() {
        if (this.client)
            return this.client;
        const connectionString = this.hyperdrive.connectionString;
        if (this.clientFactory) {
            this.client = await this.clientFactory(connectionString);
            return this.client;
        }
        const { Client } = await import('pg');
        const rawClient = new Client({
            connectionString,
            application_name: 'authrim-audit',
        });
        await rawClient.connect();
        this.client = {
            query: async (sql, params) => {
                const result = await rawClient.query(sql, params);
                return {
                    rows: result.rows,
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
    async writeEventLog(entry) {
        return this.writeEventLogBatch([entry]);
    }
    async writeEventLogBatch(entries) {
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
            const values = [];
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
            ];
            entries.forEach((e) => {
                values.push(e.id, e.tenantId, e.eventType, e.eventCategory, e.result, e.severity, e.errorCode ?? null, e.errorMessage ?? null, e.anonymizedUserId ?? null, e.clientId ?? null, e.sessionId ?? null, e.requestId ?? null, e.durationMs ?? null, e.detailsR2Key ?? null, e.detailsJson ?? null, e.retentionUntil ?? null, e.createdAt);
            });
            const sql = buildInsertIfNotExistsSql(`${this.schema}.event_log`, [...columns], 'id', entries.length);
            await client.query(sql, values);
            return {
                success: true,
                entriesWritten: entries.length,
                backend: this.id,
                durationMs: Date.now() - startTime,
            };
        }
        catch (error) {
            return {
                success: false,
                entriesWritten: 0,
                backend: this.id,
                durationMs: Date.now() - startTime,
                errorMessage: String(error),
            };
        }
    }
    async writePIILog(entry) {
        return this.writePIILogBatch([entry]);
    }
    async writePIILogBatch(entries) {
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
            const values = [];
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
            ];
            entries.forEach((e) => {
                values.push(e.id, e.tenantId, e.userId, e.anonymizedUserId, e.changeType, e.affectedFields, e.valuesR2Key ?? null, e.valuesEncrypted ?? null, e.encryptionKeyId, e.encryptionIv, e.actorUserId ?? null, e.actorType, e.requestId ?? null, e.legalBasis ?? null, e.consentReference ?? null, e.retentionUntil, e.createdAt);
            });
            const sql = buildInsertIfNotExistsSql(`${this.schema}.pii_log`, [...columns], 'id', entries.length);
            await client.query(sql, values);
            return {
                success: true,
                entriesWritten: entries.length,
                backend: this.id,
                durationMs: Date.now() - startTime,
            };
        }
        catch (error) {
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
    async query(options) {
        const startTime = Date.now();
        try {
            const client = await this.getClient();
            if (options.logType === 'event') {
                return this.queryEventLog(client, options, startTime);
            }
            else {
                return this.queryPIILog(client, options, startTime);
            }
        }
        catch (error) {
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
    async queryEventLog(client, options, startTime) {
        const { sql, params } = this.buildEventLogQuery(options);
        const limit = options.limit ?? 100;
        const offset = options.offset ?? 0;
        // Query with limit + 1 to check hasMore
        const result = await client.query(`${sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit + 1, offset]);
        const rows = result.rows;
        const hasMore = rows.length > limit;
        const entries = (hasMore ? rows.slice(0, limit) : rows).map((row) => this.mapEventLogRow(row));
        // Get total count
        let totalCount = entries.length + offset;
        if (hasMore || offset > 0) {
            const countSql = `SELECT COUNT(*) as count FROM ${this.schema}.event_log WHERE ${this.buildWhereClause(options, params).join(' AND ')}`;
            const countResult = await client.query(countSql, params);
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
    async queryPIILog(client, options, startTime) {
        const { sql, params } = this.buildPIILogQuery(options);
        const limit = options.limit ?? 100;
        const offset = options.offset ?? 0;
        const result = await client.query(`${sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit + 1, offset]);
        const rows = result.rows;
        const hasMore = rows.length > limit;
        const entries = (hasMore ? rows.slice(0, limit) : rows).map((row) => this.mapPIILogRow(row));
        let totalCount = entries.length + offset;
        if (hasMore || offset > 0) {
            const countSql = `SELECT COUNT(*) as count FROM ${this.schema}.pii_log WHERE ${this.buildWhereClause(options, params).join(' AND ')}`;
            const countResult = await client.query(countSql, params);
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
    buildEventLogQuery(options) {
        const params = [];
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
    buildPIILogQuery(options) {
        const params = [];
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
    buildWhereClause(options, params) {
        const conditions = [];
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
    async count(options) {
        try {
            const client = await this.getClient();
            const params = [];
            const conditions = this.buildWhereClause(options, params);
            const table = options.logType === 'event' ? 'event_log' : 'pii_log';
            const result = await client.query(`SELECT COUNT(*) as count FROM ${this.schema}.${table} WHERE ${conditions.join(' AND ')}`, params);
            return parseInt(result.rows[0]?.count ?? '0', 10);
        }
        catch {
            return 0;
        }
    }
    // ---------------------------------------------------------------------------
    // Row Mappers
    // ---------------------------------------------------------------------------
    mapEventLogRow(row) {
        return {
            id: row.id,
            tenantId: row.tenant_id,
            eventType: row.event_type,
            eventCategory: row.event_category,
            result: row.result,
            severity: row.severity,
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
    mapPIILogRow(row) {
        return {
            id: row.id,
            tenantId: row.tenant_id,
            userId: row.user_id,
            anonymizedUserId: row.anonymized_user_id,
            changeType: row.change_type,
            affectedFields: row.affected_fields,
            valuesR2Key: row.values_r2_key ?? undefined,
            valuesEncrypted: row.values_encrypted ?? undefined,
            encryptionKeyId: row.encryption_key_id,
            encryptionIv: row.encryption_iv,
            actorUserId: row.actor_user_id ?? undefined,
            actorType: row.actor_type,
            requestId: row.request_id ?? undefined,
            legalBasis: row.legal_basis,
            consentReference: row.consent_reference ?? undefined,
            retentionUntil: row.retention_until,
            createdAt: row.created_at,
        };
    }
    async listRetentionCandidates(logType, beforeTime, tenantId, batchSize = 1000) {
        try {
            const client = await this.getClient();
            const table = logType === 'event' ? 'event_log' : 'pii_log';
            const selectColumns = logType === 'event'
                ? `id, tenant_id, event_type, event_category, result, severity,
             error_code, error_message, anonymized_user_id, client_id,
             session_id, request_id, duration_ms, details_r2_key, details_json,
             retention_until, created_at`
                : `id, tenant_id, user_id, anonymized_user_id, change_type, affected_fields,
             values_r2_key, values_encrypted, encryption_key_id, encryption_iv,
             actor_user_id, actor_type, request_id, legal_basis, consent_reference,
             retention_until, created_at`;
            let sql;
            let params;
            if (tenantId) {
                sql = `
          SELECT ${selectColumns}
          FROM ${this.schema}.${table}
          WHERE retention_until < $1 AND tenant_id = $2
          ORDER BY retention_until ASC, created_at ASC, id ASC
          LIMIT $3
        `;
                params = [beforeTime, tenantId, batchSize];
            }
            else {
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
                const result = await client.query(sql, params);
                return result.rows.map((row) => this.mapEventLogRow(row));
            }
            const result = await client.query(sql, params);
            return result.rows.map((row) => this.mapPIILogRow(row));
        }
        catch {
            return [];
        }
    }
    async deleteByRetention(logType, beforeTime, tenantId, batchSize = 1000) {
        try {
            const client = await this.getClient();
            const table = logType === 'event' ? 'event_log' : 'pii_log';
            let sql;
            let params;
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
            }
            else {
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
        }
        catch {
            return 0;
        }
    }
    // ---------------------------------------------------------------------------
    // Health Check
    // ---------------------------------------------------------------------------
    async isHealthy() {
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
        }
        catch (error) {
            return {
                healthy: false,
                backend: this.id,
                backendType: 'HYPERDRIVE',
                latencyMs: Date.now() - startTime,
                errorMessage: String(error),
            };
        }
    }
    async close() {
        if (this.client) {
            await this.client.end();
            this.client = null;
        }
    }
}
/**
 * Create a Hyperdrive audit adapter.
 */
export function createHyperdriveAuditAdapter(hyperdrive, options) {
    return new HyperdriveAuditAdapter({
        id: options?.id ?? 'hyperdrive-audit',
        hyperdrive,
        schema: options?.schema ?? 'audit',
        isPiiDb: options?.isPiiDb ?? false,
        clientFactory: options?.clientFactory,
    });
}
