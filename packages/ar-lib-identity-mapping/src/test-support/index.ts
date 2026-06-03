import { createDeterministicId } from '../core/ids';
import type {
  FieldCatalogBundle,
  FieldRef,
  FingerprintProvider,
  MappingInput,
  MappingRuleEdge,
  RedactionClassification,
  SourceValueEnvelope,
} from '../core/types';

export type { StaticFixtureKind, StaticFixtureValidationResult } from './fixture-validation';
export { validateStaticFixture } from './fixture-validation';

export const TEST_CATALOG: FieldCatalogBundle = {
  identity: {
    id: 'authrim.pr1.test.catalog',
    version: '2026-05-27-pr1',
    contentHash: 'test-catalog-001',
    compatibilityRange: '^0.2.0',
  },
  entries: [
    {
      id: 'field.csv.email',
      namespace: 'csv',
      path: 'email',
      valueType: 'string',
      cardinality: 'single',
      classification: 'pii',
      targetType: 'canonical',
    },
    {
      id: 'field.canonical.email',
      namespace: 'authrim.profile',
      path: 'email',
      valueType: 'string',
      cardinality: 'single',
      classification: 'pii',
      targetType: 'canonical',
    },
    {
      id: 'field.csv.employee_number',
      namespace: 'csv',
      path: 'employeeNumber',
      valueType: 'string',
      cardinality: 'single',
      classification: 'regulated',
      targetType: 'canonical',
    },
    {
      id: 'field.scim.user_name',
      namespace: 'scim.user',
      path: 'userName',
      valueType: 'string',
      cardinality: 'single',
      classification: 'pii',
      targetType: 'canonical',
    },
    {
      id: 'field.saml.mail',
      namespace: 'saml.attribute',
      path: 'mail',
      valueType: 'string',
      cardinality: 'single',
      classification: 'pii',
      targetType: 'outbound-only',
    },
    {
      id: 'field.oidc.email',
      namespace: 'oidc.claim',
      path: 'email',
      valueType: 'string',
      cardinality: 'single',
      classification: 'pii',
      targetType: 'outbound-only',
    },
  ],
};

export function fieldRef(namespace: string, path: string, catalogEntryId?: string): FieldRef {
  return { side: 'inbound', namespace, path, catalogEntryId };
}

export function sourceValue(
  namespace: string,
  path: string,
  value: unknown,
  classificationHint?: RedactionClassification
): SourceValueEnvelope {
  return {
    value,
    sourceRef: fieldRef(namespace, path),
    metadata: { sourceType: namespace, fieldPath: path },
    classificationHint,
  };
}

export function edge(sourceRef: FieldRef, targetRef: FieldRef): MappingRuleEdge {
  return {
    id: createDeterministicId({
      kind: 'edge',
      semanticPath: [sourceRef.namespace, sourceRef.path, targetRef.namespace, targetRef.path],
      contentHashParts: [sourceRef.namespace, sourceRef.path, targetRef.namespace, targetRef.path],
    }),
    sourceRef,
    targetRef,
  };
}

export function mappingInput(values: SourceValueEnvelope[]): MappingInput {
  const emailSource = fieldRef('csv', 'email', 'field.csv.email');
  const emailTarget: FieldRef = {
    side: 'canonical',
    namespace: 'authrim.profile',
    path: 'email',
    catalogEntryId: 'field.canonical.email',
  };

  return {
    catalog: TEST_CATALOG,
    sourceValues: values,
    edges: [edge(emailSource, emailTarget)],
  };
}

export function createTestFingerprintProvider(): FingerprintProvider {
  return {
    fingerprint(input) {
      return createDeterministicId({
        kind: 'fixture',
        semanticPath: ['fingerprint', input.classification],
        contentHashParts: [input.classification, typeof input.value],
      });
    },
  };
}
