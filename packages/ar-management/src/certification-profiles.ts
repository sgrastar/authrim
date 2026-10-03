/**
 * OpenID Certification Test Profiles
 *
 * Pre-configured protocol settings for OpenID certification test plans, as Settings API values by
 * category. Applying one (POST /api/admin/certification-profiles/:id/apply) saves them as the
 * tenant's values and clears the other protocol settings the profiles manage, so the tenant
 * inherits those again; see `routes/certification-profiles.ts`.
 */

import { protocolSettingKeys, type CategoryName } from '@authrim/ar-lib-core';

export interface CertificationProfile {
  name: string;
  description: string;
  /** Settings API values by category. */
  settings: Partial<Record<CategoryName, Record<string, unknown>>>;
}

const OIDC_AUTH_METHODS = [
  'client_secret_basic',
  'client_secret_post',
  'client_secret_jwt',
  'private_key_jwt',
  'none',
];

/** The protocol settings of an OpenID Connect OP profile (no FAPI, unsigned request objects). */
function oidcOp(responseTypes: string[], authMethods: string[]) {
  return {
    security: {
      'security.fapi_enabled': false,
      'security.dpop_required': 'never',
      'security.fapi_allow_public_clients': true,
      'security.par_required': false,
      // Allowed for conformance tests (never in production).
      'security.allow_unsigned_request_object': true,
    },
    oauth: {
      'oauth.response_types_supported': responseTypes,
      'oauth.token_endpoint_auth_methods_supported': authMethods,
    },
  };
}

/** The protocol settings of a FAPI 2.0 profile. */
function fapi2(options: { dpop: boolean; par: boolean; issuerAudience: boolean }) {
  return {
    security: {
      'security.fapi_enabled': true,
      'security.dpop_required': options.dpop ? 'always' : 'never',
      'security.fapi_allow_public_clients': false,
      'security.par_required': options.par,
      'security.allow_unsigned_request_object': false,
      ...(options.issuerAudience ? { 'security.fapi_client_assertion_audience': 'issuer' } : {}),
    },
    oauth: {
      'oauth.response_types_supported': ['code'],
      'oauth.token_endpoint_auth_methods_supported': ['private_key_jwt'],
    },
  };
}

export const certificationProfiles: Record<string, CertificationProfile> = {
  'basic-op': {
    name: 'Basic OP',
    description: 'Standard OpenID Connect Provider (Authorization Code Flow)',
    settings: oidcOp(['code'], OIDC_AUTH_METHODS),
  },

  'implicit-op': {
    name: 'Implicit OP',
    description: 'OpenID Connect Provider with Implicit Flow support',
    settings: oidcOp(
      ['code', 'id_token', 'id_token token'],
      ['client_secret_basic', 'client_secret_post', 'none']
    ),
  },

  'hybrid-op': {
    name: 'Hybrid OP',
    description: 'OpenID Connect Provider with Hybrid Flow support',
    settings: oidcOp(
      ['code', 'code id_token', 'code token', 'code id_token token'],
      OIDC_AUTH_METHODS
    ),
  },

  'dynamic-op': {
    name: 'Dynamic OP',
    description: 'Full Dynamic OP certification profile (all flows, HTTPS request_uri, form_post)',
    settings: (() => {
      const base = oidcOp(
        [
          'code',
          'id_token',
          'id_token token',
          'code id_token',
          'code token',
          'code id_token token',
        ],
        OIDC_AUTH_METHODS
      );
      return {
        ...base,
        oauth: {
          ...base.oauth,
          // OIDC Core 6.2: Request Object by Reference from the conformance suite.
          'oauth.https_request_uri_enabled': true,
          'oauth.https_request_uri_allowed_domains':
            'certification.openid.net,www.certification.openid.net',
          'oauth.https_request_uri_timeout_ms': 10000,
          'oauth.https_request_uri_max_size': 102400,
        },
      };
    })(),
  },

  'fapi-1-advanced': {
    name: 'FAPI 1.0 Advanced',
    description: 'Financial-grade API Security Profile 1.0 - Advanced',
    settings: {
      security: {
        // FAPI 1.0 uses different validation rules than FAPI 2.0 mode.
        'security.fapi_enabled': false,
        'security.dpop_required': 'never',
        'security.fapi_allow_public_clients': false,
        'security.par_required': false,
        'security.allow_unsigned_request_object': false,
      },
      oauth: {
        'oauth.response_types_supported': ['code', 'code id_token'],
        'oauth.token_endpoint_auth_methods_supported': ['private_key_jwt'],
      },
    },
  },

  'fapi-2': {
    name: 'FAPI 2.0',
    description: 'Financial-grade API Security Profile 2.0',
    settings: fapi2({ dpop: false, par: true, issuerAudience: true }),
  },

  'fapi-2-dpop': {
    name: 'FAPI 2.0 + DPoP',
    description: 'FAPI 2.0 with DPoP sender-constrained tokens',
    settings: fapi2({ dpop: true, par: true, issuerAudience: true }),
  },

  'fapi-2-message-signing-dpop': {
    name: 'FAPI 2.0 Message Signing + DPoP',
    description: 'FAPI 2.0 Security Profile Final with signed authorization requests and JARM',
    settings: (() => {
      const base = fapi2({ dpop: true, par: true, issuerAudience: true });
      return {
        ...base,
        security: {
          ...base.security,
          'security.fapi_message_signing_enabled': true,
          'security.require_signed_request_object': true,
          'security.require_jarm': true,
          'security.request_object_signing_algs': 'ES256,PS256,EdDSA',
          'security.authorization_signing_algs': 'ES256',
          'security.default_authorization_signing_alg': 'ES256',
          'security.request_object_max_age_seconds': 3600,
          'security.request_object_max_lifetime_seconds': 3600,
          'security.request_object_clock_skew_seconds': 10,
        },
      };
    })(),
  },

  'fapi-2-client-credentials-dpop': {
    name: 'FAPI 2.0 Client Credentials + DPoP',
    description:
      'FAPI 2.0 Client Credentials grant with private_key_jwt and DPoP sender-constrained tokens',
    settings: {
      ...fapi2({ dpop: true, par: false, issuerAudience: true }),
      'feature-flags': {
        'feature.enable_client_credentials': true,
        'feature.enable_ai_ephemeral_auth': true,
      },
    },
  },

  'fapi-ciba': {
    name: 'FAPI CIBA',
    description: 'FAPI Client Initiated Backchannel Authentication (CIBA)',
    // CIBA uses backchannel authentication, not PAR.
    settings: fapi2({ dpop: false, par: false, issuerAudience: false }),
  },

  development: {
    name: 'Development',
    description: 'Relaxed settings for local development',
    settings: oidcOp(['code'], ['client_secret_basic', 'client_secret_post', 'none']),
  },
};

/**
 * The settings every profile manages, by category: the protocol settings of the older document's
 * fapi and oidc sections, which applying a profile used to replace whole. A profile that leaves
 * one out clears it, so the tenant inherits it again.
 */
export const CERTIFICATION_PROFILE_MANAGED_KEYS: ReadonlyMap<CategoryName, readonly string[]> =
  protocolSettingKeys(['fapi', 'oidc']);

/**
 * Get a certification profile by id
 */
export function getCertificationProfile(profileId: string): CertificationProfile | null {
  return Object.prototype.hasOwnProperty.call(certificationProfiles, profileId)
    ? certificationProfiles[profileId]
    : null;
}

/**
 * List all available certification profiles, with their settings
 */
export function listCertificationProfiles(): Array<{ id: string } & CertificationProfile> {
  return Object.entries(certificationProfiles).map(([id, profile]) => ({ id, ...profile }));
}
