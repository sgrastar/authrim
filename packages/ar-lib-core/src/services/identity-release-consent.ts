export type ReleaseLegalBasis = 'consent' | 'legal_obligation' | 'contract' | 'legitimate_interest';

export type AttributeReleaseConsentMode = 'once' | 'every_time' | 'until_attributes_change';
export type ReleaseDecisionAction = 'release' | 'challenge' | 'deny';

export interface AttributeReleaseConsentContext {
  mode: AttributeReleaseConsentMode;
  currentAttributeSetHash: string;
  existingConsentState?: 'granted' | 'denied' | 'revoked' | 'expired' | null;
  existingAttributeSetHash?: string | null;
  consentRecordId?: string | null;
}

export interface ReleaseDecisionInput {
  fieldRef: Record<string, unknown>;
  legalBasis: ReleaseLegalBasis;
  classification?: string | null;
  purpose?: string | null;
  requiredPurpose?: string | null;
  consentSatisfied?: boolean;
  consentStatementId?: string | null;
  attributeRelease?: AttributeReleaseConsentContext | null;
  traceMetadata?: Record<string, unknown> | null;
}

export interface ReleaseDecisionResult {
  action: ReleaseDecisionAction;
  legalBasis: ReleaseLegalBasis;
  reasonCodes: string[];
  challenge?: {
    challengeType: 'consent_statement' | 'attribute_release';
    statementId?: string | null;
    consentMode?: AttributeReleaseConsentMode | null;
    attributeSetHash?: string | null;
  };
  trace: {
    fieldRef: Record<string, unknown>;
    classification: string;
    purpose: string | null;
    basis: ReleaseLegalBasis;
    consentRecordId: string | null;
    metadata: Record<string, unknown> | null;
  };
}

const RAW_VALUE_KEYS = new Set([
  'attributeValue',
  'email',
  'nameId',
  'phoneNumber',
  'raw',
  'rawValue',
  'secret',
  'sub',
  'token',
  'value',
]);

export const RELEASE_DECISION_REASON_CODES = {
  consentMissing: 'release.consent.missing',
  consentSatisfied: 'release.consent.satisfied',
  attributeReleaseMissing: 'release.attribute_consent.missing',
  attributeReleaseEveryTime: 'release.attribute_consent.every_time',
  attributeReleaseChanged: 'release.attribute_consent.attribute_set_changed',
  attributeReleaseSatisfied: 'release.attribute_consent.satisfied',
  legalObligationPurposeMismatch: 'release.legal_obligation.purpose_mismatch',
  legalObligationSatisfied: 'release.legal_obligation.satisfied',
  disclosureBasisTraceOnly: 'release.disclosure_basis.trace_only',
} as const;

export function evaluateReleaseConsentGate(input: ReleaseDecisionInput): ReleaseDecisionResult {
  assertNoRawReleaseMetadata(input.fieldRef, 'fieldRef');
  assertNoRawReleaseMetadata(input.traceMetadata ?? null, 'traceMetadata');

  const classification = input.classification ?? 'internal';
  const baseTrace = {
    fieldRef: input.fieldRef,
    classification,
    purpose: input.purpose ?? null,
    basis: input.legalBasis,
    consentRecordId: input.attributeRelease?.consentRecordId ?? null,
    metadata: input.traceMetadata ?? null,
  };

  if (
    input.legalBasis === 'legal_obligation' &&
    classification === 'regulated' &&
    input.requiredPurpose &&
    input.purpose !== input.requiredPurpose
  ) {
    return {
      action: 'deny',
      legalBasis: input.legalBasis,
      reasonCodes: [RELEASE_DECISION_REASON_CODES.legalObligationPurposeMismatch],
      trace: baseTrace,
    };
  }

  if (input.legalBasis === 'legal_obligation') {
    return {
      action: 'release',
      legalBasis: input.legalBasis,
      reasonCodes: [RELEASE_DECISION_REASON_CODES.legalObligationSatisfied],
      trace: baseTrace,
    };
  }

  if (input.legalBasis === 'contract' || input.legalBasis === 'legitimate_interest') {
    return {
      action: 'release',
      legalBasis: input.legalBasis,
      reasonCodes: [RELEASE_DECISION_REASON_CODES.disclosureBasisTraceOnly],
      trace: baseTrace,
    };
  }

  if (!input.consentSatisfied) {
    return {
      action: 'challenge',
      legalBasis: input.legalBasis,
      reasonCodes: [RELEASE_DECISION_REASON_CODES.consentMissing],
      challenge: {
        challengeType: 'consent_statement',
        statementId: input.consentStatementId ?? null,
      },
      trace: baseTrace,
    };
  }

  const attributeReleaseDecision = evaluateAttributeReleaseConsent(input.attributeRelease ?? null);
  if (attributeReleaseDecision.action === 'challenge') {
    return {
      action: 'challenge',
      legalBasis: input.legalBasis,
      reasonCodes: [
        RELEASE_DECISION_REASON_CODES.consentSatisfied,
        ...attributeReleaseDecision.reasonCodes,
      ],
      challenge: attributeReleaseDecision.challenge,
      trace: baseTrace,
    };
  }

  return {
    action: 'release',
    legalBasis: input.legalBasis,
    reasonCodes: [
      RELEASE_DECISION_REASON_CODES.consentSatisfied,
      ...attributeReleaseDecision.reasonCodes,
    ],
    trace: baseTrace,
  };
}

function evaluateAttributeReleaseConsent(attributeRelease: AttributeReleaseConsentContext | null): {
  action: 'release' | 'challenge';
  reasonCodes: string[];
  challenge?: ReleaseDecisionResult['challenge'];
} {
  if (!attributeRelease) {
    return { action: 'release', reasonCodes: [] };
  }

  if (attributeRelease.mode === 'every_time') {
    return {
      action: 'challenge',
      reasonCodes: [RELEASE_DECISION_REASON_CODES.attributeReleaseEveryTime],
      challenge: {
        challengeType: 'attribute_release',
        consentMode: attributeRelease.mode,
        attributeSetHash: attributeRelease.currentAttributeSetHash,
      },
    };
  }

  if (attributeRelease.existingConsentState !== 'granted') {
    return {
      action: 'challenge',
      reasonCodes: [RELEASE_DECISION_REASON_CODES.attributeReleaseMissing],
      challenge: {
        challengeType: 'attribute_release',
        consentMode: attributeRelease.mode,
        attributeSetHash: attributeRelease.currentAttributeSetHash,
      },
    };
  }

  if (
    attributeRelease.mode === 'until_attributes_change' &&
    attributeRelease.existingAttributeSetHash !== attributeRelease.currentAttributeSetHash
  ) {
    return {
      action: 'challenge',
      reasonCodes: [RELEASE_DECISION_REASON_CODES.attributeReleaseChanged],
      challenge: {
        challengeType: 'attribute_release',
        consentMode: attributeRelease.mode,
        attributeSetHash: attributeRelease.currentAttributeSetHash,
      },
    };
  }

  return {
    action: 'release',
    reasonCodes: [RELEASE_DECISION_REASON_CODES.attributeReleaseSatisfied],
  };
}

function assertNoRawReleaseMetadata(value: unknown, path: string): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawReleaseMetadata(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object') {
    return;
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (RAW_VALUE_KEYS.has(key)) {
      throw new Error(`${path}.${key} must not contain raw released attribute values`);
    }
    assertNoRawReleaseMetadata(item, `${path}.${key}`);
  }
}
