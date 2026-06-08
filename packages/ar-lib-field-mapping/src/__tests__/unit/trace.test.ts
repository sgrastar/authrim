import { describe, expect, it } from 'vitest';
import { reason } from '../../core/reason-registry';
import { buildTraceEntry } from '../../core/trace';

describe('trace builder', () => {
  it('drops unsafe metadata and emits a trace reason', () => {
    const trace = buildTraceEntry({
      reason: reason('trace.mapping_evaluated'),
      metadata: {
        rowIndex: 1,
        rawValue: 'secret@example.test',
      } as Record<string, unknown>,
    });

    expect(trace.metadata).toEqual({ rowIndex: 1 });
    expect(trace.reason.code).toBe('trace.unsafe_metadata');
    expect(JSON.stringify(trace)).not.toContain('secret@example.test');
  });
});
