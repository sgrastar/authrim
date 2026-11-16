import { describe, expect, it } from 'vitest';
import { TEXT_TRANSFORM_CASES } from '@authrim/ar-lib-field-mapping/test-support';
import { assertMappingGraphContract } from '../identity-mapping-graph-contract';
import type { FieldMappingVersionRuleInput } from '../identity-mapping-control-plane';

function rule(
  operation: string,
  parameters: Record<string, unknown>
): FieldMappingVersionRuleInput {
  const targetRef = { side: 'destination', namespace: 'oidc.claim', path: 'name' };
  return {
    ruleKey: 'text',
    ruleKind: 'mapping',
    action: 'allow',
    targetRef,
    edges: [{ sourceRef: { side: 'source', namespace: 'csv', path: 'name' }, targetRef }],
    transforms: [{ operation, parameters, inputs: [{ edgeIndex: 0 }] }],
    output: { stepIndex: 0 },
  };
}

describe('text transform save contract', () => {
  it.each(TEXT_TRANSFORM_CASES)(
    'saves $operation with the console parameter shape',
    ({ operation, parameters }) => {
      expect(() => assertMappingGraphContract(rule(operation, parameters), 'rule')).not.toThrow();
    }
  );
  it.each([
    ['regex_replace', { pattern: '(a+)+$' }],
    ['regex_replace', { pattern: '(a)\\1' }],
    ['filter_values', { how: 'regex', match: '(?=a)' }],
    ['value_map', { entries: '[[1,2]]', otherwise: 'as_is' }],
    ['value_map', { entries: '[]', otherwise: 'fixed' }],
    ['date_format', { from: 'auto', to: 'iso', timeZone: 'No/Such_Zone' }],
    ['replace_text', { find: 'a', ignoreCase: 'true' }],
    ['keep_part', { delimiter: '@', keep: 'middle', occurrence: 'first' }],
  ] satisfies [string, Record<string, unknown>][])(
    'refuses invalid saved %s settings',
    (operation, parameters) => {
      expect(() => assertMappingGraphContract(rule(operation, parameters), 'rule')).toThrow(
        'parameters or input arity'
      );
    }
  );
  it.each(['default_if_empty', 'has_value', 'value_map'])(
    'refuses %s after an identifier at save',
    (operation) => {
      const c = TEXT_TRANSFORM_CASES.find((c) => c.operation === operation);
      if (!c) throw new Error('Missing case');
      const value = rule(operation, c.parameters);
      value.transforms = [
        {
          operation: 'persistent_identifier',
          inputs: [],
          parameters: { input: 'account', format: 'plain', algorithm: 'authrim_sha256' },
        },
        { operation, parameters: c.parameters, inputs: [{ stepIndex: 0 }] },
      ];
      value.output = { stepIndex: 1 };
      expect(() => assertMappingGraphContract(value, 'rule')).toThrow('identifier post-transform');
    }
  );
});
