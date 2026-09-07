import { normalizeOpenID4VCTargetOrigin } from './openid4vc-profiles';

type JsonObject = Record<string, unknown>;

export interface OpenID4VCMetadataCheck {
  profile: 'oid4vci-final' | 'oid4vci-haip' | 'oid4vp-final' | 'oid4vp-haip';
  requirement: string;
  passed: boolean;
  observed: string;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function check(
  profile: OpenID4VCMetadataCheck['profile'],
  requirement: string,
  passed: boolean,
  observed: unknown
): OpenID4VCMetadataCheck {
  return {
    profile,
    requirement,
    passed,
    observed: typeof observed === 'string' ? observed : JSON.stringify(observed),
  };
}

export function evaluateOpenID4VCMetadata(input: {
  targetOrigin: string;
  authorizationServer: JsonObject;
  credentialIssuer: JsonObject;
  verifier: JsonObject;
  credentialConfigurationId?: string;
}): OpenID4VCMetadataCheck[] {
  const origin = normalizeOpenID4VCTargetOrigin(input.targetOrigin);
  const configurationId = input.credentialConfigurationId || 'AuthrimIdentityCredential';
  const configuration = object(
    object(input.credentialIssuer.credential_configurations_supported)[configurationId]
  );
  const proofTypes = object(configuration.proof_types_supported);
  const verifierFormats = object(input.verifier.vp_formats_supported);
  const clientIdSchemes = strings(input.verifier.client_id_schemes_supported);
  const responseModes = strings(input.verifier.response_modes_supported);
  const tokenAuthMethods = strings(input.authorizationServer.token_endpoint_auth_methods_supported);
  const dpopAlgorithms = strings(input.authorizationServer.dpop_signing_alg_values_supported);

  return [
    check(
      'oid4vci-final',
      'Credential Issuer identifier is bound to the tested tenant',
      input.credentialIssuer.credential_issuer === origin,
      input.credentialIssuer.credential_issuer
    ),
    check(
      'oid4vci-final',
      'SD-JWT VC credential configuration is advertised',
      configuration.format === 'dc+sd-jwt',
      configuration.format
    ),
    check(
      'oid4vci-final',
      'JWT proof and DPoP algorithms are advertised',
      Object.keys(proofTypes).includes('jwt') && dpopAlgorithms.length > 0,
      { proofTypes: Object.keys(proofTypes), dpopAlgorithms }
    ),
    check(
      'oid4vci-haip',
      'Every selected credential configuration has a non-empty scope',
      typeof configuration.scope === 'string' && configuration.scope.length > 0,
      configuration.scope ?? 'missing'
    ),
    check(
      'oid4vci-haip',
      'OAuth client-attestation authentication is advertised',
      tokenAuthMethods.includes('attest_jwt_client_auth'),
      tokenAuthMethods
    ),
    check(
      'oid4vp-final',
      'DCQL with dc+sd-jwt and direct_post is advertised',
      input.verifier.dcql_supported === true &&
        Object.hasOwn(verifierFormats, 'dc+sd-jwt') &&
        responseModes.includes('direct_post'),
      {
        dcqlSupported: input.verifier.dcql_supported,
        formats: Object.keys(verifierFormats),
        responseModes,
      }
    ),
    check(
      'oid4vp-final',
      'Final redirect_uri client identifier prefix is advertised',
      clientIdSchemes.includes('redirect_uri'),
      clientIdSchemes
    ),
    check(
      'oid4vp-haip',
      'HAIP x509_hash client identifier prefix is advertised',
      clientIdSchemes.includes('x509_hash'),
      clientIdSchemes
    ),
    check(
      'oid4vp-haip',
      'HAIP direct_post.jwt and signed request_uri prerequisites are advertised',
      responseModes.includes('direct_post.jwt') &&
        input.authorizationServer.request_uri_parameter_supported === true,
      {
        responseModes,
        requestUriParameterSupported: input.authorizationServer.request_uri_parameter_supported,
      }
    ),
  ];
}

export async function fetchOpenID4VCMetadata(targetOrigin: string): Promise<{
  authorizationServer: JsonObject;
  credentialIssuer: JsonObject;
  verifier: JsonObject;
}> {
  const origin = normalizeOpenID4VCTargetOrigin(targetOrigin);
  const paths = [
    '/.well-known/openid-configuration',
    '/.well-known/openid-credential-issuer',
    '/.well-known/openid-credential-verifier',
  ] as const;
  const responses = await Promise.all(
    paths.map((path) =>
      fetch(`${origin}${path}`, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      })
    )
  );
  for (const [index, response] of responses.entries()) {
    if (!response.ok) throw new Error(`${paths[index]} returned ${response.status}`);
  }
  const [authorizationServer, credentialIssuer, verifier] = await Promise.all(
    responses.map((response) => response.json() as Promise<JsonObject>)
  );
  return { authorizationServer, credentialIssuer, verifier };
}
