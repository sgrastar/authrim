/**
 * Verifier Metadata Route
 *
 * Returns OpenID4VP Verifier metadata.
 * @see https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-verifier-metadata
 */

import type { Context } from 'hono';
import type { Env, VerifierMetadata } from '../../types';

/**
 * GET /.well-known/openid-credential-verifier
 *
 * Returns the Verifier's metadata including supported formats and algorithms.
 */
export async function verifierMetadataRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const verifierIdentifier = c.env.VERIFIER_IDENTIFIER || 'did:web:authrim.com';

  const metadata: VerifierMetadata = {
    verifier_identifier: verifierIdentifier,

    // HAIP-compliant formats
    vp_formats_supported: {
      'dc+sd-jwt': {
        alg_values_supported: ['ES256', 'ES384', 'ES512'],
      },
      mso_mdoc: {
        alg_values_supported: ['ES256', 'ES384', 'ES512'],
      },
    },

    // Supported client ID schemes
    client_id_schemes_supported: ['pre-registered', 'did', 'redirect_uri'],

    // Response types
    response_types_supported: ['vp_token'],

    // HAIP requires direct_post
    response_modes_supported: ['direct_post', 'direct_post.jwt'],

    // DCQL support (HAIP recommended)
    dcql_supported: true,

    // Presentation definition URI schemes
    presentation_definition_uri_schemes_supported: ['https'],
  };

  return c.json(metadata);
}
