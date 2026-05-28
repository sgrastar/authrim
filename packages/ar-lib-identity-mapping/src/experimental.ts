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
