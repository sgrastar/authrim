/**
 * Check API Type Definitions
 *
 * Phase 8.3: Real-time Check API Model
 *
 * Unified permission check types supporting:
 * - ID-level permissions (resource:id:action)
 * - Type-level permissions (resource:action)
 * - ReBAC relationship checks
 * - RBAC role-based checks
 */

// =============================================================================
// Permission Types
// =============================================================================

/**
 * Permission string format (recommended)
 * - Type-level: "resource:action" (e.g., "documents:read")
 * - ID-level: "resource:id:action" (e.g., "documents:doc_123:read")
 *
 * Constraints:
 * - resource, id, action must be URL-safe ([a-zA-Z0-9_-])
 * - Colon (:) is forbidden in values (used as delimiter)
 */
export type PermissionString = string;

/**
 * Structured permission object (for complex resource IDs)
 */
export interface PermissionObject {
  /** Resource type (e.g., "documents", "projects") */
  resource: string;
  /** Resource ID (optional, omit for type-level permissions) */
  id?: string;
  /** Action name (e.g., "read", "write", "delete") */
  action: string;
}

/**
 * Permission input - accepts string or structured object
 */
export type PermissionInput = PermissionString | PermissionObject;

/**
 * Parsed permission with type information
 */
export interface ParsedPermission {
  /** Permission type */
  type: 'id_level' | 'type_level';
  /** Resource type */
  resource: string;
  /** Resource ID (only for id_level) */
  id?: string;
  /** Action name */
  action: string;
  /** Original input (for logging/debugging) */
  original: PermissionInput;
}

// =============================================================================
// Check Request Types
// =============================================================================

/**
 * Resource context for ABAC evaluation
 */
export interface ResourceContext {
  /** Resource type override */
  type?: string;
  /** Resource owner ID */
  owner_id?: string;
  /** Organization ID */
  org_id?: string;
  /** Additional attributes for ABAC */
  attributes?: Record<string, unknown>;
}

/**
 * Contextual tuple for temporary relationships
 * These are evaluated only for this request and not persisted.
 */
export interface ContextualTupleInput {
  /** User identifier (e.g., "user:user_123" or "user_123") */
  user_id: string;
  /** Relation (e.g., "viewer", "editor", "owner") */
  relation: string;
  /** Object identifier (e.g., "document:doc_456") */
  object: string;
}

/**
 * ReBAC check parameters
 */
export interface ReBACCheckParams {
  /** Relation to check (e.g., "viewer", "editor", "owner") */
  relation: string;
  /** Object to check against (e.g., "document:doc_123") */
  object: string;
  /** Temporary relationships to consider during this check only */
  contextual_tuples?: ContextualTupleInput[];
}

/**
 * Check API request
 */
export interface CheckApiRequest {
  /** Subject ID (user or service ID) */
  subject_id: string;
  /** Subject type (default: 'user') */
  subject_type?: 'user' | 'service';
  /** Permission to check */
  permission: PermissionInput;
  /** Tenant ID (default: 'default') */
  tenant_id?: string;
  /** Resource context for ABAC evaluation */
  resource_context?: ResourceContext;
  /** Optional ReBAC check parameters */
  rebac?: ReBACCheckParams;
}

/**
 * Batch check request
 */
export interface BatchCheckRequest {
  /** Array of check requests */
  checks: CheckApiRequest[];
  /** Stop processing on first deny (default: false) */
  stop_on_deny?: boolean;
}

// =============================================================================
// Check Response Types
// =============================================================================

/**
 * Resolution method - how the permission was resolved
 */
export type ResolvedVia = 'direct' | 'role' | 'rebac' | 'id_level' | 'computed';

/**
 * Final decision
 */
export type FinalDecision = 'allow' | 'deny';

/**
 * Debug information (optional, enabled by feature flag)
 */
export interface CheckDebugInfo {
  /** Rules that matched */
  matched_rules?: string[];
  /** Resolution path (for ReBAC) */
  path?: string[];
  /** Evaluation time in milliseconds */
  evaluation_time_ms?: number;
}

/**
 * Check API response
 */
export interface CheckApiResponse {
  /** Whether the permission is allowed */
  allowed: boolean;
  /** How the permission was resolved (array for future composability) */
  resolved_via: ResolvedVia[];
  /** Final decision (explicit for clarity) */
  final_decision: FinalDecision;
  /** Debug information (when enabled) */
  debug?: CheckDebugInfo;
  /** Suggested client-side cache TTL in seconds */
  cache_ttl?: number;
  /** Reason for denial (when denied) */
  reason?: string;
}

/**
 * Batch check response summary
 */
export interface BatchCheckSummary {
  /** Total checks performed */
  total: number;
  /** Number of allowed checks */
  allowed: number;
  /** Number of denied checks */
  denied: number;
  /** Total evaluation time in milliseconds */
  evaluation_time_ms?: number;
}

/**
 * Batch check response
 */
export interface BatchCheckResponse {
  /** Results in the same order as requests */
  results: CheckApiResponse[];
  /** Summary statistics */
  summary: BatchCheckSummary;
}

// =============================================================================
// Permission Change Event Types (for WebSocket Push)
// =============================================================================

/**
 * Permission change event type
 */
export type PermissionChangeEventType = 'grant' | 'revoke' | 'modify';

/**
 * Permission change event
 */
export interface PermissionChangeEvent {
  /** Event type */
  event: PermissionChangeEventType;
  /** Tenant ID */
  tenant_id: string;
  /** Subject ID whose permissions changed */
  subject_id: string;
  /** Resource affected (optional) */
  resource?: string;
  /** Relation affected (optional) */
  relation?: string;
  /** Permission affected (optional) */
  permission?: string;
  /** Event timestamp (Unix milliseconds) */
  timestamp: number;
}

// =============================================================================
// WebSocket Message Types
// =============================================================================

/**
 * WebSocket subscribe message (client -> server)
 */
export interface WSSubscribeMessage {
  type: 'subscribe';
  /** Subject ID for authentication */
  subject_id?: string;
  /** Subjects to watch (default: authenticated user) */
  subjects?: string[];
  /** Resource patterns to watch (e.g., "document:*") */
  resources?: string[];
  /** Relations to watch (e.g., "viewer") */
  relations?: string[];
}

/**
 * WebSocket unsubscribe message (client -> server)
 */
export interface WSUnsubscribeMessage {
  type: 'unsubscribe';
  subscription_id: string;
}

/**
 * WebSocket ping message (client -> server)
 */
export interface WSPingMessage {
  type: 'ping';
  timestamp: number;
}

/**
 * WebSocket client message union
 */
export type WSClientMessage = WSSubscribeMessage | WSUnsubscribeMessage | WSPingMessage;

/**
 * WebSocket subscribed confirmation (server -> client)
 */
export interface WSSubscribedMessage {
  type: 'subscribed';
  subscription_id: string;
  subscriptions: {
    subjects: string[];
    resources: string[];
    relations: string[];
  };
}

/**
 * WebSocket permission change notification (server -> client)
 */
export interface WSPermissionChangeMessage {
  type: 'permission_change';
  event: PermissionChangeEventType;
  subject_id: string;
  resource?: string;
  relation?: string;
  permission?: string;
  timestamp: number;
  /** Signal to invalidate client-side cache */
  invalidate_cache: boolean;
}

/**
 * WebSocket pong message (server -> client)
 */
export interface WSPongMessage {
  type: 'pong';
  timestamp: number;
}

/**
 * WebSocket error message (server -> client)
 */
export interface WSErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

/**
 * WebSocket server message union
 */
export type WSServerMessage =
  | WSSubscribedMessage
  | WSPermissionChangeMessage
  | WSPongMessage
  | WSErrorMessage;

// =============================================================================
// API Key Types
// =============================================================================

/**
 * Allowed operations for API key
 */
export type CheckApiOperation = 'check' | 'batch' | 'subscribe';

/**
 * Rate limit tier
 */
export type RateLimitTier = 'strict' | 'moderate' | 'lenient';

/**
 * Check API key (stored in database)
 */
export interface CheckApiKey {
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  allowed_operations: CheckApiOperation[];
  rate_limit_tier: RateLimitTier;
  is_active: boolean;
  expires_at?: number;
  created_by?: string;
  created_at: number;
  updated_at: number;
}

/**
 * Check API key creation request
 */
export interface CreateCheckApiKeyRequest {
  client_id: string;
  name: string;
  allowed_operations?: CheckApiOperation[];
  rate_limit_tier?: RateLimitTier;
  expires_at?: number;
}

/**
 * Check API key creation response (includes plaintext key once)
 */
export interface CreateCheckApiKeyResponse {
  id: string;
  /** Plaintext API key (only returned once at creation) */
  api_key: string;
  key_prefix: string;
  name: string;
  client_id: string;
  allowed_operations: CheckApiOperation[];
  rate_limit_tier: RateLimitTier;
  expires_at?: number;
  created_at: number;
}

// =============================================================================
// Audit Log Types
// =============================================================================

/**
 * Permission check audit log entry
 */
export interface PermissionCheckAuditLog {
  id: string;
  tenant_id: string;
  subject_id: string;
  permission: string;
  permission_json?: string;
  allowed: boolean;
  resolved_via_json: string;
  final_decision: FinalDecision;
  reason?: string;
  api_key_id?: string;
  client_id?: string;
  checked_at: number;
}

// =============================================================================
// Feature Flag Types
// =============================================================================

/**
 * Check API feature flags
 */
export interface CheckApiFeatureFlags {
  /** Master switch for Check API */
  ENABLE_CHECK_API: boolean;
  /** Enable audit logging */
  ENABLE_CHECK_API_AUDIT: boolean;
  /** Enable debug info in responses */
  ENABLE_CHECK_API_DEBUG: boolean;
  /** Enable WebSocket push notifications */
  ENABLE_CHECK_API_WEBSOCKET: boolean;
}

/**
 * Audit log configuration
 */
export interface AuditLogConfig {
  /** How to log deny events */
  log_deny: 'always';
  /** How to log allow events */
  log_allow: 'always' | 'sample' | 'never';
  /** Sample rate for allow events (0.01 = 1%, 0.1 = 10%, 1.0 = 100%) */
  allow_sample_rate: number;
}

// =============================================================================
// ABAC Attribute Types
// =============================================================================

/**
 * Verified attribute for ABAC evaluation within Check API
 * Simplified version for internal use
 */
export interface VerifiedAttributeForCheck {
  /** Attribute name */
  name: string;
  /** Attribute value */
  value: string | null;
  /** Source of the attribute */
  source: 'db' | 'vc' | 'manual' | 'context';
  /** Expiration timestamp (UNIX seconds) */
  expiresAt?: number;
}

/**
 * Attribute repository interface for ABAC
 * Used by UnifiedCheckService to fetch user attributes
 */
export interface AttributeRepository {
  /** Get all valid (non-expired) attributes for a user */
  getValidAttributesForUser(tenantId: string, userId: string): Promise<Record<string, string>>;
}

// =============================================================================
// Policy Evaluator Interface (for ABAC integration)
// =============================================================================

/**
 * Policy evaluation context for ABAC
 * Minimal interface to avoid circular dependencies with ar-lib-policy
 */
/** A role assignment as attribute-based rules see it. */
export interface PolicySubjectRole {
  name: string;
  /** Where the assignment applies: everywhere, one organization, or one resource. */
  scope: 'global' | 'org' | 'resource';
  /** The organization or resource of a scoped assignment (e.g. 'org:org_123'). */
  scopeTarget?: string;
  /** When the assignment ends (UNIX milliseconds). */
  expiresAt?: number;
}

export interface PolicyEvaluationContext {
  /** Subject ID */
  subjectId: string;
  /** The subject's active role assignments in the tenant, with their scope (for role conditions) */
  subjectRoles?: PolicySubjectRole[];
  /** Subject's verified attributes */
  verifiedAttributes: VerifiedAttributeForCheck[];
  /** Resource type */
  resourceType: string;
  /** Resource ID (optional) */
  resourceId?: string;
  /** Resource owner ID (optional) */
  resourceOwnerId?: string;
  /** Resource organization ID (optional) */
  resourceOrgId?: string;
  /** Resource attributes (optional) */
  resourceAttributes?: Record<string, unknown>;
  /** Action being performed */
  action: string;
  /** Timestamp */
  timestamp: number;
  /** Environment context (IP, country, etc.) */
  environment?: {
    clientIp?: string;
    countryCode?: string;
    timezone?: string;
    [key: string]: unknown;
  };
}

/**
 * Policy evaluation result
 */
export interface PolicyEvaluationResult {
  /** Whether access is allowed */
  allowed: boolean;
  /** Reason for the decision */
  reason?: string;
  /** Which rule made the decision */
  decidedBy?: string;
}

/**
 * Policy evaluator interface
 * Allows injecting PolicyEngine without circular dependency
 */
export interface PolicyEvaluator {
  /** Evaluate policy for the given context */
  evaluate(context: PolicyEvaluationContext): PolicyEvaluationResult;
}

/**
 * How a tenant's permission checks use attribute-based policy, as its settings decide
 * (`feature.enable_abac`, `enable_verified_attributes`, `enable_custom_rules`,
 * `enable_policy_logging`).
 */
export interface TenantPolicySettings {
  /** Evaluate the evaluator after roles, ID-level permissions and relationships found no grant */
  abac: boolean;
  /** Load the subject's verified attributes for the evaluator */
  verifiedAttributes: boolean;
  /** Log each decision */
  logDecisions: boolean;
  /** The tenant's rules (its custom rules), when attribute-based policy is on */
  evaluator?: PolicyEvaluator;
  /**
   * The settings or rules could not be read: attribute-based policy is off for the check, and
   * its result is not cached (it must not outlive the outage).
   */
  unavailable?: boolean;
}
