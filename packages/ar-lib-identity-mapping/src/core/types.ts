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
  | 'copy'
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
}

export interface FingerprintProvider {
  fingerprint(input: {
    value: unknown;
    classification: RedactionClassification;
    scope?: PolicyScopeRef;
  }): string | undefined;
}

export type FieldSide = 'inbound' | 'canonical' | 'derived' | 'outbound' | 'review';

export interface FieldRef {
  side: FieldSide;
  namespace: string;
  path: string;
  catalogEntryId?: string;
}

export type TargetType = 'canonical' | 'custom' | 'derived' | 'outbound-only' | 'review-only';
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
}

export interface FieldCatalogBundle {
  identity: CatalogBundleIdentity;
  entries: FieldCatalogEntry[];
}

export interface MappingRuleEdge {
  id: string;
  sourceRef: FieldRef;
  targetRef: FieldRef;
}

export interface MappingTransformStep {
  id: string;
  inputEdgeIds: string[];
  operation: TransformOperation;
  parameters?: Record<string, unknown>;
  outputTargetRef: FieldRef;
}

export interface TransformParameterSchema {
  name: string;
  kind: TransformParameterSchemaKind;
  required: boolean;
  allowedValues?: string[];
}

export interface TransformOperationSchema {
  operation: TransformOperation;
  parameters: TransformParameterSchema[];
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

export interface MappingPolicyRule {
  id: string;
  scope: PolicyScopeRef;
  action: 'allow' | 'deny' | 'lock';
  priority?: number;
  specificity?: number;
  targetRef?: FieldRef;
}

export interface MappingPolicy {
  id: string;
  rules: MappingPolicyRule[];
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

export interface EffectivePolicyInput {
  policies: MappingPolicy[];
}

export interface EffectivePolicyResult {
  mergedPolicy: MappingPolicy;
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
  step: MappingTransformStep;
  edgeValues: Map<string, SourceValueEnvelope>;
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
  catalog: FieldCatalogBundle;
  sourceValues: SourceValueEnvelope[];
  edges: MappingRuleEdge[];
  transforms?: MappingTransformStep[];
  validationRules?: ValidationRule[];
  policy?: MappingPolicy;
  fingerprintProvider?: FingerprintProvider;
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
