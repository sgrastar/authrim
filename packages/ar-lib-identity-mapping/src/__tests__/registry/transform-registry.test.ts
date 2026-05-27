import { describe, expect, it } from 'vitest';
import {
  TRANSFORM_OPERATION_SCHEMAS,
  executeTransformStep,
  validateTransformRegistry,
  validateTransformStep,
} from '../../core/transforms';
import type { MappingTransformStep } from '../../core/types';
import { edge, fieldRef, sourceValue } from '../../test-support';

describe('transform registry', () => {
  it('has unique operation schemas', () => {
    expect(validateTransformRegistry()).toEqual([]);
  });

  it('returns structured reason codes for invalid transform parameters', () => {
    const step: MappingTransformStep = {
      id: 'transform.test',
      inputEdgeIds: ['edge.test'],
      operation: 'case',
      parameters: { mode: 'capitalize', extra: true },
      outputTargetRef: { side: 'canonical', namespace: 'authrim.profile', path: 'displayName' },
    };
    const result = validateTransformStep(step);

    expect(result.reasons.map((item) => item.code)).toEqual([
      'transform.invalid_parameter',
      'transform.unknown_parameter',
    ]);

    expect(executeTransformStep({ step, edgeValues: new Map() }).value).toBeUndefined();
  });

  it('contains the PR1 operation set', () => {
    expect(TRANSFORM_OPERATION_SCHEMAS.map((schema) => schema.operation).sort()).toEqual([
      'case',
      'concat',
      'copy',
      'fallback',
      'normalize',
      'trim',
    ]);
  });

  it('executes PR1 transform operations', () => {
    const sourceRef = fieldRef('csv', 'email');
    const targetRef = { side: 'canonical' as const, namespace: 'authrim.profile', path: 'email' };
    const mappingEdge = edge(sourceRef, targetRef);
    const edgeValues = new Map([
      [mappingEdge.id, sourceValue('csv', 'email', ' USER@EXAMPLE.TEST ')],
    ]);

    expect(
      executeTransformStep({
        step: {
          id: 'transform.email.trim',
          inputEdgeIds: [mappingEdge.id],
          operation: 'trim',
          outputTargetRef: targetRef,
        },
        edgeValues,
      }).value?.value
    ).toBe('USER@EXAMPLE.TEST');

    expect(
      executeTransformStep({
        step: {
          id: 'transform.email.case',
          inputEdgeIds: [mappingEdge.id],
          operation: 'case',
          parameters: { mode: 'lower' },
          outputTargetRef: targetRef,
        },
        edgeValues,
      }).value?.value
    ).toBe(' user@example.test ');
  });
});
