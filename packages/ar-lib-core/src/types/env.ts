// Import DO classes for type-safe RPC bindings
import type { KeyManager } from '../durable-objects/KeyManager';
import type { VersionManager } from '../durable-objects/VersionManager';
import type { SessionStore } from '../durable-objects/SessionStore';
import type { SessionClientStore } from '../durable-objects/SessionClientStore';
import type { AuthorizationCodeStore } from '../durable-objects/AuthorizationCodeStore';
import type { RefreshTokenRotator } from '../durable-objects/RefreshTokenRotator';
import type { RateLimiterCounter } from '../durable-objects/RateLimiterCounter';
import type { PARRequestStore } from '../durable-objects/PARRequestStore';
import type { ChallengeStore } from '../durable-objects/ChallengeStore';
import type { SAMLAggregateMetadataStore } from '../durable-objects/SAMLAggregateMetadataStore';
import type { JWK } from 'jose';

export interface KeyManagerPublicServiceBinding {
  getAllPublicKeys(tenantId: string): Promise<JWK[]>;
}

export interface EmailServiceBinding {
  send(message: {
    to: string | string[];
    from: string | { email: string; name: string };
    subject: string;
    html?: string;
    text?: string;
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | { email: string; name: string };
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
}

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
  DB: D1Database; // Core DB (non-PII data: canonical identity graph, sessions, passkeys, clients, roles)
  DB_PII: D1Database; // PII DB (personal information: canonical sensitive values, linked identities, subject identifiers)
  DB_ADMIN: D1Database; // Admin DB (admin_users, admin_roles, admin_sessions, admin_audit_log, admin_ip_allowlist)
  LOGGING_INDEX_DB?: D1Database; // Optional tenant-local hot chunk index DB binding

  // R2 Buckets
  AVATARS: R2Bucket;
  PUBLIC_ASSETS?: R2Bucket; // Public Login UI assets such as logos, backgrounds, and favicons
  DIAGNOSTIC_LOGS?: R2Bucket; // Diagnostic logs for debugging and OIDF conformance testing
  AUDIT_ARCHIVE?: R2Bucket; // Canonical R2 archive for audit/admin audit/runtime log chunks and DLQ backup
  IMPORT_ARTIFACTS?: R2Bucket; // Dedicated import input artifacts
  EXPORT_ARTIFACTS?: R2Bucket; // Generated export/output artifacts
  SENSITIVE_DETAILS?: R2Bucket; // Encrypted sensitive detail payloads (admin audit, webhook payloads, etc.)

  // KV Namespaces
  STATE_STORE: KVNamespace;
  NONCE_STORE: KVNamespace;
  CLIENTS_CACHE: KVNamespace; // Client metadata cache (Read-Through from D1, 1 hour TTL)
  USER_CACHE?: KVNamespace; // User metadata cache (Read-Through from D1, 1 hour TTL, with invalidation hook)
  CONSENT_CACHE?: KVNamespace; // Consent status cache (Read-Through from D1, 24 hour TTL)
  INITIAL_ACCESS_TOKENS?: KVNamespace; // For Dynamic Client Registration (RFC 7591)
  AUTHRIM_CONFIG?: KVNamespace; // Dynamic configuration (shard count, feature flags, etc.)
  TENANT_RUNTIME_REGISTRY?: KVNamespace; // Tenant DB runtime snapshots and lightweight generation keys

  // KV Namespaces for Phase 5
  JWKS_CACHE?: KVNamespace; // JWKs cache (from KeyManager DO)
  MAGIC_LINKS?: KVNamespace; // Magic Link tokens (TTL: 15 min)
  KV?: KVNamespace; // General purpose KV for session tokens and other data
  SETTINGS?: KVNamespace; // System settings storage
  REBAC_CACHE?: KVNamespace; // RBAC claims cache (Read-Through from D1, 5 min TTL)

  // Durable Objects with RPC type support
  KEY_MANAGER: DurableObjectNamespace<KeyManager>;
  SESSION_STORE: DurableObjectNamespace<SessionStore>;
  SESSION_CLIENT_STORE?: DurableObjectNamespace<SessionClientStore>;
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
  VERSION_MANAGER: DurableObjectNamespace<VersionManager>; // Worker bundle version management
  SAML_REQUEST_STORE: DurableObjectNamespace; // SAML 2.0 request/artifact store
  SAML_AGGREGATE_METADATA_STORE?: DurableObjectNamespace<SAMLAggregateMetadataStore>; // SAML aggregate metadata previews and batch imports
  PERMISSION_CHANGE_HUB?: DurableObjectNamespace; // Phase 8.3: Real-time permission change notifications
  FLOW_STATE_STORE?: DurableObjectNamespace; // Track C: Flow Engine state management
  DIRECTORY_CONNECTOR_RELAY?: DurableObjectNamespace; // Wordwarden outbound connector relay

  // Service Bindings (Worker-to-Worker communication)
  KEY_MANAGER_PUBLIC?: KeyManagerPublicServiceBinding; // Public-key-only KeyManager RPC facade
  EXTERNAL_IDP?: Fetcher; // External IdP worker (ar-bridge) for social login and enterprise IdP
  EMAIL?: EmailServiceBinding; // Cloudflare Email Service send_email binding

  // ============================================================
  // Environment Variables - Token/Auth Expiry (unit: seconds)
  // ============================================================
  ISSUER_URL: string;
  SAML_ENTITY_ID_STYLE?: string; // metadata_url (default) or role_url for generated local SAML entityID values
  SAML_INTERACTIVE_LOGIN_URL_POLICY?: string; // tenant_host (default) or ui_base_url for SAML interactive login redirects
  SAML_METADATA_SIGNING?: string; // "enabled"/"true"/"1" to sign generated IdP/SP metadata XML
  SAML_AGGREGATE_METADATA_SIGNATURE_POLICY?: string; // strict, warn, or disabled (default: strict in production, warn otherwise)
  ALLOWED_ORIGINS?: string; // Comma-separated list of allowed origins (CORS + WebAuthn RP ID)
  ACCESS_TOKEN_EXPIRY: string; // Access token lifetime in seconds (default: 3600)
  AUTH_CODE_EXPIRY: string; // Authorization code lifetime in seconds (default: 60, OAuth 2.0 BCP)
  HANDOFF_ARTIFACT_TTL_SECONDS?: string; // Handoff artifact lifetime in seconds (default: 60, clamped 30-300)
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
  ALLOW_LOCALHOST?: string; // "true" or "1" to allow localhost origins in handoff verify (development only)
  ENABLE_STATE_REQUIRED?: string; // "true" to require state parameter (CSRF protection)
  ENABLE_USERINFO_REQUIRE_OPENID_SCOPE?: string; // "false" to allow UserInfo without openid scope (OAuth 2.0 compatibility)
  ENABLE_OPEN_REGISTRATION?: string; // "true" to allow registration without Initial Access Token
  ENABLE_CONFORMANCE_MODE?: string; // "true" to enable built-in forms instead of external UI
  OAUTH_SSO_ENABLED?: string; // "true" to enable SSO (session sharing) at tenant level (default: "false")
  CLIENT_SSO_ENABLED?: string; // "true" to enable SSO (session sharing) at client level (default: "false")
  ENABLE_IFRAME_OIDC_AUTH?: string; // "true" to allow iframe-based OIDC auth after tenant/client origin opt-in

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
  ENABLE_LOGIN_RUNTIME_FLOW?: string; // "true" to enable new LoginUI runtime Flow interactions
  FLOW_RUNTIME_HMAC_SECRET?: string; // HMAC secret for Flow runtime contract signatures

  // AI Ephemeral Auth Features
  ENABLE_AI_SCOPES?: string; // "true" to enable ai:* scope namespace (ai:read, ai:write, ai:execute, ai:admin)
  ENABLE_AI_EPHEMERAL_AUTH?: string; // "true" to enable AI Ephemeral Auth tenant profile

  // SD-JWT and Custom Claims
  ENABLE_SD_JWT?: string; // "true" to enable RFC 9901 SD-JWT ID tokens
  ENABLE_POLICY_EMBEDDING?: string; // "true" to enable policy evaluation and permission embedding
  ENABLE_CUSTOM_CLAIMS?: string; // "true" to enable custom claim rules
  ENABLE_ID_LEVEL_PERMISSIONS?: string; // "true" to enable ID-level resource permissions
  USER_ID_FORMAT?: string; // "nanoid" or "uuid" for generated end-user IDs

  // External IdP Integration
  ENABLE_IDENTITY_STITCHING?: string; // "true" to enable automatic identity stitching
  ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL?: string; // "false" to allow unverified emails (not recommended)
  RP_TOKEN_ENCRYPTION_KEY?: string; // Encryption key for external IdP tokens (32-byte hex string)
  ADMIN_CREDENTIAL_ENCRYPTION_KEY?: string; // Encryption key for Admin-managed external credentials

  // PII Encryption
  ENABLE_PII_ENCRYPTION?: string; // "true" to enable PII field encryption
  PII_ENCRYPTION_KEY?: string; // 32-byte hex string (64 characters) for AES-256
  PII_ENCRYPTION_ALGORITHM?: string; // AES-256-GCM (default) or NONE
  PII_ENCRYPTION_FIELDS?: string; // Comma-separated list of fields to encrypt
  PII_ENCRYPTION_KEY_VERSION?: string; // Key version for rotation (default: 1)

  // Object Artifact Encryption
  OBJECT_ENCRYPTION_ROOT_KEY?: string; // 32-byte hex string (64 characters) for object plane envelope encryption
  OBJECT_ENCRYPTION_KEY_VERSION?: string; // Key version for object plane encryption (default: 1)
  LOGGING_TENANT_KEY_SALT?: string; // Optional salt while logging tenant_key is derived before registry-backed keys
  PII_CACHE_MODE?: string; // merged, encrypted_short_ttl, or no_cross_request_pii
  PII_CACHE_TTL?: string; // Encrypted PII cache TTL in seconds (default: 300)

  // Downstream Grant Service Integration
  USERINFO_PROTECTED_RESOURCE_AUDIENCE?: string; // Expected audience for protected customer profile reads
  DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID?: string; // Optional client_id for downstream online introspection
  DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET?: string; // Optional client_secret for downstream online introspection

  // Token Introspection
  ENABLE_INTROSPECTION_STRICT_VALIDATION?: string; // "true" to enable strict audience/client_id validation
  INTROSPECTION_EXPECTED_AUDIENCE?: string; // Expected audience value (null = use ISSUER_URL)
  ENABLE_INTROSPECTION_CACHE?: string; // "true" or "false" (default: "true")
  INTROSPECTION_CACHE_TTL?: string; // Cache TTL in seconds (default: 60)

  // Multi-tenant Configuration
  // Multi-tenant mode is always enabled when BASE_DOMAIN is set.
  // Each environment runs as a separate Workers instance with its own BASE_DOMAIN.
  BASE_DOMAIN?: string; // Base domain for multi-tenant mode (e.g., "authrim.com", "example.com")
  DEFAULT_TENANT_ID?: string; // Default tenant ID (default: "default")
  PRIMARY_TENANT_ID?: string; // Tenant ID for naked domain access (e.g., example.com → tenantA)
  NAKED_DOMAIN_AS_ISSUER?: string; // "true" to use naked domain as issuer (e.g., https://example.com instead of https://tenant.example.com)
  AUTHRIM_TRUST_FORWARDED_HOST?: string; // "true" when this Worker is reachable only behind ar-router service bindings

  // Check API (Phase 8.3)
  ENABLE_CHECK_API?: string; // "true" to enable Check API endpoints
  ENABLE_CHECK_API_DEBUG?: string; // "true" to include debug info in responses
  ENABLE_CHECK_API_WEBSOCKET?: string; // "true" to enable WebSocket Push
  ENABLE_CHECK_API_AUDIT?: string; // "true" to enable audit logging (default: enabled)

  // Runtime Profile Registry / Defaults
  PROFILE_REGISTRY_BACKEND?: string; // "kv" | "database"
  DEFAULT_STORAGE_PROFILE_ID?: string; // Environment default storage profile pointer
  DEFAULT_AUDIT_PROFILE_ID?: string; // Environment default audit profile pointer
  DEFAULT_RESIDENCY_PROFILE_ID?: string; // Environment default residency profile pointer

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

  // Region-aware sharding settings (Priority: KV -> env -> defaults)
  REGION_SHARD_TOTAL_SHARDS?: string; // Total number of shards (default: 4)
  REGION_SHARD_GENERATION?: string; // Current generation for migration (default: 1)
  REGION_SHARD_ENAM_PERCENT?: string; // North America East percentage (default: 25)
  REGION_SHARD_WEUR_PERCENT?: string; // Western Europe percentage (default: 25)
  REGION_SHARD_APAC_PERCENT?: string; // Asia-Pacific region percentage (default: 25)
  REGION_SHARD_WNAM_PERCENT?: string; // North America West percentage (default: 25)
  REGION_SHARD_GROUPS_JSON?: string; // Colocation groups as JSON (optional)

  // ============================================================
  // Cache TTL Configuration (unit: seconds)
  // ============================================================
  MAX_CODES_PER_USER?: string; // Max authorization codes per user (default: 100)
  USER_CACHE_TTL?: string; // User cache TTL in seconds (default: 3600 = 1 hour)
  CONSENT_CACHE_TTL?: string; // Consent cache TTL in seconds (default: 86400 = 24 hours)
  CONFIG_CACHE_TTL?: string; // Config in-memory cache TTL in seconds (default: 180 = 3 minutes)
  SETTINGS_CACHE_TTL?: string; // Settings/config in-memory cache TTL in seconds (default: 300 = 5 minutes)

  // Unified Identity Mapping runtime cutover guard
  ENABLE_CANONICAL_IDENTITY_RUNTIME?: string; // "true" to read SCIM user runtime projection from canonical identity tables

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
  KEY_MANAGER_SECRET?: string; // Legacy HTTP compatibility only; new deployments use the DO RPC binding
  LOGGING_CURSOR_HMAC_SECRET?: string; // HMAC secret for opaque logging Admin API cursors
  PLUGIN_ENCRYPTION_KEY?: string; // Dedicated encryption key for plugin configuration secrets
  PLUGIN_ENCRYPTION_SALT?: string; // Optional salt override for plugin configuration secret encryption
  VERSION_MANAGER_SECRET?: string; // Legacy HTTP compatibility only; new deployments use the DO RPC binding
  TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK?: string; // Ed25519 private JWK for control/management snapshot publishing only
  TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID?: string; // Key ID for runtime registry snapshot signatures
  TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWK?: string; // Ed25519 public JWK for runtime snapshot verification
  TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS?: string; // JWKS with current/previous runtime snapshot verification keys
  TENANT_RUNTIME_REGISTRY_PREVIOUS_VERIFYING_PUBLIC_JWK?: string; // Optional previous public JWK during key rotation
  EMAIL_DOMAIN_HASH_SECRET?: string; // HMAC secret for email domain blind index
  CLOUDFLARE_API_TOKEN?: string; // Cloudflare Custom Hostnames automation token
  CLOUDFLARE_D1_API_TOKEN?: string; // Optional Cloudflare D1 read/provisioning token
  CLOUDFLARE_WORKERS_API_TOKEN?: string; // Optional Workers Scripts read/edit token for generated binding deployment
  CLOUDFLARE_ACCOUNT_ID?: string; // Cloudflare account ID for account-scoped APIs
  CF_ACCOUNT_ID?: string; // Legacy/setup-compatible Cloudflare account ID alias
  TENANT_D1_DEPLOYMENT_WORKER_SCRIPTS?: string; // Comma-separated Worker script names eligible for generated tenant D1 binding deployment

  // ============================================================
  // Email Configuration
  // ============================================================
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;

  // ============================================================
  // URL Configuration
  // ============================================================
  DEFAULT_REDIRECT_URL?: string; // Default redirect URL for magic link verification
  UI_URL?: string; // URL of the Login UI deployment (e.g., https://login.example.com)
  ADMIN_UI_URL?: string; // URL of the Admin UI deployment (e.g., https://admin.example.com)
  ADMIN_WEBAUTHN_ALLOWED_ORIGINS?: string; // Optional extra Admin WebAuthn origins
  LOGIN_UI_ENABLED?: string; // "true" when Login UI is deployed/enabled for this environment
  // Where browser Login UI flows execute: 'issuer' keeps the stable tenant issuer origin.
  // When unset, legacy deployments infer issuer hosting from BASE_DOMAIN.
  LOGIN_UI_EXECUTION_HOST_MODE?: 'issuer' | 'dedicated';
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
  AUTHRIM_FLOW_RUNTIME_TIMING?: string; // Temporary: "true" to emit Flow runtime timing diagnostics

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
  LOGGING_DELIVERY_CRITICAL_QUEUE?: Queue; // High-priority logging delivery queue
  LOGGING_DELIVERY_QUEUE?: Queue; // Default logging delivery queue
  LOGGING_DELIVERY_BULK_QUEUE?: Queue; // Bulk logging delivery queue
  LOGGING_DELIVERY_QUEUE_NAMES?: string; // Comma-separated generated queue names for routing
}
