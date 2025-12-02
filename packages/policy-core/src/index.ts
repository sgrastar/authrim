/**
 * @authrim/policy-core
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
 * } from '@authrim/policy-core';
 *
 * // Quick role check
 * const subject = subjectFromClaims(tokenClaims);
 * if (hasRole(subject, 'system_admin')) {
 *   // Allow access
 * }
 *
 * // Full policy evaluation
 * const engine = createDefaultPolicyEngine();
 * const decision = engine.evaluate({
 *   subject,
 *   resource: { type: 'organization', id: 'org_123' },
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
export { PolicyEngine, createDefaultPolicyEngine } from './engine';
export type { PolicyEngineConfig } from './engine';

// Role Checker utilities
export {
  hasRole,
  hasAnyRole,
  hasAllRoles,
  isAdmin,
  isSystemAdmin,
  isOrgAdmin,
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
