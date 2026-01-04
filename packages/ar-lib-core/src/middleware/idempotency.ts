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
import type { Env } from '../types/env';
import type { DatabaseAdapter, ExecuteResult } from '../db/adapter';
import { D1Adapter } from '../db/adapters/d1-adapter';
import { createLogger } from '../utils/logger';

const log = createLogger().module('IDEMPOTENCY');

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

/**
 * Generate SHA-256 hash of request body
 */
async function hashBody(body: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(body);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
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
  // Try to get from tenantId context (set by tenant middleware)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const tenantId = (c as any).get('tenantId') as string | null;
    return tenantId ?? 'default';
  } catch {
    return 'default';
  }
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
 * Normalize path to pattern for consistent matching
 * Replaces UUIDs and IDs with placeholders
 */
function normalizePath(path: string): string {
  // Replace UUIDs
  let normalized = path.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ':id'
  );
  // Replace numeric IDs
  normalized = normalized.replace(/\/\d+\//g, '/:id/');
  return normalized;
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
    // Check for Idempotency-Key header
    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey) {
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

    const tenantId = getTenantId(c);
    const actorId = getActorId(c);
    const method = c.req.method;
    const path = c.req.path;
    const resourceId = extractResourceId(path);
    const normalizedPath = normalizePath(path);

    // Read request body
    const bodyText = await c.req.text();
    const bodyHash = await hashBody(bodyText);

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
    const adapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

    try {
      // Check for existing idempotency key
      const existingEntry = await adapter.queryOne<IdempotencyKeyEntry>(
        `SELECT * FROM idempotency_keys WHERE id = ? AND expires_at > ?`,
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
            },
            409
          );
        }

        // Same body, return cached response
        log.debug('Returning cached idempotent response', { keyId });

        // Parse and return cached response
        try {
          const cachedBody = JSON.parse(existingEntry.response_body);
          return c.json(
            cachedBody,
            existingEntry.response_status as 200 | 201 | 400 | 404 | 409 | 500
          );
        } catch {
          // If parsing fails, return as-is
          return c.text(
            existingEntry.response_body,
            existingEntry.response_status as 200 | 201 | 400 | 404 | 409 | 500
          );
        }
      }

      // No existing entry, proceed with request
      // Restore the body for the handler (since we already read it)
      // Create a new request with the body
      const originalRequest = c.req.raw;
      const newRequest = new Request(originalRequest.url, {
        method: originalRequest.method,
        headers: originalRequest.headers,
        body: bodyText,
      });
      // Replace the request in context
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c.req as any).raw = newRequest;

      // Execute the handler
      await next();

      // After handler execution, capture and store the response
      const response = c.res;

      // Clone the response to read the body
      const clonedResponse = response.clone();
      const responseBody = await clonedResponse.text();
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

      // Store the idempotency key and response
      await adapter.execute(
        `INSERT INTO idempotency_keys
         (id, tenant_id, actor_id, method, path, resource_id, idempotency_key, body_hash, response_status, response_body, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           response_status = excluded.response_status,
           response_body = excluded.response_body,
           expires_at = excluded.expires_at`,
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

      log.debug('Stored idempotency key', { keyId, status: responseStatus, expiresAt });
    } catch (error) {
      // Log error but don't fail the request - idempotency is best-effort
      log.error('Idempotency middleware error', { error, keyId });
      // If we haven't called next yet, do it now
      if (!c.res) {
        await next();
      }
    }
  };
}

/**
 * Cleanup expired idempotency keys
 * Should be called periodically by a scheduled worker
 */
export async function cleanupExpiredIdempotencyKeys(adapter: DatabaseAdapter): Promise<number> {
  const nowTs = Math.floor(Date.now() / 1000);
  const result: ExecuteResult = await adapter.execute(
    `DELETE FROM idempotency_keys WHERE expires_at < ?`,
    [nowTs]
  );
  return result.rowsAffected;
}
