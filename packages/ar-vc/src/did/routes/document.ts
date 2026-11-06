/**
 * DID Document Route
 *
 * Returns Authrim's DID document.
 */

import type { Context } from 'hono';
import type { Env } from '../../types';
import { getLogger, getTenantIdFromContext } from '@authrim/ar-lib-core';
import { getRequestIssuerIdentifier, getRequestIssuerUrl } from '../../request-identifiers';

interface DIDDocument {
  '@context': string[];
  id: string;
  verificationMethod?: VerificationMethod[];
  authentication?: string[];
  assertionMethod?: string[];
  service?: Service[];
}

interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyJwk?: Record<string, unknown>;
}

interface Service {
  id: string;
  type: string;
  serviceEndpoint: string | string[];
}

/**
 * GET /.well-known/did.json
 *
 * Returns Authrim's DID document (did:web).
 */
export async function didDocumentRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('VC');
  const issuerDid = getRequestIssuerIdentifier(c);
  const baseUrl = getRequestIssuerUrl(c);

  // The VC issuer keys over RPC: the KeyManager's HTTP `/ec/jwks` requires the internal secret.
  let keys: Array<Record<string, unknown> & { kid?: string }>;
  try {
    const doId = c.env.KEY_MANAGER.idFromName(`${getTenantIdFromContext(c)}-v3`);
    const stub = c.env.KEY_MANAGER.get(doId) as unknown as {
      getVcIssuerJwksRpc(): Promise<{ keys: Array<Record<string, unknown> & { kid?: string }> }>;
    };
    ({ keys } = await stub.getVcIssuerJwksRpc());
  } catch (error) {
    // A document without its keys would be cached by resolvers and fail every verification.
    log.error('Failed to get public keys for DID document', {}, error as Error);
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'server_error' }, 500);
  }

  // One method per key, its fragment the key's kid, so a JWT kid names its method.
  const verificationMethod: VerificationMethod[] = keys
    .filter((key): key is typeof key & { kid: string } => typeof key.kid === 'string' && !!key.kid)
    .map((publicKeyJwk) => ({
      id: `${issuerDid}#${encodeURIComponent(publicKeyJwk.kid)}`,
      type: 'JsonWebKey2020',
      controller: issuerDid,
      publicKeyJwk,
    }));
  const methodIds = verificationMethod.length
    ? verificationMethod.map((method) => method.id)
    : undefined;

  const document: DIDDocument = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
    id: issuerDid,

    verificationMethod: verificationMethod.length ? verificationMethod : undefined,

    // Methods for signing VCs
    assertionMethod: methodIds,

    // Methods for authentication
    authentication: methodIds,

    // Service endpoints
    service: [
      {
        id: `${issuerDid}#vc-issuer`,
        type: 'OpenID4VCIssuer',
        serviceEndpoint: `${baseUrl}/.well-known/openid-credential-issuer`,
      },
      {
        id: `${issuerDid}#vc-verifier`,
        type: 'OpenID4VPVerifier',
        serviceEndpoint: `${baseUrl}/.well-known/openid-credential-verifier`,
      },
    ],
  };

  return c.json(document);
}
