import { reason } from '../core/reason-registry';
import type { AdapterResult, MappingInput, SourceValueEnvelope } from '../core/types';

export interface SamlAttributePreviewInput {
  name: string;
  nameFormat?: string;
  values: unknown[];
}

export interface SamlAttributesPreviewAdapterInput {
  attributes: SamlAttributePreviewInput[];
  catalog: MappingInput['catalog'];
  edges: MappingInput['edges'];
}

export function adaptSamlAttributesPreview(
  input: SamlAttributesPreviewAdapterInput
): AdapterResult<MappingInput> {
  const reasons = input.attributes
    .filter((attribute) => !attribute.name || !Array.isArray(attribute.values))
    .map(() => reason('adapter.unsupported_attribute_shape'));

  const sourceValues: SourceValueEnvelope[] = input.attributes.map((attribute) => ({
    value: attribute.values.length === 1 ? attribute.values[0] : attribute.values,
    sourceRef: { side: 'source', namespace: 'saml.attribute', path: attribute.name },
    metadata: {
      sourceType: 'saml',
      samlAttributeName: attribute.name,
      samlNameFormat: attribute.nameFormat,
    },
  }));

  return {
    status: reasons.length > 0 ? 'partial' : 'success',
    input: {
      catalog: input.catalog,
      edges: input.edges,
      sourceValues,
    },
    reasons,
  };
}
