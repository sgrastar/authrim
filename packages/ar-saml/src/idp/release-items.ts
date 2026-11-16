import { prepareTenantMappingHashes } from '@authrim/ar-lib-core/services/mapping-hash';
import type { MappingEvaluationValue } from '@authrim/ar-lib-field-mapping/contract';
import {
  analyzeMappingDependencies,
  withMappingGraph,
} from '@authrim/ar-lib-field-mapping/authoring';
/**
 * The information a SAML SP would be given in an assertion, worked out in two steps so nothing is
 * made for a release the person has not approved:
 *
 * 1. `computeSAMLAttributeRelease` with identifiers deferred: the attributes the mapping, the
 *    institution and the Destination Profile release, where hash/identifier-dependent items
 *    have identities but no values until approved. These are the
 *    consent screen's items, with the NameID (`samlReleaseItems`).
 * 2. Once approved: the release again with identifiers made, only when an approved item needs
 *    one; then held to the approval (`applySAMLReleaseApproval`). The NameID and the session index
 *    are made only after that, when the response is built.
 */
import { executeRuntimeMapping } from '@authrim/ar-lib-field-mapping/runtime';
import type {
  Env,
  NameIDFormat,
  SAMLAttribute,
  SAMLSPConfig,
  SamlReleaseItem,
} from '@authrim/ar-lib-core';
import {
  DEFAULT_IDENTIFIER_SALT_REF,
  assertRuntimeIdentityMappingReleaseSafety,
  filterSamlAttributesByDestinationProfile,
  createIdentifierSourceReader,
  createStoredIdentifierLookup,
  prepareMappedIdentifiers,
  createIdentifierExceptionReader,
  readImportedIdentifierSalt,
  filterSamlAttributesByDestinationProfileDescriptor,
  requireAdminDatabaseAdapter,
  RELEASE_APPROVE_ALL,
  RELEASE_APPROVE_REQUIRED,
  samlReleaseItemKey,
} from '@authrim/ar-lib-core';
import { NAMEID_FORMATS } from '../common/constants';
import type { SAMLUserInfo } from '../common/user-store';
import {
  buildIdentityMappingSourceValues,
  resolveSAMLIdentityMappingFieldMappingBinding,
  type SAMLAttributeSubject,
  type SAMLIdentityMappingFieldMappingBinding,
  type SAMLIdentityMappingRuntimeContext,
  type SAMLIdentityMappingReleaseConfig,
  SAMLIdentityMappingRuntimeError,
} from './attributes';
import { prepareSAMLReleaseSubject } from './release-subject';
import { releaseSAMLAttributesWithInstitution } from './institution-release';
import type { SAMLWithheldScopedValues } from './institution-scope';
import {
  assertSAMLImportedSPRelease,
  resolveSAMLRuntimeIdentityMapping,
} from './runtime-identity-mapping';
import { resolveSAMLPairwiseSecretForRef } from './subject';

const EMPTY_CATALOG = {
  identity: { id: 'saml.nameid', version: '1', contentHash: 'none', compatibilityRange: '*' },
  entries: [],
};

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
  /** Test users never read account evidence, identifier stores or secrets. */
  fixture?: boolean;
}): Promise<SAMLAttributeRelease> {
  const { env, tenantId, idpEntityId, spConfig, userInfo } = input;
  const identityMapping = await resolveSAMLRuntimeIdentityMapping(
    env,
    tenantId,
    idpEntityId,
    spConfig
  );
  const runtimeContext = {
    saml: { localEntityId: idpEntityId, partnerEntityId: spConfig.entityId },
  };
  const mappingContext = {
    role: 'idp' as const,
    tenantId,
    localEntityId: idpEntityId,
    partnerEntityId: spConfig.entityId,
    runtimeContext,
  };
  const preparedSubject = await prepareSAMLReleaseSubject(userInfo, {
    requestScope: input.requestScope,
    env,
    tenantId,
    userId: input.userId,
    identityMapping,
    mappingContext,
    onError: input.onError,
    fixture: input.fixture,
  });
  const release = await releaseSAMLAttributesWithInstitution({
    env,
    tenantId,
    ...preparedSubject,
    releaseConfig: {
      ...spConfig,
      tenantId,
      localEntityId: idpEntityId,
      identityMapping: identityMapping ? { ...identityMapping, runtimeContext } : undefined,
    },
    onError: input.onError,
    prepareIdentifiers: identityMapping
      ? (subject) =>
          prepareSAMLMappedIdentifiers({
            env,
            tenantId,
            idpEntityId,
            spEntityId: spConfig.entityId,
            subject,
            identityMapping,
            mappingContext,
            deferIdentifiers: input.identifiers === 'deferred',
            fixture: input.fixture,
          })
      : undefined,
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
        .filter((attribute) => release.deferredAttributes?.includes(attribute.name))
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
 * none whose value is still deferred. A required attribute left out, or the NameID not
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
    if (take && !release.deferred.has(attribute.name)) {
      attributes.push(attribute);
    } else if (isRequired(attribute.name)) {
      missing.push(attribute.name);
    }
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, attributes };
}

/**
 * The `persistent_identifier` steps' values for the binding the release uses, made from the
 * subject as released. Before consent their prepared steps are deferred: nothing is made for a release that
 * may not happen. A step that cannot be made is left out, which fails the release.
 */
async function prepareSAMLMappedIdentifiers(input: {
  env: Env;
  tenantId: string;
  idpEntityId: string;
  spEntityId: string;
  subject: SAMLAttributeSubject;
  identityMapping: SAMLIdentityMappingReleaseConfig;
  mappingContext: SAMLIdentityMappingRuntimeContext;
  deferIdentifiers: boolean;
  fixture?: boolean;
}): Promise<{
  identifiers: Record<string, string>;
  suppressed: Record<string, true>;
  preparedSteps?: ReadonlyMap<string, MappingEvaluationValue>;
  allowDeferredOutputs: boolean;
}> {
  let binding: SAMLIdentityMappingFieldMappingBinding;
  try {
    binding = withMappingGraph(
      resolveSAMLIdentityMappingFieldMappingBinding(input.identityMapping, input.mappingContext)
    );
  } catch {
    // No binding applies: the release refuses for that reason, not for an identifier.
    return { identifiers: {}, suppressed: {}, allowDeferredOutputs: input.deferIdentifiers };
  }
  const deferredSteps = new Map<string, MappingEvaluationValue>();
  if (input.deferIdentifiers) {
    for (const step of binding.transforms ?? []) {
      if (step.operation === 'persistent_identifier')
        deferredSteps.set(step.id, { kind: 'deferred' });
    }
  }
  if (input.fixture && !input.deferIdentifiers) {
    return {
      identifiers: {},
      suppressed: Object.fromEntries(
        (binding.transforms ?? [])
          .filter((step) => step.operation === 'persistent_identifier')
          .map((step) => [step.id, true])
      ),
      preparedSteps: new Map(
        (binding.transforms ?? [])
          .filter((step) => step.operation === 'hash')
          .map((step) => [step.id, { kind: 'failed' }])
      ),
      allowDeferredOutputs: false,
    };
  }
  const prepared = input.deferIdentifiers
    ? { identifiers: {}, suppressed: {} }
    : await prepareMappedIdentifiers({
        transforms: binding.transforms ?? [],
        // The account's ID as the runtime holds it (the user ID), supplied directly: never read from
        // the subject's attributes or custom claims.
        accountId: input.subject.id || null,
        recipient: {
          protocol: 'saml',
          spEntityId: input.spEntityId,
          idpEntityId: input.idpEntityId,
        },
        loadDefaultSalt: async () =>
          (await resolveSAMLPairwiseSecretForRef(
            input.env,
            input.tenantId,
            DEFAULT_IDENTIFIER_SALT_REF
          )) ?? null,
        // Read only, never made: an imported salt that is not there stops the release.
        loadImportedSalt: (name) =>
          readImportedIdentifierSalt(input.env.KEY_MANAGER, input.tenantId, name),
        lookupStoredIdentifier: (store, audience, accountId) =>
          createStoredIdentifierLookup(
            requireAdminDatabaseAdapter(input.env, 'saml-mapped-identifier-store'),
            input.tenantId
          )(store, audience, accountId),
        lookupSourceValue: (source, accountId) =>
          createIdentifierSourceReader(
            requireAdminDatabaseAdapter(input.env, 'saml-identifier-source-values'),
            input.tenantId
          )(source, accountId),
        lookupException: (list, accountId, audience) =>
          createIdentifierExceptionReader(
            requireAdminDatabaseAdapter(input.env, 'saml-identifier-exceptions'),
            input.tenantId
          )(list, accountId, audience),
      });
  const hashes = await prepareTenantMappingHashes(
    input.env,
    input.tenantId,
    binding.graphRules ?? [],
    {
      catalog: binding.catalog,
      edges: binding.edges,
      sourceValues: buildIdentityMappingSourceValues(input.subject, binding.edges),
      runtimeContext: {
        identifiers: prepared.identifiers,
        suppressedIdentifiers: prepared.suppressed,
      },
      sourceCatalogValidation: 'receiver',
      preparedSteps: deferredSteps,
    },
    input.deferIdentifiers
  );
  return {
    identifiers: prepared.identifiers,
    suppressed: prepared.suppressed,
    preparedSteps: new Map([...deferredSteps, ...hashes]),
    allowDeferredOutputs: input.deferIdentifiers,
  };
}

/**
 * The persistent NameID the SP's mapping supplies: a plain copy or a persistent_identifier step
 * (plain format) into `saml.nameid`. Undefined when it supplies none, so Authrim's own NameID is
 * used. Anything else (two steps, other settings, an identifier that cannot be made) stops the
 * response: no other NameID is sent in its place.
 */
export async function resolveSAMLMappedNameID(input: {
  env: Env;
  tenantId: string;
  idpEntityId: string;
  spConfig: SAMLSPConfig;
  userInfo: SAMLUserInfo;
  fixture?: boolean;
}): Promise<(() => Promise<{ value: string; kept: boolean }>) | undefined> {
  const identityMapping = await resolveSAMLRuntimeIdentityMapping(
    input.env,
    input.tenantId,
    input.idpEntityId,
    input.spConfig
  );
  const graph = identityMapping?.nameId;
  if (!graph || (graph.transforms.length === 0 && !graph.graphRules?.length)) return undefined;
  const refuse = (): never => {
    throw new SAMLIdentityMappingRuntimeError([
      {
        category: 'policy',
        code: 'policy.persistent_identifier_unavailable',
        severity: 'critical',
      },
    ]);
  };
  const rules = graph.graphRules;
  const rule = rules?.[0];
  if (rules && (rules.length !== 1 || !rule)) refuse();
  if (rule && 'edgeIndex' in rule.output && rule.transforms.length === 0) {
    return async () => {
      const { subject } = await prepareSAMLReleaseSubject(input.userInfo, {
        env: input.env,
        tenantId: input.tenantId,
        userId: input.userInfo.id,
        requestScope: input,
        identityMapping: { ...identityMapping, ...graph },
        mappingContext: {
          role: 'idp',
          tenantId: input.tenantId,
          localEntityId: input.idpEntityId,
          partnerEntityId: input.spConfig.entityId,
        },
        onError: () => undefined,
        fixture: input.fixture,
      });
      const catalog = identityMapping.catalog?.identity ? identityMapping.catalog : EMPTY_CATALOG;
      assertRuntimeIdentityMappingReleaseSafety(
        { catalog, edges: graph.edges, graphRules: graph.graphRules },
        catalog.entries
          .filter((entry) => entry.namespace === 'saml.nameid')
          .map((entry) => ({
            key: entry.path,
            classification: entry.classification,
            requiredScopes: [],
          })),
        false,
        { requireKnownSources: true }
      );
      const checked = executeRuntimeMapping({
        catalog: identityMapping.catalog?.identity ? identityMapping.catalog : EMPTY_CATALOG,
        // Source safety above uses canonical subject reads, as attribute release does.
        sourceCatalogValidation: 'receiver',
        sourceValues: buildIdentityMappingSourceValues(subject, graph.edges),
        graphRules: graph.graphRules,
        edges: graph.edges,
        transforms: [],
        validationRules: graph.validationRules,
      });
      const value = checked.values[0]?.value;
      if (checked.status === 'failed' || typeof value !== 'string' || value.length === 0)
        return refuse();
      return { value, kept: false };
    };
  }
  const dependencies = rule
    ? analyzeMappingDependencies({ ...rule, edgeCount: rule.edges.length })
    : undefined;
  const steps =
    rule && dependencies
      ? dependencies.stepIndexes.map((index) => ({
          ...rule.transforms[index],
          inputEdgeIds: [],
          outputTargetRef: rule.targetRef,
        }))
      : graph.transforms;
  const [step, ...others] = steps;
  if (
    !step ||
    others.length > 0 ||
    step.operation !== 'persistent_identifier' ||
    step.parameters?.format !== 'plain'
  ) {
    refuse();
  }
  return async () => {
    if (input.fixture) {
      throw new SAMLIdentityMappingRuntimeError([
        {
          category: 'policy',
          code: 'policy.test_user_identifier_not_evaluated',
          severity: 'critical',
        },
      ]);
    }
    const sourceValues = buildIdentityMappingSourceValues(input.userInfo, graph.edges);
    const prepared = await prepareMappedIdentifiers({
      transforms: [step],
      accountId: input.userInfo.id || null,
      recipient: {
        protocol: 'saml',
        spEntityId: input.spConfig.entityId,
        idpEntityId: input.idpEntityId,
      },
      loadDefaultSalt: async () =>
        (await resolveSAMLPairwiseSecretForRef(
          input.env,
          input.tenantId,
          DEFAULT_IDENTIFIER_SALT_REF
        )) ?? null,
      loadImportedSalt: (name) =>
        readImportedIdentifierSalt(input.env.KEY_MANAGER, input.tenantId, name),
      lookupStoredIdentifier: (store, audience, accountId) =>
        createStoredIdentifierLookup(
          requireAdminDatabaseAdapter(input.env, 'saml-mapped-identifier-store'),
          input.tenantId
        )(store, audience, accountId),
      lookupSourceValue: (source, accountId) =>
        createIdentifierSourceReader(
          requireAdminDatabaseAdapter(input.env, 'saml-identifier-source-values'),
          input.tenantId
        )(source, accountId),
      lookupException: (list, accountId, audience) =>
        createIdentifierExceptionReader(
          requireAdminDatabaseAdapter(input.env, 'saml-identifier-exceptions'),
          input.tenantId
        )(list, accountId, audience),
    });
    // A suppressed NameID is no NameID: required, so refused like one that cannot be made.
    const value = prepared.identifiers[step.id];
    if (prepared.suppressed[step.id]) {
      throw new SAMLIdentityMappingRuntimeError([
        {
          category: 'policy',
          code: 'policy.identifier_suppressed',
          severity: 'critical',
        },
      ]);
    }
    if (!value) return refuse();
    // The mapping's own checks on what it is made from, as for any other value it releases.
    const checked = executeRuntimeMapping({
      catalog: identityMapping.catalog?.identity ? identityMapping.catalog : EMPTY_CATALOG,
      sourceValues,
      graphRules: graph.graphRules,
      edges: graph.edges,
      transforms: [step],
      validationRules: graph.validationRules,
      runtimeContext: { identifiers: prepared.identifiers },
    });
    if (checked.status === 'failed') return refuse();
    return { value, kept: prepared.kept[step.id] === true };
  };
}
