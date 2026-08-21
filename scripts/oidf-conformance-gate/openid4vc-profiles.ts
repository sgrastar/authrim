export type OpenID4VCProfile = 'oid4vci-final' | 'oid4vci-haip' | 'oid4vp-final' | 'oid4vp-haip';

export interface OpenID4VCProfileDefinition {
  planName: 'oid4vci-1_0-issuer-test-plan' | 'oid4vp-1final-verifier-test-plan';
  variant: Readonly<Record<string, string>>;
  representativeModule: string;
}

const VCI_BASE_VARIANT = {
  sender_constrain: 'dpop',
  vci_authorization_code_flow_variant: 'wallet_initiated',
  credential_format: 'sd_jwt_vc',
  authorization_request_type: 'simple',
  openid: 'plain_oauth',
  fapi_request_method: 'unsigned',
  vci_grant_type: 'authorization_code',
  vci_credential_encryption: 'plain',
  fapi_response_mode: 'plain_response',
} as const;

export const OPENID4VC_PROFILES: Readonly<Record<OpenID4VCProfile, OpenID4VCProfileDefinition>> = {
  'oid4vci-final': {
    planName: 'oid4vci-1_0-issuer-test-plan',
    variant: {
      ...VCI_BASE_VARIANT,
      client_auth_type: 'private_key_jwt',
      fapi_profile: 'vci',
    },
    representativeModule: 'oid4vci-1_0-issuer-happy-flow',
  },
  'oid4vci-haip': {
    planName: 'oid4vci-1_0-issuer-test-plan',
    variant: {
      ...VCI_BASE_VARIANT,
      client_auth_type: 'client_attestation',
      fapi_profile: 'vci_haip',
    },
    representativeModule: 'oid4vci-1_0-issuer-happy-flow',
  },
  'oid4vp-final': {
    planName: 'oid4vp-1final-verifier-test-plan',
    variant: {
      credential_format: 'sd_jwt_vc',
      request_method: 'url_query',
      vp_profile: 'plain_vp',
      client_id_prefix: 'redirect_uri',
      response_mode: 'direct_post',
    },
    representativeModule: 'oid4vp-1final-verifier-happy-flow',
  },
  'oid4vp-haip': {
    planName: 'oid4vp-1final-verifier-test-plan',
    variant: {
      credential_format: 'sd_jwt_vc',
      request_method: 'request_uri_signed',
      vp_profile: 'haip',
      client_id_prefix: 'x509_hash',
      response_mode: 'direct_post.jwt',
    },
    representativeModule: 'oid4vp-1final-verifier-happy-flow',
  },
};

export function openID4VCProfilesForArgument(value: string): OpenID4VCProfile[] {
  if (value === 'all') return Object.keys(OPENID4VC_PROFILES) as OpenID4VCProfile[];
  if (value in OPENID4VC_PROFILES) return [value as OpenID4VCProfile];
  throw new Error(`Unknown OpenID4VC conformance profile: ${value}`);
}

export function normalizeOpenID4VCTargetOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OpenID4VC target must be an absolute HTTPS origin.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('OpenID4VC target must be an absolute HTTPS origin.');
  }
  return url.origin;
}

export function assertOpenID4VCPlanBinding(input: {
  profile: OpenID4VCProfile;
  actualPlanName: string | undefined;
  actualVariant: Record<string, string> | undefined;
}): void {
  const expected = OPENID4VC_PROFILES[input.profile];
  if (input.actualPlanName !== expected.planName) {
    throw new Error(
      `${input.profile} requires ${expected.planName}; received ${input.actualPlanName || 'unknown'}`
    );
  }
  if (!input.actualVariant) {
    throw new Error(`${input.profile} plan has no variant binding`);
  }
  for (const [key, value] of Object.entries(expected.variant)) {
    if (input.actualVariant[key] !== value) {
      throw new Error(
        `${input.profile} requires variant ${key}=${value}; received ${input.actualVariant[key] || 'missing'}`
      );
    }
  }
}
