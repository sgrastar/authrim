import type { Context } from 'hono';
import type { Env, Logger } from '@authrim/ar-lib-core';
import { getLogger, getTenantIdFromContext } from '@authrim/ar-lib-core';

const PUBLIC_JWK_FIELDS = new Set([
  'kty',
  'use',
  'key_ops',
  'alg',
  'kid',
  'x5u',
  'x5c',
  'x5t',
  'x5t#S256',
  'n',
  'e',
  'crv',
  'x',
  'y',
]);

function toPublicJwk(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JWK must be an object');
  }

  const jwk = value as Record<string, unknown>;
  if (typeof jwk.kty !== 'string' || jwk.kty === 'oct') {
    throw new Error('JWKS requires an asymmetric public key');
  }

  const publicJwk = Object.fromEntries(
    Object.entries(jwk).filter(([field]) => PUBLIC_JWK_FIELDS.has(field))
  );
  if (
    (jwk.kty === 'RSA' && (typeof publicJwk.n !== 'string' || typeof publicJwk.e !== 'string')) ||
    ((jwk.kty === 'EC' || jwk.kty === 'OKP') &&
      (typeof publicJwk.crv !== 'string' || typeof publicJwk.x !== 'string'))
  ) {
    throw new Error('JWK is missing required public key parameters');
  }

  return publicJwk;
}

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
    const tenantId = getTenantIdFromContext(c);
    if (!c.env.KEY_MANAGER_PUBLIC) {
      log.warn(
        'KeyManager public service binding unavailable, falling back to environment variable'
      );
      return fallbackToEnvKey(c, log);
    }

    // Fetch JWKS through the public-key-only Worker RPC facade.
    const keys = await c.env.KEY_MANAGER_PUBLIC.getAllPublicKeys(tenantId);

    // If KeyManager returns empty keys, fall back to environment variable
    if (!keys || keys.length === 0) {
      log.warn('KeyManager returned empty keys, falling back to environment variable');
      return fallbackToEnvKey(c, log);
    }

    // Add cache headers for better performance
    // Cache for 5 minutes to allow key rotation to propagate quickly
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Vary', 'Accept-Encoding');

    return c.json({ keys: keys.map(toPublicJwk) });
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
    const publicJWK = toPublicJwk(JSON.parse(publicJWKJson));

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
        message: 'Failed to generate JWKS',
        error_description: 'Failed to generate JWKS',
      },
      500
    );
  }
}
