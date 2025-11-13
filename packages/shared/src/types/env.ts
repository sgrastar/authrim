/**
 * Cloudflare Workers Environment Bindings
 */
export interface Env {
  // KV Namespaces
  AUTH_CODES: KVNamespace;
  STATE_STORE: KVNamespace;
  NONCE_STORE: KVNamespace;
  CLIENTS: KVNamespace;
  REVOKED_TOKENS: KVNamespace;
  REFRESH_TOKENS: KVNamespace;

  // Environment Variables
  ISSUER_URL: string;
  TOKEN_EXPIRY: string;
  CODE_EXPIRY: string;
  STATE_EXPIRY: string;
  NONCE_EXPIRY: string;
  REFRESH_TOKEN_EXPIRY: string;
  ALLOW_HTTP_REDIRECT?: string; // Allow http:// redirect URIs for development

  // Secrets (cryptographic keys)
  PRIVATE_KEY_PEM?: string;
  PUBLIC_JWK_JSON?: string; // Public JWK as JSON string
  KEY_ID?: string;

  // Pairwise subject identifier salt (OIDC Core 8.1)
  PAIRWISE_SALT?: string;

  // Admin secrets for Durable Objects management
  KEY_MANAGER_SECRET?: string;
}
