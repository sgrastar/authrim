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
export { previewDestinationRelease } from './previews/destination-release';
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
  DestinationReleasePreviewDestination,
  DestinationPreviewProtocol,
  DestinationReleasePreviewInput,
  DestinationReleasePreviewItem,
  DestinationReleasePreviewResult,
  DestinationReleaseValueInput,
  ReleaseDecision,
  ReleaseLegalBasis,
  ReleaseReason,
  SamlRequestedAttributeConstraint,
  SamlRequestedAttributePreview,
} from './previews/destination-release';
