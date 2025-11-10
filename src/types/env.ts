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

  // Secrets (to be added later)
  // PRIVATE_KEY_PEM?: string;
  // PUBLIC_KEY_JWK?: string;
  // KEY_ID?: string;
}
