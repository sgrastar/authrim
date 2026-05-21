/**
 * Diagnostic Logger Service
 *
 * Central service for diagnostic logging with:
 * - Console output (always available)
 * - R2 output (optional, configurable)
 * - Queue-based async processing
 * - Security-first design (token hashing, header filtering, schema-aware extraction)
 */

import type { Env } from '../../types/env';
import type {
  DiagnosticLogEntry,
  DiagnosticLogWriteResult,
  HttpRequestLogEntry,
  HttpResponseLogEntry,
  TokenValidationLogEntry,
  AuthDecisionLogEntry,
  DiagnosticLogLevel,
  TokenValidationStep,
} from './types';
import type { DiagnosticLoggingSettings } from '../../types/settings/diagnostic-logging';
import { createLogger } from '../../utils/logger';
import { DiagnosticLogR2Adapter, createDiagnosticLogR2Adapter } from './diagnostic-log-r2-adapter';
import {
  filterSafeHeaders,
  parseSafeHeadersAllowlist,
  extractBodySummary,
  sanitizeQueryParams,
  hashToken,
  redactPII,
  applyPrivacyModeToEntry,
} from '../../utils/diagnostic-security';
import { readRequestTextWithLimit } from '../../utils/body-limits';
import { readResponseTextWithLimit } from '../../utils/url-security';
import type { DiagnosticLogPrivacyMode } from './types';

const log = createLogger().module('DIAGNOSTIC_LOGGER');
const DIAGNOSTIC_BODY_SUMMARY_MAX_BYTES = 64 * 1024;

/**
 * Diagnostic Logger Configuration
 */
export interface DiagnosticLoggerConfig {
  /** Environment bindings */
  env: Env;

  /** Tenant ID */
  tenantId: string;

  /** Client ID (optional) */
  clientId?: string;

  /** Settings */
  settings: DiagnosticLoggingSettings;

  /** Request context (for Queue integration) */
  ctx?: ExecutionContext;
}

/**
 * Diagnostic Logger Service
 */
export class DiagnosticLogger {
  private readonly env: Env;
  private readonly tenantId: string;
  private readonly clientId?: string;
  private readonly settings: DiagnosticLoggingSettings;
  private readonly ctx?: ExecutionContext;
  private r2Adapter?: DiagnosticLogR2Adapter;
  private readonly storageMode: DiagnosticLogPrivacyMode;
  private readonly hashSecret: string;
  private readonly tokenHashPrefixLength: number;

  // In-memory buffer for batch mode
  private buffer: DiagnosticLogEntry[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(config: DiagnosticLoggerConfig) {
    this.env = config.env;
    this.tenantId = config.tenantId;
    this.clientId = config.clientId;
    this.settings = config.settings;
    this.ctx = config.ctx;
    this.storageMode = this.resolveStorageMode();
    this.hashSecret = this.resolveHashSecret();
    this.tokenHashPrefixLength = this.settings['diagnostic-logging.token_hash_prefix_length'] ?? 12;

    // Initialize R2 adapter if enabled
    if (this.settings['diagnostic-logging.r2_output_enabled']) {
      this.initializeR2Adapter();
    }
  }

  /**
   * Initialize R2 adapter
   */
  private initializeR2Adapter(): void {
    const bindingName = this.settings['diagnostic-logging.r2_bucket_binding'];
    const bucket = this.env[bindingName as keyof Env] as R2Bucket | undefined;

    if (!bucket) {
      log.warn('R2 bucket binding not found', { bindingName });
      return;
    }

    this.r2Adapter = createDiagnosticLogR2Adapter(bucket, {
      pathPrefix: this.settings['diagnostic-logging.r2_path_prefix'],
      tenantId: this.tenantId,
      tenantKeySalt: this.env.LOGGING_TENANT_KEY_SALT,
      clientId: this.clientId,
    });
  }

  /**
   * Check if diagnostic logging is enabled
   */
  isEnabled(): boolean {
    return this.settings['diagnostic-logging.enabled'];
  }

  /**
   * Check if a specific category is enabled
   */
  isCategoryEnabled(category: DiagnosticLogEntry['category']): boolean {
    if (!this.isEnabled()) return false;

    const categoryKey = `diagnostic-logging.${category.replace(
      /-/g,
      '_'
    )}_enabled` as keyof DiagnosticLoggingSettings;
    return this.settings[categoryKey] as boolean;
  }

  /**
   * Resolve storage mode (tenant default + client overrides)
   */
  private resolveStorageMode(): DiagnosticLogPrivacyMode {
    const rawOverrides = this.settings['diagnostic-logging.storage_mode.by_client'];
    const defaultMode =
      (this.settings['diagnostic-logging.storage_mode.default'] as DiagnosticLogPrivacyMode) ||
      'masked';

    if (!this.clientId) return defaultMode;

    if (typeof rawOverrides === 'string' && rawOverrides.trim()) {
      try {
        const parsed = JSON.parse(rawOverrides) as Record<string, unknown>;
        const override = parsed[this.clientId];
        if (override === 'full' || override === 'masked' || override === 'minimal') {
          return override;
        }
      } catch {
        // Ignore invalid JSON overrides
      }
    }

    return defaultMode;
  }

  /**
   * Resolve hash secret for masked mode (HMAC)
   */
  private resolveHashSecret(): string {
    const baseSecret =
      this.env.OTP_HMAC_SECRET || this.env.ISSUER_URL || this.tenantId || 'authrim';
    return `${baseSecret}:${this.tenantId}`;
  }

  /**
   * Log HTTP request (Semantic HTTP Log)
   */
  async logHttpRequest(options: {
    diagnosticSessionId?: string;
    request: Request;
    requestId?: string;
    anonymizedUserId?: string;
    flowId?: string;
  }): Promise<void> {
    if (!this.isCategoryEnabled('http-request')) return;

    const url = new URL(options.request.url);
    const safeHeadersList = parseSafeHeadersAllowlist(
      this.settings['diagnostic-logging.http_safe_headers']
    );

    // Parse body if available (careful with streaming)
    let bodySummary: Record<string, unknown> | undefined;
    if (this.settings['diagnostic-logging.http_body_schema_aware']) {
      try {
        const clonedRequest = options.request.clone();
        const bodyText = await readRequestTextWithLimit(
          clonedRequest,
          DIAGNOSTIC_BODY_SUMMARY_MAX_BYTES
        );
        if (bodyText) {
          const bodyObj = JSON.parse(bodyText);
          bodySummary = extractBodySummary(
            bodyObj,
            options.request.headers.get('content-type') || undefined,
            url.pathname
          );
        }
      } catch {
        // Body parsing failed, skip
      }
    }

    const entry: HttpRequestLogEntry = {
      id: crypto.randomUUID(),
      diagnosticSessionId: options.diagnosticSessionId,
      flowId: options.flowId,
      tenantId: this.tenantId,
      clientId: this.clientId,
      category: 'http-request',
      level: 'debug',
      timestamp: Date.now(),
      requestId: options.requestId,
      storageMode: this.storageMode,
      anonymizedUserId: options.anonymizedUserId,
      method: options.request.method,
      path: url.pathname,
      query: sanitizeQueryParams(Object.fromEntries(url.searchParams)),
      headers: filterSafeHeaders(options.request.headers, safeHeadersList),
      bodySummary,
      remoteAddress: options.request.headers.get('cf-connecting-ip') || undefined,
    };

    await this.writeLog(entry);
  }

  /**
   * Log HTTP response (Semantic HTTP Log)
   */
  async logHttpResponse(options: {
    diagnosticSessionId?: string;
    response: Response;
    requestId?: string;
    durationMs?: number;
    flowId?: string;
  }): Promise<void> {
    if (!this.isCategoryEnabled('http-response')) return;

    const safeHeadersList = parseSafeHeadersAllowlist(
      this.settings['diagnostic-logging.http_safe_headers']
    );

    // Parse body if available
    let bodySummary: Record<string, unknown> | undefined;
    if (this.settings['diagnostic-logging.http_body_schema_aware']) {
      try {
        const clonedResponse = options.response.clone();
        const bodyText = await readResponseTextWithLimit(
          clonedResponse,
          DIAGNOSTIC_BODY_SUMMARY_MAX_BYTES
        );
        if (bodyText) {
          const bodyObj = JSON.parse(bodyText);
          bodySummary = extractBodySummary(bodyObj);
        }
      } catch {
        // Body parsing failed, skip
      }
    }

    const entry: HttpResponseLogEntry = {
      id: crypto.randomUUID(),
      diagnosticSessionId: options.diagnosticSessionId,
      flowId: options.flowId,
      tenantId: this.tenantId,
      clientId: this.clientId,
      category: 'http-response',
      level: 'debug',
      timestamp: Date.now(),
      requestId: options.requestId,
      storageMode: this.storageMode,
      status: options.response.status,
      headers: filterSafeHeaders(options.response.headers, safeHeadersList),
      bodySummary,
      durationMs: options.durationMs,
    };

    await this.writeLog(entry);
  }

  /**
   * Log token validation step
   */
  async logTokenValidation(options: {
    diagnosticSessionId?: string;
    step: TokenValidationStep;
    tokenType?: string;
    token?: string;
    result: 'pass' | 'fail';
    expected?: unknown;
    actual?: unknown;
    errorMessage?: string;
    details?: Record<string, unknown>;
    requestId?: string;
    flowId?: string;
  }): Promise<void> {
    if (!this.isCategoryEnabled('token-validation')) return;

    // Hash token if provided (used for legacy validation logs)
    let tokenHash: string | undefined;
    if (options.token && this.storageMode !== 'full') {
      tokenHash = await hashToken(options.token, this.tokenHashPrefixLength);
    }

    const entry: TokenValidationLogEntry = {
      id: crypto.randomUUID(),
      diagnosticSessionId: options.diagnosticSessionId,
      flowId: options.flowId,
      tenantId: this.tenantId,
      clientId: this.clientId,
      category: 'token-validation',
      level: options.result === 'fail' ? 'error' : 'debug',
      timestamp: Date.now(),
      requestId: options.requestId,
      storageMode: this.storageMode,
      step: options.step,
      tokenType: options.tokenType,
      tokenHash,
      result: options.result,
      expected: options.expected,
      actual: options.actual,
      errorMessage: options.errorMessage,
      details: options.details,
    };

    await this.writeLog(entry);
  }

  /**
   * Log authentication decision
   */
  async logAuthDecision(options: {
    diagnosticSessionId?: string;
    decision: 'allow' | 'deny';
    reason: string;
    flow?: string;
    grantType?: string;
    context?: Record<string, unknown>;
    requestId?: string;
    flowId?: string;
  }): Promise<void> {
    if (!this.isCategoryEnabled('auth-decision')) return;

    const entry: AuthDecisionLogEntry = {
      id: crypto.randomUUID(),
      diagnosticSessionId: options.diagnosticSessionId,
      flowId: options.flowId,
      tenantId: this.tenantId,
      clientId: this.clientId,
      category: 'auth-decision',
      level: options.decision === 'deny' ? 'warn' : 'info',
      timestamp: Date.now(),
      requestId: options.requestId,
      storageMode: this.storageMode,
      decision: options.decision,
      reason: options.reason,
      flow: options.flow,
      grantType: options.grantType,
      context: options.context,
    };

    await this.writeLog(entry);
  }

  /**
   * Write log entry (internal)
   */
  private async writeLog(entry: DiagnosticLogEntry): Promise<void> {
    const sanitized = await applyPrivacyModeToEntry(entry, {
      mode: this.storageMode,
      secret: this.hashSecret,
      tokenHashPrefixLength: this.tokenHashPrefixLength,
    });

    // Console output (always enabled)
    this.writeToConsole(sanitized);

    // R2 output (if enabled)
    if (this.r2Adapter) {
      await this.writeToR2(sanitized);
    }
  }

  /**
   * Apply PII filter to log entry
   */
  private applyPIIFilter(entry: DiagnosticLogEntry): void {
    // Redact PII from string fields
    if ('errorMessage' in entry && entry.errorMessage) {
      entry.errorMessage = redactPII(entry.errorMessage);
    }

    if ('reason' in entry && entry.reason) {
      entry.reason = redactPII(entry.reason);
    }

    // Recursively redact metadata
    if (entry.metadata) {
      entry.metadata = this.redactObjectPII(entry.metadata);
    }
  }

  /**
   * Recursively redact PII from object
   */
  private redactObjectPII(obj: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        redacted[key] = redactPII(value);
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        redacted[key] = this.redactObjectPII(value as Record<string, unknown>);
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
  }

  /**
   * Write to console
   */
  private writeToConsole(entry: DiagnosticLogEntry): void {
    const format = this.settings['diagnostic-logging.output_format'];
    const minLevel = this.settings['diagnostic-logging.log_level'];

    // Check log level
    if (!this.shouldLog(entry.level, minLevel)) {
      return;
    }

    if (format === 'jsonl' || format === 'json') {
      log.info('[DIAGNOSTIC]', { entry: JSON.stringify(entry) });
    } else {
      // Text format
      const message = this.formatTextLog(entry);
      log.info('[DIAGNOSTIC]', { message });
    }
  }

  /**
   * Write to R2 (async)
   */
  private async writeToR2(entry: DiagnosticLogEntry): Promise<void> {
    if (!this.r2Adapter) return;

    const strategy = this.settings['diagnostic-logging.buffer_strategy'];

    if (strategy === 'realtime') {
      // Write immediately
      const promise = this.r2Adapter.writeLog(entry);
      if (this.ctx) {
        this.ctx.waitUntil(promise);
      } else {
        await promise;
      }
    } else if (strategy === 'batch') {
      // Add to buffer
      this.buffer.push(entry);
      const batchSize = this.settings['diagnostic-logging.batch_size'];

      if (this.buffer.length >= batchSize) {
        await this.flushBuffer();
      } else {
        // Schedule flush
        this.scheduleFlush();
      }
    } else if (strategy === 'queue') {
      // Send to Queue (future implementation)
      // For now, fallback to batch
      this.buffer.push(entry);
      if (this.buffer.length >= this.settings['diagnostic-logging.batch_size']) {
        await this.flushBuffer();
      }
    }
  }

  /**
   * Schedule buffer flush
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return;

    const interval = this.settings['diagnostic-logging.batch_interval_ms'];
    this.flushTimer = setTimeout(() => {
      this.flushBuffer();
      this.flushTimer = undefined;
    }, interval);
  }

  /**
   * Flush buffer to R2
   */
  private async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0 || !this.r2Adapter) return;

    const entries = [...this.buffer];
    this.buffer = [];

    const promise = this.r2Adapter.writeLogBatch(entries);
    if (this.ctx) {
      this.ctx.waitUntil(promise);
    } else {
      await promise;
    }
  }

  /**
   * Check if log level should be logged
   */
  private shouldLog(entryLevel: DiagnosticLogLevel, minLevel: DiagnosticLogLevel): boolean {
    const levels: DiagnosticLogLevel[] = ['debug', 'info', 'warn', 'error'];
    const entryIndex = levels.indexOf(entryLevel);
    const minIndex = levels.indexOf(minLevel);
    return entryIndex >= minIndex;
  }

  /**
   * Format log entry as text
   */
  private formatTextLog(entry: DiagnosticLogEntry): string {
    const timestamp = new Date(entry.timestamp).toISOString();
    return `[${timestamp}] [${entry.level.toUpperCase()}] [${entry.category}] ${JSON.stringify(entry)}`;
  }

  /**
   * Cleanup (flush remaining buffer)
   */
  async cleanup(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    await this.flushBuffer();
  }
}

/**
 * Create a diagnostic logger instance
 */
export function createDiagnosticLogger(config: DiagnosticLoggerConfig): DiagnosticLogger | null {
  // Only create if enabled
  if (!config.settings['diagnostic-logging.enabled']) {
    return null;
  }

  return new DiagnosticLogger(config);
}
