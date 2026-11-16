import { graphFixture } from '../../test-support/graph-fixture';
import { describe, expect, it } from 'vitest';
import { executeRuntimeMapping } from '../../core/runtime';
import { dryRunMapping } from '../../core/dry-run';
import type { FieldCatalogEntry, MappingInput, ValidationRule } from '../../core/types';
import { mappingInput, sourceValue } from '../../test-support';

function competing(first: unknown, last: unknown, checks: ValidationRule[]): MappingInput {
  const input = mappingInput([]);
  const targetRef = input.edges[0].targetRef;
  return {
    ...input,
    catalog: {
      ...input.catalog,
      entries: [
        ...['first', 'last'].map(
          (path): FieldCatalogEntry => ({
            ...input.catalog.entries[0],
            id: path,
            path,
            valueType: 'unknown',
            cardinality: 'multi',
          })
        ),
        { ...input.catalog.entries[1], valueType: 'unknown', cardinality: 'multi' },
      ],
    },
    edges: ['first', 'last'].map((id) => ({
      id,
      ruleId: id,
      targetRef,
      sourceRef: { side: 'source', namespace: 'csv', path: id },
    })),
    sourceValues: [sourceValue('csv', 'first', first), sourceValue('csv', 'last', last)],
    validationRules: checks,
  };
}

const target = mappingInput([]).edges[0].targetRef;

describe('validation after writer resolution and suppression', () => {
  it.each([
    { first: 'present', last: '', missing: true },
    { first: '', last: 'present', missing: false },
    { first: ['present'], last: [], missing: true },
    { first: [], last: ['present'], missing: false },
    { first: 'present', last: null, missing: true },
    { first: null, last: 'present', missing: false },
  ])('checks required on the last writer ($first -> $last)', ({ first, last, missing }) => {
    const input = competing(first, last, [{ id: 'required', kind: 'required', targetRef: target }]);
    const result = executeRuntimeMapping(graphFixture(input));
    expect(result.reasons.some((reason) => reason.code === 'validation.required_missing')).toBe(
      missing
    );
    expect(result.status).toBe(missing ? 'failed' : 'success');
    expect(result.values.map((value) => value.value)).toEqual([first, last]);
    expect(dryRunMapping(graphFixture(input)).reasons).toEqual(result.reasons);
  });

  it.each([
    { first: 'wrong', last: 42, invalid: false },
    { first: 42, last: 'wrong', invalid: true },
  ])('checks type on the last writer only ($first -> $last)', ({ first, last, invalid }) => {
    const input = competing(first, last, [
      {
        id: 'number',
        kind: 'type',
        targetRef: target,
        parameters: { valueType: 'number' },
      },
    ]);
    expect(
      executeRuntimeMapping(graphFixture(input)).reasons.some(
        (reason) => reason.code === 'validation.type_mismatch'
      )
    ).toBe(invalid);
  });

  it.each([
    { first: ['many'], last: 'one', invalid: false },
    { first: 'one', last: ['many'], invalid: true },
  ])('checks cardinality on the last writer only', ({ first, last, invalid }) => {
    const input = competing(first, last, [
      {
        id: 'single',
        kind: 'cardinality',
        targetRef: target,
        parameters: { cardinality: 'single' },
      },
    ]);
    expect(
      executeRuntimeMapping(graphFixture(input)).reasons.some(
        (reason) => reason.code === 'validation.cardinality_mismatch'
      )
    ).toBe(invalid);
  });

  it('validates a suppressed target as absent without an original stand-in', () => {
    const input = competing('stand-in', 'unused', [
      { id: 'required', kind: 'required', targetRef: target },
    ]);
    input.edges = [];
    input.sourceValues.push({ value: 'original-stand-in', sourceRef: target });
    input.transforms = [
      {
        id: 'identifier',
        ruleId: 'identifier',
        operation: 'persistent_identifier',
        inputEdgeIds: [],
        outputTargetRef: target,
        parameters: { input: 'account', format: 'plain', algorithm: 'authrim_sha256' },
      },
    ];
    input.runtimeContext = { suppressedIdentifiers: { identifier: true } };
    const result = executeRuntimeMapping(graphFixture(input));
    expect(result.values).toEqual([]);
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'validation.required_missing' })
    );
  });
});
