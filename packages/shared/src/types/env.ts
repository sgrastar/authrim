/**
 * Cloudflare Workers Environment Bindings
 */
export interface Env {
  // D1 Database
  DB: D1Database;

  // R2 Buckets
  AVATARS: R2Bucket;

  // KV Namespaces
  AUTH_CODES: KVNamespace;
  STATE_STORE: KVNamespace;
  NONCE_STORE: KVNamespace;
  CLIENTS: KVNamespace;
  REVOKED_TOKENS: KVNamespace;
  REFRESH_TOKENS: KVNamespace;
  INITIAL_ACCESS_TOKENS?: KVNamespace; // For Dynamic Client Registration (RFC 7591)

  // KV Namespaces for Phase 5
  CLIENTS_CACHE?: KVNamespace; // Client metadata cache (read-through from D1)
  JWKS_CACHE?: KVNamespace; // JWKs cache (from KeyManager DO)
  MAGIC_LINKS?: KVNamespace; // Magic Link tokens (TTL: 15 min)
  KV?: KVNamespace; // General purpose KV for session tokens and other data

  // Rate Limiting
  RATE_LIMIT?: KVNamespace;

  // Durable Objects
  KEY_MANAGER: DurableObjectNamespace;
  SESSION_STORE: DurableObjectNamespace;
  AUTH_CODE_STORE: DurableObjectNamespace;
  REFRESH_TOKEN_ROTATOR: DurableObjectNamespace;
  CHALLENGE_STORE: DurableObjectNamespace;

  // Environment Variables
  ISSUER_URL: string;
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
}
