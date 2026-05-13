import { describe, expect, it, vi } from 'vitest';
import {
  resolveSAMLMetadataSigningMode,
  shouldSignSAMLMetadata,
  signSAMLMetadata,
} from '../metadata-signing';

describe('SAML metadata signing', () => {
  const metadataXml = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor
  xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  ID="_authrim_saml_idp_test"
  entityID="https://auth.example.com/saml/idp">
</md:EntityDescriptor>`;

  it('defaults metadata signing to disabled', () => {
    expect(resolveSAMLMetadataSigningMode({})).toBe('disabled');
    expect(shouldSignSAMLMetadata({})).toBe(false);
  });

  it.each(['enabled', 'true', '1'])('enables metadata signing for %s', (value) => {
    expect(
      shouldSignSAMLMetadata({
        SAML_METADATA_SIGNING: value,
      })
    ).toBe(true);
  });

  it('signs the EntityDescriptor ID with enveloped XML signature options', () => {
    const signer = vi.fn(() => '<signed-metadata />');

    const signed = signSAMLMetadata(
      metadataXml,
      {
        privateKeyPem: 'private-key',
        certificate: 'certificate',
      },
      signer
    );

    expect(signed).toBe('<signed-metadata />');
    expect(signer).toHaveBeenCalledWith(metadataXml, {
      privateKey: 'private-key',
      certificate: 'certificate',
      referenceUri: '#_authrim_saml_idp_test',
      signatureLocation: 'prepend',
      includeKeyInfo: true,
    });
  });

  it('fails closed when metadata has no stable EntityDescriptor ID', () => {
    expect(() =>
      signSAMLMetadata(
        '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" />',
        {
          privateKeyPem: 'private-key',
          certificate: 'certificate',
        },
        vi.fn()
      )
    ).toThrow('SAML metadata signing requires EntityDescriptor ID');
  });
});
