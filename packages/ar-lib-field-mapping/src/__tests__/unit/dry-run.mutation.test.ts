import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dryRunMapping, dryRunMappingBatch } from '../../core/dry-run';
import { createDeterministicId } from '../../core/ids';
import { executeRuntimeMapping, type RuntimeMappingResult } from '../../core/runtime';
import { TEST_CATALOG } from '../../test-support';
import type {
  FieldRef,
  MappingInput,
  ReasonCode,
  RedactionClassification,
  SourceValueEnvelope,
} from '../../core/types';

vi.mock('../../core/runtime', () => ({ executeRuntimeMapping: vi.fn() }));

const runtime = vi.mocked(executeRuntimeMapping);

const info: ReasonCode = { category: 'policy', code: 'policy.rule_selected', severity: 'info' };
const warning: ReasonCode = {
  category: 'validation',
  code: 'validation.format_mismatch',
  severity: 'warning',
};
const error: ReasonCode = {
  category: 'validation',
  code: 'validation.type_mismatch',
  severity: 'error',
};
const critical: ReasonCode = {
  category: 'policy',
  code: 'policy.deny_locked',
  severity: 'critical',
};

function runtimeResult(
  reasons: ReasonCode[],
  values: SourceValueEnvelope[] = []
): RuntimeMappingResult {
  return { status: 'success', reasons, ruleTrace: [], values };
}

function envelope(
  namespace: string,
  path: string,
  value: unknown,
  classificationHint?: RedactionClassification
): SourceValueEnvelope {
  const sourceRef: FieldRef = { side: 'source', namespace, path };
  return { sourceRef, value, ...(classificationHint ? { classificationHint } : {}) };
}

function input(sourceValues: SourceValueEnvelope[] = []): MappingInput {
  return { catalog: TEST_CATALOG, sourceValues, edges: [] };
}

beforeEach(() => {
  runtime.mockReset();
});

describe('dryRunMapping summary', () => {
  it('counts every severity separately and rejects errors and criticals only', () => {
    const trace = [{ id: 't1', reason: info }];
    runtime.mockReturnValue({
      ...runtimeResult(
        [info, warning, warning, warning, error, error, critical, info],
        [envelope('out', 'a', 1), envelope('out', 'b', 2)]
      ),
      ruleTrace: trace,
    });

    const result = dryRunMapping(input([envelope('csv', 'x', 1)]));

    expect(result.summary).toEqual({
      inputCount: 1,
      mappedCount: 2,
      omittedCount: 0,
      rejectedCount: 3,
      warningCount: 3,
      errorCount: 2,
      criticalCount: 1,
    });
    expect(result.status).toBe('failed');
    expect(result.reasons).toEqual([info, warning, warning, warning, error, error, critical, info]);
    expect(result.ruleTrace).toBe(trace);
  });

  it('counts criticals alone without inflating the other counters', () => {
    runtime.mockReturnValue(runtimeResult([critical, critical]));
    expect(dryRunMapping(input()).summary).toEqual({
      inputCount: 0,
      mappedCount: 0,
      omittedCount: 0,
      rejectedCount: 2,
      warningCount: 0,
      errorCount: 0,
      criticalCount: 2,
    });
  });

  it('counts errors alone without inflating the other counters', () => {
    runtime.mockReturnValue(runtimeResult([error]));
    const result = dryRunMapping(input());
    expect(result.summary).toMatchObject({
      rejectedCount: 1,
      warningCount: 0,
      errorCount: 1,
      criticalCount: 0,
    });
    expect(result.status).toBe('partial');
  });

  it('counts warnings alone without rejecting anything', () => {
    runtime.mockReturnValue(runtimeResult([warning, info]));
    const result = dryRunMapping(input());
    expect(result.summary).toMatchObject({
      rejectedCount: 0,
      warningCount: 1,
      errorCount: 0,
      criticalCount: 0,
    });
    expect(result.status).toBe('partial');
  });

  it('reports success with zeroed counters when nothing was reported', () => {
    runtime.mockReturnValue(runtimeResult([info]));
    const result = dryRunMapping(input());
    expect(result.status).toBe('success');
    expect(result.summary).toMatchObject({
      rejectedCount: 0,
      warningCount: 0,
      errorCount: 0,
      criticalCount: 0,
    });
  });
});

describe('dryRunMapping redacted value summaries', () => {
  it('summarizes source values first and mapped values after them', () => {
    runtime.mockReturnValue(
      runtimeResult([], [envelope('out', 'mapped', 'm', 'public'), envelope('out', 'other', 1)])
    );
    const result = dryRunMapping(
      input([envelope('csv', 'one', 'a', 'pii'), envelope('csv', 'two', 'b', 'secret')])
    );
    expect(result.redactedValueSummaries.map((item) => item.classification)).toEqual([
      'pii',
      'secret',
      'public',
      'internal',
    ]);
    expect(result.redactedValueSummaries).toHaveLength(4);
  });

  it('labels summaries deterministically from namespace, path and classification', () => {
    runtime.mockReturnValue(runtimeResult([]));
    const [summary] = dryRunMapping(
      input([envelope('csv', 'one', 'a', 'pii')])
    ).redactedValueSummaries;
    expect(summary?.label).toBe(
      createDeterministicId({
        kind: 'fixture',
        semanticPath: ['csv', 'one'],
        contentHashParts: ['csv', 'one', 'pii'],
      })
    );
    const [other] = dryRunMapping(
      input([envelope('csv', 'one', 'a', 'secret')])
    ).redactedValueSummaries;
    expect(other?.label).not.toBe(summary?.label);
  });

  it('prefers the classification hint, then the catalog entry, then internal', () => {
    runtime.mockReturnValue(runtimeResult([]));
    const result = dryRunMapping(
      input([
        envelope('csv', 'email', 'a', 'token'),
        envelope('csv', 'email', 'b'),
        envelope('unknown', 'nothing', 'c'),
      ])
    );
    expect(result.redactedValueSummaries.map((item) => item.classification)).toEqual([
      'token',
      'pii',
      'internal',
    ]);
  });

  it('takes the value type from the catalog entry or falls back to typeof', () => {
    runtime.mockReturnValue(runtimeResult([]));
    const result = dryRunMapping(
      input([
        envelope('csv', 'email', 5),
        envelope('unknown', 'nothing', 5),
        envelope('unknown', 'nothing', 'text'),
        envelope('unknown', 'nothing', undefined),
      ])
    );
    expect(result.redactedValueSummaries.map((item) => item.valueType)).toEqual([
      'string',
      'number',
      'string',
      'undefined',
    ]);
  });

  it('reports cardinality and presence without exposing values', () => {
    runtime.mockReturnValue(runtimeResult([]));
    const result = dryRunMapping(
      input([
        envelope('x', 'undefined', undefined),
        envelope('x', 'null', null),
        envelope('x', 'empty', ''),
        envelope('x', 'zero', 0),
        envelope('x', 'false', false),
        envelope('x', 'text', 'secret-value'),
        envelope('x', 'list', []),
        envelope('x', 'items', ['a', 'b']),
      ])
    );
    expect(
      result.redactedValueSummaries.map(({ cardinality, presence }) => ({ cardinality, presence }))
    ).toEqual([
      { cardinality: 'single', presence: 'missing' },
      { cardinality: 'single', presence: 'missing' },
      { cardinality: 'single', presence: 'empty' },
      { cardinality: 'single', presence: 'present' },
      { cardinality: 'single', presence: 'present' },
      { cardinality: 'single', presence: 'present' },
      { cardinality: 'multi', presence: 'present' },
      { cardinality: 'multi', presence: 'present' },
    ]);
    expect(JSON.stringify(result.redactedValueSummaries)).not.toContain('secret-value');
  });

  it('asks the fingerprint provider with the resolved classification and raw value', () => {
    runtime.mockReturnValue(runtimeResult([]));
    const result = dryRunMapping({
      ...input([envelope('csv', 'email', 'a@example.test'), envelope('x', 'y', 3, 'public')]),
      fingerprintProvider: {
        fingerprint: ({ value, classification }) => `fp:${classification}:${String(value)}`,
      },
    });
    expect(result.redactedValueSummaries.map((item) => item.fingerprint)).toEqual([
      'fp:pii:a@example.test',
      'fp:public:3',
    ]);
  });

  it('omits the fingerprint when no provider is configured', () => {
    runtime.mockReturnValue(runtimeResult([]));
    const [summary] = dryRunMapping(input([envelope('csv', 'email', 'a')])).redactedValueSummaries;
    expect(summary?.fingerprint).toBeUndefined();
  });
});

describe('dryRunMappingBatch', () => {
  function batch(...rows: RuntimeMappingResult[]) {
    for (const row of rows) runtime.mockReturnValueOnce(row);
    return dryRunMappingBatch({ rows: rows.map(() => input()) });
  }

  it('reports success when every row succeeds', () => {
    const result = batch(runtimeResult([info]), runtimeResult([]));
    expect(result.status).toBe('success');
    expect(result.summary).toEqual({
      totalRows: 2,
      successRows: 2,
      partialRows: 0,
      failedRows: 0,
      criticalCount: 0,
    });
    expect(result.criticalCount).toBe(0);
    expect(result.reasonCounts).toEqual([{ code: 'policy.rule_selected', count: 1 }]);
  });

  it('reports partial when a row is partial and none is critical', () => {
    const result = batch(runtimeResult([]), runtimeResult([error]), runtimeResult([warning]));
    expect(result.status).toBe('partial');
    expect(result.summary).toEqual({
      totalRows: 3,
      successRows: 1,
      partialRows: 2,
      failedRows: 0,
      criticalCount: 0,
    });
  });

  it('reports failed when any row holds a critical reason and sums the criticals', () => {
    const result = batch(
      runtimeResult([critical, critical]),
      runtimeResult([]),
      runtimeResult([critical]),
      runtimeResult([error])
    );
    expect(result.status).toBe('failed');
    expect(result.summary).toEqual({
      totalRows: 4,
      successRows: 1,
      partialRows: 1,
      failedRows: 2,
      criticalCount: 3,
    });
    expect(result.criticalCount).toBe(3);
    expect(result.rowResults.map((row) => row.status)).toEqual([
      'failed',
      'success',
      'failed',
      'partial',
    ]);
  });

  it('aggregates reason counts across rows in first-seen order', () => {
    const result = batch(
      runtimeResult([error, warning, error]),
      runtimeResult([critical, warning]),
      runtimeResult([error])
    );
    expect(result.reasonCounts).toEqual([
      { code: 'validation.type_mismatch', count: 3 },
      { code: 'validation.format_mismatch', count: 2 },
      { code: 'policy.deny_locked', count: 1 },
    ]);
  });

  it('reports an empty batch as successful', () => {
    const result = dryRunMappingBatch({ rows: [] });
    expect(result.status).toBe('success');
    expect(result.summary).toEqual({
      totalRows: 0,
      successRows: 0,
      partialRows: 0,
      failedRows: 0,
      criticalCount: 0,
    });
    expect(result.rowResults).toEqual([]);
    expect(result.reasonCounts).toEqual([]);
  });
});
