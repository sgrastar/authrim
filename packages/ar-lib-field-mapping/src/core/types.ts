export type ReasonSeverity = 'info' | 'warning' | 'error' | 'critical';

export type MappingDecisionAction =
  | 'mapped'
  | 'omitted'
  | 'rejected'
  | 'warning'
  | 'pending'
  | 'review_required'
  | 'denied'
  | 'redacted'
  | 'transformed';

export type TransformOperation =
  | 'keep_part'
  | 'remove_text'
  | 'replace_text'
  | 'regex_replace'
  | 'to_halfwidth'
  | 'to_fullwidth'
  | 'strip_accents'
  | 'ascii_digits'
  | 'value_map'
  | 'text_to_number'
  | 'date_format'
  | 'filter_values'
  | 'normalize_empty'
  | 'default_if_empty'
  | 'has_value'
  | 'json_extract_array'
  | 'json_extract_or'
  | 'array_build'
  | 'conditional'
  | 'constant_text'
  | 'constant_boolean'
  | 'constant_number'
  | 'hash'
  | 'copy'
  | 'as_array'
  | 'split'
  | 'join'
  | 'first'
  | 'persistent_identifier'
  | 'affix_text'
  | 'concat'
  | 'fallback'
  | 'normalize'
  | 'case'
  | 'trim'
  | 'text_to_boolean'
  | 'json_build'
  | 'json_extract_text'
  | 'json_extract_boolean'
  | 'json_extract_integer';
export type ValidationRuleKind = 'required' | 'type' | 'enum' | 'format' | 'cardinality';
export type FormatKind = 'email' | 'uri' | 'date' | 'datetime' | 'phone' | 'locale';

export type RedactionClassification =
  | 'public'
  | 'internal'
  | 'pii'
  | 'secret'
  | 'regulated'
  | 'credential'
  | 'token'
  | 'key_material';

export type PolicyScopeKind = 'platform' | 'tenant' | 'source' | 'destination' | 'job';
export type MappingResultStatus = 'success' | 'partial' | 'failed';
export type TransformParameterSchemaKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'field-ref'
  | 'string-array';
export type StableIdKind = 'rule' | 'edge' | 'trace' | 'transform' | 'validation' | 'fixture';

export type ReasonCategory =
  | 'adapter'
  | 'validation'
  | 'policy'
  | 'transform'
  | 'catalog'
  | 'trace'
  | 'fixture';

export type ReasonCodeName =
  | `adapter.${string}`
  | `validation.${string}`
  | `policy.${string}`
  | `transform.${string}`
  | `catalog.${string}`
  | `trace.${string}`
  | `fixture.${string}`;

export type SafeMetadataValue = string | number | boolean | string[];
export type RedactionSafeIdPart = string | number | boolean;

export type SafeMetadataKey =
  | 'sourceType'
  | 'sourceId'
  | 'fieldPath'
  | 'rowIndex'
  | 'columnName'
  | 'recordIndex'
  | 'catalogEntryId'
  | 'ruleId'
  | 'edgeId'
  | 'scimPath'
  | 'samlAttributeName'
  | 'samlNameFormat'
  | 'oidcClaimName'
  | 'csvHeaderName';

export interface CatalogBundleIdentity {
  id: string;
  version: string;
  contentHash: string;
  compatibilityRange: string;
}

export interface ReasonCode {
  category: ReasonCategory;
  code: ReasonCodeName;
  severity: ReasonSeverity;
}

export interface ReasonRegistryEntry extends ReasonCode {
  description: string;
  stability: 'stable' | 'experimental';
}

export interface DeterministicIdInput {
  kind: StableIdKind;
  semanticPath: string[];
  contentHashParts?: RedactionSafeIdPart[];
}

export interface ProvenanceHint {
  sourceId?: string;
  sourceType?: string;
  observedAt?: string;
  trustHint?: string;
}

export interface SourceValueEnvelope {
  value: unknown;
  sourceRef: FieldRef;
  metadata?: Partial<Record<SafeMetadataKey, SafeMetadataValue>>;
  classificationHint?: RedactionClassification;
  provenanceHint?: ProvenanceHint;
  /** Every dependency, retained by graph transforms rather than only input zero. */
  provenanceHints?: ProvenanceHint[];
}

export interface FingerprintProvider {
  fingerprint(input: {
    value: unknown;
    classification: RedactionClassification;
    scope?: PolicyScopeRef;
  }): string | undefined;
}

export type FieldSide = 'source' | 'canonical' | 'derived' | 'destination' | 'review';

export interface FieldRef {
  side: FieldSide;
  namespace: string;
  path: string;
  catalogEntryId?: string;
  valueType?: string;
}

export type TargetType = 'canonical' | 'custom' | 'derived' | 'destination-only' | 'review-only';
export type Cardinality = 'single' | 'multi';

export interface FieldCatalogEntry {
  id: string;
  namespace: string;
  path: string;
  aliases?: Array<{ namespace: string; path: string }>;
  targetType?: TargetType;
  valueType: string;
  cardinality: Cardinality;
  classification: RedactionClassification;
  uiGroupKey?: string;
  uiGroupLabel?: string;
  uiGroupOrder?: number;
  uiFieldOrder?: number;
  examples?: unknown[];
  note?: string;
  allowedValues?: string[];
  valueMultiplicity?: 'single' | 'multi';
  nullable?: boolean;
  required?: boolean;
}

export interface FieldCatalogBundle {
  identity: CatalogBundleIdentity;
  entries: FieldCatalogEntry[];
}

export interface MappingRuleEdge {
  ruleId?: string;
  id: string;
  sourceRef: FieldRef;
  targetRef: FieldRef;
}

export interface MappingTransformStep {
  ruleId?: string;
  id: string;
  inputEdgeIds: string[];
  inputNames?: (string | undefined)[];
  operation: TransformOperation;
  parameters?: Record<string, unknown>;
  outputTargetRef: FieldRef;
}

/** Rule-local indexes; names reserve named inputs for conditional operations. */
export type MappingValueReference =
  | { edgeIndex: number; name?: string }
  | { stepIndex: number; name?: string };

export interface MappingGraphTransform {
  id: string;
  operation: TransformOperation;
  parameters?: Record<string, unknown>;
  inputs: MappingValueReference[];
}

/** Exactly one target is released, from the explicit output reference. */
export interface MappingRuleGraph {
  id: string;
  targetRef: FieldRef;
  edges: MappingRuleEdge[];
  transforms: MappingGraphTransform[];
  output: MappingValueReference;
  /** Set by the caller from the recipient's subject type. */
  pairwiseSubject?: boolean;
  /** Runtime-only row order and input naming, loaded from persisted graphs. */
  writerOrder?: number;
  edgeValueReferences?: 'source' | 'target';
}

export type MappingEvaluationValue =
  | { kind: 'value'; envelope: SourceValueEnvelope }
  /** Trusted consent preparation: unknown until approved, never an operation input value. */
  | { kind: 'deferred' }
  | { kind: 'absent' }
  | { kind: 'failed' }
  | { kind: 'suppressed' };

export interface TransformParameterSchema {
  name: string;
  kind: TransformParameterSchemaKind;
  required: boolean;
  allowedValues?: string[];
}

export interface TransformOperationSchema {
  operation: TransformOperation;
  parameters: TransformParameterSchema[];
  inputArity: { min: number; max?: number };
  outputValueType?: string;
  outputCardinality?: Cardinality;
}

export interface ValidationRule {
  id: string;
  kind: ValidationRuleKind;
  targetRef: FieldRef;
  defaultSeverity?: ReasonSeverity;
  parameters?: Record<string, unknown>;
}

export interface PolicyScopeRef {
  kind: PolicyScopeKind;
  id: string;
}

export interface FieldMappingRule {
  id: string;
  scope: PolicyScopeRef;
  action: 'allow' | 'deny' | 'lock';
  priority?: number;
  specificity?: number;
  targetRef?: FieldRef;
}

export interface FieldMappingSet {
  id: string;
  rules: FieldMappingRule[];
}

export interface PolicyMergeTraceEntry {
  ruleId: string;
  scope: PolicyScopeRef;
  selected: boolean;
  reason: ReasonCode;
}

export interface DiscardedRuleSummary {
  ruleId: string;
  reason: ReasonCode;
}

export interface EffectiveFieldMappingSetInput {
  sets: FieldMappingSet[];
}

export interface EffectiveFieldMappingSetResult {
  mergedSet: FieldMappingSet;
  mergeTrace: PolicyMergeTraceEntry[];
  discardedRuleSummary: DiscardedRuleSummary[];
}

export interface RedactedValueSummary {
  label: string;
  classification: RedactionClassification;
  valueType: string;
  cardinality: Cardinality;
  presence: 'present' | 'missing' | 'empty' | 'unknown';
  fingerprint?: string;
}

export interface TraceBuilderInput {
  reason: ReasonCode;
  action?: MappingDecisionAction;
  fieldRef?: FieldRef;
  ruleId?: string;
  edgeId?: string;
  transformStepId?: string;
  validationRuleId?: string;
  redactedValueSummary?: RedactedValueSummary;
  metadata?: Partial<Record<SafeMetadataKey, SafeMetadataValue>>;
}

export interface RuleTraceEntry extends TraceBuilderInput {
  id: string;
}

export interface TransformExecutionInput {
  /** Caller-owned per-rule budget, shared by dependent steps; omitted for a single step. */
  workBudget?: { remaining: number };
  step: MappingTransformStep;
  edgeValues: Map<string, SourceValueEnvelope>;
  runtimeContext?: Record<string, unknown>;
}

export interface TransformExecutionResult {
  status: MappingResultStatus;
  value?: SourceValueEnvelope;
  reasons: ReasonCode[];
  trace: RuleTraceEntry[];
}

export interface DryRunSummary {
  inputCount: number;
  mappedCount: number;
  omittedCount: number;
  rejectedCount: number;
  warningCount: number;
  errorCount: number;
  criticalCount: number;
}

export interface DryRunResult {
  status: MappingResultStatus;
  summary: DryRunSummary;
  reasons: ReasonCode[];
  ruleTrace: RuleTraceEntry[];
  redactedValueSummaries: RedactedValueSummary[];
}

export interface BatchDryRunSummary {
  totalRows: number;
  successRows: number;
  partialRows: number;
  failedRows: number;
  criticalCount: number;
}

export interface BatchDryRunResult {
  status: MappingResultStatus;
  summary: BatchDryRunSummary;
  rowResults: DryRunResult[];
  reasonCounts: Array<{ code: ReasonCodeName; count: number }>;
  criticalCount: number;
}

export interface MappingInput {
  /** Explicit persisted or authored rule graphs. */
  graphRules?: MappingRuleGraph[];
  /** Receivers with runtime-defined sources validate their source catalog before release. */
  sourceCatalogValidation?: 'catalog' | 'receiver';
  preparedSteps?: ReadonlyMap<string, MappingEvaluationValue>;
  /** Consent-only receiver opt-in. Deferred targets have no values and await final validation. */
  allowDeferredOutputs?: boolean;
  catalog: FieldCatalogBundle;
  sourceValues: SourceValueEnvelope[];
  edges: MappingRuleEdge[];
  transforms?: MappingTransformStep[];
  validationRules?: ValidationRule[];
  fieldMappingSet?: FieldMappingSet;
  fingerprintProvider?: FingerprintProvider;
  runtimeContext?: Record<string, unknown>;
  /** Receiver-specific aggregation for final-value validation; defaults to the last writer. */
  resolveValidationValues?: (values: SourceValueEnvelope[]) => SourceValueEnvelope[];
}

export interface BatchMappingInput {
  rows: MappingInput[];
}

export interface ValidationResult {
  status: MappingResultStatus;
  reasons: ReasonCode[];
  trace: RuleTraceEntry[];
}

export interface AdapterResult<TInput> {
  status: MappingResultStatus;
  input?: TInput;
  reasons: ReasonCode[];
  trace?: RuleTraceEntry[];
}
