/**
 * Authrim Plugin Core Types
 *
 * This module defines the core interfaces for the Authrim plugin system.
 */

import type { z } from 'zod';

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
  | `flow.${string}`; // flow.otp-send (future: Flow UI nodes)

/**
 * Plugin category for UI grouping
 */
export type PluginCategory = 'notification' | 'identity' | 'authentication' | 'flow';

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
   * - Lucide icon name (e.g., "mail", "shield-check")
   * - URL to icon image (https://...)
   * - Base64 data URL (data:image/svg+xml;base64,...)
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
 * @see ./context.ts for implementation
 */
export interface PluginContext {
  /** Storage infrastructure */
  readonly storage: IStorageInfra;

  /** Policy infrastructure */
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
 * @see ../infra/types.ts for full definition
 */
export interface IStorageInfra {
  readonly provider: 'cloudflare' | 'aws' | 'gcp' | 'azure' | 'custom';
  initialize(env: Env): Promise<void>;
  healthCheck(): Promise<InfraHealthStatus>;
}

/**
 * Policy infrastructure interface
 * @see ../infra/types.ts for full definition
 */
export interface IPolicyInfra {
  readonly provider: 'builtin' | 'openfga' | 'opa' | 'custom';
  initialize(env: Env, storage: IStorageInfra): Promise<void>;
}

/**
 * Infrastructure health status
 */
export interface InfraHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  provider: string;
  latencyMs?: number;
  message?: string;
}

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
  PII_DB?: D1Database;

  // Durable Objects
  SESSION_STORE?: DurableObjectNamespace;
  KEY_MANAGER?: DurableObjectNamespace;

  // Environment variables
  ENVIRONMENT?: string;
  [key: string]: unknown;
}
