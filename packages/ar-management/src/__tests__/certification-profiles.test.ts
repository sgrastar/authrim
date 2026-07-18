import { describe, expect, it } from 'vitest';
import { getCertificationProfile } from '../certification-profiles';

describe('certification profiles', () => {
  it('defines a tenant-scoped FAPI 2.0 Client Credentials DPoP profile', () => {
    const profile = getCertificationProfile('fapi-2-client-credentials-dpop');

    expect(profile).toMatchObject({
      settings: {
        fapi: { enabled: true, requireDpop: true, allowPublicClients: false },
        oidc: {
          requirePar: false,
          tokenEndpointAuthMethodsSupported: ['private_key_jwt'],
          clientCredentials: { enabled: true },
          aiEphemeralAuth: { enabled: true },
        },
      },
    });
  });

  it('defines a FAPI 2.0 Message Signing profile without changing the normal FAPI profile', () => {
    const profile = getCertificationProfile('fapi-2-message-signing-dpop');
    const normal = getCertificationProfile('fapi-2-dpop');

    expect(profile).toMatchObject({
      settings: {
        fapi: {
          enabled: true,
          requireDpop: true,
          messageSigning: {
            enabled: true,
            requireSignedRequestObject: true,
            requireJarm: true,
            requestObjectSigningAlgorithms: ['ES256', 'PS256', 'EdDSA'],
            authorizationSigningAlgorithms: ['ES256'],
            defaultAuthorizationSigningAlgorithm: 'ES256',
          },
        },
        oidc: {
          requirePar: true,
          tokenEndpointAuthMethodsSupported: ['private_key_jwt'],
        },
      },
    });
    expect(normal?.settings.fapi.messageSigning).toBeUndefined();
  });
});
