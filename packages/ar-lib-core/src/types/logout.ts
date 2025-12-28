/**
 * OIDC Logout Types
 *
 * Type definitions for OIDC Logout functionality including:
 * - Backchannel Logout (server-to-server)
 * - Frontchannel Logout (browser-based via iframe)
 * - Session Management
 *
 * References:
 * - OIDC Back-Channel Logout 1.0
 * - OIDC Front-Channel Logout 1.0
 * - OIDC Session Management 1.0
 *
 * @packageDocumentation
 */

/**
 * Logout Token Claims
 *
 * OIDC Back-Channel Logout 1.0 Section 2.4
 *
 * The Logout Token is a JWT that contains claims about the logout event.
 * It is signed using the same key as ID Tokens.
 *
 * Design Decision (from review):
 * - `aud` is always a single string (not array) to avoid RP implementation differences
 * - `nonce` MUST NOT be present (per spec)
 */
export interface LogoutTokenClaims {
  /** Issuer URL */
  iss: string;

  /**
   * Audience - Client ID
   *
   * Always a single string, not an array.
   * Backchannel Logout Token is sent to a single RP.
   */
  aud: string;

  /** Issued at timestamp (Unix seconds) */
  iat: number;

  /** Expiration timestamp (Unix seconds) */
  exp: number;

  /** Unique token ID for replay prevention (UUID v4) */
  jti: string;

  /**
   * Logout event claim
   *
   * This is a required claim that indicates this is a logout token.
   * The value is an empty object.
   */
  events: {
    'http://schemas.openid.net/event/backchannel-logout': Record<string, never>;
  };

  /**
   * Subject (user ID)
   *
   * Optional, but at least one of sub or sid MUST be present.
   * Controlled by include_sub_claim setting.
   */
  sub?: string;

  /**
   * Session ID
   *
   * Optional, but at least one of sub or sid MUST be present.
   * Required if backchannel_logout_session_required is true.
   * Controlled by include_sid_claim setting.
   */
  sid?: string;

  // nonce MUST NOT be present
}

/**
 * Logout Retry Configuration
 *
 * Controls the retry behavior for backchannel logout requests.
 *
 * Note: Named LogoutRetryConfig to avoid conflict with D1RetryConfig in d1-retry.ts
 */
export interface LogoutRetryConfig {
  /** Maximum number of retry attempts (not including initial attempt) */
  max_attempts: number;

  /** Initial delay in milliseconds before first retry */
  initial_delay_ms: number;

  /** Maximum delay in milliseconds between retries */
  max_delay_ms: number;

  /** Multiplier for exponential backoff */
  backoff_multiplier: number;
}

/**
 * Backchannel Logout Configuration
 *
 * Settings for server-to-server logout notifications.
 */
export interface BackchannelLogoutConfig {
  /** Whether backchannel logout is enabled */
  enabled: boolean;

  /** Logout token expiration in seconds (default: 120) */
  logout_token_exp_seconds: number;

  /** Whether to include sub claim in logout token */
  include_sub_claim: boolean;

  /** Whether to include sid claim in logout token */
  include_sid_claim: boolean;

  /** Request timeout in milliseconds */
  request_timeout_ms: number;

  /** Retry configuration */
  retry: LogoutRetryConfig;

  /** Action on final failure after all retries */
  on_final_failure: 'log_only' | 'alert';
}

/**
 * Frontchannel Logout Configuration
 *
 * Settings for browser-based (iframe) logout notifications.
 *
 * Note: iframe_timeout_ms is for UX control only, not a security guarantee.
 * The OP cannot detect if the RP successfully processed the logout.
 * For security-critical scenarios, use Backchannel Logout.
 */
export interface FrontchannelLogoutConfig {
  /** Whether frontchannel logout is enabled */
  enabled: boolean;

  /** Timeout for iframe loading in milliseconds (UX only, not security) */
  iframe_timeout_ms: number;

  /** Maximum number of concurrent iframes */
  max_concurrent_iframes: number;
}

/**
 * Session Management Configuration
 *
 * Settings for OIDC Session Management (check_session_iframe).
 *
 * Note: This is primarily for OIDC Conformance testing.
 * In production, this feature is increasingly non-functional due to
 * third-party cookie restrictions in modern browsers.
 */
export interface SessionManagementConfig {
  /** Whether session management is enabled */
  enabled: boolean;

  /** Whether check_session_iframe endpoint is enabled (conformance) */
  check_session_iframe_enabled: boolean;
}

/**
 * Combined Logout Configuration
 *
 * All logout-related settings.
 */
export interface LogoutConfig {
  /** Backchannel logout settings */
  backchannel: BackchannelLogoutConfig;

  /** Frontchannel logout settings */
  frontchannel: FrontchannelLogoutConfig;

  /** Session management settings */
  session_management: SessionManagementConfig;
}

/**
 * Default Logout Configuration
 *
 * Security-focused defaults per CLAUDE.md guidelines.
 */
export const DEFAULT_LOGOUT_CONFIG: LogoutConfig = {
  backchannel: {
    enabled: true,
    logout_token_exp_seconds: 120, // 2 minutes per spec recommendation
    include_sub_claim: true,
    include_sid_claim: true,
    request_timeout_ms: 5000, // 5 seconds
    retry: {
      max_attempts: 3,
      initial_delay_ms: 1000,
      max_delay_ms: 30000,
      backoff_multiplier: 2,
    },
    on_final_failure: 'log_only',
  },
  frontchannel: {
    enabled: true,
    iframe_timeout_ms: 3000, // 3 seconds
    max_concurrent_iframes: 10,
  },
  session_management: {
    enabled: true,
    check_session_iframe_enabled: true, // For conformance
  },
};

/**
 * Logout Send Result
 *
 * Result of attempting to send a logout notification to an RP.
 */
export interface LogoutSendResult {
  /** Client ID of the RP */
  clientId: string;

  /** Whether the logout notification was successful */
  success: boolean;

  /** Method used (backchannel or frontchannel) */
  method: 'backchannel' | 'frontchannel';

  /** HTTP status code (if applicable) */
  statusCode?: number;

  /** Error message (if failed) */
  error?: string;

  /** Whether a retry has been scheduled */
  retryScheduled?: boolean;

  /** Duration of the request in milliseconds */
  duration_ms?: number;
}

/**
 * Logout Failure Record
 *
 * Records a failed logout attempt for admin visibility.
 */
export interface LogoutFailureRecord {
  /** Client ID of the RP */
  clientId: string;

  /** Client name (for display) */
  clientName?: string;

  /** Details of the last failure */
  lastFailure: {
    /** Timestamp of the failure */
    timestamp: number;

    /** HTTP status code (if applicable) */
    statusCode?: number;

    /** Error type/message */
    error: string;

    /** Additional error details */
    errorDetail?: string;
  };
}

/**
 * Backchannel Logout Request
 *
 * Parameters for initiating a backchannel logout.
 */
export interface BackchannelLogoutRequest {
  /** Session ID to terminate */
  sessionId: string;

  /** User ID (subject) */
  userId: string;

  /** Issuer URL */
  issuer: string;

  /** Optional: specific clients to notify (default: all clients for session) */
  clientIds?: string[];
}

/**
 * Frontchannel Logout Request
 *
 * Parameters for generating frontchannel logout HTML.
 */
export interface FrontchannelLogoutRequest {
  /** Session ID */
  sessionId: string;

  /** Issuer URL */
  issuer: string;

  /** Post-logout redirect URI */
  postLogoutRedirectUri?: string;

  /** State parameter to return to RP */
  state?: string;
}

/**
 * Logout Pending Lock
 *
 * Stored in KV to prevent duplicate logout notifications.
 */
export interface LogoutPendingLock {
  /** Current retry attempt */
  attempt: number;

  /** When the lock was created */
  enqueuedAt: number;
}

/**
 * Logout Queue Message
 *
 * Message format for the logout retry queue.
 */
export interface LogoutQueueMessage {
  /** Message type */
  type: 'backchannel_logout_retry';

  /** Client ID to notify */
  clientId: string;

  /** User ID */
  userId: string;

  /** Session ID */
  sessionId: string;

  /** Current attempt number */
  attempt: number;

  /** When this message was scheduled */
  scheduledAt: number;

  /** Issuer URL */
  issuer: string;
}

/**
 * Frontchannel Logout Iframe
 *
 * Represents a single iframe for frontchannel logout.
 */
export interface FrontchannelLogoutIframe {
  /** Client ID */
  clientId: string;

  /** Logout URI with query parameters */
  logoutUri: string;

  /** Whether sid is required */
  sessionRequired: boolean;
}

/**
 * KV Settings Key Constants
 */
export const LOGOUT_SETTINGS_KEY = 'settings:logout';

/**
 * KV Key Prefixes for Logout
 */
export const LOGOUT_KV_PREFIXES = {
  /** Logout token JTI cache (replay prevention) */
  JTI_CACHE: 'bcl_jti:',

  /** Pending logout lock (duplicate prevention) */
  PENDING_LOCK: 'logout:pending:',

  /** Logout failure record */
  FAILURE_RECORD: 'logout:failures:',
} as const;

/**
 * Logout Token Event URI
 */
export const LOGOUT_TOKEN_EVENT_URI = 'http://schemas.openid.net/event/backchannel-logout';

// ============================================================================
// Simple Logout Webhook Types
// ============================================================================

/**
 * Logout Webhook Configuration
 *
 * Settings for the simplified webhook-based logout notifications.
 * This is an alternative to OIDC Back-Channel Logout for clients
 * that don't support the full OIDC spec.
 */
export interface LogoutWebhookConfig {
  /** Whether webhook logout is enabled globally */
  enabled: boolean;

  /** Request timeout in milliseconds (default: 5000) */
  request_timeout_ms: number;

  /** Retry configuration */
  retry: LogoutRetryConfig;

  /** Whether to include sub claim in payload (default: true) */
  include_sub_claim: boolean;

  /** Whether to include sid claim in payload (default: true) */
  include_sid_claim: boolean;

  /** Action on final failure after all retries */
  on_final_failure: 'log_only' | 'alert';
}

/**
 * Default Logout Webhook Configuration
 *
 * Security-focused defaults per CLAUDE.md guidelines.
 */
export const DEFAULT_LOGOUT_WEBHOOK_CONFIG: LogoutWebhookConfig = {
  enabled: false, // Disabled by default (new feature)
  request_timeout_ms: 5000, // 5 seconds
  retry: {
    max_attempts: 3,
    initial_delay_ms: 1000,
    max_delay_ms: 30000,
    backoff_multiplier: 2,
  },
  include_sub_claim: true,
  include_sid_claim: true,
  on_final_failure: 'log_only',
};

/**
 * Logout Webhook Payload
 *
 * The JSON payload sent to the client's logout_webhook_uri.
 * This is a simplified format compared to OIDC Logout Token.
 */
export interface LogoutWebhookPayload {
  /** Event type (always 'user.logout') */
  event: 'user.logout';

  /** Subject (user ID) - optional based on config */
  sub?: string;

  /** Session ID - optional based on config */
  sid?: string;

  /** Issued at timestamp (Unix seconds) */
  iat: number;

  /** Client ID receiving the notification */
  client_id: string;

  /** Issuer URL (Authrim instance) */
  issuer: string;
}

/**
 * Logout Webhook Send Result
 *
 * Result of attempting to send a webhook notification.
 */
export interface LogoutWebhookSendResult {
  /** Client ID of the recipient */
  clientId: string;

  /** Whether the notification was successful */
  success: boolean;

  /** Method identifier */
  method: 'webhook';

  /** HTTP status code (if applicable) */
  statusCode?: number;

  /** Error message (if failed) */
  error?: string;

  /** Whether a retry has been scheduled */
  retryScheduled?: boolean;

  /** Duration of the request in milliseconds */
  duration_ms?: number;
}

/**
 * Session Client With Webhook
 *
 * Extended session client info including webhook configuration.
 */
export interface SessionClientWithWebhook {
  /** Session-client record ID */
  id: string;

  /** Session ID */
  session_id: string;

  /** Client ID */
  client_id: string;

  /** Client name (for logging) */
  client_name: string | null;

  /** Webhook URI */
  logout_webhook_uri: string | null;

  /** Encrypted webhook secret */
  logout_webhook_secret_encrypted: string | null;
}

/**
 * KV Settings Key for Webhook Config
 */
export const LOGOUT_WEBHOOK_SETTINGS_KEY = 'settings:logout_webhook';

/**
 * KV Key Prefixes for Webhook
 */
export const LOGOUT_WEBHOOK_KV_PREFIXES = {
  /** Pending webhook lock (duplicate prevention) */
  PENDING_LOCK: 'logout_webhook:pending:',

  /** Webhook failure record */
  FAILURE_RECORD: 'logout_webhook:failures:',
} as const;
