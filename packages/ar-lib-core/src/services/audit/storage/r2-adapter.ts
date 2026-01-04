/**
 * R2 Audit Storage Adapter
 *
 * Storage adapter for Cloudflare R2 (object storage).
 * Used for archive and long-term storage with cost efficiency.
 *
 * Features:
 * - JSONL format for efficient append and streaming
 * - Date-based partitioning for easy retention management
 * - Read-only queries (best for historical data)
 */

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
 * R2 adapter configuration.
 */
export interface R2AuditAdapterConfig {
  /** Unique identifier for this adapter */
  id: string;

  /** R2 bucket binding */
  bucket: R2Bucket;

  /** Path prefix for log files */
  pathPrefix: string;

  /** File format */
  format: 'json' | 'jsonl';
}

/**
 * R2 audit storage adapter implementation.
 *
 * Path format:
 * - Event logs: {pathPrefix}/event/{tenantId}/{YYYY-MM-DD}/{hour}.jsonl
 * - PII logs: {pathPrefix}/pii/{tenantId}/{YYYY-MM-DD}/{hour}.jsonl
 * - Single entries: {pathPrefix}/event/{tenantId}/{YYYY-MM-DD}/{entryId}.json
 */
export class R2AuditAdapter implements IAuditStorageAdapter {
  private readonly id: string;
  private readonly bucket: R2Bucket;
  private readonly pathPrefix: string;
  private readonly format: 'json' | 'jsonl';

  constructor(config: R2AuditAdapterConfig) {
    this.id = config.id;
    this.bucket = config.bucket;
    this.pathPrefix = config.pathPrefix.replace(/\/$/, ''); // Remove trailing slash
    this.format = config.format;
  }

  getBackendType(): AuditStorageBackendType {
    return 'R2';
  }

  getIdentifier(): string {
    return this.id;
  }

  // ---------------------------------------------------------------------------
  // Write Operations
  // ---------------------------------------------------------------------------

  async writeEventLog(entry: EventLogEntry): Promise<AuditWriteResult> {
    const startTime = Date.now();

    try {
      const key = this.buildEntryKey('event', entry.tenantId, entry.id, entry.createdAt);
      const body = JSON.stringify(entry);

      await this.bucket.put(key, body, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: {
          tenantId: entry.tenantId,
          eventType: entry.eventType,
          createdAt: String(entry.createdAt),
        },
      });

      return {
        success: true,
        entriesWritten: 1,
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

    if (this.format === 'jsonl') {
      return this.writeEventLogBatchJsonl(entries, startTime);
    }

    // JSON format: write each entry individually
    let written = 0;
    const errors: string[] = [];

    for (const entry of entries) {
      const result = await this.writeEventLog(entry);
      if (result.success) {
        written++;
      } else if (result.errorMessage) {
        errors.push(result.errorMessage);
      }
    }

    return {
      success: errors.length === 0,
      entriesWritten: written,
      backend: this.id,
      durationMs: Date.now() - startTime,
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
    };
  }

  private async writeEventLogBatchJsonl(
    entries: EventLogEntry[],
    startTime: number
  ): Promise<AuditWriteResult> {
    // Group entries by tenant and hour
    const grouped = this.groupEntriesByHour(entries, (e) => ({
      tenantId: e.tenantId,
      createdAt: e.createdAt,
    }));

    let written = 0;
    const errors: string[] = [];

    for (const [key, groupEntries] of grouped) {
      try {
        const [tenantId, dateHour] = key.split('|');
        const r2Key = `${this.pathPrefix}/event/${tenantId}/${dateHour}.jsonl`;

        // Append to existing file or create new
        const existing = await this.bucket.get(r2Key);
        const existingContent = existing ? await existing.text() : '';
        const newLines = groupEntries.map((e) => JSON.stringify(e)).join('\n');
        const content = existingContent ? `${existingContent}\n${newLines}` : newLines;

        await this.bucket.put(r2Key, content, {
          httpMetadata: { contentType: 'application/x-ndjson' },
          customMetadata: {
            tenantId,
            entryCount: String(content.split('\n').length),
            lastModified: new Date().toISOString(),
          },
        });

        written += groupEntries.length;
      } catch (error) {
        errors.push(String(error));
      }
    }

    return {
      success: errors.length === 0,
      entriesWritten: written,
      backend: this.id,
      durationMs: Date.now() - startTime,
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
    };
  }

  async writePIILog(entry: PIILogEntry): Promise<AuditWriteResult> {
    const startTime = Date.now();

    try {
      const key = this.buildEntryKey('pii', entry.tenantId, entry.id, entry.createdAt);
      const body = JSON.stringify(entry);

      await this.bucket.put(key, body, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: {
          tenantId: entry.tenantId,
          userId: entry.userId,
          changeType: entry.changeType,
          createdAt: String(entry.createdAt),
        },
      });

      return {
        success: true,
        entriesWritten: 1,
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

    if (this.format === 'jsonl') {
      return this.writePIILogBatchJsonl(entries, startTime);
    }

    // JSON format: write each entry individually
    let written = 0;
    const errors: string[] = [];

    for (const entry of entries) {
      const result = await this.writePIILog(entry);
      if (result.success) {
        written++;
      } else if (result.errorMessage) {
        errors.push(result.errorMessage);
      }
    }

    return {
      success: errors.length === 0,
      entriesWritten: written,
      backend: this.id,
      durationMs: Date.now() - startTime,
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
    };
  }

  private async writePIILogBatchJsonl(
    entries: PIILogEntry[],
    startTime: number
  ): Promise<AuditWriteResult> {
    const grouped = this.groupEntriesByHour(entries, (e) => ({
      tenantId: e.tenantId,
      createdAt: e.createdAt,
    }));

    let written = 0;
    const errors: string[] = [];

    for (const [key, groupEntries] of grouped) {
      try {
        const [tenantId, dateHour] = key.split('|');
        const r2Key = `${this.pathPrefix}/pii/${tenantId}/${dateHour}.jsonl`;

        const existing = await this.bucket.get(r2Key);
        const existingContent = existing ? await existing.text() : '';
        const newLines = groupEntries.map((e) => JSON.stringify(e)).join('\n');
        const content = existingContent ? `${existingContent}\n${newLines}` : newLines;

        await this.bucket.put(r2Key, content, {
          httpMetadata: { contentType: 'application/x-ndjson' },
          customMetadata: {
            tenantId,
            entryCount: String(content.split('\n').length),
            lastModified: new Date().toISOString(),
          },
        });

        written += groupEntries.length;
      } catch (error) {
        errors.push(String(error));
      }
    }

    return {
      success: errors.length === 0,
      entriesWritten: written,
      backend: this.id,
      durationMs: Date.now() - startTime,
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Query Operations
  // ---------------------------------------------------------------------------

  async query(options: AuditQueryOptions): Promise<AuditQueryResult> {
    const startTime = Date.now();

    // R2 queries are limited - we need to list and filter
    // This is primarily for archive retrieval, not real-time queries
    const logType = options.logType;
    const prefix = `${this.pathPrefix}/${logType}/${options.tenantId}/`;

    try {
      // List objects in the date range
      const listed = await this.bucket.list({
        prefix,
        limit: 1000, // Limit for performance
      });

      const entries: (EventLogEntry | PIILogEntry)[] = [];
      const limit = options.limit ?? 100;
      const offset = options.offset ?? 0;

      // Filter by date if provided
      const filteredObjects = this.filterObjectsByDate(
        listed.objects,
        options.startTime,
        options.endTime
      );

      // Read and parse entries
      for (const obj of filteredObjects) {
        if (entries.length >= limit + offset) break;

        const content = await this.bucket.get(obj.key);
        if (!content) continue;

        const text = await content.text();

        if (obj.key.endsWith('.jsonl')) {
          // Parse JSONL
          const lines = text.split('\n').filter((l) => l.trim());
          for (const line of lines) {
            if (entries.length >= limit + offset) break;
            try {
              const entry = JSON.parse(line);
              if (this.matchesQueryOptions(entry, options)) {
                entries.push(entry);
              }
            } catch {
              // Skip malformed lines
            }
          }
        } else {
          // Parse JSON
          try {
            const entry = JSON.parse(text);
            if (this.matchesQueryOptions(entry, options)) {
              entries.push(entry);
            }
          } catch {
            // Skip malformed files
          }
        }
      }

      // Apply pagination
      const paginatedEntries = entries.slice(offset, offset + limit);

      if (logType === 'event') {
        return {
          eventEntries: paginatedEntries as EventLogEntry[],
          totalCount: entries.length,
          hasMore: entries.length > offset + limit,
          durationMs: Date.now() - startTime,
          backend: this.id,
        };
      } else {
        return {
          piiEntries: paginatedEntries as PIILogEntry[],
          totalCount: entries.length,
          hasMore: entries.length > offset + limit,
          durationMs: Date.now() - startTime,
          backend: this.id,
        };
      }
    } catch (error) {
      return {
        eventEntries: logType === 'event' ? [] : undefined,
        piiEntries: logType === 'pii' ? [] : undefined,
        totalCount: 0,
        hasMore: false,
        durationMs: Date.now() - startTime,
        backend: this.id,
      };
    }
  }

  async count(options: Omit<AuditQueryOptions, 'limit' | 'offset'>): Promise<number> {
    // For R2, we need to scan files to count
    // This is expensive, so we return an estimate from metadata if available
    const result = await this.query({ ...options, limit: 10000 } as AuditQueryOptions);
    return result.totalCount;
  }

  // ---------------------------------------------------------------------------
  // Maintenance Operations
  // ---------------------------------------------------------------------------

  async deleteByRetention(
    logType: AuditLogType,
    beforeTime: number,
    tenantId?: string,
    batchSize: number = 100
  ): Promise<number> {
    const prefix = tenantId
      ? `${this.pathPrefix}/${logType}/${tenantId}/`
      : `${this.pathPrefix}/${logType}/`;

    try {
      const listed = await this.bucket.list({ prefix, limit: batchSize });
      let deleted = 0;

      for (const obj of listed.objects) {
        // Check if object is older than retention
        // We can use the date from the path: {prefix}/{tenantId}/{YYYY-MM-DD}/...
        const dateMatch = obj.key.match(/\/(\d{4}-\d{2}-\d{2})\//);
        if (dateMatch) {
          const objDate = new Date(dateMatch[1]).getTime();
          if (objDate < beforeTime) {
            await this.bucket.delete(obj.key);
            deleted++;
          }
        }
      }

      return deleted;
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
      // List a small number of objects to check connectivity
      await this.bucket.list({ prefix: this.pathPrefix, limit: 1 });

      return {
        healthy: true,
        backend: this.id,
        backendType: 'R2',
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        healthy: false,
        backend: this.id,
        backendType: 'R2',
        latencyMs: Date.now() - startTime,
        errorMessage: String(error),
      };
    }
  }

  async close(): Promise<void> {
    // R2 doesn't require explicit connection closing
  }

  // ---------------------------------------------------------------------------
  // Helper Methods
  // ---------------------------------------------------------------------------

  private buildEntryKey(
    logType: string,
    tenantId: string,
    entryId: string,
    createdAt: number
  ): string {
    const date = new Date(createdAt);
    const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
    return `${this.pathPrefix}/${logType}/${tenantId}/${dateStr}/${entryId}.json`;
  }

  private groupEntriesByHour<T>(
    entries: T[],
    getInfo: (entry: T) => { tenantId: string; createdAt: number }
  ): Map<string, T[]> {
    const grouped = new Map<string, T[]>();

    for (const entry of entries) {
      const { tenantId, createdAt } = getInfo(entry);
      const date = new Date(createdAt);
      const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
      const hour = date.getUTCHours().toString().padStart(2, '0');
      const key = `${tenantId}|${dateStr}/${hour}`;

      const existing = grouped.get(key) ?? [];
      existing.push(entry);
      grouped.set(key, existing);
    }

    return grouped;
  }

  private filterObjectsByDate(
    objects: R2Object[],
    startTime?: number,
    endTime?: number
  ): R2Object[] {
    if (!startTime && !endTime) return objects;

    return objects.filter((obj) => {
      const dateMatch = obj.key.match(/\/(\d{4}-\d{2}-\d{2})\//);
      if (!dateMatch) return true; // Include if no date in path

      const objDate = new Date(dateMatch[1]).getTime();
      if (startTime && objDate < startTime - 86400000) return false; // Day buffer
      if (endTime && objDate > endTime + 86400000) return false;
      return true;
    });
  }

  private matchesQueryOptions(
    entry: EventLogEntry | PIILogEntry,
    options: AuditQueryOptions
  ): boolean {
    // Time range filter
    if (options.startTime && entry.createdAt < options.startTime) return false;
    if (options.endTime && entry.createdAt >= options.endTime) return false;

    // Common filters
    if (options.anonymizedUserId && 'anonymizedUserId' in entry) {
      if (entry.anonymizedUserId !== options.anonymizedUserId) return false;
    }

    if (options.requestId && 'requestId' in entry) {
      if (entry.requestId !== options.requestId) return false;
    }

    // Event log filters
    if (options.logType === 'event' && 'eventType' in entry) {
      const eventEntry = entry as EventLogEntry;
      if (options.eventType && eventEntry.eventType !== options.eventType) return false;
      if (options.eventCategory && eventEntry.eventCategory !== options.eventCategory) return false;
      if (options.result && eventEntry.result !== options.result) return false;
      if (options.clientId && eventEntry.clientId !== options.clientId) return false;
    }

    // PII log filters
    if (options.logType === 'pii' && 'userId' in entry) {
      const piiEntry = entry as PIILogEntry;
      if (options.userId && piiEntry.userId !== options.userId) return false;
      if (options.changeType && piiEntry.changeType !== options.changeType) return false;
    }

    return true;
  }
}

/**
 * Create an R2 audit adapter.
 */
export function createR2AuditAdapter(
  bucket: R2Bucket,
  options?: {
    id?: string;
    pathPrefix?: string;
    format?: 'json' | 'jsonl';
  }
): R2AuditAdapter {
  return new R2AuditAdapter({
    id: options?.id ?? 'r2-archive',
    bucket,
    pathPrefix: options?.pathPrefix ?? 'audit-logs',
    format: options?.format ?? 'jsonl',
  });
}
