/**
 * Claim Scope Evaluator
 *
 * Evaluates whether a custom claim schema should be included
 * based on the granted scopes and the schema's required_scopes / scope_mode.
 */

import type { ClaimTarget, CustomClaimSchema } from './resolver';

export class ClaimScopeEvaluator {
  /**
   * Determine if a schema should be included for the given target and scopes.
   *
   * - VC target: always include (is_vc_claim itself is admin permission)
   * - No required_scopes or empty array: always include
   * - scope_mode='all': all required scopes must be granted
   * - scope_mode='any': at least one required scope must be granted
   */
  shouldInclude(schema: CustomClaimSchema, grantedScopes: string[], target: ClaimTarget): boolean {
    // VC target skips scope evaluation
    if (target === 'vc') return true;

    // Parse required_scopes (stored as JSON string)
    let requiredScopes: string[];
    if (!schema.required_scopes) {
      return true;
    }
    if (typeof schema.required_scopes === 'string') {
      try {
        requiredScopes = JSON.parse(schema.required_scopes);
      } catch {
        return true;
      }
    } else {
      requiredScopes = schema.required_scopes as unknown as string[];
    }

    if (!Array.isArray(requiredScopes) || requiredScopes.length === 0) {
      return true;
    }

    const grantedSet = new Set(grantedScopes);

    if (schema.scope_mode === 'all') {
      return requiredScopes.every((s) => grantedSet.has(s));
    }

    // Default: 'any'
    return requiredScopes.some((s) => grantedSet.has(s));
  }
}
