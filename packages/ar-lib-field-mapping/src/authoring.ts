export { validateCatalogBundle } from './core/catalog';
export { dryRunMapping, dryRunMappingBatch } from './core/dry-run';
export { createDeterministicId, shortHash } from './core/ids';
export {
  filterSafeMetadata,
  findUnsafeMetadata,
  isSafeMetadataKey,
  isSafeMetadataValue,
  SAFE_METADATA_KEYS,
} from './core/metadata';
export { resolveEffectiveFieldMappingSet } from './core/field-mapping-set';
export {
  categoryFromCode,
  reason,
  REASON_REGISTRY,
  validateReasonRegistry,
} from './core/reason-registry';
export { buildTraceEntry } from './core/trace';
export {
  IDENTIFIER_SALT_NAME,
  TRANSFORM_OPERATION_SCHEMAS,
  executeTransformStep,
  persistentIdentifierSettingsProblem,
  sharesConsumedInput,
  validateTransformRegistry,
  validateTransformStep,
} from './core/transforms';
export { sameFieldRef, validateMappingInput } from './core/validation';
export type {
  CsvSourceProfileColumn,
  CsvSourceProfileParserOptions,
  CsvSourceProfileParseResult,
  CsvSourceProfileValueType,
  CsvSourceProfileWarning,
  CsvSourceProfileWarningCode,
} from './source-profiles/csv';
export { parseCsvSourceProfile } from './source-profiles/csv';

export { evaluateMappingRule } from './core/graph-evaluator';
export type { GraphEvaluationInput } from './core/graph-evaluator';
export {
  analyzeMappingDependencies,
  withMappingGraph,
  identifierGraphProblem,
  IDENTIFIER_POST_TRANSFORM_OPERATIONS,
} from './core/graph';

export { validateMappingRuleGraph } from './core/graph-validation';
export { readMappingReference } from './core/stored-graph';

export { TRANSFORM_LIMITS, safeTransformPattern, safeRegexTest } from './core/transform-safety';
export { asciiDigits, stripAccents } from './core/text-fold';
export { toFullwidth, toHalfwidth } from './core/text-width';
