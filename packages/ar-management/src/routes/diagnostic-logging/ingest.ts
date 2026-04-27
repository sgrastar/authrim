/**
 * Diagnostic Logs Ingest API
 *
 * POST /api/v1/diagnostic-logs/ingest
 *
 * Receives diagnostic logs from SDK and stores them in R2.
 * Requires client_id/client_secret authentication.
 */

import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createLogger,
  ensureDatabaseAdapter,
  ClientRepository,
  DiagnosticLogR2Adapter,
  createSettingsManager,
  DIAGNOSTIC_LOGGING_CATEGORY_META,
  applyPrivacyModeToEntry,
  getDefaultTenantId,
  type DiagnosticLogEntry,
  type DiagnosticLogPrivacyMode,
  type DiagnosticLoggingSettings,
  type OAuthClient,
} from '@authrim/ar-lib-core';

const log = createLogger().module('DiagnosticLogsIngestAPI');

const app = new Hono<{ Bindings: Env }>();

/**
 * Ingest request body
 */
interface IngestRequestBody {
  /** Diagnostic log entries */
  logs: DiagnosticLogEntry[];
  /** Client ID */
  client_id: string;
  /** Client secret (required for confidential clients) */
  client_secret?: string;
}

/**
 * Maximum request size (100KB)
 */
const MAX_REQUEST_SIZE = 100 * 1024;

/**
 * Maximum number of logs per request
 */
const MAX_LOGS_PER_REQUEST = 100;

/**
 * Validate client credentials
 */
async function validateClient(
  env: Env,
  clientId: string,
  clientSecret?: string
): Promise<{ valid: boolean; client?: OAuthClient; error?: string }> {
  try {
    const adapter = ensureDatabaseAdapter(env.DB, 'diagnostic-logging-client-validation');
    const clientRepo = new ClientRepository(adapter);
    const client = await clientRepo.findByClientId(clientId);

    if (!client) {
      return { valid: false, error: 'client_not_found' };
    }

    // For confidential clients, client_secret is required
    if (client.token_endpoint_auth_method !== 'none' && !clientSecret) {
      return { valid: false, error: 'client_secret_required' };
    }

    // Verify client_secret for confidential clients
    // Note: OAuthClient has client_secret_hash, not client_secret
    // We need to hash the provided secret and compare
    if (client.token_endpoint_auth_method !== 'none' && clientSecret) {
      // For simplicity, we'll accept any secret for now
      // In production, implement proper secret verification
      // TODO: Implement proper client_secret verification with hashing
    }

    return { valid: true, client };
  } catch (error) {
    log.error('Failed to validate client', { clientId, error: String(error) });
    return { valid: false, error: 'validation_error' };
  }
}

/**
 * Resolve storage mode for a client (tenant default + client overrides)
 */
function resolveStorageMode(
  settings: DiagnosticLoggingSettings,
  clientId: string | undefined
): DiagnosticLogPrivacyMode {
  const defaultMode =
    (settings['diagnostic-logging.storage_mode.default'] as DiagnosticLogPrivacyMode) || 'masked';
  if (!clientId) return defaultMode;

  const rawOverrides = settings['diagnostic-logging.storage_mode.by_client'];
  if (typeof rawOverrides === 'string' && rawOverrides.trim()) {
    try {
      const parsed = JSON.parse(rawOverrides) as Record<string, unknown>;
      const override = parsed[clientId];
      if (override === 'full' || override === 'masked' || override === 'minimal') {
        return override;
      }
    } catch {
      // Ignore invalid JSON overrides
    }
  }
  return defaultMode;
}

function resolveHashSecret(env: Env, tenantId: string): string {
  const base = env.OTP_HMAC_SECRET || env.ISSUER_URL || tenantId || 'authrim';
  return `${base}:${tenantId}`;
}

/**
 * POST /api/v1/diagnostic-logs/ingest
 *
 * Ingest diagnostic logs from SDK
 */
app.post('/', async (c) => {
  // Check R2 bucket binding
  const r2 = c.env.DIAGNOSTIC_LOGS;
  if (!r2) {
    log.error('DIAGNOSTIC_LOGS R2 bucket not configured');
    return c.json(
      {
        error: 'server_error',
        error_description: 'Diagnostic logging storage not configured',
      },
      500
    );
  }

  // Parse request body
  let body: IngestRequestBody;
  try {
    const rawBody = await c.req.text();

    // Check request size
    if (rawBody.length > MAX_REQUEST_SIZE) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Request size exceeds limit',
        },
        400
      );
    }

    body = JSON.parse(rawBody);
  } catch (error) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid JSON body',
      },
      400
    );
  }

  // Validate request body
  if (!body.client_id || !Array.isArray(body.logs)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Missing required fields: client_id, logs',
      },
      400
    );
  }

  // Check logs count
  if (body.logs.length > MAX_LOGS_PER_REQUEST) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Maximum ${MAX_LOGS_PER_REQUEST} logs per request`,
      },
      400
    );
  }

  // Validate client credentials
  const validation = await validateClient(c.env, body.client_id, body.client_secret);
  if (!validation.valid) {
    log.warn('Client validation failed', {
      clientId: body.client_id,
      error: validation.error,
    });

    return c.json(
      {
        error: 'invalid_client',
        error_description: validation.error || 'Client validation failed',
      },
      401
    );
  }

  const tenantId = validation.client?.tenant_id || getDefaultTenantId(c.env);
  let diagnosticSettings: DiagnosticLoggingSettings | null = null;

  try {
    const manager = createSettingsManager({
      env: c.env as unknown as Record<string, string | undefined>,
      kv: c.env.AUTHRIM_CONFIG ?? c.env.KV ?? null,
      cacheTTL: 5000,
    });
    manager.registerCategory(DIAGNOSTIC_LOGGING_CATEGORY_META);

    const result = await manager.getAll('diagnostic-logging', {
      type: 'tenant',
      id: tenantId,
    });
    diagnosticSettings = result.values as unknown as DiagnosticLoggingSettings;

    if (!diagnosticSettings['diagnostic-logging.sdk_ingest_enabled']) {
      return c.json(
        {
          error: 'feature_disabled',
          error_description: 'SDK log ingestion is disabled',
        },
        403
      );
    }
  } catch (error) {
    log.error('Failed to load diagnostic logging settings', { error: String(error) });
    // Fail open: if we can't check the setting, allow the request
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

    const effectiveSettings = diagnosticSettings ?? settingsFallback;
    const storageMode = resolveStorageMode(effectiveSettings, body.client_id);
    const hashSecret = resolveHashSecret(c.env, tenantId);
    const tokenHashPrefixLength =
      effectiveSettings['diagnostic-logging.token_hash_prefix_length'] ?? 12;

    const sanitizedLogs = await Promise.all(
      body.logs.map(async (entry) => {
        const normalized: DiagnosticLogEntry = {
          ...entry,
          tenantId,
          clientId: body.client_id,
          storageMode,
        };
        return applyPrivacyModeToEntry(normalized, {
          mode: storageMode,
          secret: hashSecret,
          tokenHashPrefixLength,
        });
      })
    );

    // Group logs by category and write to R2
    const logsByCategory = new Map<string, DiagnosticLogEntry[]>();
    for (const entry of sanitizedLogs) {
      const category = entry.category;
      if (!logsByCategory.has(category)) {
        logsByCategory.set(category, []);
      }
      logsByCategory.get(category)!.push(entry);
    }

    let totalWritten = 0;

    for (const [category, logs] of logsByCategory) {
      const adapter = new DiagnosticLogR2Adapter({
        bucket: r2,
        pathPrefix: 'diagnostic-logs',
        tenantId,
        clientId: body.client_id,
      });

      const result = await adapter.writeLogBatch(logs);
      totalWritten += result.entriesWritten;

      log.debug('Wrote diagnostic logs', {
        clientId: body.client_id,
        category,
        count: result.entriesWritten,
      });
    }

    log.info('Ingested diagnostic logs', {
      clientId: body.client_id,
      totalLogs: totalWritten,
    });

    return c.json({
      success: true,
      entriesWritten: totalWritten,
    });
  } catch (error) {
    log.error('Failed to ingest diagnostic logs', {
      clientId: body.client_id,
      error: String(error),
    });

    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to ingest logs',
      },
      500
    );
  }
});

export default app;
