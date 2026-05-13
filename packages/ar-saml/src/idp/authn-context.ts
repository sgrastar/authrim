import type { SAMLAuthnRequest } from '@authrim/ar-lib-core';
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
] as const;

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

export function resolveSAMLAuthnContextClassRef(authnRequest: SAMLAuthnRequest): string {
  const requested = authnRequest.requestedAuthnContext;
  if (!requested) {
    return DEFAULT_IDP_AUTHN_CONTEXT_CLASS_REF;
  }

  const requestedClassRefs = requested.authnContextClassRef ?? [];
  if (requestedClassRefs.length === 0) {
    return DEFAULT_IDP_AUTHN_CONTEXT_CLASS_REF;
  }

  for (const supported of SUPPORTED_IDP_AUTHN_CONTEXT_CLASS_REFS) {
    if (requestedClassRefs.includes(supported)) {
      return supported;
    }
  }

  throw new SAMLAuthnContextPolicyError(
    'Requested AuthnContext cannot be satisfied by Authrim IdP',
    requested
  );
}

function isRequestedAuthnContextComparison(
  value: string | null
): value is NonNullable<NonNullable<SAMLAuthnRequest['requestedAuthnContext']>['comparison']> {
  return value === 'exact' || value === 'minimum' || value === 'maximum' || value === 'better';
}
