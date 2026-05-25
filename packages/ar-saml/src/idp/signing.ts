import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import { SAML_NAMESPACES } from '../common/constants';
import { findDirectChildElement, getAttribute, parseXml } from '../common/xml-utils';
import { signXml, type SignOptions } from '../common/signature';

export interface SAMLSigningMaterial {
  privateKeyPem: string;
  certificate: string;
}

type XmlSigner = (xml: string, options: SignOptions) => string;

function issuerInsertionXPath(id: string): string {
  return `//*[@ID='${id}']/*[local-name()='Issuer' and namespace-uri()='${SAML_NAMESPACES.SAML2}'][1]`;
}

/**
 * Apply SP-specific IdP signing policy.
 *
 * If both Assertion and Response need signatures, sign the Assertion first and
 * then the Response. Signing the Response first would be invalidated by adding
 * an Assertion signature afterwards.
 */
export function applySAMLResponseSigningPolicy(
  xml: string,
  spConfig: Pick<SAMLSPConfig, 'signAssertions' | 'signResponses'>,
  signingMaterial: SAMLSigningMaterial,
  signer: XmlSigner = signXml
): string {
  if (!spConfig.signAssertions && !spConfig.signResponses) {
    return xml;
  }

  const ids = extractSAMLResponseIds(xml);
  let signedXml = xml;

  if (spConfig.signAssertions) {
    if (!ids.assertionId) {
      throw new Error('Cannot sign SAML Assertion: missing Assertion ID');
    }
    signedXml = signer(signedXml, {
      privateKey: signingMaterial.privateKeyPem,
      certificate: signingMaterial.certificate,
      referenceUri: `#${ids.assertionId}`,
      signatureLocation: 'after',
      signatureInsertionXPath: issuerInsertionXPath(ids.assertionId),
      includeKeyInfo: true,
    });
  }

  if (spConfig.signResponses) {
    signedXml = signer(signedXml, {
      privateKey: signingMaterial.privateKeyPem,
      certificate: signingMaterial.certificate,
      referenceUri: `#${ids.responseId}`,
      signatureLocation: 'after',
      signatureInsertionXPath: issuerInsertionXPath(ids.responseId),
      includeKeyInfo: true,
    });
  }

  return signedXml;
}

export function applySAMLErrorResponseSigningPolicy(
  xml: string,
  spConfig: Pick<SAMLSPConfig, 'signAssertions' | 'signResponses'>,
  signingMaterial: SAMLSigningMaterial,
  signer: XmlSigner = signXml
): string {
  if (!spConfig.signAssertions && !spConfig.signResponses) {
    return xml;
  }

  const ids = extractSAMLResponseIds(xml);
  return signer(xml, {
    privateKey: signingMaterial.privateKeyPem,
    certificate: signingMaterial.certificate,
    referenceUri: `#${ids.responseId}`,
    signatureLocation: 'after',
    signatureInsertionXPath: issuerInsertionXPath(ids.responseId),
    includeKeyInfo: true,
  });
}

export function extractSAMLResponseIds(xml: string): { responseId: string; assertionId?: string } {
  const doc = parseXml(xml);
  const responseElement = doc.documentElement;
  if (
    !responseElement ||
    responseElement.namespaceURI !== SAML_NAMESPACES.SAML2P ||
    responseElement.localName !== 'Response'
  ) {
    throw new Error('Cannot sign SAML Response: missing Response element');
  }

  const responseId = getAttribute(responseElement, 'ID');
  if (!responseId) {
    throw new Error('Cannot sign SAML Response: missing Response ID');
  }

  const assertionElement = findDirectChildElement(
    responseElement,
    SAML_NAMESPACES.SAML2,
    'Assertion'
  );
  const assertionId = assertionElement
    ? getAttribute(assertionElement, 'ID') || undefined
    : undefined;

  return { responseId, assertionId };
}

export function extractSAMLProtocolMessageId(
  xml: string,
  localName: 'LogoutRequest' | 'LogoutResponse'
): string {
  const doc = parseXml(xml);
  const element = doc.documentElement;
  if (
    !element ||
    element.namespaceURI !== SAML_NAMESPACES.SAML2P ||
    element.localName !== localName
  ) {
    throw new Error(`Cannot sign SAML ${localName}: missing ${localName} element`);
  }

  const id = getAttribute(element, 'ID');
  if (!id) {
    throw new Error(`Cannot sign SAML ${localName}: missing ID`);
  }

  return id;
}
