import { executeRuntimeMapping } from '@authrim/ar-lib-field-mapping/runtime';
import type { SourceValueEnvelope } from '@authrim/ar-lib-field-mapping/contract';
import type { DatabaseAdapter } from '../db/adapter';
import type { Env } from '../types/env';
import {
  createCustomClaimSchemaResolverFromSources,
  loadFeatureConfig,
} from './custom-claims/resolver';
import { resolveCustomClaimRuntimeSourcesFromEnv } from './custom-claims/runtime-sources';
import {
  filterIntrospectionClaimsByResourceServerProfile,
  filterIntrospectionProtocolEnvelopeClaims,
  isProtectedIdentityMappingDestinationClaim,
  loadResourceServerDestinationProfileDescriptor,
} from './destination-profile-consent';
import {
  assertRuntimeIdentityMappingReleaseSafety,
  resolveRuntimeIdentityMappingBinding,
  type RuntimeIdentityMappingBinding,
} from './identity-mapping-runtime-resolver';

export interface ApplyIntrospectionIdentityMappingInput {
  coreAdapter: DatabaseAdapter;
  adminAdapter: DatabaseAdapter;
  env: Env;
  tenantId: string;
  resourceServerId: string;
  grantedScopes: string[];
  claims: Record<string, unknown>;
}

export async function applyIntrospectionIdentityMapping(
  input: ApplyIntrospectionIdentityMappingInput
): Promise<Record<string, unknown>> {
  const envelope = filterIntrospectionProtocolEnvelopeClaims(input.claims);
  const descriptor = await loadResourceServerDestinationProfileDescriptor(
    input.adminAdapter,
    input.tenantId,
    input.resourceServerId
  );
  if (!descriptor) return envelope;

  const binding = await resolveRuntimeIdentityMappingBinding(input.adminAdapter, {
    tenantId: input.tenantId,
    protocol: 'introspection',
    role: 'authorization_server',
    partnerEntityId: input.resourceServerId,
    clientId: input.resourceServerId,
    destinationProfileId: descriptor.profileId,
  });
  if (!binding) {
    return filterIntrospectionClaimsByResourceServerProfile({
      adminAdapter: input.adminAdapter,
      tenantId: input.tenantId,
      resourceServerId: input.resourceServerId,
      profileId: descriptor.profileId,
      grantedScopes: input.grantedScopes,
      claims: envelope,
    });
  }

  const destinationProfileIds = new Set(
    binding.destinationProfileIds.map(normalizeDestinationProfileReference)
  );
  if (
    destinationProfileIds.size !== 1 ||
    !destinationProfileIds.has(normalizeDestinationProfileReference(descriptor.profileId))
  ) {
    throw new IntrospectionIdentityMappingRuntimeError(
      'Introspection identity mapping must reference exactly one matching Destination Profile',
      {
        fieldMappingSetId: binding.fieldMappingSetId,
        fieldMappingVersionId: binding.fieldMappingVersionId,
        resourceServerId: input.resourceServerId,
      }
    );
  }

  assertRuntimeIdentityMappingReleaseSafety(binding, descriptor.fields, true);

  const sourceClaims = await loadMappedIntrospectionSources(input, binding);
  const runtimeResult = executeRuntimeMapping({
    catalog: binding.catalog,
    sourceValues: toIntrospectionSourceValues(sourceClaims, binding),
    edges: binding.edges,
    transforms: binding.transforms,
    validationRules: binding.validationRules,
    fieldMappingSet: binding.fieldMappingSet,
    runtimeContext: {
      oidc: {
        clientId: input.resourceServerId,
        pairwiseSubject: typeof input.claims.sub === 'string' ? input.claims.sub : undefined,
      },
    },
  });
  if (runtimeResult.status === 'failed') {
    throw new IntrospectionIdentityMappingRuntimeError('Introspection identity mapping failed', {
      fieldMappingSetId: binding.fieldMappingSetId,
      fieldMappingVersionId: binding.fieldMappingVersionId,
      resourceServerId: input.resourceServerId,
    });
  }

  const mappedClaims = { ...envelope };
  const destinationNamespace = binding.destinationNamespace ?? 'introspection.claim';
  for (const value of runtimeResult.values) {
    if (value.sourceRef.side !== 'destination') continue;
    if (value.sourceRef.namespace !== destinationNamespace) continue;
    if (isProtectedIdentityMappingDestinationClaim('introspection.claim', value.sourceRef.path)) {
      continue;
    }
    mappedClaims[value.sourceRef.path] = value.value;
  }

  return filterIntrospectionClaimsByResourceServerProfile({
    adminAdapter: input.adminAdapter,
    tenantId: input.tenantId,
    resourceServerId: input.resourceServerId,
    profileId: descriptor.profileId,
    grantedScopes: input.grantedScopes,
    claims: mappedClaims,
  });
}

function normalizeDestinationProfileReference(value: string): string {
  return value.startsWith('destination-profile-')
    ? value.slice('destination-profile-'.length)
    : value;
}

async function loadMappedIntrospectionSources(
  input: ApplyIntrospectionIdentityMappingInput,
  binding: RuntimeIdentityMappingBinding
): Promise<Record<string, unknown>> {
  const claims = { ...input.claims };
  const subjectId = typeof input.claims.sub === 'string' ? input.claims.sub : '';
  if (!subjectId) return claims;

  const referencedKeys = Array.from(
    new Set(
      binding.edges
        .filter((edge) => edge.sourceRef.side === 'source')
        .map((edge) => edge.sourceRef.path)
        .filter((path) => path && !Object.prototype.hasOwnProperty.call(claims, path))
    )
  );
  if (referencedKeys.length === 0) return claims;

  const featureConfig = await loadFeatureConfig(input.env.AUTHRIM_CONFIG || null);
  if (!featureConfig.enabled || !featureConfig.introspectionEnabled) return claims;
  const sources = await resolveCustomClaimRuntimeSourcesFromEnv(input.env, input.tenantId, {
    accountId: subjectId,
  });
  const resolver = createCustomClaimSchemaResolverFromSources({
    schemaDb: sources.schemaDb,
    nonPiiDb: sources.nonPiiDb,
    piiDb: sources.piiDb,
    cache: input.env.AUTHRIM_CONFIG || null,
    featureConfig,
  });
  const custom = await resolver.resolveFieldValues(input.tenantId, subjectId, referencedKeys);
  return { ...claims, ...custom.claims };
}

function toIntrospectionSourceValues(
  claims: Record<string, unknown>,
  binding: RuntimeIdentityMappingBinding
): SourceValueEnvelope[] {
  const values: SourceValueEnvelope[] = Object.entries(claims).map(([path, value]) => ({
    value,
    sourceRef: { side: 'source', namespace: 'introspection.claim', path },
    metadata: { fieldPath: path },
  }));
  const seen = new Set(
    values.map((value) => `${value.sourceRef.namespace}:${value.sourceRef.path}`)
  );
  for (const edge of binding.edges) {
    if (edge.sourceRef.side !== 'source') continue;
    if (!Object.prototype.hasOwnProperty.call(claims, edge.sourceRef.path)) continue;
    const key = `${edge.sourceRef.namespace}:${edge.sourceRef.path}`;
    if (seen.has(key)) continue;
    values.push({ value: claims[edge.sourceRef.path], sourceRef: edge.sourceRef });
    seen.add(key);
  }
  return values;
}

export class IntrospectionIdentityMappingRuntimeError extends Error {
  constructor(
    message: string,
    readonly details: {
      fieldMappingSetId: string;
      fieldMappingVersionId: string;
      resourceServerId: string;
    }
  ) {
    super(message);
    this.name = 'IntrospectionIdentityMappingRuntimeError';
  }
}
