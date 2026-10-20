import { executeRuntimeMapping } from '@authrim/ar-lib-field-mapping/runtime';
import type { FieldRef, SourceValueEnvelope } from '@authrim/ar-lib-field-mapping/contract';
import type { DatabaseAdapter } from '../db/adapter';
import type { Env } from '../types/env';
import type { OIDCIdentityMappingFieldMappingSelector } from '../types/oidc';
import {
  createCustomClaimSchemaResolverFromSources,
  loadFeatureConfig,
} from './custom-claims/resolver';
import { resolveCustomClaimRuntimeSourcesFromEnv } from './custom-claims/runtime-sources';
import { requireDedicatedAdminDatabaseAdapter } from './admin-database-adapter';
import { PLATFORM_MAPPING_TENANT_ID } from './identity-mapping-owner';
import { isNonAccountSubject } from '../utils/id';
import {
  filterOidcClaimsByDestinationConsent,
  filterOidcClaimsWithoutDestinationProfile,
  isProtectedIdentityMappingDestinationClaim,
  loadDestinationProfileConsentDescriptor,
} from './destination-profile-consent';
import {
  resolveOidcIdentityMappingBinding,
  type OidcIdentityMappingResolution,
} from './identity-mapping-resolution';
import { IdentityMappingSelectionError } from './identity-mapping-selection';
import { IdentityMappingResolutionError } from './identity-mapping-set-binding';
import {
  assertRuntimeIdentityMappingReleaseSafety,
  type RuntimeIdentityMappingBinding,
} from './identity-mapping-runtime-resolver';
import {
  generatePersistentIdentifier,
  resolveOIDCPairwiseAudience,
  type PersistentIdentifierAlgorithm,
  type PersistentIdentifierAudienceMode,
} from './persistent-identifiers';

export interface ApplyOIDCIdentityMappingInput {
  /** The tenant Core database: the user's consent and attributes. Never read for a mapping. */
  adapter: DatabaseAdapter;
  /**
   * SETTINGS decides which Mapping Set applies (the tenant's and the platform's default); DB_ADMIN
   * holds the set. A selection of none reads neither database, so it needs no DB_ADMIN; one that
   * names a set fails without it (there is no fallback to `adapter`).
   */
  env: Partial<Env>;
  /** The tenant the request is for. Consent, custom fields and identifiers stay with it. */
  tenantId: string;
  clientId: string;
  sectorIdentifier?: string | null;
  /**
   * The app's `identity_mapping`: its own Mapping Set, `{ mode: 'none' }`, or nothing (the tenant's
   * default, else the platform's, else no mapping). What it does not name is never looked up by
   * an activation's scope.
   */
  selector?: OIDCIdentityMappingFieldMappingSelector | null;
  destinationSurface?: 'id_token' | 'userinfo';
  grantedScopes?: string[];
  /**
   * Set when the caller has already authorized the standard claims `claims` carries against the
   * request (their scope, the claims parameter, the client's claims policy), as the authorization
   * endpoint does for the ID token it issues. For those claims the Destination Profile counts
   * the OIDC scope that releases the claim (email for email, ...) as granted, so a claim the
   * claims parameter requested is not dropped for lacking it. A scope of the profile's own is
   * still required; claims the mapping adds or whose value it replaced are held to the scopes;
   * every other profile rule still applies.
   */
  claimsAuthorizedByRequest?: boolean;
  /**
   * The same, for only the claims named here (the caller authorized just these against the
   * request, such as eduperson_assurance, which the authorization server computed after the
   * scopes and the client's claims policy allowed it). Every other claim is held to the scopes as
   * before. Ignored when `claimsAuthorizedByRequest` is set, which covers them all.
   */
  authorizedClaimNames?: readonly string[];
  /**
   * Set when the ID token is all the response gives the app (response_type=id_token carries no
   * access token to call UserInfo with), so the claims the profile lists for UserInfo are
   * released in it too, as OIDC Core 5.4 requires for the scope claims. Only for the id_token
   * surface.
   */
  userInfoClaimsInIdToken?: boolean;
  /**
   * What the token or response carries: the claims the mapping starts from and the output keeps.
   * The mapping reads these as sources too, but they depend on the scopes and the request, so a
   * mapping that reads only them would derive another sub for the same user from one request to
   * the next. `sourceAttributes` is the stable source.
   */
  claims: Record<string, unknown>;
  /**
   * The user's attributes (standard claims) the mapping reads from, whatever `claims` carries, so
   * the same user is mapped the same way on every path. Used only for the attributes the mapping
   * reads that `claims` lacks, and only those are taken from it: nothing else is read or released.
   * A function is called, with those attribute names, only when there are any, so a mapping that
   * reads no attribute (or only claims already present) loads nothing. Null: the user has none.
   */
  sourceAttributes?:
    | Record<string, unknown>
    | ((names: string[]) => Promise<Record<string, unknown> | null>);
}

export interface ApplyOIDCIdentityMappingResult {
  claims: Record<string, unknown>;
  binding: RuntimeIdentityMappingBinding | null;
}

/**
 * The sub an app's ID tokens carry for a user: `claims.sub` (the user's id) unless the app's
 * identity mapping issues another (pairwise or persistent identifiers, or one derived from the
 * user's claims, which `claims` should then hold as at issuance). Only the subject is derived:
 * the other fields' validation and release consent do not apply. A mapping that produces no sub
 * leaves `claims.sub`.
 */
export async function deriveOIDCSubject(input: ApplyOIDCIdentityMappingInput): Promise<string> {
  const userId = typeof input.claims.sub === 'string' ? input.claims.sub : '';
  const { claims } = await applyOIDCIdentityMapping({ ...input, subjectOnly: true });
  return typeof claims.sub === 'string' ? claims.sub : userId;
}

export async function applyOIDCIdentityMapping(
  input: ApplyOIDCIdentityMappingInput & { subjectOnly?: boolean }
): Promise<ApplyOIDCIdentityMappingResult> {
  // Which Mapping Set applies is decided by what is named, never by an activation's scope: the
  // app's own choice, else the tenant's default, else the platform's, else none. A level that is
  // set and cannot be used fails here (the request is not answered without the mapping); a
  // selection of none reads no database.
  let resolution: OidcIdentityMappingResolution;
  try {
    resolution = await resolveOidcIdentityMappingBinding({
      env: input.env,
      tenantId: input.tenantId,
      clientId: input.clientId,
      clientSelector: input.selector,
    });
  } catch (error) {
    throw toOidcIdentityMappingRuntimeError(error, { clientId: input.clientId });
  }
  const { selection, binding } = resolution;

  if (!binding) {
    if (input.subjectOnly) return { claims: input.claims, binding: null };
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

  // The binding carries the tenant ID that owns the set: the calling tenant's, or the platform's.
  // A mapping the platform owns releases into a Destination Profile the platform owns: the
  // profile is looked up under its owner, so a profile a tenant owns is never taken for it.
  const ownedByPlatform = binding.tenantId === PLATFORM_MAPPING_TENANT_ID;
  const destinationProfileAdapter = requireDedicatedAdminDatabaseAdapter(
    input.env,
    'oidc-destination-profile-safety'
  );
  const destinationDescriptor = await loadDestinationProfileConsentDescriptor(
    destinationProfileAdapter,
    ownedByPlatform ? PLATFORM_MAPPING_TENANT_ID : input.tenantId,
    binding.destinationProfileId
  );
  if (destinationDescriptor?.destinationType === 'oidc') {
    if (ownedByPlatform) {
      // One mapping serves every tenant, so a source whose classification cannot be told is
      // refused rather than let through.
      assertRuntimeIdentityMappingReleaseSafety(binding, destinationDescriptor.fields, true, {
        requireKnownSources: true,
      });
    } else {
      assertRuntimeIdentityMappingReleaseSafety(binding, destinationDescriptor.fields, true);
    }
  }

  // The namespace the app's own selector names applies only where the app chose the set.
  const destinationNamespace =
    (selection.kind === 'bound' ? selection.selector?.destinationNamespace : undefined) ??
    binding.destinationNamespace ??
    'oidc.claim';
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

  if (input.subjectOnly) {
    // The last value wins, as issuance overwrites edge outputs with transform results.
    let subject: unknown = input.claims.sub;
    for (const value of runtimeResult.values) {
      if (
        value.sourceRef.side === 'destination' &&
        value.sourceRef.namespace === destinationNamespace &&
        value.sourceRef.path === 'sub'
      ) {
        subject = value.value;
      }
    }
    assertMappedSubjectNotReserved(input, binding, subject);
    return { claims: { sub: subject }, binding };
  }

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
  assertMappedSubjectNotReserved(input, binding, mappedClaims.sub);

  return {
    claims: await applyOIDCDestinationFieldConsent(input, mappedClaims, binding),
    binding,
  };
}

async function loadMappedCustomClaimSources(
  input: ApplyOIDCIdentityMappingInput,
  binding: RuntimeIdentityMappingBinding
): Promise<Record<string, unknown>> {
  let claims = withCanonicalProfileAliases(input.claims);
  const referencedKeys = Array.from(new Set(mappingSourceRefs(binding).map((ref) => ref.path)));
  const missingKeys = () =>
    referencedKeys.filter((path) => !Object.prototype.hasOwnProperty.call(claims, path));

  // The user's own attributes first: the same ones whatever this request's claims carry.
  if (input.sourceAttributes && missingKeys().length > 0) {
    const attributes = withCanonicalProfileAliases(
      (typeof input.sourceAttributes === 'function'
        ? await input.sourceAttributes(missingKeys())
        : input.sourceAttributes) ?? {}
    );
    for (const key of missingKeys()) {
      if (attributes[key] != null) claims = { ...claims, [key]: attributes[key] };
    }
  }

  // The platform's mapping is saved without tenant-defined fields, so a key it reads that the
  // claims lack is a standard one. Looking it up among the calling tenant's custom fields would
  // let a tenant's field of the same name stand in for it.
  if (binding.tenantId === PLATFORM_MAPPING_TENANT_ID) return claims;
  const subjectId = typeof input.claims.sub === 'string' ? input.claims.sub : '';
  if (!subjectId) return claims;

  const customKeys = missingKeys();
  if (customKeys.length === 0) return claims;

  const featureConfig = await loadFeatureConfig(input.env as Env, input.tenantId);
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
  const custom = await resolver.resolveFieldValues(input.tenantId, subjectId, customKeys);
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
  // Only a Mapping Set that was selected brings a Destination Profile. An app whose selector names
  // only a profile (no set) is not bound to it: the profile is not looked up for a request that
  // no Mapping Set governs, as the consent screen does not look it up.
  const profileId = binding?.destinationProfileId;
  const subjectId = typeof input.claims.sub === 'string' ? input.claims.sub : '';
  const authorizedClaimNames = input.authorizedClaimNames ?? [];
  if (!profileId) return filterOidcClaimsWithoutDestinationProfile(claims);
  if (!subjectId) {
    throw new OIDCIdentityMappingRuntimeError(
      'OIDC destination release requires a subject identifier',
      {
        code: 'policy.missing_destination_subject',
        fieldMappingSetId: binding?.fieldMappingSetId,
        clientId: input.clientId,
      }
    );
  }
  return filterOidcClaimsByDestinationConsent({
    coreAdapter: input.adapter,
    adminAdapter: requireDedicatedAdminDatabaseAdapter(
      input.env,
      'oidc-destination-profile-consent'
    ),
    tenantId: input.tenantId,
    subjectId,
    clientId: input.clientId,
    profileId,
    surface: input.destinationSurface,
    ...(input.userInfoClaimsInIdToken && input.destinationSurface === 'id_token'
      ? { alsoSurfaces: ['userinfo' as const] }
      : {}),
    grantedScopes: input.grantedScopes,
    ...(input.claimsAuthorizedByRequest
      ? { authorizedClaims: unchangedClaimNames(input.claims, claims) }
      : authorizedClaimNames.length > 0
        ? {
            authorizedClaims: new Set(
              [...unchangedClaimNames(input.claims, claims)].filter((name) =>
                authorizedClaimNames.includes(name)
              )
            ),
          }
        : {}),
    claims,
  });
}

/**
 * The claims the caller handed in that the mapping left with the value it was given. Only these
 * are the ones the caller authorized; a claim the mapping replaced is the mapping's own output.
 */
function unchangedClaimNames(
  authorized: Record<string, unknown>,
  mapped: Record<string, unknown>
): Set<string> {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(authorized)) {
    if (!Object.prototype.hasOwnProperty.call(mapped, name)) continue;
    if (claimValuesEqual(mapped[name], value)) names.add(name);
  }
  return names;
}

/** Equal as JSON values are: arrays in order, object members in any order (address, say). */
function claimValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => claimValuesEqual(item, right[index]))
    );
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftEntries = Object.entries(left as Record<string, unknown>);
    const rightRecord = right as Record<string, unknown>;
    return (
      leftEntries.length === Object.keys(rightRecord).length &&
      leftEntries.every(
        ([key, item]) =>
          Object.prototype.hasOwnProperty.call(rightRecord, key) &&
          claimValuesEqual(item, rightRecord[key])
      )
    );
  }
  return false;
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

/**
 * Every source field a mapping reads, from the one place that decides it: the sources of its
 * edges (which its transforms read through the edges they take) and the source fields its
 * validation rules check. The attributes to load for a mapping, and the values it is handed,
 * both come from this list, so a field a mapping reads cannot be left unloaded or unpassed.
 */
export function mappingSourceRefs(
  binding: Pick<RuntimeIdentityMappingBinding, 'edges' | 'validationRules'>
): FieldRef[] {
  const refs: FieldRef[] = [];
  const seen = new Set<string>();
  const add = (ref: FieldRef) => {
    if (ref.side !== 'source' || !ref.path) return;
    const key = `${ref.namespace}:${ref.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };
  for (const edge of binding.edges) add(edge.sourceRef);
  for (const rule of binding.validationRules ?? []) add(rule.targetRef);
  return refs;
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
  for (const ref of mappingSourceRefs(binding)) {
    if (!Object.prototype.hasOwnProperty.call(claims, ref.path)) continue;
    const key = `${ref.namespace}:${ref.path}`;
    if (seen.has(key)) continue;
    values.push({ value: claims[ref.path], sourceRef: ref });
    seen.add(key);
  }
  return values;
}

/**
 * A mapped sub must not take a client or admin principal namespace (client:, machine:,
 * admin_user:), which only those issuance paths use: a token with such a sub would be taken for a
 * non-account subject.
 */
function assertMappedSubjectNotReserved(
  input: ApplyOIDCIdentityMappingInput,
  binding: RuntimeIdentityMappingBinding,
  subject: unknown
): void {
  if (subject === input.claims.sub || typeof subject !== 'string') return;
  if (!isNonAccountSubject(subject)) return;
  throw new OIDCIdentityMappingRuntimeError('OIDC identity mapping produced a reserved subject', {
    code: 'policy.identity_mapping_reserved_subject',
    fieldMappingSetId: binding.fieldMappingSetId,
    fieldMappingVersionId: binding.fieldMappingVersionId,
    clientId: input.clientId,
  });
}

/**
 * The error the release of claims answers with for a failure of the selection or of reading the
 * set it chose: 400 `invalid_client` / `invalid_client_metadata` for a configuration the app
 * cannot be served with (the set it names is gone or inactive, its Destination Profile is not one,
 * a default or the app's own choice is not a value), 500 for a database or settings that cannot be
 * read. Anything else is returned as it is.
 */
export function toOidcIdentityMappingRuntimeError(
  error: unknown,
  context: { clientId?: string } = {}
): unknown {
  if (error instanceof IdentityMappingResolutionError) {
    switch (error.code) {
      case 'set_missing':
      case 'set_inactive':
        return new OIDCIdentityMappingRuntimeError(
          'No active OIDC identity mapping binding found for selected policy',
          {
            code: 'policy.missing_identity_mapping_binding',
            fieldMappingSetId: error.setId,
            clientId: context.clientId,
          }
        );
      case 'destination_profile_invalid':
        return new OIDCIdentityMappingRuntimeError(
          'OIDC identity mapping must reference exactly one Destination Profile',
          {
            code: 'policy.invalid_destination_profile_binding',
            fieldMappingSetId: error.setId,
            clientId: context.clientId,
          }
        );
      default:
        // The Admin database could not be read: not a fault of the app's configuration.
        return error;
    }
  }
  if (error instanceof IdentityMappingSelectionError) {
    if (error.code === 'default_setting_invalid' || error.code === 'client_selector_invalid') {
      return new OIDCIdentityMappingRuntimeError(
        error.code === 'default_setting_invalid'
          ? 'The default OIDC identity mapping is not usable'
          : 'The OIDC identity mapping of the client is not usable',
        {
          code:
            error.code === 'default_setting_invalid'
              ? 'policy.invalid_default_identity_mapping'
              : 'policy.invalid_client_identity_mapping',
          clientId: context.clientId,
        }
      );
    }
  }
  return error;
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
