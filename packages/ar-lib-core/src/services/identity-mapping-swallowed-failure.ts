import { createLogger, type Logger } from '../utils/logger';

/**
 * Where an app with no Mapping Set of its own looks for the tenant's identity mapping, a failure
 * to resolve it is not an error of the request: the request goes on without the mapping. That
 * keeps a transient database failure from stopping every such app's sign-in, but it also hides a
 * mapping that is configured and cannot be read (the ID token and UserInfo then differ, or carry
 * claims the mapping would have held back). This records each such failure as an error so it is
 * visible; it never changes what the caller does.
 *
 * docs/operations/identity-mapping-implicit-application.md lists the activations that would apply
 * in the request's place.
 *
 * The record names the component, the tenant, the app, the kind of failure and a short reason
 * code. It carries no error message (a database message can name rows and values) and nothing of
 * the user.
 */

export type SwallowedIdentityMappingFailureKind =
  /** DB_ADMIN is not bound: the lookup ran against the tenant database, which holds no mappings. */
  | 'admin_database_unbound'
  /** The database refused or failed the lookup (missing table or column, D1 error, timeout). */
  | 'query_failed'
  | 'other';

export interface SwallowedIdentityMappingFailureInput {
  /** The code path that swallowed the failure, as a stable upper-case name. */
  component: string;
  tenantId: string;
  clientId: string;
  /** Whether DB_ADMIN is bound in the Worker that swallowed the failure. */
  adminDatabaseBound: boolean;
  error: unknown;
  /** The request's logger, when the caller has one; otherwise a tenant-scoped one is created. */
  logger?: Logger;
  /** Overrides the clock (tests). */
  now?: number;
}

/**
 * The same kind of failure in the same place is recorded once per window per Worker instance,
 * with the number of repeats since the last record. An authorization request that hits it again
 * and again (every app without a Mapping Set, every request) would otherwise write a record per
 * request. Failures of different kinds, components or tenants are recorded independently.
 */
export const SWALLOWED_IDENTITY_MAPPING_FAILURE_LOG_WINDOW_MS = 60_000;
const MAX_THROTTLE_KEYS = 256;

interface ThrottleEntry {
  lastLoggedAt: number;
  suppressed: number;
  /** The shared record of a component for keys that did not fit the table. */
  overflow?: boolean;
}
const throttle = new Map<string, ThrottleEntry>();

const OVERFLOW_KEY_SUFFIX = '|overflow';

/**
 * Drops the records whose window has passed (their next failure is recorded anyway). The shared
 * overflow records stay: they hold the count of repeats the next record reports, and there is at
 * most one per component.
 */
function pruneExpired(now: number): void {
  for (const [key, entry] of throttle) {
    if (entry.overflow) continue;
    const age = now - entry.lastLoggedAt;
    if (age < 0 || age >= SWALLOWED_IDENTITY_MAPPING_FAILURE_LOG_WINDOW_MS) throttle.delete(key);
  }
}

/** Forgets what was recorded (tests). */
export function resetSwallowedIdentityMappingFailureThrottle(): void {
  throttle.clear();
}

const CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const DATABASE_REASON_CODES = new Set([
  'no_such_table',
  'no_such_column',
  'd1_error',
  'database_timeout',
  'database_unavailable',
]);

/**
 * A short code for why the failure happened, without the error's message: an own `code` that is
 * a plain token, else a pattern of the message mapped to a fixed code, else the error's name.
 */
export function swallowedIdentityMappingFailureReasonCode(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && CODE_PATTERN.test(code)) return code;
  const message = error.message;
  if (/no such table/i.test(message)) return 'no_such_table';
  if (/no such column/i.test(message)) return 'no_such_column';
  if (/DB_ADMIN is not configured|Admin database is not configured/i.test(message)) {
    return 'admin_database_not_configured';
  }
  if (/D1_ERROR/i.test(message)) return 'd1_error';
  if (/timed? ?out|timeout/i.test(message)) return 'database_timeout';
  if (/network|connection|unavailable|overloaded/i.test(message)) return 'database_unavailable';
  return CODE_PATTERN.test(error.name) ? error.name : 'unknown';
}

export function classifySwallowedIdentityMappingFailure(input: {
  adminDatabaseBound: boolean;
  error: unknown;
}): { kind: SwallowedIdentityMappingFailureKind; reasonCode: string } {
  const reasonCode = swallowedIdentityMappingFailureReasonCode(input.error);
  if (!input.adminDatabaseBound) return { kind: 'admin_database_unbound', reasonCode };
  if (DATABASE_REASON_CODES.has(reasonCode)) return { kind: 'query_failed', reasonCode };
  return { kind: 'other', reasonCode };
}

/** Records, as an error, that resolving the identity mapping failed and the request went on. */
export function logSwallowedIdentityMappingFailure(
  input: SwallowedIdentityMappingFailureInput
): void {
  const { kind, reasonCode } = classifySwallowedIdentityMappingFailure(input);
  const now = input.now ?? Date.now();
  let key = [input.component, input.tenantId, kind, reasonCode].join('|');
  let overflow = false;
  if (!throttle.has(key) && throttle.size >= MAX_THROTTLE_KEYS) {
    pruneExpired(now);
    if (throttle.size >= MAX_THROTTLE_KEYS) {
      // Bounded: a new key that finds the table full shares one record per component (no tenant
      // in it) instead of clearing the table, which would let a cycle of distinct keys be logged
      // on every pass. The records of the keys already held keep their own windows.
      key = `${input.component}${OVERFLOW_KEY_SUFFIX}`;
      overflow = true;
    }
  }
  const entry = throttle.get(key);
  if (
    entry &&
    now - entry.lastLoggedAt >= 0 &&
    now - entry.lastLoggedAt < SWALLOWED_IDENTITY_MAPPING_FAILURE_LOG_WINDOW_MS
  ) {
    entry.suppressed += 1;
    return;
  }
  const suppressed = entry?.suppressed ?? 0;
  throttle.set(key, { lastLoggedAt: now, suppressed: 0, ...(overflow ? { overflow: true } : {}) });

  const logger = (input.logger ?? createLogger({ tenantId: input.tenantId })).module(
    input.component
  );
  logger.error('Identity mapping could not be resolved; continuing without it', {
    action: 'identity_mapping_resolution_swallowed',
    clientId: input.clientId,
    failure_kind: kind,
    reason_code: reasonCode,
    suppressed_since_last_log: suppressed,
    // The record stands for failures of several tenants or reasons that did not fit the table.
    ...(overflow ? { throttle_overflow: true } : {}),
  });
}
