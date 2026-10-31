import { describe, expect, it } from 'vitest';
import { isSamlProtocolPath } from '../saml-enabled';

describe('isSamlProtocolPath', () => {
  it.each([
    '/saml/idp/metadata',
    '/saml/idp/sso',
    '/saml/idp/init',
    '/saml/idp/slo',
    '/saml/idp/attribute-release-consent',
    '/saml/sp/metadata',
    '/saml/sp/login',
    '/saml/sp/acs',
    '/saml/sp/slo',
    '/saml/metadata',
    '/saml/anything/else',
    '/idp/profile/SAML2/POST/SSO',
    '/idp/profile/SAML2/Redirect/SSO',
    '/idp/profile/SAML2/POST/SLO',
    '/idp/profile/SAML2/Redirect/SLO',
  ])('covers %s', (path) => {
    expect(isSamlProtocolPath(path)).toBe(true);
  });

  it.each([
    '/saml/idp/sso/',
    '/saml/idp/sso//',
    '//saml//idp//sso',
    '/SAML/IDP/SSO',
    '/Saml/Sp/Acs/',
    '/saml/./idp/sso',
    '/saml/sp/../idp/sso',
    '/saml/%69dp/sso',
    '/saml/idp%2Fsso',
    '/idp/profile/saml2/post/sso/',
    '/IDP/PROFILE/SAML2/POST/SSO',
    '/saml',
    '/saml/',
  ])('covers the variant %s', (path) => {
    expect(isSamlProtocolPath(path)).toBe(true);
  });

  it.each([
    '/saml/health',
    '/saml/health/',
    '/SAML/Health',
    '//saml/health',
    '/api/admin/saml-providers',
    '/api/admin/saml-settings',
    '/api/admin/saml-metadata/preview',
    '/api/health',
    '/health/ready',
    '/authorize',
    '/samlx/idp/sso',
    '/idp/profile/other',
    '/',
  ])('leaves %s alone', (path) => {
    expect(isSamlProtocolPath(path)).toBe(false);
  });
});
