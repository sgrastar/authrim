/**
 * SAML IdP Metadata Endpoint
 *
 * Returns SAML 2.0 IdP metadata XML document conforming to SAML Metadata specification.
 * GET /saml/idp/metadata
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { createErrorResponse, AR_ERROR_CODES, getLogger } from '@authrim/ar-lib-core';
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
} from '../common/xml-utils';
import {
  getSAMLMetadataSigningCertificates,
  getSAMLSigningPolicy,
  type SAMLMetadataSigningCertificate,
} from '../common/saml-signing-keys';
import { resolveSAMLTenantIdFromContext } from '../common/tenant';
import {
  buildSAMLMetadataResponse,
  buildSAMLMetadataValidUntil,
  buildStableSAMLMetadataDescriptorId,
  SAML_METADATA_CACHE_DURATION,
} from '../common/metadata-cache';
import {
  getSAMLMetadataSigningMaterial,
  shouldSignSAMLMetadata,
  signSAMLMetadata,
} from '../common/metadata-signing';
import { getSAMLLocalEntityIds } from '../common/entity-id';

/**
 * Handle IdP metadata request
 */
export async function handleIdPMetadata(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const log = getLogger(c).module('SAML-IDP');
  const tenantId = resolveSAMLTenantIdFromContext(c);

  const { issuerUrl, idpEntityId: entityId } = await getSAMLLocalEntityIds(env, tenantId);

  // Get signing certificates from KeyManager / SAML rollover policy.
  let signingCertificates: SAMLMetadataSigningCertificate[];
  try {
    signingCertificates = await getSAMLMetadataSigningCertificates(env, {
      tenantId,
      role: 'idp',
    });
  } catch (error) {
    log.error('Failed to get signing certificate', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Build metadata XML
  let metadataXml = buildIdPMetadata({
    entityId,
    issuerUrl,
    signingCertificates,
  });

  if (shouldSignSAMLMetadata(env)) {
    try {
      const signingMaterial = await getSAMLMetadataSigningMaterial(env, {
        tenantId,
        role: 'idp',
        policy: getSAMLSigningPolicy(),
      });
      metadataXml = signSAMLMetadata(metadataXml, signingMaterial);
    } catch (error) {
      log.error('Failed to sign IdP metadata', {}, error as Error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  }

  // Return XML response
  return buildSAMLMetadataResponse(
    metadataXml,
    c.req.header('If-None-Match'),
    'authrim-saml-idp-metadata.xml'
  );
}

export interface IdPMetadataOptions {
  entityId: string;
  issuerUrl: string;
  signingCertificates: SAMLMetadataSigningCertificate[];
  validUntil?: string;
}

/**
 * Build IdP metadata XML document
 */
export function buildIdPMetadata(options: IdPMetadataOptions): string {
  const { entityId, issuerUrl, signingCertificates } = options;

  const doc = createDocument();

  // Create root EntityDescriptor element
  const entityDescriptor = createElement(doc, SAML_NAMESPACES.MD, 'EntityDescriptor', 'md');
  setAttribute(entityDescriptor, 'entityID', entityId);
  setAttribute(entityDescriptor, 'ID', buildStableSAMLMetadataDescriptorId('idp', entityId));
  setAttribute(entityDescriptor, 'cacheDuration', SAML_METADATA_CACHE_DURATION);
  setAttribute(entityDescriptor, 'validUntil', options.validUntil ?? buildSAMLMetadataValidUntil());

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

  for (const signingCertificate of signingCertificates) {
    appendChild(idpSsoDescriptor, buildSigningKeyDescriptor(doc, signingCertificate));
  }

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
  setAttributeNS(orgName, SAML_NAMESPACES.XML, 'xml:lang', 'en');
  setTextContent(orgName, 'Authrim');
  appendChild(organization, orgName);

  const orgDisplayName = createElement(doc, SAML_NAMESPACES.MD, 'OrganizationDisplayName', 'md');
  setAttributeNS(orgDisplayName, SAML_NAMESPACES.XML, 'xml:lang', 'en');
  setTextContent(orgDisplayName, 'Authrim Identity Provider');
  appendChild(organization, orgDisplayName);

  const orgUrl = createElement(doc, SAML_NAMESPACES.MD, 'OrganizationURL', 'md');
  setAttributeNS(orgUrl, SAML_NAMESPACES.XML, 'xml:lang', 'en');
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

function buildSigningKeyDescriptor(
  doc: XMLDocument,
  signingCertificate: SAMLMetadataSigningCertificate
): Element {
  const keyDescriptor = createElement(doc, SAML_NAMESPACES.MD, 'KeyDescriptor', 'md');
  setAttribute(keyDescriptor, 'use', 'signing');

  const keyInfo = createElement(doc, SAML_NAMESPACES.DS, 'KeyInfo', 'ds');
  const x509Data = createElement(doc, SAML_NAMESPACES.DS, 'X509Data', 'ds');
  const x509Certificate = createElement(doc, SAML_NAMESPACES.DS, 'X509Certificate', 'ds');

  const cleanCert = signingCertificate.certificate
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  setTextContent(x509Certificate, cleanCert);

  appendChild(x509Data, x509Certificate);
  appendChild(keyInfo, x509Data);
  appendChild(keyDescriptor, keyInfo);

  return keyDescriptor;
}
