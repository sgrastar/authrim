import { describe, expect, it } from 'vitest';
import {
  evaluateReleaseConsentGate,
  RELEASE_DECISION_REASON_CODES,
} from '../identity-release-consent';

describe('evaluateReleaseConsentGate', () => {
  it('requires a consent challenge for consent legal basis without satisfied consent', () => {
    expect(
      evaluateReleaseConsentGate({
        fieldRef: { namespace: 'authrim.profile', path: 'email' },
        legalBasis: 'consent',
        consentSatisfied: false,
        consentStatementId: 'statement-email-release',
      })
    ).toMatchObject({
      action: 'challenge',
      challenge: {
        challengeType: 'consent_statement',
        statementId: 'statement-email-release',
      },
      reasonCodes: [RELEASE_DECISION_REASON_CODES.consentMissing],
    });
  });

  it('denies regulated legal obligation release when purpose does not match', () => {
    expect(
      evaluateReleaseConsentGate({
        fieldRef: { namespace: 'authrim.regulated', path: 'individualNumber' },
        legalBasis: 'legal_obligation',
        classification: 'regulated',
        purpose: 'analytics',
        requiredPurpose: 'tax_reporting',
        consentSatisfied: true,
      })
    ).toMatchObject({
      action: 'deny',
      reasonCodes: [RELEASE_DECISION_REASON_CODES.legalObligationPurposeMismatch],
    });
  });

  it('records contract and legitimate interest as trace-only release basis', () => {
    expect(
      evaluateReleaseConsentGate({
        fieldRef: { namespace: 'authrim.profile', path: 'department' },
        legalBasis: 'contract',
      })
    ).toMatchObject({
      action: 'release',
      reasonCodes: [RELEASE_DECISION_REASON_CODES.disclosureBasisTraceOnly],
    });
  });

  it('re-challenges attribute release consent when the released attribute set changes', () => {
    expect(
      evaluateReleaseConsentGate({
        fieldRef: { namespace: 'saml', path: 'attributes' },
        legalBasis: 'consent',
        consentSatisfied: true,
        attributeRelease: {
          mode: 'until_attributes_change',
          currentAttributeSetHash: 'hash-v2',
          existingAttributeSetHash: 'hash-v1',
          existingConsentState: 'granted',
        },
      })
    ).toMatchObject({
      action: 'challenge',
      challenge: {
        challengeType: 'attribute_release',
        consentMode: 'until_attributes_change',
        attributeSetHash: 'hash-v2',
      },
      reasonCodes: [
        RELEASE_DECISION_REASON_CODES.consentSatisfied,
        RELEASE_DECISION_REASON_CODES.attributeReleaseChanged,
      ],
    });
  });

  it('does not allow raw released attribute values in release trace metadata', () => {
    expect(() =>
      evaluateReleaseConsentGate({
        fieldRef: { namespace: 'saml', path: 'mail' },
        legalBasis: 'contract',
        traceMetadata: { rawValue: 'person@example.edu' },
      })
    ).toThrow(/raw released attribute values/);
  });
});
