/**
 * Group usersets: a tuple `(group:G)#member -[relation]-> (object)` (`from_type = 'group'`,
 * `from_relation = 'member'`) grants the relation to every effective member of G (its direct
 * members and the members of its descendants: a subject's effective groups include the ancestors
 * of its groups). Memberships are read from the subject's groups (resolveSubjectGroups), never
 * copied into tuples or the closure table.
 *
 * A userset is decided only when the subject's membership of its group is known: a group in the
 * subject's unknown groups, a resolver that fails, or no resolver at all leaves it undecided
 * (`unknown`). Under an exclusion's `subtract` (negative polarity) a "not a member" of a group a
 * service group decides (service-group owned, or above one) is undecided too: dynamic memberships
 * are eventually consistent, so a stale "not a member" must not take an exclusion away.
 */

import type {
  EvaluationResult,
  MembershipTrace,
  RelationEvaluationContext,
  SubjectGroupsLookup,
} from './interfaces';
import type { RelationExpression, SubjectGroupsResolver } from './types';
import type { IStorageAdapter } from '../storage/interfaces';
import { serviceGroupDecidedGroups } from '../services/dynamic-groups/role-guard';

/**
 * How deep a relation definition may nest (a combinator's children are one level deeper than
 * it; the root is level 0). The parser refuses a deeper one (400 on save, unusable when stored),
 * so evaluation and list candidate collection walk every usable definition in full.
 */
export const MAX_DEFINITION_DEPTH = 32;

/** The stored `from_type` of a group userset. */
export const USERSET_GROUP_FROM_TYPE = 'group';
/** The only userset relation: the members of the group. */
export const USERSET_MEMBER_RELATION = 'member';

/** A fresh trace of what a check met. */
export function createMembershipTrace(): MembershipTrace {
  return { consulted: false, unknown: false, indeterminate: false, minExpiresAt: null, grants: [] };
}

/** Records an `expires_at` the evaluation relied on. */
export function noteExpiry(trace: MembershipTrace | undefined, expiresAt: unknown): void {
  if (!trace || expiresAt === null || expiresAt === undefined) return;
  const value = Number(expiresAt);
  if (!Number.isFinite(value)) return;
  trace.minExpiresAt = trace.minExpiresAt === null ? value : Math.min(trace.minExpiresAt, value);
}

/** The subject's groups, read once per check (undefined without a resolver). */
export function memoizeSubjectGroups(
  resolver: SubjectGroupsResolver | undefined,
  tenantId: string,
  subjectId: string
): SubjectGroupsLookup | undefined {
  if (!resolver) return undefined;
  let state: ReturnType<SubjectGroupsLookup> | undefined;
  return () =>
    (state ??= resolver(tenantId, subjectId).then((groups) => ({
      effective: new Set(groups.effectiveGroupIds),
      unknown: new Set(groups.unknownGroupIds),
    })));
}

/** The groups a service group decides (read once per check). */
export function memoizeServiceDecidedGroups(
  adapter: IStorageAdapter,
  tenantId: string
): () => Promise<Set<string>> {
  let groups: Promise<Set<string>> | undefined;
  return () =>
    (groups ??= serviceGroupDecidedGroups(adapter, tenantId).then(({ affected }) => affected));
}

/** The groups holding the relation on the object as a `member` userset (unexpired). */
export async function groupUsersetsFor(
  adapter: IStorageAdapter,
  tenantId: string,
  objectType: string,
  objectId: string,
  relation: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<Array<{ groupId: string; expiresAt: number | string | null }>> {
  const rows = await adapter.query<{ from_id: string; expires_at: number | string | null }>(
    `SELECT from_id, expires_at FROM relationships
      WHERE tenant_id = ?
        AND from_type = '${USERSET_GROUP_FROM_TYPE}'
        AND from_relation = '${USERSET_MEMBER_RELATION}'
        AND to_type = ?
        AND to_id = ?
        AND relationship_type = ?
        AND (expires_at IS NULL OR expires_at > ?)`,
    [tenantId, objectType, objectId, relation, nowSeconds]
  );
  return rows.map((row) => ({ groupId: row.from_id, expiresAt: row.expires_at }));
}

/**
 * Whether the evaluation's subject holds the relation on the object through a group userset:
 * `allow` (a member of one of the groups), `deny` (known not a member of any, or none), or
 * `unknown` (see the module comment; recorded on the context's trace).
 */
export async function matchGroupUserset(
  adapter: IStorageAdapter,
  context: RelationEvaluationContext,
  objectType: string,
  objectId: string,
  relation: string
): Promise<{ result: EvaluationResult; groupId?: string }> {
  if (context.user_type !== 'subject') return { result: 'deny' };
  const groups = await groupUsersetsFor(adapter, context.tenant_id, objectType, objectId, relation);
  if (groups.length === 0) return { result: 'deny' };
  const trace = context.membership;
  if (trace) trace.consulted = true;
  let state: Awaited<ReturnType<SubjectGroupsLookup>> | undefined;
  try {
    state = await context.subject_groups?.();
  } catch {
    state = undefined;
  }
  const member = state ? groups.find(({ groupId }) => state.effective.has(groupId)) : undefined;
  if (member) {
    noteExpiry(trace, member.expiresAt);
    return { result: 'allow', groupId: member.groupId };
  }
  const undecided = () => {
    if (trace) trace.unknown = true;
    return { result: 'unknown' as const };
  };
  if (!state || groups.some(({ groupId }) => state.unknown.has(groupId))) return undecided();
  if (context.negative) {
    // A "not a member" that decides a subtract: not one a service group decides (see the module
    // comment). When those groups cannot be read, no "not a member" is trusted there.
    let decided: Set<string> | null;
    try {
      decided = context.service_decided_groups ? await context.service_decided_groups() : null;
    } catch {
      decided = null;
    }
    if (!decided || groups.some(({ groupId }) => decided.has(groupId))) return undecided();
    // The usersets could expire into a "not a member" only, which keeps this answer.
  }
  return { result: 'deny' };
}

/**
 * Whether an expression contains an `exclusion` anywhere (one nested deeper than the bound is
 * treated as containing one).
 */
export function expressionContainsExclusion(
  expression: RelationExpression | undefined | null,
  depth = 0
): boolean {
  if (depth > MAX_DEFINITION_DEPTH) return true;
  if (!expression || typeof expression !== 'object') return false;
  switch (expression.type) {
    case 'exclusion':
      return true;
    case 'union':
    case 'intersection':
      return (expression.children ?? []).some((child) =>
        expressionContainsExclusion(child, depth + 1)
      );
    default:
      return false;
  }
}

/**
 * Whether an expression contains a `tuple_to_userset` anywhere (a computed relation the lists do
 * not enumerate; one nested deeper than the bound is treated as containing one).
 */
export function expressionContainsTupleToUserset(
  expression: RelationExpression | undefined | null,
  depth = 0
): boolean {
  if (depth > MAX_DEFINITION_DEPTH) return true;
  if (!expression || typeof expression !== 'object') return false;
  switch (expression.type) {
    case 'tuple_to_userset':
      return true;
    case 'union':
    case 'intersection':
      return (expression.children ?? []).some((child) =>
        expressionContainsTupleToUserset(child, depth + 1)
      );
    case 'exclusion':
      return (
        expressionContainsTupleToUserset(expression.base, depth + 1) ||
        expressionContainsTupleToUserset(expression.subtract, depth + 1)
      );
    default:
      return false;
  }
}

/**
 * At most this many distinct relations a definition's `direct` leaves may name: the list queries
 * bind them all in one statement, within D1's 100 bound parameters.
 */
export const MAX_DEFINITION_DIRECT_RELATIONS = 80;

/** Every relation a `direct` leaf of the expression names. */
export function directRelationNames(expression: RelationExpression, names = new Set<string>()) {
  switch (expression.type) {
    case 'direct':
      names.add(expression.relation);
      break;
    case 'union':
    case 'intersection':
      for (const child of expression.children) directRelationNames(child, names);
      break;
    case 'exclusion':
      directRelationNames(expression.base, names);
      directRelationNames(expression.subtract, names);
      break;
    default:
      break;
  }
  return names;
}
