import { createHmac } from 'node:crypto';
import type { MappingRuleGraph } from '@authrim/ar-lib-field-mapping/contract';

interface DeferredHashCase {
  name: string;
  transforms: MappingRuleGraph['transforms'];
  valueType: 'string' | 'boolean' | 'number';
  cardinality: 'single' | 'multi';
  required: boolean;
  expected: (digest: string) => string[];
}

function condition(pattern: string, valueType = 'as_text', thenValue = 'approved') {
  return {
    condition: JSON.stringify({ kind: 'rule', field: 'digest', operator: 'regex', value: pattern }),
    valueType,
    thenValue,
    elseMode: 'none',
  };
}

const hashInput = [{ stepIndex: 1 }];
const conditionInputs = [
  { stepIndex: 1, name: 'value' },
  { stepIndex: 1, name: 'field:digest' },
];

export const deferredHashCases: DeferredHashCase[] = [
  {
    name: 'direct hash',
    transforms: [],
    valueType: 'string',
    cardinality: 'single',
    required: true,
    expected: (digest) => [digest],
  },
  {
    name: 'case conversion',
    transforms: [
      { id: 'upper', operation: 'case', parameters: { mode: 'upper' }, inputs: hashInput },
    ],
    valueType: 'string',
    cardinality: 'single',
    required: true,
    expected: (digest) => [digest.toUpperCase()],
  },
  {
    name: 'has_value',
    transforms: [{ id: 'present', operation: 'has_value', inputs: hashInput }],
    valueType: 'boolean',
    cardinality: 'single',
    required: true,
    expected: () => ['true'],
  },
  {
    name: 'conditional suppressed by a provisional value',
    transforms: [
      {
        id: 'conditional',
        operation: 'conditional',
        parameters: condition('^[0-9a-f]+$'),
        inputs: conditionInputs,
      },
    ],
    valueType: 'string',
    cardinality: 'single',
    required: true,
    expected: () => ['approved'],
  },
  {
    name: 'conditional number conversion',
    transforms: [
      {
        id: 'number',
        operation: 'conditional',
        parameters: condition('^[0-9a-f]+$', 'as_number', '42'),
        inputs: conditionInputs,
      },
    ],
    valueType: 'number',
    cardinality: 'single',
    required: true,
    expected: () => ['42'],
  },
  {
    name: 'condition-only hash dependency',
    transforms: [
      {
        id: 'condition-only',
        operation: 'conditional',
        parameters: condition('^[0-9a-f]+$'),
        inputs: [
          { edgeIndex: 0, name: 'value' },
          { stepIndex: 1, name: 'field:digest' },
        ],
      },
    ],
    valueType: 'string',
    cardinality: 'single',
    required: true,
    expected: () => ['approved'],
  },
  {
    name: 'provisional text deletion',
    transforms: [
      {
        id: 'remove',
        operation: 'remove_text',
        parameters: { text: 'authrim-deferred-identifier' },
        inputs: hashInput,
      },
    ],
    valueType: 'string',
    cardinality: 'single',
    required: true,
    expected: (digest) => [digest],
  },
  {
    name: 'array filtering',
    transforms: [
      {
        id: 'filter',
        operation: 'filter_values',
        parameters: { how: 'regex', match: '^[0-9a-f]+$' },
        inputs: hashInput,
      },
    ],
    valueType: 'string',
    cardinality: 'multi',
    required: true,
    expected: (digest) => [digest],
  },
  {
    name: 'hash of hash',
    transforms: [
      { id: 'second-hash', operation: 'hash', parameters: { encoding: 'hex' }, inputs: hashInput },
    ],
    valueType: 'string',
    cardinality: 'single',
    required: true,
    expected: (digest) => [
      createHmac('sha256', new Uint8Array(32).fill(1)).update(digest).digest('hex'),
    ],
  },
  {
    name: 'required conditional output absent after actual computation',
    transforms: [
      {
        id: 'omit',
        operation: 'conditional',
        parameters: condition('^not-a-digest$'),
        inputs: conditionInputs,
      },
    ],
    valueType: 'string',
    cardinality: 'single',
    required: true,
    expected: () => [],
  },
  {
    name: 'optional conditional output absent after actual computation',
    transforms: [
      {
        id: 'omit',
        operation: 'conditional',
        parameters: condition('^not-a-digest$'),
        inputs: conditionInputs,
      },
    ],
    valueType: 'string',
    cardinality: 'single',
    required: false,
    expected: () => [],
  },
];
