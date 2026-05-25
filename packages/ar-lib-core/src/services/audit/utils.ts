/**
 * Audit Log Utilities
 *
 * This module provides utility functions for the audit logging system:
 * - Base64 encoding/decoding with chunking (avoids RangeError on large data)
 * - Secret field sanitization (normalizeKey + exact-match blacklist)
 * - Details auto-evacuation (2KB/4KB limits with R2 fallback)
 * - Error message sanitization with length truncation
 */

import type { EventDetails, TenantPIIConfig } from './types';
import { createLogger } from '../../utils/logger';
import { readR2ObjectTextWithLimit } from '../../utils/body-limits';
import type { TenantKeyResolver } from './tenant-key';
import type { DatabaseAdapter } from '../../db';
import {
  loadChunkedSensitiveDetailJson,
  storeImmediateChunkedSensitiveDetailJson,
  type SensitiveDetailChunkReadEnv,
} from '../sensitive-detail-chunk-store';

const log = createLogger().module('Audit');

// =============================================================================
// Constants
// =============================================================================

/** Maximum inline size for event details (bytes) */
export const DETAILS_INLINE_LIMIT_BYTES = 2048; // 2KB

/** Maximum inline size for PII values (bytes) */
export const PII_VALUES_INLINE_LIMIT_BYTES = 4096; // 4KB

/** Maximum error message length (chars) */
export const ERROR_MESSAGE_MAX_LENGTH = 1024;

/** Chunk size for Base64 encoding (32KB) */
const BASE64_CHUNK_SIZE = 0x8000;

/** Maximum R2 object size accepted for evacuated event details. */
const DETAILS_R2_READ_LIMIT_BYTES = 256 * 1024;

/** Maximum R2 object size accepted for evacuated encrypted PII values. */
const PII_VALUES_R2_READ_LIMIT_BYTES = 1024 * 1024;

const SENSITIVE_DETAIL_CATALOG_REF_PREFIX = 'sensitive-detail-catalog:';

export interface SensitiveDetailChunkWriteContext {
  adapter: DatabaseAdapter;
  bucket: R2Bucket;
  rootKeyHex: string;
  keyVersion?: number;
  createdAt?: number;
  tenantKeySalt?: string;
  tenantKeyResolver?: TenantKeyResolver;
}

export interface SensitiveDetailChunkReadContext {
  adapter: DatabaseAdapter;
  env: SensitiveDetailChunkReadEnv;
}

export function encodeSensitiveDetailCatalogRef(catalogId: string): string {
  return `${SENSITIVE_DETAIL_CATALOG_REF_PREFIX}${catalogId}`;
}

function decodeSensitiveDetailCatalogRef(value: string | null | undefined): string | null {
  if (!value?.startsWith(SENSITIVE_DETAIL_CATALOG_REF_PREFIX)) {
    return null;
  }
  const catalogId = value.slice(SENSITIVE_DETAIL_CATALOG_REF_PREFIX.length).trim();
  return catalogId || null;
}

// =============================================================================
// Base64 Utilities (Chunking for Large Data)
// =============================================================================

/**
 * Convert ArrayBuffer to Base64 using chunked approach.
 * Avoids RangeError when using spread operator on large arrays.
 *
 * @param buffer - ArrayBuffer to encode
 * @returns Base64-encoded string
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let result = '';

  // Process in 32KB chunks to avoid call stack overflow
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
    // Use apply instead of spread to handle chunks safely
    result += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }

  return btoa(result);
}

/**
 * Convert Base64 string to ArrayBuffer.
 *
 * @param base64 - Base64-encoded string
 * @returns Decoded ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);

  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes.buffer;
}

// =============================================================================
// Key Normalization for Blacklist Matching
// =============================================================================

/**
 * Normalize a key for blacklist matching.
 * Handles variations: access_token, access-token, accessToken, ACCESS_TOKEN
 *
 * @param key - Field key to normalize
 * @returns Normalized key (lowercase, no hyphens/underscores)
 */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/**
 * Secret field blacklist (normalized strings only).
 * Uses exact-match only - never use includes() to avoid false positives (e.g., "secretary").
 */
export const SECRET_FIELD_NORMALIZED_BLACKLIST = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'xapikey',
  'apikey',
  'idtoken',
  'accesstoken',
  'refreshtoken',
  'code',
  'clientsecret',
  'password',
  'passwd',
  'bearer',
  'token',
  'jwt',
  'sessionid',
  'privatekey',
  'secretkey',
  'apitoken',
  'authcode',
  'authorizationcode',
]);

// =============================================================================
// Event Details Sanitization
// =============================================================================

/**
 * Sanitize event details by removing PII and secret fields.
 *
 * Rules:
 * 1. Remove fields marked as PII in tenant config
 * 2. Remove fields matching SECRET_FIELD_NORMALIZED_BLACKLIST (exact match, normalized)
 * 3. Remove query strings from request_path
 *
 * @param details - Raw event details
 * @param tenantPiiConfig - Tenant PII configuration
 * @returns Sanitized details
 */
export function sanitizeEventDetails(
  details: Record<string, unknown>,
  tenantPiiConfig: TenantPIIConfig
): Record<string, unknown> {
  // Get list of PII fields from config
  const piiFields = Object.entries(tenantPiiConfig.piiFields)
    .filter(([, isPii]) => isPii)
    .map(([field]) => field);

  const sanitized = { ...details };

  // 1. Remove PII fields
  for (const field of piiFields) {
    delete sanitized[field];
  }

  // 2. Remove secret fields (normalized exact-match)
  for (const key of Object.keys(sanitized)) {
    if (SECRET_FIELD_NORMALIZED_BLACKLIST.has(normalizeKey(key))) {
      delete sanitized[key];
    }
  }

  // 3. Remove query string from request_path
  if (typeof sanitized.requestPath === 'string') {
    sanitized.requestPath = sanitized.requestPath.split('?')[0];
  }
  // Also handle snake_case version
  if (typeof sanitized.request_path === 'string') {
    sanitized.request_path = sanitized.request_path.split('?')[0];
  }

  return sanitized;
}

// =============================================================================
// Details Auto-Evacuation (2KB Limit)
// =============================================================================

/**
 * Result of writing event details.
 */
export interface EventDetailsResult {
  /** Inline JSON if <= 2KB */
  detailsJson: string | null;
  /** R2 key if > 2KB */
  detailsR2Key: string | null;
}

/**
 * Write event details with automatic R2 evacuation if > 2KB.
 *
 * IMPORTANT: Uses byte length, not character length (for Unicode safety).
 *
 * @param details - Event details to write
 * @param r2Bucket - R2 bucket for large details
 * @param tenantId - Tenant ID used to derive the R2 tenant_key path segment
 * @param entryId - Entry ID for R2 path
 * @param tenantKeySalt - Optional transitional salt for tenant_key derivation
 * @param tenantKeyResolver - Optional tenant registry backed tenant_key resolver
 * @returns Details storage result
 */
export async function writeEventDetails(
  details: Record<string, unknown>,
  _r2Bucket: R2Bucket,
  tenantId: string,
  entryId: string,
  tenantKeySalt?: string,
  tenantKeyResolver?: TenantKeyResolver,
  chunkContext?: SensitiveDetailChunkWriteContext
): Promise<EventDetailsResult> {
  const json = JSON.stringify(details);

  // IMPORTANT: Use byte length, not string length (Unicode safety)
  const byteLength = new TextEncoder().encode(json).length;

  if (byteLength <= DETAILS_INLINE_LIMIT_BYTES) {
    // <= 2KB: Store inline
    return { detailsJson: json, detailsR2Key: null };
  }

  if (chunkContext) {
    const result = await storeImmediateChunkedSensitiveDetailJson({
      adapter: chunkContext.adapter,
      bucket: chunkContext.bucket,
      rootKeyHex: chunkContext.rootKeyHex,
      tenantId,
      objectClass: 'event_log_detail',
      payload: details,
      contentType: 'application/json',
      createdAt: chunkContext.createdAt,
      keyVersion: chunkContext.keyVersion,
      tenantKeySalt: chunkContext.tenantKeySalt ?? tenantKeySalt,
      tenantKeyResolver: chunkContext.tenantKeyResolver ?? tenantKeyResolver,
      surface: 'event',
      logType: 'audit',
      publicArtifactId: `evt_${entryId.replace(/[^A-Za-z0-9_-]/g, '')}`,
    });

    return {
      detailsJson: null,
      detailsR2Key: encodeSensitiveDetailCatalogRef(result.catalogId),
    };
  }

  throw new Error('sensitive_detail_chunk_context_required:event_log_detail');
}

/**
 * Read event details from inline JSON or R2.
 *
 * @param detailsJson - Inline JSON (if stored inline)
 * @param detailsR2Key - R2 key (if stored in R2)
 * @param r2Bucket - R2 bucket for retrieval
 * @returns Parsed event details or null if not found
 */
export async function readEventDetails(
  detailsJson: string | null | undefined,
  detailsR2Key: string | null | undefined,
  r2Bucket: R2Bucket,
  chunkContext?: SensitiveDetailChunkReadContext & { tenantId?: string }
): Promise<EventDetails | null> {
  // Inline details
  if (detailsJson) {
    try {
      return JSON.parse(detailsJson) as EventDetails;
    } catch {
      return null;
    }
  }

  const catalogId = decodeSensitiveDetailCatalogRef(detailsR2Key);
  if (catalogId) {
    if (!chunkContext?.tenantId) {
      return null;
    }
    return loadChunkedSensitiveDetailJson<EventDetails>(chunkContext.adapter, chunkContext.env, {
      tenantId: chunkContext.tenantId,
      objectCatalogId: catalogId,
      expectedClass: 'event_log_detail',
    });
  }

  // R2 details
  if (detailsR2Key) {
    const r2Object = await r2Bucket.get(detailsR2Key);
    if (!r2Object) {
      return null;
    }
    const text = await readR2ObjectTextWithLimit(r2Object, DETAILS_R2_READ_LIMIT_BYTES);
    try {
      return JSON.parse(text) as EventDetails;
    } catch {
      return null;
    }
  }

  return null;
}

// =============================================================================
// PII Values Auto-Evacuation (4KB Limit)
// =============================================================================

/**
 * Result of writing PII values.
 */
export interface PIIValuesResult {
  /** Inline encrypted JSON if <= 4KB */
  valuesEncrypted: string | null;
  /** R2 key if > 4KB */
  valuesR2Key: string | null;
}

/**
 * Write encrypted PII values with automatic R2 evacuation if > 4KB.
 *
 * @param encryptedJson - JSON string of encrypted values
 * @param r2Bucket - R2 bucket for large values
 * @param tenantId - Tenant ID used to derive the R2 tenant_key path segment
 * @param entryId - Entry ID for R2 path
 * @param tenantKeySalt - Optional transitional salt for tenant_key derivation
 * @param tenantKeyResolver - Optional tenant registry backed tenant_key resolver
 * @returns PII values storage result
 */
export async function writePIIValues(
  encryptedJson: string,
  _r2Bucket: R2Bucket,
  tenantId: string,
  entryId: string,
  tenantKeySalt?: string,
  tenantKeyResolver?: TenantKeyResolver,
  chunkContext?: SensitiveDetailChunkWriteContext
): Promise<PIIValuesResult> {
  // IMPORTANT: Use byte length, not string length (Unicode safety)
  const byteLength = new TextEncoder().encode(encryptedJson).length;

  if (byteLength <= PII_VALUES_INLINE_LIMIT_BYTES) {
    // <= 4KB: Store inline
    return { valuesEncrypted: encryptedJson, valuesR2Key: null };
  }

  if (chunkContext) {
    const result = await storeImmediateChunkedSensitiveDetailJson({
      adapter: chunkContext.adapter,
      bucket: chunkContext.bucket,
      rootKeyHex: chunkContext.rootKeyHex,
      tenantId,
      objectClass: 'pii_log_values',
      payload: JSON.parse(encryptedJson) as unknown,
      contentType: 'application/json',
      createdAt: chunkContext.createdAt,
      keyVersion: chunkContext.keyVersion,
      tenantKeySalt: chunkContext.tenantKeySalt ?? tenantKeySalt,
      tenantKeyResolver: chunkContext.tenantKeyResolver ?? tenantKeyResolver,
      surface: 'pii',
      logType: 'pii',
      publicArtifactId: `pii_${entryId.replace(/[^A-Za-z0-9_-]/g, '')}`,
    });

    return {
      valuesEncrypted: null,
      valuesR2Key: encodeSensitiveDetailCatalogRef(result.catalogId),
    };
  }

  throw new Error('sensitive_detail_chunk_context_required:pii_log_values');
}

// =============================================================================
// Error Message Sanitization
// =============================================================================

/**
 * Sanitize error message by removing secrets and truncating.
 *
 * Removes:
 * - Bearer tokens
 * - JWTs
 * - Password values
 * - Secret values
 * - Token values
 *
 * Also truncates to ERROR_MESSAGE_MAX_LENGTH chars.
 *
 * @param message - Raw error message
 * @returns Sanitized error message
 */
export function sanitizeErrorMessage(message: string): string {
  // 1. Remove secrets
  let sanitized = message
    // Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9\-_\.]+/gi, 'Bearer [REDACTED]')
    // JWTs (3-part base64url)
    .replace(/eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/g, '[JWT_REDACTED]')
    // password=value or password: value
    .replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]')
    // secret=value or secret: value
    .replace(/secret[=:]\s*\S+/gi, 'secret=[REDACTED]')
    // token=value or token: value
    .replace(/token[=:]\s*\S+/gi, 'token=[REDACTED]')
    // api_key=value or api-key=value
    .replace(/api[-_]?key[=:]\s*\S+/gi, 'api_key=[REDACTED]')
    // authorization header value
    .replace(/authorization[=:]\s*\S+/gi, 'authorization=[REDACTED]');

  // 2. Truncate to max length
  if (sanitized.length > ERROR_MESSAGE_MAX_LENGTH) {
    sanitized = sanitized.slice(0, ERROR_MESSAGE_MAX_LENGTH) + '... [TRUNCATED]';
  }

  return sanitized;
}

// =============================================================================
// AAD (Additional Authenticated Data) Generation
// =============================================================================

/**
 * Generate AAD for AES-GCM encryption.
 * AAD is regenerated on decryption (not stored in DB).
 *
 * Format: `${tenantId}:${sortedAffectedFields.join(',')}`
 *
 * @param tenantId - Tenant identifier
 * @param affectedFields - List of affected field names
 * @returns AAD as Uint8Array
 */
export function generateAAD(tenantId: string, affectedFields: string[]): Uint8Array {
  // Sort fields for deterministic AAD (prevents order variance issues)
  const sortedFields = [...affectedFields].sort();
  const aadString = `${tenantId}:${sortedFields.join(',')}`;
  return new TextEncoder().encode(aadString);
}

// =============================================================================
// Retention Calculation
// =============================================================================

/**
 * Calculate retention expiry timestamp.
 *
 * @param retentionDays - Retention period in days
 * @param fromDate - Base date (default: now)
 * @returns Expiry timestamp in epoch milliseconds
 */
export function calculateRetentionUntil(
  retentionDays: number,
  fromDate: Date = new Date()
): number {
  const expiryDate = new Date(fromDate);
  expiryDate.setDate(expiryDate.getDate() + retentionDays);
  return expiryDate.getTime();
}

// =============================================================================
// PII Decryption
// =============================================================================

/**
 * Encrypted value structure (stored in DB or R2).
 */
export interface EncryptedValueForDecrypt {
  ciphertext: string; // Base64
  iv: string; // Base64
  keyId: string;
}

/**
 * Key provider function type.
 * In production, this retrieves keys from KeyManager DO or KV.
 *
 * @param keyId - Key identifier
 * @returns CryptoKey for decryption
 */
export type DecryptionKeyProvider = (keyId: string) => Promise<CryptoKey>;

/**
 * Decrypt PII values using AES-256-GCM.
 *
 * AAD is regenerated from tenantId and affectedFields (not stored in DB).
 *
 * @param encrypted - Encrypted value structure
 * @param tenantId - Tenant ID (for AAD regeneration)
 * @param affectedFields - Affected fields (for AAD regeneration)
 * @param keyProvider - Function to retrieve decryption key
 * @returns Decrypted values
 */
export async function decryptPIIValues(
  encrypted: EncryptedValueForDecrypt,
  tenantId: string,
  affectedFields: string[],
  keyProvider: DecryptionKeyProvider
): Promise<Record<string, unknown>> {
  // Get the decryption key
  const key = await keyProvider(encrypted.keyId);

  // Regenerate AAD (must match encryption AAD exactly)
  const aad = generateAAD(tenantId, affectedFields);

  // Decode Base64 values
  const ciphertext = base64ToArrayBuffer(encrypted.ciphertext);
  const iv = new Uint8Array(base64ToArrayBuffer(encrypted.iv));

  // Decrypt
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aad,
    },
    key,
    ciphertext
  );

  // Parse JSON
  const decoded = new TextDecoder().decode(plaintext);
  return JSON.parse(decoded) as Record<string, unknown>;
}

/**
 * Read and decrypt PII values from inline storage or R2.
 *
 * @param valuesEncrypted - Inline encrypted JSON (if stored inline)
 * @param valuesR2Key - R2 key (if stored in R2)
 * @param r2Bucket - R2 bucket for retrieval
 * @param tenantId - Tenant ID (for AAD regeneration)
 * @param affectedFields - Affected fields (for AAD regeneration)
 * @param keyProvider - Function to retrieve decryption key
 * @returns Decrypted PII values or null if not found
 */
export async function readAndDecryptPIIValues(
  valuesEncrypted: string | null | undefined,
  valuesR2Key: string | null | undefined,
  r2Bucket: R2Bucket,
  tenantId: string,
  affectedFields: string[],
  keyProvider: DecryptionKeyProvider,
  chunkContext?: SensitiveDetailChunkReadContext
): Promise<Record<string, unknown> | null> {
  let encryptedJson: string | null = null;

  // Get encrypted JSON from inline or R2
  if (valuesEncrypted) {
    encryptedJson = valuesEncrypted;
  } else {
    const catalogId = decodeSensitiveDetailCatalogRef(valuesR2Key);
    if (catalogId) {
      const chunkPayload = chunkContext
        ? await loadChunkedSensitiveDetailJson<EncryptedValueForDecrypt>(
            chunkContext.adapter,
            chunkContext.env,
            {
              tenantId,
              objectCatalogId: catalogId,
              expectedClass: 'pii_log_values',
            }
          )
        : null;
      encryptedJson = chunkPayload ? JSON.stringify(chunkPayload) : null;
    } else if (valuesR2Key) {
      const r2Object = await r2Bucket.get(valuesR2Key);
      if (!r2Object) {
        return null;
      }
      encryptedJson = await readR2ObjectTextWithLimit(r2Object, PII_VALUES_R2_READ_LIMIT_BYTES);
    }
  }

  if (!encryptedJson) {
    return null;
  }

  // Parse encrypted structure
  let encrypted: EncryptedValueForDecrypt;
  try {
    encrypted = JSON.parse(encryptedJson) as EncryptedValueForDecrypt;
  } catch {
    return null;
  }

  // Decrypt
  return decryptPIIValues(encrypted, tenantId, affectedFields, keyProvider);
}

// =============================================================================
// Async Audit Logging Helper
// =============================================================================

/**
 * Audit log parameters for async helper.
 */
export interface AsyncAuditLogParams {
  eventType: string;
  eventCategory: string;
  result: 'success' | 'failure' | 'partial';
  severity?: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  errorCode?: string;
  errorMessage?: string;
  anonymizedUserId?: string;
  clientId?: string;
  sessionId?: string;
  requestId?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}

/**
 * Audit service interface for async helper.
 */
export interface IAuditServiceForAsync {
  logEvent(tenantId: string, params: AsyncAuditLogParams): Promise<void>;
}

/**
 * Logger interface for async helper.
 */
export interface ILoggerForAsync {
  warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * Log an audit event asynchronously using ctx.waitUntil().
 *
 * This helper ensures:
 * 1. Main request is not blocked by audit logging
 * 2. Audit logging failures don't affect the main response
 * 3. Failures are logged for alerting
 *
 * @param ctx - Execution context (for waitUntil)
 * @param auditService - Audit service instance
 * @param tenantId - Tenant ID
 * @param params - Event log parameters
 * @param logger - Logger for error reporting (optional)
 *
 * @example
 * ```typescript
 * // In a request handler:
 * const result = await processRequest();
 *
 * // Fire-and-forget audit logging
 * logAuditAsync(c.executionCtx, auditService, tenantId, {
 *   eventType: 'token.issued',
 *   eventCategory: 'token',
 *   result: 'success',
 *   clientId: client.id,
 *   requestId: c.get('requestId'),
 * });
 *
 * return c.json(result);
 * ```
 */
export function logAuditAsync(
  ctx: ExecutionContext,
  auditService: IAuditServiceForAsync,
  tenantId: string,
  params: AsyncAuditLogParams,
  logger?: ILoggerForAsync
): void {
  ctx.waitUntil(
    auditService.logEvent(tenantId, params).catch((error) => {
      // Log failure for alerting (don't throw - this is fire-and-forget)
      const errorMessage = sanitizeErrorMessage(String(error));
      if (logger) {
        logger.warn('audit_write_failed', {
          tenantId,
          eventType: params.eventType,
          requestId: params.requestId,
          error: errorMessage,
        });
      } else {
        // Fallback to structured logger if no custom logger provided
        log.error('audit_write_failed', {
          tenantId,
          eventType: params.eventType,
          error: errorMessage,
        });
      }
    })
  );
}
