/**
 * Infrastructure Layer
 *
 * This module exports infrastructure INTERFACES only.
 * Implementations are provided by ar-lib-core (e.g., CloudflareStorageAdapter).
 *
 * Application code uses this to access storage and policy infrastructure.
 *
 * Note: Plugin developers should NOT import from this module directly.
 * Use PluginContext.storage and PluginContext.policy instead.
 *
 * Architecture:
 * - ar-lib-plugin: Interfaces (IStorageInfra, IPolicyInfra, IUserStore, etc.)
 * - ar-lib-core: Implementations (CloudflareStorageAdapter, UserStore, ReBACService, etc.)
 * - Workers: Inject ar-lib-core implementations into PluginContext
 */

// Types (Interfaces only - implementations are in ar-lib-core)
export type {
  // Storage Infrastructure Interface
  IStorageInfra,
  StorageProvider,
  IStorageAdapter,
  ExecuteResult,
  TransactionContext,
  // PII Classification Markers
  PIIStore,
  NonPIIStore,
  // Store Interfaces
  IUserStore,
  User,
  IClientStore,
  OAuthClient,
  ISessionStore,
  Session,
  IPasskeyStore,
  Passkey,
  // RBAC Store Interfaces
  IRoleStore,
  Role,
  IRoleAssignmentStore,
  RoleAssignment,
  IRelationshipStore,
  Relationship,
  // Policy Infrastructure Interface
  IPolicyInfra,
  PolicyProvider,
  // Policy Check Types
  CheckRequest,
  CheckResponse,
  BatchCheckRequest,
  BatchCheckResponse,
  ListObjectsRequest,
  ListObjectsResponse,
  ListUsersRequest,
  ListUsersResponse,
  // Rule Evaluation
  RuleEvaluationContext,
  RuleEvaluationResult,
  // Cache
  CacheInvalidationRequest,
  // Common
  InfraEnv,
  InfraHealthStatus,
} from './types';

// Policy Implementations (Built-in ReBAC - stays in ar-lib-plugin as reference implementation)
export { BuiltinPolicyInfra, createPolicyInfra, type PolicyInfraOptions } from './policy';
