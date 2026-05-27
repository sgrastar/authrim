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
  });

  it('escalates required missing to failed', () => {
    const result = dryRunMapping({
      ...mappingInput([sourceValue('csv', 'email', '', 'pii')]),
      validationRules: [
        {
          id: 'validation.email.required',
          kind: 'required',
          targetRef: { side: 'inbound', namespace: 'csv', path: 'email' },
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.reasons.map((item) => item.code)).toContain('validation.required_missing');
  });

  it('uses batch aggregate status rules', () => {
    const success = mappingInput([sourceValue('csv', 'email', 'user@example.test', 'pii')]);
    const failed = {
      ...mappingInput([sourceValue('csv', 'email', '', 'pii')]),
      validationRules: [
        {
          id: 'validation.email.required',
          kind: 'required' as const,
          targetRef: { side: 'inbound' as const, namespace: 'csv', path: 'email' },
        },
      ],
    };

    const result = dryRunMappingBatch({ rows: [success, failed] });
    expect(result.status).toBe('failed');
    expect(result.summary.totalRows).toBe(2);
    expect(result.criticalCount).toBe(1);
  });
});
