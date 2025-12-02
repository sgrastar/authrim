/**
 * SAML IdP Metadata Endpoint
 *
 * Returns SAML 2.0 IdP metadata XML document conforming to SAML Metadata specification.
 * GET /saml/idp/metadata
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import {
  SAML_NAMESPACES,
  BINDING_URIS,
  NAMEID_FORMATS,
  SIGNATURE_ALGORITHMS,
} from '../common/constants';
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
 * Handle IdP metadata request
 */
export async function handleIdPMetadata(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  // Get issuer URL from environment
  const issuerUrl = env.ISSUER_URL || 'https://conformance.authrim.com';
  const entityId = `${issuerUrl}/saml/idp`;

  // Get signing certificate from KeyManager
  let signingCertificate: string;
  try {
    signingCertificate = await getSigningCertificate(env);
  } catch (error) {
    console.error('Failed to get signing certificate:', error);
    return c.json({ error: 'Failed to generate metadata' }, 500);
  }

  // Build metadata XML
  const metadataXml = buildIdPMetadata({
    entityId,
    issuerUrl,
    signingCertificate,
  });

  // Return XML response
  return new Response(metadataXml, {
    headers: {
      'Content-Type': 'application/samlmetadata+xml',
      'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
    },
  });
}

interface IdPMetadataOptions {
  entityId: string;
  issuerUrl: string;
  signingCertificate: string;
}

/**
 * Build IdP metadata XML document
 */
function buildIdPMetadata(options: IdPMetadataOptions): string {
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

  // Create IDPSSODescriptor
  const idpSsoDescriptor = createElement(doc, SAML_NAMESPACES.MD, 'IDPSSODescriptor', 'md');
  setAttribute(
    idpSsoDescriptor,
    'protocolSupportEnumeration',
    'urn:oasis:names:tc:SAML:2.0:protocol'
  );
  setAttribute(idpSsoDescriptor, 'WantAuthnRequestsSigned', 'false');

  // Add KeyDescriptor for signing
  const keyDescriptor = createElement(doc, SAML_NAMESPACES.MD, 'KeyDescriptor', 'md');
  setAttribute(keyDescriptor, 'use', 'signing');

  const keyInfo = createElement(doc, SAML_NAMESPACES.DS, 'KeyInfo', 'ds');
  const x509Data = createElement(doc, SAML_NAMESPACES.DS, 'X509Data', 'ds');
  const x509Certificate = createElement(doc, SAML_NAMESPACES.DS, 'X509Certificate', 'ds');

  // Clean certificate (remove headers and whitespace)
  const cleanCert = signingCertificate
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  setTextContent(x509Certificate, cleanCert);

  appendChild(x509Data, x509Certificate);
  appendChild(keyInfo, x509Data);
  appendChild(keyDescriptor, keyInfo);
  appendChild(idpSsoDescriptor, keyDescriptor);

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
    appendChild(idpSsoDescriptor, nameIdFormat);
  }

  // Add SingleSignOnService endpoints

  // HTTP-POST Binding
  const ssoPost = createElement(doc, SAML_NAMESPACES.MD, 'SingleSignOnService', 'md');
  setAttribute(ssoPost, 'Binding', BINDING_URIS.HTTP_POST);
  setAttribute(ssoPost, 'Location', `${issuerUrl}/saml/idp/sso`);
  appendChild(idpSsoDescriptor, ssoPost);

  // HTTP-Redirect Binding
  const ssoRedirect = createElement(doc, SAML_NAMESPACES.MD, 'SingleSignOnService', 'md');
  setAttribute(ssoRedirect, 'Binding', BINDING_URIS.HTTP_REDIRECT);
  setAttribute(ssoRedirect, 'Location', `${issuerUrl}/saml/idp/sso`);
  appendChild(idpSsoDescriptor, ssoRedirect);

  // Add SingleLogoutService endpoints

  // HTTP-POST Binding for SLO
  const sloPost = createElement(doc, SAML_NAMESPACES.MD, 'SingleLogoutService', 'md');
  setAttribute(sloPost, 'Binding', BINDING_URIS.HTTP_POST);
  setAttribute(sloPost, 'Location', `${issuerUrl}/saml/idp/slo`);
  appendChild(idpSsoDescriptor, sloPost);

  // HTTP-Redirect Binding for SLO
  const sloRedirect = createElement(doc, SAML_NAMESPACES.MD, 'SingleLogoutService', 'md');
  setAttribute(sloRedirect, 'Binding', BINDING_URIS.HTTP_REDIRECT);
  setAttribute(sloRedirect, 'Location', `${issuerUrl}/saml/idp/slo`);
  appendChild(idpSsoDescriptor, sloRedirect);

  appendChild(entityDescriptor, idpSsoDescriptor);

  // Add Organization (optional but recommended)
  const organization = createElement(doc, SAML_NAMESPACES.MD, 'Organization', 'md');

  const orgName = createElement(doc, SAML_NAMESPACES.MD, 'OrganizationName', 'md');
  setAttributeNS(orgName, SAML_NAMESPACES.XS_INSTANCE, 'xml:lang', 'en');
  setTextContent(orgName, 'Authrim');
  appendChild(organization, orgName);

  const orgDisplayName = createElement(doc, SAML_NAMESPACES.MD, 'OrganizationDisplayName', 'md');
  setAttributeNS(orgDisplayName, SAML_NAMESPACES.XS_INSTANCE, 'xml:lang', 'en');
  setTextContent(orgDisplayName, 'Authrim Identity Provider');
  appendChild(organization, orgDisplayName);

  const orgUrl = createElement(doc, SAML_NAMESPACES.MD, 'OrganizationURL', 'md');
  setAttributeNS(orgUrl, SAML_NAMESPACES.XS_INSTANCE, 'xml:lang', 'en');
  setTextContent(orgUrl, issuerUrl);
  appendChild(organization, orgUrl);

  appendChild(entityDescriptor, organization);

  // Add ContactPerson (optional but recommended)
  const contactPerson = createElement(doc, SAML_NAMESPACES.MD, 'ContactPerson', 'md');
  setAttribute(contactPerson, 'contactType', 'technical');

  const company = createElement(doc, SAML_NAMESPACES.MD, 'Company', 'md');
  setTextContent(company, 'Authrim');
  appendChild(contactPerson, company);

  const emailAddress = createElement(doc, SAML_NAMESPACES.MD, 'EmailAddress', 'md');
  setTextContent(emailAddress, 'support@authrim.com');
  appendChild(contactPerson, emailAddress);

  appendChild(entityDescriptor, contactPerson);

  // Append the EntityDescriptor to the document
  appendChild(doc, entityDescriptor);

  // Serialize to string
  const xmlString = serializeXml(doc);

  // Add XML declaration
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xmlString}`;
}
