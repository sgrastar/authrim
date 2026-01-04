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
  STATE_REQUIRED?: string; // "true" to require state parameter (CSRF protection, default: false for backwards compatibility)
  USERINFO_REQUIRE_OPENID_SCOPE?: string; // "false" to allow UserInfo without openid scope (OAuth 2.0 compatibility, default: true for OIDC compliance)
  AUTH_CODE_TTL?: string; // Authorization code TTL in seconds (default: 60, increase for load testing)
  AUTH_CODE_CLEANUP_INTERVAL?: string; // Auth code cleanup interval in seconds (default: 30, increase for load testing)
  AUTHRIM_CODE_SHARDS?: string; // Number of auth code DO shards (default: 4)
  AUTHRIM_SESSION_SHARDS?: string; // Number of session DO shards (default: 4)
  AUTHRIM_CHALLENGE_SHARDS?: string; // Number of challenge DO shards (default: 4)
  AUTHRIM_REVOCATION_SHARDS?: string; // Number of token revocation DO shards (default: 4)

  // Region-aware sharding settings (Priority: KV → env → defaults)
  REGION_SHARD_TOTAL_SHARDS?: string; // Total number of shards (default: 20)
  REGION_SHARD_GENERATION?: string; // Current generation for migration (default: 1)
  REGION_SHARD_APAC_PERCENT?: string; // Asia-Pacific region percentage (default: 20)
  REGION_SHARD_ENAM_PERCENT?: string; // North America East percentage (default: 40)
  REGION_SHARD_WEUR_PERCENT?: string; // Western Europe percentage (default: 40)
  REGION_SHARD_GROUPS_JSON?: string; // Colocation groups as JSON (optional, uses defaults if not set)

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

  // Device ID HMAC secret for anonymous authentication (architecture-decisions.md §17)
  // Used to hash device identifiers for privacy
  DEVICE_HMAC_SECRET?: string;

  // Admin secrets for Durable Objects management
  KEY_MANAGER_SECRET?: string;
  ADMIN_API_SECRET?: string; // Admin API authentication secret (Bearer token)

  // Email configuration (Phase 5)
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;

  // Redirect configuration
  DEFAULT_REDIRECT_URL?: string; // Default redirect URL for magic link verification
  UI_URL?: string; // URL of the UI deployment (e.g., https://login.example.com)

  // Conformance Mode (for OIDC certification testing)
  CONFORMANCE_MODE?: string; // "true" to enable built-in forms instead of external UI

  // Multi-tenant configuration
  BASE_DOMAIN?: string; // Base domain for subdomain tenant isolation (e.g., authrim.com)
  DEFAULT_TENANT_ID?: string; // Default tenant ID for single-tenant mode (default: "default")
  TENANT_ISOLATION_ENABLED?: string; // "true" to enable tenant isolation

  // JWT Bearer Flow (RFC 7523) - Phase 6
  TRUSTED_JWT_ISSUERS?: string; // Comma-separated list of trusted issuers for JWT Bearer flow

  // Trusted Client domains (comma-separated)
  // Clients with redirect_uri domains in this list are automatically trusted
  TRUSTED_DOMAINS?: string;

  // Version Management (set by deploy script via --var)
  CODE_VERSION_UUID?: string; // UUID v4 identifying this deployed bundle
  DEPLOY_TIME_UTC?: string; // ISO 8601 timestamp of deployment
  VERSION_CHECK_ENABLED?: string; // "false" to disable version check middleware (default: enabled)

  // API Versioning (Stripe-style date-based versioning)
  API_VERSIONING_ENABLED?: string; // "false" to disable API versioning middleware (default: enabled)
  API_DEFAULT_VERSION?: string; // Default API version when not specified (YYYY-MM-DD format, default: "2024-12-01")
  API_CURRENT_STABLE_VERSION?: string; // Current stable version (YYYY-MM-DD format, default: "2024-12-01")
  API_SUPPORTED_VERSIONS?: string; // Comma-separated list of supported versions (YYYY-MM-DD format)
  API_UNKNOWN_VERSION_MODE?: string; // "fallback" | "warn" | "reject" - how to handle unknown versions (default: "fallback")

  // Deprecation Headers (RFC 8594 Sunset Header)
  DEPRECATION_HEADERS_ENABLED?: string; // "false" to disable deprecation headers (default: enabled)

  // SDK Compatibility Check (preparation for future SDK)
  SDK_COMPATIBILITY_CHECK_ENABLED?: string; // "false" to disable SDK compatibility checking (default: disabled until SDKs are developed)

  // Rate Limiting Override (for load testing)
  // Set to "loadTest" to use 10000 req/min instead of default limits
  RATE_LIMIT_PROFILE?: string;
  // Set to "true" to completely disable rate limiting (benchmark mode)
  RATE_LIMIT_DISABLED?: string;

  // SCIM Authentication Rate Limiting (RFC 7644)
  // Configurable rate limits for SCIM Bearer token authentication
  SCIM_AUTH_MAX_FAILED_ATTEMPTS?: string; // Max failures before lockout (default: 5)
  SCIM_AUTH_WINDOW_SECONDS?: string; // Time window for counting failures (default: 300)
  SCIM_AUTH_LOCKOUT_SECONDS?: string; // Lockout duration after exceeding limit (default: 900)
  SCIM_AUTH_FAILURE_DELAY_MS?: string; // Base delay on failure in ms (default: 200)
  SCIM_AUTH_RATE_LIMIT_DISABLED?: string; // "true" to disable rate limiting (for testing only)

  // Test Endpoints Control (for load testing / conformance testing)
  // Set to "true" to enable /api/admin/test/* endpoints
  // Default: disabled (returns 404) for security in production
  ENABLE_TEST_ENDPOINTS?: string;

  // RBAC Claims Configuration (Phase 2)
  // Comma-separated list of claims to include in tokens
  // ID Token: roles,scoped_roles,user_type,org_id,org_name,plan,org_type,orgs,relationships_summary
  // Access Token: roles,scoped_roles,org_id,org_type,permissions,org_context
  RBAC_ID_TOKEN_CLAIMS?: string; // Default: "roles,user_type,org_id,plan,org_type", "none" to skip
  RBAC_ACCESS_TOKEN_CLAIMS?: string; // Default: "roles,org_id,org_type", "none" to skip
  RBAC_CACHE_TTL?: string; // Cache TTL in seconds (KV overrides this, default: 600)
  RBAC_CACHE_VERSION?: string; // Cache version for invalidation (KV overrides this, default: 1)

  // User & Consent Cache TTL (KV overrides these)
  USER_CACHE_TTL?: string; // User cache TTL in seconds (default: 3600 = 1 hour)
  CONSENT_CACHE_TTL?: string; // Consent cache TTL in seconds (default: 86400 = 24 hours)
  CONFIG_CACHE_TTL?: string; // Config in-memory cache TTL in seconds (default: 180 = 3 minutes)
  SETTINGS_CACHE_TTL_SECONDS?: string; // Settings/config in-memory cache TTL (default: 300 = 5 minutes)

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

  // RFC 8693: Token Exchange Feature Flag
  // When "true", enables urn:ietf:params:oauth:grant-type:token-exchange grant type
  // Default: disabled (to avoid OIDC certification test interference)
  ENABLE_TOKEN_EXCHANGE?: string;

  // RFC 8693: Allowed subject token types (comma-separated)
  // Options: access_token, jwt, id_token
  // Default: access_token
  // Note: refresh_token is never allowed for security reasons
  TOKEN_EXCHANGE_ALLOWED_TYPES?: string;

  // RFC 8693: Maximum resource parameters (DoS prevention)
  // Valid range: 1-100
  // Default: 10
  TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS?: string;

  // RFC 8693: Maximum audience parameters (DoS prevention)
  // Valid range: 1-100
  // Default: 10
  TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS?: string;

  // RFC 6749 Section 4.4: Client Credentials Grant Feature Flag
  // When "true", enables client_credentials grant type for M2M communication
  // Default: disabled (to avoid OIDC certification test interference)
  ENABLE_CLIENT_CREDENTIALS?: string;

  // RFC 9396: Rich Authorization Requests (RAR) Feature Flag
  // When "true", enables authorization_details parameter for fine-grained authorization
  // Default: disabled (to avoid OIDC certification test interference)
  ENABLE_RAR?: string;

  // AI Ephemeral Auth: AI Capability Scopes Feature Flag
  // When "true", enables ai:* scope namespace (ai:read, ai:write, ai:execute, ai:admin)
  // Default: disabled (to avoid OIDC certification test interference)
  ENABLE_AI_SCOPES?: string;

  // AI Ephemeral Auth: Full Feature Flag
  // When "true", enables AI Ephemeral Auth tenant profile ('ai_ephemeral')
  // Default: disabled (requires explicit enablement)
  ENABLE_AI_EPHEMERAL_AUTH?: string;

  // External IdP Configuration (Phase 7)
  // Identity stitching: automatically link external identities to existing users by verified email
  IDENTITY_STITCHING_ENABLED?: string; // "true" to enable automatic identity stitching
  IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL?: string; // "false" to allow unverified emails (not recommended)
  // Encryption key for storing external IdP tokens (32-byte hex string)
  RP_TOKEN_ENCRYPTION_KEY?: string;

  // PII Encryption Configuration
  // 32-byte hex string (64 characters) for AES-256 encryption key
  // Generate with: head -c 32 /dev/urandom | xxd -p -c 64
  PII_ENCRYPTION_KEY?: string;
  // Enable/disable PII field encryption (default: false)
  PII_ENCRYPTION_ENABLED?: string;
  // Encryption algorithm: AES-256-GCM (default), AES-256-CBC, or NONE
  PII_ENCRYPTION_ALGORITHM?: string;
  // Comma-separated list of fields to encrypt (default: email,phone_number,name,given_name,family_name)
  PII_ENCRYPTION_FIELDS?: string;
  // Key version for rotation (default: 1)
  PII_ENCRYPTION_KEY_VERSION?: string;

  // Policy ↔ Identity Integration (Phase 8.1)
  // HMAC secret for email domain blind index (minimum 16 characters)
  // Used to generate email_domain_hash for policy rule evaluation
  EMAIL_DOMAIN_HASH_SECRET?: string;

  // Token Embedding Model (Phase 8.2)
  // Custom claim rules and ID-level resource permissions
  // Default: all disabled (to avoid OIDC certification test interference)
  ENABLE_CUSTOM_CLAIMS?: string; // "true" to enable custom claim rules
  ENABLE_ID_LEVEL_PERMISSIONS?: string; // "true" to enable ID-level resource permissions

  // Token Bloat Protection (Phase 8.2)
  // Maximum items to embed in tokens (KV overrides these)
  MAX_EMBEDDED_PERMISSIONS?: string; // Max type-level permissions (default: 50)
  MAX_RESOURCE_PERMISSIONS?: string; // Max ID-level permissions (default: 100)
  MAX_CUSTOM_CLAIMS?: string; // Max custom claims (default: 20)

  // Token Introspection Strict Validation (RFC 7662 + enhanced security)
  // When "true", enables additional audience and client_id validation
  // Default: disabled (RFC 7662 standard behavior)
  INTROSPECTION_STRICT_VALIDATION?: string; // "true" to enable strict validation
  INTROSPECTION_EXPECTED_AUDIENCE?: string; // Expected audience value (null = use ISSUER_URL)

  // Token Introspection Response Cache
  // Caches active=true responses to reduce KeyManager DO and D1 load
  // Default: enabled with 60 second TTL
  INTROSPECTION_CACHE_ENABLED?: string; // "true" or "false" (default: "true")
  INTROSPECTION_CACHE_TTL_SECONDS?: string; // Cache TTL in seconds (default: "60")

  // Environment Detection
  // Used for security-sensitive feature flags (e.g., blocking alg=none in production)
  ENVIRONMENT?: string; // "production", "staging", "development"
  NODE_ENV?: string; // "production", "development" (fallback for ENVIRONMENT)

  // Logging Configuration
  // Minimum log level to output (default: "info")
  // Options: "debug", "info", "warn", "error"
  LOG_LEVEL?: string;
  // Log output format (default: "json")
  // Options: "json" (structured), "pretty" (human-readable with colors)
  LOG_FORMAT?: string;
  // If "true", hash user IDs in logs for privacy (default: false)
  LOG_HASH_USER_ID?: string;

  // OIDC ACR (Authentication Context Class Reference) Configuration
  // Comma-separated list of supported ACR values for authentication level negotiation
  // Default: SAML 2.0 standard ACR values + "0" (no context)
  SUPPORTED_ACR_VALUES?: string;

  // Check API (Phase 8.3: Real-time Check API Model)
  // Feature flags for unified permission checking
  ENABLE_CHECK_API?: string; // "true" to enable Check API endpoints (default: disabled)
  CHECK_API_DEBUG_MODE?: string; // "true" to include debug info in responses (default: disabled)
  CHECK_API_WEBSOCKET_ENABLED?: string; // "true" to enable WebSocket Push (default: disabled)
  CHECK_API_AUDIT_ENABLED?: string; // "true" to enable audit logging (default: enabled)

  // Mock Authentication Feature Flag (Development/Testing Only)
  // SECURITY WARNING: Never enable this in production!
  // When "true", allows device/CIBA flows to use mock users without real authentication
  // Default: disabled (secure by default)
  ENABLE_MOCK_AUTH?: string;

  // Anonymous Authentication Feature Flag (architecture-decisions.md §17)
  // When "true", enables device-based anonymous login and upgrade flows
  // Default: disabled (requires explicit enablement per tenant/client)
  ENABLE_ANONYMOUS_AUTH?: string;

  // Check API KV Cache
  CHECK_CACHE_KV?: KVNamespace; // Cache for permission check results

  // Audit Logging (Queue and Archive)
  AUDIT_QUEUE?: Queue; // Cloudflare Queue for async audit log processing
  AUDIT_ARCHIVE?: R2Bucket; // R2 bucket for audit log archive and DLQ backup

  // ID-JAG (Identity Assertion Authorization Grant) Feature Flag
  // draft-ietf-oauth-identity-assertion-authz-grant
  // When "true", enables ID-JAG token type in Token Exchange
  ID_JAG_ENABLED?: string;
  // Comma-separated list of trusted IdP issuers for ID-JAG subject tokens
  ID_JAG_ALLOWED_ISSUERS?: string;
  // Maximum token lifetime for ID-JAG tokens in seconds (default: 3600)
  ID_JAG_MAX_TOKEN_LIFETIME?: string;

  // NIST SP 800-63-4 Assurance Levels Feature Flag
  // When "true", enables explicit AAL/FAL/IAL tracking and enforcement
  NIST_ASSURANCE_LEVELS_ENABLED?: string;
  // Default assurance levels (AAL1-3, FAL1-3, IAL1-3)
  DEFAULT_AAL?: string;
  DEFAULT_FAL?: string;
  DEFAULT_IAL?: string;
}
