/**
 * A relation's active relation definition, as evaluation uses it (the highest priority active
 * row). One whose stored expression the relation parser rejects is `unusable`: the relation then
 * answers nothing (undecided, so every check on it denies, with no fallback to direct tuples).
 */

import type { ActiveDefinition, IRelationParser } from './interfaces';
import type { RelationDefinitionRow, RelationExpression } from './types';
import type { IStorageAdapter } from '../storage/interfaces';
import {
  directRelationNames,
  expressionContainsExclusion,
  expressionContainsTupleToUserset,
  MAX_DEFINITION_DIRECT_RELATIONS,
} from './userset';

/**
 * A stored definition's expression when it can be used: it parses (within MAX_DEFINITION_DEPTH),
 * validates, and names at most MAX_DEFINITION_DIRECT_RELATIONS direct relations; null otherwise.
 * Every reader of stored definitions decides usability here (checks, lists, the tuple rules).
 */
export function usableDefinitionExpression(
  parser: Pick<IRelationParser, 'parse' | 'validate'>,
  definitionJson: string
): RelationExpression | null {
  try {
    const expression = parser.parse(definitionJson);
    if (parser.validate(expression).length > 0) return null;
    if (directRelationNames(expression).size > MAX_DEFINITION_DIRECT_RELATIONS) return null;
    return expression;
  } catch {
    return null;
  }
}

export async function loadActiveDefinition(
  adapter: Pick<IStorageAdapter, 'query'>,
  parser: Pick<IRelationParser, 'parse' | 'validate'>,
  tenantId: string,
  objectType: string,
  relation: string
): Promise<ActiveDefinition> {
  const rows = await adapter.query<RelationDefinitionRow>(
    `SELECT * FROM relation_definitions
     WHERE tenant_id = ?
       AND object_type = ?
       AND relation_name = ?
       AND is_active = 1
     ORDER BY priority DESC
     LIMIT 1`,
    [tenantId, objectType, relation]
  );
  if (rows.length === 0) return { state: 'none' };
  const row = rows[0];
  const expression = usableDefinitionExpression(parser, row.definition_json);
  if (!expression) return { state: 'unusable' };
  return {
    state: 'usable',
    exclusive: expressionContainsExclusion(expression),
    computed: expressionContainsTupleToUserset(expression),
    definition: {
      id: row.id,
      tenant_id: row.tenant_id,
      object_type: row.object_type,
      relation_name: row.relation_name,
      definition: expression,
      description: row.description ?? undefined,
      priority: row.priority,
      is_active: row.is_active === 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  };
}

/** loadActiveDefinition, read once per (object type, relation) for one check. */
export function memoizeDefinitions(
  adapter: Pick<IStorageAdapter, 'query'>,
  parser: Pick<IRelationParser, 'parse' | 'validate'>,
  tenantId: string,
  known?: Map<string, Promise<ActiveDefinition>>
): (objectType: string, relation: string) => Promise<ActiveDefinition> {
  const memo = known ?? new Map<string, Promise<ActiveDefinition>>();
  return (objectType, relation) => {
    const key = `${objectType}\u0000${relation}`;
    let definition = memo.get(key);
    if (!definition) {
      definition = loadActiveDefinition(adapter, parser, tenantId, objectType, relation);
      memo.set(key, definition);
    }
    return definition;
  };
}
