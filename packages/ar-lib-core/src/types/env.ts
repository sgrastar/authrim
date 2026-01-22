// Import DO classes for type-safe RPC bindings
import type { KeyManager } from '../durable-objects/KeyManager';
import type { SessionStore } from '../durable-objects/SessionStore';
import type { AuthorizationCodeStore } from '../durable-objects/AuthorizationCodeStore';
import type { RefreshTokenRotator } from '../durable-objects/RefreshTokenRotator';
import type { RateLimiterCounter } from '../durable-objects/RateLimiterCounter';
import type { PARRequestStore } from '../durable-objects/PARRequestStore';
import type { ChallengeStore } from '../durable-objects/ChallengeStore';

/**
 * Cloudflare Workers Environment Bindings
 *
 * Durable Object bindings use generic type parameters for RPC type safety.
 * Example: DurableObjectNamespace<SessionStore> enables stub.getSessionRpc()
 *
 * ## Environment Variable Naming Conventions
 *
 * ### Time-related variables:
 * - Token/Auth: `*_EXPIRY` (OAuth/OIDC RFC compliant, unit: seconds)
 * - Cache: `*_CACHE_TTL` (industry standard, unit: seconds)
 * - Timeout: `*_TIMEOUT_MS` (operation timeout, unit: milliseconds)
 * - Window: `*_WINDOW_SECONDS` (time window, unit explicit)
 *
 * ### Feature flags:
 * - All flags use `ENABLE_*` prefix (e.g., ENABLE_RATE_LIMIT)
 * - Value: "true" to enable, "false" or omit to disable
 *
 * ### Prefixes:
 * - None: Core settings (ISSUER_URL, BASE_DOMAIN)
 * - AUTHRIM_: Authrim-specific (sharding, config)
 * - SCIM_: SCIM settings
 * - RBAC_: RBAC settings
 * - API_: API settings
 * - PII_: PII encryption settings
 */
export interface Env {
  // D1 Databases
  DB: D1Database; // Core DB (non-PII data: users_core, sessions, passkeys, clients, roles)
  DB_PII: D1Database; // PII DB (personal information: users_pii, linked_identities, subject_identifiers)

  // R2 Buckets
  AVATARS: R2Bucket;

  // KV Namespaces
  STATE_STORE: KVNamespace;
  NONCE_STORE: KVNamespace;
  CLIENTS_CACHE: KVNamespace; // Client metadata cache (Read-Through from D1, 1 hour TTL)
  USER_CACHE?: KVNamespace; // User metadata cache (Read-Through from D1, 1 hour TTL, with invalidation hook)
  CONSENT_CACHE?: KVNamespace; // Consent status cache (Read-Through from D1, 24 hour TTL)
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
  CHALLENGE_STORE: DurableObjectNamespace<ChallengeStore>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiterCounter>; // #6: Atomic rate limiting
  USER_CODE_RATE_LIMITER: DurableObjectNamespace; // Device flow user code rate limiting
  PAR_REQUEST_STORE: DurableObjectNamespace<PARRequestStore>; // #11: PAR request_uri single-use
  DPOP_JTI_STORE: DurableObjectNamespace; // #12: DPoP JTI replay protection
  TOKEN_REVOCATION_STORE: DurableObjectNamespace; // Token revocation list
  DEVICE_CODE_STORE: DurableObjectNamespace; // RFC 8628: Device Authorization Grant
  CIBA_REQUEST_STORE: DurableObjectNamespace; // OpenID Connect CIBA Flow
  VERSION_MANAGER: DurableObjectNamespace; // Worker bundle version management
  SAML_REQUEST_STORE: DurableObjectNamespace; // SAML 2.0 request/artifact store
  PERMISSION_CHANGE_HUB?: DurableObjectNamespace; // Phase 8.3: Real-time permission change notifications
  FLOW_STATE_STORE?: DurableObjectNamespace; // Track C: Flow Engine state management

  // Service Bindings (Worker-to-Worker communication)
  EXTERNAL_IDP?: Fetcher; // External IdP worker (ar-bridge) for social login and enterprise IdP

  // ============================================================
  // Environment Variables - Token/Auth Expiry (unit: seconds)
  // ============================================================
  ISSUER_URL: string;
  ALLOWED_ORIGINS?: string; // Comma-separated list of allowed origins (CORS + WebAuthn RP ID)
  ACCESS_TOKEN_EXPIRY: string; // Access token lifetime in seconds (default: 3600)
  AUTH_CODE_EXPIRY: string; // Authorization code lifetime in seconds (default: 60, OAuth 2.0 BCP)
  STATE_EXPIRY: string; // OAuth state parameter lifetime in seconds (default: 300)
  NONCE_EXPIRY: string; // OIDC nonce lifetime in seconds (default: 300)
  REFRESH_TOKEN_EXPIRY: string; // Refresh token lifetime in seconds (default: 7776000 = 90 days)
  AUTH_CODE_CLEANUP_INTERVAL?: string; // Auth code cleanup interval in seconds (default: 30)

  // ============================================================
  // Feature Flags (ENABLE_* prefix)
  // ============================================================

  // Core OAuth/OIDC Features
  ENABLE_REFRESH_TOKEN_ROTATION?: string; // "false" to disable token rotation (for load testing only!)
  ENABLE_HTTP_REDIRECT?: string; // "true" to allow http:// redirect URIs for development
  ENABLE_STATE_REQUIRED?: string; // "true" to require state parameter (CSRF protection)
  ENABLE_USERINFO_REQUIRE_OPENID_SCOPE?: string; // "false" to allow UserInfo without openid scope (OAuth 2.0 compatibility)
  ENABLE_OPEN_REGISTRATION?: string; // "true" to allow registration without Initial Access Token
  ENABLE_CONFORMANCE_MODE?: string; // "true" to enable built-in forms instead of external UI

  // API & Versioning
  ENABLE_API_VERSIONING?: string; // "false" to disable API versioning middleware (default: enabled)
  API_DEFAULT_VERSION?: string; // Default API version when not specified (YYYY-MM-DD format, default: "2024-12-01")
  API_CURRENT_STABLE_VERSION?: string; // Current stable version (YYYY-MM-DD format, default: "2024-12-01")
  API_SUPPORTED_VERSIONS?: string; // Comma-separated list of supported versions (YYYY-MM-DD format)
  API_UNKNOWN_VERSION_MODE?: string; // "fallback" | "warn" | "reject" - how to handle unknown versions (default: "fallback")
  ENABLE_DEPRECATION_HEADERS?: string; // "false" to disable deprecation headers (default: enabled)
  ENABLE_SDK_COMPATIBILITY_CHECK?: string; // "true" to enable SDK compatibility checking

  // Rate Limiting
  RATE_LIMIT_PROFILE?: string; // "loadTest" to use 10000 req/min instead of default limits
  ENABLE_RATE_LIMIT?: string; // "false" to completely disable rate limiting (default: enabled)

  // SCIM Authentication Rate Limiting (RFC 7644)
  SCIM_AUTH_MAX_FAILED_ATTEMPTS?: string; // Max failures before lockout (default: 5)
  SCIM_AUTH_WINDOW_SECONDS?: string; // Time window for counting failures (default: 300)
  SCIM_AUTH_LOCKOUT_SECONDS?: string; // Lockout duration after exceeding limit (default: 900)
  SCIM_AUTH_FAILURE_DELAY_MS?: string; // Base delay on failure in ms (default: 200)
  ENABLE_SCIM_AUTH_RATE_LIMIT?: string; // "false" to disable rate limiting (default: enabled)

  // Test Endpoints
  ENABLE_TEST_ENDPOINTS?: string; // "true" to enable /api/admin/test/* endpoints (default: disabled for security)

  // Advanced OAuth Features
  ENABLE_HTTPS_REQUEST_URI?: string; // "true" to enable external HTTPS request_uri (SSRF risk, disabled by default)
  HTTPS_REQUEST_URI_ALLOWED_DOMAINS?: string; // Comma-separated list of allowed domains
  HTTPS_REQUEST_URI_TIMEOUT_MS?: string; // Fetch timeout in milliseconds (default: 5000)
  HTTPS_REQUEST_URI_MAX_SIZE_BYTES?: string; // Maximum response body size in bytes (default: 102400 = 100KB)

  ENABLE_TOKEN_EXCHANGE?: string; // "true" to enable RFC 8693 Token Exchange
  TOKEN_EXCHANGE_ALLOWED_TYPES?: string; // Comma-separated: access_token, jwt, id_token (default: access_token)
  TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS?: string; // Max resource parameters (default: 10)
  TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS?: string; // Max audience parameters (default: 10)

  ENABLE_CLIENT_CREDENTIALS?: string; // "true" to enable RFC 6749 Section 4.4 Client Credentials Grant
  ENABLE_RAR?: string; // "true" to enable RFC 9396 Rich Authorization Requests

  // AI Ephemeral Auth Features
  ENABLE_AI_SCOPES?: string; // "true" to enable ai:* scope namespace (ai:read, ai:write, ai:execute, ai:admin)
  ENABLE_AI_EPHEMERAL_AUTH?: string; // "true" to enable AI Ephemeral Auth tenant profile

  // SD-JWT and Custom Claims
  ENABLE_SD_JWT?: string; // "true" to enable RFC 9901 SD-JWT ID tokens
  ENABLE_POLICY_EMBEDDING?: string; // "true" to enable policy evaluation and permission embedding
  ENABLE_CUSTOM_CLAIMS?: string; // "true" to enable custom claim rules
  ENABLE_ID_LEVEL_PERMISSIONS?: string; // "true" to enable ID-level resource permissions

  // External IdP Integration
  ENABLE_IDENTITY_STITCHING?: string; // "true" to enable automatic identity stitching
  ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL?: string; // "false" to allow unverified emails (not recommended)
  RP_TOKEN_ENCRYPTION_KEY?: string; // Encryption key for external IdP tokens (32-byte hex string)

  // PII Encryption
  ENABLE_PII_ENCRYPTION?: string; // "true" to enable PII field encryption
  PII_ENCRYPTION_KEY?: string; // 32-byte hex string (64 characters) for AES-256
  PII_ENCRYPTION_ALGORITHM?: string; // AES-256-GCM (default), AES-256-CBC, or NONE
  PII_ENCRYPTION_FIELDS?: string; // Comma-separated list of fields to encrypt
  PII_ENCRYPTION_KEY_VERSION?: string; // Key version for rotation (default: 1)

  // Token Introspection
  ENABLE_INTROSPECTION_STRICT_VALIDATION?: string; // "true" to enable strict audience/client_id validation
  INTROSPECTION_EXPECTED_AUDIENCE?: string; // Expected audience value (null = use ISSUER_URL)
  ENABLE_INTROSPECTION_CACHE?: string; // "true" or "false" (default: "true")
  INTROSPECTION_CACHE_TTL?: string; // Cache TTL in seconds (default: 60)

  // Multi-tenant Configuration
  BASE_DOMAIN?: string; // Base domain for subdomain tenant isolation (e.g., authrim.com)
  DEFAULT_TENANT_ID?: string; // Default tenant ID for single-tenant mode (default: "default")
  ENABLE_TENANT_ISOLATION?: string; // "true" to enable tenant isolation

  // Check API (Phase 8.3)
  ENABLE_CHECK_API?: string; // "true" to enable Check API endpoints
  ENABLE_CHECK_API_DEBUG?: string; // "true" to include debug info in responses
  ENABLE_CHECK_API_WEBSOCKET?: string; // "true" to enable WebSocket Push
  ENABLE_CHECK_API_AUDIT?: string; // "true" to enable audit logging (default: enabled)

  // Mock/Anonymous Authentication
  ENABLE_MOCK_AUTH?: string; // "true" to enable mock authentication (NEVER in production!)
  ENABLE_ANONYMOUS_AUTH?: string; // "true" to enable device-based anonymous login

  // ID-JAG (draft-ietf-oauth-identity-assertion-authz-grant)
  ENABLE_ID_JAG?: string; // "true" to enable ID-JAG token type in Token Exchange
  ID_JAG_ALLOWED_ISSUERS?: string; // Comma-separated list of trusted IdP issuers
  ID_JAG_MAX_TOKEN_LIFETIME?: string; // Maximum token lifetime in seconds (default: 3600)

  // NIST SP 800-63-4 Assurance Levels
  ENABLE_NIST_ASSURANCE_LEVELS?: string; // "true" to enable explicit AAL/FAL/IAL tracking
  DEFAULT_AAL?: string; // Default Authentication Assurance Level (AAL1-3)
  DEFAULT_FAL?: string; // Default Federation Assurance Level (FAL1-3)
  DEFAULT_IAL?: string; // Default Identity Assurance Level (IAL1-3)

  // ============================================================
  // Sharding Configuration (AUTHRIM_* prefix)
  // ============================================================
  AUTHRIM_CODE_SHARDS?: string; // Number of auth code DO shards (default: 4)
  AUTHRIM_SESSION_SHARDS?: string; // Number of session DO shards (default: 4)
  AUTHRIM_CHALLENGE_SHARDS?: string; // Number of challenge DO shards (default: 4)
  AUTHRIM_REVOCATION_SHARDS?: string; // Number of token revocation DO shards (default: 4)
  AUTHRIM_FLOW_STATE_SHARDS?: string; // Number of flow state DO shards (default: 32)

  // Region-aware sharding settings (Priority: KV -> env -> defaults)
  REGION_SHARD_TOTAL_SHARDS?: string; // Total number of shards (default: 20)
  REGION_SHARD_GENERATION?: string; // Current generation for migration (default: 1)
  REGION_SHARD_APAC_PERCENT?: string; // Asia-Pacific region percentage (default: 20)
  REGION_SHARD_ENAM_PERCENT?: string; // North America East percentage (default: 40)
  REGION_SHARD_WEUR_PERCENT?: string; // Western Europe percentage (default: 40)
  REGION_SHARD_GROUPS_JSON?: string; // Colocation groups as JSON (optional)

  // ============================================================
  // Cache TTL Configuration (unit: seconds)
  // ============================================================
  MAX_CODES_PER_USER?: string; // Max authorization codes per user (default: 100)
  USER_CACHE_TTL?: string; // User cache TTL in seconds (default: 3600 = 1 hour)
  CONSENT_CACHE_TTL?: string; // Consent cache TTL in seconds (default: 86400 = 24 hours)
  CONFIG_CACHE_TTL?: string; // Config in-memory cache TTL in seconds (default: 180 = 3 minutes)
  SETTINGS_CACHE_TTL?: string; // Settings/config in-memory cache TTL in seconds (default: 300 = 5 minutes)

  // ============================================================
  // RBAC Configuration
  // ============================================================
  RBAC_ID_TOKEN_CLAIMS?: string; // Default: "roles,user_type,org_id,plan,org_type", "none" to skip
  RBAC_ACCESS_TOKEN_CLAIMS?: string; // Default: "roles,org_id,org_type", "none" to skip
  RBAC_CACHE_TTL?: string; // Cache TTL in seconds (default: 600)
  RBAC_CACHE_VERSION?: string; // Cache version for invalidation (default: 1)

  // RBAC Consent Screen Configuration
  ENABLE_RBAC_CONSENT_ORG_SELECTOR?: string; // "true" to show organization selector for multi-org users
  ENABLE_RBAC_CONSENT_ACTING_AS?: string; // "true" to enable acting-as (delegation) feature
  ENABLE_RBAC_CONSENT_SHOW_ROLES?: string; // "true" to display user's roles on consent screen

  // Token Bloat Protection (Phase 8.2)
  MAX_EMBEDDED_PERMISSIONS?: string; // Max type-level permissions (default: 50)
  MAX_RESOURCE_PERMISSIONS?: string; // Max ID-level permissions (default: 100)
  MAX_CUSTOM_CLAIMS?: string; // Max custom claims (default: 20)

  // ============================================================
  // Secrets (cryptographic keys)
  // ============================================================
  PRIVATE_KEY_PEM?: string;
  PUBLIC_JWK_JSON?: string; // Public JWK as JSON string
  KEY_ID?: string;
  PAIRWISE_SALT?: string; // Pairwise subject identifier salt (OIDC Core 8.1)
  OTP_HMAC_SECRET?: string; // Email OTP HMAC secret for code hashing
  DEVICE_HMAC_SECRET?: string; // Device ID HMAC secret for anonymous authentication
  KEY_MANAGER_SECRET?: string; // Admin secret for Durable Objects management
  ADMIN_API_SECRET?: string; // Admin API authentication secret (Bearer token)
  EMAIL_DOMAIN_HASH_SECRET?: string; // HMAC secret for email domain blind index

  // ============================================================
  // Email Configuration
  // ============================================================
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;

  // ============================================================
  // URL Configuration
  // ============================================================
  DEFAULT_REDIRECT_URL?: string; // Default redirect URL for magic link verification
  UI_URL?: string; // URL of the Login UI deployment (e.g., https://login.example.com)
  ADMIN_UI_URL?: string; // URL of the Admin UI deployment (e.g., https://admin.example.com)
  TRUSTED_JWT_ISSUERS?: string; // Comma-separated list of trusted issuers for JWT Bearer flow
  TRUSTED_DOMAINS?: string; // Comma-separated trusted client domains

  // ============================================================
  // Cookie Security Configuration
  // ============================================================
  // SameSite attribute for cookies. Auto-detected if not set:
  // - Same origin (ISSUER_URL == UI_URL) -> 'Lax' (more secure)
  // - Cross origin -> 'None' (required for cross-origin)
  COOKIE_SAME_SITE?: string; // 'Strict', 'Lax', or 'None' (general override)
  ADMIN_COOKIE_SAME_SITE?: string; // Override for admin session cookies
  BROWSER_STATE_COOKIE_SAME_SITE?: string; // Override for OIDC browser state cookies

  // ============================================================
  // Logging Configuration
  // ============================================================
  LOG_LEVEL?: string; // "debug", "info", "warn", "error" (default: "info")
  LOG_FORMAT?: string; // "json" (structured), "pretty" (human-readable) (default: "json")
  ENABLE_LOG_HASH_USER_ID?: string; // "true" to hash user IDs in logs for privacy

  // ============================================================
  // Environment Detection & Version Management
  // ============================================================
  ENVIRONMENT?: string; // "production", "staging", "development"
  NODE_ENV?: string; // "production", "development" (fallback for ENVIRONMENT)
  CODE_VERSION_UUID?: string; // UUID v4 identifying this deployed bundle (set by deploy script)
  DEPLOY_TIME_UTC?: string; // ISO 8601 timestamp of deployment (set by deploy script)

  // ============================================================
  // OIDC ACR Configuration
  // ============================================================
  SUPPORTED_ACR_VALUES?: string; // Comma-separated list of supported ACR values

  // ============================================================
  // Queue and Archive Bindings
  // ============================================================
  CHECK_CACHE_KV?: KVNamespace; // Cache for permission check results
  AUDIT_QUEUE?: Queue; // Cloudflare Queue for async audit log processing
  AUDIT_ARCHIVE?: R2Bucket; // R2 bucket for audit log archive and DLQ backup
}
