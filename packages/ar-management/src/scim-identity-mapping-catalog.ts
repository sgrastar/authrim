import { TRANSFORM_OPERATION_SCHEMAS } from '@authrim/ar-lib-field-mapping/authoring';
import { findCatalogEntry } from '@authrim/ar-lib-field-mapping/runtime';
import type {
  FieldCatalogBundle,
  FieldCatalogEntry,
  MappingRuleGraph,
  MappingValueReference,
  SourceValueEnvelope,
} from '@authrim/ar-lib-field-mapping/contract';

type ValueShape = Pick<FieldCatalogEntry, 'valueType' | 'cardinality'>;
const unknownShape: ValueShape = { valueType: 'unknown', cardinality: 'single' };
const operationSchemas = new Map(
  TRANSFORM_OPERATION_SCHEMAS.map((schema) => [schema.operation, schema])
);

/** Array catalog types describe their elements; cardinality describes the array itself. */
export function scimValueShape(value: unknown): ValueShape {
  if (Array.isArray(value))
    return { ...mergeShapes(value.map(scimValueShape)), cardinality: 'multi' };
  const valueType =
    value === undefined || value === null
      ? 'unknown'
      : typeof value === 'boolean'
        ? 'boolean'
        : typeof value === 'number'
          ? 'number'
          : typeof value === 'object'
            ? 'json'
            : 'string';
  return { valueType, cardinality: 'single' };
}

function mergeShapes(shapes: ValueShape[]): ValueShape {
  return {
    valueType:
      shapes.length && shapes.every((shape) => shape.valueType === shapes[0].valueType)
        ? shapes[0].valueType
        : 'unknown',
    cardinality: shapes.some((shape) => shape.cardinality === 'multi') ? 'multi' : 'single',
  };
}

/** Follow the explicit output and earlier step inputs without evaluating transforms twice. */
export function scimRuleOutputShape(
  rule: MappingRuleGraph,
  catalog: FieldCatalogBundle,
  sourceValues: SourceValueEnvelope[]
): ValueShape {
  const edges = rule.edges.map((edge): ValueShape => {
    const source = findCatalogEntry(catalog, edge.sourceRef);
    const target = findCatalogEntry(catalog, edge.targetRef);
    const observed = scimValueShape(
      sourceValues.find(
        (value) =>
          value.sourceRef.namespace === edge.sourceRef.namespace &&
          value.sourceRef.path === edge.sourceRef.path
      )?.value
    );
    return {
      valueType:
        edge.sourceRef.valueType ??
        source?.valueType ??
        edge.targetRef.valueType ??
        target?.valueType ??
        observed.valueType,
      cardinality: source?.cardinality ?? target?.cardinality ?? observed.cardinality,
    };
  });
  const steps: ValueShape[] = [];
  const resolve = (reference: MappingValueReference): ValueShape =>
    ('edgeIndex' in reference ? edges[reference.edgeIndex] : steps[reference.stepIndex]) ??
    unknownShape;
  for (const step of rule.transforms) {
    const input = mergeShapes(step.inputs.map(resolve));
    const schema = operationSchemas.get(step.operation);
    steps.push({
      valueType: schema?.outputValueType ?? input.valueType,
      cardinality: schema?.outputCardinality ?? input.cardinality,
    });
  }
  return resolve(rule.output);
}
