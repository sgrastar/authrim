import type { Context } from 'hono';
import type { Env, Logger } from '@authrim/ar-lib-core';
import { getLogger } from '@authrim/ar-lib-core';

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
  const log = getLogger(c).module('DISCOVERY');

  try {
    // Get KeyManager DO instance
    const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
    const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

    // Fetch JWKS from KeyManager DO via RPC
    const keys = await keyManager.getAllPublicKeysRpc();

    // If KeyManager returns empty keys, fall back to environment variable
    if (!keys || keys.length === 0) {
      log.warn('KeyManager returned empty keys, falling back to environment variable');
      return fallbackToEnvKey(c, log);
    }

    // Add cache headers for better performance
    // Cache for 5 minutes to allow key rotation to propagate quickly
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Vary', 'Accept-Encoding');

    return c.json({ keys });
  } catch (error) {
    log.error('Error fetching JWKS from KeyManager', {}, error as Error);
    // Fallback to environment variable if KeyManager is unavailable
    return fallbackToEnvKey(c, log);
  }
}

/**
 * Fallback to environment variable-based JWKS
 * Used when KeyManager DO is unavailable
 */
function fallbackToEnvKey(c: Context<{ Bindings: Env }>, log: Logger) {
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
    log.error('Error parsing public JWK from env', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to generate JWKS',
      },
      500
    );
  }
}
