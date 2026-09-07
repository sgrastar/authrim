import { executeRuntimeMapping } from '@authrim/ar-lib-field-mapping/runtime';
import type { SourceValueEnvelope } from '@authrim/ar-lib-field-mapping/contract';
import type { DatabaseAdapter } from '../db/adapter';
import type { Env } from '../types/env';
import type { OIDCIdentityMappingFieldMappingSelector } from '../types/oidc';
import {
  createCustomClaimSchemaResolverFromSources,
  loadFeatureConfig,
} from './custom-claims/resolver';
import { resolveCustomClaimRuntimeSourcesFromEnv } from './custom-claims/runtime-sources';
import { requireDedicatedAdminDatabaseAdapter } from './admin-database-adapter';
import {
  filterOidcClaimsByDestinationConsent,
  filterOidcClaimsWithoutDestinationProfile,
  isProtectedIdentityMappingDestinationClaim,
  loadDestinationProfileConsentDescriptor,
} from './destination-profile-consent';
import {
  assertRuntimeIdentityMappingReleaseSafety,
  resolveRuntimeIdentityMappingBinding,
  type RuntimeIdentityMappingBinding,
} from './identity-mapping-runtime-resolver';
import {
  generatePersistentIdentifier,
  resolveOIDCPairwiseAudience,
  type PersistentIdentifierAlgorithm,
  type PersistentIdentifierAudienceMode,
} from './persistent-identifiers';

export interface ApplyOIDCIdentityMappingInput {
  adapter: DatabaseAdapter;
  env?: Partial<Env>;
  tenantId: string;
  clientId: string;
  sectorIdentifier?: string | null;
  selector?: OIDCIdentityMappingFieldMappingSelector | null;
  destinationSurface?: 'id_token' | 'userinfo';
  grantedScopes?: string[];
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
    // Identity mapping catalogs, activations, and compiled snapshots are control-plane data in
    // DB_ADMIN. Keep the supplied adapter only as a single-database compatibility fallback.
    const mappingAdapter = input.env?.DB_ADMIN
      ? requireDedicatedAdminDatabaseAdapter(input.env, 'oidc-identity-mapping')
      : input.adapter;
    binding = await resolveRuntimeIdentityMappingBinding(mappingAdapter, {
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
      return {
        claims: await applyOIDCDestinationFieldConsent(input, input.claims, null),
        binding: null,
      };
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
    return {
      claims: await applyOIDCDestinationFieldConsent(input, input.claims, null),
      binding: null,
    };
  }
  if (binding.destinationProfileIds.length !== 1 || !binding.destinationProfileId) {
    throw new OIDCIdentityMappingRuntimeError(
      'OIDC identity mapping must reference exactly one Destination Profile',
      {
        code: 'policy.invalid_destination_profile_binding',
        fieldMappingSetId: binding.fieldMappingSetId,
        fieldMappingVersionId: binding.fieldMappingVersionId,
        clientId: input.clientId,
      }
    );
  }

  const destinationProfileAdapter = input.env?.DB_ADMIN
    ? requireDedicatedAdminDatabaseAdapter(input.env, 'oidc-destination-profile-safety')
    : input.adapter;
  const destinationDescriptor = await loadDestinationProfileConsentDescriptor(
    destinationProfileAdapter,
    input.tenantId,
    binding.destinationProfileId
  );
  if (destinationDescriptor?.destinationType === 'oidc') {
    assertRuntimeIdentityMappingReleaseSafety(binding, destinationDescriptor.fields, true);
  }

  const destinationNamespace =
    input.selector?.destinationNamespace ?? binding.destinationNamespace ?? 'oidc.claim';
  const sourceClaims = await loadMappedCustomClaimSources(input, binding);
  const persistentIdentifiers = await resolveOIDCPersistentIdentifiers(input, binding);
  const runtimeResult = executeRuntimeMapping({
    catalog: binding.catalog,
    sourceValues: toOIDCSourceValues(sourceClaims, binding),
    edges: binding.edges,
    transforms: binding.transforms,
    validationRules: binding.validationRules,
    fieldMappingSet: binding.fieldMappingSet,
    runtimeContext: {
      oidc: {
        clientId: input.clientId,
        pairwiseSubject: typeof input.claims.sub === 'string' ? input.claims.sub : undefined,
        persistentIdentifiers,
      },
    },
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
    if (isProtectedIdentityMappingDestinationClaim('oidc.claim', value.sourceRef.path)) {
      continue;
    }
    mappedClaims[value.sourceRef.path] = value.value;
  }

  return {
    claims: await applyOIDCDestinationFieldConsent(input, mappedClaims, binding),
    binding,
  };
}

async function loadMappedCustomClaimSources(
  input: ApplyOIDCIdentityMappingInput,
  binding: RuntimeIdentityMappingBinding
): Promise<Record<string, unknown>> {
  const claims = withCanonicalProfileAliases(input.claims);
  if (!input.env) return claims;
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
  if (!featureConfig.enabled) return claims;
  const sources = await resolveCustomClaimRuntimeSourcesFromEnv(input.env as Env, input.tenantId, {
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

function withCanonicalProfileAliases(claims: Record<string, unknown>): Record<string, unknown> {
  const aliased = { ...claims };
  if (!Object.prototype.hasOwnProperty.call(aliased, 'display_name') && aliased.name != null) {
    aliased.display_name = aliased.name;
  }
  if (!Object.prototype.hasOwnProperty.call(aliased, 'picture_url') && aliased.picture != null) {
    aliased.picture_url = aliased.picture;
  }
  return aliased;
}

async function applyOIDCDestinationFieldConsent(
  input: ApplyOIDCIdentityMappingInput,
  claims: Record<string, unknown>,
  binding: RuntimeIdentityMappingBinding | null
): Promise<Record<string, unknown>> {
  const profileId = binding?.destinationProfileId ?? input.selector?.destinationProfileId;
  const subjectId = typeof input.claims.sub === 'string' ? input.claims.sub : '';
  if (!profileId) return filterOidcClaimsWithoutDestinationProfile(claims);
  if (!subjectId) {
    throw new OIDCIdentityMappingRuntimeError(
      'OIDC destination release requires a subject identifier',
      {
        code: 'policy.missing_destination_subject',
        fieldMappingSetId: input.selector?.fieldMappingSetId,
        clientId: input.clientId,
      }
    );
  }
  return filterOidcClaimsByDestinationConsent({
    coreAdapter: input.adapter,
    adminAdapter: input.env?.DB_ADMIN
      ? requireDedicatedAdminDatabaseAdapter(input.env, 'oidc-destination-profile-consent')
      : input.adapter,
    tenantId: input.tenantId,
    subjectId,
    clientId: input.clientId,
    profileId,
    surface: input.destinationSurface,
    grantedScopes: input.grantedScopes,
    claims,
  });
}

interface OIDCPersistentIdentifierProfileRow {
  id: string;
  mode: string;
  algorithm: string;
  protocol_scope: string;
  secret_ref: string | null;
  audience_mode: string | null;
  lifecycle_state: string;
}

async function resolveOIDCPersistentIdentifiers(
  input: ApplyOIDCIdentityMappingInput,
  binding: RuntimeIdentityMappingBinding
): Promise<Record<string, string>> {
  const profileIds = findPersistentIdentifierProfileIds(binding, 'oidc_pairwise_sub');
  if (profileIds.length === 0) {
    return {};
  }

  if (!input.env?.DB_ADMIN || !input.env.KEY_MANAGER) {
    throw new OIDCIdentityMappingRuntimeError(
      'OIDC persistent identifier profile is not available',
      {
        code: 'policy.persistent_identifier_profile_not_found',
        fieldMappingSetId: binding.fieldMappingSetId,
        fieldMappingVersionId: binding.fieldMappingVersionId,
        clientId: input.clientId,
      }
    );
  }

  const adminAdapter = requireDedicatedAdminDatabaseAdapter(
    input.env,
    'oidc-persistent-identifier'
  );
  const output: Record<string, string> = {};

  for (const profileId of profileIds) {
    const profile = await loadOIDCPersistentIdentifierProfile(
      adminAdapter,
      input.tenantId,
      profileId
    );
    if (!profile) {
      throw new OIDCIdentityMappingRuntimeError(
        'OIDC persistent identifier profile was not found',
        {
          code: 'policy.persistent_identifier_profile_not_found',
          fieldMappingSetId: binding.fieldMappingSetId,
          fieldMappingVersionId: binding.fieldMappingVersionId,
          clientId: input.clientId,
        }
      );
    }

    if (
      profile.mode !== 'computed' ||
      !isComputedAlgorithm(profile.algorithm) ||
      !['any', 'oidc', 'generic'].includes(profile.protocol_scope)
    ) {
      throw new OIDCIdentityMappingRuntimeError(
        'OIDC persistent identifier profile mode is not supported',
        {
          code: 'policy.persistent_identifier_profile_unsupported_mode',
          fieldMappingSetId: binding.fieldMappingSetId,
          fieldMappingVersionId: binding.fieldMappingVersionId,
          clientId: input.clientId,
        }
      );
    }

    if (!profile.secret_ref) {
      throw new OIDCIdentityMappingRuntimeError(
        'OIDC persistent identifier profile secret is not configured',
        {
          code: 'policy.persistent_identifier_secret_missing',
          fieldMappingSetId: binding.fieldMappingSetId,
          fieldMappingVersionId: binding.fieldMappingVersionId,
          clientId: input.clientId,
        }
      );
    }

    const secret = await getPersistentIdentifierSecret(
      input.env.KEY_MANAGER,
      input.tenantId,
      profile.secret_ref
    );
    if (!secret) {
      throw new OIDCIdentityMappingRuntimeError(
        'OIDC persistent identifier profile secret is not available',
        {
          code: 'policy.persistent_identifier_secret_missing',
          fieldMappingSetId: binding.fieldMappingSetId,
          fieldMappingVersionId: binding.fieldMappingVersionId,
          clientId: input.clientId,
        }
      );
    }

    const subject = typeof input.claims.sub === 'string' ? input.claims.sub : undefined;
    if (!subject) {
      throw new OIDCIdentityMappingRuntimeError('OIDC subject is required for pairwise transform', {
        code: 'policy.identity_mapping_failed',
        fieldMappingSetId: binding.fieldMappingSetId,
        fieldMappingVersionId: binding.fieldMappingVersionId,
        clientId: input.clientId,
      });
    }

    output[profile.id] = await generatePersistentIdentifier({
      algorithm: profile.algorithm,
      subject,
      audience: resolveOIDCPairwiseAudience({
        clientId: input.clientId,
        sectorIdentifier: input.sectorIdentifier,
        audienceMode: isAudienceMode(profile.audience_mode) ? profile.audience_mode : undefined,
      }),
      secret,
    });
  }

  return output;
}

function findPersistentIdentifierProfileIds(
  binding: RuntimeIdentityMappingBinding,
  operation: string
): string[] {
  const ids = new Set<string>();
  for (const transform of binding.transforms ?? []) {
    if (transform.operation !== operation) continue;
    const profileId = transform.parameters?.persistentIdentifierProfileId;
    if (typeof profileId === 'string' && profileId.length > 0) {
      ids.add(profileId);
    }
  }
  return Array.from(ids);
}

async function loadOIDCPersistentIdentifierProfile(
  adapter: DatabaseAdapter,
  tenantId: string,
  profileId: string
): Promise<OIDCPersistentIdentifierProfileRow | null> {
  const rows = await adapter.query<OIDCPersistentIdentifierProfileRow>(
    `SELECT id, mode, algorithm, protocol_scope, secret_ref, audience_mode, lifecycle_state
       FROM persistent_identifier_profiles
      WHERE tenant_id = ? AND id = ? AND lifecycle_state = 'active'
      LIMIT 1`,
    [tenantId, profileId]
  );
  return rows[0] ?? null;
}

async function getPersistentIdentifierSecret(
  keyManagerNamespace: Env['KEY_MANAGER'],
  tenantId: string,
  secretRef: string
): Promise<string | null> {
  const keyManagerId = keyManagerNamespace.idFromName(`${tenantId}-v3`);
  const keyManager = keyManagerNamespace.get(keyManagerId) as unknown as {
    getOrCreateSecretRpc: (secretRef: string) => Promise<{ active?: { value?: unknown } }>;
  };
  const secret = await keyManager.getOrCreateSecretRpc(secretRef);
  return typeof secret?.active?.value === 'string' ? secret.active.value : null;
}

function isComputedAlgorithm(value: string): value is PersistentIdentifierAlgorithm {
  return value === 'authrim_sha256_base64url' || value === 'shibboleth_sha1_base64';
}

function isAudienceMode(value: string | null): value is PersistentIdentifierAudienceMode {
  return value === 'runtime' || value === 'saml_sp_entity_id' || value === 'oidc_sector_identifier';
}

function toOIDCSourceValues(
  claims: Record<string, unknown>,
  binding: RuntimeIdentityMappingBinding
): SourceValueEnvelope[] {
  const values: SourceValueEnvelope[] = Object.entries(claims).map(([path, value]) => ({
    value,
    sourceRef: { side: 'source', namespace: 'oidc.claim', path },
    metadata: { oidcClaimName: path },
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
