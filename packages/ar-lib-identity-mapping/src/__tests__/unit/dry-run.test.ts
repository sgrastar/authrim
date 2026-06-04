import { describe, expect, it } from 'vitest';
import { dryRunMapping, dryRunMappingBatch } from '../../core/dry-run';
import { createTestFingerprintProvider, mappingInput, sourceValue } from '../../test-support';

describe('dry-run mapping', () => {
  it('returns redacted summaries without raw values', () => {
    const result = dryRunMapping({
      ...mappingInput([sourceValue('csv', 'email', 'user@example.test', 'pii')]),
      fingerprintProvider: createTestFingerprintProvider(),
    });

    expect(result.status).toBe('success');
    expect(JSON.stringify(result.redactedValueSummaries)).not.toContain('user@example.test');
    expect(result.redactedValueSummaries[0]?.classification).toBe('pii');
    expect(result.redactedValueSummaries[0]?.fingerprint).toMatch(/^fixture\./);
    expect(result.summary.mappedCount).toBe(1);
    expect(result.ruleTrace.some((entry) => entry.action === 'mapped')).toBe(true);
  });

  it('executes transform steps and records transformed traces', () => {
    const input = mappingInput([sourceValue('csv', 'email', ' USER@EXAMPLE.TEST ', 'pii')]);
    const result = dryRunMapping({
      ...input,
      transforms: [
        {
          id: 'transform.email.trim',
          inputEdgeIds: [input.edges[0]!.id],
          operation: 'trim',
          outputTargetRef: {
            side: 'canonical',
            namespace: 'authrim.profile',
            path: 'email',
            catalogEntryId: 'field.canonical.email',
          },
        },
      ],
    });

    expect(result.status).toBe('success');
    expect(result.summary.mappedCount).toBe(2);
    expect(result.ruleTrace.some((entry) => entry.action === 'transformed')).toBe(true);
    expect(JSON.stringify(result.redactedValueSummaries)).not.toContain('USER@EXAMPLE.TEST');
  });

  it('escalates required missing to failed', () => {
    const result = dryRunMapping({
      ...mappingInput([sourceValue('csv', 'email', '', 'pii')]),
      validationRules: [
        {
          id: 'validation.email.required',
          kind: 'required',
          targetRef: { side: 'source', namespace: 'csv', path: 'email' },
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.reasons.map((item) => item.code)).toContain('validation.required_missing');
  });

  it('preserves repeated reasons so row-level evidence is not collapsed', () => {
    const input = mappingInput([sourceValue('csv', 'email', ['bad-email'], 'pii')]);
    const result = dryRunMapping({
      ...input,
      validationRules: [
        {
          id: 'validation.email.cardinality',
          kind: 'cardinality',
          targetRef: { side: 'source', namespace: 'csv', path: 'email' },
          parameters: { cardinality: 'single' },
        },
      ],
    });

    expect(result.reasons.map((item) => item.code)).toEqual([
      'validation.cardinality_mismatch',
      'validation.cardinality_mismatch',
    ]);
    expect(result.summary.errorCount).toBe(2);
  });

  it('uses batch aggregate status rules', () => {
    const success = mappingInput([sourceValue('csv', 'email', 'user@example.test', 'pii')]);
    const failed = {
      ...mappingInput([sourceValue('csv', 'email', '', 'pii')]),
      validationRules: [
        {
          id: 'validation.email.required',
          kind: 'required' as const,
          targetRef: { side: 'source' as const, namespace: 'csv', path: 'email' },
        },
      ],
    };

    const result = dryRunMappingBatch({ rows: [success, failed] });
    expect(result.status).toBe('failed');
    expect(result.summary.totalRows).toBe(2);
    expect(result.criticalCount).toBe(1);
  });
});
