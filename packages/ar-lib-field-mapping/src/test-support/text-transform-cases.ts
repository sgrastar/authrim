import type { TransformOperation } from '../core/types';

export interface TextTransformCase {
  operation: TransformOperation;
  parameters: Record<string, string | boolean>;
  input: unknown;
  output: unknown;
}

/** Console step-demos.ts acceptance examples, shared with preview and save-contract tests. */
export const TEXT_TRANSFORM_CASES: TextTransformCase[] = [
  {
    operation: 'keep_part',
    parameters: { delimiter: '@', keep: 'before', occurrence: 'first' },
    input: 'john.smith@example.com',
    output: 'john.smith',
  },
  {
    operation: 'remove_text',
    parameters: { text: '-' },
    input: '+1-555-0142',
    output: '+15550142',
  },
  {
    operation: 'replace_text',
    parameters: { find: '&', replacement: 'and' },
    input: 'Sales & Marketing',
    output: 'Sales and Marketing',
  },
  {
    operation: 'regex_replace',
    parameters: { pattern: '^.*<|>$', replacement: '' },
    input: 'John Smith <john@example.com>',
    output: 'john@example.com',
  },
  { operation: 'to_halfwidth', parameters: {}, input: 'ＡＢＣ－１２３', output: 'ABC-123' },
  { operation: 'to_fullwidth', parameters: {}, input: 'ABC-123', output: 'ＡＢＣ－１２３' },
  { operation: 'strip_accents', parameters: {}, input: 'José Müller', output: 'Jose Muller' },
  { operation: 'ascii_digits', parameters: {}, input: '٤٢٠١', output: '4201' },
  {
    operation: 'value_map',
    parameters: { entries: '[["SLS","Sales"]]', otherwise: 'as_is' },
    input: 'SLS',
    output: 'Sales',
  },
  { operation: 'text_to_number', parameters: {}, input: '42', output: 42 },
  {
    operation: 'date_format',
    parameters: { from: 'auto', to: 'iso', timeZone: 'Asia/Tokyo' },
    input: '1700000000',
    output: '2023-11-15T07:13:20+09:00',
  },
  {
    operation: 'filter_values',
    parameters: { how: 'starts_with', match: 'app-' },
    input: ['app-crm', 'staff', 'app-hr'],
    output: ['app-crm', 'app-hr'],
  },
  {
    operation: 'normalize_empty',
    parameters: { spaces: true, emptyAs: 'none' },
    input: '   ',
    output: null,
  },
  { operation: 'default_if_empty', parameters: { value: 'en' }, input: null, output: 'en' },
  { operation: 'has_value', parameters: {}, input: 'john@example.com', output: true },
];
