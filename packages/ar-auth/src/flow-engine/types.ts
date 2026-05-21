/**
 * Flow Engine - three-layer IR type definitions
 *
 * Architecture principles:
 * - GraphDefinition (for editing): Used by Admin UI / Flow Designer
 * - CompiledPlan (for execution): Flow Engine references it at runtime
 * - RuntimeState (for DO storage): Persisted to Durable Object
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import type {
  ProfileId,
  Intent,
  CapabilityType,
  CapabilityHints,
  ValidationRule,
  UIContract,
  StabilityLevel,
} from '@authrim/ar-lib-core';

// =============================================================================
// Layer 1: GraphDefinition (for editing)
// Used by Admin UI / Flow Designer.Optimized for visual editing.
// =============================================================================

/**
 * GraphDefinition - Admin UI / Flow Designerfor
 * Format optimized for visual editing
 */
export interface GraphDefinition {
  /** Unique identifier */
  id: string;

  /** Flow definition version (semantic version e.g., "1.0.0") */
  flowVersion: string;

  /** Flow name */
  name: string;

  /** Flow description */
  description: string;

  /** target profile */
  profileId: ProfileId;

  /** Node definitions */
  nodes: GraphNode[];

  /** Edge definitions */
  edges: GraphEdge[];

  /** Metadata */
  metadata: GraphMetadata;
}

/**
 * Graph node - each step in the flow
 */
export interface GraphNode {
  /** Unique node identifier */
  id: string;

  /** Node type */
  type: GraphNodeType;

  /** UI position (Flow Designerfor) */
  position: { x: number; y: number };

  /** Node data */
  data: GraphNodeData;
}

/**
 * Node data
 */
export interface GraphNodeData {
  /** Display label */
  label: string;

  /** Intent (intent/purpose) */
  intent: Intent;

  /** Capability template */
  capabilities: CapabilityTemplate[];

  /** Node-specific settings */
  config: Record<string, unknown>;
}

/**
 * Node type
 *
 * Design principles:
 * - selection = UI node (chosen by the user)
 * - decision = Check/Resolve node (decided by the system)
 * - execution = Action node (performs side effects)
 * - control = Control node (flow control)
 */
export type GraphNodeType =
  // === 1. Control Nodes (control nodes)===
  | 'start' // flow start
  | 'end' // flow end
  | 'goto' // jump within the flow (for loops and shared processing)

  // === 2. State/Check Nodes (state/check nodes)===
  | 'check_session' // check for a session
  | 'check_auth_level' // ACR/strength check
  | 'check_first_login' // first login check
  | 'check_user_attribute' // user attribute check
  | 'check_context' // client/locale/ip/country
  | 'check_risk' // risk score

  // === 3. Selection/UI Nodes (selection/input nodes)===
  | 'auth_method_select' // authentication method selection (email, social, etc.)
  | 'login_method_select' // login method selection (passkey, OTP, etc.)
  | 'identifier' // identifier input (email/phone/username)
  | 'profile_input' // profile input (name/birthdate, etc.)
  | 'custom_form' // administrator-defined form
  | 'information' // information only (read-only)
  | 'challenge' // CAPTCHA/Bot challenge

  // === 4. Authentication Nodes (authentication execution nodes)===
  | 'login' // authentication execution (passkey/otp/password/social)
  | 'mfa' // additional authentication (TOTP/SMS/WebAuthn)
  | 'register' // registration

  // === 5. Consent/Profile Nodes (consent/profile nodes)===
  | 'consent' // terms of service・consent
  | 'check_consent_status' // check consent status
  | 'record_consent' // consent recording (for audit)

  // === 6. Resolve Nodes (resolve nodes - important)===
  | 'resolve_tenant' // tenant resolution (from email domain, etc.)
  | 'resolve_org' // organization resolution
  | 'resolve_policy' // policy resolution

  // === 7. Session/Token Nodes (session/token nodes)===
  | 'issue_tokens' // issue tokens
  | 'refresh_session' // refresh session
  | 'revoke_session' // force logout
  | 'bind_device' // device binding
  | 'link_account' // social linking / identity stitching

  // === 8. Side Effect Nodes (external integration / side effects)===
  | 'redirect' // semantic redirect
  | 'webhook' // external notification
  | 'event_emit' // emit internal event (audit/analytics)
  | 'email_send' // send email
  | 'sms_send' // SMSsubmit
  | 'push_notify' // push notification

  // === 9. Logic/Decision Nodes (condition/branch nodes)===
  | 'decision' // compound condition branch
  | 'switch' // enum branching (locale/client_type)

  // === 10. Policy Nodes (policy decision)===
  | 'policy_check' // RBAC/ABAC/ReBAC decision

  // === 11. Error/Debug Nodes ===
  | 'error' // error display (retry/support)
  | 'log' // logging (for development)

  // === Legacy (deprecated, kept for migration) ===
  | 'auth_method' // → auth_method_select migrate to
  | 'user_input' // → profile_input/custom_form migrate to
  | 'condition' // → decision migrate to
  | 'check_user' // → check_user_attribute migrate to
  | 'set_variable' // → to internal processing
  | 'call_api' // → webhook merge into
  | 'send_notification' // → email_send/sms_send/push_notify split into
  | 'risk_check' // → check_risk migrate to
  | 'wait_input'; // → custom_form migrate to

// =============================================================================
// Condition Types - for condition evaluation
// =============================================================================

/**
 * Condition key - data path to evaluate
 * Designed with Descope dynamic keys as a reference
 */
export type ConditionKey =
  // === User Attributes ===
  | 'user.id'
  | 'user.email'
  | 'user.emailDomain'
  | 'user.phone'
  | 'user.verifiedEmail'
  | 'user.verifiedPhone'
  | 'user.status'
  | 'user.tenantIds'
  | 'user.roles'
  | 'user.permissions'
  | `user.customAttributes.${string}`

  // === Authentication State ===
  | 'user.isLoggedIn'
  | 'user.hasPassword'
  | 'user.hasTotp'
  | 'user.hasWebAuthn'
  | 'user.hasSocialLogin'
  | 'user.mfaEnabled'

  // === Authentication History ===
  | 'lastAuth.time'
  | 'lastAuth.method'
  | 'lastAuth.country'
  | 'lastAuth.city'
  | 'lastAuth.ip'

  // === Device & Context ===
  | 'device.type'
  | 'device.os'
  | 'device.browser'
  | 'device.webAuthnSupport'
  | 'device.trustedDevice'

  // === Location & IP ===
  | 'request.country'
  | 'request.city'
  | 'request.ip'
  | 'request.isVPN'
  | 'request.isTor'

  // === Risk Assessment ===
  | 'risk.score'
  | 'risk.botDetected'
  | 'risk.impossibleTravel'
  | 'risk.newDevice'
  | 'risk.newLocation'

  // === Tenant & Client Context ===
  | 'tenant.id'
  | 'tenant.name'
  | 'tenant.enforceSSO'
  | 'tenant.allowedAuthMethods'
  | 'client.id'
  | 'client.type'

  // === Form Input ===
  | 'form.email'
  | 'form.phone'
  | 'form.identifier'
  | `form.${string}`

  // === Previous Node Results ===
  | 'prevNode.success'
  | 'prevNode.result'
  | 'prevNode.error'
  | 'prevNode.errorCode'

  // === Flow Variables ===
  | `var.${string}`;

/**
 * Condition operator
 */
export type ConditionOperator =
  | 'equals' // ==
  | 'notEquals' // !=
  | 'contains' // string/array contains
  | 'notContains' // string/array not contains
  | 'startsWith' // string starts with
  | 'endsWith' // string ends with
  | 'greaterThan' // >
  | 'lessThan' // <
  | 'greaterOrEqual' // >=
  | 'lessOrEqual' // <=
  | 'in' // value in array
  | 'notIn' // value not in array
  | 'exists' // not null/undefined
  | 'notExists' // null/undefined
  | 'matches' // regex match
  | 'isTrue' // boolean true (no value needed)
  | 'isFalse'; // boolean false (no value needed)

/**
 * Single condition
 */
export interface FlowCondition {
  /** Condition key */
  key: ConditionKey | string; // allow custom keys as strings

  /** Operator */
  operator: ConditionOperator;

  /** Comparison value (not needed for isTrue/isFalse) */
  value?: unknown;
}

/**
 * Condition group (combination of multiple conditions)
 */
export interface ConditionGroup {
  /** Logical operator */
  logic: 'and' | 'or';

  /** Condition list */
  conditions: (FlowCondition | ConditionGroup)[];
}

/**
 * Node output - previous node result
 */
export interface NodeOutput {
  /** Success/failure */
  success: boolean;

  /** Result value (string, number, boolean, or object) */
  result?: string | number | boolean | Record<string, unknown>;

  /** Error information */
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Flow runtime context - used during condition evaluation
 */
export interface FlowRuntimeContext {
  // === User ===
  user?: {
    id?: string;
    email?: string;
    emailDomain?: string;
    phone?: string;
    verifiedEmail?: boolean;
    verifiedPhone?: boolean;
    status?: 'active' | 'disabled' | 'invited';
    tenantIds?: string[];
    roles?: string[];
    permissions?: string[];
    customAttributes?: Record<string, unknown>;
    isLoggedIn?: boolean;
    hasPassword?: boolean;
    hasTotp?: boolean;
    hasWebAuthn?: boolean;
    hasSocialLogin?: boolean;
    mfaEnabled?: boolean;
  };

  // === Last Auth ===
  lastAuth?: {
    time?: number;
    method?: string;
    country?: string;
    city?: string;
    ip?: string;
  };

  // === Device ===
  device?: {
    type?: 'mobile' | 'desktop' | 'tablet';
    os?: string;
    browser?: string;
    webAuthnSupport?: boolean;
    trustedDevice?: boolean;
  };

  // === Request ===
  request?: {
    country?: string;
    city?: string;
    ip?: string;
    isVPN?: boolean;
    isTor?: boolean;
  };

  // === Risk ===
  risk?: {
    score?: number;
    botDetected?: boolean;
    impossibleTravel?: boolean;
    newDevice?: boolean;
    newLocation?: boolean;
  };

  // === Tenant & Client ===
  tenant?: {
    id?: string;
    name?: string;
    enforceSSO?: boolean;
    allowedAuthMethods?: string[];
  };
  client?: {
    id?: string;
    type?: 'public' | 'confidential';
  };

  // === Form Input ===
  form?: Record<string, unknown>;

  // === Previous Node ===
  prevNode?: NodeOutput;

  // === Flow Variables ===
  variables?: Record<string, unknown>;
}

// =============================================================================
// Decision/Switch Node Configurations
// =============================================================================

/**
 * Decision Node Configuration - N-way conditional node
 * Evaluate each branch condition and transition to the first matching branch
 */
export interface DecisionNodeConfig {
  /** Branch list (evaluated in priority order) */
  branches: DecisionBranch[];

  /** Default branch (when no condition matches) */
  defaultBranch?: string;
}

/**
 * Decision Branch - single branch definition
 */
export interface DecisionBranch {
  /** Branch ID (sourceHandle ID) */
  id: string;

  /** Display label */
  label: string;

  /** Branch condition */
  condition: FlowCondition | ConditionGroup;

  /** Priority (lower values are evaluated first; same priority uses definition order) */
  priority: number;
}

/**
 * Switch Node Configuration - enum-value branching
 * Determine the branch target from a specific key value
 */
export interface SwitchNodeConfig {
  /** Key to evaluate */
  switchKey: ConditionKey | string;

  /** case Branch list */
  cases: SwitchCase[];

  /** Default case (when no case matches) */
  defaultCase?: string;
}

/**
 * Switch Case - single case definition
 */
export interface SwitchCase {
  /** caseID (sourceHandle ID) */
  id: string;

  /** Display label */
  label: string;

  /** List of matching values */
  values: (string | number | boolean)[];
}

/**
 * Graph edge - transition between nodes
 */
export interface GraphEdge {
  /** Edge unique identifier */
  id: string;

  /** Source node ID */
  source: string;

  /** Target node ID */
  target: string;

  /** Source handle (for multiple outputs) */
  sourceHandle?: string;

  /** Target handle (for multiple inputs) */
  targetHandle?: string;

  /** Edge type */
  type: GraphEdgeType;

  /** Edge data */
  data?: GraphEdgeData;
}

/**
 * Edge data
 */
export interface GraphEdgeData {
  /** Display label */
  label?: string;

  /** Transition condition (for conditional type) */
  condition?: EdgeCondition;
}

/**
 * Edge type
 */
export type GraphEdgeType = 'success' | 'error' | 'conditional';

/**
 * Edge condition
 */
export interface EdgeCondition {
  /** Condition type */
  type: 'capability_result' | 'policy_check' | 'feature_flag' | 'custom';

  /** Evaluation expression (JSONPath-like or JavaScript expression) */
  expression: string;
}

/**
 * Graph metadata
 */
export interface GraphMetadata {
  /** Created at (ISO 8601) */
  createdAt: string;

  /** Updated at (ISO 8601) */
  updatedAt: string;

  /** Created by (user_id) */
  createdBy?: string;
}

/**
 * Capability template - resolved during UIContract generation
 */
export interface CapabilityTemplate {
  /** Capability type */
  type: CapabilityType;

  /** ID suffix (Full ID is `${nodeId}_${idSuffix}`) */
  idSuffix: string;

  /** Required flag */
  required: boolean;

  /** Hint template */
  hintsTemplate?: Partial<CapabilityHints>;

  /** Validation rules */
  validationRules?: ValidationRule[];
}

// =============================================================================
// Layer 2: CompiledPlan (for execution)
// Flow Engine references it at runtime.optimized format.
// =============================================================================

/**
 * CompiledPlan - Flow Enginefor execution
 * Optimized form compiled from GraphDefinition
 */
export interface CompiledPlan {
  /** Compiled plan ID */
  id: string;

  /** Version of the CompiledPlan itself */
  version: string;

  /** flowVersion from the source GraphDefinition */
  sourceVersion: string;

  /** target profile */
  profileId: ProfileId;

  /** Entry point node ID */
  entryNodeId: string;

  /** Node map (id -> CompiledNode) */
  nodes: Map<string, CompiledNode>;

  /** Transition map (sourceNodeId -> CompiledTransition[]) */
  transitions: Map<string, CompiledTransition[]>;

  /** Compiled at (ISO 8601) */
  compiledAt: string;
}

/**
 * Compiled node
 */
export interface CompiledNode {
  /** Node ID */
  id: string;

  /** Node type */
  type: GraphNodeType;

  /** Intent */
  intent: Intent;

  /** Resolved Capability */
  capabilities: ResolvedCapability[];

  /** Next node ID on success (null means terminal) */
  nextOnSuccess: string | null;

  /** Next node ID on error (null means default error handling) */
  nextOnError: string | null;

  /** Decision/Switch settings (matching nodes only) */
  decisionConfig?: DecisionNodeConfig | SwitchNodeConfig;
}

/**
 * Compiled transition
 */
export interface CompiledTransition {
  /** Target node ID */
  targetNodeId: string;

  /** Transition type */
  type: 'success' | 'error' | 'conditional';

  /** Compiled condition (for conditional type) */
  condition?: CompiledCondition;

  /** Source handle (Decision/Switch nodefor) */
  sourceHandle?: string;

  /** Priority (Decision branch evaluation order) */
  priority?: number;
}

/**
 * Compiled condition
 */
export interface CompiledCondition {
  /** Condition type */
  type: 'capability_result' | 'policy_check' | 'feature_flag' | 'custom';

  /** Source expression */
  expression: string;

  /** Evaluation function (generated at compile time) */
  evaluate: (context: EvaluationContext) => boolean;
}

/**
 * Condition evaluation context
 */
export interface EvaluationContext {
  /** Collected data */
  collectedData: Record<string, unknown>;

  /** Completed Capability IDs */
  completedCapabilities: string[];

  /** User claims */
  claims?: Record<string, unknown>;

  /** Feature flags */
  featureFlags?: Record<string, boolean>;
}

/**
 * Resolved Capability
 */
export interface ResolvedCapability {
  /** Capability type */
  type: CapabilityType;

  /** Full ID (`${nodeId}_${idSuffix}`) */
  id: string;

  /** Required flag */
  required: boolean;

  /** Resolved hints */
  hints: CapabilityHints;

  /** Validation rules */
  validationRules: ValidationRule[];

  /** Stability level */
  stability: StabilityLevel;
}

// =============================================================================
// Layer 3: RuntimeState (for DO storage)
// Persisted to Durable Object.minimal data.
// =============================================================================

/**
 * RuntimeState - for Durable Object storage
 * Keep minimal runtime state
 */
export interface RuntimeState {
  // === Session identification ===

  /** Session ID */
  sessionId: string;

  /** Flow ID */
  flowId: string;

  /** Flow type */
  flowType: string;

  /** Tenant ID */
  tenantId: string;

  /** Client ID */
  clientId: string;

  // === Current position ===

  /** Current node ID */
  currentNodeId: string;

  /** Visited node IDs */
  visitedNodeIds: string[];

  // === Collected data ===

  /** Collected data (capabilityId -> response) */
  collectedData: Record<string, unknown>;

  /** Completed Capability IDs */
  completedCapabilities: string[];

  // === Authentication context ===

  /** Authenticated user ID */
  userId?: string;

  /** User claims */
  claims?: Record<string, unknown>;

  // === OAuth parameters (for authorization flow) ===
  oauthParams?: OAuthFlowParams;

  // === Timestamps ===

  /** Flow start time (UNIX ms) */
  startedAt: number;

  /** expiration time (UNIX ms) */
  expiresAt: number;

  /** Last activity time (UNIX ms) */
  lastActivityAt: number;

  /** Recent request timestamps for per-session rate limiting */
  requestTimestamps: number[];

  // === Idempotency management ===

  /** Processed requestId -> snapshot */
  processedRequestIds: Record<string, RuntimeStateSnapshot>;
}

/**
 * OAuth flow parameters
 */
export interface OAuthFlowParams {
  responseType?: string;
  redirectUri?: string;
  scope?: string;
  state?: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  acrValues?: string;
  loginHint?: string;
  prompt?: string;
  maxAge?: number;
}

/**
 * Snapshot for idempotency
 * Return this result when the same requestId is resent
 */
export interface RuntimeStateSnapshot {
  /** Request ID */
  requestId: string;

  /** Processed at (UNIX ms) */
  processedAt: number;

  /** Result node ID */
  resultNodeId: string;

  /** Result data (UIContract or redirect information) */
  resultData: FlowSubmitResult;
}

// =============================================================================
// API Request/Response Types
// =============================================================================

/**
 * POST /api/flow/init request
 */
export interface FlowInitRequest {
  /** Flow type */
  flowType: 'login' | 'authorization' | 'consent' | 'logout';

  /** Client ID */
  clientId: string;

  /** Tenant ID (for multi-tenant) */
  tenantId?: string;

  /** OAuthparameters (for authorization flow) */
  oauthParams?: OAuthFlowParams;
}

/**
 * POST /api/flow/init response
 */
export interface FlowInitResponse {
  /** Session ID */
  sessionId: string;

  /** UIContract version */
  uiContractVersion: '0.1';

  /** Initial UIContract */
  uiContract: UIContract;
}

/**
 * POST /api/flow/submit request
 */
export interface FlowSubmitRequest {
  /** Session ID */
  sessionId: string;

  /** Request ID (clientgenerateUUID, for idempotency) */
  requestId: string;

  /** Capability ID */
  capabilityId: string;

  /** capability response */
  response: unknown;

  /** Tenant ID (session validationfor, retrieved from request context) */
  tenantId?: string;

  /** Client ID (session validationfor, retrieved from request context) */
  clientId?: string;
}

/**
 * POST /api/flow/submit response
 */
export type FlowSubmitResponse = FlowSubmitResult;

/**
 * Flow submit result
 */
export type FlowSubmitResult =
  | { type: 'continue'; uiContract: UIContract }
  | { type: 'redirect'; redirect: FlowRedirect }
  | { type: 'error'; error: FlowError };

/**
 * redirect information
 */
export interface FlowRedirect {
  /** redirect URL */
  url: string;

  /** HTTP method */
  method: 'GET' | 'POST';

  /** additional parameters */
  params?: Record<string, string>;
}

/**
 * Flow error
 */
export interface FlowError {
  /** Error code */
  code: string;

  /** Error message */
  message: string;

  /** additional details */
  details?: Record<string, unknown>;
}

/**
 * GET /api/flow/state/:sessionId response
 */
export interface FlowStateResponse {
  /** current state (public subset) */
  state: {
    currentNodeId: string;
    visitedNodeIds: string[];
    completedCapabilities: string[];
  };

  /** Current UIContract */
  uiContract: UIContract;
}

// =============================================================================
// Flow Migrator Types
// =============================================================================

/**
 * Migration function
 */
export type MigrationFn = (flow: GraphDefinition) => GraphDefinition;

/**
 * Migration definition
 */
export interface MigrationDefinition {
  /** source version */
  fromVersion: string;

  /** target version */
  toVersion: string;

  /** Migration function */
  migrate: MigrationFn;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Compiler that converts GraphDefinition to CompiledPlan
 */
export interface FlowCompiler {
  compile(graph: GraphDefinition): CompiledPlan;
}

/**
 * RuntimeState creation parameters
 */
export interface CreateRuntimeStateParams {
  sessionId: string;
  flowId: string;
  flowType: 'login' | 'authorization' | 'consent' | 'logout';
  tenantId: string;
  clientId: string;
  entryNodeId: string;
  ttlMs: number;
  oauthParams?: OAuthFlowParams;
}

/**
 * Default session expiration (10 minutes)
 */
export const DEFAULT_FLOW_TTL_MS = 10 * 60 * 1000;

/**
 * Maximum retention count for idempotency snapshots
 */
export const MAX_PROCESSED_REQUEST_IDS = 100;
