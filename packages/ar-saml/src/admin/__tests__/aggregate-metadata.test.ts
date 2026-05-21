import { describe, expect, it } from 'vitest';
import {
  extractEntityDescriptorXml,
  fingerprintCertificateSha256,
  isAggregateMetadata,
  parseAggregateMetadata,
  verifyAggregateMetadataSignature,
} from '../aggregate-metadata';
import { signXml } from '../../common/signature';

const testPrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC6GHFfTLe7OFyL
R7HdFE5ljqiUyCplJfyfJD0we+WnY7iZ77KnKjnXvZWUMNTC5PAzb9r6i8q7JD1n
c7NKofHSs8+QGtvwzTWLP4SWIcfGG9VV8qUY2xKNJ8TuOazbxg9SK5mmgyd0QwGh
gzIu0hvOKbcTZoKPc1IWyS82qU7xLJrABcti/hLnBg+sKXtesWAh+Xn0DPnCFQYt
Esw/X2ttIPW/4AXQana0FGsDNYYsKB1ufY7lV9allraI5jPHkE/ZfG0GOh56qDw0
AJNOgWrMOQ1LJDpbpDFvhM6eTbUKhPls1IFDgeJFlk032IIbkfuMWEni/M0tOoTe
Kof9dB5RAgMBAAECggEAAKsaVKMjdHoBYerlLEutb/zZAkM41GQ6w709zTPW6ic4
hdkuOJHFPiNVGJf8r/g5jXpXThYeK5Za+I16JhwklOntgUDhPgC7z1weFEbPQfwl
v4IbFmJlNV2rIQ2wwEG8jbEm9Fv1LA5P77mLnaqGbTLmmQptao7WbYKMNfEimob6
v5SouD1axF1filIuY3Wnj6vU6FOT6UZx91QbkIYlcy0/CDwK45sMpSXr1oddHe0K
hP5qaMquY4OewstHFWTEa6Mqlpwoo8fpgrxoEuPr0ldazBgVnkLgkSghlEYoRsiX
nUsHYlF/Yil24nlog+rC5IcGocX1KD+m4qlUxtkfAQKBgQD5Yvged8xotM+1lXsw
q7SFJ1f+XW+MwvNbIsDdWI/mLppej+Tb37Vwtxn1aWPyIZP73Bhy/4BjdshzNCyH
O1fb9IDP/JBhEIRIl33JkMhFylbotJLxUCTi5K2suEpFO84cXTCleI66D8tX5uDJ
BEoJDJVBMHIs19fVxbaLj8NHAQKBgQC/B83dPwEF+5a7JUpOxQNnWhy+zqNd2TU1
jY8rIAZsU5tb1F043p/lUmfbIivDhHx0FVBKnbiMAgupszk6tN5xRSVsDsYBHHu0
FDzYJXDqGZZUxT7q3zWggHud01uEykHkwh6AheACOokKEyGdxgfRVtx4INBDb55d
meMxblmnUQKBgDZNJHWN5EZQSIHjYIWCfbYYkQJj2ewubsrDUHdh10NplldMwapW
la1LUS2smwSX5x8KF5DCrXP64z6id6eidkkAfiPLfKyF6ifcRJllGxaHLlFRMEW3
C7ET1fUr05Arq39lkzgUfg9pbP9g2EUs1+oMgVtGbzXwcaCsgkj1LrIBAoGBAJJo
89IPOMSSF+tlYDdQ7hPnT8K58yG5mPtrfIAr8mBSD+9oqu4sSlZjOzALV4lpYE1E
DJ6zlT7RTokI0OL6vsYHne/cvssZPoI9RIjQ4WK6q6pa5qby3lIeRyAmXq0+qxQd
52zPrmlm3aM4GHqozVMXhLAZTiVxReotSKCZF+ORAoGACY9pYPmFI/2e18PN9xjo
Ht/ng/V8VLikEDl3tT8Zv9+r/83tcrjgmzDlf13tA9s0ac/KqJn2dlxa9oLb6iq0
oHPa1QEDdepuBOyiGmHNf8RHhBm3WsFxXOFKwBE5tGxgIQ529dcnehM6/o84C4eI
egw/OarojpPy6CaPG6w10G8=
-----END PRIVATE KEY-----`;

const testCertificate = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUEgn0BYLRk2hTRQbUKUKgmEofvuowDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNVGVzdCBTQU1MIElkUDAeFw0yNTEyMjAxMjE3MzJaFw0z
NTEyMTgxMjE3MzJaMBgxFjAUBgNVBAMMDVRlc3QgU0FNTCBJZFAwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQC6GHFfTLe7OFyLR7HdFE5ljqiUyCplJfyf
JD0we+WnY7iZ77KnKjnXvZWUMNTC5PAzb9r6i8q7JD1nc7NKofHSs8+QGtvwzTWL
P4SWIcfGG9VV8qUY2xKNJ8TuOazbxg9SK5mmgyd0QwGhgzIu0hvOKbcTZoKPc1IW
yS82qU7xLJrABcti/hLnBg+sKXtesWAh+Xn0DPnCFQYtEsw/X2ttIPW/4AXQana0
FGsDNYYsKB1ufY7lV9allraI5jPHkE/ZfG0GOh56qDw0AJNOgWrMOQ1LJDpbpDFv
hM6eTbUKhPls1IFDgeJFlk032IIbkfuMWEni/M0tOoTeKof9dB5RAgMBAAGjUzBR
MB0GA1UdDgQWBBTvFqiV3zmGR7gvZ4NHg0qBDcscpjAfBgNVHSMEGDAWgBTvFqiV
3zmGR7gvZ4NHg0qBDcscpjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQAtRXwrFZW8H5ycRuiGnmUVprbfv66GrSiknO/fMWvcfD6rYdtckTFN9l8K
REcWpgeNgRhSx4RibZfuH8b+temXXm3/wgEVb/bZHddB/pVVeoTRfcYgOALrklzb
TCRBe6wVyQyrW+EVw/mfuN0COKkYxoe7GTql3l+JA2pK+FoIGShMJg2zpJjscX8+
Cz7UiUaH27x8IE4LGzcxDeZgpqYZDs2Bp1H0jRa4igkvH0zSNRZm0ErgpErOgJbz
p1hSbc73BFCq2TO7acDmxkKKAbQ9nfZhO6cZEqoMgkfRpqV2BrBDC9GBhoK0yaUU
rXDP3Op15iM4yR/FO2uFs9ZPLoHu
-----END CERTIFICATE-----`;

const differentCertificate = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUNSH1VyCoup3Y8F8/LBxNimR2uucwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNRGlmZmVyZW50IElkUDAeFw0yNTEyMjAxMjE3NDJaFw0z
NTEyMTgxMjE3NDJaMBgxFjAUBgNVBAMMDURpZmZlcmVudCBJZFAwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDqc2Wf2rXR3KzldgB0MKXsIE6cD4CHF92J
y+kp6diJzuQPo5pO/4SNLM9WhXgP4hehu8GRfL3LySQxkr39+G6VvyUu5HSKUQ2C
bkOlNoTKuRdlxcgevztcSgEGzpIBmV3CAEcbe1tCE51uLP91bL7ODo8OHKc89rD9
CHauhzYUz50VRpm0QgP35mTWgoHBUJHHors1qea9VORcQ+fTg5mGgu13E1ZUlnuy
okU3ltpVsHO4IKgJX9iicMZuHCaGZTqQiWpjWg8hpSOAPYwrWlo7om2iOMV9FBOL
HiCb9yRrodCzy8PWCcQEIT/vhPioO5GI3GNlEmSk6BunkFiNcgWbAgMBAAGjUzBR
MB0GA1UdDgQWBBRntKzO7ZmO2446hac0/gbOLL1jSzAfBgNVHSMEGDAWgBRntKzO
7ZmO2446hac0/gbOLL1jSzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQAVeKeGIge9X9xChkhEsypIRgRc0afJcfRPkwMYAVRtZaVsjKQ/BQclNyTB
GK4hojV4ikLVUSA4QGZXDDSwOs5fEukqWILrJCMpqrad59PSrSWXY/aWmtZ7/D4V
9dT3VINm4n6oAFL0u+pz/E4JnCJ4tVRYxondROEMVVoj87mkprBxa9v5bU3ib9DN
SBxekCUogMCRDIbwE4Oi5Y/fi7Qbn3VLuf0XSn5VJegj7PL0iCj9aSxgAZVJ1jH6
5n0xP+qrQCFm6HDQJs7aYp/kSSOmZu7WZcTHdQA75mCn2oxjST/U/pt0z14kpa2X
0wOD8RRqKOeqTc6WUQzejhS+J/f7
-----END CERTIFICATE-----`;

const aggregateXml = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntitiesDescriptor
  xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  xmlns:mdui="urn:oasis:names:tc:SAML:metadata:ui"
  ID="_aggregate"
  validUntil="2030-01-01T00:00:00Z">
  <md:EntityDescriptor entityID="https://idp.example.test/idp">
    <md:IDPSSODescriptor
      protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:Extensions>
        <mdui:UIInfo>
          <mdui:DisplayName xml:lang="en">Example IdP</mdui:DisplayName>
          <mdui:Keywords xml:lang="en">category:location:tohoku category:type:test</mdui:Keywords>
          <mdui:Logo xml:lang="en" width="96" height="64">https://idp.example.test/logo.png</mdui:Logo>
        </mdui:UIInfo>
      </md:Extensions>
      <md:KeyDescriptor use="signing">
        <ds:KeyInfo>
          <ds:X509Data>
            <ds:X509Certificate>IDPCERT</ds:X509Certificate>
          </ds:X509Data>
        </ds:KeyInfo>
      </md:KeyDescriptor>
      <md:SingleSignOnService
        Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
        Location="https://idp.example.test/sso" />
    </md:IDPSSODescriptor>
  </md:EntityDescriptor>
  <md:EntitiesDescriptor Name="nested">
    <md:EntityDescriptor entityID="https://sp.example.test/sp">
      <md:SPSSODescriptor
        protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
        <md:AssertionConsumerService
          Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
          Location="https://sp.example.test/acs"
          index="0"
          isDefault="true" />
      </md:SPSSODescriptor>
    </md:EntityDescriptor>
  </md:EntitiesDescriptor>
</md:EntitiesDescriptor>`;

const signableAggregateXml = `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" ID="_signed_aggregate"><md:EntityDescriptor entityID="https://sp.example.test/sp"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.test/acs" index="0" isDefault="true"/></md:SPSSODescriptor></md:EntityDescriptor></md:EntitiesDescriptor>`;

describe('SAML aggregate metadata', () => {
  it('detects and summarizes aggregate metadata including nested entity descriptors', () => {
    expect(isAggregateMetadata(aggregateXml)).toBe(true);

    const aggregate = parseAggregateMetadata(aggregateXml);

    expect(aggregate.rootId).toBe('_aggregate');
    expect(aggregate.validUntil).toBe('2030-01-01T00:00:00Z');
    expect(aggregate.entities).toHaveLength(2);
    expect(aggregate.entities[0]).toMatchObject({
      entityId: 'https://idp.example.test/idp',
      role: 'saml_idp',
      displayName: 'Example IdP',
      ssoUrl: 'https://idp.example.test/sso',
      certificateCount: 1,
      keywords: ['category:location:tohoku', 'category:type:test'],
      logoUrl: 'https://idp.example.test/logo.png',
    });
    expect(aggregate.entities[1]).toMatchObject({
      entityId: 'https://sp.example.test/sp',
      role: 'saml_sp',
      acsUrl: 'https://sp.example.test/acs',
      certificateCount: 0,
    });
  });

  it('extracts a selected EntityDescriptor with namespace declarations preserved', () => {
    const xml = extractEntityDescriptorXml(aggregateXml, 'https://sp.example.test/sp');

    expect(xml).toContain('<md:EntityDescriptor');
    expect(xml).toContain('xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"');
    expect(xml).toContain('entityID="https://sp.example.test/sp"');
    expect(xml).toContain('AssertionConsumerService');
    expect(xml).not.toContain('https://idp.example.test/idp');
  });

  it('permits unsigned aggregate metadata in warn mode but records the trust profile decision', () => {
    const summary = verifyAggregateMetadataSignature(
      aggregateXml,
      'https://metadata.example.test/aggregate.xml',
      [
        {
          id: 'profile-1',
          tenantId: 'default',
          name: 'Example federation',
          metadataUrlPatterns: ['https://metadata.example.test/*'],
          certificates: [],
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      'warn'
    );

    expect(summary.status).toBe('unverified');
    expect(summary.trustProfileId).toBe('profile-1');
    expect(summary.error).toBe('Aggregate metadata root is not signed');
  });

  it('rejects unsigned aggregate metadata in strict mode', () => {
    expect(() =>
      verifyAggregateMetadataSignature(
        aggregateXml,
        'https://metadata.example.test/aggregate.xml',
        [
          {
            id: 'profile-1',
            tenantId: 'default',
            name: 'Example federation',
            metadataUrlPatterns: ['https://metadata.example.test/*'],
            certificates: [],
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        'strict'
      )
    ).toThrow('Aggregate metadata root is not signed');
  });

  it('records disabled aggregate metadata signature verification explicitly', () => {
    expect(
      verifyAggregateMetadataSignature(
        aggregateXml,
        'https://metadata.example.test/aggregate.xml',
        [],
        'disabled'
      )
    ).toMatchObject({
      status: 'skipped',
      policy: 'disabled',
    });
  });

  it('verifies signed aggregate metadata with a matching trust profile', () => {
    const signedXml = signXml(signableAggregateXml, {
      privateKey: testPrivateKey,
      certificate: testCertificate,
      referenceUri: '#_signed_aggregate',
      signatureLocation: 'prepend',
    });

    const summary = verifyAggregateMetadataSignature(
      signedXml,
      'https://metadata.example.test/aggregate.xml',
      [
        {
          id: 'profile-1',
          tenantId: 'default',
          name: 'Example federation',
          metadataUrlPatterns: ['https://metadata.example.test/*'],
          certificates: [
            {
              id: 'cert-1',
              certificate: testCertificate,
              fingerprintSha256: 'test-fingerprint',
              createdAt: 1,
            },
          ],
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      'strict'
    );

    expect(summary).toMatchObject({
      status: 'verified',
      trustProfileId: 'profile-1',
      certificateFingerprintSha256: 'test-fingerprint',
      signedElementId: '_signed_aggregate',
    });
  });

  it('does not match uploaded aggregate metadata to URL-bound trust profiles without a URL', () => {
    const signedXml = signXml(signableAggregateXml, {
      privateKey: testPrivateKey,
      certificate: testCertificate,
      referenceUri: '#_signed_aggregate',
      signatureLocation: 'prepend',
    });

    expect(() =>
      verifyAggregateMetadataSignature(
        signedXml,
        undefined,
        [
          {
            id: 'profile-1',
            tenantId: 'default',
            name: 'Example federation',
            metadataUrlPatterns: ['https://metadata.example.test/*'],
            certificates: [
              {
                id: 'cert-1',
                certificate: testCertificate,
                fingerprintSha256: 'test-fingerprint',
                createdAt: 1,
              },
            ],
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        'strict'
      )
    ).toThrow('No matching federation trust profile');
  });

  it('allows uploaded aggregate metadata only when the trust profile explicitly uses *', () => {
    const signedXml = signXml(signableAggregateXml, {
      privateKey: testPrivateKey,
      certificate: testCertificate,
      referenceUri: '#_signed_aggregate',
      signatureLocation: 'prepend',
    });

    const summary = verifyAggregateMetadataSignature(
      signedXml,
      undefined,
      [
        {
          id: 'profile-1',
          tenantId: 'default',
          name: 'Offline federation',
          metadataUrlPatterns: ['*'],
          certificates: [
            {
              id: 'cert-1',
              certificate: testCertificate,
              fingerprintSha256: 'test-fingerprint',
              createdAt: 1,
            },
          ],
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      'strict'
    );

    expect(summary.status).toBe('verified');
  });

  it('rejects aggregate signatures with more than one Reference', () => {
    const signedXml = signXml(signableAggregateXml, {
      privateKey: testPrivateKey,
      certificate: testCertificate,
      referenceUri: '#_signed_aggregate',
      signatureLocation: 'prepend',
    }).replace(
      /<\/(?:\w+:)?SignedInfo>/,
      '<Reference xmlns="http://www.w3.org/2000/09/xmldsig#" URI="#unexpected"><DigestValue>ignored</DigestValue></Reference>$&'
    );

    expect(() =>
      verifyAggregateMetadataSignature(
        signedXml,
        'https://metadata.example.test/aggregate.xml',
        [
          {
            id: 'profile-1',
            tenantId: 'default',
            name: 'Example federation',
            metadataUrlPatterns: ['https://metadata.example.test/*'],
            certificates: [
              {
                id: 'cert-1',
                certificate: testCertificate,
                fingerprintSha256: 'test-fingerprint',
                createdAt: 1,
              },
            ],
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        'strict'
      )
    ).toThrow(
      'Aggregate signature reference does not exclusively cover the root EntitiesDescriptor'
    );
  });

  it('rejects tampered signed aggregate metadata in strict mode', () => {
    const signedXml = signXml(signableAggregateXml, {
      privateKey: testPrivateKey,
      certificate: testCertificate,
      referenceUri: '#_signed_aggregate',
      signatureLocation: 'prepend',
    }).replace('https://sp.example.test/acs', 'https://sp.example.test/tampered');

    expect(() =>
      verifyAggregateMetadataSignature(
        signedXml,
        'https://metadata.example.test/aggregate.xml',
        [
          {
            id: 'profile-1',
            tenantId: 'default',
            name: 'Example federation',
            metadataUrlPatterns: ['https://metadata.example.test/*'],
            certificates: [
              {
                id: 'cert-1',
                certificate: testCertificate,
                fingerprintSha256: 'test-fingerprint',
                createdAt: 1,
              },
            ],
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        'strict'
      )
    ).toThrow('Aggregate metadata signature could not be verified');
  });

  it('rejects aggregate metadata signed by an unknown certificate in strict mode', () => {
    const signedXml = signXml(signableAggregateXml, {
      privateKey: testPrivateKey,
      certificate: testCertificate,
      referenceUri: '#_signed_aggregate',
      signatureLocation: 'prepend',
    });

    expect(() =>
      verifyAggregateMetadataSignature(
        signedXml,
        'https://metadata.example.test/aggregate.xml',
        [
          {
            id: 'profile-1',
            tenantId: 'default',
            name: 'Example federation',
            metadataUrlPatterns: ['https://metadata.example.test/*'],
            certificates: [
              {
                id: 'cert-1',
                certificate: differentCertificate,
                fingerprintSha256: 'different-fingerprint',
                createdAt: 1,
              },
            ],
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        'strict'
      )
    ).toThrow('Aggregate metadata signature could not be verified');
  });

  it('rejects invalid trust certificate PEM before fingerprinting', async () => {
    await expect(fingerprintCertificateSha256('not a certificate')).rejects.toThrow(
      'Invalid trust certificate PEM'
    );
  });
});
