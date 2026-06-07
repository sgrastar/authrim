import { executeRuntimeMapping, type SourceValueEnvelope } from '@authrim/ar-lib-identity-mapping';
import type { DatabaseAdapter } from '../db/adapter';
import type { OIDCIdentityMappingPolicySelector } from '../types/oidc';
import {
  resolveRuntimeIdentityMappingBinding,
  type RuntimeIdentityMappingBinding,
} from './identity-mapping-runtime-resolver';

export interface ApplyOIDCIdentityMappingInput {
  adapter: DatabaseAdapter;
  tenantId: string;
  clientId: string;
  selector?: OIDCIdentityMappingPolicySelector | null;
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
      policySetId: input.selector?.policySetId,
      policyVersionId: input.selector?.policyVersionId,
      partnerEntityId: input.clientId,
      clientId: input.clientId,
    });
  } catch (error) {
    if (!input.selector?.policySetId) {
      return { claims: input.claims, binding: null };
    }
    throw error;
  }

  if (!binding) {
    if (input.selector?.policySetId) {
      throw new OIDCIdentityMappingRuntimeError(
        'No active OIDC identity mapping binding found for selected policy',
        {
          code: 'policy.missing_identity_mapping_binding',
          policySetId: input.selector.policySetId,
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
    policy: binding.policy,
  });

  if (runtimeResult.status === 'failed') {
    throw new OIDCIdentityMappingRuntimeError('OIDC identity mapping failed', {
      code: 'policy.identity_mapping_failed',
      policySetId: binding.policySetId,
      policyVersionId: binding.policyVersionId,
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
      policySetId?: string;
      policyVersionId?: string;
      clientId?: string;
    }
  ) {
    super(message);
    this.name = 'OIDCIdentityMappingRuntimeError';
  }
}
