/**
 * Authrim Error System - Type Definitions
 *
 * Core types for the error handling system.
 * These types are designed for SDK public exposure.
 *
 * @packageDocumentation
 */

/**
 * User action recommendations for error recovery
 * SDK clients use this to determine appropriate UX flows
 */
export type UserAction =
  | 'login' // Re-login required (session expired)
  | 'reauth' // Re-authentication required (step-up/MFA)
  | 'consent' // Navigate to consent screen
  | 'retry' // Manual retry recommended (not automatic)
  | 'contact_admin' // Contact administrator
  | 'update_client' // Update client configuration
  | 'none'; // No recovery action available

/**
 * Error severity levels for logging and alerting
 */
export type Severity = 'info' | 'warn' | 'error' | 'critical';

/**
 * Error response format options
 */
export type ErrorResponseFormat = 'oauth' | 'problem_details';

/**
 * Error ID generation mode
 */
export type ErrorIdMode = 'all' | '5xx' | 'security_only' | 'none';

/**
 * Supported locales for error messages
 */
export type ErrorLocale = 'en' | 'ja';

/**
 * Error security classification
 * Determines how much detail is exposed to clients
 */
export type ErrorSecurityLevel =
  | 'public' // Full details returned
  | 'masked' // Generic message replacement
  | 'internal'; // Log only, generic error to client

/**
 * Error metadata for AI Agents and SDKs
 *
 * This interface is mandatory for SDK public exposure.
 * "Types that exist get used; types that don't exist get forgotten"
 *
 * @public
 */
export interface ErrorMeta {
  /**
   * Whether automatic retry with exponential backoff is effective
   * true = same request can be retried automatically
   * false = user action or config change required
   */
  retryable: boolean;

  /**
   * Whether the error is transient (temporary)
   * Used when retryable:false but error may resolve over time
   * Example: External IdP temporary unavailability
   */
  transient?: boolean;

  /**
   * Recommended user action for error recovery
   */
  user_action?: UserAction;

  /**
   * Error severity for logging and alerting
   */
  severity: Severity;
}

/**
 * Normalized error descriptor
 *
 * This is the return type of ErrorFactory - HTTP response format independent.
 * The endpoint layer serializes this to OAuth or Problem Details format.
 *
 * @public
 */
export interface ErrorDescriptor {
  // Identifiers
  /** Authrim error code (AR000001 format) */
  code: string;

  /** RFC standard error code (invalid_grant, etc.) */
  rfcError: string;

  /** Type URI slug for Problem Details (auth/session-expired) */
  typeSlug: string;

  // Messages (localized)
  /** Short summary */
  title: string;

  /** Detailed message */
  detail: string;

  // HTTP
  /** HTTP status code */
  status: number;

  // Metadata (SDK mandatory)
  /** Error metadata for AI Agents and SDKs */
  meta: ErrorMeta;

  // Optional fields
  /** Trace ID for support (based on error_id_mode setting) */
  errorId?: string;

  /** State parameter for Authorization Endpoint errors */
  state?: string;

  /** Retry-After header value in seconds (for rate limiting) */
  retryAfter?: number;
}

/**
 * OAuth 2.0 / OIDC standard error response format
 * RFC 6749 Section 5.2
 */
export interface OAuthErrorResponse {
  /** RFC standard error code */
  error: string;

  /** Localized error description */
  error_description: string;

  /** Documentation URL */
  error_uri?: string;

  /** State parameter (Authorization Endpoint) */
  state?: string;

  // Authrim extensions
  /** Internal error code (AR000001 format) */
  error_code?: string;

  /** Trace ID for support */
  error_id?: string;
}

/**
 * RFC 9457 Problem Details response format
 */
export interface ProblemDetailsResponse {
  /** Problem type URI */
  type: string;

  /** Short human-readable summary */
  title: string;

  /** HTTP status code */
  status: number;

  /** Detailed human-readable explanation */
  detail: string;

  /** URI identifying the specific occurrence */
  instance?: string;

  // OAuth compatibility
  /** RFC standard error code */
  error?: string;

  /** Internal error code (AR000001 format) */
  error_code?: string;

  /** Trace ID for support */
  error_id?: string;

  /** Error metadata for AI Agents and SDKs */
  error_meta?: ErrorMeta;
}

/**
 * Error code definition structure
 */
export interface ErrorCodeDefinition {
  /** Authrim code (AR000001) */
  code: string;

  /** RFC standard error to use */
  rfcError: string;

  /** HTTP status code */
  status: number;

  /** Type URI slug */
  typeSlug: string;

  /** Default English title */
  titleKey: string;

  /** Default English detail message key (used when detailFixed is not set) */
  detailKey: string;

  /**
   * Fixed detail message (RFC-compliant, not translated).
   * When set, this takes precedence over detailKey.
   * Used for RFC-mandated error messages like Device Flow.
   */
  detailFixed?: string;

  /** Error metadata */
  meta: ErrorMeta;

  /** Security classification */
  securityLevel: ErrorSecurityLevel;
}

/**
 * Error message template with placeholder support
 * Placeholders use {key} format
 */
export type ErrorMessages = Record<string, string>;

/**
 * Error factory options
 */
export interface ErrorFactoryOptions {
  /** Locale for messages */
  locale?: ErrorLocale;

  /** Error ID generation mode */
  errorIdMode?: ErrorIdMode;

  /** State parameter (for Authorization Endpoint) */
  state?: string;

  /** Custom message variables for placeholder replacement */
  variables?: Record<string, string | number>;
}

/**
 * Error serialization options
 */
export interface SerializeOptions {
  /** Response format */
  format: ErrorResponseFormat;

  /** Base URL for Problem Details type URI */
  baseUrl?: string;
}

/**
 * Security tracked errors for error_id_mode='security_only'
 */
export const SECURITY_TRACKED_ERRORS = [
  // RFC standard errors
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'access_denied',

  // Authrim type URI slugs
  'client/authentication-failed',
  'user/invalid-credentials',
  'user/locked',
  'token/reuse-detected',
  'rate-limit/exceeded',
  'policy/invalid-api-key',
  'admin/authentication-required',
] as const;

export type SecurityTrackedError = (typeof SECURITY_TRACKED_ERRORS)[number];

/**
 * OIDC core endpoints where format switching is disabled
 */
export const OIDC_CORE_ENDPOINTS = [
  '/authorize',
  '/token',
  '/userinfo',
  '/introspect',
  '/revoke',
] as const;

export type OIDCCoreEndpoint = (typeof OIDC_CORE_ENDPOINTS)[number];
