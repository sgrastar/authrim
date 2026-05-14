/**
 * SAML SP Metadata Endpoint
 *
 * Returns SAML 2.0 SP metadata XML document.
 * GET /saml/sp/metadata
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createErrorResponse,
  AR_ERROR_CODES,
  buildIssuerUrl,
  getLogger,
} from '@authrim/ar-lib-core';
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
} from '../common/xml-utils';
import {
  getSAMLMetadataSigningCertificates,
  getSAMLSigningPolicy,
  type SAMLMetadataSigningCertificate,
} from '../common/saml-signing-keys';
import { resolveSAMLTenantIdFromContext } from '../common/tenant';
import {
  buildSAMLMetadataResponse,
  buildStableSAMLMetadataDescriptorId,
  SAML_METADATA_CACHE_DURATION,
} from '../common/metadata-cache';
import {
  getSAMLMetadataSigningMaterial,
  shouldSignSAMLMetadata,
  signSAMLMetadata,
} from '../common/metadata-signing';

/**
 * Handle SP metadata request
 */
export async function handleSPMetadata(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const log = getLogger(c).module('SAML-SP');
  const tenantId = resolveSAMLTenantIdFromContext(c);

  const issuerUrl = buildIssuerUrl(env, tenantId);
  const entityId = `${issuerUrl}/saml/sp`;

  // Get signing certificates from KeyManager / SAML rollover policy.
  let signingCertificates: SAMLMetadataSigningCertificate[];
  try {
    signingCertificates = await getSAMLMetadataSigningCertificates(env, {
      tenantId,
      role: 'sp',
    });
  } catch (error) {
    log.error('Failed to get signing certificate', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  // Build metadata XML
  let metadataXml = buildSPMetadata({
    entityId,
    issuerUrl,
    signingCertificates,
  });

  if (shouldSignSAMLMetadata(env)) {
    try {
      const signingMaterial = await getSAMLMetadataSigningMaterial(env, {
        tenantId,
        role: 'sp',
        policy: getSAMLSigningPolicy(),
      });
      metadataXml = signSAMLMetadata(metadataXml, signingMaterial);
    } catch (error) {
      log.error('Failed to sign SP metadata', {}, error as Error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  }

  // Return XML response
  return buildSAMLMetadataResponse(
    metadataXml,
    c.req.header('If-None-Match'),
    'authrim-saml-sp-metadata.xml'
  );
}

export interface SPMetadataOptions {
  entityId: string;
  issuerUrl: string;
  signingCertificates: SAMLMetadataSigningCertificate[];
  encryptionCertificates?: string[];
}

/**
 * Build SP metadata XML document
 */
export function buildSPMetadata(options: SPMetadataOptions): string {
  const { entityId, issuerUrl, signingCertificates, encryptionCertificates = [] } = options;

  const doc = createDocument();

  // Create root EntityDescriptor element
  const entityDescriptor = createElement(doc, SAML_NAMESPACES.MD, 'EntityDescriptor', 'md');
  setAttribute(entityDescriptor, 'entityID', entityId);
  setAttribute(entityDescriptor, 'ID', buildStableSAMLMetadataDescriptorId('sp', entityId));
  setAttribute(entityDescriptor, 'cacheDuration', SAML_METADATA_CACHE_DURATION);

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

  for (const signingCertificate of signingCertificates) {
    appendChild(spSsoDescriptor, buildSigningKeyDescriptor(doc, signingCertificate));
  }
  for (const encryptionCertificate of encryptionCertificates) {
    appendChild(spSsoDescriptor, buildEncryptionKeyDescriptor(doc, encryptionCertificate));
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
  setAttributeNS(orgName, SAML_NAMESPACES.XML, 'xml:lang', 'en');
  setTextContent(orgName, 'Authrim');
  appendChild(organization, orgName);

  const orgDisplayName = createElement(doc, SAML_NAMESPACES.MD, 'OrganizationDisplayName', 'md');
  setAttributeNS(orgDisplayName, SAML_NAMESPACES.XML, 'xml:lang', 'en');
  setTextContent(orgDisplayName, 'Authrim Service Provider');
  appendChild(organization, orgDisplayName);

  const orgUrl = createElement(doc, SAML_NAMESPACES.MD, 'OrganizationURL', 'md');
  setAttributeNS(orgUrl, SAML_NAMESPACES.XML, 'xml:lang', 'en');
  setTextContent(orgUrl, issuerUrl);
  appendChild(organization, orgUrl);

  appendChild(entityDescriptor, organization);

  // Append to document and serialize
  appendChild(doc, entityDescriptor);

  const xmlString = serializeXml(doc);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xmlString}`;
}

function buildSigningKeyDescriptor(
  doc: XMLDocument,
  signingCertificate: SAMLMetadataSigningCertificate
): Element {
  const keyDescriptor = createElement(doc, SAML_NAMESPACES.MD, 'KeyDescriptor', 'md');
  setAttribute(keyDescriptor, 'use', 'signing');
  appendChild(keyDescriptor, buildX509KeyInfo(doc, signingCertificate.certificate));

  return keyDescriptor;
}

function buildEncryptionKeyDescriptor(doc: XMLDocument, encryptionCertificate: string): Element {
  const keyDescriptor = createElement(doc, SAML_NAMESPACES.MD, 'KeyDescriptor', 'md');
  setAttribute(keyDescriptor, 'use', 'encryption');
  appendChild(keyDescriptor, buildX509KeyInfo(doc, encryptionCertificate));

  return keyDescriptor;
}

function buildX509KeyInfo(doc: XMLDocument, certificate: string): Element {
  const keyInfo = createElement(doc, SAML_NAMESPACES.DS, 'KeyInfo', 'ds');
  const x509Data = createElement(doc, SAML_NAMESPACES.DS, 'X509Data', 'ds');
  const x509Certificate = createElement(doc, SAML_NAMESPACES.DS, 'X509Certificate', 'ds');

  const cleanCert = certificate
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  setTextContent(x509Certificate, cleanCert);

  appendChild(x509Data, x509Certificate);
  appendChild(keyInfo, x509Data);

  return keyInfo;
}
