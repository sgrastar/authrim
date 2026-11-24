import { describe, expect, it } from 'vitest';
import { TEXT_TRANSFORM_SCHEMAS } from '../../core/text-transform-schemas';
import { STRUCTURE_TRANSFORM_SCHEMAS } from '../../core/structure-transforms';
import type { TransformOperationSchema } from '../../core/types';

/** Compact view: name:kind, a trailing ? for optional, and the allowed values when an enum. */
function summarize(schema: TransformOperationSchema) {
  return {
    operation: schema.operation,
    arity: schema.inputArity,
    output: [schema.outputValueType, schema.outputCardinality],
    parameters: schema.parameters.map((parameter) =>
      [
        `${parameter.name}:${parameter.kind}${parameter.required ? '' : '?'}`,
        ...(parameter.allowedValues ?? []),
      ].join(' ')
    ),
  };
}
const one = { min: 1, max: 1 };
const none: [undefined, undefined] = [undefined, undefined];

describe('text transform schemas', () => {
  it('keep the console parameter names, kinds, requirements and choices', () => {
    expect(TEXT_TRANSFORM_SCHEMAS.map(summarize)).toEqual([
      {
        operation: 'keep_part',
        arity: one,
        output: none,
        parameters: ['delimiter:string', 'keep:enum before after', 'occurrence:enum first last'],
      },
      { operation: 'remove_text', arity: one, output: none, parameters: ['text:string'] },
      {
        operation: 'replace_text',
        arity: one,
        output: none,
        parameters: ['find:string', 'replacement:string?', 'ignoreCase:boolean?'],
      },
      {
        operation: 'regex_replace',
        arity: one,
        output: none,
        parameters: ['pattern:string', 'replacement:string?', 'ignoreCase:boolean?'],
      },
      {
        operation: 'to_halfwidth',
        arity: one,
        output: none,
        parameters: ['katakana:boolean?'],
      },
      {
        operation: 'to_fullwidth',
        arity: one,
        output: none,
        parameters: ['katakana:boolean?'],
      },
      { operation: 'strip_accents', arity: one, output: none, parameters: [] },
      { operation: 'ascii_digits', arity: one, output: none, parameters: [] },
      {
        operation: 'value_map',
        arity: one,
        output: none,
        parameters: [
          'entries:string',
          'ignoreCase:boolean?',
          'otherwise:enum as_is none fixed',
          'fallbackValue:string?',
        ],
      },
      { operation: 'text_to_number', arity: one, output: none, parameters: [] },
      {
        operation: 'date_format',
        arity: one,
        output: none,
        parameters: [
          'from:enum auto iso unix_s unix_ms',
          'to:enum iso date unix_s unix_ms',
          'timeZone:string?',
        ],
      },
      {
        operation: 'filter_values',
        arity: one,
        output: [undefined, 'multi'],
        parameters: [
          'how:enum starts_with ends_with contains equals regex',
          'match:string',
          'exclude:boolean?',
          'ignoreCase:boolean?',
        ],
      },
      {
        operation: 'normalize_empty',
        arity: one,
        output: none,
        parameters: ['spaces:boolean?', 'emptyAs:enum none empty fixed', 'emptyValue:string?'],
      },
      {
        operation: 'default_if_empty',
        arity: one,
        output: none,
        parameters: ['value:string'],
      },
      {
        operation: 'has_value',
        arity: one,
        output: ['boolean', undefined],
        parameters: ['invert:boolean?'],
      },
    ]);
  });
});

describe('structure transform schemas', () => {
  it('keep the console parameter names, kinds, requirements and choices', () => {
    expect(STRUCTURE_TRANSFORM_SCHEMAS.map(summarize)).toEqual([
      {
        operation: 'json_extract_array',
        arity: one,
        output: ['unknown', 'multi'],
        parameters: ['path:string'],
      },
      {
        operation: 'json_extract_or',
        arity: one,
        output: ['string', 'single'],
        parameters: ['path:string', 'defaultValue:string', 'nullAsMissing:boolean?'],
      },
      {
        operation: 'array_build',
        arity: { min: 1, max: 500 },
        output: [undefined, 'multi'],
        parameters: ['omitEmpty:boolean?', 'unique:boolean?'],
      },
      {
        operation: 'hash',
        arity: one,
        output: ['string', 'single'],
        parameters: ['encoding:enum hex base64url'],
      },
      {
        operation: 'constant_text',
        arity: { min: 0, max: 0 },
        output: ['string', 'single'],
        parameters: ['value:string'],
      },
      {
        operation: 'constant_boolean',
        arity: { min: 0, max: 0 },
        output: ['boolean', 'single'],
        parameters: ['value:boolean'],
      },
      {
        operation: 'constant_number',
        arity: { min: 0, max: 0 },
        output: ['number', 'single'],
        parameters: ['value:number'],
      },
      {
        operation: 'conditional',
        arity: { min: 1, max: 65 },
        output: none,
        parameters: [
          'condition:string',
          'valueType:enum as_text as_boolean as_number',
          'elseMode:enum as_is none fixed',
          'thenValue:string?',
          'elseValue:string?',
          'thenBool:enum? true false',
          'elseBool:enum? true false',
        ],
      },
    ]);
  });
});
