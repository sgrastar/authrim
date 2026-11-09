import { describe, expect, it } from 'vitest';
import { executeRuntimeMapping } from '../../core/runtime';
import type { MappingInput } from '../../core/types';
import { edge, fieldRef, mappingInput, sourceValue, TEST_CATALOG } from '../../test-support';

describe('runtime field mapping identity boundaries', () => {
  it('does not substitute a same-path source with a different catalog identity', () => {
    const source = sourceValue('csv', 'email', 'private@example.test', 'pii');
    source.sourceRef.catalogEntryId = 'field.csv.employee_number';
    const input = mappingInput([source]);

    const result = executeRuntimeMapping(input);

    expect(result.values).toEqual([]);
    expect(result.ruleTrace.map((item) => item.action)).not.toContain('mapped');
    expect(JSON.stringify(result.ruleTrace)).not.toContain('private@example.test');
  });

  it('uses the source path when one side has no catalog identity', () => {
    const input = mappingInput([sourceValue('csv', 'email', 'user@example.test', 'pii')]);
    const result = executeRuntimeMapping(input);

    expect(result.values).toEqual([
      expect.objectContaining({ value: 'user@example.test', classificationHint: 'pii' }),
    ]);
    expect(result.ruleTrace.map((item) => item.action)).toContain('mapped');
  });

  it('does not release values mapped to a target absent from the catalog', () => {
    const sourceRef = fieldRef('csv', 'email', 'field.csv.email');
    const unknownTarget = {
      side: 'canonical' as const,
      namespace: 'authrim.profile',
      path: 'unregistered',
      catalogEntryId: 'field.canonical.unknown',
    };
    const input: MappingInput = {
      catalog: TEST_CATALOG,
      sourceValues: [
        {
          ...sourceValue('csv', 'email', 'private@example.test', 'pii'),
          sourceRef,
        },
      ],
      edges: [edge(sourceRef, unknownTarget)],
    };

    const result = executeRuntimeMapping(input);

    expect(result.reasons.map((item) => item.code)).toContain('catalog.invalid_entry');
    expect(result.values).toEqual([]);
    expect(JSON.stringify(result.ruleTrace)).not.toContain('private@example.test');
  });

  it('keeps a transform without its mapped input out of the released values', () => {
    const input = mappingInput([]);
    input.transforms = [
      {
        id: 'transform.email',
        operation: 'trim',
        inputEdgeIds: [input.edges[0].id],
        outputTargetRef: input.edges[0].targetRef,
      },
    ];

    const result = executeRuntimeMapping(input);

    expect(result.values).toEqual([]);
    expect(result.reasons.map((item) => item.code)).toContain('transform.missing_input');
    expect(result.ruleTrace.map((item) => item.action)).not.toContain('mapped');
  });
});
