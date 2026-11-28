/**
 * Relation Parser Implementation
 *
 * Parses and evaluates Zanzibar-style relation expressions:
 * - direct: a direct tuple from the subject, or a group userset the subject is a member of
 *   (userset.ts)
 * - union: OR of multiple expressions
 * - tuple_to_userset: inherit from a related object (the only declared object-to-object path):
 *   the computed relation is evaluated on the related object through its own definition
 *
 * Evaluation is three-valued (allow / deny / unknown). A cycle on the current recursion path, the
 * depth limit, or an unusable definition is `unknown`, which grants nothing and is never cached.
 * - intersection: AND of multiple expressions
 * - exclusion: base AND NOT subtract
 */

import type {
  RelationExpression,
  DirectRelation,
  UnionRelation,
  TupleToUsersetRelation,
  IntersectionRelation,
  ExclusionRelation,
} from './types';
import type { EvaluationResult, IRelationParser, RelationEvaluationContext } from './interfaces';
import type { IStorageAdapter } from '../storage/interfaces';
import { DEFAULT_MAX_DEPTH } from './types';
import { createLogger } from '../utils/logger';
import {
  matchGroupUserset,
  noteExpiry,
  directRelationNames,
  MAX_DEFINITION_DIRECT_RELATIONS,
  MAX_DEFINITION_DEPTH,
} from './userset';
import { loadActiveDefinition } from './definitions';

const log = createLogger().module('REBAC');

/**
 * RelationParser - Parses and evaluates relation expressions
 */
export class RelationParser implements IRelationParser {
  /**
   * Parse a JSON relation expression
   */
  parse(json: string | object): RelationExpression {
    const obj = typeof json === 'string' ? JSON.parse(json) : json;
    return this.parseExpression(obj);
  }

  /**
   * Recursively parse an expression object
   */
  private parseExpression(obj: unknown, depth = 0): RelationExpression {
    if (!obj || typeof obj !== 'object') {
      throw new Error('Invalid relation expression: must be an object');
    }
    // One bound for every walk of a definition (validation, evaluation, list candidates): a
    // deeper one is refused when saved and unusable when stored.
    if (depth > MAX_DEFINITION_DEPTH) {
      throw new Error(
        `Invalid relation expression: nested deeper than ${MAX_DEFINITION_DEPTH} levels`
      );
    }

    const expr = obj as Record<string, unknown>;
    const type = expr.type as string;

    if (!type) {
      throw new Error('Invalid relation expression: missing "type" field');
    }

    switch (type) {
      case 'direct':
        return this.parseDirectRelation(expr);
      case 'union':
        return this.parseUnionRelation(expr, depth);
      case 'tuple_to_userset':
        return this.parseTupleToUsersetRelation(expr);
      case 'intersection':
        return this.parseIntersectionRelation(expr, depth);
      case 'exclusion':
        return this.parseExclusionRelation(expr, depth);
      default:
        throw new Error(`Unknown relation expression type: ${type}`);
    }
  }

  private parseDirectRelation(obj: Record<string, unknown>): DirectRelation {
    if (typeof obj.relation !== 'string') {
      throw new Error('Direct relation must have a string "relation" field');
    }
    return {
      type: 'direct',
      relation: obj.relation,
    };
  }

  private parseUnionRelation(obj: Record<string, unknown>, depth: number): UnionRelation {
    if (!Array.isArray(obj.children)) {
      throw new Error('Union relation must have an array "children" field');
    }
    return {
      type: 'union',
      children: obj.children.map((child) => this.parseExpression(child, depth + 1)),
    };
  }

  private parseTupleToUsersetRelation(obj: Record<string, unknown>): TupleToUsersetRelation {
    const tupleset = obj.tupleset as Record<string, unknown> | undefined;
    const computedUserset = obj.computed_userset as Record<string, unknown> | undefined;

    if (!tupleset || typeof tupleset.relation !== 'string') {
      throw new Error('Tuple-to-userset must have tupleset.relation');
    }
    if (!computedUserset || typeof computedUserset.relation !== 'string') {
      throw new Error('Tuple-to-userset must have computed_userset.relation');
    }

    return {
      type: 'tuple_to_userset',
      tupleset: { relation: tupleset.relation },
      computed_userset: { relation: computedUserset.relation },
    };
  }

  private parseIntersectionRelation(
    obj: Record<string, unknown>,
    depth: number
  ): IntersectionRelation {
    if (!Array.isArray(obj.children)) {
      throw new Error('Intersection relation must have an array "children" field');
    }
    return {
      type: 'intersection',
      children: obj.children.map((child) => this.parseExpression(child, depth + 1)),
    };
  }

  private parseExclusionRelation(obj: Record<string, unknown>, depth: number): ExclusionRelation {
    if (!obj.base) {
      throw new Error('Exclusion relation must have a "base" expression');
    }
    if (!obj.subtract) {
      throw new Error('Exclusion relation must have a "subtract" expression');
    }
    return {
      type: 'exclusion',
      base: this.parseExpression(obj.base, depth + 1),
      subtract: this.parseExpression(obj.subtract, depth + 1),
    };
  }

  /**
   * Validate a relation expression
   */
  validate(expression: RelationExpression): string[] {
    const errors: string[] = [];
    this.validateExpression(expression, errors, []);
    return errors;
  }

  private validateExpression(expr: RelationExpression, errors: string[], path: string[]): void {
    const currentPath = path.join('.');

    switch (expr.type) {
      case 'direct':
        if (!expr.relation || expr.relation.trim() === '') {
          errors.push(`${currentPath}: direct relation must have a non-empty relation name`);
        }
        break;

      case 'union':
        if (!expr.children || expr.children.length === 0) {
          errors.push(`${currentPath}: union must have at least one child expression`);
        } else {
          expr.children.forEach((child, index) => {
            this.validateExpression(child, errors, [...path, `union[${index}]`]);
          });
        }
        break;

      case 'tuple_to_userset':
        if (!expr.tupleset?.relation) {
          errors.push(`${currentPath}: tuple_to_userset must have tupleset.relation`);
        }
        if (!expr.computed_userset?.relation) {
          errors.push(`${currentPath}: tuple_to_userset must have computed_userset.relation`);
        }
        break;

      case 'intersection':
        // Phase 4+ - validate but warn
        if (!expr.children || expr.children.length === 0) {
          errors.push(`${currentPath}: intersection must have at least one child expression`);
        } else {
          expr.children.forEach((child, index) => {
            this.validateExpression(child, errors, [...path, `intersection[${index}]`]);
          });
        }
        break;

      case 'exclusion':
        // Phase 4+ - validate but warn
        if (!expr.base) {
          errors.push(`${currentPath}: exclusion must have a base expression`);
        } else {
          this.validateExpression(expr.base, errors, [...path, 'exclusion.base']);
        }
        if (!expr.subtract) {
          errors.push(`${currentPath}: exclusion must have a subtract expression`);
        } else {
          this.validateExpression(expr.subtract, errors, [...path, 'exclusion.subtract']);
        }
        break;

      default:
        errors.push(`${currentPath}: unknown expression type`);
    }
  }

  /**
   * Evaluate a relation expression: true only when it allows (an undecided result is false).
   */
  async evaluate(
    expression: RelationExpression,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<boolean> {
    return (await this.evaluateExpression(expression, context, adapter)) === 'allow';
  }

  /**
   * Evaluate a relation (`object_type:object_id#relation`) as a check does: through its active
   * definition when it has one (the definition alone decides; tuples count only through its
   * `direct` leaves), through direct tuples and group usersets when it has none. An unusable
   * definition, a cycle on the current path, or the depth limit leaves it undecided.
   */
  async evaluateRelation(
    objectType: string,
    objectId: string,
    relation: string,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<EvaluationResult> {
    const undecided = (): EvaluationResult => {
      if (context.membership) context.membership.indeterminate = true;
      return 'unknown';
    };
    if (context.depth > context.max_depth) {
      log.warn(`Maximum depth (${context.max_depth}) exceeded`, {
        objectType,
        objectId,
      });
      return undecided();
    }
    const key = `${objectType}:${objectId}#${relation}`;
    if (context.visited.has(key)) return undecided();
    const path = new Set(context.visited);
    path.add(key);
    const next: RelationEvaluationContext = {
      ...context,
      object_type: objectType,
      object_id: objectId,
      visited: path,
    };
    const definition = context.definitions
      ? await context.definitions(objectType, relation)
      : await loadActiveDefinition(adapter, this, context.tenant_id, objectType, relation);
    if (definition.state === 'unusable') return undecided();
    if (definition.state === 'none') {
      return this.evaluateDirectRelation({ type: 'direct', relation }, next, adapter);
    }
    return this.evaluateExpression(definition.definition.definition, next, adapter);
  }

  /**
   * Evaluate an expression in three values (`unknown` grants nothing and is never cached).
   */
  async evaluateExpression(
    expression: RelationExpression,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<EvaluationResult> {
    if (context.depth > context.max_depth) {
      log.warn(`Maximum depth (${context.max_depth}) exceeded`, {
        userId: context.user_id,
        objectType: context.object_type,
        objectId: context.object_id,
      });
      if (context.membership) context.membership.indeterminate = true;
      return 'unknown';
    }

    switch (expression.type) {
      case 'direct':
        return this.evaluateDirectRelation(expression, context, adapter);
      case 'union':
        return this.evaluateUnionRelation(expression, context, adapter);
      case 'tuple_to_userset':
        return this.evaluateTupleToUsersetRelation(expression, context, adapter);
      case 'intersection':
        return this.evaluateIntersectionRelation(expression, context, adapter);
      case 'exclusion':
        return this.evaluateExclusionRelation(expression, context, adapter);
      default:
        if (context.membership) context.membership.indeterminate = true;
        return 'unknown';
    }
  }

  /**
   * Evaluate a direct relation: a request-specific (contextual) tuple, a stored tuple from the
   * subject, or a group userset the subject is a member of.
   */
  private async evaluateDirectRelation(
    expr: DirectRelation,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<EvaluationResult> {
    const grant = (how: string): EvaluationResult => {
      if (!context.negative && context.membership)
        context.membership.grants.push(
          `${context.object_type}:${context.object_id}#${expr.relation}@${how}`
        );
      return 'allow';
    };
    if (
      context.contextual?.some(
        (tuple) =>
          tuple.relation === expr.relation &&
          tuple.object_type === context.object_type &&
          tuple.object_id === context.object_id
      )
    ) {
      return grant('contextual_tuple');
    }

    // (object_type:object_id)#relation@(user_type:user_id)
    const results = await adapter.query<{ id: string; expires_at: number | string | null }>(
      `SELECT id, expires_at FROM relationships
       WHERE tenant_id = ?
         AND from_type <> 'group' -- a group tuple is a userset, matched below
         AND from_type = ?
         AND from_id = ?
         AND to_type = ?
         AND to_id = ?
         AND relationship_type = ?
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`,
      [
        context.tenant_id,
        context.user_type,
        context.user_id,
        context.object_type,
        context.object_id,
        expr.relation,
        Math.floor(Date.now() / 1000),
      ]
    );
    if (results.length > 0) {
      noteExpiry(context.membership, results[0].expires_at);
      return grant(results[0].id);
    }

    const userset = await matchGroupUserset(
      adapter,
      context,
      context.object_type,
      context.object_id,
      expr.relation
    );
    if (userset.result === 'allow') return grant(`group:${userset.groupId}#member`);
    return userset.result;
  }

  /**
   * Evaluate a union relation: allow when any child allows, else undecided when any child is.
   */
  private async evaluateUnionRelation(
    expr: UnionRelation,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<EvaluationResult> {
    let unknown = false;
    for (const child of expr.children) {
      const result = await this.evaluateExpression(child, context, adapter);
      if (result === 'allow') return 'allow';
      if (result === 'unknown') unknown = true;
    }
    return unknown ? 'unknown' : 'deny';
  }

  /**
   * Evaluate a tuple-to-userset relation
   *
   * Example: document#parent.viewer
   * 1. Find the parents of the document (the tupleset edges, from the document)
   * 2. Evaluate `viewer` on each parent as a relation of its own: through the parent type's
   *    active definition (its exclusion, or its being unusable, applies), one hop deeper on the
   *    same path
   */
  private async evaluateTupleToUsersetRelation(
    expr: TupleToUsersetRelation,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<EvaluationResult> {
    const relatedObjects = await adapter.query<{
      to_type: string;
      to_id: string;
      expires_at: number | string | null;
    }>(
      `SELECT to_type, to_id, expires_at FROM relationships
       WHERE tenant_id = ?
         AND from_type <> 'group' -- a group tuple is a userset, never an object edge
         AND from_type = ?
         AND from_id = ?
         AND relationship_type = ?
         AND (expires_at IS NULL OR expires_at > ?)`,
      [
        context.tenant_id,
        context.object_type,
        context.object_id,
        expr.tupleset.relation,
        Math.floor(Date.now() / 1000),
      ]
    );

    let unknown = false;
    for (const related of relatedObjects) {
      // An edge that expires changes what it leads to (noted whatever the answer through it).
      noteExpiry(context.membership, related.expires_at);
      const result = await this.evaluateRelation(
        related.to_type,
        related.to_id,
        expr.computed_userset.relation,
        { ...context, depth: context.depth + 1 },
        adapter
      );
      if (result === 'allow') return 'allow';
      if (result === 'unknown') unknown = true;
    }
    return unknown ? 'unknown' : 'deny';
  }

  /**
   * Evaluate an intersection relation: deny when any child denies, else undecided when any is.
   */
  private async evaluateIntersectionRelation(
    expr: IntersectionRelation,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<EvaluationResult> {
    let unknown = false;
    for (const child of expr.children) {
      const result = await this.evaluateExpression(child, context, adapter);
      if (result === 'deny') return 'deny';
      if (result === 'unknown') unknown = true;
    }
    return unknown ? 'unknown' : 'allow';
  }

  /**
   * Evaluate an exclusion relation: base allows and subtract denies. A subtract that cannot be
   * decided leaves the exclusion undecided (it is evaluated with the polarity flipped, so a
   * "not a member" it cannot trust is undecided; see userset.ts).
   */
  private async evaluateExclusionRelation(
    expr: ExclusionRelation,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<EvaluationResult> {
    const base = await this.evaluateExpression(expr.base, context, adapter);
    if (base === 'deny') return 'deny';
    const subtract = await this.evaluateExpression(
      expr.subtract,
      { ...context, negative: !context.negative },
      adapter
    );
    if (subtract === 'allow') return 'deny';
    if (base === 'unknown' || subtract === 'unknown') return 'unknown';
    return 'allow';
  }
}

/**
 * Why a relation definition (a stored `definition_json` string or a request's object) cannot be
 * evaluated: the parser's and the validator's errors; empty when it can. A definition with errors
 * is refused when saved, and a stored one denies every check on its relation.
 */
export function relationDefinitionErrors(input: unknown): string[] {
  const parser = new RelationParser();
  try {
    if (typeof input !== 'string' && (!input || typeof input !== 'object')) {
      return ['Invalid relation expression: must be an object'];
    }
    const expression = parser.parse(input);
    const errors = parser.validate(expression);
    if (directRelationNames(expression).size > MAX_DEFINITION_DIRECT_RELATIONS) {
      errors.push(
        `A definition may name at most ${MAX_DEFINITION_DIRECT_RELATIONS} distinct direct relations`
      );
    }
    return errors;
  } catch (error) {
    return [error instanceof Error ? error.message : 'Invalid relation expression'];
  }
}

/**
 * Create a fresh evaluation context
 */
export function createEvaluationContext(
  tenantId: string,
  userId: string,
  objectType: string,
  objectId: string,
  maxDepth: number = DEFAULT_MAX_DEPTH,
  usersets?: Pick<
    RelationEvaluationContext,
    'subject_groups' | 'membership' | 'contextual' | 'definitions' | 'service_decided_groups'
  >
): RelationEvaluationContext {
  return {
    tenant_id: tenantId,
    user_id: userId,
    user_type: 'subject', // Default to subject (user)
    object_type: objectType,
    object_id: objectId,
    depth: 0,
    max_depth: maxDepth,
    visited: new Set(),
    ...(usersets?.subject_groups && { subject_groups: usersets.subject_groups }),
    ...(usersets?.membership && { membership: usersets.membership }),
    ...(usersets?.contextual && { contextual: usersets.contextual }),
    ...(usersets?.definitions && { definitions: usersets.definitions }),
    ...(usersets?.service_decided_groups && {
      service_decided_groups: usersets.service_decided_groups,
    }),
  };
}

/**
 * Parse object string into type and ID
 * "document:doc_123" → { type: "document", id: "doc_123" }
 */
export function parseObjectString(object: string): { type: string; id: string } {
  const colonIndex = object.indexOf(':');
  if (colonIndex === -1) {
    // No colon, assume the whole string is the ID with unknown type
    return { type: 'unknown', id: object };
  }
  return {
    type: object.substring(0, colonIndex),
    id: object.substring(colonIndex + 1),
  };
}

/**
 * Build object string from type and ID
 */
export function buildObjectString(type: string, id: string): string {
  return `${type}:${id}`;
}
