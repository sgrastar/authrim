import type {
  SAMLMetadataRefreshPolicy,
  SAMLMetadataCriticalFields,
  SAMLMetadataDiffSummary,
  SAMLMetadataEndpointSnapshot,
  SAMLMetadataRefreshStatus,
} from '@authrim/ar-lib-core';
import { fnv1a32 } from '@authrim/ar-lib-core';
import { SAML_NAMESPACES } from '../common/constants';
import {
  findElement,
  findElements,
  getAttribute,
  getTextContent,
  parseXml,
} from '../common/xml-utils';

export interface SAMLMetadataAnalysis {
  hash: string;
  criticalFields: SAMLMetadataCriticalFields;
}

export const DEFAULT_SAML_METADATA_REFRESH_INTERVAL_SECONDS = 6 * 60 * 60;
export const MIN_SAML_METADATA_REFRESH_INTERVAL_SECONDS = 15 * 60;
export const MAX_SAML_METADATA_REFRESH_INTERVAL_SECONDS = 7 * 24 * 60 * 60;

export function normalizeSAMLMetadataRefreshPolicy(
  policy: SAMLMetadataRefreshPolicy | undefined,
  metadataUrl: string | undefined,
  now = Date.now()
): SAMLMetadataRefreshPolicy {
  const requestedInterval = policy?.intervalSeconds;
  const intervalSeconds =
    typeof requestedInterval === 'number' && Number.isFinite(requestedInterval)
      ? Math.min(
          MAX_SAML_METADATA_REFRESH_INTERVAL_SECONDS,
          Math.max(MIN_SAML_METADATA_REFRESH_INTERVAL_SECONDS, Math.floor(requestedInterval))
        )
      : DEFAULT_SAML_METADATA_REFRESH_INTERVAL_SECONDS;
  const mode = metadataUrl ? (policy?.mode === 'manual' ? 'manual' : 'automatic') : 'manual';
  const validatorsMatchSource =
    !!metadataUrl && !!policy?.validatorSourceUrl && policy.validatorSourceUrl === metadataUrl;

  return {
    ...policy,
    mode,
    intervalSeconds,
    nextRefreshAt:
      policy?.nextRefreshAt ?? (mode === 'automatic' ? now + intervalSeconds * 1000 : undefined),
    consecutiveFailures: policy?.consecutiveFailures ?? 0,
    sourceState: policy?.sourceState ?? (metadataUrl ? 'healthy' : 'stale'),
    etag: validatorsMatchSource ? policy?.etag : undefined,
    lastModified: validatorsMatchSource ? policy?.lastModified : undefined,
    validatorSourceUrl: validatorsMatchSource ? policy?.validatorSourceUrl : undefined,
    acceptedValidUntil: validatorsMatchSource ? policy?.acceptedValidUntil : undefined,
  };
}

export function isSAMLMetadataRefreshDue(
  policy: SAMLMetadataRefreshPolicy | undefined,
  metadataUrl: string | undefined,
  now = Date.now()
): boolean {
  if (!metadataUrl) return false;
  if (policy?.mode === 'manual') return false;
  if (policy?.nextRefreshAt === undefined) return true;
  const normalized = normalizeSAMLMetadataRefreshPolicy(policy, metadataUrl, now);
  return normalized.mode === 'automatic' && (normalized.nextRefreshAt ?? 0) <= now;
}

export function markSAMLMetadataRefreshSuccess(
  policy: SAMLMetadataRefreshPolicy | undefined,
  metadataUrl: string,
  now = Date.now()
): SAMLMetadataRefreshPolicy {
  const normalized = normalizeSAMLMetadataRefreshPolicy(policy, metadataUrl, now);
  return {
    ...normalized,
    lastAttemptAt: now,
    lastSuccessAt: now,
    nextRefreshAt:
      normalized.mode === 'automatic' ? now + normalized.intervalSeconds * 1000 : undefined,
    consecutiveFailures: 0,
    sourceState: 'healthy',
    lastErrorCode: undefined,
    suspendedByMetadataSync: undefined,
  };
}

export function markSAMLMetadataRefreshFailure(
  policy: SAMLMetadataRefreshPolicy | undefined,
  metadataUrl: string,
  errorCode: string,
  sourceState: NonNullable<SAMLMetadataRefreshPolicy['sourceState']> = 'error',
  now = Date.now()
): SAMLMetadataRefreshPolicy {
  const normalized = normalizeSAMLMetadataRefreshPolicy(policy, metadataUrl, now);
  const consecutiveFailures = (normalized.consecutiveFailures ?? 0) + 1;
  const retrySeconds = Math.min(
    normalized.intervalSeconds,
    MIN_SAML_METADATA_REFRESH_INTERVAL_SECONDS * 2 ** Math.min(consecutiveFailures - 1, 5)
  );
  return {
    ...normalized,
    lastAttemptAt: now,
    nextRefreshAt: normalized.mode === 'automatic' ? now + retrySeconds * 1000 : undefined,
    consecutiveFailures,
    sourceState,
    lastErrorCode: errorCode,
  };
}

export function analyzeSAMLMetadata(xml: string): SAMLMetadataAnalysis {
  const doc = parseXml(xml);
  const entityDescriptor = findElement(doc, SAML_NAMESPACES.MD, 'EntityDescriptor');
  if (!entityDescriptor) {
    throw new Error('Invalid metadata: missing EntityDescriptor');
  }

  const entityId = getAttribute(entityDescriptor, 'entityID');
  if (!entityId) {
    throw new Error('Invalid metadata: missing entityID');
  }

  return {
    hash: buildSAMLMetadataHash(xml),
    criticalFields: {
      entityId,
      validUntil: getAttribute(entityDescriptor, 'validUntil') || undefined,
      certificates: extractMetadataCertificates(entityDescriptor),
      endpoints: extractMetadataEndpoints(entityDescriptor),
    },
  };
}

export function buildSAMLMetadataRefreshStatus(
  previous: SAMLMetadataAnalysis | undefined,
  current: SAMLMetadataAnalysis,
  now = Date.now()
): SAMLMetadataRefreshStatus {
  const diff = buildSAMLMetadataDiffSummary(previous, current, now);
  return {
    lastCheckedAt: now,
    lastChangedAt: diff.changed ? now : undefined,
    previousHash: previous?.hash,
    currentHash: current.hash,
    previous: previous?.criticalFields,
    current: current.criticalFields,
    diff,
  };
}

export function buildSAMLMetadataDiffSummary(
  previous: SAMLMetadataAnalysis | undefined,
  current: SAMLMetadataAnalysis,
  now = Date.now()
): SAMLMetadataDiffSummary {
  const validUntilMs = current.criticalFields.validUntil
    ? Date.parse(current.criticalFields.validUntil)
    : undefined;
  const expiresInSeconds =
    validUntilMs && Number.isFinite(validUntilMs)
      ? Math.floor((validUntilMs - now) / 1000)
      : undefined;
  const expired = typeof expiresInSeconds === 'number' ? expiresInSeconds <= 0 : false;

  if (!previous) {
    return {
      changed: true,
      currentHash: current.hash,
      entityIdChanged: false,
      validUntilChanged: false,
      certificatesAdded: current.criticalFields.certificates,
      certificatesRemoved: [],
      endpointsAdded: current.criticalFields.endpoints,
      endpointsRemoved: [],
      validUntil: current.criticalFields.validUntil,
      expiresInSeconds,
      expired,
    };
  }

  const certificatesAdded = difference(
    current.criticalFields.certificates,
    previous.criticalFields.certificates
  );
  const certificatesRemoved = difference(
    previous.criticalFields.certificates,
    current.criticalFields.certificates
  );
  const currentEndpointKeys = current.criticalFields.endpoints.map(buildEndpointKey);
  const previousEndpointKeys = previous.criticalFields.endpoints.map(buildEndpointKey);
  const endpointsAdded = current.criticalFields.endpoints.filter(
    (endpoint) => !previousEndpointKeys.includes(buildEndpointKey(endpoint))
  );
  const endpointsRemoved = previous.criticalFields.endpoints.filter(
    (endpoint) => !currentEndpointKeys.includes(buildEndpointKey(endpoint))
  );
  const entityIdChanged = previous.criticalFields.entityId !== current.criticalFields.entityId;
  const validUntilChanged =
    previous.criticalFields.validUntil !== current.criticalFields.validUntil;
  const changed =
    previous.hash !== current.hash ||
    entityIdChanged ||
    validUntilChanged ||
    certificatesAdded.length > 0 ||
    certificatesRemoved.length > 0 ||
    endpointsAdded.length > 0 ||
    endpointsRemoved.length > 0;

  return {
    changed,
    previousHash: previous.hash,
    currentHash: current.hash,
    entityIdChanged,
    validUntilChanged,
    certificatesAdded,
    certificatesRemoved,
    endpointsAdded,
    endpointsRemoved,
    validUntil: current.criticalFields.validUntil,
    expiresInSeconds,
    expired,
  };
}

function buildSAMLMetadataHash(xml: string): string {
  return fnv1a32(xml.replace(/\s+/g, ' ').trim()).toString(36);
}

function extractMetadataCertificates(entityDescriptor: Element): string[] {
  const certificates = findElements(entityDescriptor, SAML_NAMESPACES.DS, 'X509Certificate')
    .map((certificate) => getTextContent(certificate)?.replace(/\s+/g, '') || '')
    .filter(Boolean);
  return Array.from(new Set(certificates)).sort();
}

function extractMetadataEndpoints(entityDescriptor: Element): SAMLMetadataEndpointSnapshot[] {
  return [
    ...extractEndpointType(entityDescriptor, 'sso', 'SingleSignOnService'),
    ...extractEndpointType(entityDescriptor, 'slo', 'SingleLogoutService'),
    ...extractEndpointType(entityDescriptor, 'acs', 'AssertionConsumerService'),
  ].sort((a, b) => buildEndpointKey(a).localeCompare(buildEndpointKey(b)));
}

function extractEndpointType(
  entityDescriptor: Element,
  type: SAMLMetadataEndpointSnapshot['type'],
  localName: string
): SAMLMetadataEndpointSnapshot[] {
  return findElements(entityDescriptor, SAML_NAMESPACES.MD, localName)
    .map((endpoint) => ({
      type,
      binding: getAttribute(endpoint, 'Binding') || '',
      location: getAttribute(endpoint, 'Location') || '',
      responseLocation: getAttribute(endpoint, 'ResponseLocation') || undefined,
      index: parseOptionalNonNegativeInteger(getAttribute(endpoint, 'index')) ?? undefined,
    }))
    .filter((endpoint) => endpoint.binding && endpoint.location);
}

function buildEndpointKey(endpoint: SAMLMetadataEndpointSnapshot): string {
  return [
    endpoint.type,
    endpoint.binding,
    endpoint.location,
    endpoint.responseLocation ?? '',
    endpoint.index ?? '',
  ].join('\u0000');
}

function difference(values: string[], excludedValues: string[]): string[] {
  return values.filter((value) => !excludedValues.includes(value));
}

function parseOptionalNonNegativeInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
