import { executeRuntimeMapping, findCatalogEntry } from '@authrim/ar-lib-field-mapping/runtime';
import type {
  FieldCatalogBundle,
  FieldRef,
  FieldMappingSet,
  MappingRuleEdge,
  MappingTransformStep,
  ReasonCode,
  SourceValueEnvelope,
  ValidationRule,
} from '@authrim/ar-lib-field-mapping/contract';
import type {
  SAMLAttribute,
  SAMLAttributeValueType,
  SAMLComputedAttribute,
} from '@authrim/ar-lib-core';
import {
  findConflictingSourceIds,
  mappingSourceSubjectPath,
  normalizeSubjectReadPath,
} from '@authrim/ar-lib-core';
import {
  applySAMLInstitutionScopePolicy,
  scopedAttributeKind,
  scopedKindFromHints,
  type SAMLInstitutionScopePolicy,
  type SAMLScopedAttributeKind,
  type SAMLWithheldScopedValues,
} from './institution-scope';

export interface SAMLAttributeSubject {
  id: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  display_name?: string;
  given_name?: string;
  family_name?: string;
  preferred_username?: string;
  picture_url?: string;
  locale?: string;
  claims?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  customClaims?: Record<string, unknown>;
  customFields?: Record<string, unknown>;
  /**
   * The person's effective IAL ("IAL2"), read from their assurance evidence. Set only by
   * resolveSAMLAssuranceAttributes, never from user data, and only when a mapping releases it.
   */
  assurance_ial?: string;
  /** The assurance values (eduPersonAssurance URIs) of the person's IAL. Set like assurance_ial. */
  edu_person_assurance?: string[];
  /**
   * The tenant's default institution scope (schacHomeOrganization). Set only by
   * withSAMLInstitutionAttributes from the tenant's settings, never from user data, and only when
   * a mapping releases it.
   */
  schac_home_organization?: string;
  /** The tenant's institution name (the organization name, `o`). Set like schac_home_organization. */
  organization_name?: string;
}

export interface SAMLAttributeReleaseConfig {
  entityId?: string;
  localEntityId?: string;
  tenantId?: string;
  attributeMapping: Record<string, string>;
  attributeReleasePolicy?: {
    attributes: SAMLAttributeReleaseRule[];
  };
  identityMapping?: SAMLIdentityMappingReleaseConfig;
  /**
   * The tenant's registered institution scopes, which the scoped attributes (eduPersonScopedAffiliation,
   * eduPersonPrincipalName) must be under. Left out, the values are released as the mapping gives them.
   */
  institutionScope?: SAMLInstitutionScopePolicy;
  /** The names the tenant registered for its institution, which `o` must be one of. */
  institutionNames?: readonly string[];
}

export interface SAMLAttributeReleaseRule {
  name: string;
  nameFormat?: string;
  friendlyName?: string;
  valueType?: SAMLAttributeValueType;
  source: SAMLAttributeReleaseSource;
  claim?: string;
  value?: string | string[];
  computed?: SAMLComputedAttribute;
  required?: boolean;
}

export interface MissingRequiredSAMLAttribute {
  name: string;
  friendlyName?: string;
  source: SAMLAttributeReleaseSource | 'identity_mapping';
  claim?: string;
}

export interface SAMLIdentityMappingAttributeDescriptor {
  name?: string;
  nameFormat?: string;
  friendlyName?: string;
  valueType?: SAMLAttributeValueType;
  required?: boolean;
}

export type SAMLIdentityMappingRole = 'idp' | 'sp';

export interface SAMLIdentityMappingRuntimeContext {
  role: SAMLIdentityMappingRole;
  tenantId?: string;
  localEntityId?: string;
  partnerEntityId?: string;
  runtimeContext?: Record<string, unknown>;
}

export interface SAMLIdentityMappingFieldMappingBinding {
  id?: string;
  role?: SAMLIdentityMappingRole;
  tenantId?: string;
  localEntityId?: string;
  partnerEntityId?: string;
  catalog: FieldCatalogBundle;
  edges: MappingRuleEdge[];
  transforms?: MappingTransformStep[];
  validationRules?: ValidationRule[];
  fieldMappingSet?: FieldMappingSet;
  destinationNamespace?: string;
  attributeDescriptors?: Record<string, SAMLIdentityMappingAttributeDescriptor>;
  fieldMappingSetId?: string;
  fieldMappingVersionId?: string;
  sourceProfileId?: string;
  destinationProfileId?: string;
  destinationFieldPolicies?: Record<string, 'required' | 'optional' | 'hidden'>;
  runtimeContext?: Record<string, unknown>;
}

export interface SAMLIdentityMappingReleaseConfig extends Partial<SAMLIdentityMappingFieldMappingBinding> {
  defaultBinding?: SAMLIdentityMappingFieldMappingBinding;
  bindings?: SAMLIdentityMappingFieldMappingBinding[];
}

export class MissingRequiredSAMLAttributeError extends Error {
  readonly missingAttributes: MissingRequiredSAMLAttribute[];
  /** The scoped values withheld on the way, which may be why an attribute has none left. */
  readonly withheldScopedValues: SAMLWithheldScopedValues[];

  constructor(
    missingAttributes: MissingRequiredSAMLAttribute[],
    withheldScopedValues: SAMLWithheldScopedValues[] = []
  ) {
    super(
      `Missing required SAML attribute value: ${missingAttributes.map((attr) => attr.name).join(', ')}`
    );
    this.name = 'MissingRequiredSAMLAttributeError';
    this.missingAttributes = missingAttributes;
    this.withheldScopedValues = withheldScopedValues;
  }
}

export class SAMLIdentityMappingRuntimeError extends Error {
  readonly reasons: ReasonCode[];

  constructor(reasons: ReasonCode[]) {
    super(`SAML identity mapping failed: ${reasons.map((item) => item.code).join(', ')}`);
    this.name = 'SAMLIdentityMappingRuntimeError';
    this.reasons = reasons;
  }
}

export type SAMLAttributeReleaseSource =
  | 'claim'
  | 'attribute'
  | 'custom_claim'
  | 'custom_field'
  | 'constant'
  | 'computed';

export interface SAMLAttributeReleaseResult {
  attributes: SAMLAttribute[];
  optionalMissingAttributes: MissingRequiredSAMLAttribute[];
  /** Scoped values the tenant's institution scopes did not allow (see institution-scope.ts). */
  withheldScopedValues?: SAMLWithheldScopedValues[];
}

type AttributeValue = string | number | boolean;

/**
 * Build SAML attributes from the existing claim-to-SAML attribute mapping.
 *
 * This keeps the current SAMLSPConfig.attributeMapping contract intact while
 * centralizing the release logic so a policy-backed resolver can replace the
 * mapping source later.
 */
export function buildSAMLAttributesFromMapping(
  subject: SAMLAttributeSubject,
  attributeMapping: Record<string, string> = {}
): SAMLAttribute[] {
  const attributes: SAMLAttribute[] = [];

  for (const [sourceClaim, samlAttributeName] of Object.entries(attributeMapping)) {
    const values = normalizeAttributeValues(readSubjectValue(subject, sourceClaim));
    if (values.length === 0) {
      continue;
    }

    attributes.push({
      name: samlAttributeName,
      values,
    });
  }

  return attributes;
}

export function buildSAMLAttributesForSP(
  subject: SAMLAttributeSubject,
  spConfig: SAMLAttributeReleaseConfig
): SAMLAttribute[] {
  return buildSAMLAttributesForSPWithDiagnostics(subject, spConfig).attributes;
}

export function buildSAMLAttributesForSPWithDiagnostics(
  subject: SAMLAttributeSubject,
  spConfig: SAMLAttributeReleaseConfig
): SAMLAttributeReleaseResult {
  if (spConfig.identityMapping && hasSAMLIdentityMappingRuntimeConfig(spConfig.identityMapping)) {
    return buildSAMLAttributesFromIdentityMapping(
      subject,
      spConfig.identityMapping,
      {
        role: 'idp',
        tenantId: spConfig.tenantId,
        localEntityId: spConfig.localEntityId,
        partnerEntityId: spConfig.entityId,
        runtimeContext: spConfig.identityMapping.runtimeContext,
      },
      spConfig.institutionScope,
      spConfig.institutionNames
    );
  }

  throw new SAMLIdentityMappingRuntimeError([
    {
      category: 'policy',
      code: 'policy.missing_identity_mapping_binding',
      severity: 'critical',
    },
  ]);
}

export function hasSAMLIdentityMappingRuntimeConfig(
  config: SAMLIdentityMappingReleaseConfig
): boolean {
  return (
    isCompleteSAMLIdentityMappingBinding(config) ||
    Boolean(config.defaultBinding) ||
    Boolean(config.bindings?.length)
  );
}

function buildSAMLAttributesFromIdentityMapping(
  subject: SAMLAttributeSubject,
  config: SAMLIdentityMappingReleaseConfig,
  context: SAMLIdentityMappingRuntimeContext,
  institutionScope?: SAMLInstitutionScopePolicy,
  institutionNames?: readonly string[]
): SAMLAttributeReleaseResult {
  const binding = resolveSAMLIdentityMappingFieldMappingBinding(config, context);
  const destinationNamespace = binding.destinationNamespace ?? 'saml.attribute';
  const sourceValues = buildIdentityMappingSourceValues(subject, binding.edges);
  const result = executeRuntimeMapping({
    catalog: binding.catalog,
    sourceValues,
    edges: binding.edges,
    transforms: binding.transforms,
    validationRules: binding.validationRules,
    fieldMappingSet: binding.fieldMappingSet,
    runtimeContext: context.runtimeContext ?? binding.runtimeContext,
  });

  if (result.status === 'failed') {
    throw new SAMLIdentityMappingRuntimeError(result.reasons);
  }

  const mappedAttributes: Array<{
    attribute: SAMLAttribute;
    kind: SAMLScopedAttributeKind | null;
  }> = [];
  const provenance = mappedProvenance(binding);
  for (const value of result.values) {
    if (value.sourceRef.namespace !== destinationNamespace) continue;
    const attribute = buildAttributeFromMappedValue(value, binding);
    if (!attribute) continue;
    mappedAttributes.push({
      attribute,
      kind: scopedKindOfMappedValue(value.sourceRef, attribute, binding, provenance),
    });
  }
  // What an attribute is does not rest on the name it is released under: the catalog entry, the
  // path and the fields it is read from say so too (see scopedKindOfMappedValue).
  const kindByName = new Map<string, SAMLScopedAttributeKind>();
  for (const { attribute, kind } of mappedAttributes) {
    if (kind && !kindByName.has(attribute.name)) kindByName.set(attribute.name, kind);
  }
  const kindOf = (attribute: SAMLAttribute): SAMLScopedAttributeKind | null =>
    kindByName.get(attribute.name) ?? scopedAttributeKind(attribute);
  const mapped = applyDestinationFieldReleasePolicy(
    mergeSAMLAttributes(mappedAttributes.map(({ attribute }) => attribute)),
    binding.destinationFieldPolicies
  );
  // Before the required attributes are checked: a required scoped attribute none of whose values
  // is under a registered scope is missing, as any other that has no value.
  const { attributes, withheld } = institutionScope
    ? applySAMLInstitutionScopePolicy(mapped, institutionScope, kindOf, institutionNames)
    : { attributes: mapped, withheld: [] };
  const missingAttributes = findMissingRequiredMappedAttributes(
    attributes,
    binding,
    destinationNamespace
  );

  if (missingAttributes.length > 0) {
    throw new MissingRequiredSAMLAttributeError(missingAttributes, withheld);
  }

  return {
    attributes,
    optionalMissingAttributes: [],
    ...(withheld.length > 0 ? { withheldScopedValues: withheld } : {}),
  };
}

export function resolveSAMLIdentityMappingFieldMappingBinding(
  config: SAMLIdentityMappingReleaseConfig,
  context: SAMLIdentityMappingRuntimeContext
): SAMLIdentityMappingFieldMappingBinding {
  const candidates = [
    ...(config.bindings ?? []),
    ...(config.defaultBinding ? [config.defaultBinding] : []),
    ...(isCompleteSAMLIdentityMappingBinding(config) ? [config] : []),
  ] as SAMLIdentityMappingFieldMappingBinding[];
  const exact = selectBestSAMLIdentityMappingFieldMappingBinding(candidates, context, true);
  if (exact) {
    return exact;
  }
  const scopedDefault = selectBestSAMLIdentityMappingFieldMappingBinding(
    candidates,
    context,
    false
  );
  if (scopedDefault) {
    return scopedDefault;
  }
  throw new SAMLIdentityMappingRuntimeError([
    {
      category: 'policy',
      code: 'policy.missing_identity_mapping_binding',
      severity: 'critical',
    },
  ]);
}

/** The subject keys the identity assurance sources of a mapping read (system.identity.*). */
export const SAML_ASSURANCE_SUBJECT_KEYS = {
  ial: 'assurance_ial',
  eduPersonAssurance: 'edu_person_assurance',
} as const;

/** The subject keys the institution sources of a mapping read (system.identity.*). */
export const SAML_INSTITUTION_SUBJECT_KEYS = {
  homeOrganization: 'schac_home_organization',
  organizationName: 'organization_name',
} as const;

export interface SAMLAssuranceSourceNeeds {
  ial: boolean;
  eduPersonAssurance: boolean;
}

/**
 * Which identity assurance sources the mapping that will release attributes reads, so the
 * person's evidence is read only when an attribute built from it can be released: a source that
 * no edge reads, or whose destination field the SP's release policy hides, is not read. Never
 * throws: a mapping that cannot be resolved needs nothing here (the release itself fails on it).
 */
export function findSAMLAssuranceSourceNeeds(
  config: SAMLIdentityMappingReleaseConfig | undefined,
  context: SAMLIdentityMappingRuntimeContext
): SAMLAssuranceSourceNeeds {
  const needs = findSAMLSystemSourceNeeds(config, context, {
    ial: SAML_ASSURANCE_SUBJECT_KEYS.ial,
    eduPersonAssurance: SAML_ASSURANCE_SUBJECT_KEYS.eduPersonAssurance,
  });
  return { ial: needs.ial, eduPersonAssurance: needs.eduPersonAssurance };
}

/**
 * Which of the named subject keys (each a system source the runtime fills) an edge of the mapping
 * reads and releases.
 */
function findSAMLSystemSourceNeeds<Name extends string>(
  config: SAMLIdentityMappingReleaseConfig | undefined,
  context: SAMLIdentityMappingRuntimeContext,
  subjectKeys: Record<Name, string>
): Record<Name, boolean> {
  const needs = Object.fromEntries(
    (Object.keys(subjectKeys) as Name[]).map((name) => [name, false])
  ) as Record<Name, boolean>;
  if (!config || !hasSAMLIdentityMappingRuntimeConfig(config)) return needs;
  let binding: SAMLIdentityMappingFieldMappingBinding;
  try {
    binding = resolveSAMLIdentityMappingFieldMappingBinding(config, context);
  } catch {
    return needs;
  }
  for (const edge of binding.edges) {
    const sourcePath = mappingSourceSubjectPath(edge.sourceRef);
    const key = (Object.keys(subjectKeys) as Name[]).find(
      (name) => subjectKeys[name] === sourcePath
    );
    if (!key || needs[key]) continue;
    const attributeName = findMappedAttributeDescriptor(edge.targetRef, binding)?.name;
    const hidden =
      binding.destinationFieldPolicies?.[attributeName ?? edge.targetRef.path] === 'hidden';
    if (!hidden) needs[key] = true;
  }
  return needs;
}

function isCompleteSAMLIdentityMappingBinding(
  config: SAMLIdentityMappingReleaseConfig
): config is SAMLIdentityMappingFieldMappingBinding {
  return Boolean(config.catalog && Array.isArray(config.edges));
}

function bindingMatches(
  binding: SAMLIdentityMappingFieldMappingBinding,
  context: SAMLIdentityMappingRuntimeContext,
  requirePartnerMatch: boolean
): boolean {
  if (binding.role && binding.role !== context.role) {
    return false;
  }
  if (!scopeMatches(binding.tenantId, context.tenantId)) {
    return false;
  }
  if (!scopeMatches(binding.localEntityId, context.localEntityId)) {
    return false;
  }
  if (requirePartnerMatch) {
    return Boolean(
      binding.partnerEntityId &&
      context.partnerEntityId &&
      binding.partnerEntityId === context.partnerEntityId
    );
  }
  return !binding.partnerEntityId;
}

function selectBestSAMLIdentityMappingFieldMappingBinding(
  candidates: SAMLIdentityMappingFieldMappingBinding[],
  context: SAMLIdentityMappingRuntimeContext,
  requirePartnerMatch: boolean
): SAMLIdentityMappingFieldMappingBinding | undefined {
  return candidates
    .filter((candidate) => bindingMatches(candidate, context, requirePartnerMatch))
    .sort((left, right) => bindingSpecificity(right) - bindingSpecificity(left))[0];
}

function scopeMatches(bindingScope: string | undefined, contextScope: string | undefined): boolean {
  return !bindingScope || bindingScope === contextScope;
}

function bindingSpecificity(binding: SAMLIdentityMappingFieldMappingBinding): number {
  return (
    (binding.role ? 1 : 0) +
    (binding.tenantId ? 2 : 0) +
    (binding.localEntityId ? 4 : 0) +
    (binding.partnerEntityId ? 8 : 0)
  );
}

function buildIdentityMappingSourceValues(
  subject: SAMLAttributeSubject,
  edges: MappingRuleEdge[]
): SourceValueEnvelope[] {
  // A value is matched to an edge by the catalog entry id the edge names, so one id may not stand
  // for different reads: the value read for one would be released as the other's.
  if (findConflictingSourceIds(edges.map((edge) => edge.sourceRef)).length > 0) {
    throw new SAMLIdentityMappingRuntimeError([
      {
        category: 'policy',
        code: 'policy.mapping_source_reference_conflict',
        severity: 'critical',
      },
    ]);
  }

  const seen = new Set<string>();
  const values: SourceValueEnvelope[] = [];

  for (const edge of edges) {
    const key = fieldRefKey(edge.sourceRef);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    values.push({
      value: readMappingSourceValue(subject, edge.sourceRef),
      sourceRef: edge.sourceRef,
      metadata: {
        sourceType: edge.sourceRef.namespace,
        fieldPath: edge.sourceRef.path,
      },
    });
  }

  return values;
}

/** What a mapping keeps about a field that says what it is: its path, catalog entry id and path. */
function fieldHints(
  binding: SAMLIdentityMappingFieldMappingBinding,
  ref: FieldRef,
  withCatalogEntry: boolean
): string[] {
  const hints = [ref.path];
  if (ref.catalogEntryId) hints.push(ref.catalogEntryId);
  if (withCatalogEntry) {
    const entry = findCatalogEntry(binding.catalog, ref);
    if (entry) hints.push(entry.id, entry.path);
  }
  return hints;
}

/**
 * Where each destination's value comes from, by destination (namespace and path): the fields it is read from and
 * the fields it passes through on the way when a transform takes it from its input edges (so a
 * value that goes through a hidden intermediate field and a copy is still known for what it
 * started as). A value read from a field called
 * eduPersonPrincipalName is a principal name whatever it is released as.
 */
function provenanceKey(ref: Pick<FieldRef, 'namespace' | 'path'>): string {
  // The namespace is part of the identity: a field called mail in one namespace is not another's.
  return `${ref.namespace}:${ref.path}`;
}

function mappedProvenance(binding: SAMLIdentityMappingFieldMappingBinding): Map<string, string[]> {
  const byPath = new Map<string, Set<string>>();
  const add = (path: string, hints: readonly string[]): void => {
    const set = byPath.get(path) ?? new Set<string>();
    for (const hint of hints) set.add(hint);
    byPath.set(path, set);
  };
  const edgesById = new Map(binding.edges.map((edge) => [edge.id, edge]));
  for (const edge of binding.edges)
    add(provenanceKey(edge.targetRef), fieldHints(binding, edge.sourceRef, false));
  // A transform's output is what its input edges carry, whatever field they end in (hidden or not).
  for (const step of binding.transforms ?? []) {
    for (const id of step.inputEdgeIds) {
      const edge = edgesById.get(id);
      if (!edge) continue;
      add(provenanceKey(step.outputTargetRef), [
        ...fieldHints(binding, edge.sourceRef, false),
        ...fieldHints(binding, edge.targetRef, true),
      ]);
    }
  }
  return new Map([...byPath].map(([path, hints]) => [path, [...hints]]));
}

/**
 * Which scoped attribute a mapped value is, from everything the mapping keeps about it: the name
 * and friendly name it is released under, the destination's catalog entry and path (what a
 * transform's output names too), and the fields it is read from. Null when none says one.
 */
function scopedKindOfMappedValue(
  target: FieldRef,
  attribute: SAMLAttribute,
  binding: SAMLIdentityMappingFieldMappingBinding,
  provenance: Map<string, string[]>
): SAMLScopedAttributeKind | null {
  const entry = findCatalogEntry(binding.catalog, target);
  return scopedKindFromHints([
    attribute.name,
    attribute.friendlyName,
    target.path,
    target.catalogEntryId,
    entry?.id,
    entry?.path,
    ...(provenance.get(provenanceKey(target)) ?? []),
  ]);
}

function buildAttributeFromMappedValue(
  mappedValue: SourceValueEnvelope,
  config: SAMLIdentityMappingFieldMappingBinding
): SAMLAttribute | null {
  const values = normalizeAttributeValues(mappedValue.value);
  if (values.length === 0) {
    return null;
  }
  const descriptor = findMappedAttributeDescriptor(mappedValue.sourceRef, config);

  return {
    name: descriptor?.name ?? mappedValue.sourceRef.path,
    nameFormat: descriptor?.nameFormat,
    friendlyName: descriptor?.friendlyName,
    valueType: resolveMappedAttributeValueType(mappedValue.sourceRef, config, descriptor),
    values,
  };
}

function resolveMappedAttributeValueType(
  fieldRef: FieldRef,
  config: SAMLIdentityMappingFieldMappingBinding,
  descriptor?: SAMLIdentityMappingAttributeDescriptor
): SAMLAttributeValueType | undefined {
  return (
    descriptor?.valueType ??
    coerceSAMLAttributeValueType((fieldRef as FieldRef & { valueType?: string }).valueType) ??
    coerceSAMLAttributeValueType(findCatalogEntry(config.catalog, fieldRef)?.valueType)
  );
}

function coerceSAMLAttributeValueType(valueType?: string): SAMLAttributeValueType | undefined {
  const normalized = valueType?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'saml:persistent-nameid') {
    return 'saml:persistent-nameid';
  }
  if (normalized === 'xs:boolean') {
    return 'xs:boolean';
  }
  if (normalized === 'xs:integer') {
    return 'xs:integer';
  }
  if (normalized === 'xs:datetime') {
    return 'xs:dateTime';
  }
  if (normalized === 'xs:anyuri') {
    return 'xs:anyURI';
  }
  if (normalized === 'xs:string') {
    return 'xs:string';
  }
  return undefined;
}

function mergeSAMLAttributes(attributes: SAMLAttribute[]): SAMLAttribute[] {
  const merged = new Map<string, SAMLAttribute>();

  for (const attribute of attributes) {
    const key = samlAttributeKey(attribute);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...attribute, values: dedupeAttributeValues(attribute.values) });
      continue;
    }
    existing.values = dedupeAttributeValues([...existing.values, ...attribute.values]);
  }

  return Array.from(merged.values());
}

function samlAttributeKey(attribute: SAMLAttribute): string {
  return [
    attribute.name,
    attribute.nameFormat ?? '',
    attribute.friendlyName ?? '',
    attribute.valueType ?? '',
  ].join('\u0000');
}

function dedupeAttributeValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

function findMissingRequiredMappedAttributes(
  attributes: SAMLAttribute[],
  config: SAMLIdentityMappingFieldMappingBinding,
  destinationNamespace: string
): MissingRequiredSAMLAttribute[] {
  const emittedNames = new Set(attributes.map((attribute) => attribute.name));
  return dedupeMissingAttributes(
    Object.entries(config.destinationFieldPolicies ?? {}).flatMap(([name, mode]) => {
      if (mode !== 'required' || emittedNames.has(name)) return [];
      const entry = config.catalog.entries.find(
        (candidate) => candidate.namespace === destinationNamespace && candidate.path === name
      );
      const descriptor = entry
        ? findMappedAttributeDescriptor(
            {
              side: 'destination',
              namespace: entry.namespace,
              path: entry.path,
              catalogEntryId: entry.id,
            },
            config
          )
        : undefined;
      return [
        {
          name,
          friendlyName: descriptor?.friendlyName,
          source: 'identity_mapping' as const,
          claim: entry?.path ?? name,
        },
      ];
    })
  );
}

function applyDestinationFieldReleasePolicy(
  attributes: SAMLAttribute[],
  policies?: Record<string, 'required' | 'optional' | 'hidden'>
): SAMLAttribute[] {
  if (!policies) return attributes;
  return attributes.filter((attribute) => policies[attribute.name] !== 'hidden');
}

function findMappedAttributeDescriptor(
  fieldRef: FieldRef,
  config: SAMLIdentityMappingFieldMappingBinding
): SAMLIdentityMappingAttributeDescriptor | undefined {
  const descriptors = config.attributeDescriptors ?? {};
  // Own keys only: a field may be named constructor or toString, and must not find Object's.
  const own = (key: string) => (Object.hasOwn(descriptors, key) ? descriptors[key] : undefined);
  return (
    (fieldRef.catalogEntryId ? own(fieldRef.catalogEntryId) : undefined) ??
    own(fieldRef.path) ??
    own(`${fieldRef.namespace}:${fieldRef.path}`)
  );
}

function dedupeMissingAttributes(
  missingAttributes: MissingRequiredSAMLAttribute[]
): MissingRequiredSAMLAttribute[] {
  const seen = new Set<string>();
  const deduped: MissingRequiredSAMLAttribute[] = [];
  for (const attribute of missingAttributes) {
    const key = `${attribute.name}:${attribute.friendlyName ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(attribute);
  }
  return deduped;
}

function readMappingSourceValue(subject: SAMLAttributeSubject, fieldRef: FieldRef): unknown {
  return readSubjectValue(subject, mappingSourceSubjectPath(fieldRef));
}

function fieldRefKey(fieldRef: FieldRef): string {
  return fieldRef.catalogEntryId
    ? `id:${fieldRef.catalogEntryId}`
    : `${fieldRef.side}:${fieldRef.namespace}:${fieldRef.path}`;
}

/**
 * A value of the subject at a key path. The path is normalized first (normalizeSubjectReadPath,
 * shared with the release safety check): this is the only place a path is read, so what is
 * classified and what is read are the same place.
 */
function readSubjectValue(subject: SAMLAttributeSubject, sourceClaim: string): unknown {
  const path = normalizeSubjectReadPath(sourceClaim).split('.');

  if (path.length === 1) {
    return Object.hasOwn(subject, path[0])
      ? subject[path[0] as keyof SAMLAttributeSubject]
      : undefined;
  }

  const [root, ...rest] = path;
  const rootValue = readRootValue(subject, root);
  if (!isRecord(rootValue)) {
    return undefined;
  }

  return readNestedValue(rootValue, rest);
}

function readRootValue(subject: SAMLAttributeSubject, root: string): unknown {
  switch (root) {
    case 'claims':
      return subject.claims;
    case 'attributes':
      return subject.attributes;
    case 'customClaims':
      return subject.customClaims;
    case 'customFields':
      return subject.customFields;
    default:
      return Object.hasOwn(subject, root) ? subject[root as keyof SAMLAttributeSubject] : undefined;
  }
}

function readNestedValue(record: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = record;

  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = Object.hasOwn(current, segment) ? current[segment] : undefined;
  }

  return current;
}

function normalizeAttributeValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeAttributeValues(item));
  }

  if (isAttributeValue(value)) {
    const stringValue = String(value);
    return stringValue.length > 0 ? [stringValue] : [];
  }

  return [];
}

function isAttributeValue(value: unknown): value is AttributeValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
