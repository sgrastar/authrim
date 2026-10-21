/**
 * Replay protection for the bulk apply, kept in the platform's Admin database (see
 * `admin-replay-idempotency.ts` for how it works).
 *
 * A bulk apply's answer holds the settings, IDs and results of many tenants, so it is stored under
 * the platform and in no tenant's database. The key is required (8 to 128 characters); the same key
 * and body answers with the stored answer for 15 minutes; the same key with another body is a 409;
 * a request still running is a 425.
 *
 * Once an apply has started, the reservation is never released: whether tenants were changed is
 * not known if the answer cannot be kept, and running the request again could undo what another
 * person has done to a tenant since. Such a record is kept as `unknown` (a repeat is a 409,
 * `result_unknown`) until it runs out. A reservation is released only when it is certain that no
 * tenant was changed: a refusal before the work, a preview, or a failure before the first change.
 */
import type { Env } from '@authrim/ar-lib-core';
import { createReplayIdempotency, sweepExpiredReplayRecords } from '../../admin-replay-idempotency';

/** The records of the bulk apply have an operation key that starts with this. */
export const BULK_APPLY_OPERATION_PREFIX = 'settings.bulk_apply:';
/** The records belong to no tenant. */
const PLATFORM = 'platform';
export const BULK_APPLY_RECORD_TTL_MS = 15 * 60 * 1000;
const BODY_LIMIT_BYTES = 1024 * 1024;

/** Set by the handler when it is about to change tenants: from then on the key is held. */
export const BULK_APPLY_STARTED = 'bulkApplyStarted';

export const bulkApplyIdempotency = createReplayIdempotency({
  partition: 'bulk-apply-idempotency',
  logModule: 'SETTINGS_BULK_APPLY',
  subject: 'bulk apply',
  operation: (principal) => `${BULK_APPLY_OPERATION_PREFIX}${principal}`,
  tenantId: () => PLATFORM,
  ttlMs: BULK_APPLY_RECORD_TTL_MS,
  bodyLimitBytes: BODY_LIMIT_BYTES,
  startedKey: BULK_APPLY_STARTED,
  unknownMessage:
    'A request with this Idempotency-Key was run, but its result was not kept; it is not run again. Look at the tenants, and use another key to run it again',
});

/**
 * Removes the records of the bulk apply that have run out, a page at a time. The answers in them
 * hold the settings and IDs of many tenants, so they do not stay beyond their time even when the
 * administrator who made them does not come back. Returns how many were removed.
 */
export async function sweepExpiredBulkApplyRecords(
  env: Env,
  options: { limit?: number; now?: number } = {}
): Promise<number> {
  return sweepExpiredReplayRecords(env, {
    partition: 'bulk-apply-idempotency-sweep',
    prefix: BULK_APPLY_OPERATION_PREFIX,
    tenantId: PLATFORM,
    ...options,
  });
}
