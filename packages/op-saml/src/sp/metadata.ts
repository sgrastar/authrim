/**
 * SAML SP Metadata Endpoint
 *
 * Returns SAML 2.0 SP metadata XML document.
 * GET /saml/sp/metadata
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import { SAML_NAMESPACES, BINDING_URIS, NAMEID_FORMATS } from '../common/constants';
import {
  createDocument,
  createElement,
  setAttribute,
  setAttributeNS,
  setTextContent,
  appendChild,
  addNamespaceDeclarations,
  serializeXml,
  generateSAMLId,
} from '../common/xml-utils';
import { getSigningCertificate } from '../common/key-utils';

/**
 * Handle SP metadata request
 */
export async function handleSPMetadata(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  // Get issuer URL from environment
  const issuerUrl = env.ISSUER_URL || 'https://conformance.authrim.com';
  const entityId = `${issuerUrl}/saml/sp`;

  // Get signing certificate
  let signingCertificate: string;
  try {
    signingCertificate = await getSigningCertificate(env);
  } catch (error) {
    console.error('Failed to get signing certificate:', error);
    return c.json({ error: 'Failed to generate metadata' }, 500);
  }

  // Build metadata XML
  const metadataXml = buildSPMetadata({
    entityId,
    issuerUrl,
    signingCertificate,
  });

  // Return XML response
  return new Response(metadataXml, {
    headers: {
      'Content-Type': 'application/samlmetadata+xml',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

interface SPMetadataOptions {
  entityId: string;
  issuerUrl: string;
  signingCertificate: string;
}

/**
 * Build SP metadata XML document
 */
function buildSPMetadata(options: SPMetadataOptions): string {
  const { entityId, issuerUrl, signingCertificate } = options;

  const doc = createDocument();

  // Create root EntityDescriptor element
  const entityDescriptor = createElement(doc, SAML_NAMESPACES.MD, 'EntityDescriptor', 'md');
  setAttribute(entityDescriptor, 'entityID', entityId);
  setAttribute(entityDescriptor, 'ID', generateSAMLId());

  // Add namespace declarations
  addNamespaceDeclarations(entityDescriptor, {
    md: SAML_NAMESPACES.MD,
    ds: SAML_NAMESPACES.DS,
    saml: SAML_NAMESPACES.SAML2,
  });

  // Create SPSSODescriptor
  const spSsoDescriptor = createElement(doc, SAML_NAMESPACES.MD, 'SPSSODescriptor', 'md');
  setAttribute(
    spSsoDescriptor,
    'protocolSupportEnumeration',
    'urn:oasis:names:tc:SAML:2.0:protocol'
  );
  setAttribute(spSsoDescriptor, 'AuthnRequestsSigned', 'true');
  setAttribute(spSsoDescriptor, 'WantAssertionsSigned', 'true');

  // Add KeyDescriptor for signing
  const keyDescriptor = createElement(doc, SAML_NAMESPACES.MD, 'KeyDescriptor', 'md');
  setAttribute(keyDescriptor, 'use', 'signing');

  const keyInfo = createElement(doc, SAML_NAMESPACES.DS, 'KeyInfo', 'ds');
  const x509Data = createElement(doc, SAML_NAMESPACES.DS, 'X509Data', 'ds');
  const x509Certificate = createElement(doc, SAML_NAMESPACES.DS, 'X509Certificate', 'ds');

  // Clean certificate
  const cleanCert = signingCertificate
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  setTextContent(x509Certificate, cleanCert);

  appendChild(x509Data, x509Certificate);
  appendChild(keyInfo, x509Data);
  appendChild(keyDescriptor, keyInfo);
  appendChild(spSsoDescriptor, keyDescriptor);

  // Add NameIDFormat elements
  const supportedFormats = [
    NAMEID_FORMATS.EMAIL,
    NAMEID_FORMATS.PERSISTENT,
    NAMEID_FORMATS.TRANSIENT,
    NAMEID_FORMATS.UNSPECIFIED,
  ];

  for (const format of supportedFormats) {
    const nameIdFormat = createElement(doc, SAML_NAMESPACES.MD, 'NameIDFormat', 'md');
    setTextContent(nameIdFormat, format);
    appendChild(spSsoDescriptor, nameIdFormat);
  }

  // Add AssertionConsumerService endpoints

  // HTTP-POST Binding (default)
  const acsPost = createElement(doc, SAML_NAMESPACES.MD, 'AssertionConsumerService', 'md');
  setAttribute(acsPost, 'Binding', BINDING_URIS.HTTP_POST);
  setAttribute(acsPost, 'Location', `${issuerUrl}/saml/sp/acs`);
  setAttribute(acsPost, 'index', '0');
  setAttribute(acsPost, 'isDefault', 'true');
  appendChild(spSsoDescriptor, acsPost);

  // Add SingleLogoutService endpoints

  // HTTP-POST Binding for SLO
  const sloPost = createElement(doc, SAML_NAMESPACES.MD, 'SingleLogoutService', 'md');
  setAttribute(sloPost, 'Binding', BINDING_URIS.HTTP_POST);
  setAttribute(sloPost, 'Location', `${issuerUrl}/saml/sp/slo`);
  appendChild(spSsoDescriptor, sloPost);

  // HTTP-Redirect Binding for SLO
  const sloRedirect = createElement(doc, SAML_NAMESPACES.MD, 'SingleLogoutService', 'md');
  setAttribute(sloRedirect, 'Binding', BINDING_URIS.HTTP_REDIRECT);
  setAttribute(sloRedirect, 'Location', `${issuerUrl}/saml/sp/slo`);
  appendChild(spSsoDescriptor, sloRedirect);

  appendChild(entityDescriptor, spSsoDescriptor);

  // Add Organization
  const organization = createElement(doc, SAML_NAMESPACES.MD, 'Organization', 'md');

  const orgName = createElement(doc, SAML_NAMESPACES.MD, 'OrganizationName', 'md');
  setAttributeNS(orgName, SAML_NAMESPACES.XS_INSTANCE, 'xml:lang', 'en');
  setTextContent(orgName, 'Authrim');
  appendChild(organization, orgName);

  const orgDisplayName = createElement(doc, SAML_NAMESPACES.MD, 'OrganizationDisplayName', 'md');
  setAttributeNS(orgDisplayName, SAML_NAMESPACES.XS_INSTANCE, 'xml:lang', 'en');
  setTextContent(orgDisplayName, 'Authrim Service Provider');
  appendChild(organization, orgDisplayName);

  const orgUrl = createElement(doc, SAML_NAMESPACES.MD, 'OrganizationURL', 'md');
  setAttributeNS(orgUrl, SAML_NAMESPACES.XS_INSTANCE, 'xml:lang', 'en');
  setTextContent(orgUrl, issuerUrl);
  appendChild(organization, orgUrl);

  appendChild(entityDescriptor, organization);

  // Append to document and serialize
  appendChild(doc, entityDescriptor);

  const xmlString = serializeXml(doc);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xmlString}`;
}
