import type {
  Env,
  SAMLFederationTrustProfile,
  SAMLMetadataEntityRole,
  SAMLMetadataEntitySummary,
  SAMLMetadataVerificationPolicy,
  SAMLMetadataVerificationSummary,
} from '@authrim/ar-lib-core';
import { SignedXml } from 'xml-crypto';
import {
  parseXml,
  serializeXml,
  findElement,
  findElements,
  getAttribute,
  getTextContent,
} from '../common/xml-utils';
import { SAML_NAMESPACES, SIGNATURE_ALGORITHMS } from '../common/constants';
import type { SignedXmlWithErrors } from '../common/types';
import { SAMLMetadataValidationError } from './errors';

export const SINGLE_METADATA_FETCH_LIMIT_BYTES = 1024 * 1024;
export const AGGREGATE_METADATA_FETCH_LIMIT_BYTES = 10 * 1024 * 1024;

export interface ParsedAggregateMetadata {
  metadataXml: string;
  rootId: string;
  validUntil?: string;
  entities: SAMLMetadataEntitySummary[];
}

export function isAggregateMetadata(xml: string): boolean {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  return root?.namespaceURI === SAML_NAMESPACES.MD && root.localName === 'EntitiesDescriptor';
}

export function parseAggregateMetadata(xml: string): ParsedAggregateMetadata {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (
    !root ||
    root.namespaceURI !== SAML_NAMESPACES.MD ||
    root.localName !== 'EntitiesDescriptor'
  ) {
    throw new SAMLMetadataValidationError('Invalid aggregate metadata: missing EntitiesDescriptor');
  }

  const rootId = getAttribute(root, 'ID');
  if (!rootId) {
    throw new SAMLMetadataValidationError('Invalid aggregate metadata: missing root ID');
  }

  const entities = findElements(root, SAML_NAMESPACES.MD, 'EntityDescriptor').map((entity) =>
    summarizeEntityDescriptor(entity)
  );
  if (entities.length === 0) {
    throw new SAMLMetadataValidationError(
      'Invalid aggregate metadata: no EntityDescriptor entries'
    );
  }

  return {
    metadataXml: xml,
    rootId,
    validUntil: getAttribute(root, 'validUntil') || undefined,
    entities,
  };
}

export function extractEntityDescriptorXml(xml: string, entityId: string): string {
  const doc = parseXml(xml);
  const entities = findElements(doc, SAML_NAMESPACES.MD, 'EntityDescriptor');
  const entity = entities.find((candidate) => getAttribute(candidate, 'entityID') === entityId);
  if (!entity) {
    throw new SAMLMetadataValidationError(
      `Aggregate metadata does not contain entityID: ${entityId}`
    );
  }

  const clone = entity.cloneNode(true) as Element;
  copyNamespaceDeclarations(entity, clone);
  return serializeXml(clone);
}

export function resolveAggregateSignaturePolicy(env: Env): SAMLMetadataVerificationPolicy {
  const raw = env.SAML_AGGREGATE_METADATA_SIGNATURE_POLICY?.trim().toLowerCase();
  if (raw === 'strict' || raw === 'warn' || raw === 'disabled') {
    return raw;
  }

  const deploymentTarget = (env as unknown as Record<string, string | undefined>)
    .AUTHRIM_DEPLOYMENT_TARGET;
  const environment = (env as unknown as Record<string, string | undefined>).ENVIRONMENT;
  const isProduction =
    deploymentTarget === 'prod' ||
    deploymentTarget === 'production' ||
    environment === 'prod' ||
    environment === 'production';
  return isProduction ? 'strict' : 'warn';
}

export function verifyAggregateMetadataSignature(
  xml: string,
  metadataUrl: string | undefined,
  trustProfiles: SAMLFederationTrustProfile[],
  policy: SAMLMetadataVerificationPolicy
): SAMLMetadataVerificationSummary {
  if (policy === 'disabled') {
    return {
      status: 'skipped',
      policy,
      warnings: ['Aggregate metadata signature verification is disabled.'],
    };
  }

  const aggregate = parseAggregateMetadata(xml);
  const matchingProfiles = trustProfiles.filter(
    (profile) => profile.enabled && metadataUrlMatchesProfile(metadataUrl, profile)
  );
  const warnings: string[] = [];

  if (matchingProfiles.length === 0) {
    const summary: SAMLMetadataVerificationSummary = {
      status: policy === 'strict' ? 'failed' : 'unverified',
      policy,
      signedElementId: aggregate.rootId,
      warnings: ['No enabled federation trust profile matched this metadata URL.'],
      error: 'No matching federation trust profile',
    };
    if (policy === 'strict') {
      throw new SAMLMetadataValidationError(summary.error!);
    }
    return summary;
  }

  const rootSignature = findDirectChildElement(
    parseXml(xml).documentElement,
    SAML_NAMESPACES.DS,
    'Signature'
  );
  if (!rootSignature) {
    const summary: SAMLMetadataVerificationSummary = {
      status: policy === 'strict' ? 'failed' : 'unverified',
      policy,
      signedElementId: aggregate.rootId,
      trustProfileId: matchingProfiles[0]?.id,
      trustProfileName: matchingProfiles[0]?.name,
      warnings: ['Aggregate metadata root is not signed.'],
      error: 'Aggregate metadata root is not signed',
    };
    if (policy === 'strict') {
      throw new SAMLMetadataValidationError(summary.error!);
    }
    return summary;
  }

  const referenceUris = Array.from(
    rootSignature.getElementsByTagNameNS(SAML_NAMESPACES.DS, 'Reference')
  )
    .map((reference) => getAttribute(reference as Element, 'URI'))
    .filter((uri): uri is string => Boolean(uri));

  if (referenceUris.length !== 1 || referenceUris[0] !== `#${aggregate.rootId}`) {
    const summary: SAMLMetadataVerificationSummary = {
      status: policy === 'strict' ? 'failed' : 'unverified',
      policy,
      signedElementId: aggregate.rootId,
      trustProfileId: matchingProfiles[0]?.id,
      trustProfileName: matchingProfiles[0]?.name,
      warnings: [
        'Aggregate metadata signature must contain exactly one Reference to the root EntitiesDescriptor ID.',
      ],
      error: 'Aggregate signature reference does not exclusively cover the root EntitiesDescriptor',
    };
    if (policy === 'strict') {
      throw new SAMLMetadataValidationError(summary.error!);
    }
    return summary;
  }

  for (const profile of matchingProfiles) {
    for (const certificate of profile.certificates) {
      try {
        verifyRootAggregateSignature(xml, aggregate.rootId, certificate.certificate);
        return {
          status: 'verified',
          policy,
          trustProfileId: profile.id,
          trustProfileName: profile.name,
          certificateFingerprintSha256: certificate.fingerprintSha256,
          signedElementId: aggregate.rootId,
          verifiedAt: Date.now(),
        };
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : 'Signature verification failed');
      }
    }
  }

  const summary: SAMLMetadataVerificationSummary = {
    status: policy === 'strict' ? 'failed' : 'unverified',
    policy,
    signedElementId: aggregate.rootId,
    trustProfileId: matchingProfiles[0]?.id,
    trustProfileName: matchingProfiles[0]?.name,
    warnings: warnings.slice(0, 5),
    error: 'Aggregate metadata signature could not be verified with matching trust profiles',
  };
  if (policy === 'strict') {
    throw new SAMLMetadataValidationError(summary.error!);
  }
  return summary;
}

export async function fingerprintCertificateSha256(certificate: string): Promise<string> {
  if (
    !certificate.includes('-----BEGIN CERTIFICATE-----') ||
    !certificate.includes('-----END CERTIFICATE-----')
  ) {
    throw new SAMLMetadataValidationError('Invalid trust certificate PEM');
  }
  const normalized = certificate
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]+=*$/.test(normalized)) {
    throw new SAMLMetadataValidationError('Invalid trust certificate PEM');
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
  } catch {
    throw new SAMLMetadataValidationError('Invalid trust certificate PEM');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(':');
}

function summarizeEntityDescriptor(entity: Element): SAMLMetadataEntitySummary {
  const entityId = getAttribute(entity, 'entityID') || '';
  const idpDescriptor = findElement(entity, SAML_NAMESPACES.MD, 'IDPSSODescriptor');
  const spDescriptor = findElement(entity, SAML_NAMESPACES.MD, 'SPSSODescriptor');
  const role: SAMLMetadataEntityRole =
    idpDescriptor && spDescriptor
      ? 'ambiguous'
      : idpDescriptor
        ? 'saml_idp'
        : spDescriptor
          ? 'saml_sp'
          : 'unknown';
  const displayName =
    getLocalizedText(entity, 'DisplayName') ||
    getLocalizedText(entity, 'OrganizationDisplayName') ||
    getLocalizedText(entity, 'OrganizationName') ||
    undefined;
  const acs = spDescriptor
    ? findElement(spDescriptor, SAML_NAMESPACES.MD, 'AssertionConsumerService')
    : null;
  const sso = idpDescriptor
    ? findElement(idpDescriptor, SAML_NAMESPACES.MD, 'SingleSignOnService')
    : null;
  const sloSource = spDescriptor || idpDescriptor;
  const slo = sloSource ? findElement(sloSource, SAML_NAMESPACES.MD, 'SingleLogoutService') : null;

  return {
    entityId,
    role,
    displayName,
    acsUrl: acs ? getAttribute(acs, 'Location') || undefined : undefined,
    ssoUrl: sso ? getAttribute(sso, 'Location') || undefined : undefined,
    sloUrl: slo ? getAttribute(slo, 'Location') || undefined : undefined,
    certificateCount: findElements(entity, SAML_NAMESPACES.DS, 'X509Certificate').length,
    validUntil: getAttribute(entity, 'validUntil') || undefined,
    keywords: getKeywords(entity),
    logoUrl: getLogoUrl(entity),
  };
}

function metadataUrlMatchesProfile(
  metadataUrl: string | undefined,
  profile: SAMLFederationTrustProfile
): boolean {
  if (!metadataUrl) {
    return profile.metadataUrlPatterns.some((pattern) => pattern.trim() === '*');
  }
  return profile.metadataUrlPatterns.some((pattern) => wildcardMatch(metadataUrl, pattern));
}

function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function getLocalizedText(parent: Element, localName: string): string | null {
  const elements = Array.from(parent.getElementsByTagNameNS('*', localName));
  const preferred =
    elements.find((element) => element.getAttribute('xml:lang') === 'en') ||
    elements.find((element) => element.getAttribute('xml:lang') === 'ja') ||
    elements[0];
  return preferred ? getTextContent(preferred as Element) : null;
}

function getKeywords(parent: Element): string[] | undefined {
  const keywords = Array.from(parent.getElementsByTagNameNS('*', 'Keywords'))
    .flatMap((element) => (getTextContent(element as Element) ?? '').split(/\s+/))
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  const uniqueKeywords = Array.from(new Set(keywords));
  return uniqueKeywords.length > 0 ? uniqueKeywords : undefined;
}

export function getLogoUrl(parent: Element): string | undefined {
  const logos = Array.from(parent.getElementsByTagNameNS('*', 'Logo'))
    .map((element) => {
      const logo = element as Element;
      return {
        url: getTextContent(logo)?.trim() ?? '',
        lang: logo.getAttribute('xml:lang') ?? '',
        width: Number(logo.getAttribute('width') ?? 0),
        height: Number(logo.getAttribute('height') ?? 0),
      };
    })
    .filter((logo) => isHttpsUrl(logo.url));

  if (logos.length === 0) {
    return undefined;
  }

  logos.sort((a, b) => {
    const aLangScore = a.lang === 'en' || a.lang === 'ja' ? 1 : 0;
    const bLangScore = b.lang === 'en' || b.lang === 'ja' ? 1 : 0;
    const aSize = Math.max(a.width, a.height);
    const bSize = Math.max(b.width, b.height);
    return bLangScore - aLangScore || bSize - aSize;
  });
  return logos[0].url;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function findDirectChildElement(
  parent: Element | null,
  namespace: string,
  localName: string
): Element | null {
  if (!parent) {
    return null;
  }
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (
      child.nodeType === 1 &&
      (child as Element).namespaceURI === namespace &&
      (child as Element).localName === localName
    ) {
      return child as Element;
    }
  }
  return null;
}

function verifyRootAggregateSignature(xml: string, rootId: string, certificateOrKey: string): void {
  const doc = parseXml(xml);
  const signatureNode = findDirectChildElement(
    doc.documentElement,
    SAML_NAMESPACES.DS,
    'Signature'
  );
  if (!signatureNode) {
    throw new Error('Aggregate metadata root is not signed');
  }
  const references = signatureNode.getElementsByTagNameNS(SAML_NAMESPACES.DS, 'Reference');
  if (references.length !== 1) {
    throw new Error('Aggregate signature must contain exactly one Reference');
  }

  const referenceUri = references[0]?.getAttribute('URI');
  if (referenceUri !== `#${rootId}`) {
    throw new Error(
      `Aggregate signature Reference URI "${referenceUri}" does not match root "#${rootId}"`
    );
  }

  const referencedElements = findElementsById(doc, rootId);
  if (referencedElements.length !== 1) {
    throw new Error(
      `Aggregate signature expected exactly one element with ID "${rootId}", found ${referencedElements.length}`
    );
  }

  const signatureMethod = signatureNode.getElementsByTagNameNS(
    SAML_NAMESPACES.DS,
    'SignatureMethod'
  )[0];
  if (signatureMethod?.getAttribute('Algorithm') === SIGNATURE_ALGORITHMS.RSA_SHA1) {
    throw new Error('SHA-1 signature algorithm is not allowed');
  }

  const signature = new SignedXml();
  signature.publicCert = certificateOrKey;
  signature.loadSignature(signatureNode);
  if (!signature.checkSignature(xml)) {
    const errors = (signature as unknown as SignedXmlWithErrors).validationErrors || [];
    throw new Error(`Signature verification failed: ${errors.join(', ')}`);
  }
}

function findElementsById(doc: Document, id: string): Element[] {
  const results: Element[] = [];

  function traverse(node: Node): void {
    if (node.nodeType === 1 && (node as Element).getAttribute('ID') === id) {
      results.push(node as Element);
    }
    if (!node.childNodes) {
      return;
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      traverse(node.childNodes[i]!);
    }
  }

  traverse(doc);
  return results;
}

function copyNamespaceDeclarations(source: Element, target: Element): void {
  let current: Element | null = source;
  while (current) {
    for (let i = 0; i < current.attributes.length; i++) {
      const attr = current.attributes[i];
      if (
        (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) &&
        !hasAttributeNamed(target, attr.name)
      ) {
        target.setAttribute(attr.name, attr.value);
      }
    }
    current = current.parentNode?.nodeType === 1 ? (current.parentNode as Element) : null;
  }

  if (!hasAttributeNamed(target, 'xmlns')) {
    target.setAttribute('xmlns', SAML_NAMESPACES.MD);
  }
  if (!hasAttributeNamed(target, 'xmlns:ds')) {
    target.setAttribute('xmlns:ds', SAML_NAMESPACES.DS);
  }
}

function hasAttributeNamed(element: Element, name: string): boolean {
  for (let i = 0; i < element.attributes.length; i++) {
    if (element.attributes[i]?.name === name) {
      return true;
    }
  }
  return serializeXml(element).includes(`${name}=`);
}
