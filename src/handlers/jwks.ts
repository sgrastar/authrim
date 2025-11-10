import type { Context } from 'hono';
import type { Env } from '../types/env';

/**
 * JSON Web Key Set (JWKS) Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#JWKs
 *
 * Returns the public keys used to verify ID tokens
 */
export async function jwksHandler(c: Context<{ Bindings: Env }>) {
  // TODO: Week 3/4 - Load public key from Durable Objects or environment
  // For now, return empty key set
  // In production, this should return the actual public keys

  return c.json({
    keys: [],
  });
}
