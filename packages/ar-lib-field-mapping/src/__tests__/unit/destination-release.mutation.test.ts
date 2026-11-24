import { describe, expect, it } from 'vitest';
import {
  previewDestinationRelease,
  type DestinationReleasePreviewDestination,
  type DestinationReleasePreviewInput,
  type DestinationReleaseValueInput,
  type ReleaseReason,
} from '../../previews/destination-release';
import type { FieldRef } from '../../core/types';

const fieldRef: FieldRef = { side: 'canonical', namespace: 'authrim.profile', path: 'email' };
const oidc: DestinationReleasePreviewDestination = {
  protocol: 'oidc',
  destinationId: 'client-1',
  purpose: 'login',
};
const saml: DestinationReleasePreviewDestination = {
  protocol: 'saml',
  destinationId: 'sp-1',
  purpose: 'login',
};

function value(
  overrides: Partial<DestinationReleaseValueInput> = {}
): DestinationReleaseValueInput {
  return {
    fieldRef,
    outputName: 'email',
    classification: 'pii',
    valueType: 'string',
    legalBasis: 'contract',
    ...overrides,
  };
}

function preview(
  values: DestinationReleaseValueInput[],
  extra: Partial<DestinationReleasePreviewInput> = {},
  destination = oidc
) {
  return previewDestinationRelease({ destination, values, ...extra });
}

function codes(reasons: ReleaseReason[]): string[] {
  return reasons.map((reason) => reason.code);
}

describe('destination release item defaults', () => {
  it('fills defaults for optional value fields', () => {
    const [item] = preview([value()]).items;
    expect(item).toEqual({
      fieldRef,
      output: { protocol: 'oidc', name: 'email', nameFormat: null },
      decision: 'release',
      legalBasis: 'contract',
      classification: 'pii',
      valueType: 'string',
      cardinality: 'single',
      presence: 'present',
      valueFingerprint: null,
      reasons: [
        {
          code: 'release.contract_trace_only',
          severity: 'info',
          message:
            'Release does not require consent, but the legal basis is retained in the trace.',
        },
      ],
      oidcConstraint: null,
      samlRequestedAttribute: null,
      consentPreview: null,
    });
  });

  it('keeps provided optional value fields', () => {
    const [item] = preview([
      value({
        outputNameFormat: 'urn:format',
        cardinality: 'multi',
        valueFingerprint: 'fp-1',
        legalBasis: 'legitimate_interest',
      }),
    ]).items;
    expect(item).toMatchObject({
      output: { protocol: 'oidc', name: 'email', nameFormat: 'urn:format' },
      cardinality: 'multi',
      valueFingerprint: 'fp-1',
    });
    expect(codes(item?.reasons ?? [])).toEqual(['release.legitimate_interest_trace_only']);
  });

  it('echoes the destination and the field count', () => {
    const result = preview([value(), value({ outputName: 'other' })]);
    expect(result.destination).toBe(oidc);
    expect(result.summary.totalFields).toBe(2);
  });
});

describe('destination release missing values', () => {
  const missingReason = (severity: ReleaseReason['severity']): ReleaseReason => ({
    code: 'release.value_missing',
    severity,
    message: 'The source value is not present for this destination field.',
  });

  it.each(['missing', 'empty'] as const)('omits a %s value with a warning', (presence) => {
    const [item] = preview([value({ presence, legalBasis: 'legal_obligation' })]).items;
    expect(item?.presence).toBe(presence);
    expect(item?.decision).toBe('omit');
    expect(item?.reasons[0]).toEqual(missingReason('warning'));
  });

  it('keeps a present value free of the missing reason', () => {
    const [item] = preview([value({ presence: 'present' })]).items;
    expect(codes(item?.reasons ?? [])).not.toContain('release.value_missing');
  });

  it('denies a missing value that an essential OIDC claim requires', () => {
    const [item] = preview([value({ presence: 'missing' })], {
      oidcClaimsRequest: { email: { essential: true } },
    }).items;
    expect(item?.decision).toBe('deny');
    expect(item?.reasons[0]).toEqual(missingReason('critical'));
  });

  it('omits a missing value for a claim that is requested but not essential', () => {
    const [item] = preview([value({ presence: 'missing' })], {
      oidcClaimsRequest: { email: { essential: false } },
    }).items;
    expect(item?.decision).toBe('omit');
    expect(item?.reasons[0]).toEqual(missingReason('warning'));
  });

  it('denies a missing value that a required SAML attribute requests', () => {
    const [item] = preview(
      [value({ presence: 'missing' })],
      { samlRequestedAttributes: [{ name: 'email', isRequired: true }] },
      saml
    ).items;
    expect(item?.decision).toBe('deny');
    expect(item?.reasons[0]).toEqual(missingReason('critical'));
  });

  it('omits a missing value for an optional SAML attribute', () => {
    const [item] = preview(
      [value({ presence: 'missing' })],
      { samlRequestedAttributes: [{ name: 'email', isRequired: false }] },
      saml
    ).items;
    expect(item?.decision).toBe('omit');
  });

  it('ignores protocol constraints of the other protocol', () => {
    const forSaml = preview(
      [value({ presence: 'missing' })],
      { oidcClaimsRequest: { email: { essential: true } } },
      saml
    ).items[0];
    expect(forSaml?.decision).toBe('omit');
    expect(forSaml?.oidcConstraint).toBeNull();
    const forOidc = preview([value({ presence: 'missing' })], {
      samlRequestedAttributes: [{ name: 'email', isRequired: true }],
    }).items[0];
    expect(forOidc?.decision).toBe('omit');
    expect(forOidc?.samlRequestedAttribute).toBeNull();
  });
});

describe('destination release legal basis', () => {
  const regulated = (overrides: Partial<DestinationReleaseValueInput> = {}) =>
    value({ classification: 'regulated', allowedPurposes: ['audit'], ...overrides });

  it('denies regulated data for a purpose that is not allowed', () => {
    const [item] = preview([regulated({ legalBasis: 'legal_obligation' })]).items;
    expect(item?.decision).toBe('deny');
    expect(item?.reasons).toEqual([
      {
        code: 'release.regulated_purpose_mismatch',
        severity: 'critical',
        message: 'Regulated data cannot be released for the requested destination purpose.',
      },
    ]);
  });

  it.each(['legal_obligation', 'contract', 'legitimate_interest', 'consent'] as const)(
    'skips the basis specific reason after a purpose mismatch for the %s basis',
    (legalBasis) => {
      const [item] = preview([
        regulated({
          legalBasis,
          consent: { required: true, granted: true },
        }),
      ]).items;
      expect(
        codes(item?.reasons ?? []).filter((code) => !code.startsWith('release.consent'))
      ).toEqual(['release.regulated_purpose_mismatch']);
    }
  );

  it('releases regulated data for an allowed purpose', () => {
    const [item] = preview([regulated({ allowedPurposes: ['audit', 'login'] })]).items;
    expect(item?.decision).toBe('release');
    expect(codes(item?.reasons ?? [])).toEqual(['release.contract_trace_only']);
  });

  it('does not check purposes when none are listed or the data is not regulated', () => {
    expect(codes(preview([regulated({ allowedPurposes: [] })]).items[0]?.reasons ?? [])).toEqual([
      'release.contract_trace_only',
    ]);
    expect(
      codes(preview([regulated({ allowedPurposes: undefined })]).items[0]?.reasons ?? [])
    ).toEqual(['release.contract_trace_only']);
    expect(
      codes(
        preview([value({ classification: 'pii', allowedPurposes: ['audit'] })]).items[0]?.reasons ??
          []
      )
    ).toEqual(['release.contract_trace_only']);
  });

  it('notes the legal obligation check', () => {
    const [item] = preview([value({ legalBasis: 'legal_obligation' })]).items;
    expect(item?.reasons).toEqual([
      {
        code: 'release.legal_obligation_purpose_checked',
        severity: 'info',
        message: 'Release is evaluated through legal obligation and purpose limitation.',
      },
    ]);
    expect(item?.decision).toBe('release');
  });

  it.each(['contract', 'legitimate_interest'] as const)(
    'traces the %s basis only',
    (legalBasis) => {
      const [item] = preview([value({ legalBasis })]).items;
      expect(item?.reasons).toEqual([
        {
          code: `release.${legalBasis}_trace_only`,
          severity: 'info',
          message:
            'Release does not require consent, but the legal basis is retained in the trace.',
        },
      ]);
    }
  );
});

describe('destination release consent', () => {
  it('notes a consent basis without a required gate', () => {
    const notRequired = {
      code: 'release.consent_not_required',
      severity: 'info',
      message: 'Consent legal basis is configured without a required consent gate.',
    };
    expect(preview([value({ legalBasis: 'consent' })]).items[0]?.reasons).toEqual([notRequired]);
    expect(
      preview([value({ legalBasis: 'consent', consent: { required: false, granted: true } })])
        .items[0]?.reasons
    ).toEqual([notRequired]);
  });

  it('notes granted consent', () => {
    const [item] = preview([
      value({ legalBasis: 'consent', consent: { required: true, granted: true } }),
    ]).items;
    expect(item?.decision).toBe('release');
    expect(item?.reasons).toEqual([
      {
        code: 'release.consent_granted',
        severity: 'info',
        message: 'Required consent has been granted for this release preview.',
      },
    ]);
  });

  it('omits the value while required consent is missing', () => {
    const [item] = preview([
      value({ legalBasis: 'consent', consent: { required: true, granted: false } }),
    ]).items;
    expect(item?.decision).toBe('omit');
    expect(item?.reasons).toEqual([
      {
        code: 'release.consent_required',
        severity: 'error',
        message: 'Required consent has not been granted for this release preview.',
      },
    ]);
  });

  it('ignores consent details for other legal bases', () => {
    const [item] = preview([
      value({ legalBasis: 'contract', consent: { required: true, granted: false } }),
    ]).items;
    expect(codes(item?.reasons ?? [])).toEqual(['release.contract_trace_only']);
    expect(item?.decision).toBe('release');
  });

  it('previews the consent configuration', () => {
    const [item] = preview([
      value({
        legalBasis: 'consent',
        consent: {
          required: true,
          granted: true,
          mode: 'every_time',
          attributeSetHash: 'hash-1',
          statementId: 'statement-1',
          statementVersion: '2',
        },
      }),
    ]).items;
    expect(item?.consentPreview).toEqual({
      required: true,
      granted: true,
      mode: 'every_time',
      attributeSetHash: 'hash-1',
      statementId: 'statement-1',
      statementVersion: '2',
    });
    const [bare] = preview([
      value({ legalBasis: 'consent', consent: { required: false, granted: false } }),
    ]).items;
    expect(bare?.consentPreview).toEqual({
      required: false,
      granted: false,
      mode: null,
      attributeSetHash: null,
      statementId: null,
      statementVersion: null,
    });
  });
});

describe('destination release protocol constraints', () => {
  it('notes essential OIDC claims', () => {
    const [item] = preview([value()], { oidcClaimsRequest: { email: { essential: true } } }).items;
    expect(item?.oidcConstraint).toEqual({
      essential: true,
      requestedValueCount: 0,
      purpose: null,
    });
    expect(item?.reasons.slice(-1)).toEqual([
      {
        code: 'release.oidc_essential_claim_requested',
        severity: 'info',
        message: 'OIDC claims request marks this claim as essential.',
      },
    ]);
  });

  it.each([
    ['null', null],
    ['an empty constraint', {}],
    ['a non-essential claim', { essential: false }],
    ['a non-boolean essential flag', { essential: 'yes' as unknown as boolean }],
  ])('does not mark %s as essential', (_name, constraint) => {
    const [item] = preview([value()], { oidcClaimsRequest: { email: constraint } }).items;
    expect(codes(item?.reasons ?? [])).not.toContain('release.oidc_essential_claim_requested');
  });

  it('keeps unrequested claims out of the constraint preview', () => {
    const [item] = preview([value()], { oidcClaimsRequest: { other: { essential: true } } }).items;
    expect(item?.oidcConstraint).toBeNull();
    expect(preview([value()]).items[0]?.oidcConstraint).toBeNull();
    expect(
      preview([value()], { oidcClaimsRequest: { email: null } }).items[0]?.oidcConstraint
    ).toBeNull();
  });

  it('counts requested values and previews their constraint', () => {
    const constraint = (claim: object) =>
      preview([value()], { oidcClaimsRequest: { email: claim } }).items[0];
    expect(constraint({ value: 'a' })?.oidcConstraint).toEqual({
      essential: false,
      requestedValueCount: 1,
      purpose: null,
    });
    expect(constraint({ values: ['a', 'b', 'c'], purpose: 'audit' })?.oidcConstraint).toEqual({
      essential: false,
      requestedValueCount: 3,
      purpose: 'audit',
    });
    expect(constraint({ values: [], value: 'a' })?.oidcConstraint?.requestedValueCount).toBe(0);
    expect(constraint({ value: null })?.oidcConstraint?.requestedValueCount).toBe(1);
    expect(constraint({ value: undefined })?.oidcConstraint?.requestedValueCount).toBe(0);
    expect(constraint({ essential: true })?.oidcConstraint?.requestedValueCount).toBe(0);
    expect(codes(constraint({ value: 'a' })?.reasons ?? [])).toContain(
      'release.oidc_value_constraint_previewed'
    );
    expect(codes(constraint({ values: [] })?.reasons ?? [])).not.toContain(
      'release.oidc_value_constraint_previewed'
    );
    expect(codes(constraint({})?.reasons ?? [])).not.toContain(
      'release.oidc_value_constraint_previewed'
    );
  });

  it('reports the value constraint reason exactly', () => {
    const [item] = preview([value()], { oidcClaimsRequest: { email: { value: 'a' } } }).items;
    expect(item?.reasons.slice(-1)).toEqual([
      {
        code: 'release.oidc_value_constraint_previewed',
        severity: 'info',
        message: 'OIDC claims request contains value constraints; preview reports counts only.',
      },
    ]);
  });

  it('previews requested SAML attributes', () => {
    const [item] = preview(
      [value()],
      {
        samlRequestedAttributes: [
          { name: 'other', isRequired: true },
          { name: 'email', nameFormat: 'urn:format', isRequired: true },
        ],
      },
      saml
    ).items;
    expect(item?.samlRequestedAttribute).toEqual({
      requested: true,
      required: true,
      nameFormat: 'urn:format',
    });
    expect(item?.reasons.slice(-1)).toEqual([
      {
        code: 'release.saml_required_attribute_requested',
        severity: 'info',
        message: 'SAML metadata or request marks this attribute as required.',
      },
    ]);
  });

  it.each([
    ['without a flag', {}],
    ['marked optional', { isRequired: false }],
    ['with a non-boolean flag', { isRequired: 'true' as unknown as boolean }],
  ])('does not require a SAML attribute %s', (_name, extra) => {
    const [item] = preview(
      [value()],
      { samlRequestedAttributes: [{ name: 'email', ...extra }] },
      saml
    ).items;
    expect(item?.samlRequestedAttribute).toEqual({
      requested: true,
      required: false,
      nameFormat: null,
    });
    expect(codes(item?.reasons ?? [])).not.toContain('release.saml_required_attribute_requested');
  });

  it('reports no SAML preview for attributes nobody requested', () => {
    expect(
      preview([value()], { samlRequestedAttributes: [{ name: 'other' }] }, saml).items[0]
        ?.samlRequestedAttribute
    ).toBeNull();
    expect(preview([value()], {}, saml).items[0]?.samlRequestedAttribute).toBeNull();
  });
});

describe('destination release summary', () => {
  it('reports success when every field is released', () => {
    const result = preview([value(), value({ outputName: 'b' })]);
    expect(result.status).toBe('success');
    expect(result.summary).toEqual({
      totalFields: 2,
      releaseCount: 2,
      omitCount: 0,
      denyCount: 0,
      consentRequiredCount: 0,
      regulatedDenyCount: 0,
    });
  });

  it('reports partial when a field is omitted but nothing is denied', () => {
    const result = preview([value(), value({ outputName: 'b', presence: 'missing' })]);
    expect(result.status).toBe('partial');
    expect(result.summary).toMatchObject({ releaseCount: 1, omitCount: 1, denyCount: 0 });
  });

  it('reports failed when a field is denied', () => {
    const result = preview([
      value(),
      value({ outputName: 'b', presence: 'missing' }),
      value({
        outputName: 'c',
        classification: 'regulated',
        allowedPurposes: ['audit'],
      }),
    ]);
    expect(result.status).toBe('failed');
    expect(result.summary).toEqual({
      totalFields: 3,
      releaseCount: 1,
      omitCount: 1,
      denyCount: 1,
      consentRequiredCount: 0,
      regulatedDenyCount: 1,
    });
  });

  it('counts consent-required fields and regulated denials separately', () => {
    const result = preview([
      value({ legalBasis: 'consent', consent: { required: true, granted: true } }),
      value({ legalBasis: 'consent', consent: { required: true, granted: false } }),
      value({ legalBasis: 'consent', consent: { required: false, granted: false } }),
      value({ legalBasis: 'consent' }),
      value({ classification: 'regulated', allowedPurposes: ['audit'] }),
      value({ presence: 'missing' }),
    ]);
    expect(result.summary).toEqual({
      totalFields: 6,
      releaseCount: 3,
      omitCount: 2,
      denyCount: 1,
      consentRequiredCount: 2,
      regulatedDenyCount: 1,
    });
  });

  it('counts a regulated purpose mismatch next to other reasons of the field', () => {
    const result = preview([
      value({
        presence: 'missing',
        classification: 'regulated',
        allowedPurposes: ['audit'],
      }),
      value({ outputName: 'b' }),
    ]);
    expect(codes(result.items[0]?.reasons ?? [])).toEqual([
      'release.value_missing',
      'release.regulated_purpose_mismatch',
    ]);
    expect(result.summary).toMatchObject({ denyCount: 1, regulatedDenyCount: 1 });
  });

  it('denies a field with an essential claim that is missing even without regulated data', () => {
    const result = preview([value({ presence: 'empty' })], {
      oidcClaimsRequest: { email: { essential: true } },
    });
    expect(result.status).toBe('failed');
    expect(result.summary).toMatchObject({ denyCount: 1, regulatedDenyCount: 0 });
  });

  it('reports an empty preview as successful', () => {
    const result = preview([]);
    expect(result.status).toBe('success');
    expect(result.items).toEqual([]);
    expect(result.summary.totalFields).toBe(0);
  });
});
