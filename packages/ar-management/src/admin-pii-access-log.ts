/**
 * PII read records for admin responses (audit_log_pii; see ar-lib-core pii-access-log): which
 * administrator was given which personal fields of which user, through which operation and
 * request. Written after the response through the configured encrypted log storage.
 */
import type { Context } from 'hono';
import {
  disclosedPiiFields,
  PiiAccessLog,
  schedulePiiAccessLog,
  type AccountDataContext,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';

/** The personal fields an admin user object (formatCanonicalAdminUser) may return. */
export const ADMIN_USER_PII_FIELDS = [
  'email',
  'name',
  'given_name',
  'family_name',
  'nickname',
  'preferred_username',
  'picture',
  'phone_number',
  'website',
  'gender',
  'birthdate',
  'locale',
  'zoneinfo',
  'address_formatted',
  'address_street_address',
  'address_locality',
  'address_region',
  'address_postal_code',
  'address_country',
] as const;

/** A session row's personal fields: the user's contact data and the session's client facts. */
export const ADMIN_SESSION_PII_FIELDS = [
  'user_email',
  'user_name',
  'ip_address',
  'user_agent',
] as const;

/** A request variable, or undefined where the context has none (recording never fails a read). */
function contextValue(c: Context<{ Bindings: Env }>, key: string): unknown {
  const get = (c as unknown as { get?: (name: string) => unknown }).get;
  if (typeof get !== 'function') return undefined;
  try {
    return get.call(c, key);
  } catch {
    return undefined;
  }
}

export function createAdminPiiAccessLog(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  operation: string
): PiiAccessLog {
  const adminAuth = contextValue(c, 'adminAuth') as AdminAuthContext | undefined;
  const requestId = contextValue(c, 'requestId');
  return new PiiAccessLog({
    tenantId,
    actorId: adminAuth?.actorId ?? adminAuth?.userId ?? null,
    actorType: adminAuth?.actorType ?? adminAuth?.authMethod ?? null,
    requestId: typeof requestId === 'string' && requestId ? requestId : null,
    operation,
  });
}

/** The request's own PII store: the account's when the request is bound to one. */
export function requestPiiStore(
  c: Context<{ Bindings: Env }>,
  adapter: DatabaseAdapter
): { key: string; adapter: DatabaseAdapter } {
  const account = contextValue(c, 'accountDataContext') as AccountDataContext | undefined;
  return { key: account?.piiBindingRef ?? 'tenant-default', adapter };
}

/** Notes the personal fields `record` returns for `userId`. */
export function noteAdminPiiRead(
  accessLog: PiiAccessLog,
  store: { key: string; adapter: DatabaseAdapter },
  userId: string,
  record: Record<string, unknown>,
  fields: readonly string[]
): void {
  accessLog.add(store, userId, disclosedPiiFields(record, fields));
}

export function scheduleAdminPiiAccessLog(
  c: Context<{ Bindings: Env }>,
  accessLog: PiiAccessLog,
  tenantId: string
): void {
  let executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    // No execution context (tests, some local runs): the write still runs, unawaited.
    executionCtx = undefined;
  }
  void schedulePiiAccessLog(c.env, executionCtx, accessLog, tenantId);
}
