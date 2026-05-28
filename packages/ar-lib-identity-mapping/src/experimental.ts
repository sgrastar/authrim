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
export type {
  CsvPreviewAdapterInput,
  OidcClaimsPreviewAdapterInput,
  SamlAttributePreviewInput,
  SamlAttributesPreviewAdapterInput,
  ScimUserPreviewAdapterInput,
} from './adapters';
