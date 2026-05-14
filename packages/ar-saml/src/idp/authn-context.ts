import type { SAMLAuthnRequest, SAMLSPConfig } from '@authrim/ar-lib-core';
import { AUTHN_CONTEXT, SAML_NAMESPACES } from '../common/constants';
import {
  findElement,
  findElements,
  getAttribute,
  getTextContent,
  type XMLElement,
} from '../common/xml-utils';

export const DEFAULT_IDP_AUTHN_CONTEXT_CLASS_REF = AUTHN_CONTEXT.PASSWORD_PROTECTED_TRANSPORT;

export const SUPPORTED_IDP_AUTHN_CONTEXT_CLASS_REFS = [
  AUTHN_CONTEXT.PASSWORD_PROTECTED_TRANSPORT,
  AUTHN_CONTEXT.PASSWORD,
  AUTHN_CONTEXT.AUTHRIM_PHISHING_RESISTANT,
] as const;

export interface SAMLAuthnContextSessionInfo {
  acr?: string;
  amr?: string[];
}

export interface SAMLAuthnContextResolutionOptions {
  spConfig?: Pick<
    SAMLSPConfig,
    'authnContextClassRefMode' | 'defaultAuthnContextClassRef' | 'passkeyAuthnContextClassRef'
  >;
  session?: SAMLAuthnContextSessionInfo;
}

export class SAMLAuthnContextPolicyError extends Error {
  constructor(
    message: string,
    readonly requestedAuthnContext: NonNullable<SAMLAuthnRequest['requestedAuthnContext']>
  ) {
    super(message);
    this.name = 'SAMLAuthnContextPolicyError';
  }
}

export function parseRequestedAuthnContext(
  authnRequestElement: XMLElement
): SAMLAuthnRequest['requestedAuthnContext'] {
  const requestedAuthnContextElement = findElement(
    authnRequestElement,
    SAML_NAMESPACES.SAML2P,
    'RequestedAuthnContext'
  );
  if (!requestedAuthnContextElement) {
    return undefined;
  }

  const comparison = getAttribute(requestedAuthnContextElement, 'Comparison');
  const classRefs = findElements(
    requestedAuthnContextElement,
    SAML_NAMESPACES.SAML2,
    'AuthnContextClassRef'
  )
    .map((element) => getTextContent(element)?.trim())
    .filter((value): value is string => Boolean(value));

  return {
    comparison: isRequestedAuthnContextComparison(comparison) ? comparison : undefined,
    authnContextClassRef: classRefs.length > 0 ? classRefs : undefined,
  };
}

export function resolveSAMLAuthnContextClassRef(
  authnRequest: SAMLAuthnRequest,
  options: SAMLAuthnContextResolutionOptions = {}
): string {
  const requested = authnRequest.requestedAuthnContext;
  if (!requested) {
    return resolveDefaultAuthnContextClassRef(options);
  }

  const requestedClassRefs = requested.authnContextClassRef ?? [];
  if (requestedClassRefs.length === 0) {
    return resolveDefaultAuthnContextClassRef(options);
  }

  for (const supported of getSupportedAuthnContextClassRefs(options)) {
    if (requestedClassRefs.includes(supported)) {
      return supported;
    }
  }

  throw new SAMLAuthnContextPolicyError(
    'Requested AuthnContext cannot be satisfied by Authrim IdP',
    requested
  );
}

function resolveDefaultAuthnContextClassRef(options: SAMLAuthnContextResolutionOptions): string {
  const configuredDefault =
    options.spConfig?.defaultAuthnContextClassRef || DEFAULT_IDP_AUTHN_CONTEXT_CLASS_REF;

  if (options.spConfig?.authnContextClassRefMode !== 'session') {
    return configuredDefault;
  }

  const amr = options.session?.amr ?? [];
  if (amr.includes('passkey') || options.session?.acr === AUTHN_CONTEXT.AUTHRIM_PHISHING_RESISTANT) {
    return options.spConfig.passkeyAuthnContextClassRef || AUTHN_CONTEXT.AUTHRIM_PHISHING_RESISTANT;
  }

  return options.session?.acr || configuredDefault;
}

function getSupportedAuthnContextClassRefs(
  options: SAMLAuthnContextResolutionOptions
): string[] {
  return Array.from(
    new Set([
      ...SUPPORTED_IDP_AUTHN_CONTEXT_CLASS_REFS,
      options.spConfig?.defaultAuthnContextClassRef,
      options.spConfig?.passkeyAuthnContextClassRef,
    ].filter(isString))
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRequestedAuthnContextComparison(
  value: string | null
): value is NonNullable<NonNullable<SAMLAuthnRequest['requestedAuthnContext']>['comparison']> {
  return value === 'exact' || value === 'minimum' || value === 'maximum' || value === 'better';
}
