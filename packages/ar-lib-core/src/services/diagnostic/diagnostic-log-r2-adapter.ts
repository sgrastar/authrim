/**
 * Diagnostic Log R2 Storage Adapter
 *
 * Storage adapter for diagnostic logs to Cloudflare R2.
 * Supports immutable JSONL chunks with date-based partitioning.
 *
 * Path structure:
 * - {prefix}/v1/{tenantKey}/diagnostic_detail/diagnostic/{category}/_tenant/{yyyy}/{mm}/{dd}/{hh}/{chunkId}.jsonl
 * - {prefix}/v1/{tenantKey}/diagnostic_detail/diagnostic/{category}/{clientId}/{yyyy}/{mm}/{dd}/{hh}/{chunkId}.jsonl
 */

import {
  createLoggingId,
  deriveTenantKeyFromTenantId,
  formatUtcPartition,
} from '@authrim/ar-lib-logging';
import type {
  DiagnosticLogEntry,
  DiagnosticLogWriteResult,
  DiagnosticLogQueryOptions,
  DiagnosticLogQueryResult,
  DiagnosticLogCategory,
} from './types';
import { readR2ObjectTextWithLimit } from '../../utils/body-limits';

const DIAGNOSTIC_R2_OBJECT_MAX_BYTES = 16 * 1024 * 1024;
const DIAGNOSTIC_CHUNK_WINDOW_MS = 5 * 60 * 1000;
const TENANT_SCOPE_SEGMENT = '_tenant';

/**
 * R2 adapter configuration
 */
export interface DiagnosticLogR2AdapterConfig {
  /** R2 bucket binding */
  bucket: R2Bucket;

  /** Path prefix (e.g., "diagnostic-logs") */
  pathPrefix: string;

  /** Tenant ID */
  tenantId: string;

  /** Opaque tenant key for R2 paths */
  tenantKey?: string;

  /** Salt used when deriving tenant keys from tenant IDs */
  tenantKeySalt?: string;

  /** Client ID (optional, for future client-scoped logging) */
  clientId?: string;
}

function cleanDiagnosticSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._=-]/g, '_').slice(0, 128) || '_';
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(start, end);
}

function normalizeDiagnosticPrefix(prefix?: string): string {
  const raw = trimSlashes(prefix ?? 'diagnostic-logs');
  const cleaned = raw
    .split('/')
    .map((segment) => cleanDiagnosticSegment(segment))
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('/');
  return cleaned || 'diagnostic-logs';
}

async function resolveDiagnosticTenantKey(options: {
  tenantId: string;
  tenantKey?: string;
  tenantKeySalt?: string;
}): Promise<string> {
  return (
    options.tenantKey ?? (await deriveTenantKeyFromTenantId(options.tenantId, options.tenantKeySalt))
  );
}

function floorToDiagnosticChunkWindow(timestamp: number): number {
  return Math.floor(timestamp / DIAGNOSTIC_CHUNK_WINDOW_MS) * DIAGNOSTIC_CHUNK_WINDOW_MS;
}

/**
 * Build R2 object key for diagnostic logs
 *
 * Tenant path by default; include clientId when available. The key uses an
 * opaque tenant key so raw tenant IDs are not embedded in R2 object names.
 *
 * @param options - Path construction options
 * @returns R2 object key
 */
export async function buildDiagnosticLogPath(options: {
  pathPrefix: string;
  tenantId: string;
  tenantKey?: string;
  tenantKeySalt?: string;
  clientId?: string;
  category: DiagnosticLogCategory;
  timestamp: number;
  chunkId?: string;
}): Promise<string> {
  const tenantKey = await resolveDiagnosticTenantKey(options);
  const partition = formatUtcPartition(options.timestamp);
  const chunkId = options.chunkId ?? createLoggingId('chk', options.timestamp);
  return [
    normalizeDiagnosticPrefix(options.pathPrefix),
    'v1',
    cleanDiagnosticSegment(tenantKey),
    'diagnostic_detail',
    'diagnostic',
    cleanDiagnosticSegment(options.category),
    options.clientId ? cleanDiagnosticSegment(options.clientId) : TENANT_SCOPE_SEGMENT,
    partition.year,
    partition.month,
    partition.day,
    partition.hour,
    `${cleanDiagnosticSegment(chunkId)}.jsonl`,
  ].join('/');
}

export async function buildDiagnosticLogPrefix(options: {
  pathPrefix: string;
  tenantId: string;
  tenantKey?: string;
  tenantKeySalt?: string;
  category?: DiagnosticLogCategory;
  clientId?: string;
}): Promise<string> {
  const tenantKey = await resolveDiagnosticTenantKey(options);
  const segments = [
    normalizeDiagnosticPrefix(options.pathPrefix),
    'v1',
    cleanDiagnosticSegment(tenantKey),
    'diagnostic_detail',
    'diagnostic',
  ];
  if (options.category) {
    segments.push(cleanDiagnosticSegment(options.category));
  }
  if (options.clientId) {
    segments.push(cleanDiagnosticSegment(options.clientId));
  }
  return segments.join('/');
}

/**
 * Diagnostic Log R2 Adapter
 */
export class DiagnosticLogR2Adapter {
  private readonly bucket: R2Bucket;
  private readonly pathPrefix: string;
  private readonly tenantId: string;
  private readonly tenantKey?: string;
  private readonly tenantKeySalt?: string;
  private readonly clientId?: string;

  constructor(config: DiagnosticLogR2AdapterConfig) {
    this.bucket = config.bucket;
    this.pathPrefix = normalizeDiagnosticPrefix(config.pathPrefix);
    this.tenantId = config.tenantId;
    this.tenantKeySalt = config.tenantKeySalt;
    this.tenantKey = config.tenantKey;
    this.clientId = config.clientId;
  }

  /**
   * Write a single diagnostic log entry
   */
  async writeLog(entry: DiagnosticLogEntry): Promise<DiagnosticLogWriteResult> {
    return this.writeLogBatch([entry]);
  }

  /**
   * Write a batch of diagnostic log entries
   */
  async writeLogBatch(entries: DiagnosticLogEntry[]): Promise<DiagnosticLogWriteResult> {
    if (entries.length === 0) {
      return {
        success: true,
        entriesWritten: 0,
        backend: 'r2-diagnostic',
        durationMs: 0,
      };
    }

    const startTime = Date.now();

    // Group entries by category and bounded chunk window. Each group becomes a
    // new immutable object; existing chunks are never read and rewritten.
    const grouped = this.groupEntriesByChunkWindow(entries);
    const tenantKey = await resolveDiagnosticTenantKey({
      tenantId: this.tenantId,
      tenantKey: this.tenantKey,
      tenantKeySalt: this.tenantKeySalt,
    });

    let written = 0;
    const errors: string[] = [];

    for (const [key, groupEntries] of grouped) {
      try {
        const [category, chunkStartAtText] = key.split('|') as [DiagnosticLogCategory, string];
        const chunkStartAt = Number.parseInt(chunkStartAtText, 10);
        const chunkEndAt = Math.max(...groupEntries.map((entry) => entry.timestamp));
        const chunkId = createLoggingId('chk', chunkStartAt);
        const r2Key = await buildDiagnosticLogPath({
          pathPrefix: this.pathPrefix,
          tenantId: this.tenantId,
          tenantKey,
          clientId: this.clientId,
          category,
          timestamp: chunkStartAt,
          chunkId,
        });
        const content = `${groupEntries.map((e) => JSON.stringify(e)).join('\n')}\n`;

        await this.bucket.put(r2Key, content, {
          httpMetadata: { contentType: 'application/x-ndjson' },
          customMetadata: {
            tenantKey,
            clientId: this.clientId ?? '',
            category,
            entryCount: String(groupEntries.length),
            chunkStartAt: String(chunkStartAt),
            chunkEndAt: String(chunkEndAt),
            createdAt: new Date().toISOString(),
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
      backend: 'r2-diagnostic',
      durationMs: Date.now() - startTime,
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
    };
  }

  /**
   * Query diagnostic logs
   */
  async query(options: DiagnosticLogQueryOptions): Promise<DiagnosticLogQueryResult> {
    const startTime = Date.now();

    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    try {
      const entries: DiagnosticLogEntry[] = [];
      const objects = await this.listQueryObjects(options);
      const filteredObjects = this.filterObjectsByDate(objects, options.startTime, options.endTime);

      // Read and parse entries
      for (const obj of filteredObjects) {
        if (entries.length >= limit + offset) break;

        const content = await this.bucket.get(obj.key);
        if (!content) continue;

        const text = await readR2ObjectTextWithLimit(content, DIAGNOSTIC_R2_OBJECT_MAX_BYTES);

        // Parse JSONL
        const lines = text.split('\n').filter((l) => l.trim());
        for (const line of lines) {
          if (entries.length >= limit + offset) break;
          try {
            const entry = JSON.parse(line) as DiagnosticLogEntry;
            if (this.matchesQueryOptions(entry, options)) {
              entries.push(entry);
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      // Apply pagination
      const paginatedEntries = entries.slice(offset, offset + limit);

      return {
        entries: paginatedEntries,
        totalCount: entries.length,
        hasMore: entries.length > offset + limit,
        durationMs: Date.now() - startTime,
        backend: 'r2-diagnostic',
      };
    } catch (error) {
      return {
        entries: [],
        totalCount: 0,
        hasMore: false,
        durationMs: Date.now() - startTime,
        backend: 'r2-diagnostic',
      };
    }
  }

  /**
   * Delete logs older than retention period
   */
  async deleteByRetention(beforeTime: number, batchSize: number = 100): Promise<number> {
    const prefix = await buildDiagnosticLogPrefix({
      pathPrefix: this.pathPrefix,
      tenantId: this.tenantId,
      tenantKey: this.tenantKey,
      tenantKeySalt: this.tenantKeySalt,
    });

    try {
      let deleted = 0;
      let cursor: string | undefined;

      do {
        const listed = await this.bucket.list({ prefix, limit: batchSize, cursor });

        for (const obj of listed.objects) {
          const objDate = this.getObjectDayTimestamp(obj.key);
          if (objDate < beforeTime) {
            await this.bucket.delete(obj.key);
            deleted++;
          }
        }

        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);

      return deleted;
    } catch {
      return 0;
    }
  }

  /**
   * Health check
   */
  async isHealthy(): Promise<{ healthy: boolean; latencyMs: number; errorMessage?: string }> {
    const startTime = Date.now();

    try {
      // List a small number of objects to check connectivity
      await this.bucket.list({ prefix: this.pathPrefix, limit: 1 });

      return {
        healthy: true,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - startTime,
        errorMessage: String(error),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Helper Methods
  // ---------------------------------------------------------------------------

  private groupEntriesByChunkWindow(
    entries: DiagnosticLogEntry[]
  ): Map<string, DiagnosticLogEntry[]> {
    const grouped = new Map<string, DiagnosticLogEntry[]>();

    for (const entry of entries) {
      const chunkStartAt = floorToDiagnosticChunkWindow(entry.timestamp);
      const key = `${entry.category}|${chunkStartAt}`;

      const existing = grouped.get(key) ?? [];
      existing.push(entry);
      grouped.set(key, existing);
    }

    return grouped;
  }

  private async listQueryObjects(options: DiagnosticLogQueryOptions): Promise<R2Object[]> {
    const prefix = await buildDiagnosticLogPrefix({
      pathPrefix: this.pathPrefix,
      tenantId: options.tenantId,
      tenantKey: options.tenantId === this.tenantId ? this.tenantKey : undefined,
      tenantKeySalt: this.tenantKeySalt,
      category: options.category,
      clientId: options.category ? options.clientId : undefined,
    });
    const objects: R2Object[] = [];
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({
        prefix,
        limit: 1000,
        cursor,
      });
      objects.push(...listed.objects);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return objects;
  }

  private getObjectDayTimestamp(key: string): number {
    const partitionMatch = key.match(/\/yyyy=(\d{4})\/mm=(\d{2})\/dd=(\d{2})\//);
    if (partitionMatch) {
      return Date.UTC(
        Number.parseInt(partitionMatch[1], 10),
        Number.parseInt(partitionMatch[2], 10) - 1,
        Number.parseInt(partitionMatch[3], 10)
      );
    }

    const legacyMatch = key.match(/\/(\d{4}-\d{2}-\d{2})\//);
    if (legacyMatch) {
      return new Date(`${legacyMatch[1]}T00:00:00.000Z`).getTime();
    }

    return Number.POSITIVE_INFINITY;
  }

  private filterObjectsByDate(
    objects: R2Object[],
    startTime?: number,
    endTime?: number
  ): R2Object[] {
    if (!startTime && !endTime) return objects;

    return objects.filter((obj) => {
      const objDate = this.getObjectDayTimestamp(obj.key);
      if (!Number.isFinite(objDate)) return true;

      if (startTime && objDate < startTime - 86400000) return false; // Day buffer
      if (endTime && objDate > endTime + 86400000) return false;
      return true;
    });
  }

  private matchesQueryOptions(
    entry: DiagnosticLogEntry,
    options: DiagnosticLogQueryOptions
  ): boolean {
    if (entry.tenantId !== options.tenantId) return false;
    if (options.clientId && entry.clientId !== options.clientId) return false;

    // Time range filter
    if (options.startTime && entry.timestamp < options.startTime) return false;
    if (options.endTime && entry.timestamp >= options.endTime) return false;

    // Diagnostic session ID filter
    if (options.diagnosticSessionId && entry.diagnosticSessionId !== options.diagnosticSessionId) {
      return false;
    }

    // Request ID filter
    if (options.requestId && entry.requestId !== options.requestId) {
      return false;
    }

    // Category filter (already filtered by prefix, but double-check)
    if (options.category && entry.category !== options.category) {
      return false;
    }

    return true;
  }
}

/**
 * Create a diagnostic log R2 adapter
 */
export function createDiagnosticLogR2Adapter(
  bucket: R2Bucket,
  options: {
    pathPrefix?: string;
    tenantId: string;
    tenantKey?: string;
    tenantKeySalt?: string;
    clientId?: string;
  }
): DiagnosticLogR2Adapter {
  return new DiagnosticLogR2Adapter({
    bucket,
    pathPrefix: options.pathPrefix ?? 'diagnostic-logs',
    tenantId: options.tenantId,
    tenantKey: options.tenantKey,
    tenantKeySalt: options.tenantKeySalt,
    clientId: options.clientId,
  });
}
