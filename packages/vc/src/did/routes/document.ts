/**
 * DID Document Route
 *
 * Returns Authrim's DID document.
 */

import type { Context } from 'hono';
import type { Env } from '../../types';

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
  const issuerDid = c.env.ISSUER_IDENTIFIER || 'did:web:authrim.com';
  const baseUrl = new URL(c.req.url).origin;

  // Get public key from KeyManager
  let publicKeyJwk: Record<string, unknown> | undefined;

  try {
    const doId = c.env.KEY_MANAGER.idFromName('issuer-keys');
    const stub = c.env.KEY_MANAGER.get(doId);

    const response = await stub.fetch(new Request('https://internal/ec/jwks'));

    if (response.ok) {
      const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
      publicKeyJwk = jwks.keys[0];
    }
  } catch (error) {
    console.error('[didDocument] Failed to get public key:', error);
  }

  const document: DIDDocument = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
    id: issuerDid,

    verificationMethod: publicKeyJwk
      ? [
          {
            id: `${issuerDid}#key-1`,
            type: 'JsonWebKey2020',
            controller: issuerDid,
            publicKeyJwk,
          },
        ]
      : undefined,

    // Methods for signing VCs
    assertionMethod: publicKeyJwk ? [`${issuerDid}#key-1`] : undefined,

    // Methods for authentication
    authentication: publicKeyJwk ? [`${issuerDid}#key-1`] : undefined,

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
