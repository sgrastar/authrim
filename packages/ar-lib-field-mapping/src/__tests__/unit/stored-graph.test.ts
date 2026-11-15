import { describe, expect, it } from 'vitest';
import { readMappingReference } from '../../core/stored-graph';

describe('persisted graph references', () => {
  it('decodes ordered named edge and earlier-step inputs', () => {
    expect(
      readMappingReference(
        { edge_id: 'e2', input_step_id: null, name: 'right' },
        ['e1', 'e2'],
        ['s1'],
        0
      )
    ).toEqual({ edgeIndex: 1, name: 'right' });
    expect(
      readMappingReference({ edge_id: null, input_step_id: 's1' }, [], ['s1', 's2'], 1)
    ).toEqual({ stepIndex: 0 });
  });
  it('refuses dangling, cross-rule, forward and ambiguous references', () => {
    for (const ref of [
      { edge_id: 'foreign', input_step_id: null },
      { edge_id: null, input_step_id: 's2' },
      { edge_id: null, input_step_id: null },
      { edge_id: 'e1', input_step_id: 's1' },
    ])
      expect(() => readMappingReference(ref, ['e1'], ['s1', 's2'], 1)).toThrow('invalid_reference');
  });
});
