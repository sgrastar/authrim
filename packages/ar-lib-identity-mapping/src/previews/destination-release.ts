import type { FieldRef, MappingResultStatus, RedactionClassification } from '../core/types';

export type DestinationPreviewProtocol = 'saml' | 'oidc';
export type ReleaseDecision = 'release' | 'omit' | 'deny';
export type ReleaseLegalBasis = 'consent' | 'legal_obligation' | 'contract' | 'legitimate_interest';
export type AttributeReleaseConsentMode = 'once' | 'every_time' | 'until_attributes_change';

export interface DestinationReleasePreviewDestination {
  protocol: DestinationPreviewProtocol;
  destinationId: string;
  purpose: string;
}

export interface AttributeReleaseConsentPreviewInput {
  required: boolean;
  granted: boolean;
  mode?: AttributeReleaseConsentMode;
  attributeSetHash?: string;
  statementId?: string;
  statementVersion?: string;
}

export interface OidcAdvancedClaimConstraint {
  essential?: boolean;
  value?: unknown;
  values?: unknown[];
  purpose?: string;
}

export interface SamlRequestedAttributeConstraint {
  name: string;
  nameFormat?: string;
  isRequired?: boolean;
}

export interface DestinationReleaseValueInput {
  fieldRef: FieldRef;
  outputName: string;
  outputNameFormat?: string;
  classification: RedactionClassification;
  valueType: string;
  cardinality?: 'single' | 'multi';
  presence?: 'present' | 'missing' | 'empty';
  legalBasis: ReleaseLegalBasis;
  allowedPurposes?: string[];
  consent?: AttributeReleaseConsentPreviewInput;
  valueFingerprint?: string;
}

export interface DestinationReleasePreviewInput {
  destination: DestinationReleasePreviewDestination;
  values: DestinationReleaseValueInput[];
  oidcClaimsRequest?: Record<string, OidcAdvancedClaimConstraint | null>;
  samlRequestedAttributes?: SamlRequestedAttributeConstraint[];
}

export interface ReleaseReason {
  code: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
}

export interface OidcConstraintPreview {
  essential: boolean;
  requestedValueCount: number;
  purpose: string | null;
}

export interface SamlRequestedAttributePreview {
  requested: boolean;
  required: boolean;
  nameFormat: string | null;
}

export interface AttributeReleaseConsentPreview {
  required: boolean;
  granted: boolean;
  mode: AttributeReleaseConsentMode | null;
  attributeSetHash: string | null;
  statementId: string | null;
  statementVersion: string | null;
}

export interface DestinationReleasePreviewItem {
  fieldRef: FieldRef;
  output: {
    protocol: DestinationPreviewProtocol;
    name: string;
    nameFormat: string | null;
  };
  decision: ReleaseDecision;
  legalBasis: ReleaseLegalBasis;
  classification: RedactionClassification;
  valueType: string;
  cardinality: 'single' | 'multi';
  presence: 'present' | 'missing' | 'empty';
  valueFingerprint: string | null;
  reasons: ReleaseReason[];
  oidcConstraint: OidcConstraintPreview | null;
  samlRequestedAttribute: SamlRequestedAttributePreview | null;
  consentPreview: AttributeReleaseConsentPreview | null;
}

export interface DestinationReleasePreviewResult {
  status: MappingResultStatus;
  destination: DestinationReleasePreviewDestination;
  summary: {
    totalFields: number;
    releaseCount: number;
    omitCount: number;
    denyCount: number;
    consentRequiredCount: number;
    regulatedDenyCount: number;
  };
  items: DestinationReleasePreviewItem[];
}

export function previewDestinationRelease(
  input: DestinationReleasePreviewInput
): DestinationReleasePreviewResult {
  const items = input.values.map((value) => previewDestinationReleaseItem(input, value));
  const denyCount = items.filter((item) => item.decision === 'deny').length;
  const omitCount = items.filter((item) => item.decision === 'omit').length;
  const releaseCount = items.filter((item) => item.decision === 'release').length;
  const criticalCount = items.reduce(
    (sum, item) => sum + item.reasons.filter((reason) => reason.severity === 'critical').length,
    0
  );

  return {
    status: criticalCount > 0 || denyCount > 0 ? 'failed' : omitCount > 0 ? 'partial' : 'success',
    destination: input.destination,
    summary: {
      totalFields: items.length,
      releaseCount,
      omitCount,
      denyCount,
      consentRequiredCount: items.filter((item) => item.consentPreview?.required).length,
      regulatedDenyCount: items.filter((item) =>
        item.reasons.some((reason) => reason.code === 'release.regulated_purpose_mismatch')
      ).length,
    },
    items,
  };
}

function previewDestinationReleaseItem(
  input: DestinationReleasePreviewInput,
  value: DestinationReleaseValueInput
): DestinationReleasePreviewItem {
  const reasons: ReleaseReason[] = [];
  const presence = value.presence ?? 'present';
  const oidcConstraint =
    input.destination.protocol === 'oidc'
      ? buildOidcConstraintPreview(input.oidcClaimsRequest?.[value.outputName])
      : null;
  const samlRequestedAttribute =
    input.destination.protocol === 'saml'
      ? buildSamlRequestedAttributePreview(input.samlRequestedAttributes, value)
      : null;
  const consentPreview = buildConsentPreview(value.consent);

  if (presence !== 'present') {
    reasons.push({
      code: 'release.value_missing',
      severity: isRequiredByDestination(oidcConstraint, samlRequestedAttribute)
        ? 'critical'
        : 'warning',
      message: 'The source value is not present for this destination field.',
    });
  }

  addLegalBasisReasons(input.destination, value, reasons);
  addConsentReasons(value, reasons);
  addProtocolConstraintReasons(oidcConstraint, samlRequestedAttribute, reasons);

  return {
    fieldRef: value.fieldRef,
    output: {
      protocol: input.destination.protocol,
      name: value.outputName,
      nameFormat: value.outputNameFormat ?? null,
    },
    decision: decideRelease(reasons),
    legalBasis: value.legalBasis,
    classification: value.classification,
    valueType: value.valueType,
    cardinality: value.cardinality ?? 'single',
    presence,
    valueFingerprint: value.valueFingerprint ?? null,
    reasons,
    oidcConstraint,
    samlRequestedAttribute,
    consentPreview,
  };
}

function addLegalBasisReasons(
  destination: DestinationReleasePreviewDestination,
  value: DestinationReleaseValueInput,
  reasons: ReleaseReason[]
): void {
  if (
    value.classification === 'regulated' &&
    value.allowedPurposes?.length &&
    !value.allowedPurposes.includes(destination.purpose)
  ) {
    reasons.push({
      code: 'release.regulated_purpose_mismatch',
      severity: 'critical',
      message: 'Regulated data cannot be released for the requested destination purpose.',
    });
    return;
  }

  if (value.legalBasis === 'legal_obligation') {
    reasons.push({
      code: 'release.legal_obligation_purpose_checked',
      severity: 'info',
      message: 'Release is evaluated through legal obligation and purpose limitation.',
    });
    return;
  }

  if (value.legalBasis === 'contract' || value.legalBasis === 'legitimate_interest') {
    reasons.push({
      code: `release.${value.legalBasis}_trace_only`,
      severity: 'info',
      message: 'Release does not require consent, but the legal basis is retained in the trace.',
    });
  }
}

function addConsentReasons(value: DestinationReleaseValueInput, reasons: ReleaseReason[]): void {
  if (value.legalBasis !== 'consent') {
    return;
  }

  if (!value.consent?.required) {
    reasons.push({
      code: 'release.consent_not_required',
      severity: 'info',
      message: 'Consent legal basis is configured without a required consent gate.',
    });
    return;
  }

  if (value.consent.granted) {
    reasons.push({
      code: 'release.consent_granted',
      severity: 'info',
      message: 'Required consent has been granted for this release preview.',
    });
    return;
  }

  reasons.push({
    code: 'release.consent_required',
    severity: 'error',
    message: 'Required consent has not been granted for this release preview.',
  });
}

function addProtocolConstraintReasons(
  oidcConstraint: OidcConstraintPreview | null,
  samlRequestedAttribute: SamlRequestedAttributePreview | null,
  reasons: ReleaseReason[]
): void {
  if (oidcConstraint?.essential) {
    reasons.push({
      code: 'release.oidc_essential_claim_requested',
      severity: 'info',
      message: 'OIDC claims request marks this claim as essential.',
    });
  }

  if (oidcConstraint && oidcConstraint.requestedValueCount > 0) {
    reasons.push({
      code: 'release.oidc_value_constraint_previewed',
      severity: 'info',
      message: 'OIDC claims request contains value constraints; preview reports counts only.',
    });
  }

  if (samlRequestedAttribute?.required) {
    reasons.push({
      code: 'release.saml_required_attribute_requested',
      severity: 'info',
      message: 'SAML metadata or request marks this attribute as required.',
    });
  }
}

function decideRelease(reasons: ReleaseReason[]): ReleaseDecision {
  if (reasons.some((reason) => reason.severity === 'critical')) {
    return 'deny';
  }
  if (reasons.some((reason) => reason.severity === 'error' || reason.severity === 'warning')) {
    return 'omit';
  }
  return 'release';
}

function buildOidcConstraintPreview(
  constraint: OidcAdvancedClaimConstraint | null | undefined
): OidcConstraintPreview | null {
  if (constraint === undefined || constraint === null) {
    return null;
  }
  return {
    essential: constraint.essential === true,
    requestedValueCount:
      constraint.values !== undefined
        ? constraint.values.length
        : constraint.value !== undefined
          ? 1
          : 0,
    purpose: constraint.purpose ?? null,
  };
}

function buildSamlRequestedAttributePreview(
  requestedAttributes: SamlRequestedAttributeConstraint[] | undefined,
  value: DestinationReleaseValueInput
): SamlRequestedAttributePreview | null {
  const requested = requestedAttributes?.find((attribute) => attribute.name === value.outputName);
  if (!requested) {
    return null;
  }
  return {
    requested: true,
    required: requested.isRequired === true,
    nameFormat: requested.nameFormat ?? null,
  };
}

function buildConsentPreview(
  consent: AttributeReleaseConsentPreviewInput | undefined
): AttributeReleaseConsentPreview | null {
  if (!consent) {
    return null;
  }
  return {
    required: consent.required,
    granted: consent.granted,
    mode: consent.mode ?? null,
    attributeSetHash: consent.attributeSetHash ?? null,
    statementId: consent.statementId ?? null,
    statementVersion: consent.statementVersion ?? null,
  };
}

function isRequiredByDestination(
  oidcConstraint: OidcConstraintPreview | null,
  samlRequestedAttribute: SamlRequestedAttributePreview | null
): boolean {
  return oidcConstraint?.essential === true || samlRequestedAttribute?.required === true;
}
