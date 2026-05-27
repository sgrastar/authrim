import { findCatalogEntry } from './catalog';
import { createDeterministicId } from './ids';
import { reason } from './reason-registry';
import { statusFromReasons } from './result';
import { buildTraceEntry } from './trace';
import { validateMappingInput } from './validation';
import type {
  BatchDryRunResult,
  BatchMappingInput,
  DryRunResult,
  MappingInput,
  RedactedValueSummary,
} from './types';

export function dryRunMapping(input: MappingInput): DryRunResult {
  const validation = validateMappingInput(input);
  const redactedValueSummaries = input.sourceValues.map((value): RedactedValueSummary => {
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
  });

  return {
    status: statusFromReasons(validation.reasons),
    summary: {
      inputCount: input.sourceValues.length,
      mappedCount: Math.max(0, input.edges.length - validation.reasons.length),
      omittedCount: 0,
      rejectedCount: validation.reasons.filter((item) => item.severity === 'error').length,
      warningCount: validation.reasons.filter((item) => item.severity === 'warning').length,
      errorCount: validation.reasons.filter((item) => item.severity === 'error').length,
      criticalCount: validation.reasons.filter((item) => item.severity === 'critical').length,
    },
    reasons: validation.reasons,
    ruleTrace: [
      ...validation.trace,
      ...input.edges.map((edge) =>
        buildTraceEntry({
          reason: reason('trace.mapping_evaluated'),
          fieldRef: edge.targetRef,
          edgeId: edge.id,
        })
      ),
    ],
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
