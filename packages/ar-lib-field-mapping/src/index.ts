export type {
  AdapterResult,
  BatchDryRunResult,
  BatchDryRunSummary,
  BatchMappingInput,
  Cardinality,
  CatalogBundleIdentity,
  DeterministicIdInput,
  DiscardedRuleSummary,
  DryRunResult,
  DryRunSummary,
  EffectiveFieldMappingSetInput,
  EffectiveFieldMappingSetResult,
  FieldCatalogBundle,
  FieldCatalogEntry,
  FieldRef,
  FieldSide,
  FingerprintProvider,
  FormatKind,
  MappingDecisionAction,
  MappingInput,
  FieldMappingSet,
  FieldMappingRule,
  MappingResultStatus,
  MappingRuleEdge,
  MappingTransformStep,
  PolicyMergeTraceEntry,
  PolicyScopeKind,
  PolicyScopeRef,
  ProvenanceHint,
  ReasonCategory,
  ReasonCode,
  ReasonCodeName,
  ReasonRegistryEntry,
  ReasonSeverity,
  RedactedValueSummary,
  RedactionClassification,
  RedactionSafeIdPart,
  RuleTraceEntry,
  SafeMetadataKey,
  SafeMetadataValue,
  SourceValueEnvelope,
  StableIdKind,
  TargetType,
  TraceBuilderInput,
  TransformExecutionInput,
  TransformExecutionResult,
  TransformOperation,
  TransformOperationSchema,
  TransformParameterSchema,
  TransformParameterSchemaKind,
  ValidationResult,
  ValidationRule,
  ValidationRuleKind,
} from './core/types';

export { validateCatalogBundle, findCatalogEntry } from './core/catalog';
export { dryRunMapping, dryRunMappingBatch } from './core/dry-run';
export { executeRuntimeMapping } from './core/runtime';
export type { RuntimeMappingResult } from './core/runtime';
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
  TRANSFORM_OPERATION_SCHEMAS,
  executeTransformStep,
  validateTransformRegistry,
  validateTransformStep,
} from './core/transforms';
export { validateMappingInput } from './core/validation';
export type {
  CsvSourceProfileColumn,
  CsvSourceProfileParserOptions,
  CsvSourceProfileParseResult,
  CsvSourceProfileValueType,
  CsvSourceProfileWarning,
  CsvSourceProfileWarningCode,
} from './source-profiles/csv';
export { parseCsvSourceProfile } from './source-profiles/csv';
