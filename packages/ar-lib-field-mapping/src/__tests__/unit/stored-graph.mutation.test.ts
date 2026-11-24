import { describe, expect, it } from 'vitest';
import { readMappingReference } from '../../core/stored-graph';

describe('persisted graph reference decoding', () => {
  it('decodes the first edge, which must not be mistaken for a dangling one', () => {
    expect(readMappingReference({ edge_id: 'e1', input_step_id: null }, ['e1', 'e2'], [])).toEqual({
      edgeIndex: 0,
    });
  });

  it('rejects an unknown edge with the dangling edge message', () => {
    expect(() =>
      readMappingReference({ edge_id: 'foreign', input_step_id: null }, ['e1'], [])
    ).toThrow('invalid_reference: dangling or cross-rule edge');
  });

  it('requires exactly one of edge and step', () => {
    expect(() =>
      readMappingReference({ edge_id: null, input_step_id: null }, ['e1'], ['s1'])
    ).toThrow('invalid_reference: exactly one edge or step is required');
    expect(() =>
      readMappingReference({ edge_id: 'e1', input_step_id: 's1' }, ['e1'], ['s1'])
    ).toThrow('invalid_reference: exactly one edge or step is required');
  });

  it('accepts the last earlier step and refuses the first forward one', () => {
    const stepIds = ['s0', 's1', 's2'];
    expect(
      readMappingReference({ edge_id: null, input_step_id: 's1' }, [], stepIds, 2)
    ).toStrictEqual({ stepIndex: 1 });
    expect(() =>
      readMappingReference({ edge_id: null, input_step_id: 's2' }, [], stepIds, 2)
    ).toThrow('invalid_reference: dangling, cross-rule or forward step');
  });

  it('defaults the step bound to every known step', () => {
    expect(
      readMappingReference({ edge_id: null, input_step_id: 's1' }, [], ['s0', 's1'])
    ).toStrictEqual({ stepIndex: 1 });
  });

  it('refuses an unknown step and the first step when no step precedes it', () => {
    expect(() =>
      readMappingReference({ edge_id: null, input_step_id: 'nope' }, [], ['s0'])
    ).toThrow('invalid_reference: dangling, cross-rule or forward step');
    expect(() =>
      readMappingReference({ edge_id: null, input_step_id: 's0' }, [], ['s0'], 0)
    ).toThrow('invalid_reference: dangling, cross-rule or forward step');
  });

  it('omits the name when it is null or undefined and keeps any other', () => {
    expect(
      readMappingReference({ edge_id: 'e1', input_step_id: null, name: null }, ['e1'], [])
    ).toStrictEqual({ edgeIndex: 0 });
    expect(
      readMappingReference({ edge_id: 'e1', input_step_id: null, name: undefined }, ['e1'], [])
    ).toStrictEqual({ edgeIndex: 0 });
    expect(
      readMappingReference({ edge_id: null, input_step_id: 's0', name: 'x' }, [], ['s0'])
    ).toStrictEqual({ stepIndex: 0, name: 'x' });
  });

  it.each(['', ' ', '\t\n'])('refuses the blank input name %j', (name) => {
    expect(() =>
      readMappingReference({ edge_id: 'e1', input_step_id: null, name }, ['e1'], [])
    ).toThrow('invalid_reference: empty input name');
    expect(() =>
      readMappingReference({ edge_id: null, input_step_id: 's0', name }, [], ['s0'])
    ).toThrow('invalid_reference: empty input name');
  });

  it('keeps a name with surrounding spaces untouched', () => {
    expect(
      readMappingReference({ edge_id: 'e1', input_step_id: null, name: ' a ' }, ['e1'], [])
    ).toStrictEqual({ edgeIndex: 0, name: ' a ' });
  });
});
