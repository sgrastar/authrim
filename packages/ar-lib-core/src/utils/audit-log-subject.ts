/**
 * Who and what a legacy audit entry is about, for its unified event_log mirror: the user it
 * records (as anonymized_user_id), its client and its session.
 */

import type { Env } from '../types/env';
import type { AuditLogEntry } from '../types/admin';
import { ensureDatabaseAdapter } from '../db';
import { AnonymizationService } from '../services/audit/anonymization';
import { cacheAnonymizedUserId } from '../services/audit/anonymized-user-id-cache';
import { resolveAuditPersistenceSourcesFromEnv } from '../services/audit/runtime-sources';
import { resolveAccountPiiSourceForAudit } from '../services/runtime-data-context';

/** Actor values that name a component, not a user. */
const NON_USER_ACTORS: ReadonlySet<string> = new Set([
  'system',
  'saml-idp',
  'scim-service',
  'unknown',
  'anonymous',
]);

/** Resources whose ID is a user ID (SCIM names its users `scim_user`). */
const USER_RESOURCES: ReadonlySet<string> = new Set(['user', 'scim_user']);

/**
 * Actions whose `user` resourceId is already a one-way pseudonym rather than a user ID
 * (user.anonymized names the user by a hash only): it is neither the event's user nor removed.
 */
const PSEUDONYMOUS_USER_RESOURCE_ACTIONS: ReadonlySet<string> = new Set(['user.anonymized']);

const AUDIT_IDENTIFIER_PATTERN = /^[\x21-\x7e]{1,255}$/u;

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && AUDIT_IDENTIFIER_PATTERN.test(value) ? value : undefined;
}

type MirrorEntry = Pick<AuditLogEntry, 'userId' | 'action' | 'resource' | 'resourceId'>;

/**
 * The user an entry records, only from what the entry already carries: the user its data names
 * (`userId`), else the user resource it acts on, else its actor when that is not a component.
 * An entry that names no user (a failure before the user is known) stays without one.
 */
export function resolveAuditSubjectUserId(
  entry: MirrorEntry,
  metadata: Record<string, unknown>
): string | undefined {
  const fromData = identifier(metadata.userId) ?? identifier(metadata.user_id);
  if (fromData) return fromData;
  if (USER_RESOURCES.has(entry.resource) && !PSEUDONYMOUS_USER_RESOURCE_ACTIONS.has(entry.action)) {
    const resourceUser = identifier(entry.resourceId);
    if (resourceUser) return resourceUser;
  }
  const actor = identifier(entry.userId);
  return actor && !NON_USER_ACTORS.has(actor) ? actor : undefined;
}

/** `sid_` + SHA-256 hex of a session ID: correlates a session's events, unusable as a cookie. */
async function sessionDigest(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`authrim:event_log:session\u0000${sessionId}`)
  );
  return `sid_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The resourceId the mirror keeps in details. Not one that names a user (the entry's user, or
 * any user of a user resource), since event_log names users by anonymized_user_id only; and a
 * session resource only as its digest, since a session ID is the session cookie's value.
 */
export async function mirrorableResourceId(
  entry: MirrorEntry,
  resourceId: unknown,
  subjectUserId: string | undefined
): Promise<unknown> {
  if (resourceId == null || resourceId === '') return undefined;
  if (entry.resource === 'session') {
    return typeof resourceId === 'string' ? sessionDigest(resourceId) : undefined;
  }
  if (USER_RESOURCES.has(entry.resource) && !PSEUDONYMOUS_USER_RESOURCE_ACTIONS.has(entry.action)) {
    return undefined;
  }
  return resourceId === subjectUserId ? undefined : resourceId;
}

/** The OAuth client the entry's data names (`clientId` / `client_id`). */
export function resolveAuditClientId(metadata: Record<string, unknown>): string | undefined {
  return identifier(metadata.clientId) ?? identifier(metadata.client_id);
}

/** The session the entry names (its data's `sessionId` / `session_id`, or a session resource), as its digest. */
export async function resolveAuditSessionRef(
  entry: MirrorEntry,
  metadata: Record<string, unknown>
): Promise<string | undefined> {
  const sessionId =
    identifier(metadata.sessionId) ??
    identifier(metadata.session_id) ??
    (entry.resource === 'session' ? identifier(entry.resourceId) : undefined);
  return sessionId ? sessionDigest(sessionId) : undefined;
}

/** Account route failures that mean the ID names no runtime account (an admin, a client). */
const NO_ACCOUNT_ROUTE_ERRORS: ReadonlySet<string> = new Set([
  'account_data_route_not_found',
  'account_data_account_id_invalid',
]);

/**
 * Read or create the user's anonymized ID in the user's PII store (resolved through the account
 * route, as other per-user PII reads are, inactive accounts included) and cache it. Null when the ID names no account, or
 * the account was deleted or anonymized before it had a mapping. For after-response use only.
 */
export async function resolveAnonymizedUserIdFromEnv(
  env: Env,
  tenantId: string,
  userId: string
): Promise<string | null> {
  let piiDb;
  try {
    piiDb = await resolveAccountPiiSourceForAudit(env, { tenantId, accountId: userId });
  } catch (error) {
    if (error instanceof Error && NO_ACCOUNT_ROUTE_ERRORS.has(error.message)) return null;
    throw error;
  }
  const anonymizedUserId = await new AnonymizationService(piiDb).getAnonymizedUserIdUnlessErased(
    tenantId,
    userId
  );
  if (anonymizedUserId) cacheAnonymizedUserId(tenantId, userId, anonymizedUserId);
  return anonymizedUserId;
}

/**
 * Record the anonymized ID on an event_log row already written without one (the Core D1 copy;
 * a row held by another primary is not updated here).
 */
export async function backfillEventLogAnonymizedUserId(
  env: Env,
  tenantId: string,
  eventId: string,
  anonymizedUserId: string
): Promise<void> {
  const core = ensureDatabaseAdapter(
    resolveAuditPersistenceSourcesFromEnv(env).coreSource,
    'audit-event-anonymized-user'
  );
  await core.execute(
    `UPDATE event_log SET anonymized_user_id = ?
      WHERE tenant_id = ? AND id = ? AND anonymized_user_id IS NULL`,
    [anonymizedUserId, tenantId, eventId]
  );
}
