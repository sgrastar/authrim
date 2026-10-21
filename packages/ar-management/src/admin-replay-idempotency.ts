/**
 * Replay protection that keeps the answer in the platform's Admin database.
 *
 * The usual idempotency middleware keeps the answer in the Core database of the tenant the request
 * arrived on. An answer that holds settings or mappings of many tenants (a bulk apply), or the
 * definition of a Mapping Set (the set facade), must not go into a tenant's Core database: it
 * would cross the tenant boundary, and be exported, backed up and deleted with that tenant. It
 * goes into `idempotency_records` of the Admin database instead, keyed by the acting principal as
 * well as the key: another administrator's request with the same key is another request.
 *
 * The key is required (8 to 128 characters); the same key and body answers with the stored answer
 * until the record runs out; the same key with another body is a 409; a request still running is
 * a 425.
 *
 * Once the work has started (the handler sets `startedKey`), the reservation is never released:
 * whether anything was changed is not known if the answer cannot be kept, and running the request
 * again could undo what another person has done since. Such a record is kept as `unknown` (a
 * repeat is a 409, `result_unknown`) until it runs out. A reservation is released only when it is
 * certain that nothing was changed: a refusal before the work, a preview, or a failure before the
 * first change.
 */
import type { Context, MiddlewareHandler } from 'hono';
import {
  BodyLimitExceededError,
  createLogger,
  isUniqueConstraintError,
  readRequestBytesWithLimit,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';

const RESPONSE_LIMIT_BYTES = 1024 * 1024;
/** How many times the answer is written before the record is left as `unknown`. */
const STORE_ATTEMPTS = 3;

export interface ReplayIdempotencyOptions {
  /** Names the Admin database use and the log lines. */
  partition: string;
  /** The log module. */
  logModule: string;
  /** What the log lines call the request ("bulk apply"). */
  subject: string;
  /** The operation key of a record; the principal is part of it. */
  operation(principal: string): string;
  /** The tenant ID the records are stored under. */
  tenantId(c: Context): string;
  ttlMs: number;
  bodyLimitBytes: number;
  /** The context variable the handler sets when it is about to change something. */
  startedKey: string;
  /** What a repeat of a request whose result was lost is told. */
  unknownMessage: string;
  /** A request this returns true for is passed on with no key and no record. */
  bypass?(c: Context): boolean;
  /**
   * What else makes a request the same request besides its body (the method and path of a route
   * that has an ID in its path). It is part of what the key and the body are compared with.
   */
  requestScope?(c: Context): string;
  /**
   * Make the authority the caller holds part of what a request is compared with: a stored answer
   * is then given only to the credential (and the rights) it was made with. For answers that
   * hold more than a caller with less authority may see.
   */
  bindToAuthority?: boolean;
  /**
   * Run before a stored record is used for anything (replayed, or answered as a conflict): the
   * caller's right is judged again as it is now, as the first request was. A response it returns
   * is sent instead. Not run for a first request, whose handler does the same judging.
   */
  authorizeReplay?(
    c: Context,
    body: ArrayBuffer,
    /** The answer the record holds, when it has one (a finished request). */
    stored: { status: number; body: unknown } | null
  ): Promise<Response | null>;
}

interface RecordRow {
  id: string;
  request_hash: string;
  response_ref: string | null;
  status: string;
  expires_at: number;
}

interface StoredAnswer {
  status: number;
  body: unknown;
  /** The only headers kept for a replay (an allow-list): the entity tag of a read-back. */
  headers?: { etag?: string };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * What the caller may do, as the request was authenticated: a stored answer is for the authority
 * it was made with. Another credential of the same principal, or the same one with a right since
 * taken away or given, is another request, whatever the key and the body.
 */
function authorityFingerprint(auth: AdminAuthContext | undefined): string {
  const sorted = (list: readonly string[] | undefined) => [...(list ?? [])].sort();
  return JSON.stringify({
    user: auth?.userId ?? null,
    method: auth?.authMethod ?? null,
    actor: auth?.actorType ?? null,
    credential: auth?.credentialId ?? null,
    scope: sorted(auth?.tenantScope),
    roles: sorted(auth?.roles),
    globalRoles: sorted(auth?.globalRoles),
    permissions: sorted(auth?.permissions),
    globalPermissions: sorted(auth?.globalPermissions),
  });
}

function concatBytes(head: Uint8Array, tail: ArrayBuffer): ArrayBuffer {
  const joined = new Uint8Array(head.length + tail.byteLength);
  joined.set(head, 0);
  joined.set(new Uint8Array(tail), head.length);
  return joined.buffer;
}

function replay(c: Context, row: RecordRow): Response | null {
  if (row.status !== 'complete' || !row.response_ref) return null;
  try {
    const stored = JSON.parse(row.response_ref) as StoredAnswer;
    if (typeof stored.headers?.etag === 'string') c.header('ETag', stored.headers.etag);
    return c.json(stored.body as never, stored.status as never);
  } catch {
    return null;
  }
}

function conflict(c: Context): Response {
  return c.json(
    {
      error: 'idempotency_conflict',
      error_description: 'Idempotency-Key already used with different request body',
    },
    409
  );
}

function inProgress(c: Context): Response {
  c.header('Retry-After', '2');
  return c.json(
    {
      error: 'idempotency_in_progress',
      error_description: 'A request with this Idempotency-Key is still in progress',
    },
    425
  );
}

function unavailable(c: Context): Response {
  c.header('Cache-Control', 'no-store');
  return c.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'Idempotency storage is temporarily unavailable',
    },
    503
  );
}

export function createReplayIdempotency(options: ReplayIdempotencyOptions): MiddlewareHandler<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}> {
  const log = createLogger().module(options.logModule);
  const resultUnknown = (c: Context): Response =>
    c.json({ error: 'result_unknown', error_description: options.unknownMessage }, 409);

  return async (c, next) => {
    if (options.bypass?.(c as unknown as Context)) {
      await next();
      return;
    }
    const key = c.req.header('Idempotency-Key');
    if (!key) {
      return c.json(
        { error: 'invalid_request', error_description: 'Idempotency-Key header is required' },
        400
      );
    }
    if (key.length < 8 || key.length > 128) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Idempotency-Key must be between 8 and 128 characters',
        },
        400
      );
    }
    const principal = c.get('adminAuth')?.userId;
    if (!principal) {
      return c.json({ error: 'forbidden', message: 'Admin authentication required' }, 403);
    }

    let bytes: ArrayBuffer;
    try {
      bytes = await readRequestBytesWithLimit(c.req.raw, options.bodyLimitBytes);
    } catch (error) {
      if (error instanceof BodyLimitExceededError) {
        return c.json(
          { error: 'invalid_request', error_description: 'Request body is too large' },
          413
        );
      }
      return c.json(
        { error: 'invalid_request', error_description: 'Request body is unreadable' },
        400
      );
    }
    const scopeParts = [
      ...(options.bindToAuthority ? [`authority=${authorityFingerprint(c.get('adminAuth'))}`] : []),
      ...(options.requestScope ? [options.requestScope(c as unknown as Context)] : []),
    ];
    const hash = await sha256Hex(
      scopeParts.length === 0
        ? bytes
        : concatBytes(new TextEncoder().encode(`${scopeParts.join('\n')}\n`), bytes)
    );
    // The principal is part of the operation: the same key of another administrator is another record.
    const operation = options.operation(principal);
    const recordTenantId = options.tenantId(c as unknown as Context);

    let adapter: DatabaseAdapter;
    try {
      adapter = requireDedicatedAdminDatabaseAdapter(c.env, options.partition);
    } catch {
      return unavailable(c);
    }

    const id = crypto.randomUUID();
    let reserved = false;
    for (let attempt = 0; attempt < 2 && !reserved; attempt += 1) {
      const now = Date.now();
      try {
        await adapter.execute(
          `INSERT INTO idempotency_records
             (id, tenant_id, idempotency_key, operation_key, request_hash, response_ref, status,
              expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, 'in_progress', ?, ?, ?)`,
          [id, recordTenantId, key, operation, hash, now + options.ttlMs, now, now]
        );
        reserved = true;
      } catch (error) {
        // The adapters wrap the database's error: it is the cause that says "unique".
        if (!isUniqueConstraintError(error)) return unavailable(c);
        try {
          const existing = await adapter.queryOne<RecordRow>(
            `SELECT id, request_hash, response_ref, status, expires_at FROM idempotency_records
              WHERE tenant_id = ? AND operation_key = ? AND idempotency_key = ?`,
            [recordTenantId, operation, key]
          );
          if (!existing) continue;
          if (options.authorizeReplay) {
            let storedAnswer: StoredAnswer | null = null;
            try {
              storedAnswer =
                existing.status === 'complete' && existing.response_ref
                  ? (JSON.parse(existing.response_ref) as StoredAnswer)
                  : null;
            } catch {
              storedAnswer = null;
            }
            const refused = await options.authorizeReplay(
              c as unknown as Context,
              bytes,
              storedAnswer
            );
            if (refused) return refused;
          }
          if (existing.expires_at <= now) {
            // Run out: it is neither replayed nor kept, and the key is free again.
            await adapter.execute(
              'DELETE FROM idempotency_records WHERE id = ? AND expires_at <= ?',
              [existing.id, now]
            );
            continue;
          }
          if (existing.request_hash !== hash) return conflict(c);
          if (existing.status === 'unknown') return resultUnknown(c);
          return replay(c as unknown as Context, existing) ?? inProgress(c);
        } catch {
          return unavailable(c);
        }
      }
    }
    if (!reserved) return unavailable(c);

    const release = async () => {
      try {
        await adapter.execute('DELETE FROM idempotency_records WHERE id = ?', [id]);
      } catch {
        log.warn(`A ${options.subject} idempotency reservation could not be released`);
      }
    };
    const markUnknown = async () => {
      try {
        await adapter.execute(
          `UPDATE idempotency_records SET status = 'unknown', updated_at = ? WHERE id = ?`,
          [Date.now(), id]
        );
      } catch {
        // The record stays `in_progress`, which a repeat also does not run again, until it runs out.
        log.warn(`A ${options.subject} idempotency record could not be marked unknown`);
      }
    };
    const started = () =>
      (c as unknown as { get(name: string): unknown }).get(options.startedKey) === true;

    // The body was read: give it back to the handler.
    (c.req as unknown as { raw: Request }).raw = new Request(c.req.raw, { body: bytes });
    try {
      await next();
    } catch (error) {
      if (started()) await markUnknown();
      else await release();
      throw error;
    }

    const response = c.res;
    if (response.status >= 500) {
      if (started()) await markUnknown();
      else await release();
      return;
    }

    let stored: string | null = null;
    try {
      const text = await response.clone().text();
      if (new TextEncoder().encode(text).length <= RESPONSE_LIMIT_BYTES) {
        const etag = response.headers.get('ETag');
        stored = JSON.stringify({
          status: response.status,
          body: JSON.parse(text) as unknown,
          ...(etag ? { headers: { etag } } : {}),
        } satisfies StoredAnswer);
      }
    } catch {
      stored = null;
    }
    if (stored === null) {
      // Too large or unreadable to keep (the estimate before the work should prevent it).
      if (started()) await markUnknown();
      else await release();
      return;
    }
    for (let attempt = 0; attempt < STORE_ATTEMPTS; attempt += 1) {
      try {
        const result = await adapter.execute(
          `UPDATE idempotency_records SET status = 'complete', response_ref = ?, updated_at = ?
            WHERE id = ?`,
          [stored, Date.now(), id]
        );
        if (result.rowsAffected > 0) return;
      } catch {
        // Tried again, up to the limit.
      }
    }
    // The caller has the answer; the repeat of a caller that did not get it must not run again.
    if (started()) await markUnknown();
    else await release();
  };
}

/**
 * Removes the records of one operation family that have run out, a page at a time (the family is
 * the range of operation keys that start with `prefix`). Returns how many were removed.
 */
export async function sweepExpiredReplayRecords(
  env: Env,
  options: {
    partition: string;
    prefix: string;
    /** Only the records of this tenant ID (the bulk apply's are the platform's). */
    tenantId?: string;
    limit?: number;
    now?: number;
  }
): Promise<number> {
  const limit = Math.max(1, Math.min(500, options.limit ?? 200));
  const adapter = requireDedicatedAdminDatabaseAdapter(env, options.partition);
  // The operation key is the prefix and the principal: a range of the unique index.
  const result = await adapter.execute(
    `DELETE FROM idempotency_records
      WHERE id IN (
        SELECT id FROM idempotency_records
         WHERE ${options.tenantId ? 'tenant_id = ? AND ' : ''}operation_key >= ? AND operation_key < ? AND expires_at <= ?
         LIMIT ?)`,
    [
      ...(options.tenantId ? [options.tenantId] : []),
      options.prefix,
      `${options.prefix.slice(0, -1)};`,
      options.now ?? Date.now(),
      limit,
    ]
  );
  return result.rowsAffected;
}
