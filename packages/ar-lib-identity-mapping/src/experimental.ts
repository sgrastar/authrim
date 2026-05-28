export type PreviewProtocol = 'csv' | 'scim' | 'saml' | 'oidc';

export interface PreviewAdapterDescriptor {
  protocol: PreviewProtocol;
  fixtureName: string;
}

export {
  adaptCsvPreview,
  adaptOidcClaimsPreview,
  adaptSamlAttributesPreview,
  adaptScimUserPreview,
} from './adapters';
export { previewCsvDryRun } from './previews/csv-dry-run';
export { previewOutboundRelease } from './previews/outbound-release';
export type {
  CsvPreviewAdapterInput,
  OidcClaimsPreviewAdapterInput,
  SamlAttributePreviewInput,
  SamlAttributesPreviewAdapterInput,
  ScimUserPreviewAdapterInput,
} from './adapters';
export type {
  CsvCanonicalTargetPreview,
  CsvDryRunPreviewInput,
  CsvDryRunPreviewResult,
  CsvDryRunPreviewRowResult,
  CsvHeaderSuggestion,
} from './previews/csv-dry-run';
export type {
  AttributeReleaseConsentMode,
  AttributeReleaseConsentPreview,
  AttributeReleaseConsentPreviewInput,
  OidcAdvancedClaimConstraint,
  OidcConstraintPreview,
  OutboundPreviewDestination,
  OutboundPreviewProtocol,
  OutboundReleasePreviewInput,
  OutboundReleasePreviewItem,
  OutboundReleasePreviewResult,
  OutboundReleaseValueInput,
  ReleaseDecision,
  ReleaseLegalBasis,
  ReleaseReason,
  SamlRequestedAttributeConstraint,
  SamlRequestedAttributePreview,
} from './previews/outbound-release';
