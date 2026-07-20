/**
 * Diagnostic Logs Export API
 *
 * GET /api/admin/diagnostic-logging/export
 *
 * Exports diagnostic logs from R2 in various formats (JSON, JSONL, Text).
 */

import { Hono } from 'hono';
import type { Env, DiagnosticLogEntry } from '@authrim/ar-lib-core';
import {
  adminAuthMiddleware,
  createLogger,
  createSettingsManager,
  formatAsJSON,
  formatAsJSONL,
  formatAsText,
  getLogStatistics,
  DIAGNOSTIC_LOGGING_CATEGORY_META,
  applyPrivacyModeToEntry,
  buildDiagnosticLogPrefix,
  type DiagnosticLogPrivacyMode,
  type DiagnosticLoggingSettings,
  type ExportOptions,
  readR2ObjectTextWithLimit,
} from '@authrim/ar-lib-core';

const log = createLogger().module('DiagnosticLogsExportAPI');
const DIAGNOSTIC_EXPORT_R2_OBJECT_MAX_BYTES = 16 * 1024 * 1024;

const app = new Hono<{ Bindings: Env }>();

function safeFilenameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'tenant';
}

/**
 * Export query parameters
 */
interface ExportQuery {
  /** Tenant ID */
  tenantId: string;
  /** Client ID (optional) */
  clientId?: string;
  /** Client IDs (comma-separated) */
  clientIds?: string;
  /** Start date (ISO 8601 or Unix timestamp) */
  startDate?: string;
  /** End date (ISO 8601 or Unix timestamp) */
  endDate?: string;
  /** Session IDs (comma-separated) */
  sessionIds?: string;
  /** Authentication flow IDs (comma-separated) */
  flowIds?: string;
  /** Categories (comma-separated) */
  categories?: string;
  /** Output format */
  format?: 'json' | 'jsonl' | 'text';
  /** Include statistics */
  includeStats?: string;
  /** Sort mode */
  sortMode?: 'session' | 'category' | 'timeline';
  /** Export privacy mode */
  exportMode?: 'full' | 'masked' | 'minimal';
}

/**
 * Parse client IDs from query
 */
function parseCsvFilter(
  value: string | undefined,
  field: string,
  options: { maxItems?: number; maxItemLength?: number } = {}
): string[] | undefined {
  if (!value) return undefined;
  const maxItems = options.maxItems ?? 100;
  const maxItemLength = options.maxItemLength ?? 256;
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const unique = Array.from(new Set(ids));
  if (unique.length > maxItems) {
    throw new Error(`${field} must contain at most ${maxItems} values`);
  }
  if (unique.some((id) => id.length > maxItemLength)) {
    throw new Error(`${field} contains a value longer than ${maxItemLength} characters`);
  }
  return unique.length > 0 ? unique : undefined;
}

/**
 * Parse date string to Unix timestamp
 */
function parseDate(dateStr: string): number {
  // Try parsing as Unix timestamp first
  const timestamp = parseInt(dateStr, 10);
  if (!isNaN(timestamp)) {
    // If it's a reasonable Unix timestamp (in milliseconds)
    if (timestamp > 1000000000000) {
      return timestamp;
    }
    // If it's in seconds, convert to milliseconds
    if (timestamp > 1000000000) {
      return timestamp * 1000;
    }
  }

  // Try parsing as ISO 8601
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    return date.getTime();
  }

  throw new Error(`Invalid date format: ${dateStr}`);
}

/**
 * Parse date string with day-boundary handling for date-only inputs.
 */
function parseDateWithBoundary(dateStr: string, boundary: 'start' | 'end'): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const base = new Date(`${dateStr}T00:00:00.000Z`).getTime();
    return boundary === 'end' ? base + 24 * 60 * 60 * 1000 - 1 : base;
  }
  return parseDate(dateStr);
}

function resolveHashSecret(env: Env, tenantId: string): string {
  const base = env.OTP_HMAC_SECRET || env.ISSUER_URL || tenantId || 'authrim';
  return `${base}:${tenantId}`;
}

function normalizeMode(value?: string): DiagnosticLogPrivacyMode | undefined {
  if (value === 'full' || value === 'masked' || value === 'minimal') return value;
  return undefined;
}

function resolveEffectiveMode(
  storedMode: DiagnosticLogPrivacyMode,
  requestedMode?: DiagnosticLogPrivacyMode
): DiagnosticLogPrivacyMode {
  if (!requestedMode) return storedMode;
  const rank: Record<DiagnosticLogPrivacyMode, number> = {
    minimal: 0,
    masked: 1,
    full: 2,
  };
  return rank[storedMode] <= rank[requestedMode] ? storedMode : requestedMode;
}

function getDiagnosticObjectDayTimestamp(key: string): number {
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

function isDiagnosticObjectInDateRange(key: string, startDate: Date, endDate: Date): boolean {
  const day = getDiagnosticObjectDayTimestamp(key);
  if (!Number.isFinite(day)) return true;
  const start = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate()
  );
  const end =
    Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()) +
    24 * 60 * 60 * 1000 -
    1;
  return day >= start - 24 * 60 * 60 * 1000 && day <= end + 24 * 60 * 60 * 1000;
}

/**
 * List immutable diagnostic chunk objects in date range.
 */
async function listR2Objects(
  r2: R2Bucket,
  prefix: string,
  startDate: Date,
  endDate: Date
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  const listPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;

  do {
    const listed = await r2.list({ prefix: listPrefix, limit: 1000, cursor });

    for (const object of listed.objects) {
      if (isDiagnosticObjectInDateRange(object.key, startDate, endDate)) {
        keys.push(object.key);
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return keys;
}

/**
 * Fetch and parse diagnostic logs from R2
 */
async function fetchLogsFromR2(r2: R2Bucket, keys: string[]): Promise<DiagnosticLogEntry[]> {
  const logs: DiagnosticLogEntry[] = [];

  for (const key of keys) {
    try {
      const object = await r2.get(key);
      if (!object) continue;

      const text = await readR2ObjectTextWithLimit(object, DIAGNOSTIC_EXPORT_R2_OBJECT_MAX_BYTES);
      const lines = text.split('\n').filter((line) => line.trim());

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as DiagnosticLogEntry;
          logs.push(parsed);
        } catch (error) {
          log.warn('Failed to parse log line', { key, error: String(error) });
        }
      }
    } catch (error) {
      log.warn('Failed to fetch R2 object', { key, error: String(error) });
    }
  }

  return logs;
}

/**
 * GET /api/admin/diagnostic-logging/export
 *
 * Export diagnostic logs
 */
app.get('/', adminAuthMiddleware({ requirePermissions: ['admin:diagnostics:read'] }), async (c) => {
  const query = c.req.query() as unknown as ExportQuery;

  // Validate required parameters
  if (!query.tenantId) {
    return c.json(
      {
        error: 'missing_tenant_id',
        message: 'tenantId query parameter is required',
      },
      400
    );
  }

  // Parse query parameters
  const tenantId = query.tenantId;
  if (tenantId.length > 128) {
    return c.json({ error: 'invalid_tenant_id', message: 'tenantId is too long' }, 400);
  }

  let clientIds: string[] | undefined;
  let sessionIds: string[] | undefined;
  let flowIds: string[] | undefined;
  let categories: string[] | undefined;
  try {
    clientIds = parseCsvFilter(query.clientIds ?? query.clientId, 'clientIds');
    sessionIds = parseCsvFilter(query.sessionIds, 'sessionIds');
    flowIds = parseCsvFilter(query.flowIds, 'flowIds', { maxItemLength: 128 });
    categories = parseCsvFilter(query.categories, 'categories', {
      maxItems: 4,
      maxItemLength: 32,
    });
  } catch (error) {
    return c.json(
      {
        error: 'invalid_filter',
        message: error instanceof Error ? error.message : 'Invalid export filter',
      },
      400
    );
  }

  const allowedCategories = new Set([
    'http-request',
    'http-response',
    'token-validation',
    'auth-decision',
  ]);
  if (categories?.some((category) => !allowedCategories.has(category))) {
    return c.json({ error: 'invalid_categories', message: 'Unknown log category' }, 400);
  }

  const format = query.format || 'json';
  if (format !== 'json' && format !== 'jsonl' && format !== 'text') {
    return c.json({ error: 'invalid_format', message: 'Unknown export format' }, 400);
  }
  if (query.sortMode && !['session', 'category', 'timeline'].includes(query.sortMode)) {
    return c.json({ error: 'invalid_sort_mode', message: 'Unknown sort mode' }, 400);
  }
  if (query.exportMode && !normalizeMode(query.exportMode)) {
    return c.json({ error: 'invalid_export_mode', message: 'Unknown export privacy mode' }, 400);
  }
  const includeStats = query.includeStats === 'true';
  const sortMode = query.sortMode;
  const exportMode = normalizeMode(query.exportMode);

  // Parse date range
  let startTime: number | undefined;
  let endTime: number | undefined;

  try {
    if (query.startDate) {
      startTime = parseDateWithBoundary(query.startDate, 'start');
    }
    if (query.endDate) {
      endTime = parseDateWithBoundary(query.endDate, 'end');
    }
  } catch (error) {
    return c.json(
      {
        error: 'invalid_date',
        message: error instanceof Error ? error.message : 'Invalid date format',
      },
      400
    );
  }

  // Default to last 7 days if no date range specified
  if (!startTime && !endTime) {
    endTime = Date.now();
    startTime = endTime - 7 * 24 * 60 * 60 * 1000; // 7 days ago
  }

  const startDate = new Date(startTime || 0);
  const endDate = new Date(endTime || Date.now());
  if (startDate.getTime() > endDate.getTime()) {
    return c.json(
      { error: 'invalid_date_range', message: 'startDate must not be after endDate' },
      400
    );
  }

  // Check R2 bucket binding
  const r2 = c.env.DIAGNOSTIC_LOGS;
  if (!r2) {
    return c.json(
      {
        error: 'r2_not_configured',
        message: 'DIAGNOSTIC_LOGS R2 bucket is not configured',
      },
      500
    );
  }

  try {
    const settingsFallback: DiagnosticLoggingSettings = {
      'diagnostic-logging.enabled': true,
      'diagnostic-logging.log_level': 'debug',
      'diagnostic-logging.http_request_enabled': true,
      'diagnostic-logging.http_response_enabled': true,
      'diagnostic-logging.token_validation_enabled': true,
      'diagnostic-logging.auth_decision_enabled': true,
      'diagnostic-logging.r2_output_enabled': true,
      'diagnostic-logging.r2_bucket_binding': 'DIAGNOSTIC_LOGS',
      'diagnostic-logging.r2_path_prefix': 'diagnostic-logs',
      'diagnostic-logging.output_format': 'jsonl',
      'diagnostic-logging.buffer_strategy': 'queue',
      'diagnostic-logging.batch_size': 100,
      'diagnostic-logging.batch_interval_ms': 5000,
      'diagnostic-logging.filter_pii': true,
      'diagnostic-logging.filter_tokens': true,
      'diagnostic-logging.token_hash_prefix_length': 12,
      'diagnostic-logging.http_safe_headers':
        'content-type,accept,user-agent,x-correlation-id,x-diagnostic-session-id',
      'diagnostic-logging.http_body_schema_aware': true,
      'diagnostic-logging.retention_days': 30,
      'diagnostic-logging.storage_mode.default': 'masked',
      'diagnostic-logging.storage_mode.by_client': '{}',
      'diagnostic-logging.sdk_ingest_enabled': true,
      'diagnostic-logging.merged_output_enabled': false,
    };

    let diagnosticSettings = settingsFallback;
    try {
      const manager = createSettingsManager({
        env: c.env as unknown as Record<string, string | undefined>,
        kv: c.env.SETTINGS ?? null,
        cacheTTL: 5000,
      });
      manager.registerCategory(DIAGNOSTIC_LOGGING_CATEGORY_META);
      const result = await manager.getAll('diagnostic-logging', {
        type: 'tenant',
        id: tenantId,
      });
      diagnosticSettings = result.values as unknown as DiagnosticLoggingSettings;
    } catch (error) {
      log.warn('Failed to load diagnostic settings for export', { error: String(error) });
    }

    const hashSecret = resolveHashSecret(c.env, tenantId);
    const tokenHashPrefixLength =
      diagnosticSettings['diagnostic-logging.token_hash_prefix_length'] ?? 12;

    // Build R2 prefixes for immutable diagnostic chunks.
    const logTypes = categories || ['token-validation', 'auth-decision'];
    const allLogs: DiagnosticLogEntry[] = [];
    const pathPrefix = diagnosticSettings['diagnostic-logging.r2_path_prefix'] || 'diagnostic-logs';

    const prefixes: string[] = [];

    for (const logType of logTypes) {
      if (clientIds && clientIds.length > 0) {
        for (const clientId of clientIds) {
          prefixes.push(
            await buildDiagnosticLogPrefix({
              pathPrefix,
              tenantId,
              tenantKeySalt: c.env.LOGGING_TENANT_KEY_SALT,
              category: logType as DiagnosticLogEntry['category'],
              clientId,
            })
          );
        }
      } else {
        prefixes.push(
          await buildDiagnosticLogPrefix({
            pathPrefix,
            tenantId,
            tenantKeySalt: c.env.LOGGING_TENANT_KEY_SALT,
            category: logType as DiagnosticLogEntry['category'],
          })
        );
      }
    }

    const keySet = new Set<string>();

    for (const prefix of prefixes) {
      const keys = await listR2Objects(r2, prefix, startDate, endDate);
      log.debug('Listed R2 objects', { prefix, keyCount: keys.length });
      for (const key of keys) {
        keySet.add(key);
      }
    }

    const logs = await fetchLogsFromR2(r2, Array.from(keySet));
    allLogs.push(...logs);

    const processedLogs = await Promise.all(
      allLogs.map(async (entry) => {
        const storedMode = normalizeMode(entry.storageMode) ?? 'masked';
        const effectiveMode = resolveEffectiveMode(storedMode, exportMode);
        if (effectiveMode === storedMode) {
          return entry;
        }
        return applyPrivacyModeToEntry(
          { ...entry, storageMode: storedMode },
          {
            mode: effectiveMode,
            secret: hashSecret,
            tokenHashPrefixLength,
          }
        );
      })
    );

    log.info('Fetched diagnostic logs', {
      tenantId,
      clientIds,
      totalLogs: processedLogs.length,
    });

    // Build export options
    const exportOptions: ExportOptions = {
      sessionIds,
      flowIds,
      startTime,
      endTime,
      categories,
      sortOrder: 'asc',
      sortMode,
    };

    // Format logs
    let output: string;
    let contentType: string;
    let filename: string;

    if (format === 'jsonl') {
      output = formatAsJSONL(processedLogs, exportOptions);
      contentType = 'application/x-ndjson';
      filename = `diagnostic-logs-${safeFilenameSegment(tenantId)}-${Date.now()}.jsonl`;
    } else if (format === 'text') {
      output = formatAsText(processedLogs, exportOptions);
      contentType = 'text/plain';
      filename = `diagnostic-logs-${safeFilenameSegment(tenantId)}-${Date.now()}.txt`;
    } else {
      // Default: JSON
      const jsonData: Record<string, unknown> = {
        logs: JSON.parse(formatAsJSON(processedLogs, exportOptions)),
      };

      if (includeStats) {
        jsonData.statistics = getLogStatistics(processedLogs);
      }

      output = JSON.stringify(jsonData, null, 2);
      contentType = 'application/json';
      filename = `diagnostic-logs-${safeFilenameSegment(tenantId)}-${Date.now()}.json`;
    }

    // Return as downloadable file
    return new Response(output, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    log.error('Failed to export diagnostic logs', {
      error: String(error),
      tenantId,
    });

    return c.json(
      {
        error: 'export_failed',
        message: 'Failed to export diagnostic logs',
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

export default app;
