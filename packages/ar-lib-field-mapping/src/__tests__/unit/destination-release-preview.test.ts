import { describe, expect, it } from 'vitest';
import { previewDestinationRelease } from '../../previews/destination-release';
import type { DestinationReleasePreviewInput } from '../../previews/destination-release';

const emailField = {
  side: 'canonical' as const,
  namespace: 'authrim.profile',
  path: 'email',
  catalogEntryId: 'field.canonical.email',
};

function baseInput(
  overrides: Partial<DestinationReleasePreviewInput> = {}
): DestinationReleasePreviewInput {
  return {
    destination: {
      protocol: 'oidc',
      destinationId: 'client-web',
      purpose: 'login',
    },
    values: [
      {
        fieldRef: emailField,
        outputName: 'email',
        classification: 'pii',
        valueType: 'string',
        legalBasis: 'contract',
        valueFingerprint: 'fp_email',
      },
    ],
    ...overrides,
  };
}

describe('previewDestinationRelease', () => {
  it('previews OIDC release and Advanced Syntax for Claims constraints without raw values', () => {
    const result = previewDestinationRelease(
      baseInput({
        oidcClaimsRequest: {
          email: { essential: true, values: ['person@example.test'], purpose: 'login' },
        },
      })
    );

    expect(result.status).toBe('success');
    expect(result.summary.releaseCount).toBe(1);
    expect(result.items[0]).toMatchObject({
      decision: 'release',
      output: {
        protocol: 'oidc',
        name: 'email',
      },
      oidcConstraint: {
        essential: true,
        requestedValueCount: 1,
        purpose: 'login',
      },
    });
    expect(JSON.stringify(result)).not.toContain('person@example.test');
  });

  it('previews SAML attribute release consent as omit when consent is required but missing', () => {
    const result = previewDestinationRelease(
      baseInput({
        destination: {
          protocol: 'saml',
          destinationId: 'sp-acme',
          purpose: 'login',
        },
        values: [
          {
            fieldRef: emailField,
            outputName: 'urn:oid:0.9.2342.19200300.100.1.3',
            outputNameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
            classification: 'pii',
            valueType: 'string',
            legalBasis: 'consent',
            consent: {
              required: true,
              granted: false,
              mode: 'until_attributes_change',
              attributeSetHash: 'attrs_v1_hash',
              statementId: 'saml-attribute-release',
              statementVersion: '2026-05-28',
            },
          },
        ],
        samlRequestedAttributes: [
          {
            name: 'urn:oid:0.9.2342.19200300.100.1.3',
            nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
            isRequired: false,
          },
        ],
      })
    );

    expect(result.status).toBe('partial');
    expect(result.summary.consentRequiredCount).toBe(1);
    expect(result.items[0]).toMatchObject({
      decision: 'omit',
      legalBasis: 'consent',
      consentPreview: {
        required: true,
        granted: false,
        mode: 'until_attributes_change',
        attributeSetHash: 'attrs_v1_hash',
      },
      samlRequestedAttribute: {
        requested: true,
        required: false,
      },
    });
    expect(result.items[0]?.reasons).toContainEqual({
      code: 'release.consent_required',
      severity: 'error',
      message: expect.any(String),
    });
  });

  it('denies regulated legal obligation data when destination purpose is not allowed', () => {
    const result = previewDestinationRelease(
      baseInput({
        destination: {
          protocol: 'oidc',
          destinationId: 'client-web',
          purpose: 'marketing',
        },
        values: [
          {
            fieldRef: {
              side: 'canonical',
              namespace: 'authrim.profile',
              path: 'governmentId',
              catalogEntryId: 'field.canonical.government_id',
            },
            outputName: 'government_id',
            classification: 'regulated',
            valueType: 'string',
            legalBasis: 'legal_obligation',
            allowedPurposes: ['tax_reporting'],
            valueFingerprint: 'fp_government_id',
          },
        ],
      })
    );

    expect(result.status).toBe('failed');
    expect(result.summary.regulatedDenyCount).toBe(1);
    expect(result.items[0]).toMatchObject({
      decision: 'deny',
      legalBasis: 'legal_obligation',
    });
    expect(result.items[0]?.reasons).toContainEqual({
      code: 'release.regulated_purpose_mismatch',
      severity: 'critical',
      message: expect.any(String),
    });
  });

  it('covers contract and legitimate interest paths as trace-only release decisions', () => {
    const result = previewDestinationRelease(
      baseInput({
        values: [
          {
            fieldRef: emailField,
            outputName: 'email',
            classification: 'pii',
            valueType: 'string',
            legalBasis: 'contract',
          },
          {
            fieldRef: {
              side: 'canonical',
              namespace: 'authrim.profile',
              path: 'locale',
              catalogEntryId: 'field.canonical.locale',
            },
            outputName: 'locale',
            classification: 'internal',
            valueType: 'string',
            legalBasis: 'legitimate_interest',
          },
        ],
      })
    );

    expect(result.status).toBe('success');
    expect(result.summary.releaseCount).toBe(2);
    expect(result.items.map((item) => item.reasons[0]?.code)).toEqual([
      'release.contract_trace_only',
      'release.legitimate_interest_trace_only',
    ]);
  });
});
