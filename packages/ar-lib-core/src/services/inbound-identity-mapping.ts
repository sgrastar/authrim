/** Incoming OP/IdP attributes are account input, never an outgoing release profile. */
import {
  TRANSFORM_OPERATION_SCHEMAS,
  validateMappingRuleGraph,
} from '@authrim/ar-lib-field-mapping/authoring';
import { lastWriterMappingValues } from '@authrim/ar-lib-field-mapping/runtime';
import type {
  FieldCatalogBundle,
  FieldCatalogEntry,
  FieldRef,
  MappingRuleGraph,
  MappingValueReference,
  SourceValueEnvelope,
} from '@authrim/ar-lib-field-mapping/contract';
import { executeTenantMapping, type MappingHashEnvironment } from './mapping-hash';
import type { RuntimeIdentityMappingBinding } from './identity-mapping-runtime-resolver';
import { sensitiveClassificationRank } from './identity-mapping-source-reads';

export type InboundMappingProtocol = 'oidc' | 'saml';
export const INBOUND_PROFILE_FIELDS: readonly string[] = [
  'email',
  'name',
  'given_name',
  'family_name',
  'middle_name',
  'nickname',
  'profile',
  'picture',
  'website',
  'gender',
  'birthdate',
  'zoneinfo',
  'locale',
];
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
export const inboundFieldKeySafe = (path: string): boolean =>
  path.length > 0 &&
  path.length <= 512 &&
  !path.split(/[.[\]]/u).some((key) => unsafeKeys.has(key));

export function inboundProfileTargets(custom: FieldCatalogEntry[] = []): FieldCatalogEntry[] {
  return [
    ...INBOUND_PROFILE_FIELDS.map(
      (path): FieldCatalogEntry => ({
        id: `inbound.target.profile.${path}`,
        namespace: 'authrim.profile',
        path,
        valueType: 'string',
        cardinality: 'single',
        classification: 'pii',
        targetType: 'canonical',
      })
    ),
    ...custom
      .filter(
        (entry) =>
          entry.valueType === 'string' &&
          entry.cardinality === 'single' &&
          inboundFieldKeySafe(entry.path) &&
          !INBOUND_PROFILE_FIELDS.includes(entry.path) &&
          ![
            'id',
            'sub',
            'email_verified',
            'user_id',
            'tenant_id',
            'account_id',
            'subject_id',
            'lifecycle_state',
            'is_active',
            'created_at',
            'updated_at',
            'identity_provider_id',
            'provider_user_id',
            'roles',
            'permissions',
          ].includes(entry.path)
      )
      .map(
        (entry): FieldCatalogEntry => ({
          ...entry,
          id: `inbound.target.custom.${entry.path}`,
          namespace: 'authrim.custom_claims',
          targetType: 'custom',
          aliases: undefined,
        })
      ),
  ];
}

export function inboundSourceField(
  protocol: InboundMappingProtocol,
  namespace: string,
  path: string,
  multi = false
): FieldCatalogEntry {
  if (
    !inboundFieldKeySafe(path) ||
    (protocol === 'oidc'
      ? namespace !== 'oidc.userinfo'
      : namespace !== 'saml.attribute' &&
        !(namespace === 'saml.subject' && ['nameId', 'nameIdFormat'].includes(path)))
  )
    throw new Error('inbound_mapping_source_invalid');
  if (multi && (namespace === 'saml.subject' || (protocol === 'oidc' && path === 'email_verified')))
    throw new Error('inbound_mapping_source_invalid');
  return {
    id: `inbound.source.${namespace}:${path}`,
    namespace,
    path,
    valueType: protocol === 'oidc' && path === 'email_verified' ? 'boolean' : 'string',
    cardinality: multi ? 'multi' : 'single',
    classification: 'pii',
    targetType: 'canonical',
  };
}

export function defaultInboundSources(protocol: InboundMappingProtocol): FieldCatalogEntry[] {
  return protocol === 'oidc'
    ? ['sub', 'email_verified', 'preferred_username', ...INBOUND_PROFILE_FIELDS].map((path) =>
        inboundSourceField(protocol, 'oidc.userinfo', path)
      )
    : [
        inboundSourceField(protocol, 'saml.subject', 'nameId'),
        inboundSourceField(protocol, 'saml.subject', 'nameIdFormat'),
        ...[
          'email',
          'mail',
          'name',
          'givenName',
          'sn',
          'displayName',
          'urn:oid:0.9.2342.19200300.100.1.3',
        ].map((path) => inboundSourceField(protocol, 'saml.attribute', path)),
      ];
}

function fieldAt(entries: FieldCatalogEntry[], ref: FieldRef): FieldCatalogEntry {
  const entry = entries.find((item) => item.namespace === ref.namespace && item.path === ref.path);
  if (
    !entry ||
    (ref.catalogEntryId !== undefined && ref.catalogEntryId !== entry.id) ||
    (ref.valueType !== undefined && ref.valueType !== entry.valueType) ||
    Object.keys(ref).some(
      (key) => !['side', 'namespace', 'path', 'valueType', 'catalogEntryId'].includes(key)
    )
  )
    throw new Error('inbound_mapping_reference_invalid');
  return entry;
}

type Shape = Pick<FieldCatalogEntry, 'valueType' | 'cardinality'>;
function outputShape(rule: MappingRuleGraph, catalog: FieldCatalogBundle): Shape {
  const edges = rule.edges.map((edge) => fieldAt(catalog.entries, edge.sourceRef));
  const steps: Shape[] = [];
  const read = (ref: MappingValueReference): Shape => {
    const shape = 'edgeIndex' in ref ? edges[ref.edgeIndex] : steps[ref.stepIndex];
    if (!shape) throw new Error('inbound_mapping_reference_invalid');
    return shape;
  };
  for (const step of rule.transforms) {
    const inputs = (
      step.operation === 'conditional'
        ? step.inputs.filter((ref) => ref.name === 'value')
        : step.inputs
    ).map(read);
    const first = inputs[0];
    const schema = TRANSFORM_OPERATION_SCHEMAS.find((item) => item.operation === step.operation);
    const conditionalType =
      step.operation === 'conditional'
        ? step.parameters?.valueType === 'as_boolean'
          ? 'boolean'
          : step.parameters?.valueType === 'as_number'
            ? 'number'
            : 'string'
        : undefined;
    steps.push({
      valueType:
        conditionalType ??
        (step.operation === 'text_to_number'
          ? 'number'
          : step.operation === 'date_format'
            ? ['unix_s', 'unix_ms'].includes(String(step.parameters?.to))
              ? 'number'
              : 'string'
            : undefined) ??
        schema?.outputValueType ??
        (inputs.every((input) => input.valueType === first?.valueType)
          ? (first?.valueType ?? 'unknown')
          : 'unknown'),
      cardinality:
        step.operation === 'conditional' && step.parameters?.elseMode !== 'as_is'
          ? 'single'
          : (schema?.outputCardinality ??
            (inputs.some((input) => input.cardinality === 'multi') ? 'multi' : 'single')),
    });
  }
  return read(rule.output);
}

/** Checked on save and again at the receiver, including disconnected edges/steps. */
export function assertInboundMappingGraph(
  protocol: InboundMappingProtocol,
  rules: MappingRuleGraph[],
  catalog: FieldCatalogBundle,
  targets: FieldCatalogEntry[]
): void {
  if (
    !rules.length ||
    rules.length > 100 ||
    new Set(rules.map((rule) => rule.id)).size !== rules.length
  )
    throw new Error('inbound_mapping_rules_invalid');
  const writers = new Set<string>();
  for (const rule of rules) {
    if (
      validateMappingRuleGraph(rule).length ||
      rule.transforms.some((step) => step.operation === 'persistent_identifier')
    )
      throw new Error('inbound_mapping_operation_invalid');
    if (rule.targetRef.side !== 'destination') throw new Error('inbound_mapping_target_invalid');
    const target = fieldAt(targets, rule.targetRef);
    const key = `${target.namespace}:${target.path}`;
    if (writers.has(key)) throw new Error('inbound_mapping_duplicate_target');
    writers.add(key);
    for (const edge of rule.edges) {
      if (
        edge.sourceRef.side !== 'source' ||
        edge.targetRef.side !== 'destination' ||
        edge.targetRef.namespace !== target.namespace ||
        edge.targetRef.path !== target.path
      )
        throw new Error('inbound_mapping_reference_invalid');
      fieldAt(targets, edge.targetRef);
      const source = fieldAt(catalog.entries, edge.sourceRef);
      const expected = inboundSourceField(
        protocol,
        source.namespace,
        source.path,
        source.cardinality === 'multi'
      );
      if (
        source.valueType !== expected.valueType ||
        source.classification !== expected.classification ||
        sensitiveClassificationRank(source.classification) >
          sensitiveClassificationRank(target.classification)
      )
        throw new Error('inbound_mapping_schema_invalid');
    }
    const shape = outputShape(rule, catalog);
    if (shape.valueType !== target.valueType || shape.cardinality !== target.cardinality)
      throw new Error('inbound_mapping_output_type_invalid');
  }
}

/** ACS represents an Attribute with one value as a scalar, including in synthetic samples. */
export function samlInboundAttributeValue(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

export function inboundScalar(value: unknown): string | undefined {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string'
    ? first
    : typeof first === 'number' || typeof first === 'boolean'
      ? String(first)
      : undefined;
}

export function projectInboundMapping(values: SourceValueEnvelope[]) {
  const profile: Record<string, string> = {};
  const customClaims: Record<string, string> = {};
  for (const envelope of values) {
    const value = inboundScalar(envelope.value);
    if (value === undefined) continue;
    const { namespace, path } = envelope.sourceRef;
    if (namespace === 'authrim.profile' && INBOUND_PROFILE_FIELDS.includes(path))
      profile[path] = value;
    else if (namespace === 'authrim.custom_claims' && inboundFieldKeySafe(path))
      customClaims[path] = value;
    else throw new Error('inbound_mapping_target_invalid');
  }
  return { profile, customClaims };
}

/** Synthetic preview and actual receivers use exactly this evaluator and scalar projection. */
export async function evaluateInboundMapping(input: {
  env: MappingHashEnvironment;
  tenantId: string;
  protocol: InboundMappingProtocol;
  binding: Pick<
    RuntimeIdentityMappingBinding,
    'catalog' | 'graphRules' | 'edges' | 'transforms' | 'validationRules' | 'fieldMappingSet'
  >;
  sources: SourceValueEnvelope[];
  targets: FieldCatalogEntry[];
}) {
  const { binding } = input;
  if (!binding.graphRules) throw new Error('inbound_mapping_graph_missing');
  assertInboundMappingGraph(input.protocol, binding.graphRules, binding.catalog, input.targets);
  const result = await executeTenantMapping(input.env, input.tenantId, {
    ...binding,
    sourceValues: input.sources.filter((envelope) =>
      binding.catalog.entries.some(
        (field) =>
          field.namespace === envelope.sourceRef.namespace && field.path === envelope.sourceRef.path
      )
    ),
    resolveValidationValues: (values) =>
      lastWriterMappingValues(
        values.flatMap((envelope) => {
          const value = inboundScalar(envelope.value);
          return value === undefined ? [] : [{ ...envelope, value }];
        })
      ),
    runtimeContext: {
      tenantId: input.tenantId,
      protocol: input.protocol,
      role: input.protocol === 'oidc' ? 'rp' : 'sp',
    },
  });
  if (
    result.status === 'failed' ||
    result.reasons.some((reason) => reason.severity === 'error' || reason.severity === 'critical')
  )
    throw new Error('inbound_mapping_evaluation_failed');
  if (
    result.values.some(
      (envelope) =>
        envelope.value !== null &&
        envelope.value !== undefined &&
        typeof envelope.value !== 'string'
    )
  )
    throw new Error('inbound_mapping_output_type_invalid');
  return projectInboundMapping(result.values);
}

export function oidcInboundSources(
  userInfo: Record<string, unknown>,
  fields: FieldCatalogEntry[]
): SourceValueEnvelope[] {
  return fields
    .filter((field) => field.namespace === 'oidc.userinfo')
    .flatMap((field) => {
      // A path names a claim verbatim. Nested structures require an explicit JSON transform.
      const value = Object.hasOwn(userInfo, field.path) ? userInfo[field.path] : undefined;
      return value === undefined
        ? []
        : [{ value, sourceRef: { side: 'source', namespace: field.namespace, path: field.path } }];
    });
}
