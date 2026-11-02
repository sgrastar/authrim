/**
 * JWT VC Issuer Metadata Route
 *
 * Lets verifiers resolve the key that signed an SD-JWT VC from its `iss` URL. Credentials stay
 * valid for days, so the JWKS also carries public keys retained after normal key rotation.
 *
 * @see https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/ (JWT VC Issuer Metadata)
 */

import type { Context } from 'hono';
import { getLogger, getTenantIdFromContext } from '@authrim/ar-lib-core';
import type { JWK } from 'jose';
import type { Env } from '../../types';
import { getRequestIssuerUrl } from '../../request-identifiers';

/**
 * GET /.well-known/jwt-vc-issuer
 */
export async function jwtVcIssuerMetadataRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC');
  const issuer = getRequestIssuerUrl(c);

  let keys: JWK[];
  try {
    const doId = c.env.KEY_MANAGER.idFromName(`${getTenantIdFromContext(c)}-v3`);
    const stub = c.env.KEY_MANAGER.get(doId) as unknown as {
      getVcIssuerJwksRpc(): Promise<{ keys: JWK[] }>;
    };
    ({ keys } = await stub.getVcIssuerJwksRpc());
  } catch (error) {
    log.error('Failed to load VC issuer keys', {}, error as Error);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'server_error' }, 500);
  }

  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ issuer, jwks: { keys } });
}
