/**
 * Flow × UI Separation - Type Definitions
 *
 * This module exports TypeScript types for the Flow × UI separation architecture.
 * Types are derived from JSON Schema definitions in this directory.
 *
 * @see ./ui-contract.schema.json
 * @see ./capability.schema.json
 * @see ./intent.schema.json
 * @see ./feature-profile.schema.json
 * @see ../types/contracts - Contract hierarchy types
 */

import type { ResolvedPolicy } from '../../types/contracts';

// =============================================================================
// Stability Levels
// =============================================================================

/**
 * Stability level for API contracts.
 * - core: Will never change. Safe for all SDKs.
 * - stable: Unlikely to change. Safe for production SDKs.
 * - experimental: May change without notice. Use at own risk.
 * - deprecated: Will be removed. Migration path provided.
 */
export type StabilityLevel = 'core' | 'stable' | 'experimental' | 'deprecated';

// =============================================================================
// Security Tiers & Compliance (DR-007)
// =============================================================================

/**
 * Security tier modifiers that can be applied to any profile.
 * These define security posture independent of use case.
 *
 * - standard: Default, no additional requirements
 * - enhanced: Security hardening (MFA required, detailed audit logs)
 * - regulated: Regulatory compliance (Enterprise Attestation, 7-year logs)
 */
export type SecurityTier = 'standard' | 'enhanced' | 'regulated';

/**
 * Compliance modules for regulatory control support.
 *
 * ⚠️ IMPORTANT: These provide "control support", NOT "certification".
 * Using Authrim does NOT guarantee regulatory compliance.
 * Final compliance responsibility rests with the customer.
 */
export type ComplianceModule =
  | 'hipaa' // Healthcare (US)
  | 'pci-dss' // Payment Card Industry
  | 'ismap' // Government (Japan)
  | 'gdpr' // Data Protection (EU)
  | 'sox'; // Public Companies (US)

// =============================================================================
// Feature Profiles
// =============================================================================

/**
 * Core profile identifiers (guaranteed by Authrim).
 * These profiles are fully tested and supported.
 */
export type CoreProfileId = 'human-basic' | 'human-org' | 'ai-agent' | 'iot-device';

/**
 * Custom profile identifiers for tenant-specific configurations.
 * Format: custom.{tenant}.{name}
 */
export type CustomProfileId = `custom.${string}`;

/**
 * Enterprise profile identifiers for OEM/White-label.
 * Format: enterprise.{name}
 */
export type EnterpriseProfileId = `enterprise.${string}`;

/**
 * All supported profile identifiers.
 * - CoreProfileId: Authrim-maintained profiles
 * - CustomProfileId: Tenant-specific profiles (custom.*)
 * - EnterpriseProfileId: OEM extensions (enterprise.*)
 */
export type ProfileId = CoreProfileId | CustomProfileId | EnterpriseProfileId;

/**
 * Feature toggle configuration.
 * Can be a simple boolean or an object with allowed/default.
 */
export type FeatureToggle =
  | boolean
  | {
      /** Whether this feature can be enabled via adjustments */
      allowed: boolean;
      /** Default enabled state */
      default: boolean;
    };

/**
 * Policy engine configuration.
 */
export interface PolicyConfig {
  /** Role-Based Access Control: 'simple' (Admin/User) or 'full' (custom roles) */
  rbac: boolean | 'simple' | 'full';
  /** Attribute-Based Access Control */
  abac: boolean;
  /** Relationship-Based Access Control (organizations) */
  rebac: boolean;
}

/**
 * Authentication target configuration.
 */
export interface TargetConfig {
  /** Human user authentication (always true) */
  human: boolean;
  /** IoT device authentication */
  iot: FeatureToggle;
  /** AI agent authentication */
  ai_agent: FeatureToggle;
  /** AI MCP (Model Context Protocol) authentication */
  ai_mcp: FeatureToggle;
  /** Service-to-service authentication */
  service: FeatureToggle;
}

/**
 * Authentication method configuration.
 */
export interface AuthMethodConfig {
  /** WebAuthn/Passkey authentication */
  passkey: FeatureToggle;
  /** Email OTP authentication */
  email_code: FeatureToggle;
  /** Password authentication */
  password: FeatureToggle;
  /** External Identity Provider (SSO) */
  external_idp: FeatureToggle;
  /** Decentralized Identifier authentication */
  did: FeatureToggle;
}

/**
 * Feature Profile definition.
 * Profiles are the primary configuration unit.
 */
export interface FeatureProfile {
  /** Unique profile identifier */
  id: ProfileId;
  /** Human-readable profile name */
  name: string;
  /** Profile description and use case */
  description: string;
  /** Profile stability level */
  stability?: StabilityLevel;
  /** Policy engine configuration */
  policy: PolicyConfig;
  /** Authentication target configuration */
  targets: TargetConfig;
  /** Authentication method configuration */
  authMethods: AuthMethodConfig;
  /** Available capabilities in this profile */
  capabilities: CapabilityType[];
  /** Available intents in this profile */
  intents: Intent[];
  /** Profile to extend (inherit capabilities/intents) */
  extends?: ProfileId;
}

/**
 * Tenant-specific profile configuration stored in KV.
 *
 * Combines a base profile with security tier and optional compliance modules.
 * The security tier applies additional requirements independent of the use case.
 *
 * @example
 * // Startup with minimal config
 * { id: 'human-basic', securityTier: 'standard' }
 *
 * @example
 * // B2B SaaS with SOC 2 requirements
 * { id: 'human-org', securityTier: 'enhanced' }
 *
 * @example
 * // Financial institution with PCI-DSS
 * { id: 'human-org', securityTier: 'regulated', complianceModules: ['pci-dss'] }
 */
export interface TenantProfileConfig {
  /** Selected profile (base use case) */
  id: ProfileId;
  /**
   * Security tier modifier.
   * - standard: Default, no additional requirements
   * - enhanced: MFA required, detailed audit logs, 1-year retention
   * - regulated: Enterprise Attestation, device-bound passkeys, 7-year retention
   * @default 'standard'
   */
  securityTier?: SecurityTier;
  /**
   * Compliance modules for regulatory control support.
   * ⚠️ These provide "control support", NOT "certification".
   */
  complianceModules?: ComplianceModule[];
  /** Profile adjustments (subtractive only) */
  adjustments?: {
    authMethods?: Partial<Record<keyof AuthMethodConfig, boolean>>;
    ui?: Record<string, unknown>;
  };
  /** When this profile was activated */
  activatedAt?: string;
}

// =============================================================================
// Intents
// =============================================================================

/**
 * Core intents available in all profiles.
 */
export type CoreIntent =
  | 'identify_user'
  | 'authenticate_user'
  | 'verify_factor'
  | 'obtain_consent'
  | 'complete_flow'
  | 'handle_error';

/**
 * Policy intents for RBAC/ReBAC features.
 */
export type PolicyIntent =
  | 'select_organization'
  | 'select_role'
  | 'delegate_identity'
  | 'review_permissions';

/**
 * Target-specific intents for AI/IoT/Service.
 */
export type TargetIntent =
  | 'authorize_agent'
  | 'scope_agent'
  | 'bind_mcp_tools'
  | 'authorize_mcp'
  | 'attest_device'
  | 'bind_device'
  | 'authenticate_service';

/**
 * All available intents.
 */
export type Intent = CoreIntent | PolicyIntent | TargetIntent;

/**
 * Intent definition with metadata.
 */
export interface IntentDefinition {
  /** Intent identifier */
  id: Intent;
  /** Intent category */
  category: 'core' | 'policy' | 'target';
  /** Human-readable description */
  description: string;
  /** Stability level */
  stability: StabilityLevel;
  /** Capabilities typically used with this intent */
  requiredCapabilities?: CapabilityType[];
  /** Profiles that include this intent */
  profiles?: ProfileId[];
}

// =============================================================================
// Capabilities
// =============================================================================

/**
 * Core capabilities always available.
 */
export type CoreCapability =
  | 'collect_identifier'
  | 'collect_secret'
  | 'verify_possession'
  | 'display_info'
  | 'redirect'
  | 'confirm_consent';

/**
 * Policy capabilities for RBAC/ReBAC.
 */
export type PolicyCapability =
  | 'choose_organization'
  | 'choose_role'
  | 'delegate_access'
  | 'view_permissions';

/**
 * Target capabilities for AI/IoT.
 */
export type TargetCapability =
  | 'agent_scope_request'
  | 'agent_consent'
  | 'mcp_tool_binding'
  | 'mcp_resource_select'
  | 'device_attestation'
  | 'device_binding';

/**
 * Experimental/private capability extensions.
 * Format: x-{name}
 * No stability guarantee.
 */
export type ExperimentalCapability = `x-${string}`;

/**
 * Official Authrim capability extensions.
 * Format: authrim.{name}
 * Stable after release.
 */
export type AuthrimCapability = `authrim.${string}`;

/**
 * Third-party vendor capability extensions.
 * Format: {vendor}.{name}
 * Vendor's responsibility for stability.
 */
export type VendorCapability = `${string}.${string}`;

/**
 * All available capability types.
 * - Core/Policy/Target: Built-in capabilities (enum)
 * - Experimental: x-* prefix (unstable)
 * - Authrim: authrim.* prefix (official extensions)
 * - Vendor: vendor.* pattern (third-party)
 */
export type CapabilityType =
  | CoreCapability
  | PolicyCapability
  | TargetCapability
  | ExperimentalCapability
  | AuthrimCapability;

/**
 * Capability category.
 */
export type CapabilityCategory = 'core' | 'auth' | 'policy' | 'target';

/**
 * Input type for capability hints.
 */
export type CapabilityInputType =
  | 'text'
  | 'email'
  | 'password'
  | 'tel'
  | 'number'
  | 'otp'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'radio'
  | 'button'
  | 'hidden';

/**
 * UI rendering hints for a capability.
 */
export interface CapabilityHints {
  /** Input element type */
  inputType?: CapabilityInputType;
  /** Field label (can be i18n key) */
  label?: string;
  /** Placeholder text (can be i18n key) */
  placeholder?: string;
  /** Help text (can be i18n key) */
  helpText?: string;
  /** HTML autocomplete attribute value */
  autoComplete?: string;
  /** Whether to auto-focus this input */
  autoFocus?: boolean;
  /** Input mask pattern */
  mask?: string;
  /** Maximum input length */
  maxLength?: number;
  /** Options for select/multiselect/radio */
  options?: Array<{
    value: string;
    label: string;
    disabled?: boolean;
    description?: string;
  }>;
  /** Visual variant for display_info */
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
  /** Icon identifier */
  icon?: string;
  /** WebAuthn-specific hints (FIDO2/W3C WebAuthn compliant) */
  webauthn?: {
    /** WebAuthn ceremony mode */
    mode: 'register' | 'authenticate';
    /** Create discoverable credential (passkey) */
    discoverable?: boolean;
    /**
     * User verification requirement (W3C WebAuthn Level 2).
     * - required: UV must succeed or ceremony fails
     * - preferred: UV attempted, fallback to UP only
     * - discouraged: Skip UV (use for 2FA scenarios)
     * @see https://www.w3.org/TR/webauthn-2/#enum-userVerificationRequirement
     */
    userVerification?: 'required' | 'preferred' | 'discouraged';
    /**
     * Authenticator attachment preference.
     * - platform: Built-in authenticator (Touch ID, Windows Hello)
     * - cross-platform: Roaming authenticator (security key)
     */
    authenticatorAttachment?: 'platform' | 'cross-platform';
  };
}

/**
 * Validation rule type.
 */
export type ValidationRuleType =
  | 'required'
  | 'email'
  | 'minLength'
  | 'maxLength'
  | 'pattern'
  | 'numeric'
  | 'alphanumeric'
  | 'url'
  | 'custom';

/**
 * Input validation rule.
 */
export interface ValidationRule {
  /** Validation type */
  type: ValidationRuleType;
  /** Validation value (e.g., minLength value, pattern regex) */
  value?: unknown;
  /** Error message (can be i18n key) */
  message?: string;
}

/**
 * Feature requirements for a capability.
 */
export interface FeatureRequirement {
  /** Required policy features (any of) */
  policy?: Array<'rbac' | 'abac' | 'rebac'>;
  /** Required target types (any of) */
  target?: Array<'human' | 'iot' | 'ai_agent' | 'ai_mcp' | 'service'>;
  /** Required auth methods (any of) */
  authMethod?: Array<'passkey' | 'email_code' | 'password' | 'external_idp' | 'did'>;
}

/**
 * Capability definition.
 */
export interface Capability {
  /** Capability type identifier */
  type: CapabilityType;
  /** Unique identifier for this capability instance */
  id: string;
  /** Capability category */
  category?: CapabilityCategory;
  /** Stability level */
  stability?: StabilityLevel;
  /** Whether this capability must be fulfilled to proceed */
  required?: boolean;
  /** UI rendering hints */
  hints?: CapabilityHints;
  /** Input validation rules */
  validation?: ValidationRule[];
  /** Feature requirements for this capability */
  requires?: FeatureRequirement;
}

// =============================================================================
// UI Contract
// =============================================================================

/**
 * Feature flags derived from the active profile.
 */
export interface FeatureFlags {
  policy: {
    rbac: boolean | 'simple' | 'full';
    abac: boolean;
    rebac: boolean;
  };
  targets: {
    human: boolean;
    iot: boolean;
    ai_agent: boolean;
    ai_mcp: boolean;
    service: boolean;
  };
  authMethods: {
    passkey: boolean;
    email_code: boolean;
    password: boolean;
    external_idp: boolean;
    did: boolean;
  };
}

/**
 * Branding context for UI customization.
 */
export interface BrandingContext {
  /** Display name (client or tenant) */
  name?: string;
  /** Logo URL */
  logoUri?: string;
  /** Privacy policy URL */
  policyUri?: string;
  /** Terms of service URL */
  tosUri?: string;
  /** Primary brand color (hex) */
  primaryColor?: string;
}

/**
 * User context (if authenticated).
 */
export interface UserContext {
  /** User ID */
  id: string;
  /** User email */
  email?: string;
  /** Display name */
  name?: string;
  /** Profile picture URL */
  picture?: string;
}

/**
 * Organization context (if ReBAC enabled).
 */
export interface OrganizationContext {
  /** Organization ID */
  id: string;
  /** Organization name */
  name: string;
  /** User's role in this organization */
  role?: string;
  /** Organizations the user can select */
  availableOrganizations?: Array<{
    id: string;
    name: string;
    isPrimary?: boolean;
  }>;
}

/**
 * OAuth client context.
 */
export interface ClientContext {
  /** Client ID */
  clientId: string;
  /** Client display name */
  clientName?: string;
  /** Client website URL */
  clientUri?: string;
  /** Client logo URL */
  logoUri?: string;
  /** Client privacy policy URL */
  policyUri?: string;
  /** Client terms of service URL */
  tosUri?: string;
  /** Whether this is a first-party client */
  isTrusted?: boolean;
  /** Requested scopes */
  scopes?: Array<{
    name: string;
    title?: string;
    description?: string;
    required?: boolean;
  }>;
}

/**
 * Error context.
 */
export interface ErrorContext {
  /** Error code */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Additional error details */
  details?: Record<string, unknown>;
  /** Whether the operation can be retried */
  retryable?: boolean;
}

/**
 * Flow context for UI rendering.
 */
export interface FlowContext {
  /** Branding information */
  branding?: BrandingContext;
  /** Current user information */
  user?: UserContext;
  /** Organization context */
  organization?: OrganizationContext;
  /** OAuth client information */
  client?: ClientContext;
  /** Error information */
  error?: ErrorContext;
  /** Preferred locale */
  locale?: string;

  // OIDC Authentication Context (RFC 6711, OIDC Core §2)
  /**
   * Requested Authentication Context Class References.
   * Space-separated list from OIDC acr_values parameter.
   * @see https://openid.net/specs/openid-connect-core-1_0.html#acrSemantics
   */
  acrValuesRequested?: string[];
  /**
   * Achieved Authentication Context Class Reference.
   * Set after authentication completes.
   * Level "0" indicates no confidence in user identity (ISO/IEC 29115).
   */
  acr?: string;
  /**
   * Authentication Methods References (OIDC amr claim).
   * List of authentication methods used in this session.
   * @see https://www.rfc-editor.org/rfc/rfc8176
   */
  amr?: string[];

  // ========== Contract Hierarchy Integration ==========
  /**
   * Resolved policy for this flow.
   * Contains effective settings after merging Tenant Policy and Client Profile.
   * Pinned to session for consistency during authentication flow.
   *
   * @see ResolvedPolicy
   */
  policy?: ResolvedPolicy;
}

/**
 * Action definition.
 */
export interface ActionDefinition {
  /** Action type identifier */
  type: string;
  /** Display label (can be i18n key) */
  label: string;
  /** Whether the action is disabled */
  disabled?: boolean;
  /** Whether the action is in loading state */
  loading?: boolean;
  /** Visual variant */
  variant?: 'primary' | 'secondary' | 'danger' | 'link';
}

/**
 * Available user actions.
 */
export interface ActionSet {
  /** Primary action (e.g., Submit, Continue) */
  primary: ActionDefinition;
  /** Secondary actions (e.g., Cancel, Skip) */
  secondary?: ActionDefinition[];
}

/**
 * UI Contract - the main interface between Flow Engine and UI.
 * Defines what a UI should render for a given flow state.
 *
 * ## Versioning
 * Uses semantic versioning (MAJOR.MINOR):
 * - MAJOR: Breaking changes (capability removal, intent changes)
 * - MINOR: Backward compatible additions
 * - 0.x: Experimental phase (current)
 * - 1.0: Production stable (GA)
 *
 * ## State vs Intent (DR-006)
 * - `state`: Internal flow state (implementation detail, may change on refactor)
 * - `intent`: Semantic purpose (stable API, use for UI logic)
 *
 * SDK Guidance: Always branch on `intent`, use `state` only for diagnostics.
 */
export interface UIContract {
  /**
   * Schema version (semantic versioning).
   * Format: "MAJOR.MINOR"
   */
  version: '0.1';
  /**
   * Internal flow state identifier.
   * ⚠️ UNSTABLE: Do not use for UI branching logic.
   * Use for logging/debugging only.
   */
  state: string;
  /**
   * Semantic intent of this flow step.
   * ✅ STABLE: Use this for UI rendering decisions.
   * @see Intent
   */
  intent: Intent;
  /** Contract-level stability indicator */
  stability?: StabilityLevel;
  /** Enabled features for this flow */
  features: FeatureFlags;
  /** UI capabilities required for this state */
  capabilities: Capability[];
  /** Contextual data for rendering */
  context?: FlowContext;
  /** Available user actions */
  actions: ActionSet;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Extract capability types for a given profile.
 */
export type CapabilitiesForProfile<P extends ProfileId> = P extends 'human-basic'
  ? CoreCapability
  : P extends 'human-org'
    ? CoreCapability | PolicyCapability
    : P extends 'ai-agent'
      ? CoreCapability | PolicyCapability | TargetCapability
      : P extends 'iot-device'
        ?
            | 'collect_identifier'
            | 'device_attestation'
            | 'device_binding'
            | 'display_info'
            | 'redirect'
        : never;

/**
 * Extract intents for a given profile.
 */
export type IntentsForProfile<P extends ProfileId> = P extends 'human-basic'
  ? CoreIntent
  : P extends 'human-org'
    ? CoreIntent | PolicyIntent
    : P extends 'ai-agent'
      ? CoreIntent | PolicyIntent | TargetIntent
      : P extends 'iot-device'
        ? 'identify_user' | 'attest_device' | 'bind_device' | 'complete_flow' | 'handle_error'
        : never;
