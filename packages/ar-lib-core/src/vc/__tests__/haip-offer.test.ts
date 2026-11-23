import { describe, it, expect } from 'vitest';
import { HAIP_VCI_SCHEME, buildHaipCredentialOffer } from '../haip-offer';

describe('buildHaipCredentialOffer', () => {
  it("offers the authorization code grant at the issuer's own OP, by value, on the haip-vci scheme", () => {
    const { offer, uri } = buildHaipCredentialOffer({
      credentialIssuer: 'https://idp.example.com',
      credentialConfigurationId: 'AuthrimAdminCredential',
    });
    expect(offer).toEqual({
      credential_issuer: 'https://idp.example.com',
      credential_configuration_ids: ['AuthrimAdminCredential'],
      grants: { authorization_code: { authorization_server: 'https://idp.example.com' } },
    });
    expect(uri.startsWith(`${HAIP_VCI_SCHEME}?credential_offer=`)).toBe(true);
    const encoded = uri.slice(`${HAIP_VCI_SCHEME}?credential_offer=`.length);
    expect(JSON.parse(decodeURIComponent(encoded))).toEqual(offer);
    // Nothing secret travels in it, and no pre-authorized grant is offered.
    expect(uri).not.toContain('pre-authorized');
  });

  it('refuses an issuer that is not an https origin and a malformed configuration id', () => {
    for (const credentialIssuer of [
      'http://idp.example.com',
      'https://idp.example.com/path',
      'https://idp.example.com/',
      'idp.example.com',
    ]) {
      expect(() =>
        buildHaipCredentialOffer({
          credentialIssuer,
          credentialConfigurationId: 'AuthrimAdminCredential',
        })
      ).toThrow();
    }
    expect(() =>
      buildHaipCredentialOffer({
        credentialIssuer: 'https://idp.example.com',
        credentialConfigurationId: 'bad id',
      })
    ).toThrow('haip_offer_configuration_invalid');
  });
});
