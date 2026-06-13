export const GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_POST_PATH = '/idp/profile/SAML2/POST/SSO';
export const GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_REDIRECT_PATH = '/idp/profile/SAML2/Redirect/SSO';
export const GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_POST_PATH = '/idp/profile/SAML2/POST/SLO';
export const GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_REDIRECT_PATH = '/idp/profile/SAML2/Redirect/SLO';

export function buildIdPSSODestinationUrls(issuerUrl: string): string[] {
  return buildDestinationUrls(issuerUrl, [
    '/saml/idp/sso',
    GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_POST_PATH,
    GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_REDIRECT_PATH,
  ]);
}

export function buildIdPSLODestinationUrls(issuerUrl: string): string[] {
  return buildDestinationUrls(issuerUrl, [
    '/saml/idp/slo',
    GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_POST_PATH,
    GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_REDIRECT_PATH,
  ]);
}

export function isAllowedIdPSSODestination(destination: string, issuerUrl: string): boolean {
  return buildIdPSSODestinationUrls(issuerUrl).includes(destination);
}

export function isAllowedIdPSLODestination(destination: string, issuerUrl: string): boolean {
  return buildIdPSLODestinationUrls(issuerUrl).includes(destination);
}

function buildDestinationUrls(issuerUrl: string, paths: string[]): string[] {
  const base = issuerUrl.endsWith('/') ? issuerUrl.slice(0, -1) : issuerUrl;
  return paths.map((path) => `${base}${path}`);
}
