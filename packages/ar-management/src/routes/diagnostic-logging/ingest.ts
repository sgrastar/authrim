/**
 * Diagnostic Logs Ingest API
 *
 * POST /api/v1/diagnostic-logs/ingest
 *
 * Receives diagnostic logs from SDK and stores them in R2.
 * Requires client_id/client_secret authentication.
 */

import { Hono, type Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createLogger,
  ClientRepository,
  DiagnosticLogR2Adapter,
  createSettingsManager,
  DIAGNOSTIC_LOGGING_CATEGORY_META,
  applyPrivacyModeToEntry,
  identifierOrFingerprint,
  getDefaultTenantId,
  isMultiTenantEnabled,
  emitRuntimeLogRecords,
  readRequestTextWithLimit,
  verifyClientSecretHash,
  resolveAuthCorePersistenceAdapterFromEnv,
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
  /** Tenant ID. Required in multi-tenant deployments because client_id is tenant-scoped. */
  tenant_id?: string;
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
  tenantId: string,
  clientId: string,
  clientSecret?: string
): Promise<{ valid: boolean; client?: OAuthClient; error?: string }> {
  try {
    const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
      env,
      'diagnostic-logging-client-validation',
      { tenantId }
    );
    const clientRepo = new ClientRepository(adapter, tenantId);
    const client = await clientRepo.findByClientId(clientId);

    if (!client) {
      return { valid: false, error: 'client_not_found' };
    }

    const requiresSecret = client.token_endpoint_auth_method !== 'none';

    if (!requiresSecret) {
      return { valid: true, client };
    }

    if (!clientSecret) {
      return { valid: false, error: 'client_secret_required' };
    }

    if (!client.client_secret_hash) {
      return { valid: false, error: 'client_secret_not_configured' };
    }

    if (!(await verifyClientSecretHash(clientSecret, client.client_secret_hash))) {
      return { valid: false, error: 'invalid_client_secret' };
    }

    return { valid: true, client };
  } catch (error) {
    log.error('Failed to validate client', {
      clientId: await identifierOrFingerprint(clientId),
      error: String(error),
    });
    return { valid: false, error: 'validation_error' };
  }
}

function resolveIngestTenantId(env: Env, tenantId?: string): string | null {
  const normalized = tenantId?.trim();
  if (normalized) {
    return normalized;
  }
  return isMultiTenantEnabled(env) ? null : getDefaultTenantId(env);
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

async function recordDiagnosticIngestFailure(
  c: Context<{ Bindings: Env }>,
  input: {
    reason: string;
    tenantId?: string | null;
    clientId?: string | null;
    httpStatus: number;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const tenantId = input.tenantId || getDefaultTenantId(c.env);
  // The client id is what the sender wrote before anything was checked: it reaches the archive
  // only as a plain identifier or a fingerprint (an email-shaped client_id is not stored).
  const clientId =
    input.clientId === null || input.clientId === undefined
      ? null
      : await identifierOrFingerprint(input.clientId);
  try {
    await emitRuntimeLogRecords({
      env: c.env,
      tenantId,
      logType: 'diagnostic',
      surface: 'diagnostic_ingest',
      sourceDataset: 'diagnostic.ingest_events',
      planes: ['archive'],
      records: [
        {
          id: `diag_ingest_${crypto.randomUUID()}`,
          eventAt: Date.now(),
          type: 'diagnostic.ingest.failure',
          severity: input.httpStatus >= 500 ? 'error' : 'warn',
          subject: clientId ? `client:${clientId}` : null,
          payload: {
            reason: input.reason,
            client_id: clientId,
            http_status: input.httpStatus,
            ...(input.metadata ?? {}),
          },
        },
      ],
    });
  } catch (error) {
    log.warn('Failed to record diagnostic ingest failure event', {
      reason: input.reason,
      error: String(error),
    });
  }
}

/**
 * POST /api/v1/diagnostic-logs/ingest
 *
 * Ingest diagnostic logs from SDK
 */
app.post('/', async (c) => {
  // Parse request body
  let body: IngestRequestBody;
  let rawBody: string;
  try {
    rawBody = await readRequestTextWithLimit(c.req.raw, MAX_REQUEST_SIZE);
  } catch {
    await recordDiagnosticIngestFailure(c, {
      reason: 'request_too_large',
      httpStatus: 400,
      metadata: { max_request_size: MAX_REQUEST_SIZE },
    });
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Request size exceeds limit',
      },
      400
    );
  }
  try {
    body = JSON.parse(rawBody);
  } catch {
    await recordDiagnosticIngestFailure(c, {
      reason: 'invalid_json',
      httpStatus: 400,
      metadata: { body_bytes: rawBody.length },
    });
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
    await recordDiagnosticIngestFailure(c, {
      reason: 'missing_required_fields',
      clientId: typeof body.client_id === 'string' ? body.client_id : null,
      httpStatus: 400,
    });
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
    await recordDiagnosticIngestFailure(c, {
      reason: 'too_many_logs',
      clientId: body.client_id,
      tenantId: body.tenant_id ?? null,
      httpStatus: 400,
      metadata: { log_count: body.logs.length, max_logs: MAX_LOGS_PER_REQUEST },
    });
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Maximum ${MAX_LOGS_PER_REQUEST} logs per request`,
      },
      400
    );
  }

  const tenantId = resolveIngestTenantId(c.env, body.tenant_id);
  if (!tenantId) {
    await recordDiagnosticIngestFailure(c, {
      reason: 'tenant_id_required',
      clientId: body.client_id,
      httpStatus: 400,
    });
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'tenant_id is required for diagnostic log ingestion',
      },
      400
    );
  }

  // Validate client credentials
  const validation = await validateClient(c.env, tenantId, body.client_id, body.client_secret);
  if (!validation.valid) {
    log.warn('Client validation failed', {
      clientId: await identifierOrFingerprint(body.client_id),
      error: validation.error,
    });
    await recordDiagnosticIngestFailure(c, {
      reason: validation.error || 'client_validation_failed',
      tenantId,
      clientId: body.client_id,
      httpStatus: 401,
    });

    return c.json(
      {
        error: 'invalid_client',
        error_description: validation.error || 'Client validation failed',
      },
      401
    );
  }

  const validatedTenantId = validation.client?.tenant_id;
  if (validatedTenantId !== tenantId) {
    await recordDiagnosticIngestFailure(c, {
      reason: 'client_tenant_mismatch',
      tenantId,
      clientId: body.client_id,
      httpStatus: 401,
      metadata: { validated_tenant_present: !!validatedTenantId },
    });
    return c.json(
      {
        error: 'invalid_client',
        error_description: 'Client tenant mismatch',
      },
      401
    );
  }
  // The tenant's settings decide whether anything is stored at all (sdk_ingest_enabled), so
  // when they cannot be read nothing is stored: a settings outage must not switch ingest on.
  let diagnosticSettings: DiagnosticLoggingSettings;
  try {
    // A deployment without the settings namespace cannot say whether ingest is on: same as a
    // namespace that cannot be read.
    if (!c.env.SETTINGS) throw new Error('settings_binding_missing');
    const manager = createSettingsManager({
      env: c.env as unknown as Record<string, string | undefined>,
      kv: c.env.SETTINGS ?? null,
      cacheTTL: 5000,
      // A settings document that exists but cannot be read must not pass for the tenant's choices.
      strictReads: true,
    });
    manager.registerCategory(DIAGNOSTIC_LOGGING_CATEGORY_META);

    const result = await manager.getAll('diagnostic-logging', {
      type: 'tenant',
      id: tenantId,
    });
    diagnosticSettings = result.values as unknown as DiagnosticLoggingSettings;
  } catch (error) {
    log.error('Failed to load diagnostic logging settings', { error: String(error) });
    await recordDiagnosticIngestFailure(c, {
      reason: 'settings_unavailable',
      tenantId,
      clientId: body.client_id,
      httpStatus: 503,
    });
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'Diagnostic logging settings cannot be read right now; try again',
      },
      503
    );
  }

  if (
    !diagnosticSettings['diagnostic-logging.enabled'] ||
    !diagnosticSettings['diagnostic-logging.sdk_ingest_enabled']
  ) {
    await recordDiagnosticIngestFailure(c, {
      reason: 'sdk_ingest_disabled',
      tenantId,
      clientId: body.client_id,
      httpStatus: 403,
    });
    return c.json(
      {
        error: 'feature_disabled',
        error_description: 'Diagnostic logging or SDK log ingestion is disabled',
      },
      403
    );
  }

  try {
    const effectiveSettings = diagnosticSettings;
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
          // Named by the receiver, never taken from the sender: a merged export shows it.
          source: 'sdk',
        };
        return applyPrivacyModeToEntry(normalized, {
          mode: storageMode,
          secret: hashSecret,
          tokenHashPrefixLength,
          filterPii: effectiveSettings['diagnostic-logging.filter_pii'] !== false,
        });
      })
    );

    const adapter = new DiagnosticLogR2Adapter({
      env: c.env,
      tenantId,
      clientId: body.client_id,
      retentionDays: effectiveSettings['diagnostic-logging.retention_days'],
    });
    const result = await adapter.writeLogBatch(sanitizedLogs);
    if (!result.success) throw new Error(result.errorMessage ?? 'diagnostic_log_write_failed');
    const totalWritten = result.entriesWritten;

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
