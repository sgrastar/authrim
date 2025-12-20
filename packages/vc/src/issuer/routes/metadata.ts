/**
 * Issuer Metadata Route
 *
 * Returns OpenID4VCI Issuer metadata.
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html
 */

import type { Context } from 'hono';
import type { Env } from '../../types';

/**
 * Issuer Metadata Response
 */
interface IssuerMetadata {
  credential_issuer: string;
  credential_endpoint: string;
  deferred_credential_endpoint?: string;
  credential_configurations_supported: Record<string, CredentialConfiguration>;
  display?: IssuerDisplay[];
}

interface CredentialConfiguration {
  format: string;
  vct?: string;
  cryptographic_binding_methods_supported?: string[];
  credential_signing_alg_values_supported?: string[];
  claims?: Record<string, ClaimDefinition>;
  display?: CredentialDisplay[];
}

interface ClaimDefinition {
  mandatory?: boolean;
  display?: { name: string; locale: string }[];
}

interface CredentialDisplay {
  name: string;
  locale: string;
  logo?: { uri: string };
  background_color?: string;
  text_color?: string;
}

interface IssuerDisplay {
  name: string;
  locale: string;
  logo?: { uri: string };
}

/**
 * GET /.well-known/openid-credential-issuer
 *
 * Returns the Issuer's metadata including supported credential types.
 */
export async function issuerMetadataRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const issuerIdentifier = c.env.ISSUER_IDENTIFIER || 'did:web:authrim.com';
  const baseUrl = new URL(c.req.url).origin;

  const metadata: IssuerMetadata = {
    credential_issuer: issuerIdentifier,
    credential_endpoint: `${baseUrl}/vci/credential`,
    deferred_credential_endpoint: `${baseUrl}/vci/deferred`,

    credential_configurations_supported: {
      // Identity Credential
      AuthrimIdentityCredential: {
        format: 'dc+sd-jwt',
        vct: 'https://authrim.com/credentials/identity/v1',
        cryptographic_binding_methods_supported: ['jwk'],
        credential_signing_alg_values_supported: ['ES256', 'ES384', 'ES512'],
        claims: {
          given_name: {
            display: [{ name: 'Given Name', locale: 'en' }],
          },
          family_name: {
            display: [{ name: 'Family Name', locale: 'en' }],
          },
          email: {
            display: [{ name: 'Email', locale: 'en' }],
          },
          birthdate: {
            display: [{ name: 'Date of Birth', locale: 'en' }],
          },
        },
        display: [
          {
            name: 'Authrim Identity Credential',
            locale: 'en',
            logo: { uri: `${baseUrl}/logo.png` },
            background_color: '#1E3A8A',
            text_color: '#FFFFFF',
          },
        ],
      },

      // Age Verification Credential
      AuthrimAgeVerification: {
        format: 'dc+sd-jwt',
        vct: 'https://authrim.com/credentials/age-verification/v1',
        cryptographic_binding_methods_supported: ['jwk'],
        credential_signing_alg_values_supported: ['ES256', 'ES384', 'ES512'],
        claims: {
          age_over_18: {
            mandatory: true,
            display: [{ name: 'Age Over 18', locale: 'en' }],
          },
          age_over_21: {
            display: [{ name: 'Age Over 21', locale: 'en' }],
          },
        },
        display: [
          {
            name: 'Age Verification',
            locale: 'en',
            background_color: '#047857',
            text_color: '#FFFFFF',
          },
        ],
      },
    },

    display: [
      {
        name: 'Authrim',
        locale: 'en',
        logo: { uri: `${baseUrl}/logo.png` },
      },
    ],
  };

  return c.json(metadata);
}
