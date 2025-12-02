/**
 * Cloudflare Workers Environment Bindings
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
  INITIAL_ACCESS_TOKENS?: KVNamespace; // For Dynamic Client Registration (RFC 7591)

  // KV Namespaces for Phase 5
  JWKS_CACHE?: KVNamespace; // JWKs cache (from KeyManager DO)
  MAGIC_LINKS?: KVNamespace; // Magic Link tokens (TTL: 15 min)
  KV?: KVNamespace; // General purpose KV for session tokens and other data
  SETTINGS?: KVNamespace; // System settings storage

  // Durable Objects
  KEY_MANAGER: DurableObjectNamespace;
  SESSION_STORE: DurableObjectNamespace;
  AUTH_CODE_STORE: DurableObjectNamespace;
  REFRESH_TOKEN_ROTATOR: DurableObjectNamespace;
  CHALLENGE_STORE: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace; // #6: Atomic rate limiting
  USER_CODE_RATE_LIMITER: DurableObjectNamespace; // Device flow user code rate limiting
  PAR_REQUEST_STORE: DurableObjectNamespace; // #11: PAR request_uri single-use
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
  AUTHRIM_CODE_SHARDS?: string; // Number of auth code DO shards (default: 64, set to 0 to disable sharding)

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
}
