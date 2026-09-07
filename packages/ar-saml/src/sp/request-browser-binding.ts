import { DEFAULTS } from '../common/constants';

const SAML_REQUEST_BINDING_COOKIE_PREFIX = '__Host-authrim_saml_request_';
const AUTHRIM_SAML_REQUEST_ID_PATTERN = /^_[0-9a-f]{32}$/;

function getSAMLRequestBindingCookieName(requestId: string): string {
  if (!AUTHRIM_SAML_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid Authrim SAML request ID for browser binding');
  }
  return `${SAML_REQUEST_BINDING_COOKIE_PREFIX}${requestId}`;
}

export function buildSAMLRequestBindingCookie(requestId: string): string {
  const name = getSAMLRequestBindingCookieName(requestId);
  return `${name}=1; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${DEFAULTS.REQUEST_VALIDITY_SECONDS}`;
}

export function buildSAMLRequestBindingClearCookie(requestId: string): string {
  const name = getSAMLRequestBindingCookieName(requestId);
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
}

export function hasSAMLRequestBrowserBinding(
  cookieHeader: string | undefined,
  requestId: string
): boolean {
  if (!cookieHeader) {
    return false;
  }

  let name: string;
  try {
    name = getSAMLRequestBindingCookieName(requestId);
  } catch {
    return false;
  }

  return cookieHeader.split(';').some((cookie) => cookie.trim() === `${name}=1`);
}
