import { executeRuntimeMapping, type SourceValueEnvelope } from '@authrim/ar-lib-field-mapping';
import type { DatabaseAdapter } from '../db/adapter';
import type { Env } from '../types/env';
import type { OIDCIdentityMappingFieldMappingSelector } from '../types/oidc';
import { requireDedicatedAdminDatabaseAdapter } from './admin-database-adapter';
import {
  generatePersistentIdentifier,
  resolveOIDCPairwiseAudience,
  type PersistentIdentifierAlgorithm,
  type PersistentIdentifierAudienceMode,
} from './persistent-identifiers';
import {
  resolveRuntimeIdentityMappingBinding,
  type RuntimeIdentityMappingBinding,
} from './identity-mapping-runtime-resolver';

export interface ApplyOIDCIdentityMappingInput {
  adapter: DatabaseAdapter;
  env?: Pick<Env, 'DB_ADMIN' | 'KEY_MANAGER'>;
  tenantId: string;
  clientId: string;
  sectorIdentifier?: string | null;
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
  const persistentIdentifiers = await resolveOIDCPersistentIdentifiers(input, binding);
  const runtimeResult = executeRuntimeMapping({
    catalog: binding.catalog,
    sourceValues: toOIDCSourceValues(input.claims),
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
    mappedClaims[value.sourceRef.path] = value.value;
  }

  return { claims: mappedClaims, binding };
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
  const keyManager = keyManagerNamespace.get(keyManagerId);
  const secret = await keyManager.getSecretRpc(secretRef);
  return typeof secret?.active?.value === 'string' ? secret.active.value : null;
}

function isComputedAlgorithm(value: string): value is PersistentIdentifierAlgorithm {
  return value === 'authrim_sha256_base64url' || value === 'shibboleth_sha1_base64';
}

function isAudienceMode(value: string | null): value is PersistentIdentifierAudienceMode {
  return value === 'runtime' || value === 'saml_sp_entity_id' || value === 'oidc_sector_identifier';
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
