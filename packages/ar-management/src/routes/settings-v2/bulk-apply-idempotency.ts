/**
 * Replay protection for the bulk apply, kept in the platform's Admin database.
 *
 * The usual idempotency middleware keeps the answer in the Core database of the tenant the request
 * arrived on. A bulk apply's answer holds the settings, IDs and results of many tenants, so it must
 * not go into any one tenant's database (it would cross the tenant boundary, and be exported,
 * backed up and deleted with that tenant). It goes into `idempotency_records` of the Admin database
 * instead, under the platform, keyed by the acting principal as well as the key: another
 * administrator's request with the same key is another request.
 *
 * The key is required (8 to 128 characters); the same key and body answers with the stored answer
 * for 15 minutes; the same key with another body is a 409; a request still running is a 425.
 *
 * Once an apply has started, the reservation is never released: whether tenants were changed is
 * not known if the answer cannot be kept, and running the request again could undo what another
 * person has done to a tenant since. Such a record is kept as `unknown` (a repeat is a 409,
 * `result_unknown`) until it runs out. A reservation is released only when it is certain that no
 * tenant was changed: a refusal before the work, a preview, or a failure before the first change.
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

const log = createLogger().module('SETTINGS_BULK_APPLY');

/** The records of the bulk apply have an operation key that starts with this. */
export const BULK_APPLY_OPERATION_PREFIX = 'settings.bulk_apply:';
/** The records belong to no tenant. */
const PLATFORM = 'platform';
export const BULK_APPLY_RECORD_TTL_MS = 15 * 60 * 1000;
const BODY_LIMIT_BYTES = 1024 * 1024;
const RESPONSE_LIMIT_BYTES = 1024 * 1024;
/** How many times the answer is written before the record is left as `unknown`. */
const STORE_ATTEMPTS = 3;

/** Set by the handler when it is about to change tenants: from then on the key is held. */
export const BULK_APPLY_STARTED = 'bulkApplyStarted';

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
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function replay(c: Context, row: RecordRow): Response | null {
  if (row.status !== 'complete' || !row.response_ref) return null;
  try {
    const stored = JSON.parse(row.response_ref) as StoredAnswer;
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

function resultUnknown(c: Context): Response {
  return c.json(
    {
      error: 'result_unknown',
      error_description:
        'A request with this Idempotency-Key was run, but its result was not kept; it is not run again. Look at the tenants, and use another key to run it again',
    },
    409
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

export const bulkApplyIdempotency: MiddlewareHandler<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}> = async (c, next) => {
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
    bytes = await readRequestBytesWithLimit(c.req.raw, BODY_LIMIT_BYTES);
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
  const hash = await sha256Hex(bytes);
  // The principal is part of the operation: the same key of another administrator is another record.
  const operation = `${BULK_APPLY_OPERATION_PREFIX}${principal}`;

  let adapter: DatabaseAdapter;
  try {
    adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'bulk-apply-idempotency');
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
        [id, PLATFORM, key, operation, hash, now + BULK_APPLY_RECORD_TTL_MS, now, now]
      );
      reserved = true;
    } catch (error) {
      // The adapters wrap the database's error: it is the cause that says "unique".
      if (!isUniqueConstraintError(error)) return unavailable(c);
      try {
        const existing = await adapter.queryOne<RecordRow>(
          `SELECT id, request_hash, response_ref, status, expires_at FROM idempotency_records
            WHERE tenant_id = ? AND operation_key = ? AND idempotency_key = ?`,
          [PLATFORM, operation, key]
        );
        if (!existing) continue;
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
        return replay(c, existing) ?? inProgress(c);
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
      log.warn('A bulk apply idempotency reservation could not be released');
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
      log.warn('A bulk apply idempotency record could not be marked unknown');
    }
  };
  const started = () =>
    (c as unknown as { get(name: string): unknown }).get(BULK_APPLY_STARTED) === true;

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
      stored = JSON.stringify({
        status: response.status,
        body: JSON.parse(text) as unknown,
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

/**
 * Removes the records of the bulk apply that have run out, a page at a time. The answers in them
 * hold the settings and IDs of many tenants, so they do not stay beyond their time even when the
 * administrator who made them does not come back. Returns how many were removed.
 */
export async function sweepExpiredBulkApplyRecords(
  env: Env,
  options: { limit?: number; now?: number } = {}
): Promise<number> {
  const limit = Math.max(1, Math.min(500, options.limit ?? 200));
  const adapter = requireDedicatedAdminDatabaseAdapter(env, 'bulk-apply-idempotency-sweep');
  // The operation key is `settings.bulk_apply:` and the principal: a range of the unique index.
  const result = await adapter.execute(
    `DELETE FROM idempotency_records
      WHERE id IN (
        SELECT id FROM idempotency_records
         WHERE tenant_id = ? AND operation_key >= ? AND operation_key < ? AND expires_at <= ?
         LIMIT ?)`,
    [
      PLATFORM,
      BULK_APPLY_OPERATION_PREFIX,
      `${BULK_APPLY_OPERATION_PREFIX.slice(0, -1)};`,
      options.now ?? Date.now(),
      limit,
    ]
  );
  return result.rowsAffected;
}
