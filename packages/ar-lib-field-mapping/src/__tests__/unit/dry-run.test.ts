import { describe, expect, it } from 'vitest';
import { dryRunMapping, dryRunMappingBatch } from '../../core/dry-run';
import { executeRuntimeMapping } from '../../core/runtime';
import {
  createTestFingerprintProvider,
  edge,
  fieldRef,
  mappingInput,
  sourceValue,
} from '../../test-support';

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
    expect(result.summary.mappedCount).toBe(1);
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

  it('returns mapped runtime values for protocol release paths', () => {
    const input = mappingInput([sourceValue('csv', 'email', 'user@example.test', 'pii')]);
    const result = executeRuntimeMapping(input);

    expect(result.status).toBe('success');
    expect(result.values).toEqual([
      expect.objectContaining({
        value: 'user@example.test',
        sourceRef: expect.objectContaining({
          namespace: 'authrim.profile',
          path: 'email',
        }),
      }),
    ]);
  });

  it('keeps destination outputs even when the compiled catalog has no destination entries', () => {
    const result = executeRuntimeMapping({
      catalog: {
        identity: {
          id: 'empty-runtime-catalog',
          version: 'v1',
          contentHash: 'empty',
          compatibilityRange: '^0.3.0',
        },
        entries: [],
      },
      sourceValues: [
        {
          ...sourceValue('authrim.profile', 'email', 'user@example.test', 'pii'),
          sourceRef: {
            side: 'source',
            namespace: 'authrim.profile',
            path: 'email',
            catalogEntryId: 'field.canonical.email',
          },
        },
      ],
      edges: [
        edge(
          {
            ...fieldRef('authrim.profile', 'email', 'field.canonical.email'),
            side: 'source',
          },
          {
            side: 'destination',
            namespace: 'saml.attribute',
            path: 'urn:oid:0.9.2342.19200300.100.1.3',
            catalogEntryId: 'field.saml.mail',
          }
        ),
      ],
    });

    expect(result.status).toBe('partial');
    expect(result.reasons.map((item) => item.code)).toContain('catalog.invalid_entry');
    expect(result.values).toEqual([
      expect.objectContaining({
        value: 'user@example.test',
        sourceRef: expect.objectContaining({
          side: 'destination',
          namespace: 'saml.attribute',
          path: 'urn:oid:0.9.2342.19200300.100.1.3',
        }),
      }),
    ]);
  });
});
