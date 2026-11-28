/**
 * ReBAC tuple type rules: which relationship tuples may be written (and deleted, and matched for
 * uniqueness) through `/api/rebac/write`, `DELETE /api/rebac/tuples` and the Admin API
 * (`POST /api/admin/rebac/tuples`).
 *
 * A tuple `(from_type:from_id) -[relationship_type]-> (to_type:to_id)` is accepted when its source
 * is one of:
 *
 * 1. **A direct subject**: `from_type = 'subject'` (`'user'` is accepted as the same thing and
 *    stored as `'subject'`, the type the relationship check matches; see rebac-service.ts).
 * 2. **A group userset**: `from_type = 'group'` with `from_relation = 'member'` (written when the
 *    request leaves it out), "every effective member of the group": the check matches it against
 *    the subject's groups (userset.ts). Lists and the closure do not expand it.
 * 3. **An object-to-object edge** declared by a relation definition: an active definition of
 *    `object_type = from_type` contains a `tuple_to_userset` whose `tupleset.relation` is the
 *    tuple's `relationship_type` (for example `document#parent` → `folder`).
 *
 * Everything else is refused (`POLICY_REBAC_TUPLE_TYPE_NOT_ALLOWED`): a tuple from an arbitrary
 * type would be stored and then either never matched or matched in ways no definition declared.
 */

import type { RelationExpression } from './types';
import { RelationParser } from './relation-parser';
import { usableDefinitionExpression } from './definitions';
import { MAX_DEFINITION_DEPTH, USERSET_MEMBER_RELATION } from './userset';

/** The kind of source a tuple has (see the module comment). */
export type RelationshipTupleSourceKind = 'subject' | 'group_userset' | 'object_edge';

export type RelationshipTupleSourceRuling =
  | {
      allowed: true;
      kind: RelationshipTupleSourceKind;
      fromType: string;
      /** What to store as `from_relation`: `'member'` for a group userset, otherwise null. */
      fromRelation: string | null;
    }
  | {
      allowed: false;
      reason: 'missing_type' | 'undeclared_object_edge' | 'unsupported_from_relation';
    };

/** The database reads the rules need. */
export interface TupleTypeRuleStore {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** The stored `from_type` of a direct subject (what the relationship check matches). */
export const REBAC_SUBJECT_FROM_TYPE = 'subject';
/** The stored `from_type` of a group userset. */
export const REBAC_GROUP_FROM_TYPE = 'group';

/**
 * The stored `from_type` values a tuple's source matches when it is looked up (delete, uniqueness,
 * listing): a direct subject also matches the rows older writes stored as `user`; any other type
 * only itself. Always two values, for `from_type IN (?, ?)`. New rows are stored as `subject`.
 * Migration 020 rewrote the stored `user` rows as `subject`; the dual match stays for one more
 * release (a deployment that writes `user` between its schema migration and its code update).
 */
export function relationshipSourceTypes(fromType: string): [string, string] {
  return fromType === REBAC_SUBJECT_FROM_TYPE
    ? [REBAC_SUBJECT_FROM_TYPE, 'user']
    : [fromType, fromType];
}

/** Whether an expression declares `relation` as the tupleset of a tuple_to_userset. */
export function declaresTuplesetRelation(
  expression: RelationExpression | undefined | null,
  relation: string,
  depth = 0
): boolean {
  if (!expression || typeof expression !== 'object' || depth > MAX_DEFINITION_DEPTH) return false;
  switch (expression.type) {
    case 'tuple_to_userset':
      return expression.tupleset?.relation === relation;
    case 'union':
    case 'intersection':
      return (expression.children ?? []).some((child) =>
        declaresTuplesetRelation(child, relation, depth + 1)
      );
    case 'exclusion':
      return (
        declaresTuplesetRelation(expression.base, relation, depth + 1) ||
        declaresTuplesetRelation(expression.subtract, relation, depth + 1)
      );
    default:
      return false;
  }
}

/**
 * Rule on a tuple's source (see the module comment). `fromType` is what the caller sent
 * (`subject_type` on `/api/rebac/write`, `from_type` on the Admin API); the returned `fromType`
 * is what to store and match.
 */
export async function ruleOnRelationshipTupleSource(
  store: TupleTypeRuleStore,
  input: {
    tenantId: string;
    fromType: string | undefined | null;
    relationshipType: string;
    /**
     * The source's relation as the request sent it (`from_relation`): a group tuple is the
     * `member` userset (absent or `'member'`), and no other source has one. Anything else is
     * refused rather than stored as something else.
     */
    fromRelation?: unknown;
  }
): Promise<RelationshipTupleSourceRuling> {
  const fromType = typeof input.fromType === 'string' ? input.fromType.trim() : '';
  if (!fromType || !input.relationshipType) return { allowed: false, reason: 'missing_type' };
  if (
    input.fromRelation !== undefined &&
    !(fromType === REBAC_GROUP_FROM_TYPE && input.fromRelation === 'member')
  ) {
    return { allowed: false, reason: 'unsupported_from_relation' };
  }

  if (fromType === REBAC_SUBJECT_FROM_TYPE || fromType === 'user') {
    return {
      allowed: true,
      kind: 'subject',
      fromType: REBAC_SUBJECT_FROM_TYPE,
      fromRelation: null,
    };
  }
  if (fromType === REBAC_GROUP_FROM_TYPE) {
    return {
      allowed: true,
      kind: 'group_userset',
      fromType: REBAC_GROUP_FROM_TYPE,
      fromRelation: USERSET_MEMBER_RELATION,
    };
  }

  // The definitions checks use (the active one of each relation of the type: the highest
  // priority row; the table holds one per relation), read in one query and judged as the loader
  // judges them: one that cannot be used declares nothing (the tuple is refused, never a server
  // error).
  const rows = await store.query<{ relation_name: string; definition_json: string }>(
    `SELECT relation_name, definition_json FROM relation_definitions
      WHERE tenant_id = ? AND object_type = ? AND is_active = 1
      ORDER BY relation_name, priority DESC`,
    [input.tenantId, fromType]
  );
  const parser = new RelationParser();
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.relation_name === 'string') {
      if (seen.has(row.relation_name)) continue;
      seen.add(row.relation_name);
    }
    const expression = usableDefinitionExpression(parser, row.definition_json);
    if (expression && declaresTuplesetRelation(expression, input.relationshipType)) {
      return { allowed: true, kind: 'object_edge', fromType, fromRelation: null };
    }
  }
  return { allowed: false, reason: 'undeclared_object_edge' };
}
