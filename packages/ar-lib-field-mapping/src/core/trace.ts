import { createDeterministicId } from './ids';
import { findUnsafeMetadata, filterSafeMetadata } from './metadata';
import { reason } from './reason-registry';
import type { RuleTraceEntry, TraceBuilderInput } from './types';

export function buildTraceEntry(input: TraceBuilderInput): RuleTraceEntry {
  const unsafeMetadataKeys = findUnsafeMetadata(input.metadata);
  const safeMetadata = filterSafeMetadata(input.metadata);
  const traceReason =
    unsafeMetadataKeys.length > 0 ? reason('trace.unsafe_metadata') : input.reason;

  return {
    ...input,
    id: createDeterministicId({
      kind: 'trace',
      semanticPath: [
        input.ruleId ?? input.edgeId ?? input.validationRuleId ?? input.reason.code,
        input.fieldRef?.namespace ?? 'none',
        input.fieldRef?.path ?? 'none',
      ],
      contentHashParts: [input.reason.code, traceReason.severity],
    }),
    reason: traceReason,
    metadata: safeMetadata,
  };
}
