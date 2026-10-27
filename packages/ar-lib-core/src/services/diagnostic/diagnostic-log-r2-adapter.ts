/** Diagnostic storage follows the selected archive mode; no JSONL objects are written. */
import type { Env } from '../../types/env';
import { logIcebergCanonicalJson } from '../log-iceberg-record';
import { emitLogIcebergRow } from '../log-iceberg-emitter';
import { readLogIcebergDataset } from '../log-iceberg-read';
import type {
  DiagnosticLogEntry,
  DiagnosticLogWriteResult,
  DiagnosticLogQueryOptions,
  DiagnosticLogQueryResult,
} from './types';

export const DIAGNOSTIC_LOG_DATASET = 'diagnostic.diagnostic_log';
export interface DiagnosticLogR2AdapterConfig {
  env: Env;
  tenantId: string;
  clientId?: string;
  retentionDays?: number;
}

export class DiagnosticLogR2Adapter {
  private readonly env: Env;
  private readonly tenantId: string;
  private readonly clientId?: string;
  private readonly retentionDays: number;

  constructor(config: DiagnosticLogR2AdapterConfig) {
    this.env = config.env;
    this.tenantId = config.tenantId;
    this.clientId = config.clientId;
    this.retentionDays = config.retentionDays ?? 30;
    if (
      !Number.isSafeInteger(this.retentionDays) ||
      this.retentionDays < 1 ||
      this.retentionDays > 3650
    )
      throw new Error('diagnostic_retention_invalid');
  }

  async writeLog(entry: DiagnosticLogEntry): Promise<DiagnosticLogWriteResult> {
    return this.writeLogBatch([entry]);
  }

  async writeLogBatch(entries: DiagnosticLogEntry[]): Promise<DiagnosticLogWriteResult> {
    const started = Date.now();
    let written = 0;
    try {
      for (const input of entries) {
        const entry = structuredClone(input);
        if (
          entry.tenantId !== this.tenantId ||
          (this.clientId && entry.clientId !== this.clientId) ||
          !entry.id ||
          !Number.isSafeInteger(entry.timestamp) ||
          entry.timestamp < 0
        )
          throw new Error('diagnostic_log_scope_invalid');
        await emitLogIcebergRow(this.env, {
          tenantId: this.tenantId,
          sourceDataset: DIAGNOSTIC_LOG_DATASET,
          logType: 'diagnostic',
          eventAt: entry.timestamp,
          expiresAt: entry.timestamp + this.retentionDays * 86_400_000,
          row: {
            id: entry.id,
            tenant_id: this.tenantId,
            client_id: entry.clientId ?? null,
            category: entry.category,
            level: entry.level,
            created_at: entry.timestamp,
            diagnostic_session_id: entry.diagnosticSessionId ?? null,
            request_id: entry.requestId ?? null,
            flow_id: entry.flowId ?? null,
            source: entry.source ?? null,
            storage_mode: entry.storageMode ?? null,
            entry_json: logIcebergCanonicalJson(JSON.parse(JSON.stringify(entry))),
          },
          overview: {
            action: entry.category,
            severity: entry.level,
            request_id: entry.requestId ?? null,
            client_id: entry.clientId ?? null,
          },
        });
        written++;
      }
      return {
        success: true,
        entriesWritten: written,
        backend: 'iceberg-diagnostic',
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        entriesWritten: written,
        backend: 'iceberg-diagnostic',
        durationMs: Date.now() - started,
        errorMessage: error instanceof Error ? error.message : 'diagnostic_log_write_failed',
      };
    }
  }

  async query(options: DiagnosticLogQueryOptions): Promise<DiagnosticLogQueryResult> {
    if (options.tenantId !== this.tenantId || (this.clientId && options.clientId !== this.clientId))
      throw new Error('diagnostic_log_scope_invalid');
    const started = Date.now();
    const result = await readLogIcebergDataset(this.env, {
      tenantId: this.tenantId,
      sourceDataset: DIAGNOSTIC_LOG_DATASET,
      fromMs: options.startTime,
      toMs: options.endTime,
    });
    const entries = result.rows
      .map((row) => {
        if (typeof row.entry_json !== 'string')
          throw new Error('diagnostic_archive_record_invalid');
        const entry = JSON.parse(row.entry_json) as DiagnosticLogEntry;
        if (
          entry.id !== row.id ||
          entry.tenantId !== this.tenantId ||
          !Number.isSafeInteger(entry.timestamp)
        )
          throw new Error('diagnostic_archive_record_invalid');
        return entry;
      })
      .filter((entry) => this.matchesQueryOptions(entry, options))
      .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
    const offset = options.offset ?? 0,
      limit = options.limit ?? 100;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10000
    )
      throw new Error('diagnostic_pagination_invalid');
    return {
      entries: entries.slice(offset, offset + limit),
      totalCount: entries.length,
      hasMore: entries.length > offset + limit,
      durationMs: Date.now() - started,
      backend: 'iceberg-diagnostic',
      consistency: result.consistency,
    };
  }

  /** Shared Iceberg maintenance applies each immutable record's expires_at. */
  async deleteByRetention(_beforeTime: number, _batchSize = 100): Promise<number> {
    throw new Error('diagnostic_retention_managed_by_iceberg');
  }
  async deleteByRetentionPage(
    _beforeTime: number,
    _batchSize = 100,
    _cursor?: string
  ): Promise<{ deleted: number; scanned: number; cursor?: string }> {
    throw new Error('diagnostic_retention_managed_by_iceberg');
  }

  async isHealthy(): Promise<{ healthy: boolean; latencyMs: number; errorMessage?: string }> {
    const started = Date.now();
    try {
      await readLogIcebergDataset(this.env, {
        tenantId: this.tenantId,
        sourceDataset: DIAGNOSTIC_LOG_DATASET,
        fromMs: started,
        toMs: started + 1,
      });
      return { healthy: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - started,
        errorMessage: error instanceof Error ? error.message : 'diagnostic_storage_unavailable',
      };
    }
  }

  private matchesQueryOptions(
    entry: DiagnosticLogEntry,
    options: DiagnosticLogQueryOptions
  ): boolean {
    return (
      entry.tenantId === options.tenantId &&
      (!options.clientId || entry.clientId === options.clientId) &&
      (options.startTime === undefined || entry.timestamp >= options.startTime) &&
      (options.endTime === undefined || entry.timestamp < options.endTime) &&
      (!options.diagnosticSessionId || entry.diagnosticSessionId === options.diagnosticSessionId) &&
      (!options.requestId || entry.requestId === options.requestId) &&
      (!options.category || entry.category === options.category)
    );
  }
}

export function createDiagnosticLogR2Adapter(
  env: Env,
  options: { tenantId: string; clientId?: string; retentionDays?: number }
): DiagnosticLogR2Adapter {
  return new DiagnosticLogR2Adapter({ env, ...options });
}
