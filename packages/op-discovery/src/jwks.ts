import type { Context } from 'hono';
import type { Env } from '@enrai/shared';

/**
 * JSON Web Key Set (JWKS) Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#JWKs
 *
 * Returns the public keys used to verify ID tokens
 *
 * This endpoint now fetches keys dynamically from KeyManager DO,
 * solving issue #13: JWKS Endpoint and KeyManager inconsistency.
 *
 * Benefits:
 * - Key rotation is immediately reflected
 * - Supports multiple active keys during rotation
 * - No environment variable dependency
 */
export async function jwksHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Get KeyManager DO instance
    const keyManagerId = c.env.KEY_MANAGER.idFromName('default');
    const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

    // Fetch JWKS from KeyManager DO (public endpoint, no auth required)
    const response = await keyManager.fetch('http://internal/jwks', {
      method: 'GET',
    });

    if (!response.ok) {
      console.error('Failed to fetch JWKS from KeyManager:', await response.text());
      // Fallback to environment variable if KeyManager fails
      return fallbackToEnvKey(c);
    }

    const data = await response.json<{ keys: unknown[] }>();

    // Add cache headers for better performance
    // Cache for 5 minutes to allow key rotation to propagate quickly
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Vary', 'Accept-Encoding');

    return c.json(data);
  } catch (error) {
    console.error('Error fetching JWKS from KeyManager:', error);
    // Fallback to environment variable if KeyManager is unavailable
    return fallbackToEnvKey(c);
  }
}

/**
 * Fallback to environment variable-based JWKS
 * Used when KeyManager DO is unavailable
 */
function fallbackToEnvKey(c: Context<{ Bindings: Env }>) {
  const publicJWKJson = c.env.PUBLIC_JWK_JSON;

  if (!publicJWKJson) {
    return c.json({
      keys: [],
    });
  }

  try {
    const publicJWK = JSON.parse(publicJWKJson);

    c.header('Cache-Control', 'public, max-age=3600');
    c.header('Vary', 'Accept-Encoding');

    return c.json({
      keys: [publicJWK],
    });
  } catch (error) {
    console.error('Error parsing public JWK from env:', error);
    return c.json(
      {
        error: 'internal_server_error',
        message: 'Failed to generate JWKS',
      },
      500
    );
  }
}
