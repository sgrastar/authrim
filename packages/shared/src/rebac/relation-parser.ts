/**
 * Relation Parser Implementation
 *
 * Parses and evaluates Zanzibar-style relation expressions.
 *
 * Phase 3 MVP supports:
 * - direct: Direct relation tuple match
 * - union: OR of multiple expressions
 * - tuple_to_userset: Inherit from related object
 *
 * Phase 4+ will add:
 * - intersection: AND of multiple expressions
 * - exclusion: NOT expression
 */

import type {
  RelationExpression,
  DirectRelation,
  UnionRelation,
  TupleToUsersetRelation,
  IntersectionRelation,
  ExclusionRelation,
} from './types';
import type { IRelationParser, RelationEvaluationContext } from './interfaces';
import type { IStorageAdapter } from '../storage/interfaces';
import { DEFAULT_MAX_DEPTH } from './types';

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
  private parseExpression(obj: unknown): RelationExpression {
    if (!obj || typeof obj !== 'object') {
      throw new Error('Invalid relation expression: must be an object');
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
        return this.parseUnionRelation(expr);
      case 'tuple_to_userset':
        return this.parseTupleToUsersetRelation(expr);
      case 'intersection':
        return this.parseIntersectionRelation(expr);
      case 'exclusion':
        return this.parseExclusionRelation(expr);
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

  private parseUnionRelation(obj: Record<string, unknown>): UnionRelation {
    if (!Array.isArray(obj.children)) {
      throw new Error('Union relation must have an array "children" field');
    }
    return {
      type: 'union',
      children: obj.children.map((child) => this.parseExpression(child)),
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

  private parseIntersectionRelation(obj: Record<string, unknown>): IntersectionRelation {
    if (!Array.isArray(obj.children)) {
      throw new Error('Intersection relation must have an array "children" field');
    }
    return {
      type: 'intersection',
      children: obj.children.map((child) => this.parseExpression(child)),
    };
  }

  private parseExclusionRelation(obj: Record<string, unknown>): ExclusionRelation {
    if (!obj.base) {
      throw new Error('Exclusion relation must have a "base" expression');
    }
    if (!obj.subtract) {
      throw new Error('Exclusion relation must have a "subtract" expression');
    }
    return {
      type: 'exclusion',
      base: this.parseExpression(obj.base),
      subtract: this.parseExpression(obj.subtract),
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
   * Evaluate a relation expression
   */
  async evaluate(
    expression: RelationExpression,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<boolean> {
    // Check depth limit
    if (context.depth > context.max_depth) {
      console.warn(
        `ReBAC: Maximum depth (${context.max_depth}) exceeded for ${context.user_id} -> ${context.object_type}:${context.object_id}`
      );
      return false;
    }

    // Check visited to prevent cycles
    const visitKey = `${context.user_type}:${context.user_id}:${expression.type}:${context.object_type}:${context.object_id}`;
    if (context.visited.has(visitKey)) {
      return false;
    }
    context.visited.add(visitKey);

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
        return false;
    }
  }

  /**
   * Evaluate a direct relation - check for a direct tuple
   */
  private async evaluateDirectRelation(
    expr: DirectRelation,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<boolean> {
    // Check if there's a direct relationship tuple:
    // (object_type:object_id)#relation@(user_type:user_id)
    const results = await adapter.query<{ id: string }>(
      `SELECT id FROM relationships
       WHERE tenant_id = ?
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

    return results.length > 0;
  }

  /**
   * Evaluate a union relation - any child must match
   */
  private async evaluateUnionRelation(
    expr: UnionRelation,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<boolean> {
    // Short-circuit: return true as soon as any child matches
    for (const child of expr.children) {
      const result = await this.evaluate(child, context, adapter);
      if (result) {
        return true;
      }
    }
    return false;
  }

  /**
   * Evaluate a tuple-to-userset relation
   *
   * Example: document#parent.viewer
   * 1. Find the parent of the document (via tupleset relation)
   * 2. Check if the user has viewer relation on the parent (computed_userset)
   */
  private async evaluateTupleToUsersetRelation(
    expr: TupleToUsersetRelation,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<boolean> {
    // Step 1: Find objects related to the current object via the tupleset relation
    // For example, find all objects where: (current_object)#parent@(related_object)
    const relatedObjects = await adapter.query<{
      to_type: string;
      to_id: string;
    }>(
      `SELECT to_type, to_id FROM relationships
       WHERE tenant_id = ?
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

    // Step 2: For each related object, check if user has the computed_userset relation
    for (const related of relatedObjects) {
      // Create a new context for checking the related object
      const newContext: RelationEvaluationContext = {
        ...context,
        object_type: related.to_type,
        object_id: related.to_id,
        depth: context.depth + 1,
        // Keep the same visited set to prevent cycles
      };

      // Check if user has the computed relation on the related object
      const directCheck: DirectRelation = {
        type: 'direct',
        relation: expr.computed_userset.relation,
      };

      const hasRelation = await this.evaluate(directCheck, newContext, adapter);
      if (hasRelation) {
        return true;
      }

      // Recursively check computed relations on the related object
      // This handles nested hierarchies (e.g., folder → folder → folder → document)
      const tupleResult = await this.evaluateTupleToUsersetRelation(expr, newContext, adapter);
      if (tupleResult) {
        return true;
      }
    }

    return false;
  }

  /**
   * Evaluate an intersection relation - all children must match
   * Phase 4+ feature
   */
  private async evaluateIntersectionRelation(
    expr: IntersectionRelation,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<boolean> {
    // All children must match
    for (const child of expr.children) {
      const result = await this.evaluate(child, context, adapter);
      if (!result) {
        return false;
      }
    }
    return true;
  }

  /**
   * Evaluate an exclusion relation - base must match, subtract must not
   * Phase 4+ feature
   */
  private async evaluateExclusionRelation(
    expr: ExclusionRelation,
    context: RelationEvaluationContext,
    adapter: IStorageAdapter
  ): Promise<boolean> {
    const baseResult = await this.evaluate(expr.base, context, adapter);
    if (!baseResult) {
      return false;
    }

    const subtractResult = await this.evaluate(expr.subtract, context, adapter);
    return !subtractResult;
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
  maxDepth: number = DEFAULT_MAX_DEPTH
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
