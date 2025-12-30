/**
 * Event Type Constants
 *
 * Defines all standard event types for the Unified Event System.
 * These constants should be used when publishing events to ensure consistency.
 *
 * @packageDocumentation
 */

// =============================================================================
// Authentication Events
// =============================================================================

/**
 * Authentication event types.
 *
 * Pattern: auth.<method>.<outcome>
 */
export const AUTH_EVENTS = {
  // Passkey (WebAuthn)
  PASSKEY_SUCCEEDED: 'auth.passkey.succeeded',
  PASSKEY_FAILED: 'auth.passkey.failed',

  // Password (if implemented)
  PASSWORD_SUCCEEDED: 'auth.password.succeeded',
  PASSWORD_FAILED: 'auth.password.failed',

  // Email OTP
  EMAIL_CODE_SUCCEEDED: 'auth.email_code.succeeded',
  EMAIL_CODE_FAILED: 'auth.email_code.failed',

  // Magic Link
  MAGIC_LINK_SUCCEEDED: 'auth.magic_link.succeeded',
  MAGIC_LINK_FAILED: 'auth.magic_link.failed',

  // Social/External IdP
  EXTERNAL_IDP_SUCCEEDED: 'auth.external_idp.succeeded',
  EXTERNAL_IDP_FAILED: 'auth.external_idp.failed',

  // DID Authentication (Decentralized Identifier)
  DID_SUCCEEDED: 'auth.did.succeeded',
  DID_FAILED: 'auth.did.failed',

  // SAML Authentication
  SAML_SUCCEEDED: 'auth.saml.succeeded',
  SAML_FAILED: 'auth.saml.failed',

  // Generic login events (use when method-specific is not applicable)
  LOGIN_SUCCEEDED: 'auth.login.succeeded',
  LOGIN_FAILED: 'auth.login.failed',
} as const;

export type AuthEventType = (typeof AUTH_EVENTS)[keyof typeof AUTH_EVENTS];

// =============================================================================
// Session Events
// =============================================================================

/**
 * Session event types.
 *
 * Pattern: session.<entity>.<action>
 */
export const SESSION_EVENTS = {
  // User sessions
  USER_CREATED: 'session.user.created',
  USER_DESTROYED: 'session.user.destroyed',
  USER_REFRESHED: 'session.user.refreshed',

  // Client sessions (in RP context)
  CLIENT_CREATED: 'session.client.created',
  CLIENT_DESTROYED: 'session.client.destroyed',
} as const;

export type SessionEventType = (typeof SESSION_EVENTS)[keyof typeof SESSION_EVENTS];

// =============================================================================
// Token Events
// =============================================================================

/**
 * Token event types.
 *
 * Pattern: token.<type>.<action>
 */
export const TOKEN_EVENTS = {
  // Access tokens
  ACCESS_ISSUED: 'token.access.issued',
  ACCESS_REVOKED: 'token.access.revoked',
  ACCESS_INTROSPECTED: 'token.access.introspected',

  // Refresh tokens
  REFRESH_ISSUED: 'token.refresh.issued',
  REFRESH_REVOKED: 'token.refresh.revoked',
  REFRESH_ROTATED: 'token.refresh.rotated',

  // ID tokens
  ID_ISSUED: 'token.id.issued',

  // Batch operations
  BATCH_REVOKED: 'token.batch.revoked',
} as const;

export type TokenEventType = (typeof TOKEN_EVENTS)[keyof typeof TOKEN_EVENTS];

// =============================================================================
// Consent Events
// =============================================================================

/**
 * Consent event types.
 *
 * Pattern: consent.<action>
 */
export const CONSENT_EVENTS = {
  /** User granted consent to a client */
  GRANTED: 'consent.granted',
  /** User denied consent to a client */
  DENIED: 'consent.denied',
  /** User or admin revoked previously granted consent */
  REVOKED: 'consent.revoked',
  /** User agreed to updated policy versions (re-consent) */
  VERSION_UPGRADED: 'consent.version_upgraded',
  /** User modified their selected scopes (granular consent) */
  SCOPES_UPDATED: 'consent.scopes_updated',
  /** Consent expired due to time limit */
  EXPIRED: 'consent.expired',
} as const;

export type ConsentEventType = (typeof CONSENT_EVENTS)[keyof typeof CONSENT_EVENTS];

// =============================================================================
// User Management Events
// =============================================================================

/**
 * User management event types.
 *
 * Pattern: user.<action>
 */
export const USER_EVENTS = {
  CREATED: 'user.created',
  UPDATED: 'user.updated',
  DELETED: 'user.deleted',
  PASSWORD_CHANGED: 'user.password_changed',
  EMAIL_VERIFIED: 'user.email_verified',
  LOGOUT: 'user.logout',
} as const;

export type UserEventType = (typeof USER_EVENTS)[keyof typeof USER_EVENTS];

// =============================================================================
// Client Management Events
// =============================================================================

/**
 * Client management event types.
 *
 * Pattern: client.<action>
 */
export const CLIENT_EVENTS = {
  CREATED: 'client.created',
  UPDATED: 'client.updated',
  DELETED: 'client.deleted',
  SECRET_ROTATED: 'client.secret_rotated',
  // RFC 7592: Client Configuration Endpoint events
  CONFIG_READ: 'client.config.read',
  CONFIG_UPDATED: 'client.config.updated',
  CONFIG_DELETED: 'client.config.deleted',
} as const;

export type ClientEventType = (typeof CLIENT_EVENTS)[keyof typeof CLIENT_EVENTS];

// =============================================================================
// Security Events
// =============================================================================

/**
 * Security event types.
 *
 * Pattern: security.<category>.<action>
 */
export const SECURITY_EVENTS = {
  // Rate limiting
  RATE_LIMIT_EXCEEDED: 'security.rate_limit.exceeded',

  // Suspicious activity
  SUSPICIOUS_LOGIN_ATTEMPT: 'security.suspicious.login_attempt',
  CREDENTIAL_STUFFING_DETECTED: 'security.suspicious.credential_stuffing',

  // Account security
  ACCOUNT_LOCKED: 'security.account.locked',
  ACCOUNT_UNLOCKED: 'security.account.unlocked',
} as const;

export type SecurityEventType = (typeof SECURITY_EVENTS)[keyof typeof SECURITY_EVENTS];

// =============================================================================
// Domain Verification Events
// =============================================================================

/**
 * Domain verification event types.
 *
 * Pattern: domain.verification.<action>
 */
export const DOMAIN_EVENTS = {
  /** Domain verification initiated */
  VERIFICATION_STARTED: 'domain.verification.started',
  /** Domain verification completed successfully */
  VERIFICATION_SUCCEEDED: 'domain.verification.succeeded',
  /** Domain verification failed */
  VERIFICATION_FAILED: 'domain.verification.failed',
} as const;

export type DomainEventType = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

// =============================================================================
// Settings Events
// =============================================================================

/**
 * Settings configuration event types.
 *
 * Pattern: settings.<action>
 */
export const SETTINGS_EVENTS = {
  /** Settings updated */
  UPDATED: 'settings.updated',
  /** Settings rollback started */
  ROLLBACK_STARTED: 'settings.rollback.started',
  /** Settings rollback completed */
  ROLLBACK_COMPLETED: 'settings.rollback.completed',
  /** Settings rollback failed */
  ROLLBACK_FAILED: 'settings.rollback.failed',
} as const;

export type SettingsEventType = (typeof SETTINGS_EVENTS)[keyof typeof SETTINGS_EVENTS];

// =============================================================================
// Combined Event Types
// =============================================================================

/**
 * All event types combined.
 */
export const EVENT_TYPES = {
  ...AUTH_EVENTS,
  ...SESSION_EVENTS,
  ...TOKEN_EVENTS,
  ...CONSENT_EVENTS,
  ...USER_EVENTS,
  ...CLIENT_EVENTS,
  ...SECURITY_EVENTS,
  ...DOMAIN_EVENTS,
  ...SETTINGS_EVENTS,
} as const;

export type EventType =
  | AuthEventType
  | SessionEventType
  | TokenEventType
  | ConsentEventType
  | UserEventType
  | ClientEventType
  | SecurityEventType
  | DomainEventType
  | SettingsEventType;

// =============================================================================
// Event Data Types
// =============================================================================

/**
 * Base event data that all events should include.
 */
export interface BaseEventData {
  /** Timestamp of the event (Unix epoch in seconds) */
  timestamp?: number;
}

/**
 * Auth event data.
 */
export interface AuthEventData extends BaseEventData {
  /** User ID (subject) - omit in failed events for security */
  userId?: string;
  /** Authentication method */
  method:
    | 'passkey'
    | 'password'
    | 'email_code'
    | 'magic_link'
    | 'external_idp'
    | 'did'
    | 'saml'
    | 'anonymous'
    | 'upgrade'; // architecture-decisions.md §17
  /** Client ID */
  clientId: string;
  /** Session ID (for successful auth) */
  sessionId?: string;
  /** Error code (for failed auth) */
  errorCode?: string;
  /** IP address (hashed for privacy) */
  ipHash?: string;
  /** User agent (truncated) */
  userAgent?: string;
}

/**
 * Session event data.
 */
export interface SessionEventData extends BaseEventData {
  /** Session ID */
  sessionId: string;
  /** User ID */
  userId: string;
  /** Session TTL in seconds (for created/refreshed) */
  ttlSeconds?: number;
  /** Destruction reason (for destroyed) */
  reason?: 'logout' | 'expired' | 'revoked' | 'security';
}

/**
 * Token event data.
 */
export interface TokenEventData extends BaseEventData {
  /** Token JTI (identifier) */
  jti?: string;
  /** Client ID */
  clientId: string;
  /** User ID (subject) */
  userId?: string;
  /** Token scopes */
  scopes?: string[];
  /** Token expiration (Unix epoch) */
  expiresAt?: number;
  /** Grant type used */
  grantType?: string;
}

/**
 * Batch revocation event data.
 */
export interface BatchRevokeEventData extends BaseEventData {
  /** Client ID that initiated the batch revocation */
  clientId: string;
  /** Total number of tokens in the batch */
  total: number;
  /** Number of tokens successfully revoked */
  revoked: number;
  /** Number of invalid/already revoked tokens */
  invalid: number;
}

/**
 * Consent event data.
 */
export interface ConsentEventData extends BaseEventData {
  /** User ID */
  userId: string;
  /** Client ID */
  clientId: string;
  /** Granted scopes */
  scopes: string[];
}

/**
 * Extended consent event data for version upgrade and scope update events.
 * Used with VERSION_UPGRADED, SCOPES_UPDATED, and REVOKED events.
 */
export interface ExtendedConsentEventData extends ConsentEventData {
  /** Previous scopes (for SCOPES_UPDATED) */
  previousScopes?: string[];
  /** Previous privacy policy version (for VERSION_UPGRADED) */
  previousPrivacyPolicyVersion?: string;
  /** New privacy policy version (for VERSION_UPGRADED) */
  newPrivacyPolicyVersion?: string;
  /** Previous TOS version (for VERSION_UPGRADED) */
  previousTosVersion?: string;
  /** New TOS version (for VERSION_UPGRADED) */
  newTosVersion?: string;
  /** Revocation reason (for REVOKED) */
  revocationReason?: 'user_request' | 'admin_action' | 'policy_violation' | 'expiration';
  /** Who initiated the action */
  initiatedBy?: 'user' | 'admin' | 'system';
}

/**
 * User management event data.
 *
 * For USER_EVENTS.LOGOUT, sessionId and reason should be included.
 * For CREATED/UPDATED/DELETED, only userId is required.
 */
export interface UserEventData extends BaseEventData {
  /** User ID */
  userId: string;
  /** Session ID (for logout events) */
  sessionId?: string;
  /** Logout reason (for logout events) */
  reason?: 'logout' | 'expired' | 'revoked' | 'security';
}

/**
 * Client management event data.
 */
export interface ClientEventData extends BaseEventData {
  /** Client ID */
  clientId: string;
}

/**
 * Security event data.
 */
export interface SecurityEventData extends BaseEventData {
  /** Endpoint path */
  endpoint?: string;
  /** Client IP (hashed for privacy) */
  clientIpHash?: string;
  /** User ID (if authenticated) */
  userId?: string;
  /** Client ID (if applicable) */
  clientId?: string;
  /** Rate limit details */
  rateLimit?: {
    maxRequests: number;
    windowSeconds: number;
    retryAfter: number;
  };
}

/**
 * Domain verification event data.
 */
export interface DomainEventData extends BaseEventData {
  /** Domain mapping ID */
  mappingId: string;
  /** Domain name (masked for privacy in logs) */
  domain?: string;
  /** Organization ID */
  orgId: string;
  /** Verification method used */
  verificationMethod: string;
  /** Error message (for failed events) */
  errorMessage?: string;
}

/**
 * Settings event data.
 */
export interface SettingsEventData extends BaseEventData {
  /** Settings category (oauth, rate_limit, logout, etc.) */
  category: string;
  /** Current version number */
  currentVersion?: number;
  /** Target version number (for rollback) */
  targetVersion?: number;
  /** Actor who made the change */
  actorId?: string;
  /** Change source (admin_api, settings_ui, etc.) */
  changeSource?: string;
  /** Error message (for failed events) */
  errorMessage?: string;
}
