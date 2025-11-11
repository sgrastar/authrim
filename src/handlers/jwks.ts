import type { Context } from 'hono';
import type { Env } from '../types/env';
import { importPKCS8, exportJWK } from 'jose';

/**
 * JSON Web Key Set (JWKS) Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#JWKs
 *
 * Returns the public keys used to verify ID tokens
 */
export async function jwksHandler(c: Context<{ Bindings: Env }>) {
  const privateKeyPEM = c.env.PRIVATE_KEY_PEM;
  const keyId = c.env.KEY_ID;

  // If no private key is configured, return empty key set
  if (!privateKeyPEM) {
    return c.json({
      keys: [],
    });
  }

  try {
    // Import private key and extract public key
    const privateKey = await importPKCS8(privateKeyPEM, 'RS256');
    const publicJWK = await exportJWK(privateKey);

    // Create JWK with standard parameters
    const jwk = {
      kty: 'RSA',
      use: 'sig',
      alg: 'RS256',
      kid: keyId || 'default',
      n: publicJWK.n,
      e: publicJWK.e,
    };

    // Add cache headers for better performance
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('Vary', 'Accept-Encoding');

    return c.json({
      keys: [jwk],
    });
  } catch (error) {
    console.error('Error exporting public key:', error);
    return c.json(
      {
        error: 'internal_server_error',
        message: 'Failed to generate JWKS',
      },
      500
    );
  }
}
