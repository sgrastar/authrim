/**
 * Authrim Plugin Core Types
 *
 * This module defines the core interfaces for the Authrim plugin system.
 */

import type { z } from 'zod';

// Import infrastructure types for use in this file
// These are re-exported at the bottom for plugin developers
import type {
  IPolicyInfra as _IPolicyInfra,
  CheckRequest as _CheckRequest,
  CheckResponse as _CheckResponse,
  InfraHealthStatus as _InfraHealthStatus,
  IUserStore as _IUserStore,
  IClientStore as _IClientStore,
  ISessionStore as _ISessionStore,
  IPasskeyStore as _IPasskeyStore,
  IOrganizationStore as _IOrganizationStore,
  IRoleStore as _IRoleStore,
  IRoleAssignmentStore as _IRoleAssignmentStore,
  IRelationshipStore as _IRelationshipStore,
  User as _User,
  OAuthClient as _OAuthClient,
  Session as _Session,
  Passkey as _Passkey,
  Organization as _Organization,
  Role as _Role,
  RoleAssignment as _RoleAssignment,
  Relationship as _Relationship,
} from '../infra/types';

// Local type aliases for use in interface definitions
type IPolicyInfra = _IPolicyInfra;
type InfraHealthStatus = _InfraHealthStatus;
type IUserStore = _IUserStore;
type IClientStore = _IClientStore;
type ISessionStore = _ISessionStore;
type IPasskeyStore = _IPasskeyStore;
type IOrganizationStore = _IOrganizationStore;
type IRoleStore = _IRoleStore;
type IRoleAssignmentStore = _IRoleAssignmentStore;
type IRelationshipStore = _IRelationshipStore;

// =============================================================================
// Plugin Interface
// =============================================================================

/**
 * Base interface for all Authrim plugins
 *
 * @template TConfig - Plugin configuration type (inferred from configSchema)
 */
export interface AuthrimPlugin<TConfig = unknown> {
  /** Plugin ID (e.g., 'notifier-resend') - must be unique */
  readonly id: string;

  /** Plugin version (semver) */
  readonly version: string;

  /** Capabilities provided by this plugin */
  readonly capabilities: PluginCapability[];

  /** Whether this is an official Authrim plugin */
  readonly official?: boolean;

  /**
   * Configuration schema (Zod) - used for validation and UI generation
   *
   * Note: Using z.ZodType with unknown input type to support schemas with defaults
   *
   * IMPORTANT: Use .describe() on each field for UI display:
   * ```typescript
   * z.object({
   *   apiKey: z.string().describe('API key for the service'),
   *   timeout: z.number().default(30).describe('Request timeout in seconds'),
   * })
   * ```
   */
  readonly configSchema: z.ZodType<TConfig, z.ZodTypeDef, unknown>;

  /** Plugin metadata for UI display and management */
  readonly meta: PluginMeta;

  /**
   * Register capabilities with the registry
   *
   * This method should be synchronous and have no side effects.
   * It is called after initialize() completes successfully.
   */
  register(registry: CapabilityRegistry, config: TConfig): void;

  /**
   * Initialize the plugin (optional)
   *
   * Called before register(). Use for:
   * - External service connection/warmup
   * - Dependency validation
   * - Configuration verification
   *
   * If this throws, register() will not be called.
   */
  initialize?(ctx: PluginContext, config: TConfig): Promise<void>;

  /**
   * Shutdown the plugin (optional)
   *
   * Called when the plugin is being unloaded.
   * Use for cleanup, closing connections, etc.
   */
  shutdown?(): Promise<void>;

  /**
   * Health check (optional)
   *
   * Called by Admin API to verify plugin health.
   * Context and config are provided when called via PluginLoader.
   */
  healthCheck?(ctx?: PluginContext, config?: TConfig): Promise<HealthStatus>;
}

// =============================================================================
// Capability Types
// =============================================================================

/**
 * Plugin capability identifier
 *
 * Format: `{category}.{name}`
 * Examples: 'notifier.email', 'idp.google', 'authenticator.passkey'
 */
export type PluginCapability =
  | `notifier.${string}` // notifier.email, notifier.sms, notifier.push
  | `idp.${string}` // idp.google, idp.saml, idp.oidc
  | `authenticator.${string}` // authenticator.passkey, authenticator.otp
  | `human_verification.${string}` // human_verification.turnstile, human_verification.recaptcha
  | `flow.${string}`; // flow.otp-send (future: Flow UI nodes)

/**
 * Plugin category for UI grouping
 */
export type PluginCategory = 'notification' | 'identity' | 'authentication' | 'security' | 'flow';

// =============================================================================
// FlowNode Definition (Extension Point for Future Flow x UI Architecture)
// =============================================================================

/**
 * FlowNode definition for Flow Designer UI
 *
 * This is an extension point for the future Flow x UI separation architecture.
 * Currently, only type definitions are provided; implementation comes later.
 */
export interface FlowNodeDefinition {
  /**
   * Node type identifier
   *
   * Must be globally unique. Recommended format: `{pluginId}:{action}`
   * Examples: 'notifier-resend:send', 'authenticator-passkey:verify'
   */
  type: string;

  /** UI display label */
  label: string;

  /** Icon identifier (for UI) */
  icon?: string;

  /** Input port definitions */
  inputs: FlowPortDefinition[];

  /** Output port definitions */
  outputs: FlowPortDefinition[];

  /** Node configuration schema (Zod) */
  configSchema?: z.ZodSchema;

  /** UI display category */
  category: 'authentication' | 'notification' | 'condition' | 'action';
}

/**
 * Flow port definition for node connections
 */
export interface FlowPortDefinition {
  /** Port identifier */
  id: string;

  /** Display label */
  label: string;

  /** Port data type */
  type: 'trigger' | 'data' | 'boolean';
}

// =============================================================================
// Plugin Metadata
// =============================================================================

/**
 * Plugin metadata for UI display and management
 *
 * This metadata is used for:
 * - Admin UI plugin list and detail pages
 * - Plugin marketplace/catalog
 * - Documentation generation
 * - Audit and compliance tracking
 */
export interface PluginMeta {
  // ---------------------------------------------------------------------------
  // Required Fields
  // ---------------------------------------------------------------------------

  /** Display name (e.g., "Resend Email Notifier") */
  name: string;

  /**
   * Short description (1-2 sentences)
   * Should explain what the plugin does, not how it works.
   */
  description: string;

  /** Category for UI grouping and filtering */
  category: PluginCategory;

  // ---------------------------------------------------------------------------
  // Author & License (Required for non-official plugins)
  // ---------------------------------------------------------------------------

  /** Author information */
  author?: PluginAuthor;

  /**
   * License identifier (SPDX format recommended)
   * Examples: "MIT", "Apache-2.0", "proprietary"
   */
  license?: string;

  // ---------------------------------------------------------------------------
  // Display & Branding
  // ---------------------------------------------------------------------------

  /**
   * Icon identifier
   *
   * Can be:
   * - Lucide icon name (e.g., "mail", "shield-check") [Recommended]
   * - URL to icon image (https://...)
   * - Base64 data URL (data:image/svg+xml;base64,...)
   *
   * Security Notes:
   * - URLs are NOT fetched server-side; they are passed to Admin UI for display
   * - Admin UI should validate URLs and use CSP to restrict image sources
   * - For official plugins, prefer Lucide icon names to avoid external dependencies
   */
  icon?: string;

  /**
   * Tags for search and filtering
   * Examples: ["email", "transactional", "marketing"]
   */
  tags?: string[];

  /**
   * Logo URL for detailed plugin view
   * Recommended size: 256x256 PNG with transparency
   *
   * Security Notes:
   * - URLs are passed to Admin UI for display (not fetched server-side)
   * - Admin UI should:
   *   - Validate URL format (https:// only, no javascript: or data: for logos)
   *   - Use CSP img-src directive to restrict allowed domains
   *   - Consider proxying through a trusted CDN for untrusted sources
   * - For official plugins, host logos on Authrim's CDN or use inline SVG
   */
  logoUrl?: string;

  // ---------------------------------------------------------------------------
  // Documentation & Support
  // ---------------------------------------------------------------------------

  /** Link to documentation */
  documentationUrl?: string;

  /** Link to source repository (GitHub, GitLab, etc.) */
  repositoryUrl?: string;

  /** Link to changelog */
  changelogUrl?: string;

  /** Support information */
  support?: PluginSupport;

  // ---------------------------------------------------------------------------
  // Compatibility & Requirements
  // ---------------------------------------------------------------------------

  /**
   * Minimum Authrim version required (semver)
   * Example: "1.0.0"
   */
  minAuthrimVersion?: string;

  /**
   * External service dependencies
   * Used to show warnings if services are unavailable
   */
  externalDependencies?: ExternalDependency[];

  // ---------------------------------------------------------------------------
  // Status & Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Plugin stability status
   * - stable: Production ready
   * - beta: Feature complete but may have bugs
   * - alpha: Experimental, API may change
   * - deprecated: No longer maintained
   */
  stability?: 'stable' | 'beta' | 'alpha' | 'deprecated';

  /**
   * Deprecation notice (when stability is 'deprecated')
   * Should include migration instructions
   */
  deprecationNotice?: string;

  /**
   * Hide from public plugin list (internal plugins)
   * Plugin can still be enabled via Admin API
   */
  hidden?: boolean;

  // ---------------------------------------------------------------------------
  // Admin Notes (Internal Use)
  // ---------------------------------------------------------------------------

  /**
   * Internal notes for administrators
   * Not shown to end users, only in Admin API responses
   *
   * Use for:
   * - Configuration tips
   * - Known issues
   * - Deployment notes
   */
  adminNotes?: string;
}

/**
 * Plugin author information
 */
export interface PluginAuthor {
  /** Author or organization name */
  name: string;

  /** Contact email */
  email?: string;

  /** Website URL */
  url?: string;

  /** Organization/company name (if different from author name) */
  organization?: string;
}

/**
 * Plugin support information
 */
export interface PluginSupport {
  /** Support email */
  email?: string;

  /** Support URL (help desk, forum, etc.) */
  url?: string;

  /** Issue tracker URL */
  issuesUrl?: string;

  /** Discord/Slack invite URL */
  chatUrl?: string;
}

/**
 * External service dependency
 */
export interface ExternalDependency {
  /** Service name (e.g., "Resend API", "Google OAuth") */
  name: string;

  /** Service URL for reference */
  url?: string;

  /** Whether this dependency is required or optional */
  required: boolean;

  /** Description of why this dependency is needed */
  description?: string;
}

// =============================================================================
// Health Status
// =============================================================================

/**
 * Plugin health status
 */
export interface HealthStatus {
  /** Overall status */
  status: 'healthy' | 'degraded' | 'unhealthy';

  /** Optional message */
  message?: string;

  /** Detailed checks (optional) */
  checks?: Record<
    string,
    {
      status: 'pass' | 'warn' | 'fail';
      message?: string;
    }
  >;

  /** Timestamp */
  timestamp?: number;
}

// =============================================================================
// Plugin Source & Trust Level
// =============================================================================

/**
 * Plugin source information
 *
 * Used to determine trust level and display in Admin UI.
 * Trust is based on distribution channel, NOT metadata claims.
 */
export interface PluginSource {
  /**
   * Source type
   * - builtin: Included in ar-lib-plugin/src/builtin/
   * - npm: Installed via npm (includes scoped packages)
   * - local: Local file path
   * - unknown: Source cannot be determined
   */
  type: 'builtin' | 'npm' | 'local' | 'unknown';

  /**
   * Source identifier
   * - builtin: "ar-lib-plugin/builtin/{path}"
   * - npm: "@scope/package-name" or "package-name"
   * - local: "/path/to/plugin"
   * - unknown: undefined
   */
  identifier?: string;

  /**
   * npm package version (if source is npm)
   */
  npmVersion?: string;
}

/**
 * Plugin trust level
 *
 * Determined by source, NOT by metadata claims.
 * - official: Builtin or @authrim/* npm scope
 * - community: Everything else
 *
 * Note: plugin.official flag is for UI hints only,
 * not used for trust determination.
 */
export type PluginTrustLevel = 'official' | 'community';

/**
 * Determine trust level from plugin source
 *
 * Rules:
 * 1. Builtin plugins are always official
 * 2. npm @authrim/* scope is official
 * 3. Everything else is community
 */
export function getPluginTrustLevel(source: PluginSource): PluginTrustLevel {
  // Builtin is always official
  if (source.type === 'builtin') {
    return 'official';
  }

  // npm @authrim/* scope is official
  if (source.type === 'npm' && source.identifier?.startsWith('@authrim/')) {
    return 'official';
  }

  // Everything else is community
  return 'community';
}

/**
 * Disclaimer text for third-party plugins
 *
 * Admin UI is responsible for i18n. This provides only the English text.
 */
export const THIRD_PARTY_DISCLAIMER =
  'This plugin is provided by a third party. Authrim does not guarantee its security, reliability, or compatibility. Use at your own risk.';

// =============================================================================
// Forward Declarations (implemented in other modules)
// =============================================================================

/**
 * Capability registry for plugin registration
 * @see ./registry.ts for implementation
 */
export interface CapabilityRegistry {
  registerNotifier(channel: string, handler: NotifierHandler): void;
  getNotifier(channel: string): NotifierHandler | undefined;
  listCapabilities(): PluginCapability[];
}

/**
 * Plugin context providing access to infrastructure and services
 *
 * Note: Storage and Policy implementations are injected by the Worker.
 * ar-lib-plugin only defines interfaces; ar-lib-core provides implementations.
 */
export interface PluginContext {
  /**
   * Storage access via Store interfaces
   *
   * Note: Raw adapter access is NOT provided to plugins.
   * Use the appropriate Store (user, client, session, etc.) instead.
   * Implementation is provided by ar-lib-core and injected by Worker.
   */
  readonly storage: PluginStorageAccess;

  /** Policy infrastructure (implementation from ar-lib-core) */
  readonly policy: IPolicyInfra;

  /** Plugin configuration store */
  readonly config: PluginConfigStore;

  /** Logger */
  readonly logger: Logger;

  /** Audit logger */
  readonly audit: AuditLogger;

  /** Current tenant ID */
  readonly tenantId: string;

  /** Environment bindings */
  readonly env: Env;
}

// =============================================================================
// Notifier Types
// =============================================================================

/**
 * Notifier handler interface
 */
export interface NotifierHandler {
  /** Send a notification */
  send(notification: Notification): Promise<SendResult>;

  /** Check if handler supports given options (optional) */
  supports?(options: NotificationOptions): boolean;
}

/**
 * Notification payload
 */
export interface Notification {
  /** Notification channel (email, sms, push) */
  channel: string;

  /** Recipient (email address, phone number, device token) */
  to: string;

  /** Sender (optional, uses default if not specified) */
  from?: string;

  /** Subject (for email) */
  subject?: string;

  /** Notification body (HTML for email, plain text for SMS) */
  body: string;

  /** Reply-to address (for email) */
  replyTo?: string;

  /** CC recipients (for email) */
  cc?: string[];

  /** BCC recipients (for email) */
  bcc?: string[];

  /** Template ID (optional) */
  templateId?: string;

  /** Template variables (optional) */
  templateVars?: Record<string, unknown>;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Notification options for capability checking
 */
export interface NotificationOptions {
  channel: string;
  templateId?: string;
  features?: string[];
}

/**
 * Result of sending a notification
 */
export interface SendResult {
  /** Whether the send was successful */
  success: boolean;

  /** Message ID from the provider (if successful) */
  messageId?: string;

  /** Error message (if failed) */
  error?: string;

  /** Error code from the provider (if available) */
  errorCode?: string;

  /** Whether the error is retryable */
  retryable?: boolean;

  /** Provider-specific response data */
  providerResponse?: unknown;
}

// =============================================================================
// Plugin Configuration Store
// =============================================================================

/**
 * Plugin configuration store interface
 *
 * Priority: Cache → KV → Environment Variables → Default Values
 */
export interface PluginConfigStore {
  /**
   * Get plugin configuration (global)
   *
   * @param pluginId - Plugin identifier
   * @param schema - Zod schema for validation
   */
  get<T>(pluginId: string, schema: z.ZodSchema<T>): Promise<T>;

  /**
   * Get plugin configuration for a specific tenant
   *
   * @param pluginId - Plugin identifier
   * @param tenantId - Tenant identifier
   * @param schema - Zod schema for validation
   */
  getForTenant<T>(pluginId: string, tenantId: string, schema: z.ZodSchema<T>): Promise<T>;

  /**
   * Set plugin configuration (via Admin API)
   *
   * @param pluginId - Plugin identifier
   * @param config - Configuration object
   */
  set<T>(pluginId: string, config: T): Promise<void>;
}

// =============================================================================
// Infrastructure Interfaces (Forward Declarations)
// =============================================================================

/**
 * Storage infrastructure interface
 *
 * @internal - Full infrastructure interface with provider info.
 * Implementation is provided by ar-lib-core (not ar-lib-plugin).
 */
export interface IStorageInfra {
  readonly provider: 'cloudflare' | 'aws' | 'gcp' | 'azure' | 'custom';
  readonly user: IUserStore;
  readonly client: IClientStore;
  readonly session: ISessionStore;
  readonly passkey: IPasskeyStore;
  readonly organization: IOrganizationStore;
  readonly role: IRoleStore;
  readonly roleAssignment: IRoleAssignmentStore;
  readonly relationship: IRelationshipStore;
  initialize(env: Env): Promise<void>;
  healthCheck(): Promise<InfraHealthStatus>;
}

/**
 * Plugin-safe storage access
 *
 * Exposes only Store interfaces, NOT the raw adapter.
 * This prevents plugins from writing arbitrary SQL queries,
 * and enforces PII/non-PII data separation at the Store level.
 *
 * Implementation is provided by ar-lib-core and injected by Worker.
 */
export interface PluginStorageAccess {
  /** User data store (@pii) */
  readonly user: IUserStore;

  /** OAuth client store (@non-pii) */
  readonly client: IClientStore;

  /** Session store (@pii - contains IP, user agent) */
  readonly session: ISessionStore;

  /** Passkey credential store (@non-pii) */
  readonly passkey: IPasskeyStore;

  /** Organization store (@non-pii) */
  readonly organization: IOrganizationStore;

  /** Role store (@non-pii) */
  readonly role: IRoleStore;

  /** Role assignment store (@non-pii) */
  readonly roleAssignment: IRoleAssignmentStore;

  /** Relationship store (@non-pii) */
  readonly relationship: IRelationshipStore;
}

// =============================================================================
// Re-export infrastructure types from infra/types.ts (DRY)
// =============================================================================

/**
 * Re-exported from infra/types.ts for convenience.
 * These are the canonical definitions - do not duplicate here.
 */
export type {
  // Policy infrastructure
  _IPolicyInfra as IPolicyInfra,
  _CheckRequest as CheckRequest,
  _CheckResponse as CheckResponse,
  _InfraHealthStatus as InfraHealthStatus,
  // Store interfaces
  _IUserStore as IUserStore,
  _IClientStore as IClientStore,
  _ISessionStore as ISessionStore,
  _IPasskeyStore as IPasskeyStore,
  _IOrganizationStore as IOrganizationStore,
  _IRoleStore as IRoleStore,
  _IRoleAssignmentStore as IRoleAssignmentStore,
  _IRelationshipStore as IRelationshipStore,
  // Entity types
  _User as User,
  _OAuthClient as OAuthClient,
  _Session as Session,
  _Passkey as Passkey,
  _Organization as Organization,
  _Role as Role,
  _RoleAssignment as RoleAssignment,
  _Relationship as Relationship,
};

// =============================================================================
// Logging Interfaces
// =============================================================================

/**
 * Logger interface
 */
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Audit logger interface
 */
export interface AuditLogger {
  log(event: AuditEvent): Promise<void>;
}

/**
 * Audit event
 */
export interface AuditEvent {
  eventType: string;
  actorId?: string;
  actorType: 'user' | 'admin' | 'system' | 'plugin';
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

// =============================================================================
// Environment Types (Cloudflare Workers)
// =============================================================================

/**
 * Cloudflare Workers environment bindings
 *
 * This is a minimal interface; the full definition is in ar-lib-core
 */
export interface Env {
  // KV Namespaces
  AUTHRIM_CONFIG?: KVNamespace;
  USER_CACHE?: KVNamespace;

  // D1 Databases
  DB?: D1Database;
  DB_PII?: D1Database;

  // Durable Objects
  SESSION_STORE?: DurableObjectNamespace;
  KEY_MANAGER?: DurableObjectNamespace;

  // Environment variables
  ENVIRONMENT?: string;
  [key: string]: unknown;
}
