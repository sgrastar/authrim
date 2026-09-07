/**
 * Idempotency Middleware
 *
 * Provides idempotency support for sensitive operations to prevent
 * duplicate requests from retry logic or network issues.
 *
 * Features:
 * - Checks Idempotency-Key header
 * - Stores request/response pairs with SHA-256 body hash
 * - Returns cached response for duplicate requests
 * - Rejects conflicting body with same key (409 Conflict)
 * - PII sanitization in cached responses
 * - Configurable TTL (default 24 hours)
 *
 * Usage:
 * ```typescript
 * app.use('/api/admin/users/:id/suspend', idempotencyMiddleware({
 *   adapter: createAdapter(c),
 *   tenantId,
 *   actorId,
 * }));
 * ```
 */

import type { Context, MiddlewareHandler, Next } from 'hono';
import { createAuthContextFromHono } from '../context/hono-context';
import type { Env } from '../types/env';
import type { DatabaseAdapter } from '../db/adapter';
import { createLogger } from '../utils/logger';
import { createPhase1ErrorDetails } from '../errors/details';
import { readRequestBytesWithLimit } from '../utils/body-limits';
import { readResponseTextWithLimit } from '../utils/url-security';

const log = createLogger().module('IDEMPOTENCY');
const IDEMPOTENCY_REQUEST_BODY_MAX_BYTES = 1024 * 1024;
const IDEMPOTENCY_RESPONSE_BODY_MAX_BYTES = 1024 * 1024;

/**
 * Idempotency key entry stored in database
 */
interface IdempotencyKeyEntry {
  id: string;
  tenant_id: string;
  actor_id: string;
  method: string;
  path: string;
  resource_id: string | null;
  idempotency_key: string;
  body_hash: string;
  response_status: number;
  response_body: string;
  created_at: number;
  expires_at: number;
}

/**
 * Idempotency middleware configuration
 */
export interface IdempotencyConfig {
  /** Time-to-live for idempotency keys in seconds (default: 24 hours) */
  ttlSeconds?: number;
  /** Fields to redact from cached responses (PII protection) */
  redactFields?: string[];
  /** Whether Idempotency-Key is required instead of best-effort */
  required?: boolean;
  /** Reject before mutation when idempotency storage cannot be read. */
  failClosedOnStorageError?: boolean;
  /** Atomically reserve a key before invoking the mutation handler. */
  reserveBeforeExecution?: boolean;
}

/**
 * Default fields to redact from cached responses
 */
const DEFAULT_REDACT_FIELDS = [
  'email',
  'phone',
  'name',
  'reason_detail',
  'client_secret',
  'password',
  'secret',
];

/**
 * Default TTL: 24 hours
 */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function isUniqueConstraintError(error: unknown): boolean {
  return String(error).includes('UNIQUE constraint');
}

function returnStoredResponse(
  c: Context<{ Bindings: Env }>,
  entry: Pick<IdempotencyKeyEntry, 'response_body' | 'response_status'>
): Response {
  const status = entry.response_status as 200 | 201 | 202 | 400 | 404 | 409 | 425 | 500 | 503;
  try {
    return c.json(JSON.parse(entry.response_body), status);
  } catch {
    return c.text(entry.response_body, status);
  }
}

/**
 * Generate SHA-256 hash of request body
 */
async function hashBody(body: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', body);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sanitize response body to remove PII fields
 */
function sanitizeResponse(response: unknown, redactFields: string[]): unknown {
  return JSON.parse(
    JSON.stringify(response, (key, value) => {
      if (redactFields.includes(key)) {
        return '[REDACTED]';
      }
      return value;
    })
  );
}

/**
 * Generate composite key ID for idempotency lookup
 * Format: tenant_id:actor_id:method:path_pattern:resource_id:key
 */
function generateKeyId(
  tenantId: string,
  actorId: string,
  method: string,
  path: string,
  resourceId: string | null,
  idempotencyKey: string
): string {
  const parts = [tenantId, actorId, method, path, resourceId ?? '', idempotencyKey];
  return parts.join(':');
}

/**
 * Get admin actor ID from context
 */
function getActorId(c: Context<{ Bindings: Env }>): string {
  // Try to get from adminAuth context (set by admin-auth middleware)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const adminAuth = (c as any).get('adminAuth') as { userId?: string; adminId?: string } | null;
    return adminAuth?.adminId ?? adminAuth?.userId ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Get tenant ID from context
 */
function getTenantId(c: Context<{ Bindings: Env }>): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const tenantId = ((c as any).get('tenantId') as string | null | undefined)?.trim();
    if (tenantId) {
      return tenantId;
    }
  } catch {
    // Fall through to the fail-closed error below.
  }
  throw new Error('Idempotency middleware requires tenant context');
}

/**
 * Extract resource ID from URL path
 * Examples:
 * - /api/admin/users/123/suspend -> 123
 * - /api/admin/clients/abc/regenerate-secret -> abc
 */
function extractResourceId(path: string): string | null {
  // Match patterns like /users/:id/action or /clients/:id/action
  const match = path.match(/\/(?:users|clients)\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * Create idempotency middleware
 *
 * This middleware intercepts requests with Idempotency-Key header
 * and ensures duplicate requests return the same response.
 *
 * @param config - Optional configuration
 * @returns Hono middleware handler
 */
export function idempotencyMiddleware(
  config?: IdempotencyConfig
): MiddlewareHandler<{ Bindings: Env }> {
  const ttlSeconds = config?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const redactFields = config?.redactFields ?? DEFAULT_REDACT_FIELDS;

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    let handlerStarted = false;
    let handlerThrew = false;
    // Check for Idempotency-Key header
    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey) {
      if (config?.required) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Idempotency-Key header is required',
          },
          400
        );
      }
      // No idempotency key, proceed normally
      return next();
    }

    // Validate key format (should be UUID-like or similar)
    if (idempotencyKey.length > 128 || idempotencyKey.length < 8) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Idempotency-Key must be between 8 and 128 characters',
        },
        400
      );
    }

    let tenantId: string;
    try {
      tenantId = getTenantId(c);
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Tenant context is required for idempotent requests',
        },
        400
      );
    }

    const actorId = getActorId(c);
    const method = c.req.method;
    const path = c.req.path;
    const resourceId = extractResourceId(path);
    // Scope idempotency to the exact target path. Normalizing UUID/numeric segments can alias
    // unrelated resources on routes not covered by extractResourceId (for example step-up
    // actions and credential offers), allowing one resource's response to replay for another.
    const normalizedPath = path;

    let bodyBytes: ArrayBuffer;
    try {
      bodyBytes = await readRequestBytesWithLimit(c.req.raw, IDEMPOTENCY_REQUEST_BODY_MAX_BYTES);
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Request body exceeds idempotency size limit',
        },
        413
      );
    }
    const bodyHash = await hashBody(bodyBytes);

    // Generate composite key ID
    const keyId = generateKeyId(
      tenantId,
      actorId,
      method,
      normalizedPath,
      resourceId,
      idempotencyKey
    );

    // Create database adapter
    const adapter: DatabaseAdapter = createAuthContextFromHono(
      c as Context<{ Bindings: Env }>,
      tenantId
    ).coreAdapter;

    try {
      // Check for existing idempotency key
      const existingEntry = await adapter.queryOne<IdempotencyKeyEntry>(
        'SELECT * FROM idempotency_keys WHERE id = ? AND expires_at > ?',
        [keyId, Math.floor(Date.now() / 1000)]
      );

      if (existingEntry) {
        // Key exists, check body hash
        if (existingEntry.body_hash !== bodyHash) {
          // Different body with same key - conflict
          log.warn('Idempotency key conflict', {
            keyId,
            existingHash: existingEntry.body_hash.substring(0, 8),
            newHash: bodyHash.substring(0, 8),
          });
          return c.json(
            {
              error: 'idempotency_conflict',
              error_description: 'Idempotency-Key already used with different request body',
              error_details: createPhase1ErrorDetails('idempotency_conflict'),
            },
            409
          );
        }

        // Same body, return cached response
        log.debug('Returning cached idempotent response', { keyId });

        if (existingEntry.response_status === 425) c.header('Retry-After', '2');
        return returnStoredResponse(c, existingEntry);
      }

      const reservationTimestamp = Math.floor(Date.now() / 1000);
      const reservationExpiresAt = reservationTimestamp + ttlSeconds;
      if (config?.reserveBeforeExecution) {
        try {
          await adapter.execute(
            `INSERT INTO idempotency_keys
             (id, tenant_id, actor_id, method, path, resource_id, idempotency_key, body_hash, response_status, response_body, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              keyId,
              tenantId,
              actorId,
              method,
              normalizedPath,
              resourceId,
              idempotencyKey,
              bodyHash,
              425,
              JSON.stringify({
                error: 'idempotency_in_progress',
                error_description: 'A request with this Idempotency-Key is still in progress',
              }),
              reservationTimestamp,
              reservationExpiresAt,
            ]
          );
        } catch (error) {
          if (!isUniqueConstraintError(error)) throw error;
          const winner = await adapter.queryOne<IdempotencyKeyEntry>(
            'SELECT * FROM idempotency_keys WHERE id = ? AND expires_at > ?',
            [keyId, reservationTimestamp]
          );
          if (!winner) throw error;
          if (winner.body_hash !== bodyHash) {
            return c.json(
              {
                error: 'idempotency_conflict',
                error_description: 'Idempotency-Key already used with different request body',
                error_details: createPhase1ErrorDetails('idempotency_conflict'),
              },
              409
            );
          }
          if (winner.response_status === 425) c.header('Retry-After', '2');
          return returnStoredResponse(c, winner);
        }
      }

      // No existing entry, proceed with request
      // Restore the body for the handler (since we already read it)
      // Create a new request with the body
      const originalRequest = c.req.raw;
      const newRequest =
        originalRequest.method === 'GET' || originalRequest.method === 'HEAD'
          ? new Request(originalRequest)
          : new Request(originalRequest, { body: bodyBytes });
      // Replace the request in context
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c.req as any).raw = newRequest;

      // Execute the handler
      handlerStarted = true;
      try {
        await next();
      } catch (error) {
        handlerThrew = true;
        throw error;
      }

      // After handler execution, capture and store the response
      const response = c.res;

      // Clone the response to read the body
      const clonedResponse = response.clone();
      const responseBody = await readResponseTextWithLimit(
        clonedResponse,
        IDEMPOTENCY_RESPONSE_BODY_MAX_BYTES
      );
      const responseStatus = clonedResponse.status;

      // Sanitize response to remove PII
      let sanitizedBody: string;
      try {
        const parsed = JSON.parse(responseBody);
        const sanitized = sanitizeResponse(parsed, redactFields);
        sanitizedBody = JSON.stringify(sanitized);
      } catch {
        sanitizedBody = responseBody;
      }

      const nowTs = Math.floor(Date.now() / 1000);
      const expiresAt = nowTs + ttlSeconds;

      // Store the idempotency key and response. A concurrent request may have
      // inserted the key after the initial SELECT, so handle UNIQUE races
      // explicitly instead of relying on dialect-specific upsert syntax.
      const updateResult = await adapter.execute(
        config?.reserveBeforeExecution
          ? `UPDATE idempotency_keys
             SET response_status = ?, response_body = ?, expires_at = ?
             WHERE id = ? AND body_hash = ? AND response_status = 425`
          : `UPDATE idempotency_keys
             SET response_status = ?, response_body = ?, expires_at = ?
             WHERE id = ?`,
        config?.reserveBeforeExecution
          ? [responseStatus, sanitizedBody, expiresAt, keyId, bodyHash]
          : [responseStatus, sanitizedBody, expiresAt, keyId]
      );

      if (updateResult.rowsAffected === 0) {
        if (config?.reserveBeforeExecution) {
          throw new Error('Idempotency reservation was lost before response storage');
        }
        try {
          await adapter.execute(
            `INSERT INTO idempotency_keys
             (id, tenant_id, actor_id, method, path, resource_id, idempotency_key, body_hash, response_status, response_body, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              keyId,
              tenantId,
              actorId,
              method,
              normalizedPath,
              resourceId,
              idempotencyKey,
              bodyHash,
              responseStatus,
              sanitizedBody,
              nowTs,
              expiresAt,
            ]
          );
        } catch (error) {
          if (!isUniqueConstraintError(error)) {
            throw error;
          }
          const winner = await adapter.queryOne<IdempotencyKeyEntry>(
            'SELECT * FROM idempotency_keys WHERE id = ? AND expires_at > ?',
            [keyId, nowTs]
          );
          if (!winner || winner.body_hash !== bodyHash) throw error;
          return returnStoredResponse(c, winner);
        }
      }

      log.debug('Stored idempotency key', { keyId, status: responseStatus, expiresAt });
    } catch (error) {
      log.error('Idempotency middleware error', { error, keyId });
      if (handlerThrew) throw error;
      if (config?.failClosedOnStorageError && !handlerStarted) {
        c.header('Cache-Control', 'no-store');
        c.header('Pragma', 'no-cache');
        return c.json(
          {
            error: 'temporarily_unavailable',
            error_description: 'Idempotency storage is temporarily unavailable',
          },
          503
        );
      }
      // Best-effort mode preserves legacy behavior. If the handler already ran, keep its response
      // because returning a retryable error could cause a duplicate mutation.
      if (!handlerStarted) {
        handlerStarted = true;
        await next();
      }
    }
  };
}

export function requiredIdempotencyMiddleware(
  config?: Omit<IdempotencyConfig, 'required'>
): MiddlewareHandler<{ Bindings: Env }> {
  return idempotencyMiddleware({
    ...config,
    required: true,
  });
}

/**
 * Cleanup expired idempotency keys
 * Should be called periodically by a scheduled worker
 */
export async function cleanupExpiredIdempotencyKeys(adapter: DatabaseAdapter): Promise<number> {
  const nowTs = Math.floor(Date.now() / 1000);
  const result = await adapter.execute('DELETE FROM idempotency_keys WHERE expires_at < ?', [
    nowTs,
  ]);
  return result.rowsAffected;
}
