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
  CLIENTS: KVNamespace;
  INITIAL_ACCESS_TOKENS?: KVNamespace; // For Dynamic Client Registration (RFC 7591)

  // KV Namespaces for Phase 5
  CLIENTS_CACHE?: KVNamespace; // Client metadata cache (read-through from D1)
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

  // Environment Variables
  ISSUER_URL: string;
  ALLOWED_ORIGINS?: string; // Comma-separated list of allowed origins (CORS + WebAuthn RP ID)
  TOKEN_EXPIRY: string;
  CODE_EXPIRY: string;
  STATE_EXPIRY: string;
  NONCE_EXPIRY: string;
  REFRESH_TOKEN_EXPIRY: string;
  ALLOW_HTTP_REDIRECT?: string; // Allow http:// redirect URIs for development

  // Dynamic Client Registration settings
  OPEN_REGISTRATION?: string; // "true" to allow registration without Initial Access Token

  // Secrets (cryptographic keys)
  PRIVATE_KEY_PEM?: string;
  PUBLIC_JWK_JSON?: string; // Public JWK as JSON string
  KEY_ID?: string;

  // Pairwise subject identifier salt (OIDC Core 8.1)
  PAIRWISE_SALT?: string;

  // Admin secrets for Durable Objects management
  KEY_MANAGER_SECRET?: string;

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
}
