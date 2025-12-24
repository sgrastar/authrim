/**
 * Infrastructure Layer
 *
 * This module exports infrastructure interfaces and implementations.
 * Application code uses this to access storage and policy infrastructure.
 *
 * Note: Plugin developers should NOT import from this module directly.
 * Use PluginContext.storage and PluginContext.policy instead.
 */

// Types
export type {
  // Storage Infrastructure
  IStorageInfra,
  StorageProvider,
  IStorageAdapter,
  ExecuteResult,
  TransactionContext,
  // Stores
  IUserStore,
  User,
  IClientStore,
  OAuthClient,
  ISessionStore,
  Session,
  IPasskeyStore,
  Passkey,
  // RBAC Stores
  IOrganizationStore,
  Organization,
  IRoleStore,
  Role,
  IRoleAssignmentStore,
  RoleAssignment,
  IRelationshipStore,
  Relationship,
  // Policy Infrastructure
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

// Storage Implementations
export {
  CloudflareStorageInfra,
  CloudflareStorageAdapter,
  createStorageInfra,
  type StorageInfraOptions,
} from './storage';

// Policy Implementations
export { BuiltinPolicyInfra, createPolicyInfra, type PolicyInfraOptions } from './policy';
