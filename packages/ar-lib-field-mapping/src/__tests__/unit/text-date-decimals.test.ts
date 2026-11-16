import { describe, expect, it } from 'vitest';
import { executeTransformStep } from '../../core/transforms';
import type { FieldRef } from '../../core/types';

const ref: FieldRef = { side: 'source', namespace: 'test', path: 'epoch' };
function run(value: unknown, from = 'unix_s', to = 'unix_ms') {
  return executeTransformStep({
    step: {
      id: 'date',
      operation: 'date_format',
      inputEdgeIds: ['in'],
      outputTargetRef: ref,
      parameters: { from, to },
    },
    edgeValues: new Map([['in', { value, sourceRef: ref }]]),
  });
}

describe('decimal epoch seconds', () => {
  it.each([
    ['1.001', 1001],
    ['-1.001', -1001],
    ['0.001', 1],
    ['-0.001', -1],
    ['1.0100', 1010],
    ['-1.0100', -1010],
    ['0.0000', 0],
    ['-0.0000', 0],
    [' 1700000000.001 ', 1700000000001],
    ['-1700000000.001', -1700000000001],
    [1.001, 1001],
    [-1.001, -1001],
    [0.001, 1],
    [-0.001, -1],
  ])('converts %s to exact integral milliseconds', (input, output) => {
    expect(run(input)).toMatchObject({ status: 'success', value: { value: output } });
    expect(run(input, 'auto')).toMatchObject({ status: 'success', value: { value: output } });
  });

  it.each([
    '0.0001',
    '-0.0001',
    '1.0001',
    '-1.0001',
    '1.0010001',
    '-1.0010001',
    '0.00100000000000000001',
    0.0001,
    -0.0001,
    1e-7,
    -1e-7,
  ])('rejects genuine sub-millisecond seconds %s', (input) => {
    expect(run(input).reasons.map((reason) => reason.code)).toContain('transform.invalid_output');
    expect(run(input).value).toBeUndefined();
  });

  it.each(['1000.001', '-1000.001', 1000.001, -1000.001])(
    'rejects fractional milliseconds %s',
    (input) => {
      expect(run(input, 'unix_ms').value).toBeUndefined();
    }
  );

  it('retains precision, range checks and negative second flooring', () => {
    expect(run('1.001', 'unix_s', 'iso').value?.value).toBe('1970-01-01T00:00:01Z');
    expect(run('-1.001', 'unix_s', 'unix_s').value?.value).toBe(-2);
    expect(run('1001.0000', 'unix_ms').value?.value).toBe(1001);
    for (const input of [
      '9007199254740.992',
      '-9007199254740.992',
      '9999999999999999',
      Infinity,
      NaN,
      '1e-3',
    ])
      expect(run(input).value).toBeUndefined();
  });
});
