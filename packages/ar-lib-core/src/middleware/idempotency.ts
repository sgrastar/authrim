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
 * - With reservation, keeps "act, then retry" errors (markIdempotentResponseRetryable) out of the
 *   store: the key stays bound to the body and the same body may run again
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
import { isUniqueConstraintError } from '../utils/d1-retry';

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

const RETRYABLE_RESPONSE_CONTEXT_KEY = 'idempotencyResponseRetryable';

/** response_status of a key whose handler is running (reserveBeforeExecution). */
const IN_PROGRESS_STATUS = 425;
/**
 * response_status of a key whose last attempt was marked retryable: the row still binds the body
 * hash but holds no outcome, so the next attempt with the same body may reserve it again.
 * Not an HTTP status, so it never collides with a stored response.
 */
const RETRYABLE_STATUS = 0;
const MAX_RESERVATION_ATTEMPTS = 3;
const IN_PROGRESS_ERROR = {
  error: 'idempotency_in_progress',
  error_description: 'A request with this Idempotency-Key is still in progress',
};
const IN_PROGRESS_BODY = JSON.stringify(IN_PROGRESS_ERROR);
const RETRYABLE_BODY = JSON.stringify({ retryable: true });

/**
 * Marks the current error response as "nothing was done; act, then retry with the same
 * Idempotency-Key" (for example step_up_required, or a step-up receipt that was refused). With
 * reserveBeforeExecution, the middleware then stores no outcome for the key: it keeps the key bound
 * to the request body (a different body is still refused with 409) and releases the reservation,
 * so the next attempt with the same body reserves the key again and reaches the handler. Without
 * reserveBeforeExecution the mark is ignored and the response is stored as usual, because only the
 * reservation keeps two attempts from running the handler at once.
 *
 * Call it only on a path that has performed no side effect. A success (status < 400) is always
 * stored, whether or not it was marked.
 */
export function markIdempotentResponseRetryable(c: Context): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  (c as any).set(RETRYABLE_RESPONSE_CONTEXT_KEY, true);
}

function returnStoredResponse(
  c: Context<{ Bindings: Env }>,
  entry: Pick<IdempotencyKeyEntry, 'response_body' | 'response_status'>
): Response {
  const status = entry.response_status as 200 | 201 | 202 | 400 | 404 | 409 | 425 | 500 | 503;
  // An in-progress row's body names its owner; answer with the plain in-progress error.
  const responseBody =
    entry.response_status === IN_PROGRESS_STATUS ? IN_PROGRESS_BODY : entry.response_body;
  try {
    return c.json(JSON.parse(responseBody), status);
  } catch {
    return c.text(responseBody, status);
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

function isResponseMarkedRetryable(c: Context): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return (c as any).get(RETRYABLE_RESPONSE_CONTEXT_KEY) === true;
}

function idempotencyConflict(c: Context<{ Bindings: Env }>): Response {
  return c.json(
    {
      error: 'idempotency_conflict',
      error_description: 'Idempotency-Key already used with different request body',
      error_details: createPhase1ErrorDetails('idempotency_conflict'),
    },
    409
  );
}

function inProgress(c: Context<{ Bindings: Env }>): Response {
  c.header('Retry-After', '2');
  return returnStoredResponse(c, {
    response_status: IN_PROGRESS_STATUS,
    response_body: IN_PROGRESS_BODY,
  });
}

/**
 * The response_body of an in-progress row. It carries a per-reservation id so that only the
 * request holding the reservation can release or finalize it.
 */
function createReservationBody(): string {
  return JSON.stringify({ ...IN_PROGRESS_ERROR, reservation_id: crypto.randomUUID() });
}

/**
 * Moves a key from one state to another for the same body; false when another request won. Leaving
 * the in-progress state requires the reservation body, so a request whose reservation was replaced
 * cannot touch the new owner's row.
 */
async function transitionReservation(
  adapter: DatabaseAdapter,
  input: {
    keyId: string;
    bodyHash: string;
    to: number;
    responseBody: string;
    expiresAt: number;
  } & ({ from: typeof RETRYABLE_STATUS } | { from: typeof IN_PROGRESS_STATUS; ownerBody: string })
): Promise<boolean> {
  const owned = input.from === IN_PROGRESS_STATUS;
  const result = await adapter.execute(
    `UPDATE idempotency_keys
     SET response_status = ?, response_body = ?, expires_at = ?
     WHERE id = ? AND body_hash = ? AND response_status = ${input.from}${
       owned ? ' AND response_body = ?' : ''
     }`,
    [
      input.to,
      input.responseBody,
      input.expiresAt,
      input.keyId,
      input.bodyHash,
      ...(input.from === IN_PROGRESS_STATUS ? [input.ownerBody] : []),
    ]
  );
  return result.rowsAffected === 1;
}

interface ReservationRow {
  keyId: string;
  tenantId: string;
  actorId: string;
  method: string;
  path: string;
  resourceId: string | null;
  idempotencyKey: string;
  bodyHash: string;
}

/**
 * Atomically takes ownership of the key before the handler runs: inserts a new in-progress row, or
 * re-reserves a row left retryable by an earlier attempt with the same body. Returns the response
 * to send instead of running the handler, or the reservation body when this request owns the key.
 * Never lets the handler run without a reservation: a key that keeps changing hands answers 425.
 */
async function reserveKey(input: {
  c: Context<{ Bindings: Env }>;
  adapter: DatabaseAdapter;
  entry: IdempotencyKeyEntry | null;
  row: ReservationRow;
  ttlSeconds: number;
}): Promise<{ response: Response } | { ownerBody: string }> {
  const { c, adapter, row } = input;
  const ownerBody = createReservationBody();
  let entry = input.entry;
  for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt += 1) {
    const now = Math.floor(Date.now() / 1000);
    if (entry && entry.body_hash !== row.bodyHash) return { response: idempotencyConflict(c) };
    if (entry && entry.response_status !== RETRYABLE_STATUS) {
      if (entry.response_status === IN_PROGRESS_STATUS) c.header('Retry-After', '2');
      return { response: returnStoredResponse(c, entry) };
    }
    if (entry) {
      const reserved = await transitionReservation(adapter, {
        keyId: row.keyId,
        bodyHash: row.bodyHash,
        from: RETRYABLE_STATUS,
        to: IN_PROGRESS_STATUS,
        responseBody: ownerBody,
        expiresAt: now + input.ttlSeconds,
      });
      if (reserved) return { ownerBody };
    } else {
      try {
        await adapter.execute(
          `INSERT INTO idempotency_keys
           (id, tenant_id, actor_id, method, path, resource_id, idempotency_key, body_hash, response_status, response_body, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.keyId,
            row.tenantId,
            row.actorId,
            row.method,
            row.path,
            row.resourceId,
            row.idempotencyKey,
            row.bodyHash,
            IN_PROGRESS_STATUS,
            ownerBody,
            now,
            now + input.ttlSeconds,
          ]
        );
        return { ownerBody };
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
      }
    }
    entry = await adapter.queryOne<IdempotencyKeyEntry>(
      'SELECT * FROM idempotency_keys WHERE id = ? AND expires_at > ?',
      [row.keyId, now]
    );
    if (!entry) {
      // The conflicting row has expired but not been swept yet: an expired outcome no longer binds
      // the key. An expired reservation is left alone: its handler may still be running.
      await adapter.execute(
        `DELETE FROM idempotency_keys
         WHERE id = ? AND expires_at <= ? AND response_status <> ${IN_PROGRESS_STATUS}`,
        [row.keyId, now]
      );
    }
  }
  return { response: inProgress(c) };
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
          return idempotencyConflict(c);
        }

        if (existingEntry.response_status !== RETRYABLE_STATUS) {
          // Same body, return cached response
          log.debug('Returning cached idempotent response', { keyId });

          if (existingEntry.response_status === IN_PROGRESS_STATUS) c.header('Retry-After', '2');
          return returnStoredResponse(c, existingEntry);
        }
      }

      let ownerBody: string | undefined;
      if (config?.reserveBeforeExecution) {
        const reservation = await reserveKey({
          c,
          adapter,
          entry: existingEntry,
          row: {
            keyId,
            tenantId,
            actorId,
            method,
            path: normalizedPath,
            resourceId,
            idempotencyKey,
            bodyHash,
          },
          ttlSeconds,
        });
        if ('response' in reservation) return reservation.response;
        ownerBody = reservation.ownerBody;
      }

      // No stored outcome (no entry, or one left retryable), proceed with request
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

      // An "act, then retry" error is not the outcome of the request: storing it would replay it
      // to the retry that carries what the handler asked for. Keep the body binding, drop the
      // reservation, and let the next attempt with the same body reserve the key again.
      if (ownerBody !== undefined && response.status >= 400 && isResponseMarkedRetryable(c)) {
        const released = await transitionReservation(adapter, {
          keyId,
          bodyHash,
          from: IN_PROGRESS_STATUS,
          ownerBody,
          to: RETRYABLE_STATUS,
          responseBody: RETRYABLE_BODY,
          expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
        });
        if (!released) {
          throw new Error('Idempotency reservation was lost before release');
        }
        log.debug('Released idempotency key after retryable response', {
          keyId,
          status: response.status,
        });
        return;
      }

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
      const stored =
        ownerBody !== undefined
          ? await transitionReservation(adapter, {
              keyId,
              bodyHash,
              from: IN_PROGRESS_STATUS,
              ownerBody,
              to: responseStatus,
              responseBody: sanitizedBody,
              expiresAt,
            })
          : (
              await adapter.execute(
                `UPDATE idempotency_keys
                 SET response_status = ?, response_body = ?, expires_at = ?
                 WHERE id = ?`,
                [responseStatus, sanitizedBody, expiresAt, keyId]
              )
            ).rowsAffected > 0;

      if (!stored) {
        if (ownerBody !== undefined) {
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
          if (
            !winner ||
            winner.body_hash !== bodyHash ||
            winner.response_status === RETRYABLE_STATUS
          ) {
            throw error;
          }
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
 * How long cleanup keeps an expired in-progress reservation. Its handler may still be running, and
 * deleting the row would let another attempt with the same key run the handler as well. A
 * reservation abandoned by a crashed request blocks its key (425) for this long.
 */
export const IDEMPOTENCY_RESERVATION_RETENTION_SECONDS = 24 * 60 * 60;

/**
 * WHERE clause (after `tenant_id = ? AND`, if any) selecting the rows cleanup may delete; bind
 * [now, now - IDEMPOTENCY_RESERVATION_RETENTION_SECONDS].
 */
export const EXPIRED_IDEMPOTENCY_KEYS_CONDITION = `expires_at < ? AND (response_status <> ${IN_PROGRESS_STATUS} OR expires_at < ?)`;

/**
 * Cleanup expired idempotency keys
 * Should be called periodically by a scheduled worker
 */
export async function cleanupExpiredIdempotencyKeys(adapter: DatabaseAdapter): Promise<number> {
  const nowTs = Math.floor(Date.now() / 1000);
  const result = await adapter.execute(
    `DELETE FROM idempotency_keys WHERE ${EXPIRED_IDEMPOTENCY_KEYS_CONDITION}`,
    [nowTs, nowTs - IDEMPOTENCY_RESERVATION_RETENTION_SECONDS]
  );
  return result.rowsAffected;
}
