import { describe, expect, it } from 'vitest';
import { evaluateOpenID4VCMetadata } from './openid4vc-metadata';

const targetOrigin = 'https://oid4vc.example';

function supportedMetadata() {
  return {
    targetOrigin,
    authorizationServer: {
      token_endpoint_auth_methods_supported: ['private_key_jwt', 'attest_jwt_client_auth'],
      dpop_signing_alg_values_supported: ['ES256'],
      request_uri_parameter_supported: true,
    },
    credentialIssuer: {
      credential_issuer: targetOrigin,
      credential_configurations_supported: {
        AuthrimIdentityCredential: {
          format: 'dc+sd-jwt',
          scope: 'AuthrimIdentityCredential',
          proof_types_supported: { jwt: { proof_signing_alg_values_supported: ['ES256'] } },
        },
      },
    },
    verifier: {
      vp_formats_supported: { 'dc+sd-jwt': { alg_values_supported: ['ES256'] } },
      client_id_schemes_supported: ['redirect_uri', 'x509_hash'],
      response_modes_supported: ['direct_post', 'direct_post.jwt'],
      dcql_supported: true,
    },
  };
}

describe('OpenID4VC metadata gap analyzer', () => {
  it('accepts a complete Final and HAIP metadata surface', () => {
    expect(evaluateOpenID4VCMetadata(supportedMetadata()).every((entry) => entry.passed)).toBe(
      true
    );
  });

  it('reports the current HAIP and Final interoperability gaps independently', () => {
    const metadata = supportedMetadata();
    metadata.credentialIssuer.credential_configurations_supported.AuthrimIdentityCredential.scope =
      '';
    metadata.authorizationServer.token_endpoint_auth_methods_supported = ['private_key_jwt'];
    metadata.verifier.client_id_schemes_supported = ['pre-registered'];

    const failures = evaluateOpenID4VCMetadata(metadata).filter((entry) => !entry.passed);
    expect(failures.map((entry) => entry.requirement)).toEqual([
      'Every selected credential configuration has a non-empty scope',
      'OAuth client-attestation authentication is advertised',
      'Final redirect_uri client identifier prefix is advertised',
      'HAIP x509_hash client identifier prefix is advertised',
    ]);
  });

  it('does not treat direct_post.jwt advertisement alone as HAIP support', () => {
    const metadata = supportedMetadata();
    metadata.authorizationServer.request_uri_parameter_supported = false;
    const haipRequestCheck = evaluateOpenID4VCMetadata(metadata).find((entry) =>
      entry.requirement.startsWith('HAIP direct_post.jwt')
    );
    expect(haipRequestCheck?.passed).toBe(false);
  });
});
