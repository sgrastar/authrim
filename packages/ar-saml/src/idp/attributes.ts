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

  constructor(missingAttributes: MissingRequiredSAMLAttribute[]) {
    super(
      `Missing required SAML attribute value: ${missingAttributes.map((attr) => attr.name).join(', ')}`
    );
    this.name = 'MissingRequiredSAMLAttributeError';
    this.missingAttributes = missingAttributes;
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
    return buildSAMLAttributesFromIdentityMapping(subject, spConfig.identityMapping, {
      role: 'idp',
      tenantId: spConfig.tenantId,
      localEntityId: spConfig.localEntityId,
      partnerEntityId: spConfig.entityId,
      runtimeContext: spConfig.identityMapping.runtimeContext,
    });
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
  context: SAMLIdentityMappingRuntimeContext
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

  const attributes = applyDestinationFieldReleasePolicy(
    mergeSAMLAttributes(
      result.values
        .filter((value) => value.sourceRef.namespace === destinationNamespace)
        .map((value) => buildAttributeFromMappedValue(value, binding))
        .filter((attribute): attribute is SAMLAttribute => attribute !== null)
    ),
    binding.destinationFieldPolicies
  );
  const missingAttributes = findMissingRequiredMappedAttributes(
    attributes,
    binding,
    destinationNamespace
  );

  if (missingAttributes.length > 0) {
    throw new MissingRequiredSAMLAttributeError(missingAttributes);
  }

  return {
    attributes,
    optionalMissingAttributes: [],
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
  const needs: SAMLAssuranceSourceNeeds = { ial: false, eduPersonAssurance: false };
  if (!config || !hasSAMLIdentityMappingRuntimeConfig(config)) return needs;
  let binding: SAMLIdentityMappingFieldMappingBinding;
  try {
    binding = resolveSAMLIdentityMappingFieldMappingBinding(config, context);
  } catch {
    return needs;
  }
  for (const edge of binding.edges) {
    const sourcePath = mappingSourceSubjectPath(edge.sourceRef);
    const key =
      sourcePath === SAML_ASSURANCE_SUBJECT_KEYS.ial
        ? 'ial'
        : sourcePath === SAML_ASSURANCE_SUBJECT_KEYS.eduPersonAssurance
          ? 'eduPersonAssurance'
          : null;
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

function buildAttributeFromRule(
  subject: SAMLAttributeSubject,
  rule: SAMLAttributeReleaseRule
): SAMLAttribute | null {
  const values = normalizeAttributeValues(readRuleValue(subject, rule));
  if (values.length === 0) {
    return null;
  }

  return {
    name: rule.name,
    nameFormat: rule.nameFormat,
    friendlyName: rule.friendlyName,
    valueType: rule.valueType,
    values,
  };
}

function readRuleValue(subject: SAMLAttributeSubject, rule: SAMLAttributeReleaseRule): unknown {
  switch (rule.source) {
    case 'claim':
      return rule.claim ? readSubjectValue(subject, rule.claim) : undefined;
    case 'attribute':
      return rule.claim ? readSubjectValue(subject, `attributes.${rule.claim}`) : undefined;
    case 'custom_claim':
      return rule.claim ? readSubjectValue(subject, `customClaims.${rule.claim}`) : undefined;
    case 'custom_field':
      return rule.claim ? readSubjectValue(subject, `customFields.${rule.claim}`) : undefined;
    case 'constant':
      return rule.value;
    case 'computed':
      return readComputedRuleValue(subject, rule);
  }
}

function readComputedRuleValue(
  subject: SAMLAttributeSubject,
  rule: SAMLAttributeReleaseRule
): unknown {
  switch (rule.computed) {
    case 'eduPersonScopedAffiliation':
      return readEduPersonScopedAffiliation(subject, rule.claim);
    default:
      return undefined;
  }
}

function readEduPersonScopedAffiliation(
  subject: SAMLAttributeSubject,
  directClaim = 'eduPersonScopedAffiliation'
): unknown {
  const directValue =
    readSubjectValue(subject, `customClaims.${directClaim}`) ??
    readSubjectValue(subject, `claims.${directClaim}`) ??
    readSubjectValue(subject, directClaim);
  if (normalizeAttributeValues(directValue).length > 0) {
    return directValue;
  }

  const affiliations = normalizeAttributeValues(
    readSubjectValue(subject, 'customClaims.eduPersonAffiliation') ??
      readSubjectValue(subject, 'customClaims.affiliation') ??
      readSubjectValue(subject, 'claims.eduPersonAffiliation') ??
      readSubjectValue(subject, 'claims.affiliation')
  );
  const scopes = normalizeAttributeValues(
    readSubjectValue(subject, 'customClaims.eduPersonScope') ??
      readSubjectValue(subject, 'customClaims.institutionScope') ??
      readSubjectValue(subject, 'customClaims.scope') ??
      readSubjectValue(subject, 'claims.eduPersonScope') ??
      readSubjectValue(subject, 'claims.institutionScope') ??
      readSubjectValue(subject, 'claims.scope')
  );

  if (affiliations.length === 0 || scopes.length === 0) {
    return undefined;
  }

  return affiliations.flatMap((affiliation) => scopes.map((scope) => `${affiliation}@${scope}`));
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
