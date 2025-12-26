/**
 * Flow Design API - Type Definitions
 *
 * This module exports TypeScript types for the Flow Designer,
 * enabling visual flow editing with React Flow / Svelte Flow.
 *
 * @see ../flow-ui/index.ts - UI Contract types
 * @see ../flow-api/index.ts - Flow View API types
 * @see docs/architecture/flow-ui/04-api-specification.md
 */

import type {
  CapabilityType,
  CoreProfileId,
  Intent,
  ProfileId,
  SecurityTier,
  StabilityLevel,
  ActionDefinition,
} from '../flow-ui';

import type { FlowTemplateId } from '../../types/contracts';
import type { FlowNodePalette, FlowNodeDisplayState } from '../../types/contracts/ui-display';

// =============================================================================
// Flow Design Types
// =============================================================================

/**
 * Authentication flow definition.
 * Stored in KV and used by the Flow Engine.
 */
export interface AuthenticationFlow {
  /** Unique flow identifier */
  id: string;
  /** Human-readable flow name */
  name: string;
  /** Flow description */
  description?: string;
  /** Base profile for this flow */
  profile: ProfileId;
  /** Security tier modifier */
  securityTier?: SecurityTier;
  /** Flow version (semver format) */
  version: string;
  /** Flow nodes */
  nodes: FlowDesignNode[];
  /** Flow edges (transitions) */
  edges: FlowDesignEdge[];
  /** Entry node ID */
  entry: string;
  /** Error handler node ID */
  errorHandler?: string;
  /** Whether this flow is currently active */
  isActive?: boolean;
  /** Flow metadata */
  metadata: FlowMetadata;

  // ========== Contract Hierarchy Integration ==========
  /**
   * Referenced tenant policy version.
   * Flow is validated against this policy version.
   */
  tenantPolicyVersion?: number;
  /**
   * Referenced client profile version (for client-specific flows).
   * If not set, flow applies to all clients.
   */
  clientProfileVersion?: number;
  /**
   * Template ID used to create this flow (if template-based).
   */
  templateId?: FlowTemplateId;
}

/**
 * Flow metadata.
 */
export interface FlowMetadata {
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
  /** Creator user ID or 'system' */
  createdBy: string;
  /** Last modifier user ID */
  updatedBy?: string;
  /** Optional tags for organization */
  tags?: string[];
}

// =============================================================================
// Node Types
// =============================================================================

/**
 * Flow design node.
 * Represents a step in the authentication flow.
 */
export interface FlowDesignNode {
  /** Unique node ID */
  id: string;
  /**
   * Node type - determines behavior and available capabilities.
   *
   * Built-in types:
   * - CapabilityType: Core/Policy/Target capabilities
   * - Intent: Flow intent nodes
   * - `plugin.${string}`: Plugin-provided nodes
   */
  type: CapabilityType | Intent | PluginNodeType;
  /** Display label for visual editor */
  label: string;
  /** Node position in visual editor */
  position: NodePosition;
  /** Node-specific configuration */
  config?: NodeConfig;
  /** Capabilities available at this node */
  capabilities: CapabilityType[];
  /** Actions available at this node */
  actions: ActionDefinition[];
  /** Visual editor metadata */
  meta?: NodeMeta;
}

/**
 * Plugin node type pattern.
 * Format: plugin.{pluginId}
 */
export type PluginNodeType = `plugin.${string}`;

/**
 * Node position for visual editor.
 * Compatible with React Flow / Svelte Flow.
 */
export interface NodePosition {
  /** X coordinate */
  x: number;
  /** Y coordinate */
  y: number;
}

/**
 * Node-specific configuration.
 * Contents depend on node type.
 */
export interface NodeConfig {
  /**
   * Validation rules for capabilities.
   * Key: capability ID, Value: validation config
   */
  validation?: Record<string, ValidationConfig>;
  /**
   * Hints for capability rendering.
   * Key: capability ID, Value: hint overrides
   */
  hints?: Record<string, HintOverrides>;
  /**
   * Custom settings for plugin nodes.
   */
  pluginSettings?: Record<string, unknown>;
  /**
   * Timeout for this node in milliseconds.
   * Default: 300000 (5 minutes)
   */
  timeout?: number;
  /**
   * Maximum retry count on transient errors.
   * Default: 0 (no retry)
   */
  retryCount?: number;
}

/**
 * Validation configuration for a capability.
 */
export interface ValidationConfig {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  customMessage?: string;
}

/**
 * Hint overrides for capability rendering.
 */
export interface HintOverrides {
  label?: string;
  placeholder?: string;
  helpText?: string;
  autoFocus?: boolean;
}

/**
 * Visual editor metadata for a node.
 */
export interface NodeMeta {
  /** Icon identifier (e.g., 'mail', 'key', 'shield') */
  icon?: string;
  /** Node color (hex or named color) */
  color?: string;
  /** Node description for tooltips */
  description?: string;
  /** Whether node is collapsible in editor */
  collapsible?: boolean;
  /** Node group for organizing in palette */
  group?: string;
}

// =============================================================================
// Edge Types
// =============================================================================

/**
 * Flow design edge.
 * Represents a transition between nodes.
 */
export interface FlowDesignEdge {
  /** Unique edge ID */
  id: string;
  /** Source node ID */
  from: string;
  /** Target node ID */
  to: string;
  /**
   * Transition guard condition.
   * If not specified, always transitions.
   */
  guard?: TransitionGuard;
  /** Edge label for visual editor */
  label?: string;
  /** Edge metadata */
  meta?: EdgeMeta;
}

/**
 * Edge metadata.
 */
export interface EdgeMeta {
  /** Error handler override for this edge */
  errorHandler?: string;
  /** Timeout override for this transition */
  timeout?: number;
  /** Retry count override */
  retryCount?: number;
  /** Edge color for visual editor */
  color?: string;
  /** Whether this is an error edge */
  isError?: boolean;
}

// =============================================================================
// Transition Guards
// =============================================================================

/**
 * Transition guard - determines when an edge can be traversed.
 *
 * Guard evaluation order:
 * 1. 'always' - no condition check
 * 2. 'preset' - evaluate built-in condition
 * 3. 'custom' - evaluate custom expression
 */
export interface TransitionGuard {
  /** Guard type */
  type: GuardType;
  /** Preset guard configuration (if type === 'preset') */
  preset?: PresetGuard;
  /** Custom guard configuration (if type === 'custom') */
  custom?: CustomGuard;
}

/**
 * Guard type.
 */
export type GuardType = 'always' | 'preset' | 'custom';

/**
 * Preset guard - built-in conditions.
 */
export type PresetGuard =
  | PromptEqualsGuard
  | AuthAgeExceededGuard
  | ConsentMissingGuard
  | MfaRequiredGuard
  | OrgSelectionRequiredGuard
  | PasskeyAvailableGuard
  | EmailVerifiedGuard
  | RoleRequiredGuard;

/**
 * Check if OIDC prompt parameter equals a value.
 */
export interface PromptEqualsGuard {
  name: 'prompt_equals';
  value: 'login' | 'consent' | 'none' | 'select_account';
}

/**
 * Check if authentication age exceeds max_age.
 */
export interface AuthAgeExceededGuard {
  name: 'auth_age_exceeded';
  /** Max age in seconds */
  maxAge: number;
}

/**
 * Check if consent is required for requested scopes.
 */
export interface ConsentMissingGuard {
  name: 'consent_missing';
}

/**
 * Check if MFA is required by policy.
 */
export interface MfaRequiredGuard {
  name: 'mfa_required';
}

/**
 * Check if organization selection is required.
 */
export interface OrgSelectionRequiredGuard {
  name: 'org_selection_required';
}

/**
 * Check if user has registered passkeys.
 */
export interface PasskeyAvailableGuard {
  name: 'passkey_available';
}

/**
 * Check if user's email is verified.
 */
export interface EmailVerifiedGuard {
  name: 'email_verified';
}

/**
 * Check if user has a specific role.
 */
export interface RoleRequiredGuard {
  name: 'role_required';
  /** Required role name */
  role: string;
  /** Organization ID (optional) */
  orgId?: string;
}

/**
 * Custom guard - JavaScript expression or Zod schema.
 *
 * ⚠️ Security: Custom expressions are evaluated in a sandboxed environment.
 */
export interface CustomGuard {
  /**
   * JavaScript expression that evaluates to boolean.
   * Available context variables:
   * - `ctx.user`: User object (if authenticated)
   * - `ctx.session`: Session data
   * - `ctx.request`: Request metadata
   * - `ctx.capabilities`: Submitted capability values
   * - `ctx.oidc`: OIDC parameters (prompt, max_age, etc.)
   *
   * @example "ctx.user.email.endsWith('@company.com')"
   * @example "ctx.oidc.max_age < 3600"
   * @example "ctx.capabilities.email?.value != null"
   */
  expression: string;
  /**
   * Optional Zod schema for type validation.
   * Serialized as JSON string.
   */
  schema?: string;
  /**
   * Description of what this guard checks.
   * Used for documentation and error messages.
   */
  description?: string;
}

// =============================================================================
// Node Palette Types (Admin API)
// =============================================================================

/**
 * Available node for the flow designer palette.
 */
export interface AvailableNode {
  /** Node type identifier */
  type: CapabilityType | Intent | PluginNodeType;
  /** Display label */
  label: string;
  /** Category for grouping */
  category: NodeCategory;
  /** Stability level */
  stability: StabilityLevel;
  /** Icon identifier */
  icon?: string;
  /** Description */
  description?: string;
  /** Default capabilities for this node type */
  defaultCapabilities?: CapabilityType[];
  /** Default actions for this node type */
  defaultActions?: ActionDefinition[];
}

/**
 * Node category for palette grouping.
 */
export type NodeCategory =
  | 'core' // Core capabilities
  | 'auth' // Authentication methods
  | 'policy' // Policy/RBAC/ReBAC
  | 'target' // AI/IoT/Service
  | 'plugin' // Plugin-provided
  | 'flow'; // Flow control (error, complete)

/**
 * Response from GET /api/admin/flows/nodes
 */
export interface AvailableNodesResponse {
  /** Built-in capabilities */
  capabilities: AvailableNode[];
  /** Plugin-provided custom nodes */
  customNodes: AvailableNode[];

  // ========== Contract Hierarchy Integration ==========
  /**
   * Node palette with policy filtering and UI display info.
   * Nodes are categorized and filtered based on active policy.
   */
  palette?: FlowNodePalette;
  /**
   * Active policy information.
   * Used to determine which nodes are available.
   */
  activePolicy?: {
    /** Tenant policy version */
    tenantPolicyVersion: number;
    /** Client profile version (if client-specific) */
    clientProfileVersion?: number;
    /** Effective security tier */
    effectiveSecurityTier: SecurityTier;
  };
}

// =============================================================================
// Validation Types
// =============================================================================

/**
 * Flow validation result.
 * Returned by POST /api/admin/flows/:id/validate
 */
export interface FlowValidationResult {
  /** Whether the flow is valid */
  valid: boolean;
  /** Validation errors (blocks activation) */
  errors: ValidationError[];
  /** Validation warnings (does not block activation) */
  warnings: ValidationWarning[];
  /** Policy violations (blocks activation if any) */
  policyViolations?: PolicyViolation[];
}

/**
 * Policy violation - flow configuration conflicts with tenant/client policy.
 */
export interface PolicyViolation {
  /** Violation type */
  type: PolicyViolationType;
  /** Related node ID (if applicable) */
  nodeId?: string;
  /** Human-readable violation message */
  message: string;
  /** Source of the policy constraint */
  source: 'tenant' | 'client';
  /** Suggested resolution */
  suggestion?: string;
}

/**
 * Policy violation types.
 */
export type PolicyViolationType =
  | 'forbidden_auth_method' // Uses authentication method disabled by policy
  | 'forbidden_capability' // Uses capability not allowed by policy
  | 'missing_mfa' // MFA required by policy but not in flow
  | 'missing_consent' // Consent required by policy but not in flow
  | 'security_tier_mismatch' // Flow security tier below policy requirement
  | 'scope_not_allowed'; // Flow grants scope not allowed by policy

/**
 * Validation error - blocks flow activation.
 */
export interface ValidationError {
  /** Error type */
  type: ValidationErrorType;
  /** Related node ID (if applicable) */
  nodeId?: string;
  /** Related edge ID (if applicable) */
  edgeId?: string;
  /** Human-readable error message */
  message: string;
}

/**
 * Validation error types.
 */
export type ValidationErrorType =
  | 'missing_entry' // No entry node defined
  | 'orphan_node' // Node has no incoming edges (except entry)
  | 'invalid_guard' // Guard expression is invalid
  | 'profile_mismatch' // Node capability not in profile
  | 'cycle_detected' // Infinite loop detected
  | 'missing_error_handler' // No error handler for node
  | 'invalid_edge' // Edge references non-existent node
  | 'duplicate_node_id' // Multiple nodes with same ID
  | 'duplicate_edge_id'; // Multiple edges with same ID

/**
 * Validation warning - does not block activation.
 */
export interface ValidationWarning {
  /** Warning type */
  type: ValidationWarningType;
  /** Related node ID (if applicable) */
  nodeId?: string;
  /** Human-readable warning message */
  message: string;
}

/**
 * Validation warning types.
 */
export type ValidationWarningType =
  | 'unreachable_node' // Node cannot be reached from entry
  | 'no_error_handler' // Flow has no global error handler
  | 'deprecated_node' // Node type is deprecated
  | 'experimental_node' // Node type is experimental
  | 'complex_guard'; // Guard expression may be slow

// =============================================================================
// Admin API Request/Response Types
// =============================================================================

/**
 * Request for POST /api/admin/flows (create flow)
 */
export interface CreateFlowRequest {
  /** Flow name */
  name: string;
  /** Flow description */
  description?: string;
  /** Base profile */
  profile: CoreProfileId;
  /** Security tier */
  securityTier?: SecurityTier;
  /** Initial nodes (optional) */
  nodes?: FlowDesignNode[];
  /** Initial edges (optional) */
  edges?: FlowDesignEdge[];
  /** Entry node ID (required if nodes provided) */
  entry?: string;
}

/**
 * Request for PATCH /api/admin/flows/:id (update flow)
 */
export interface UpdateFlowRequest {
  /** Updated flow name */
  name?: string;
  /** Updated description */
  description?: string;
  /** Updated security tier */
  securityTier?: SecurityTier;
  /** Updated nodes */
  nodes?: FlowDesignNode[];
  /** Updated edges */
  edges?: FlowDesignEdge[];
  /** Updated entry node ID */
  entry?: string;
  /** Updated error handler node ID */
  errorHandler?: string;
}

/**
 * Response for GET /api/admin/flows (list flows)
 */
export interface ListFlowsResponse {
  /** List of flows */
  flows: FlowSummary[];
  /** Pagination info */
  pagination: PaginationInfo;
}

/**
 * Flow summary for list view.
 */
export interface FlowSummary {
  /** Flow ID */
  id: string;
  /** Flow name */
  name: string;
  /** Flow description */
  description?: string;
  /** Base profile */
  profile: ProfileId;
  /** Security tier */
  securityTier?: SecurityTier;
  /** Flow version */
  version: string;
  /** Whether flow is active */
  isActive: boolean;
  /** Node count */
  nodeCount: number;
  /** Edge count */
  edgeCount: number;
  /** Last updated timestamp */
  updatedAt: string;
}

/**
 * Pagination info.
 */
export interface PaginationInfo {
  /** Current page (1-based) */
  page: number;
  /** Items per page */
  perPage: number;
  /** Total items */
  total: number;
  /** Total pages */
  totalPages: number;
}

// =============================================================================
// Default Flow Templates
// =============================================================================

/**
 * Pre-built flow template.
 */
export interface FlowTemplate {
  /** Template ID */
  id: string;
  /** Template name */
  name: string;
  /** Template description */
  description: string;
  /** Target profile */
  profile: CoreProfileId;
  /** Pre-configured flow definition */
  flow: Omit<AuthenticationFlow, 'id' | 'metadata'>;
  /** Template tags */
  tags: string[];
}

/**
 * Built-in flow template IDs.
 */
export type BuiltInTemplateId =
  | 'basic-email-login' // Email OTP only
  | 'passkey-first' // Passkey with email fallback
  | 'enterprise-sso' // External IdP with consent
  | 'b2b-org-selection' // Organization context selection
  | 'mfa-required'; // Forced MFA flow

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a node type is a plugin node.
 */
export function isPluginNode(type: string): type is PluginNodeType {
  return type.startsWith('plugin.');
}

/**
 * Check if a guard is a preset guard.
 */
export function isPresetGuard(
  guard: TransitionGuard
): guard is TransitionGuard & { preset: PresetGuard } {
  return guard.type === 'preset' && guard.preset !== undefined;
}

/**
 * Check if a guard is a custom guard.
 */
export function isCustomGuard(
  guard: TransitionGuard
): guard is TransitionGuard & { custom: CustomGuard } {
  return guard.type === 'custom' && guard.custom !== undefined;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default timeout for flow nodes (5 minutes).
 */
export const DEFAULT_NODE_TIMEOUT = 300000;

/**
 * Default timeout for flow transitions (10 seconds).
 */
export const DEFAULT_TRANSITION_TIMEOUT = 10000;

/**
 * Maximum allowed custom guard expression length.
 */
export const MAX_GUARD_EXPRESSION_LENGTH = 1000;

/**
 * Maximum nodes allowed in a single flow.
 */
export const MAX_FLOW_NODES = 100;

/**
 * Maximum edges allowed in a single flow.
 */
export const MAX_FLOW_EDGES = 500;
