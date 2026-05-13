import { describe, expect, it } from 'vitest';
import type { AuthrimDRBundle } from '../dr-bundle';
import {
  assertDRBundleContainsNoPrivateMaterial,
  findDRBundlePrivateMaterial,
} from '../../utils/dr-bundle';

describe('Authrim DR bundle schema', () => {
  it('accepts SAML configuration snapshots without private material', () => {
    const bundle = createBundle();

    expect(() => assertDRBundleContainsNoPrivateMaterial(bundle)).not.toThrow();
    expect(bundle.protocols.saml?.pairwiseSubject).toEqual({
      enabled: true,
      algorithm: 'sha256-base64url',
      secretRef: 'tenant:library-a:saml:pairwise-nameid',
      rotationModel: 'active_previous',
      includesSecretValue: false,
    });
    expect(bundle.exclusions).toEqual({
      activeSessions: true,
      privateSigningKeys: true,
      samlTransientState: true,
      oidcTokensAndCodes: true,
    });
  });

  it('detects forbidden private material fields and PEM values', () => {
    const unsafeBundle = {
      ...createBundle(),
      protocols: {
        saml: {
          ...createBundle().protocols.saml,
          privateKeyPem: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
          serviceProviders: [
            {
              ...createBundle().protocols.saml!.serviceProviders[0],
              client_secret: 'do-not-export',
            },
          ],
        },
      },
    } as unknown as AuthrimDRBundle;

    expect(findDRBundlePrivateMaterial(unsafeBundle)).toEqual(
      expect.arrayContaining([
        {
          path: '$.protocols.saml.privateKeyPem',
          reason: 'forbidden_key',
        },
        {
          path: '$.protocols.saml.privateKeyPem',
          reason: 'private_key_pem',
        },
        {
          path: '$.protocols.saml.serviceProviders[0].client_secret',
          reason: 'forbidden_key',
        },
      ])
    );
    expect(() => assertDRBundleContainsNoPrivateMaterial(unsafeBundle)).toThrow(
      'DR bundle contains private material'
    );
  });
});

function createBundle(): AuthrimDRBundle {
  return {
    kind: 'authrim.dr_bundle.v1',
    schemaVersion: '1',
    bundleId: 'drb_123',
    tenantId: 'library-a',
    generatedAt: 1770000000000,
    source: {
      authrimVersion: '0.1.10',
      issuer: 'https://library-a.example.org',
    },
    capabilities: {
      saml: true,
      oidc: false,
    },
    protocols: {
      saml: {
        issuer: 'https://library-a.example.org',
        idp: {
          entityId: 'https://library-a.example.org/saml/idp',
          ssoUrl: 'https://library-a.example.org/saml/idp/sso',
          sloUrl: 'https://library-a.example.org/saml/idp/slo',
          metadataCertificatePublication: 'active_next_backup',
          signingKeys: [
            {
              slot: 'active',
              keyRef: 'tenant:library-a:saml:idp:signing',
              kid: 'key-active',
              certificate: '-----BEGIN CERTIFICATE-----\nPUBLIC\n-----END CERTIFICATE-----',
              intendedUse: 'saml_signing',
            },
          ],
        },
        serviceProviders: [
          {
            entityId: 'https://publisher.example.test/saml/sp',
            acsUrl: 'https://publisher.example.test/saml/acs',
            sloUrl: 'https://publisher.example.test/saml/slo',
            sloResponseUrl: 'https://publisher.example.test/saml/slo/response',
            sloBinding: 'redirect',
            allowedBindings: ['post'],
            nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
            signAssertions: true,
            signResponses: true,
            authnRequestSignaturePolicy: 'required',
            logoutRequestSignaturePolicy: 'required',
            logoutResponseSignaturePolicy: 'required',
            logoutResponseBinding: 'post',
            attributeReleasePolicy: {
              attributes: [
                {
                  name: 'urn:oid:0.9.2342.19200300.100.1.3',
                  friendlyName: 'mail',
                  source: 'claim',
                  claim: 'email',
                  required: true,
                },
              ],
            },
          },
        ],
        pairwiseSubject: {
          enabled: true,
          algorithm: 'sha256-base64url',
          secretRef: 'tenant:library-a:saml:pairwise-nameid',
          rotationModel: 'active_previous',
          includesSecretValue: false,
        },
        excludedState: {
          transientNameIdMappings: true,
          authnRequests: true,
          logoutRequests: true,
        },
      },
    },
    exclusions: {
      activeSessions: true,
      privateSigningKeys: true,
      samlTransientState: true,
      oidcTokensAndCodes: true,
    },
  };
}
