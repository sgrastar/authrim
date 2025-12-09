// Import DO classes for type-safe RPC bindings
import type { KeyManager } from '../durable-objects/KeyManager';
import type { SessionStore } from '../durable-objects/SessionStore';
import type { AuthorizationCodeStore } from '../durable-objects/AuthorizationCodeStore';
import type { RefreshTokenRotator } from '../durable-objects/RefreshTokenRotator';
import type { RateLimiterCounter } from '../durable-objects/RateLimiterCounter';
import type { PARRequestStore } from '../durable-objects/PARRequestStore';

/**
 * Cloudflare Workers Environment Bindings
 *
 * Durable Object bindings use generic type parameters for RPC type safety.
 * Example: DurableObjectNamespace<SessionStore> enables stub.getSessionRpc()
 */
export interface Env {
  // D1 Database
  DB: D1Database;

  // R2 Buckets
  AVATARS: R2Bucket;

  // KV Namespaces
  STATE_STORE: KVNamespace;
  NONCE_STORE: KVNamespace;
  CLIENTS_CACHE: KVNamespace; // Client metadata cache (Read-Through from D1, 1 hour TTL)
  USER_CACHE?: KVNamespace; // User metadata cache (Read-Through from D1, 1 hour TTL, with invalidation hook)
  INITIAL_ACCESS_TOKENS?: KVNamespace; // For Dynamic Client Registration (RFC 7591)
  AUTHRIM_CONFIG?: KVNamespace; // Dynamic configuration (shard count, feature flags, etc.)

  // KV Namespaces for Phase 5
  JWKS_CACHE?: KVNamespace; // JWKs cache (from KeyManager DO)
  MAGIC_LINKS?: KVNamespace; // Magic Link tokens (TTL: 15 min)
  KV?: KVNamespace; // General purpose KV for session tokens and other data
  SETTINGS?: KVNamespace; // System settings storage
  REBAC_CACHE?: KVNamespace; // RBAC claims cache (Read-Through from D1, 5 min TTL)

  // Durable Objects with RPC type support
  KEY_MANAGER: DurableObjectNamespace<KeyManager>;
  SESSION_STORE: DurableObjectNamespace<SessionStore>;
  AUTH_CODE_STORE: DurableObjectNamespace<AuthorizationCodeStore>;
  REFRESH_TOKEN_ROTATOR: DurableObjectNamespace<RefreshTokenRotator>;
  CHALLENGE_STORE: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace<RateLimiterCounter>; // #6: Atomic rate limiting
  USER_CODE_RATE_LIMITER: DurableObjectNamespace; // Device flow user code rate limiting
  PAR_REQUEST_STORE: DurableObjectNamespace<PARRequestStore>; // #11: PAR request_uri single-use
  DPOP_JTI_STORE: DurableObjectNamespace; // #12: DPoP JTI replay protection
  TOKEN_REVOCATION_STORE: DurableObjectNamespace; // Token revocation list
  DEVICE_CODE_STORE: DurableObjectNamespace; // RFC 8628: Device Authorization Grant
  CIBA_REQUEST_STORE: DurableObjectNamespace; // OpenID Connect CIBA Flow
  VERSION_MANAGER: DurableObjectNamespace; // Worker bundle version management
  SAML_REQUEST_STORE: DurableObjectNamespace; // SAML 2.0 request/artifact store

  // Environment Variables
  ISSUER_URL: string;
  ALLOWED_ORIGINS?: string; // Comma-separated list of allowed origins (CORS + WebAuthn RP ID)
  TOKEN_EXPIRY: string;
  CODE_EXPIRY: string;
  STATE_EXPIRY: string;
  NONCE_EXPIRY: string;
  REFRESH_TOKEN_EXPIRY: string;
  REFRESH_TOKEN_ROTATION_ENABLED?: string; // "false" to disable token rotation (for load testing only!)
  ALLOW_HTTP_REDIRECT?: string; // Allow http:// redirect URIs for development
  MAX_CODES_PER_USER?: string; // Max authorization codes per user (default: 100, increase for load testing)
  AUTH_CODE_TTL?: string; // Authorization code TTL in seconds (default: 60, increase for load testing)
  AUTH_CODE_CLEANUP_INTERVAL?: string; // Auth code cleanup interval in seconds (default: 30, increase for load testing)
  AUTHRIM_CODE_SHARDS?: string; // Number of auth code DO shards (default: 64, set to 0 to disable sharding)
  AUTHRIM_SESSION_SHARDS?: string; // Number of session DO shards (default: 32)

  // Dynamic Client Registration settings
  OPEN_REGISTRATION?: string; // "true" to allow registration without Initial Access Token

  // Secrets (cryptographic keys)
  PRIVATE_KEY_PEM?: string;
  PUBLIC_JWK_JSON?: string; // Public JWK as JSON string
  KEY_ID?: string;

  // Pairwise subject identifier salt (OIDC Core 8.1)
  PAIRWISE_SALT?: string;

  // Email OTP HMAC secret for code hashing
  OTP_HMAC_SECRET?: string;

  // Admin secrets for Durable Objects management
  KEY_MANAGER_SECRET?: string;
  ADMIN_API_SECRET?: string; // Admin API authentication secret (Bearer token)

  // Email configuration (Phase 5)
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;

  // Redirect configuration
  DEFAULT_REDIRECT_URL?: string; // Default redirect URL for magic link verification
  UI_URL?: string; // URL of the UI deployment (Cloudflare Pages)
  UI_BASE_URL?: string; // Base URL for the UI (used for device authorization flow)

  // JWT Bearer Flow (RFC 7523) - Phase 6
  TRUSTED_JWT_ISSUERS?: string; // Comma-separated list of trusted issuers for JWT Bearer flow

  // Trusted Client domains (comma-separated)
  // Clients with redirect_uri domains in this list are automatically trusted
  TRUSTED_DOMAINS?: string;

  // Version Management (set by deploy script via --var)
  CODE_VERSION_UUID?: string; // UUID v4 identifying this deployed bundle
  DEPLOY_TIME_UTC?: string; // ISO 8601 timestamp of deployment

  // RBAC Claims Configuration (Phase 2)
  // Comma-separated list of claims to include in tokens
  // ID Token: roles,scoped_roles,user_type,org_id,org_name,plan,org_type,orgs,relationships_summary
  // Access Token: roles,scoped_roles,org_id,org_type,permissions,org_context
  RBAC_ID_TOKEN_CLAIMS?: string; // Default: "roles,user_type,org_id,plan,org_type"
  RBAC_ACCESS_TOKEN_CLAIMS?: string; // Default: "roles,org_id,org_type"

  // RBAC Consent Screen Configuration (Phase 2-B)
  // Feature flags to control consent screen RBAC features
  RBAC_CONSENT_ORG_SELECTOR?: string; // "true" to show organization selector for multi-org users
  RBAC_CONSENT_ACTING_AS?: string; // "true" to enable acting-as (delegation) feature
  RBAC_CONSENT_SHOW_ROLES?: string; // "true" to display user's roles on consent screen

  // SD-JWT Feature Flag (RFC 9901)
  // When "true", clients with id_token_signed_response_type="sd-jwt" will receive SD-JWT ID tokens
  ENABLE_SD_JWT?: string;

  // Policy Embedding Feature Flag
  // When "true", evaluates requested scopes against PolicyEngine and embeds
  // permitted actions as authrim_permissions in Access Token
  ENABLE_POLICY_EMBEDDING?: string;

  // HTTPS Request URI Feature Flag (OIDC Core 6.2)
  // SECURITY: Disabled by default to prevent SSRF attacks
  // When "true", allows fetching Request Objects from external HTTPS URLs
  // PAR (RFC 9126) URN format is always allowed and recommended
  ENABLE_HTTPS_REQUEST_URI?: string; // "true" to enable external HTTPS request_uri

  // HTTPS Request URI Security Controls (only relevant when ENABLE_HTTPS_REQUEST_URI="true")
  // Comma-separated list of allowed domains for HTTPS request_uri (empty = allow all)
  HTTPS_REQUEST_URI_ALLOWED_DOMAINS?: string;
  // Fetch timeout in milliseconds (default: 5000)
  HTTPS_REQUEST_URI_TIMEOUT_MS?: string;
  // Maximum response body size in bytes (default: 102400 = 100KB)
  HTTPS_REQUEST_URI_MAX_SIZE_BYTES?: string;

  // External IdP Configuration (Phase 7)
  // Identity stitching: automatically link external identities to existing users by verified email
  IDENTITY_STITCHING_ENABLED?: string; // "true" to enable automatic identity stitching
  IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL?: string; // "false" to allow unverified emails (not recommended)
  // Encryption key for storing external IdP tokens (32-byte hex string)
  RP_TOKEN_ENCRYPTION_KEY?: string;
}
