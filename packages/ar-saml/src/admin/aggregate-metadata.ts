import type {
  Env,
  SAMLFederationTrustProfile,
  SAMLMetadataEntityRole,
  SAMLMetadataEntitySummary,
  SAMLMetadataVerificationPolicy,
  SAMLMetadataVerificationSummary,
} from '@authrim/ar-lib-core';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { ExclusiveCanonicalization } from 'xml-crypto';
import {
  parseXml,
  findDirectChildElement,
  findDirectChildElements,
  findElement,
  findElements,
  getAttribute,
  getTextContent,
} from '../common/xml-utils';
import { DIGEST_ALGORITHMS, SAML_NAMESPACES, SIGNATURE_ALGORITHMS } from '../common/constants';
import { importPublicKeyFromCertificate } from '../common/signature';
import { SAMLMetadataValidationError } from './errors';

export const SINGLE_METADATA_FETCH_LIMIT_BYTES = 1024 * 1024;
export const AGGREGATE_METADATA_FETCH_LIMIT_BYTES = 10 * 1024 * 1024;

const AGGREGATE_XML_LIMITS = {
  maxBytes: AGGREGATE_METADATA_FETCH_LIMIT_BYTES,
  maxElements: 100_000,
  maxAttributes: 200_000,
  maxDepth: 64,
  maxEntities: 10_000,
} as const;

const AGGREGATE_SIGNATURE_LIMITS = {
  maxBytes: 128 * 1024,
  maxElements: 512,
  maxAttributes: 1024,
} as const;

const SAML_ENTITY_CATEGORY_ATTRIBUTE = 'http://macedir.org/entity-category';
const SAML_ENTITY_CATEGORY_SUPPORT_ATTRIBUTE = 'http://macedir.org/entity-category-support';
const SAML_METADATA_ATTRIBUTE_NAMESPACE = 'urn:oasis:names:tc:SAML:metadata:attribute';
const SAML_METADATA_RPI_NAMESPACE = 'urn:oasis:names:tc:SAML:metadata:rpi';

export interface ParsedAggregateMetadata {
  metadataXml: string;
  rootId: string;
  validUntil?: string;
  entities: SAMLMetadataEntitySummary[];
}

export interface VerifiedAggregateMetadata {
  aggregate: ParsedAggregateMetadata;
  verification: SAMLMetadataVerificationSummary;
}

interface ScannedAggregateMetadata {
  rootId: string;
  rootIdOccurrences: number;
  validUntil?: string;
  rootSignatureXml?: string;
  entityCount: number;
  entityXml: string[];
}

interface PreparedAggregateSignature {
  signedReference: string;
  signedInfo: Uint8Array;
  signatureValue: Uint8Array;
}

export function isAggregateMetadata(xml: string): boolean {
  if (utf8ByteLength(xml) > AGGREGATE_XML_LIMITS.maxBytes) {
    throw new SAMLMetadataValidationError('Aggregate metadata exceeds maximum size');
  }
  let rootIsAggregate = false;
  let depth = 0;
  let elementCount = 0;
  let attributeCount = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => {
    throw new SAMLMetadataValidationError(
      'XML security error: DOCTYPE declarations are not allowed'
    );
  });
  parser.on('processinginstruction', () => {
    throw new SAMLMetadataValidationError('SAML metadata processing instructions are not allowed');
  });
  parser.on('opentag', (tag) => {
    depth++;
    elementCount++;
    attributeCount += Object.keys(tag.attributes).length;
    if (depth > AGGREGATE_XML_LIMITS.maxDepth) {
      throw new SAMLMetadataValidationError('SAML metadata exceeds maximum depth');
    }
    if (elementCount > AGGREGATE_XML_LIMITS.maxElements) {
      throw new SAMLMetadataValidationError('SAML metadata exceeds maximum element count');
    }
    if (attributeCount > AGGREGATE_XML_LIMITS.maxAttributes) {
      throw new SAMLMetadataValidationError('SAML metadata exceeds maximum attribute count');
    }
    if (depth === 1) {
      rootIsAggregate = tag.uri === SAML_NAMESPACES.MD && tag.local === 'EntitiesDescriptor';
    }
  });
  parser.on('closetag', () => {
    depth--;
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    throw toAggregateValidationError(error);
  }
  return rootIsAggregate;
}

export function parseAggregateMetadata(xml: string): ParsedAggregateMetadata {
  return buildParsedAggregateMetadata(xml, scanAggregateMetadata(xml));
}

export function extractEntityDescriptorXml(xml: string, entityId: string): string {
  const entities = extractEntityDescriptorXmls(xml, [entityId]);
  const entityXml = entities.get(entityId);
  if (!entityXml) {
    throw new SAMLMetadataValidationError(
      `Aggregate metadata does not contain entityID: ${entityId}`
    );
  }
  return entityXml;
}

export function extractEntityDescriptorXmls(
  xml: string,
  entityIds: Iterable<string>
): Map<string, string> {
  const requestedEntityIds = new Set(entityIds);
  if (requestedEntityIds.size === 0) {
    return new Map();
  }
  const scan = scanAggregateMetadata(xml, requestedEntityIds);
  const results = new Map<string, string>();
  for (const entityXml of scan.entityXml) {
    const entity = parseEntityDescriptor(entityXml);
    const entityId = getAttribute(entity, 'entityID');
    if (entityId && requestedEntityIds.has(entityId) && !results.has(entityId)) {
      results.set(entityId, entityXml);
    }
  }
  return results;
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

export async function verifyAggregateMetadataSignature(
  xml: string,
  metadataUrl: string | undefined,
  trustProfiles: SAMLFederationTrustProfile[],
  policy: SAMLMetadataVerificationPolicy
): Promise<SAMLMetadataVerificationSummary> {
  return (await verifyAggregateMetadata(xml, metadataUrl, trustProfiles, policy)).verification;
}

export async function verifyAggregateMetadata(
  xml: string,
  metadataUrl: string | undefined,
  trustProfiles: SAMLFederationTrustProfile[],
  policy: SAMLMetadataVerificationPolicy
): Promise<VerifiedAggregateMetadata> {
  const scan = scanAggregateMetadata(xml, undefined, false);
  const matchingProfiles = trustProfiles.filter(
    (profile) => profile.enabled && metadataUrlMatchesProfile(metadataUrl, profile)
  );
  if (policy === 'disabled') {
    const profile = matchingProfiles.length === 1 ? matchingProfiles[0] : undefined;
    return {
      aggregate: parseAggregateMetadata(xml),
      verification: {
        status: 'skipped',
        policy,
        trustProfileId: profile?.id,
        trustProfileName: profile?.name,
        trustContextSnapshotHash: profile?.trustContextSnapshotHash,
        warnings: ['Aggregate metadata signature verification is disabled.'],
      },
    };
  }

  const warnings: string[] = [];

  if (matchingProfiles.length === 0) {
    const summary: SAMLMetadataVerificationSummary = {
      status: policy === 'strict' ? 'failed' : 'unverified',
      policy,
      signedElementId: scan.rootId,
      warnings: ['No enabled federation trust profile matched this metadata URL.'],
      error: 'No matching federation trust profile',
    };
    if (policy === 'strict') {
      throw new SAMLMetadataValidationError(summary.error!);
    }
    return { aggregate: parseAggregateMetadata(xml), verification: summary };
  }

  if (!scan.rootSignatureXml) {
    const summary: SAMLMetadataVerificationSummary = {
      status: policy === 'strict' ? 'failed' : 'unverified',
      policy,
      signedElementId: scan.rootId,
      trustProfileId: matchingProfiles[0]?.id,
      trustProfileName: matchingProfiles[0]?.name,
      trustContextSnapshotHash: matchingProfiles[0]?.trustContextSnapshotHash,
      warnings: ['Aggregate metadata root is not signed.'],
      error: 'Aggregate metadata root is not signed',
    };
    if (policy === 'strict') {
      throw new SAMLMetadataValidationError(summary.error!);
    }
    return { aggregate: parseAggregateMetadata(xml), verification: summary };
  }

  const signatureNode = parseXml(scan.rootSignatureXml).documentElement;
  const signedInfo = getSingleDirectDsigChild(signatureNode, 'SignedInfo');
  const references = getDirectDsigChildren(signedInfo, 'Reference');
  const referenceUris = references
    .map((reference) => getAttribute(reference as Element, 'URI'))
    .filter((uri): uri is string => Boolean(uri));

  if (
    references.length !== 1 ||
    referenceUris.length !== 1 ||
    referenceUris[0] !== `#${scan.rootId}`
  ) {
    const summary: SAMLMetadataVerificationSummary = {
      status: policy === 'strict' ? 'failed' : 'unverified',
      policy,
      signedElementId: scan.rootId,
      trustProfileId: matchingProfiles[0]?.id,
      trustProfileName: matchingProfiles[0]?.name,
      trustContextSnapshotHash: matchingProfiles[0]?.trustContextSnapshotHash,
      warnings: [
        'Aggregate metadata signature must contain exactly one Reference to the root EntitiesDescriptor ID.',
      ],
      error: 'Aggregate signature reference does not exclusively cover the root EntitiesDescriptor',
    };
    if (policy === 'strict') {
      throw new SAMLMetadataValidationError(summary.error!);
    }
    return { aggregate: parseAggregateMetadata(xml), verification: summary };
  }

  let prepared: PreparedAggregateSignature | undefined;
  try {
    prepared = await prepareAggregateSignature(xml, scan);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : 'Signature verification failed');
  }

  for (const profile of matchingProfiles) {
    for (const certificate of profile.certificates) {
      if (!prepared) break;
      try {
        await verifyPreparedAggregateSignature(prepared, certificate.certificate);
        const verifiedAggregate = parseAggregateMetadata(prepared.signedReference);
        if (verifiedAggregate.rootId !== scan.rootId) {
          throw new Error('Verified aggregate root ID does not match the received document');
        }
        return {
          aggregate: verifiedAggregate,
          verification: {
            status: 'verified',
            policy,
            trustProfileId: profile.id,
            trustProfileName: profile.name,
            trustContextSnapshotHash: profile.trustContextSnapshotHash,
            certificateFingerprintSha256: certificate.fingerprintSha256,
            signedElementId: scan.rootId,
            verifiedAt: Date.now(),
          },
        };
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : 'Signature verification failed');
      }
    }
  }

  const summary: SAMLMetadataVerificationSummary = {
    status: policy === 'strict' ? 'failed' : 'unverified',
    policy,
    signedElementId: scan.rootId,
    trustProfileId: matchingProfiles[0]?.id,
    trustProfileName: matchingProfiles[0]?.name,
    trustContextSnapshotHash: matchingProfiles[0]?.trustContextSnapshotHash,
    warnings: warnings.slice(0, 5),
    error: 'Aggregate metadata signature could not be verified with matching trust profiles',
  };
  if (policy === 'strict') {
    throw new SAMLMetadataValidationError(summary.error!);
  }
  return { aggregate: parseAggregateMetadata(xml), verification: summary };
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
    entityCategories: getEntityAttributeValues(entity, SAML_ENTITY_CATEGORY_ATTRIBUTE),
    entityCategorySupport: getEntityAttributeValues(entity, SAML_ENTITY_CATEGORY_SUPPORT_ATTRIBUTE),
    registrationAuthority: getRegistrationAuthority(entity),
  };
}

function getEntityAttributeValues(entity: Element, attributeName: string): string[] | undefined {
  const extensions = findDirectChildElement(entity, SAML_NAMESPACES.MD, 'Extensions');
  if (!extensions) return undefined;
  const entityAttributes = findDirectChildElements(
    extensions,
    SAML_METADATA_ATTRIBUTE_NAMESPACE,
    'EntityAttributes'
  );
  const values = entityAttributes
    .flatMap((container) => findDirectChildElements(container, SAML_NAMESPACES.SAML2, 'Attribute'))
    .filter((attribute) => getAttribute(attribute, 'Name') === attributeName)
    .flatMap((attribute) =>
      findDirectChildElements(attribute, SAML_NAMESPACES.SAML2, 'AttributeValue')
    )
    .map((value) => getTextContent(value)?.trim() ?? '')
    .filter(Boolean);
  const uniqueValues = Array.from(new Set(values));
  return uniqueValues.length > 0 ? uniqueValues : undefined;
}

function getRegistrationAuthority(entity: Element): string | undefined {
  const extensions = findDirectChildElement(entity, SAML_NAMESPACES.MD, 'Extensions');
  if (!extensions) return undefined;
  const registrationInfo = findDirectChildElements(
    extensions,
    SAML_METADATA_RPI_NAMESPACE,
    'RegistrationInfo'
  );
  if (registrationInfo.length > 1) {
    throw new SAMLMetadataValidationError(
      'Invalid aggregate metadata: multiple mdrpi RegistrationInfo elements'
    );
  }
  return registrationInfo[0]
    ? getAttribute(registrationInfo[0], 'registrationAuthority') || undefined
    : undefined;
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

async function prepareAggregateSignature(
  xml: string,
  scan: ScannedAggregateMetadata
): Promise<PreparedAggregateSignature> {
  if (!scan.rootSignatureXml) {
    throw new Error('Aggregate metadata root is not signed');
  }
  const signatureNode = parseXml(scan.rootSignatureXml).documentElement;
  const signedInfo = getSingleDirectDsigChild(signatureNode, 'SignedInfo');
  const references = getDirectDsigChildren(signedInfo, 'Reference');
  if (references.length !== 1) {
    throw new Error('Aggregate signature must contain exactly one Reference');
  }

  const referenceUri = references[0]?.getAttribute('URI');
  if (referenceUri !== `#${scan.rootId}`) {
    throw new Error(
      `Aggregate signature Reference URI "${referenceUri}" does not match root "#${scan.rootId}"`
    );
  }

  if (scan.rootIdOccurrences !== 1) {
    throw new Error(
      `Aggregate signature expected exactly one element with ID "${scan.rootId}", found ${scan.rootIdOccurrences}`
    );
  }

  const canonicalizationMethod = getSingleDirectDsigChild(signedInfo, 'CanonicalizationMethod');
  if (
    canonicalizationMethod.getAttribute('Algorithm') !== 'http://www.w3.org/2001/10/xml-exc-c14n#'
  ) {
    throw new Error('Aggregate SignedInfo canonicalization must use exclusive C14N');
  }

  const signatureMethod = getSingleDirectDsigChild(signedInfo, 'SignatureMethod');
  if (signatureMethod.getAttribute('Algorithm') !== SIGNATURE_ALGORITHMS.RSA_SHA256) {
    throw new Error('Aggregate signature algorithm must be RSA-SHA256');
  }

  const digestMethod = getSingleDirectDsigChild(references[0]!, 'DigestMethod');
  if (digestMethod.getAttribute('Algorithm') !== DIGEST_ALGORITHMS.SHA256) {
    throw new Error('Aggregate digest algorithm must be SHA-256');
  }

  const transformsElement = getSingleDirectDsigChild(references[0]!, 'Transforms');
  const transforms = getDirectDsigChildren(transformsElement, 'Transform').map((transform) =>
    transform.getAttribute('Algorithm')
  );
  if (
    transforms.length !== 2 ||
    transforms[0] !== 'http://www.w3.org/2000/09/xmldsig#enveloped-signature' ||
    transforms[1] !== 'http://www.w3.org/2001/10/xml-exc-c14n#'
  ) {
    throw new Error(
      'Aggregate signature transforms must be enveloped-signature followed by exclusive C14N'
    );
  }

  if (signatureNode.getElementsByTagNameNS('*', 'InclusiveNamespaces').length > 0) {
    throw new Error('Aggregate signature InclusiveNamespaces is not supported');
  }

  const digestValue = getRequiredElementText(
    getSingleDirectDsigChild(references[0]!, 'DigestValue'),
    'DigestValue'
  );
  const signatureValue = decodeBase64(
    getRequiredElementText(
      getSingleDirectDsigChild(signatureNode, 'SignatureValue'),
      'SignatureValue'
    ),
    'SignatureValue'
  );
  const signedInfoCanonical = new ExclusiveCanonicalization().process(signedInfo, {});
  const signedReference = canonicalizeAggregateReference(xml);
  const actualDigest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signedReference))
  );
  if (encodeBase64(actualDigest) !== digestValue.replace(/\s+/g, '')) {
    throw new Error('Aggregate metadata reference digest is invalid');
  }

  return {
    signedReference,
    signedInfo: new TextEncoder().encode(signedInfoCanonical),
    signatureValue,
  };
}

async function verifyPreparedAggregateSignature(
  prepared: PreparedAggregateSignature,
  certificate: string
): Promise<void> {
  const publicKey = await importPublicKeyFromCertificate(certificate);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    toArrayBuffer(prepared.signatureValue),
    toArrayBuffer(prepared.signedInfo)
  );
  if (!valid) {
    throw new Error('Aggregate SignedInfo signature is invalid');
  }
}

function canonicalizeAggregateReference(xml: string): string {
  let depth = 0;
  let skippedSignatureDepth: number | undefined;
  const output: string[] = [];
  const renderedNamespaces: Array<Map<string, string>> = [];
  const parser = new SaxesParser({ xmlns: true });

  parser.on('doctype', () => {
    throw new SAMLMetadataValidationError(
      'XML security error: DOCTYPE declarations are not allowed'
    );
  });
  parser.on('processinginstruction', () => {
    throw new SAMLMetadataValidationError('SAML metadata processing instructions are not allowed');
  });
  parser.on('opentag', (tag) => {
    depth++;
    const inherited = new Map(renderedNamespaces[renderedNamespaces.length - 1] ?? []);
    renderedNamespaces.push(inherited);

    if (
      skippedSignatureDepth === undefined &&
      depth === 2 &&
      tag.uri === SAML_NAMESPACES.DS &&
      tag.local === 'Signature'
    ) {
      skippedSignatureDepth = depth;
      return;
    }
    if (skippedSignatureDepth !== undefined) return;

    output.push(serializeExclusiveCanonicalOpenTag(tag, inherited));
  });
  parser.on('text', (text) => {
    if (skippedSignatureDepth === undefined && depth > 0) {
      output.push(escapeCanonicalText(text));
    }
  });
  parser.on('cdata', (text) => {
    if (skippedSignatureDepth === undefined && depth > 0) {
      output.push(escapeCanonicalText(text));
    }
  });
  parser.on('closetag', (tag) => {
    if (skippedSignatureDepth === undefined) {
      output.push(`</${tag.name}>`);
    } else if (skippedSignatureDepth === depth) {
      skippedSignatureDepth = undefined;
    }
    renderedNamespaces.pop();
    depth--;
  });

  try {
    parser.write(xml).close();
  } catch (error) {
    throw toAggregateValidationError(error);
  }
  return output.join('');
}

function serializeExclusiveCanonicalOpenTag(
  tag: SaxesTagNS,
  renderedNamespaces: Map<string, string>
): string {
  const namespacesToRender = new Map<string, string>();
  if (tag.prefix) {
    if (renderedNamespaces.get(tag.prefix) !== tag.uri) {
      namespacesToRender.set(tag.prefix, tag.uri);
    }
  } else if ((renderedNamespaces.get('') ?? '') !== tag.uri) {
    namespacesToRender.set('', tag.uri);
  }

  const attributes = Object.values(tag.attributes).filter(
    (attribute) => attribute.prefix !== 'xmlns' && attribute.name !== 'xmlns'
  );
  for (const attribute of attributes) {
    if (
      attribute.prefix &&
      attribute.prefix !== 'xml' &&
      renderedNamespaces.get(attribute.prefix) !== attribute.uri
    ) {
      namespacesToRender.set(attribute.prefix, attribute.uri);
    }
  }

  const namespaceXml = Array.from(namespacesToRender)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([prefix, uri]) => {
      renderedNamespaces.set(prefix, uri);
      const name = prefix ? `xmlns:${prefix}` : 'xmlns';
      return ` ${name}="${escapeCanonicalAttribute(uri)}"`;
    })
    .join('');
  const attributeXml = attributes
    .sort((left, right) => {
      const leftKey = `${left.uri || ''}\u0000${left.local}`;
      const rightKey = `${right.uri || ''}\u0000${right.local}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
    .map((attribute) => ` ${attribute.name}="${escapeCanonicalAttribute(attribute.value)}"`)
    .join('');

  return `<${tag.name}${namespaceXml}${attributeXml}>`;
}

function escapeCanonicalText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;');
}

function escapeCanonicalAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

function getRequiredElementText(element: Element, localName: string): string {
  const value = getTextContent(element)?.trim();
  if (!value) {
    throw new Error(`Aggregate signature ${localName} is empty`);
  }
  return value;
}

function getSingleDirectDsigChild(parent: Element, localName: string): Element {
  const children = getDirectDsigChildren(parent, localName);
  if (children.length !== 1) {
    throw new Error(`Aggregate signature must contain exactly one direct ${localName}`);
  }
  return children[0]!;
}

function getDirectDsigChildren(parent: Element, localName: string): Element[] {
  const children: Element[] = [];
  for (let index = 0; index < parent.childNodes.length; index++) {
    const child = parent.childNodes[index];
    if (child?.nodeType !== 1 || (child as Element).localName !== localName) continue;
    const element = child as Element;
    if (element.namespaceURI !== SAML_NAMESPACES.DS) {
      throw new Error(`Aggregate signature ${localName} must use the XMLDSig namespace`);
    }
    children.push(element);
  }
  return children;
}

function decodeBase64(value: string, field: string): Uint8Array {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error(`Aggregate signature ${field} is not valid base64`);
  }
  try {
    return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
  } catch {
    throw new Error(`Aggregate signature ${field} is not valid base64`);
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function buildParsedAggregateMetadata(
  xml: string,
  scan: ScannedAggregateMetadata
): ParsedAggregateMetadata {
  assertAggregateMetadataIsCurrent(scan.validUntil);
  const entities = scan.entityXml.map((entityXml) =>
    summarizeEntityDescriptor(parseEntityDescriptor(entityXml))
  );
  if (entities.length === 0) {
    throw new SAMLMetadataValidationError(
      'Invalid aggregate metadata: no EntityDescriptor entries'
    );
  }
  const entityIds = new Set<string>();
  for (const entity of entities) {
    if (!entity.entityId || entityIds.has(entity.entityId)) {
      throw new SAMLMetadataValidationError(
        'Invalid aggregate metadata: entityID values must be present and unique'
      );
    }
    entityIds.add(entity.entityId);
  }
  return {
    metadataXml: xml,
    rootId: scan.rootId,
    validUntil: scan.validUntil,
    entities,
  };
}

function parseEntityDescriptor(xml: string): Element {
  if (utf8ByteLength(xml) > SINGLE_METADATA_FETCH_LIMIT_BYTES) {
    throw new SAMLMetadataValidationError(
      'Invalid aggregate metadata: EntityDescriptor exceeds size limit'
    );
  }
  const root = parseXml(xml).documentElement;
  if (root.namespaceURI !== SAML_NAMESPACES.MD || root.localName !== 'EntityDescriptor') {
    throw new SAMLMetadataValidationError('Invalid aggregate metadata: invalid EntityDescriptor');
  }
  return root;
}

function scanAggregateMetadata(
  xml: string,
  requestedEntityIds?: ReadonlySet<string>,
  captureEntities = true
): ScannedAggregateMetadata {
  if (utf8ByteLength(xml) > AGGREGATE_XML_LIMITS.maxBytes) {
    throw new SAMLMetadataValidationError('Aggregate metadata exceeds maximum size');
  }

  let depth = 0;
  let elementCount = 0;
  let attributeCount = 0;
  let entityCount = 0;
  let rootId = '';
  let validUntil: string | undefined;
  let rootIdOccurrences = 0;
  let captureEntityDepth: number | undefined;
  let captureEntity = false;
  let entityBuffer: string[] = [];
  let captureSignatureDepth: number | undefined;
  let signatureBuffer: string[] = [];
  let signatureBytes = 0;
  let signatureElementCount = 0;
  let signatureAttributeCount = 0;
  let rootSignatureXml: string | undefined;
  const entityXml: string[] = [];
  const namespaceStack: Array<Record<string, string>> = [];
  const entitiesDescriptorValidityStack: Array<string | undefined> = [];
  const parser = new SaxesParser({ xmlns: true });

  const appendSignatureChunk = (chunk: string): void => {
    signatureBytes += utf8ByteLength(chunk);
    if (signatureBytes > AGGREGATE_SIGNATURE_LIMITS.maxBytes) {
      throw new SAMLMetadataValidationError('Aggregate signature exceeds maximum size');
    }
    signatureBuffer.push(chunk);
  };

  const countSignatureElement = (tag: SaxesTagNS): void => {
    signatureElementCount++;
    signatureAttributeCount += Object.keys(tag.attributes).length;
    if (signatureElementCount > AGGREGATE_SIGNATURE_LIMITS.maxElements) {
      throw new SAMLMetadataValidationError('Aggregate signature exceeds maximum element count');
    }
    if (signatureAttributeCount > AGGREGATE_SIGNATURE_LIMITS.maxAttributes) {
      throw new SAMLMetadataValidationError('Aggregate signature exceeds maximum attribute count');
    }
  };

  parser.on('doctype', () => {
    throw new SAMLMetadataValidationError(
      'XML security error: DOCTYPE declarations are not allowed'
    );
  });
  parser.on('processinginstruction', () => {
    throw new SAMLMetadataValidationError('SAML metadata processing instructions are not allowed');
  });
  parser.on('opentag', (tag) => {
    let entityValidUntilOverride: string | undefined;
    depth++;
    const inScopeNamespaces = {
      ...(namespaceStack[namespaceStack.length - 1] ?? {}),
      ...tag.ns,
    };
    namespaceStack.push(inScopeNamespaces);
    elementCount++;
    attributeCount += Object.keys(tag.attributes).length;
    if (depth > AGGREGATE_XML_LIMITS.maxDepth) {
      throw new SAMLMetadataValidationError('Aggregate metadata exceeds maximum depth');
    }
    if (elementCount > AGGREGATE_XML_LIMITS.maxElements) {
      throw new SAMLMetadataValidationError('Aggregate metadata exceeds maximum element count');
    }
    if (attributeCount > AGGREGATE_XML_LIMITS.maxAttributes) {
      throw new SAMLMetadataValidationError('Aggregate metadata exceeds maximum attribute count');
    }

    const id = getSaxesAttribute(tag, 'ID');
    if (depth === 1) {
      if (tag.uri !== SAML_NAMESPACES.MD || tag.local !== 'EntitiesDescriptor') {
        throw new SAMLMetadataValidationError(
          'Invalid aggregate metadata: missing EntitiesDescriptor'
        );
      }
      rootId = id ?? '';
      if (!rootId) {
        throw new SAMLMetadataValidationError('Invalid aggregate metadata: missing root ID');
      }
      validUntil = getSaxesAttribute(tag, 'validUntil');
    }
    if (tag.uri === SAML_NAMESPACES.MD && tag.local === 'EntitiesDescriptor') {
      const descriptorValidUntil = getSaxesAttribute(tag, 'validUntil');
      assertAggregateMetadataIsCurrent(descriptorValidUntil);
      entitiesDescriptorValidityStack.push(descriptorValidUntil);
    }
    if (id === rootId && rootId) {
      rootIdOccurrences++;
    }

    if (
      captureEntityDepth === undefined &&
      tag.uri === SAML_NAMESPACES.MD &&
      tag.local === 'EntityDescriptor'
    ) {
      entityCount++;
      if (entityCount > AGGREGATE_XML_LIMITS.maxEntities) {
        throw new SAMLMetadataValidationError('Aggregate metadata exceeds maximum entity count');
      }
      const entityId = getSaxesAttribute(tag, 'entityID') ?? '';
      const entityValidUntil = getSaxesAttribute(tag, 'validUntil');
      assertAggregateMetadataIsCurrent(entityValidUntil);
      entityValidUntilOverride = earliestValidUntil([
        ...entitiesDescriptorValidityStack,
        entityValidUntil,
      ]);
      captureEntity = captureEntities && (!requestedEntityIds || requestedEntityIds.has(entityId));
      captureEntityDepth = depth;
      entityBuffer = [];
    } else if (
      captureEntityDepth !== undefined &&
      tag.uri === SAML_NAMESPACES.MD &&
      tag.local === 'EntityDescriptor'
    ) {
      throw new SAMLMetadataValidationError('Invalid aggregate metadata: nested EntityDescriptor');
    }

    if (captureEntity && captureEntityDepth !== undefined) {
      entityBuffer.push(
        serializeSaxesOpenTag(
          tag,
          depth === captureEntityDepth ? inScopeNamespaces : undefined,
          depth === captureEntityDepth && entityValidUntilOverride
            ? { validUntil: entityValidUntilOverride }
            : undefined
        )
      );
    }

    if (
      captureSignatureDepth === undefined &&
      depth === 2 &&
      tag.uri === SAML_NAMESPACES.DS &&
      tag.local === 'Signature'
    ) {
      if (rootSignatureXml) {
        throw new SAMLMetadataValidationError(
          'Invalid aggregate metadata: multiple root signatures'
        );
      }
      captureSignatureDepth = depth;
      signatureBuffer = [];
      signatureBytes = 0;
      signatureElementCount = 0;
      signatureAttributeCount = 0;
      countSignatureElement(tag);
      appendSignatureChunk(serializeSaxesOpenTag(tag, inScopeNamespaces));
    } else if (captureSignatureDepth !== undefined && depth > captureSignatureDepth) {
      countSignatureElement(tag);
      appendSignatureChunk(serializeSaxesOpenTag(tag));
    }
  });
  parser.on('text', (text) => {
    const escaped = escapeXmlText(text);
    if (captureEntity) entityBuffer.push(escaped);
    if (captureSignatureDepth !== undefined) appendSignatureChunk(escaped);
  });
  parser.on('cdata', (text) => {
    const escaped = escapeXmlText(text);
    if (captureEntity) entityBuffer.push(escaped);
    if (captureSignatureDepth !== undefined) appendSignatureChunk(escaped);
  });
  parser.on('closetag', (tag) => {
    if (captureEntity && captureEntityDepth !== undefined) {
      entityBuffer.push(`</${tag.name}>`);
    }
    if (captureSignatureDepth !== undefined) {
      appendSignatureChunk(`</${tag.name}>`);
    }

    if (captureEntityDepth === depth) {
      if (captureEntity) {
        entityXml.push(entityBuffer.join(''));
      }
      captureEntityDepth = undefined;
      captureEntity = false;
      entityBuffer = [];
    }
    if (captureSignatureDepth === depth) {
      rootSignatureXml = signatureBuffer.join('');
      captureSignatureDepth = undefined;
      signatureBuffer = [];
    }
    if (tag.uri === SAML_NAMESPACES.MD && tag.local === 'EntitiesDescriptor') {
      entitiesDescriptorValidityStack.pop();
    }
    namespaceStack.pop();
    depth--;
  });

  try {
    parser.write(xml).close();
  } catch (error) {
    throw toAggregateValidationError(error);
  }

  if (!rootId) {
    throw new SAMLMetadataValidationError('Invalid aggregate metadata: missing EntitiesDescriptor');
  }
  if (entityCount === 0) {
    throw new SAMLMetadataValidationError(
      'Invalid aggregate metadata: no EntityDescriptor entries'
    );
  }
  return { rootId, rootIdOccurrences, validUntil, rootSignatureXml, entityCount, entityXml };
}

function serializeSaxesOpenTag(
  tag: SaxesTagNS,
  inScopeNamespaces?: Readonly<Record<string, string>>,
  attributeOverrides?: Readonly<Record<string, string>>
): string {
  const attributes = Object.values(tag.attributes);
  const existingNames = new Set(attributes.map((attribute) => attribute.name));
  const serializedAttributes = attributes.map(
    (attribute) =>
      ` ${attribute.name}="${escapeXmlAttribute(
        attributeOverrides?.[attribute.name] ?? attribute.value
      )}"`
  );

  for (const [name, value] of Object.entries(attributeOverrides ?? {})) {
    if (!existingNames.has(name)) {
      serializedAttributes.push(` ${name}="${escapeXmlAttribute(value)}"`);
    }
  }

  if (inScopeNamespaces) {
    for (const [prefix, uri] of Object.entries(inScopeNamespaces)) {
      if (prefix === 'xml') continue;
      const name = prefix ? `xmlns:${prefix}` : 'xmlns';
      if (!existingNames.has(name)) {
        serializedAttributes.push(` ${name}="${escapeXmlAttribute(uri)}"`);
      }
    }
  }
  return `<${tag.name}${serializedAttributes.join('')}>`;
}

function earliestValidUntil(values: Array<string | undefined>): string | undefined {
  let earliest: { value: string; expiresAt: number } | undefined;
  for (const value of values) {
    if (!value) continue;
    const expiresAt = Date.parse(value);
    if (!Number.isFinite(expiresAt)) {
      throw new SAMLMetadataValidationError('Invalid aggregate metadata: invalid validUntil');
    }
    if (!earliest || expiresAt < earliest.expiresAt) earliest = { value, expiresAt };
  }
  return earliest?.value;
}

function getSaxesAttribute(tag: SaxesTagNS, name: string): string | undefined {
  return Object.values(tag.attributes).find((attribute) => attribute.name === name)?.value;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/\r/g, '&#13;');
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertAggregateMetadataIsCurrent(validUntil: string | undefined, now = Date.now()): void {
  if (!validUntil) return;
  const expiresAt = Date.parse(validUntil);
  if (!Number.isFinite(expiresAt)) {
    throw new SAMLMetadataValidationError('Invalid aggregate metadata: invalid validUntil');
  }
  if (expiresAt <= now) {
    throw new SAMLMetadataValidationError('Invalid aggregate metadata: expired validUntil');
  }
}

function toAggregateValidationError(error: unknown): SAMLMetadataValidationError {
  if (error instanceof SAMLMetadataValidationError) return error;
  return new SAMLMetadataValidationError(
    error instanceof Error
      ? `Invalid aggregate metadata: ${error.message}`
      : 'Invalid aggregate metadata'
  );
}
