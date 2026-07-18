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
});
