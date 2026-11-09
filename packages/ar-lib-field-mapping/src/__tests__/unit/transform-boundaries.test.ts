import { describe, expect, it } from 'vitest';
import { executeTransformStep, validateTransformStep } from '../../core/transforms';
import type {
  MappingTransformStep,
  SourceValueEnvelope,
  TransformOperation,
} from '../../core/types';
import { sourceValue } from '../../test-support';

const target = {
  side: 'canonical' as const,
  namespace: 'authrim.profile',
  path: 'result',
};

function run(
  operation: TransformOperation,
  values: unknown[],
  parameters?: Record<string, unknown>,
  runtimeContext?: Record<string, unknown>
) {
  const step: MappingTransformStep = {
    id: `transform.${operation}`,
    inputEdgeIds: values.map((_, index) => `edge-${index}`),
    operation,
    parameters,
    outputTargetRef: target,
  };
  const edgeValues = new Map<string, SourceValueEnvelope>(
    values.map((value, index) => [`edge-${index}`, sourceValue('csv', `field-${index}`, value)])
  );
  return executeTransformStep({ step, edgeValues, runtimeContext });
}

describe('transform failures and output boundaries', () => {
  it('does not execute a transform whose required parameter is absent', () => {
    const step: MappingTransformStep = {
      id: 'transform.case',
      inputEdgeIds: ['edge-0'],
      operation: 'case',
      outputTargetRef: target,
    };
    const result = executeTransformStep({
      step,
      edgeValues: new Map([['edge-0', sourceValue('csv', 'name', 'Alice')]]),
    });

    expect(result.value).toBeUndefined();
    expect(result.reasons.map((item) => item.code)).toEqual(['transform.missing_parameter']);
    expect(result.trace.every((item) => item.action !== 'transformed')).toBe(true);
  });

  it('does not report a missing edge as a successful transform', () => {
    const step: MappingTransformStep = {
      id: 'transform.copy',
      inputEdgeIds: ['edge-missing'],
      operation: 'copy',
      outputTargetRef: target,
    };
    const result = executeTransformStep({ step, edgeValues: new Map() });

    expect(result.value).toBeUndefined();
    expect(result.reasons.map((item) => item.code)).toEqual(['transform.missing_input']);
    expect(result.trace.every((item) => item.action !== 'transformed')).toBe(true);
  });

  it.each([
    ['oidc_pairwise_sub', { oidc: { subject: '' } }],
    ['saml_edu_person_targeted_id', { saml: { localEntityId: 'https://idp.test' } }],
  ] as const)('rejects incomplete persistent identifiers for %s', (operation, runtimeContext) => {
    const result = run(operation, ['ignored'], undefined, runtimeContext);

    expect(result.value).toBeUndefined();
    expect(result.reasons.map((item) => item.code)).toContain('transform.invalid_output');
  });

  it('keeps transformed provenance and classification while excluding raw values from the trace', () => {
    const original = sourceValue('csv', 'email', 'secret@example.test', 'pii');
    original.provenanceHint = { source: 'external', sourceId: 'record-1' } as never;
    const step: MappingTransformStep = {
      id: 'transform.email.trim',
      inputEdgeIds: ['edge-0'],
      operation: 'trim',
      outputTargetRef: target,
    };
    const result = executeTransformStep({
      step,
      edgeValues: new Map([['edge-0', original]]),
    });

    expect(result.value).toMatchObject({
      value: 'secret@example.test',
      sourceRef: target,
      classificationHint: 'pii',
      provenanceHint: original.provenanceHint,
      metadata: original.metadata,
    });
    expect(JSON.stringify(result.trace)).not.toContain('secret@example.test');
  });

  it('preserves false and zero while skipping only empty fallback candidates', () => {
    expect(run('fallback', [null, '', false, 'later']).value?.value).toBe(false);
    expect(run('fallback', [undefined, '', 0, 'later']).value?.value).toBe(0);
  });

  it('deduplicates arrays by value and type after optional trimming', () => {
    const result = run('as_array', [[1, '1', ' same ', 'same', null, '']], {
      trimItems: true,
      omitEmpty: true,
      unique: true,
    });
    expect(result.value?.value).toEqual([1, '1', 'same']);
  });
});

describe('JSON transform safety limits', () => {
  it('rejects a JSON path with more than 32 segments before execution', () => {
    const step: MappingTransformStep = {
      id: 'transform.path',
      inputEdgeIds: ['edge-0'],
      operation: 'json_extract_text',
      parameters: { path: Array.from({ length: 33 }, () => 'child').join('.') },
      outputTargetRef: target,
    };

    expect(validateTransformStep(step).reasons.map((item) => item.code)).toContain(
      'transform.invalid_parameter'
    );
    expect(
      executeTransformStep({
        step,
        edgeValues: new Map([['edge-0', sourceValue('csv', 'json', { child: 'private' })]]),
      }).value
    ).toBeUndefined();
  });

  it('rejects circular, deeply nested, and oversized array JSON outputs', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let deep: Record<string, unknown> = { leaf: 'value' };
    for (let index = 0; index < 13; index += 1) deep = { child: deep };

    for (const value of [circular, deep, Array.from({ length: 501 }, () => 1)]) {
      const result = run('json_build', [value], { nullHandling: 'omit' });
      expect(result.value).toBeUndefined();
      expect(result.reasons.map((item) => item.code)).toContain('transform.invalid_output');
    }
  });

  it('does not return an oversized nested object as extracted text', () => {
    const result = run('json_extract_text', [{ payload: { private: 'x'.repeat(2100) } }], {
      path: 'payload',
    });

    expect(result.value?.value).toBeNull();
    expect(JSON.stringify(result.trace)).not.toContain('private');
  });

  it('builds deterministic safe keys when a malformed key map is supplied', () => {
    const result = run('json_build', ['one', 'two', null], {
      keyMap: '{invalid-json',
      nullHandling: 'include_null',
    });

    expect(result.value?.value).toEqual({
      field_0: 'one',
      field_1: 'two',
      field_2: null,
    });
    expect(result.reasons).toEqual([]);
  });

  it('keeps distinct values whose source columns have the same name', () => {
    const first = sourceValue('csv', 'one', 'alpha');
    const second = sourceValue('csv', 'two', 'beta');
    first.metadata = { columnName: 'Display Name' };
    second.metadata = { columnName: 'Display Name' };
    const result = executeTransformStep({
      step: {
        id: 'transform.duplicate-columns',
        inputEdgeIds: ['first', 'second'],
        operation: 'json_build',
        parameters: { nullHandling: 'omit' },
        outputTargetRef: target,
      },
      edgeValues: new Map([
        ['first', first],
        ['second', second],
      ]),
    });

    expect(result.value?.value).toEqual({ Display_Name: 'alpha', Display_Name_2: 'beta' });
  });

  it('does not coerce malformed JSON booleans or non-integer numbers', () => {
    expect(
      run('json_extract_boolean', [{ active: 'maybe' }], { path: 'active' }).value?.value
    ).toBeNull();
    expect(
      run('json_extract_integer', [{ quota: 1.5 }], { path: 'quota' }).value?.value
    ).toBeNull();
    expect(
      run('json_extract_integer', [{ quota: '12px' }], { path: 'quota' }).value?.value
    ).toBeNull();
  });
});
