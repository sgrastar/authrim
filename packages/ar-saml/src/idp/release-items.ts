/**
 * The information a SAML SP would be given in an assertion, worked out in two steps so nothing is
 * made for a release the person has not approved:
 *
 * 1. `computeSAMLAttributeRelease` with identifiers deferred: the attributes the mapping, the
 *    institution and the Destination Profile release (with their checks), where a pairwise
 *    identifier (eduPersonTargetedID) stands as a placeholder, never made or shown. These are the
 *    consent screen's items, with the NameID (`samlReleaseItems`).
 * 2. Once approved: the release again with identifiers made, only when an approved item needs
 *    one; then held to the approval (`applySAMLReleaseApproval`). The NameID and the session index
 *    are made only after that, when the response is built.
 */
import type {
  Env,
  NameIDFormat,
  SAMLAttribute,
  SAMLSPConfig,
  SamlReleaseItem,
} from '@authrim/ar-lib-core';
import {
  filterSamlAttributesByDestinationProfile,
  filterSamlAttributesByDestinationProfileDescriptor,
  requireAdminDatabaseAdapter,
  RELEASE_APPROVE_ALL,
  RELEASE_APPROVE_REQUIRED,
  samlReleaseItemKey,
} from '@authrim/ar-lib-core';
import { NAMEID_FORMATS } from '../common/constants';
import type { SAMLUserInfo } from '../common/user-store';
import {
  resolveSAMLIdentityMappingFieldMappingBinding,
  type SAMLIdentityMappingReleaseConfig,
  SAMLIdentityMappingRuntimeError,
} from './attributes';
import { withSAMLAssuranceAttributes } from './identity-assurance';
import { releaseSAMLAttributesWithInstitution } from './institution-release';
import type { SAMLWithheldScopedValues } from './institution-scope';
import {
  assertSAMLImportedSPRelease,
  resolveSAMLRuntimeIdentityMapping,
} from './runtime-identity-mapping';
import {
  resolveSAMLEduPersonTargetedIDOpaque,
  resolveSAMLPairwiseSecret,
  resolveSAMLPairwiseSecretForRef,
  resolveSAMLPersistentNameIDRegistryStore,
  type SAMLPersistentIdentifierAlgorithm,
} from './subject';

/**
 * What stands for a pairwise identifier before it is made. An attribute carrying it is an item
 * whose value is made only once approved.
 */
const DEFERRED_IDENTIFIER = 'authrim-deferred-identifier';

export interface SAMLAttributeRelease {
  attributes: SAMLAttribute[];
  /** Names of the attributes the SP requires; 'all' without a Destination Profile. */
  required: Set<string> | 'all';
  /** What the Destination Profile calls each attribute. */
  labels: Map<string, string>;
  /** Names of the attributes whose value is made only once approved. */
  deferred: Set<string>;
  withheldScopedValues: SAMLWithheldScopedValues[];
  optionalMissingAttributes: string[];
}

/**
 * The attributes released to the SP for this person (see the file comment). Throws the mapping's,
 * the release policy's and the Destination Profile's errors as before.
 */
export async function computeSAMLAttributeRelease(input: {
  env: Env;
  tenantId: string;
  idpEntityId: string;
  spConfig: SAMLSPConfig;
  userInfo: SAMLUserInfo;
  /** The session's user (the owner of the assurance evidence). */
  userId: string;
  /** Per-request cache scope for evidence reads. */
  requestScope: object;
  identifiers: 'deferred' | 'made';
  onError: (message: string, error: unknown) => void;
}): Promise<SAMLAttributeRelease> {
  const { env, tenantId, idpEntityId, spConfig, userInfo } = input;
  const identityMapping = await resolveSAMLRuntimeIdentityMapping(
    env,
    tenantId,
    idpEntityId,
    spConfig
  );
  const runtimeContext = await buildSAMLIdentityMappingRuntimeContext({
    env,
    tenantId,
    idpEntityId,
    spEntityId: spConfig.entityId,
    userInfo,
    identityMapping,
    deferIdentifiers: input.identifiers === 'deferred',
  });
  const mappingContext = {
    role: 'idp' as const,
    tenantId,
    localEntityId: idpEntityId,
    partnerEntityId: spConfig.entityId,
    runtimeContext,
  };
  const release = await releaseSAMLAttributesWithInstitution({
    env,
    tenantId,
    subject: await withSAMLAssuranceAttributes(userInfo, {
      requestScope: input.requestScope,
      env,
      tenantId,
      userId: input.userId,
      identityMapping,
      mappingContext,
      onError: input.onError,
    }),
    releaseConfig: {
      ...spConfig,
      tenantId,
      localEntityId: idpEntityId,
      identityMapping: identityMapping ? { ...identityMapping, runtimeContext } : undefined,
    },
    onError: input.onError,
  });
  let attributes = release.attributes;
  let required: Set<string> | 'all' = 'all';
  let labels = new Map<string, string>();
  if (identityMapping?.destinationProfileId) {
    const releaseInput = {
      profileId: identityMapping.destinationProfileId,
      fieldPolicies: identityMapping.destinationFieldPolicies,
      releaseSafetyBinding: resolveSAMLIdentityMappingFieldMappingBinding(
        identityMapping,
        mappingContext
      ),
      attributes,
    };
    let profiled;
    if (env.SAML_RUNTIME_PORTS) {
      const importedRelease = env.SAML_RUNTIME_PORTS.serviceProviders.getRelease({
        tenantId,
        entityId: spConfig.entityId,
      });
      assertSAMLImportedSPRelease(importedRelease ?? null, {
        tenantId,
        spEntityId: spConfig.entityId,
        idpEntityId,
        sourceSelector: spConfig.identityMapping,
      });
      profiled = filterSamlAttributesByDestinationProfileDescriptor({
        ...releaseInput,
        descriptor: importedRelease?.destinationProfile ?? null,
      });
    } else {
      profiled = await filterSamlAttributesByDestinationProfile({
        ...releaseInput,
        tenantId,
        adminAdapter: requireAdminDatabaseAdapter(env, 'saml-destination-profile'),
      });
    }
    attributes = profiled.attributes;
    required = profiled.required;
    labels = profiled.labels;
  }
  return {
    attributes,
    required,
    labels,
    deferred: new Set(
      attributes
        .filter((attribute) =>
          attribute.values.some((value) => value.includes(DEFERRED_IDENTIFIER))
        )
        .map((attribute) => attribute.name)
    ),
    withheldScopedValues: release.withheldScopedValues ?? [],
    optionalMissingAttributes: release.optionalMissingAttributes.map((item) => item.name),
  };
}

/** The key of an attribute's item. */
export function samlAttributeItemKey(attribute: Pick<SAMLAttribute, 'name' | 'nameFormat'>) {
  return samlReleaseItemKey({
    kind: 'attribute',
    name: attribute.name,
    nameFormat: attribute.nameFormat ?? null,
  });
}

/** The key of the NameID's item (always required: the assertion's subject). */
export function samlNameIdItemKey(format: NameIDFormat): string {
  return samlReleaseItemKey({ kind: 'nameid', format });
}

/**
 * The items of a release, as the consent screen shows them: the NameID first, then the
 * attributes. Values only when the SP shows them, and never for an item made once approved.
 */
export function samlReleaseItems(
  release: SAMLAttributeRelease,
  input: { nameIdFormat: NameIDFormat; userInfo: SAMLUserInfo; showValues: boolean }
): SamlReleaseItem[] {
  const email = typeof input.userInfo.email === 'string' ? input.userInfo.email.trim() : '';
  const nameIdShown = input.nameIdFormat === NAMEID_FORMATS.EMAIL && email;
  const items: SamlReleaseItem[] = [
    {
      key: samlNameIdItemKey(input.nameIdFormat),
      kind: 'nameid',
      label: input.nameIdFormat,
      required: true,
      ...(nameIdShown ? (input.showValues ? { values: [email] } : {}) : { deferred: true }),
    },
  ];
  for (const attribute of release.attributes) {
    const deferred = release.deferred.has(attribute.name);
    items.push({
      key: samlAttributeItemKey(attribute),
      kind: 'attribute',
      label: release.labels.get(attribute.name) ?? attribute.friendlyName ?? attribute.name,
      required: release.required === 'all' || release.required.has(attribute.name),
      ...(deferred
        ? { deferred: true }
        : input.showValues
          ? { values: [...attribute.values] }
          : {}),
    });
  }
  return items;
}

/** Whether an approval needs identifiers made (an approved item whose value is made then). */
export function samlApprovalNeedsIdentifiers(
  release: SAMLAttributeRelease,
  approval: readonly string[]
): boolean {
  if (release.deferred.size === 0) return false;
  const approved = new Set(approval);
  return release.attributes.some(
    (attribute) =>
      release.deferred.has(attribute.name) &&
      (approved.has(RELEASE_APPROVE_ALL) ||
        approved.has(samlAttributeItemKey(attribute)) ||
        (approved.has(RELEASE_APPROVE_REQUIRED) &&
          (release.required === 'all' || release.required.has(attribute.name))))
  );
}

/**
 * Hold the attributes to an approval: the approved ones (all, the required ones, or by key), and
 * none that still carries a placeholder. A required attribute left out, or the NameID not
 * approved, refuses the release (`missing`).
 */
export function applySAMLReleaseApproval(
  release: SAMLAttributeRelease,
  approval: readonly string[],
  nameIdFormat: NameIDFormat
): { ok: true; attributes: SAMLAttribute[] } | { ok: false; missing: string[] } {
  const approved = new Set(approval);
  const all = approved.has(RELEASE_APPROVE_ALL);
  const requiredOnly = approved.has(RELEASE_APPROVE_REQUIRED);
  const isRequired = (name: string) => release.required === 'all' || release.required.has(name);
  const missing: string[] = [];
  if (!all && !requiredOnly && !approved.has(samlNameIdItemKey(nameIdFormat))) {
    missing.push('NameID');
  }
  const attributes: SAMLAttribute[] = [];
  for (const attribute of release.attributes) {
    const take =
      all ||
      approved.has(samlAttributeItemKey(attribute)) ||
      (requiredOnly && isRequired(attribute.name));
    if (take && !attribute.values.some((value) => value.includes(DEFERRED_IDENTIFIER))) {
      attributes.push(attribute);
    } else if (isRequired(attribute.name)) {
      missing.push(attribute.name);
    }
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, attributes };
}

async function buildSAMLIdentityMappingRuntimeContext(input: {
  env: Env;
  tenantId: string;
  idpEntityId: string;
  spEntityId: string;
  userInfo: SAMLUserInfo;
  identityMapping?: SAMLIdentityMappingReleaseConfig;
  /** Leave pairwise identifiers unmade (a placeholder stands for them). */
  deferIdentifiers: boolean;
}): Promise<Record<string, unknown>> {
  const samlContext: Record<string, unknown> = {
    localEntityId: input.idpEntityId,
    partnerEntityId: input.spEntityId,
  };

  if (usesSAMLEduPersonTargetedIDTransform(input.identityMapping) && input.deferIdentifiers) {
    samlContext.eduPersonTargetedIdOpaque = DEFERRED_IDENTIFIER;
  } else if (usesSAMLEduPersonTargetedIDTransform(input.identityMapping)) {
    const pairwiseSecretDefault = await resolveSAMLPairwiseSecret(input.env, input.tenantId);
    const persistentRegistry = resolveSAMLPersistentNameIDRegistryStore(input.env);
    const profileId = findSAMLPersistentIdentifierProfileId(input.identityMapping);
    const profile = profileId
      ? await loadSAMLPersistentIdentifierProfile(input.env, input.tenantId, profileId)
      : null;
    const pairwiseSecret = profile?.secretRef
      ? await resolveSAMLPairwiseSecretForRef(input.env, input.tenantId, profile.secretRef)
      : pairwiseSecretDefault;
    if (profile?.issuerEntityId) {
      samlContext.localEntityId = profile.issuerEntityId;
    }
    if (!pairwiseSecret) {
      throw new SAMLIdentityMappingRuntimeError([
        {
          category: 'policy',
          code: profile
            ? 'policy.persistent_identifier_secret_missing'
            : 'policy.identity_mapping_pairwise_secret_missing',
          severity: 'critical',
        },
      ]);
    }
    samlContext.eduPersonTargetedIdOpaque = await resolveSAMLEduPersonTargetedIDOpaque(
      input.userInfo,
      {
        tenantId: input.tenantId,
        spEntityId: input.spEntityId,
        pairwiseSalt: pairwiseSecret,
        pairwiseAlgorithm: profile?.algorithm,
        pairwiseAudienceMode: profile?.audienceMode,
        persistentProfileId: profile?.id,
        persistentRegistry,
      }
    );
  }

  return { saml: samlContext };
}

interface SAMLPersistentIdentifierProfile {
  id: string;
  secretRef?: string;
  issuerEntityId?: string;
  algorithm?: SAMLPersistentIdentifierAlgorithm;
  audienceMode?: 'runtime' | 'saml_sp_entity_id' | 'oidc_sector_identifier';
}

interface SAMLPersistentIdentifierProfileRow {
  id: string;
  mode: string;
  algorithm: string;
  protocol_scope: string;
  secret_ref: string | null;
  issuer_entity_id: string | null;
  audience_mode: string | null;
}

function findSAMLPersistentIdentifierProfileId(
  identityMapping?: SAMLIdentityMappingReleaseConfig
): string | undefined {
  const bindings = [
    identityMapping,
    identityMapping?.defaultBinding,
    ...(identityMapping?.bindings ?? []),
  ];
  for (const binding of bindings) {
    const transform = binding?.transforms?.find(
      (item) => item.operation === 'saml_edu_person_targeted_id'
    );
    const profileId = readString(transform?.parameters?.persistentIdentifierProfileId);
    if (profileId) {
      return profileId;
    }
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function loadSAMLPersistentIdentifierProfile(
  env: Env,
  tenantId: string,
  profileId: string
): Promise<SAMLPersistentIdentifierProfile | null> {
  const adapter = requireAdminDatabaseAdapter(env, 'saml-persistent-identifier-profile');
  const rows = await adapter.query<SAMLPersistentIdentifierProfileRow>(
    `SELECT id, mode, algorithm, protocol_scope, secret_ref, issuer_entity_id, audience_mode
       FROM persistent_identifier_profiles
      WHERE tenant_id = ? AND id = ? AND lifecycle_state = 'active'
      LIMIT 1`,
    [tenantId, profileId]
  );
  const row = rows[0];
  if (!row) {
    throw new SAMLIdentityMappingRuntimeError([
      {
        category: 'policy',
        code: 'policy.persistent_identifier_profile_not_found',
        severity: 'critical',
      },
    ]);
  }
  if (row.mode !== 'computed' || !['any', 'saml', 'generic'].includes(row.protocol_scope)) {
    throw new SAMLIdentityMappingRuntimeError([
      {
        category: 'policy',
        code: 'policy.persistent_identifier_profile_unsupported_mode',
        severity: 'critical',
      },
    ]);
  }
  return {
    id: row.id,
    secretRef: row.secret_ref ?? undefined,
    issuerEntityId: row.issuer_entity_id ?? undefined,
    algorithm: row.algorithm === 'shibboleth_sha1_base64' ? 'shibboleth_sha1_base64' : undefined,
    audienceMode: isSAMLPersistentIdentifierAudienceMode(row.audience_mode)
      ? row.audience_mode
      : undefined,
  };
}

function isSAMLPersistentIdentifierAudienceMode(
  value: string | null
): value is 'runtime' | 'saml_sp_entity_id' | 'oidc_sector_identifier' {
  return value === 'runtime' || value === 'saml_sp_entity_id' || value === 'oidc_sector_identifier';
}

function usesSAMLEduPersonTargetedIDTransform(
  identityMapping?: SAMLIdentityMappingReleaseConfig
): boolean {
  const bindings = [
    identityMapping,
    identityMapping?.defaultBinding,
    ...(identityMapping?.bindings ?? []),
  ];
  return bindings.some((binding) =>
    binding?.transforms?.some((transform) => transform.operation === 'saml_edu_person_targeted_id')
  );
}
