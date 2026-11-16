import type { TransformOperation } from '../core/types';

/** Synthetic examples shared by engine, save and console parity checks. */
export const STRUCTURE_TRANSFORM_CASES: {
  operation: TransformOperation;
  parameters: Record<string, unknown>;
  input: unknown;
  output: unknown;
}[] = [
  {
    operation: 'json_extract_array',
    parameters: { path: 'user.roles[0]' },
    input: { user: { roles: [['one', 'two']] } },
    output: ['one', 'two'],
  },
  {
    operation: 'json_extract_or',
    parameters: { path: 'picture', defaultValue: 'default', nullAsMissing: true },
    input: {},
    output: 'default',
  },
  {
    operation: 'array_build',
    parameters: { omitEmpty: true, unique: true },
    input: ['one', '', null, 'one', 0, false],
    output: ['one', 0, false],
  },
  { operation: 'constant_text', parameters: { value: '' }, input: undefined, output: '' },
  { operation: 'constant_boolean', parameters: { value: false }, input: undefined, output: false },
  { operation: 'constant_number', parameters: { value: -3.5 }, input: undefined, output: -3.5 },
];
export const SYNTHETIC_CONDITION = JSON.stringify({
  id: 'all',
  kind: 'group',
  match: 'all',
  children: [
    { id: 'department', kind: 'rule', field: 'department', operator: 'eq', value: 'Engineering' },
  ],
});
export const CONDITIONAL_PARAMETERS = {
  condition: SYNTHETIC_CONDITION,
  valueType: 'as_text',
  thenValue: 'member',
  elseMode: 'as_is',
};
