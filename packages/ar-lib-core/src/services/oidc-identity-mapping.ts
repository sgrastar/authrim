import { executeRuntimeMapping, type SourceValueEnvelope } from '@authrim/ar-lib-field-mapping';
import type { DatabaseAdapter } from '../db/adapter';
import type { OIDCIdentityMappingFieldMappingSelector } from '../types/oidc';
import {
  resolveRuntimeIdentityMappingBinding,
  type RuntimeIdentityMappingBinding,
} from './identity-mapping-runtime-resolver';

export interface ApplyOIDCIdentityMappingInput {
  adapter: DatabaseAdapter;
  tenantId: string;
  clientId: string;
  selector?: OIDCIdentityMappingFieldMappingSelector | null;
  claims: Record<string, unknown>;
}

export interface ApplyOIDCIdentityMappingResult {
  claims: Record<string, unknown>;
  binding: RuntimeIdentityMappingBinding | null;
}

export async function applyOIDCIdentityMapping(
  input: ApplyOIDCIdentityMappingInput
): Promise<ApplyOIDCIdentityMappingResult> {
  let binding: RuntimeIdentityMappingBinding | null;
  try {
    binding = await resolveRuntimeIdentityMappingBinding(input.adapter, {
      tenantId: input.tenantId,
      protocol: 'oidc',
      role: 'op',
      fieldMappingSetId: input.selector?.fieldMappingSetId,
      fieldMappingVersionId: input.selector?.fieldMappingVersionId,
      partnerEntityId: input.clientId,
      clientId: input.clientId,
    });
  } catch (error) {
    if (!input.selector?.fieldMappingSetId) {
      return { claims: input.claims, binding: null };
    }
    throw error;
  }

  if (!binding) {
    if (input.selector?.fieldMappingSetId) {
      throw new OIDCIdentityMappingRuntimeError(
        'No active OIDC identity mapping binding found for selected policy',
        {
          code: 'policy.missing_identity_mapping_binding',
          fieldMappingSetId: input.selector.fieldMappingSetId,
          clientId: input.clientId,
        }
      );
    }
    return { claims: input.claims, binding: null };
  }

  const destinationNamespace =
    input.selector?.destinationNamespace ?? binding.destinationNamespace ?? 'oidc.claim';
  const runtimeResult = executeRuntimeMapping({
    catalog: binding.catalog,
    sourceValues: toOIDCSourceValues(input.claims),
    edges: binding.edges,
    transforms: binding.transforms,
    validationRules: binding.validationRules,
    fieldMappingSet: binding.fieldMappingSet,
  });

  if (runtimeResult.status === 'failed') {
    throw new OIDCIdentityMappingRuntimeError('OIDC identity mapping failed', {
      code: 'policy.identity_mapping_failed',
      fieldMappingSetId: binding.fieldMappingSetId,
      fieldMappingVersionId: binding.fieldMappingVersionId,
      clientId: input.clientId,
    });
  }

  const mappedClaims = { ...input.claims };
  for (const value of runtimeResult.values) {
    if (value.sourceRef.side !== 'destination') {
      continue;
    }
    if (value.sourceRef.namespace !== destinationNamespace) {
      continue;
    }
    mappedClaims[value.sourceRef.path] = value.value;
  }

  return { claims: mappedClaims, binding };
}

function toOIDCSourceValues(claims: Record<string, unknown>): SourceValueEnvelope[] {
  return Object.entries(claims).map(([path, value]) => ({
    value,
    sourceRef: {
      side: 'source',
      namespace: 'oidc.claim',
      path,
    },
    metadata: {
      oidcClaimName: path,
    },
  }));
}

export class OIDCIdentityMappingRuntimeError extends Error {
  constructor(
    message: string,
    public readonly details: {
      code: string;
      fieldMappingSetId?: string;
      fieldMappingVersionId?: string;
      clientId?: string;
    }
  ) {
    super(message);
    this.name = 'OIDCIdentityMappingRuntimeError';
  }
}
