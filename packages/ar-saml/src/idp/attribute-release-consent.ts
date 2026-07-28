import type {
  AttributeReleaseConsentMode,
  AttributeReleaseConsentPolicy,
  Env,
  SAMLAttribute,
  SAMLRequestContext,
  SAMLSPConfig,
} from '@authrim/ar-lib-core';
import {
  AttributeReleaseConsentRepository,
  evaluateReleaseConsentGate,
  resolveClientTrustPolicy,
  resolveConsentRequirements,
  resolveAuthCorePersistenceAdapterFromEnv,
} from '@authrim/ar-lib-core';

export const SAML_ATTRIBUTE_RELEASE_CONSENT_MODES = new Set<AttributeReleaseConsentMode>([
  'once',
  'every_time',
  'until_attributes_change',
]);

export interface SAMLAttributeReleaseConsentCheckResult {
  action: 'release' | 'challenge';
  attributeSetHash: string | null;
  reasonCodes: string[];
}

export class SAMLAttributeReleaseConsentRequiredError extends Error {
  readonly attributeSetHash: string;
  readonly reasonCodes: string[];
  readonly consentMode: AttributeReleaseConsentMode;
  readonly attributeSummaries: SAMLAttributeReleaseConsentAttributeSummary[];

  constructor(input: {
    attributeSetHash: string;
    reasonCodes: string[];
    consentMode: AttributeReleaseConsentMode;
    attributes: SAMLAttribute[];
  }) {
    super('SAML attribute release consent is required');
    this.name = 'SAMLAttributeReleaseConsentRequiredError';
    this.attributeSetHash = input.attributeSetHash;
    this.reasonCodes = input.reasonCodes;
    this.consentMode = input.consentMode;
    this.attributeSummaries = summarizeSAMLAttributes(input.attributes);
  }
}

export interface SAMLAttributeReleaseConsentAttributeSummary {
  name: string;
  friendlyName?: string;
  nameFormat?: string;
  valueCount: number;
}

export function normalizeAttributeReleaseConsentPolicy(
  value: unknown
): AttributeReleaseConsentPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const mode = source.mode;
  if (
    mode !== undefined &&
    !SAML_ATTRIBUTE_RELEASE_CONSENT_MODES.has(mode as AttributeReleaseConsentMode)
  ) {
    return null;
  }
  return {
    enabled: source.enabled === true,
    mode: (mode as AttributeReleaseConsentMode | undefined) ?? 'once',
  };
}

export async function enforceSAMLAttributeReleaseConsent(input: {
  env: Env;
  tenantId: string;
  subjectId: string;
  spConfig: SAMLSPConfig;
  attributes: SAMLAttribute[];
  confirmedRelease?: SAMLRequestContext['attributeReleaseConsentConfirmed'];
  destinationFieldConsentConfirmed?: {
    consentRecordId: string;
  };
}): Promise<SAMLAttributeReleaseConsentCheckResult> {
  if (input.attributes.length === 0) {
    return { action: 'release', attributeSetHash: null, reasonCodes: [] };
  }

  let policy = normalizeAttributeReleaseConsentPolicy(input.spConfig.attributeReleaseConsent);
  const attributeSetHash = await buildSAMLAttributeSetHash(input.attributes);
  if (
    policy?.enabled &&
    confirmedAttributeReleaseMatches({
      confirmedRelease: input.confirmedRelease,
      subjectId: input.subjectId,
      destinationId: input.spConfig.entityId,
      attributeSetHash,
    })
  ) {
    return {
      action: 'release',
      attributeSetHash,
      reasonCodes: ['release.attribute_consent.transaction_confirmed'],
    };
  }

  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
    input.env,
    'saml-attribute-release-consent'
  );
  const trustPolicy = await resolveClientTrustPolicy(
    adapter,
    input.tenantId,
    'saml_sp',
    input.spConfig.entityId
  );
  if (trustPolicy?.trusted || trustPolicy?.skip_authorization_consent) {
    return { action: 'release', attributeSetHash: null, reasonCodes: ['release.trusted_saml_sp'] };
  }

  if (!policy?.enabled) {
    try {
      const policyRequirements = await resolveConsentRequirements(
        adapter,
        input.tenantId,
        input.spConfig.entityId,
        {},
        {
          target_type: 'saml_sp',
          target_id: input.spConfig.entityId,
          requested_saml_attributes: input.attributes.map((attribute) => attribute.name),
        }
      );
      if (policyRequirements.some((requirement) => requirement.is_required)) {
        policy = { enabled: true, mode: 'once' };
      }
    } catch {
      policy = null;
    }
  }

  if (!policy?.enabled) {
    return { action: 'release', attributeSetHash: null, reasonCodes: [] };
  }

  const repository = new AttributeReleaseConsentRepository(adapter);
  if (input.destinationFieldConsentConfirmed) {
    if (policy.mode !== 'every_time') {
      await repository.grant({
        tenant_id: input.tenantId,
        subject_id: input.subjectId,
        destination_type: 'saml_sp',
        destination_id: input.spConfig.entityId,
        attribute_set_hash: attributeSetHash,
        consent_mode: policy.mode,
        consent_record_id: input.destinationFieldConsentConfirmed.consentRecordId,
      });
    }
    return {
      action: 'release',
      attributeSetHash,
      reasonCodes: ['release.attribute_consent.transaction_confirmed'],
    };
  }

  if (
    confirmedAttributeReleaseMatches({
      confirmedRelease: input.confirmedRelease,
      subjectId: input.subjectId,
      destinationId: input.spConfig.entityId,
      attributeSetHash,
    })
  ) {
    return {
      action: 'release',
      attributeSetHash,
      reasonCodes: ['release.attribute_consent.transaction_confirmed'],
    };
  }

  const existingConsent =
    policy.mode === 'until_attributes_change'
      ? ((await repository.findGrantedConsent({
          tenant_id: input.tenantId,
          subject_id: input.subjectId,
          destination_type: 'saml_sp',
          destination_id: input.spConfig.entityId,
          attribute_set_hash: attributeSetHash,
        })) ??
        (await repository.findLatestGrantedConsentForDestination({
          tenant_id: input.tenantId,
          subject_id: input.subjectId,
          destination_type: 'saml_sp',
          destination_id: input.spConfig.entityId,
        })))
      : await repository.findLatestGrantedConsentForDestination({
          tenant_id: input.tenantId,
          subject_id: input.subjectId,
          destination_type: 'saml_sp',
          destination_id: input.spConfig.entityId,
        });

  const decision = evaluateReleaseConsentGate({
    fieldRef: {
      namespace: 'saml.attribute',
      path: '*',
      destinationType: 'saml_sp',
      destinationId: input.spConfig.entityId,
    },
    legalBasis: 'consent',
    consentSatisfied: true,
    attributeRelease: {
      mode: policy.mode,
      currentAttributeSetHash: attributeSetHash,
      existingConsentState: normalizeAttributeReleaseConsentState(existingConsent?.consent_state),
      existingAttributeSetHash: existingConsent?.attribute_set_hash ?? null,
      consentRecordId: existingConsent?.consent_record_id ?? null,
    },
    traceMetadata: {
      protocol: 'saml',
      attributeCount: input.attributes.length,
    },
  });

  if (decision.action === 'challenge') {
    throw new SAMLAttributeReleaseConsentRequiredError({
      attributeSetHash,
      reasonCodes: decision.reasonCodes,
      consentMode: policy.mode,
      attributes: input.attributes,
    });
  }

  return {
    action: 'release',
    attributeSetHash,
    reasonCodes: decision.reasonCodes,
  };
}

function confirmedAttributeReleaseMatches(input: {
  confirmedRelease?: SAMLRequestContext['attributeReleaseConsentConfirmed'];
  subjectId: string;
  destinationId: string;
  attributeSetHash: string;
}): boolean {
  const confirmed = input.confirmedRelease;
  if (!confirmed) {
    return false;
  }
  return (
    confirmed.subjectId === input.subjectId &&
    confirmed.destinationType === 'saml_sp' &&
    confirmed.destinationId === input.destinationId &&
    confirmed.attributeSetHash === input.attributeSetHash &&
    Date.now() - confirmed.confirmedAt <= 5 * 60 * 1000
  );
}

function normalizeAttributeReleaseConsentState(
  value: string | undefined
): 'granted' | 'denied' | 'revoked' | 'expired' | null {
  return value === 'granted' || value === 'denied' || value === 'revoked' || value === 'expired'
    ? value
    : null;
}

function summarizeSAMLAttributes(
  attributes: SAMLAttribute[]
): SAMLAttributeReleaseConsentAttributeSummary[] {
  return attributes.map((attribute) => ({
    name: attribute.name,
    friendlyName: attribute.friendlyName,
    nameFormat: attribute.nameFormat,
    valueCount: attribute.values.length,
  }));
}

export async function buildSAMLAttributeSetHash(attributes: SAMLAttribute[]): Promise<string> {
  const canonical = await Promise.all(
    attributes.map(async (attribute) => ({
      name: attribute.name,
      nameFormat: attribute.nameFormat ?? null,
      friendlyName: attribute.friendlyName ?? null,
      valueType: attribute.valueType ?? null,
      valueHashes: (await Promise.all(attribute.values.map((value) => sha256Hex(value))))
        .map((value) => `sha256:${value}`)
        .sort(),
    }))
  );
  canonical.sort(
    (left, right) =>
      [
        left.name.localeCompare(right.name),
        (left.nameFormat ?? '').localeCompare(right.nameFormat ?? ''),
        (left.friendlyName ?? '').localeCompare(right.friendlyName ?? ''),
      ].find((value) => value !== 0) ?? 0
  );
  const digest = await sha256Hex(JSON.stringify(canonical));
  return `sha256:${digest}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
