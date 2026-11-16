import type { TransformOperationSchema } from './types';

/** Console parameter names and saved shapes; tables are JSON text, flags are booleans. */
export const TEXT_TRANSFORM_SCHEMAS: TransformOperationSchema[] = [
  {
    operation: 'keep_part',
    inputArity: { min: 1, max: 1 },
    parameters: [
      { name: 'delimiter', kind: 'string', required: true },
      { name: 'keep', kind: 'enum', required: true, allowedValues: ['before', 'after'] },
      { name: 'occurrence', kind: 'enum', required: true, allowedValues: ['first', 'last'] },
    ],
  },
  {
    operation: 'remove_text',
    inputArity: { min: 1, max: 1 },
    parameters: [{ name: 'text', kind: 'string', required: true }],
  },
  {
    operation: 'replace_text',
    inputArity: { min: 1, max: 1 },
    parameters: [
      { name: 'find', kind: 'string', required: true },
      { name: 'replacement', kind: 'string', required: false },
      { name: 'ignoreCase', kind: 'boolean', required: false },
    ],
  },
  {
    operation: 'regex_replace',
    inputArity: { min: 1, max: 1 },
    parameters: [
      { name: 'pattern', kind: 'string', required: true },
      { name: 'replacement', kind: 'string', required: false },
      { name: 'ignoreCase', kind: 'boolean', required: false },
    ],
  },
  ...['to_halfwidth', 'to_fullwidth'].map(
    (operation): TransformOperationSchema => ({
      operation: operation === 'to_halfwidth' ? 'to_halfwidth' : 'to_fullwidth',
      inputArity: { min: 1, max: 1 },
      parameters: [{ name: 'katakana', kind: 'boolean', required: false }],
    })
  ),
  { operation: 'strip_accents', inputArity: { min: 1, max: 1 }, parameters: [] },
  { operation: 'ascii_digits', inputArity: { min: 1, max: 1 }, parameters: [] },
  {
    operation: 'value_map',
    inputArity: { min: 1, max: 1 },
    parameters: [
      { name: 'entries', kind: 'string', required: true },
      { name: 'ignoreCase', kind: 'boolean', required: false },
      {
        name: 'otherwise',
        kind: 'enum',
        required: true,
        allowedValues: ['as_is', 'none', 'fixed'],
      },
      { name: 'fallbackValue', kind: 'string', required: false },
    ],
  },
  { operation: 'text_to_number', inputArity: { min: 1, max: 1 }, parameters: [] },
  {
    operation: 'date_format',
    inputArity: { min: 1, max: 1 },
    parameters: [
      {
        name: 'from',
        kind: 'enum',
        required: true,
        allowedValues: ['auto', 'iso', 'unix_s', 'unix_ms'],
      },
      {
        name: 'to',
        kind: 'enum',
        required: true,
        allowedValues: ['iso', 'date', 'unix_s', 'unix_ms'],
      },
      { name: 'timeZone', kind: 'string', required: false },
    ],
  },
  {
    operation: 'filter_values',
    inputArity: { min: 1, max: 1 },
    outputCardinality: 'multi',
    parameters: [
      {
        name: 'how',
        kind: 'enum',
        required: true,
        allowedValues: ['starts_with', 'ends_with', 'contains', 'equals', 'regex'],
      },
      { name: 'match', kind: 'string', required: true },
      { name: 'exclude', kind: 'boolean', required: false },
      { name: 'ignoreCase', kind: 'boolean', required: false },
    ],
  },
  {
    operation: 'normalize_empty',
    inputArity: { min: 1, max: 1 },
    parameters: [
      { name: 'spaces', kind: 'boolean', required: false },
      { name: 'emptyAs', kind: 'enum', required: true, allowedValues: ['none', 'empty', 'fixed'] },
      { name: 'emptyValue', kind: 'string', required: false },
    ],
  },
  {
    operation: 'default_if_empty',
    inputArity: { min: 1, max: 1 },
    parameters: [{ name: 'value', kind: 'string', required: true }],
  },
  {
    operation: 'has_value',
    inputArity: { min: 1, max: 1 },
    outputValueType: 'boolean',
    parameters: [{ name: 'invert', kind: 'boolean', required: false }],
  },
];
