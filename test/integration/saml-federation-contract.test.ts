import { describe, expect, it } from 'vitest';
import type { SAMLAuthnRequest, SAMLSPConfig } from '@authrim/ar-lib-core';
import { BINDING_URIS } from '../../packages/ar-saml/src/common/constants';
import { buildIdPMetadata } from '../../packages/ar-saml/src/idp/metadata';
import {
  buildIdPSLODestinationUrls,
  buildIdPSSODestinationUrls,
  isAllowedIdPSLODestination,
  isAllowedIdPSSODestination,
} from '../../packages/ar-saml/src/idp/shibboleth-compat';
import {
  InvalidSAMLResponseDestinationError,
  UnsupportedSAMLResponseBindingError,
  resolveSAMLResponseDestination,
  validateSAMLResponseProtocolBinding,
} from '../../packages/ar-saml/src/idp/response-destination';
import { buildSPMetadata } from '../../packages/ar-saml/src/sp/metadata';
import {
  buildSAMLRequestBindingClearCookie,
  buildSAMLRequestBindingCookie,
  hasSAMLRequestBrowserBinding,
} from '../../packages/ar-saml/src/sp/request-browser-binding';

const ISSUER = 'https://tenant.example';
const SP_ENTITY_ID = `${ISSUER}/saml/sp`;
const IDP_ENTITY_ID = `${ISSUER}/saml/idp`;
const PRIMARY_ACS = 'https://service.example/saml/acs';
const SECONDARY_ACS = 'https://service.example/saml/acs/mobile';
const REQUEST_ID = '_0123456789abcdef0123456789abcdef';
const PUBLIC_CERTIFICATE = [
  '-----BEGIN CERTIFICATE-----',
  'QXV0aHJpbS1mZWRlcmF0aW9uLXRlc3QtY2VydGlmaWNhdGU=',
  '-----END CERTIFICATE-----',
].join('\n');

const SP_CONFIG: SAMLSPConfig = {
  entityId: 'https://service.example/saml/metadata',
  acsUrl: PRIMARY_ACS,
  acsUrls: [SECONDARY_ACS],
  acsServices: [
    { index: 0, location: PRIMARY_ACS, binding: 'post', isDefault: true },
    { index: 7, location: SECONDARY_ACS, binding: 'post' },
  ],
};

function authnRequest(overrides: Partial<SAMLAuthnRequest> = {}): SAMLAuthnRequest {
  return {
    id: REQUEST_ID,
    issueInstant: '2026-08-15T00:00:00.000Z',
    issuer: SP_CONFIG.entityId,
    destination: `${ISSUER}/saml/idp/sso`,
    protocolBinding: BINDING_URIS.HTTP_POST,
    ...overrides,
  };
}

describe('SAML federation boundary contract', () => {
  it('publishes SP and IdP metadata whose native endpoints share the canonical issuer', () => {
    expect.hasAssertions();
    const signingCertificates = [{ slot: 'active' as const, certificate: PUBLIC_CERTIFICATE }];
    const spMetadata = buildSPMetadata({
      entityId: SP_ENTITY_ID,
      issuerUrl: ISSUER,
      signingCertificates,
      validUntil: '2026-08-16T00:00:00.000Z',
    });
    const idpMetadata = buildIdPMetadata({
      entityId: IDP_ENTITY_ID,
      issuerUrl: ISSUER,
      signingCertificates,
      validUntil: '2026-08-16T00:00:00.000Z',
    });

    expect(spMetadata).toContain(`entityID=\"${SP_ENTITY_ID}\"`);
    expect(spMetadata).toContain(`Location=\"${ISSUER}/saml/sp/acs\"`);
    expect(spMetadata).toContain(`Location=\"${ISSUER}/saml/sp/slo\"`);
    expect(idpMetadata).toContain(`entityID=\"${IDP_ENTITY_ID}\"`);
    expect(idpMetadata).toContain(`Location=\"${ISSUER}/saml/idp/sso\"`);
    expect(idpMetadata).toContain(`Location=\"${ISSUER}/saml/idp/slo\"`);
    expect(spMetadata).not.toContain('BEGIN CERTIFICATE');
    expect(idpMetadata).not.toContain('BEGIN CERTIFICATE');
  });

  it.each([
    ['native POST SSO', `${ISSUER}/saml/idp/sso`],
    ['GakuNin POST SSO', `${ISSUER}/idp/profile/SAML2/POST/SSO`],
    ['Shibboleth Redirect SSO', `${ISSUER}/idp/profile/SAML2/Redirect/SSO`],
  ])('accepts the %s destination for the same federation issuer', (_label, destination) => {
    expect.hasAssertions();
    expect(buildIdPSSODestinationUrls(ISSUER)).toContain(destination);
    expect(isAllowedIdPSSODestination(destination, ISSUER)).toBe(true);
  });

  it.each([
    ['native POST SLO', `${ISSUER}/saml/idp/slo`],
    ['GakuNin POST SLO', `${ISSUER}/idp/profile/SAML2/POST/SLO`],
    ['Shibboleth Redirect SLO', `${ISSUER}/idp/profile/SAML2/Redirect/SLO`],
  ])('accepts the %s destination for the same federation issuer', (_label, destination) => {
    expect.hasAssertions();
    expect(buildIdPSLODestinationUrls(`${ISSUER}/`)).toContain(destination);
    expect(isAllowedIdPSLODestination(destination, ISSUER)).toBe(true);
  });

  it.each([
    ['different origin', 'https://attacker.example/saml/idp/sso'],
    ['issuer prefix attack', 'https://tenant.example.attacker.test/saml/idp/sso'],
    ['path suffix attack', `${ISSUER}/saml/idp/sso/continue`],
  ])('rejects an SSO destination with a %s', (_label, destination) => {
    expect.hasAssertions();
    expect(isAllowedIdPSSODestination(destination, ISSUER)).toBe(false);
  });

  it('selects registered default, explicit, and indexed ACS destinations', () => {
    expect.hasAssertions();
    expect(resolveSAMLResponseDestination(authnRequest(), SP_CONFIG)).toBe(PRIMARY_ACS);
    expect(
      resolveSAMLResponseDestination(
        authnRequest({ assertionConsumerServiceURL: SECONDARY_ACS }),
        SP_CONFIG
      )
    ).toBe(SECONDARY_ACS);
    expect(
      resolveSAMLResponseDestination(authnRequest({ assertionConsumerServiceIndex: 7 }), SP_CONFIG)
    ).toBe(SECONDARY_ACS);
  });

  it.each([
    ['unregistered URL', { assertionConsumerServiceURL: 'https://attacker.example/collect' }],
    ['unknown index', { assertionConsumerServiceIndex: 99 }],
  ])('fails closed for an %s', (_label, overrides) => {
    expect.hasAssertions();
    expect(() => resolveSAMLResponseDestination(authnRequest(overrides), SP_CONFIG)).toThrow(
      InvalidSAMLResponseDestinationError
    );
  });

  it('allows only HTTP-POST as the SAML response binding', () => {
    expect.hasAssertions();
    expect(() => validateSAMLResponseProtocolBinding(authnRequest())).not.toThrow();
    expect(() =>
      validateSAMLResponseProtocolBinding(
        authnRequest({ protocolBinding: BINDING_URIS.HTTP_REDIRECT })
      )
    ).toThrow(UnsupportedSAMLResponseBindingError);
  });

  it('binds the browser round trip to the exact AuthnRequest ID', () => {
    expect.hasAssertions();
    const cookie = buildSAMLRequestBindingCookie(REQUEST_ID);
    const otherRequestId = '_ffffffffffffffffffffffffffffffff';

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=None');
    expect(hasSAMLRequestBrowserBinding(cookie, REQUEST_ID)).toBe(true);
    expect(hasSAMLRequestBrowserBinding(cookie, otherRequestId)).toBe(false);
    expect(hasSAMLRequestBrowserBinding(cookie, `${REQUEST_ID}suffix`)).toBe(false);
    expect(buildSAMLRequestBindingClearCookie(REQUEST_ID)).toContain('Max-Age=0');
  });
});
