import { findCatalogEntry } from './catalog';
import { createDeterministicId } from './ids';
import { reason } from './reason-registry';
import { statusFromReasons } from './result';
import { buildTraceEntry } from './trace';
import { executeTransformStep } from './transforms';
import { validateMappingInput } from './validation';
import type {
  BatchDryRunResult,
  BatchMappingInput,
  DryRunResult,
  MappingInput,
  MappingRuleEdge,
  ReasonCode,
  RuleTraceEntry,
  RedactedValueSummary,
  SourceValueEnvelope,
} from './types';

export function dryRunMapping(input: MappingInput): DryRunResult {
  const validation = validateMappingInput(input);
  const edgeValues = new Map<string, SourceValueEnvelope>();
  const mappedValues: SourceValueEnvelope[] = [];
  const transformReasons: ReasonCode[] = [];
  const transformTrace: RuleTraceEntry[] = [];
  const mappingTrace: RuleTraceEntry[] = [];

  for (const edge of input.edges) {
    const sourceValue = findSourceValue(input.sourceValues, edge);
    if (!sourceValue) {
      continue;
    }
    const targetValue: SourceValueEnvelope = {
      ...sourceValue,
      sourceRef: edge.targetRef,
    };
    edgeValues.set(edge.id, targetValue);
    mappedValues.push(targetValue);
    mappingTrace.push(
      buildTraceEntry({
        reason: reason('trace.mapping_evaluated'),
        action: 'mapped',
        fieldRef: edge.targetRef,
        edgeId: edge.id,
      })
    );
  }

  for (const step of input.transforms ?? []) {
    const result = executeTransformStep({ step, edgeValues, runtimeContext: input.runtimeContext });
    transformReasons.push(...result.reasons);
    transformTrace.push(...result.trace);
    if (result.value) {
      mappedValues.push(result.value);
    }
  }

  const reasons = [...validation.reasons, ...transformReasons];
  const redactedValueSummaries = [...input.sourceValues, ...mappedValues].map((value) =>
    toRedactedValueSummary(input, value)
  );
  const rejectedCount = reasons.filter(
    (item) => item.severity === 'error' || item.severity === 'critical'
  ).length;

  return {
    status: statusFromReasons(reasons),
    summary: {
      inputCount: input.sourceValues.length,
      mappedCount: mappedValues.length,
      omittedCount: 0,
      rejectedCount,
      warningCount: reasons.filter((item) => item.severity === 'warning').length,
      errorCount: reasons.filter((item) => item.severity === 'error').length,
      criticalCount: reasons.filter((item) => item.severity === 'critical').length,
    },
    reasons,
    ruleTrace: [...validation.trace, ...mappingTrace, ...transformTrace],
    redactedValueSummaries,
  };
}

export function dryRunMappingBatch(input: BatchMappingInput): BatchDryRunResult {
  const rowResults = input.rows.map((row) => dryRunMapping(row));
  const reasonCounts = new Map<string, number>();

  for (const result of rowResults) {
    for (const item of result.reasons) {
      reasonCounts.set(item.code, (reasonCounts.get(item.code) ?? 0) + 1);
    }
  }

  const criticalCount = rowResults.reduce((sum, result) => sum + result.summary.criticalCount, 0);
  const failedRows = rowResults.filter((result) => result.status === 'failed').length;
  const partialRows = rowResults.filter((result) => result.status === 'partial').length;
  const successRows = rowResults.filter((result) => result.status === 'success').length;

  return {
    status:
      criticalCount > 0 ? 'failed' : partialRows > 0 || failedRows > 0 ? 'partial' : 'success',
    summary: {
      totalRows: rowResults.length,
      successRows,
      partialRows,
      failedRows,
      criticalCount,
    },
    rowResults,
    reasonCounts: Array.from(reasonCounts.entries()).map(([code, count]) => ({
      code: code as BatchDryRunResult['reasonCounts'][number]['code'],
      count,
    })),
    criticalCount,
  };
}

function findSourceValue(
  sourceValues: SourceValueEnvelope[],
  edge: MappingRuleEdge
): SourceValueEnvelope | undefined {
  return sourceValues.find((value) => {
    if (value.sourceRef.catalogEntryId && edge.sourceRef.catalogEntryId) {
      return value.sourceRef.catalogEntryId === edge.sourceRef.catalogEntryId;
    }
    return (
      value.sourceRef.side === edge.sourceRef.side &&
      value.sourceRef.namespace === edge.sourceRef.namespace &&
      value.sourceRef.path === edge.sourceRef.path
    );
  });
}

function toRedactedValueSummary(
  input: MappingInput,
  value: SourceValueEnvelope
): RedactedValueSummary {
  const entry = findCatalogEntry(input.catalog, value.sourceRef);
  const classification = value.classificationHint ?? entry?.classification ?? 'internal';
  return {
    label: createDeterministicId({
      kind: 'fixture',
      semanticPath: [value.sourceRef.namespace, value.sourceRef.path],
      contentHashParts: [value.sourceRef.namespace, value.sourceRef.path, classification],
    }),
    classification,
    valueType: entry?.valueType ?? typeof value.value,
    cardinality: Array.isArray(value.value) ? 'multi' : 'single',
    presence:
      value.value === undefined || value.value === null
        ? 'missing'
        : value.value === ''
          ? 'empty'
          : 'present',
    fingerprint: input.fingerprintProvider?.fingerprint({ value: value.value, classification }),
  };
}
