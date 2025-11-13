import type { Context } from 'hono';
import type { Env } from '@enrai/shared';
import type { JWK } from 'jose';

/**
 * JSON Web Key Set (JWKS) Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#JWKs
 *
 * Returns the public keys used to verify ID tokens
 */
export async function jwksHandler(c: Context<{ Bindings: Env }>) {
  const publicJWKJson = c.env.PUBLIC_JWK_JSON;

  // If no public key is configured, return empty key set
  if (!publicJWKJson) {
    return c.json({
      keys: [],
    });
  }

  try {
    // Parse the public JWK from environment variable
    const publicJWK = JSON.parse(publicJWKJson) as JWK;

    // Add cache headers for better performance
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('Vary', 'Accept-Encoding');

    return c.json({
      keys: [publicJWK],
    });
  } catch (error) {
    console.error('Error parsing public JWK:', error);
    return c.json(
      {
        error: 'internal_server_error',
        message: 'Failed to generate JWKS',
      },
      500
    );
  }
}
