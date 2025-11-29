/**
 * OpenID Certification Test Profiles
 *
 * Pre-configured settings for different OpenID Connect certification profiles
 * Use with: PUT /api/admin/settings/profile/:profileName
 */

export interface CertificationProfile {
  name: string;
  description: string;
  settings: {
    fapi: {
      enabled: boolean;
      requireDpop: boolean;
      allowPublicClients: boolean;
    };
    oidc: {
      requirePar: boolean;
      responseTypesSupported?: string[];
      tokenEndpointAuthMethodsSupported: string[];
      allowNoneAlgorithm?: boolean; // Allow 'none' algorithm for JWT signatures (default: false)
    };
  };
}

export const certificationProfiles: Record<string, CertificationProfile> = {
  'basic-op': {
    name: 'Basic OP',
    description: 'Standard OpenID Connect Provider (Authorization Code Flow)',
    settings: {
      fapi: {
        enabled: false,
        requireDpop: false,
        allowPublicClients: true,
      },
      oidc: {
        requirePar: false,
        responseTypesSupported: ['code'],
        tokenEndpointAuthMethodsSupported: [
          'client_secret_basic',
          'client_secret_post',
          'client_secret_jwt',
          'private_key_jwt',
          'none',
        ],
        allowNoneAlgorithm: true, // Allow for testing
      },
    },
  },

  'implicit-op': {
    name: 'Implicit OP',
    description: 'OpenID Connect Provider with Implicit Flow support',
    settings: {
      fapi: {
        enabled: false,
        requireDpop: false,
        allowPublicClients: true,
      },
      oidc: {
        requirePar: false,
        responseTypesSupported: ['code', 'id_token', 'id_token token'],
        tokenEndpointAuthMethodsSupported: ['client_secret_basic', 'client_secret_post', 'none'],
        allowNoneAlgorithm: true, // Allow for testing
      },
    },
  },

  'hybrid-op': {
    name: 'Hybrid OP',
    description: 'OpenID Connect Provider with Hybrid Flow support',
    settings: {
      fapi: {
        enabled: false,
        requireDpop: false,
        allowPublicClients: true,
      },
      oidc: {
        requirePar: false,
        responseTypesSupported: ['code', 'code id_token', 'code token', 'code id_token token'],
        tokenEndpointAuthMethodsSupported: [
          'client_secret_basic',
          'client_secret_post',
          'client_secret_jwt',
          'private_key_jwt',
          'none',
        ],
        allowNoneAlgorithm: true, // Allow for testing
      },
    },
  },

  'fapi-1-advanced': {
    name: 'FAPI 1.0 Advanced',
    description: 'Financial-grade API Security Profile 1.0 - Advanced',
    settings: {
      fapi: {
        enabled: false, // FAPI 1.0 uses different validation rules
        requireDpop: false, // FAPI 1.0 uses MTLS instead
        allowPublicClients: false,
      },
      oidc: {
        requirePar: false, // FAPI 1.0 doesn't mandate PAR
        responseTypesSupported: ['code', 'code id_token'],
        tokenEndpointAuthMethodsSupported: [
          'private_key_jwt',
          'tls_client_auth', // MTLS
        ],
        allowNoneAlgorithm: false, // Security: Reject 'none' algorithm
      },
    },
  },

  'fapi-2': {
    name: 'FAPI 2.0',
    description: 'Financial-grade API Security Profile 2.0',
    settings: {
      fapi: {
        enabled: true,
        requireDpop: false,
        allowPublicClients: false,
      },
      oidc: {
        requirePar: true,
        responseTypesSupported: ['code'],
        tokenEndpointAuthMethodsSupported: ['private_key_jwt', 'client_secret_jwt'],
        allowNoneAlgorithm: false, // Security: Reject 'none' algorithm
      },
    },
  },

  'fapi-2-dpop': {
    name: 'FAPI 2.0 + DPoP',
    description: 'FAPI 2.0 with DPoP sender-constrained tokens',
    settings: {
      fapi: {
        enabled: true,
        requireDpop: true,
        allowPublicClients: false,
      },
      oidc: {
        requirePar: true,
        responseTypesSupported: ['code'],
        tokenEndpointAuthMethodsSupported: ['private_key_jwt'],
        allowNoneAlgorithm: false, // Security: Reject 'none' algorithm
      },
    },
  },

  'fapi-ciba': {
    name: 'FAPI CIBA',
    description: 'FAPI Client Initiated Backchannel Authentication (CIBA)',
    settings: {
      fapi: {
        enabled: true,
        requireDpop: false,
        allowPublicClients: false,
      },
      oidc: {
        requirePar: false, // CIBA uses backchannel authentication, not PAR
        responseTypesSupported: ['code'],
        tokenEndpointAuthMethodsSupported: ['private_key_jwt'],
        allowNoneAlgorithm: false, // Security: Reject 'none' algorithm
      },
    },
  },

  development: {
    name: 'Development',
    description: 'Relaxed settings for local development',
    settings: {
      fapi: {
        enabled: false,
        requireDpop: false,
        allowPublicClients: true,
      },
      oidc: {
        requirePar: false,
        responseTypesSupported: ['code'],
        tokenEndpointAuthMethodsSupported: ['client_secret_basic', 'client_secret_post', 'none'],
        allowNoneAlgorithm: true, // Allow for development
      },
    },
  },
};

/**
 * Get a certification profile by name
 */
export function getCertificationProfile(profileName: string): CertificationProfile | null {
  return certificationProfiles[profileName] || null;
}

/**
 * List all available certification profiles
 */
export function listCertificationProfiles(): Array<{ name: string; description: string }> {
  return Object.values(certificationProfiles).map((profile) => ({
    name: profile.name,
    description: profile.description,
  }));
}
