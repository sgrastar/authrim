import { reason } from '../core/reason-registry';
import type { AdapterResult, MappingInput, SourceValueEnvelope } from '../core/types';

export interface OidcClaimsPreviewAdapterInput {
  claims: Record<string, unknown>;
  catalog: MappingInput['catalog'];
  edges: MappingInput['edges'];
}

export function adaptOidcClaimsPreview(
  input: OidcClaimsPreviewAdapterInput
): AdapterResult<MappingInput> {
  const sourceValues: SourceValueEnvelope[] = [];
  const reasons = [];

  for (const [claimName, claimRequest] of Object.entries(input.claims)) {
    if (claimRequest !== null && typeof claimRequest !== 'object') {
      reasons.push(reason('adapter.unsupported_claim_shape'));
    }
    sourceValues.push({
      value: claimRequest,
      sourceRef: { side: 'outbound', namespace: 'oidc.claim', path: claimName },
      metadata: { sourceType: 'oidc', oidcClaimName: claimName, fieldPath: claimName },
    });
  }

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
