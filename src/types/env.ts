/**
 * Cloudflare Workers Environment Bindings
 */
export interface Env {
  // KV Namespaces
  AUTH_CODES: KVNamespace;
  STATE_STORE: KVNamespace;
  NONCE_STORE: KVNamespace;
  CLIENTS: KVNamespace;

  // Environment Variables
  ISSUER_URL: string;
  TOKEN_EXPIRY: string;
  CODE_EXPIRY: string;
  STATE_EXPIRY: string;
  NONCE_EXPIRY: string;
  ALLOW_HTTP_REDIRECT?: string; // Allow http:// redirect URIs for development

  // Secrets (cryptographic keys)
  PRIVATE_KEY_PEM?: string;
  KEY_ID?: string;

  // Admin secrets for Durable Objects management
  KEY_MANAGER_SECRET?: string;
}
