/**
 * @authrim/ar-lib-policy
 *
 * Core policy evaluation engine for RBAC/ABAC.
 *
 * Phase 1: Role-based access control with scoped roles.
 *
 * @example
 * ```typescript
 * import {
 *   PolicyEngine,
 *   createDefaultPolicyEngine,
 *   hasRole,
 *   hasAnyRole,
 *   isAdmin,
 *   subjectFromClaims
 * } from '@authrim/ar-lib-policy';
 *
 * // Quick role check
 * const subject = subjectFromClaims(tokenClaims);
 * if (hasRole(subject, 'admin')) {
 *   // Allow access
 * }
 *
 * // Full policy evaluation
 * const engine = createDefaultPolicyEngine();
 * const decision = engine.evaluate({
 *   subject,
 *   resource: { type: 'document', id: 'doc_123' },
 *   action: { name: 'manage' },
 *   timestamp: Date.now()
 * });
 *
 * if (decision.allowed) {
 *   // Allow access
 * }
 * ```
 */

// Types
export type {
  PolicySubject,
  SubjectRole,
  SubjectRelationship,
  RelationshipType,
  PolicyResource,
  PolicyAction,
  PolicyContext,
  PolicyDecision,
  PolicyRule,
  PolicyCondition,
  ConditionType,
  // ABAC types (Phase 3)
  VerifiedAttribute,
  PolicySubjectWithAttributes,
} from './types';

// Policy Engine
export {
  PolicyEngine,
  createDefaultPolicyEngine,
  isKnownConditionType,
  validatePolicyConditions,
  CHECK_API_CONDITION_TYPES,
  ATTRIBUTE_CONDITION_TYPES,
  GROUP_CONDITION_TYPES,
} from './engine';
export type { PolicyEngineConfig } from './engine';

// A tenant's custom rules (Check API and policy simulation)
export {
  toTenantPolicyRule,
  evaluateTenantRules,
  tenantRulesUnusableReason,
  toTenantPolicyContext,
  createTenantRuleEvaluator,
  readTenantPolicyRules,
  tenantRulesUseGroups,
  tenantRulesNeedServiceGroups,
  dynamicGroupConditionProblem,
} from './tenant-rules';
export type { ServiceGroupDecided } from './tenant-rules';
// The policy service's rule cache lifetime (shared with the group delegation guard in ar-lib-core).
export { TENANT_POLICY_RULES_CACHE_TTL_MS } from '@authrim/ar-lib-core';
export type { TenantPolicyRule, TenantPolicyRuleRow } from './tenant-rules';

// Role Checker utilities
export {
  hasRole,
  hasAnyRole,
  hasAllRoles,
  isAdmin,
  getActiveRoles,
  subjectFromClaims,
} from './role-checker';
export type { RoleCheckOptions } from './role-checker';

// Feature Flags
export {
  FeatureFlagsManager,
  createFeatureFlagsManager,
  getFlagsFromEnv,
  DEFAULT_FLAGS,
  FLAG_NAMES,
} from './feature-flags';
export type { PolicyFeatureFlags, FlagName, KVNamespace } from './feature-flags';
