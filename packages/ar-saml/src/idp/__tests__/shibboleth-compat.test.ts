import { describe, expect, it } from 'vitest';
import {
  buildIdPSLODestinationUrls,
  buildIdPSSODestinationUrls,
  GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_POST_PATH,
  GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_REDIRECT_PATH,
  GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_POST_PATH,
  GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_REDIRECT_PATH,
  isAllowedIdPSLODestination,
  isAllowedIdPSSODestination,
} from '../shibboleth-compat';

describe('GakuNin/Shibboleth SAML2 IdP compatibility endpoints', () => {
  const issuerUrl = 'https://conformance.authrim.com';

  it('allows canonical and Shibboleth-style SAML2 SSO destinations', () => {
    expect(buildIdPSSODestinationUrls(`${issuerUrl}/`)).toEqual([
      `${issuerUrl}/saml/idp/sso`,
      `${issuerUrl}${GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_POST_PATH}`,
      `${issuerUrl}${GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_REDIRECT_PATH}`,
    ]);

    expect(isAllowedIdPSSODestination(`${issuerUrl}/saml/idp/sso`, issuerUrl)).toBe(true);
    expect(
      isAllowedIdPSSODestination(
        `${issuerUrl}${GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_POST_PATH}`,
        issuerUrl
      )
    ).toBe(true);
    expect(
      isAllowedIdPSSODestination(
        `${issuerUrl}${GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_REDIRECT_PATH}`,
        issuerUrl
      )
    ).toBe(true);
  });

  it('allows canonical and Shibboleth-style SAML2 SLO destinations', () => {
    expect(buildIdPSLODestinationUrls(`${issuerUrl}/`)).toEqual([
      `${issuerUrl}/saml/idp/slo`,
      `${issuerUrl}${GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_POST_PATH}`,
      `${issuerUrl}${GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_REDIRECT_PATH}`,
    ]);

    expect(isAllowedIdPSLODestination(`${issuerUrl}/saml/idp/slo`, issuerUrl)).toBe(true);
    expect(
      isAllowedIdPSLODestination(
        `${issuerUrl}${GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_POST_PATH}`,
        issuerUrl
      )
    ).toBe(true);
    expect(
      isAllowedIdPSLODestination(
        `${issuerUrl}${GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_REDIRECT_PATH}`,
        issuerUrl
      )
    ).toBe(true);
  });

  it('does not allow Shibboleth 1.0 profile destinations', () => {
    expect(isAllowedIdPSSODestination(`${issuerUrl}/idp/profile/Shibboleth/SSO`, issuerUrl)).toBe(
      false
    );
  });
});
