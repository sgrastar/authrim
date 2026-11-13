import { describe, expect, it } from 'vitest';

import {
  ageOn,
  conditionUserAttributeKeys,
  evaluateFlowCondition,
  matchOperator,
  runtimeConditionExpressions,
  validateFlowEditorState,
  type FlowConditionEvaluationContext,
  type FlowConditionExpression,
} from '../index';

const NOW = Date.UTC(2026, 10, 13); // 2026-11-13

function holds(condition: FlowConditionExpression, context: FlowConditionEvaluationContext = {}) {
  return evaluateFlowCondition(condition, { now_ms: NOW, ...context });
}

function codesFor(condition: Record<string, unknown>): string[] {
  return (
    validateFlowEditorState(
      {
        nodes: [
          { id: 'entry', type: 'entry' },
          {
            id: 'branch',
            type: 'condition',
            config: {
              conditions: {
                rows: [{ id: 'row', condition, output_handle: 'yes' }],
                otherwise: { output_handle: 'no' },
              },
            },
          },
        ],
        edges: [{ id: 'entry-branch', source: 'entry', target: 'branch' }],
      },
      { for_publish: true }
    )
      .map((issue) => issue.code)
      // The graph has no end: only what the condition says is looked at.
      .filter(
        (code) => !['missing_complete_node', 'missing_protocol_condition_edge'].includes(code)
      )
  );
}

describe('matchOperator', () => {
  it('matches one of the values, and nothing known never', () => {
    expect(matchOperator('JP', { operator: 'eq', value: 'JP' })).toBe(true);
    expect(matchOperator('US', { operator: 'in', values: ['JP', 'US'] })).toBe(true);
    expect(matchOperator(['a', 'b'], { operator: 'in', values: ['b'] })).toBe(true);
    expect(matchOperator(undefined, { operator: 'eq', value: 'JP' })).toBe(false);
  });

  it('counts nothing known as not equal (asking more is the safer way)', () => {
    expect(matchOperator('JP', { operator: 'ne', value: 'JP' })).toBe(false);
    expect(matchOperator('US', { operator: 'ne', value: 'JP' })).toBe(true);
    expect(matchOperator(undefined, { operator: 'ne', value: 'JP' })).toBe(true);
    expect(matchOperator(null, { operator: 'not_in', values: ['JP'] })).toBe(true);
  });

  it('tells whether anything is known', () => {
    expect(matchOperator('x', { operator: 'exists' })).toBe(true);
    expect(matchOperator('  ', { operator: 'exists' })).toBe(false);
    expect(matchOperator([], { operator: 'exists' })).toBe(false);
    expect(matchOperator(undefined, { operator: 'not_exists' })).toBe(true);
  });

  it('orders numbers and dates, and nothing else', () => {
    expect(matchOperator(17, { operator: 'lt', value: 18 })).toBe(true);
    expect(matchOperator('18', { operator: 'lt', value: 18 })).toBe(false);
    expect(matchOperator('18', { operator: 'lte', value: '18' })).toBe(true);
    expect(matchOperator('2010-05-01', { operator: 'gt', value: '2008-11-13' })).toBe(true);
    expect(matchOperator('2010-02-30', { operator: 'gt', value: '2008-11-13' })).toBe(false);
    // Two kinds, a text, nothing known, a list: never.
    expect(matchOperator('2010-05-01', { operator: 'gt', value: 5 })).toBe(false);
    expect(matchOperator('abc', { operator: 'gte', value: 'abb' })).toBe(false);
    expect(matchOperator(undefined, { operator: 'lt', value: 18 })).toBe(false);
    expect(matchOperator(['1'], { operator: 'lt', value: 18 })).toBe(false);
  });
});

describe('ageOn', () => {
  it('is the age in whole years on that day', () => {
    expect(ageOn('2008-11-13', NOW)).toBe(18);
    expect(ageOn('2008-11-14', NOW)).toBe(17);
    expect(ageOn('2000-02-29', Date.UTC(2026, 1, 28))).toBe(25);
    expect(ageOn('2000-02-29', Date.UTC(2026, 2, 1))).toBe(26);
  });

  it('is unknown for a partial, impossible or future date', () => {
    for (const birthdate of ['0000-05-01', '2001', '2001-13-01', '2001-02-29', '2030-01-01', 7]) {
      expect(ageOn(birthdate, NOW)).toBeNull();
    }
  });
});

describe('evaluateFlowCondition with the new kinds', () => {
  const user = (attributes: Record<string, string | string[]>) => ({ user: { attributes } });

  it('compares a user attribute by its operator', async () => {
    const notJapanese = {
      type: 'user.attribute',
      attribute: 'nationality',
      operator: 'ne',
      value: 'JP',
    } as const;
    await expect(holds(notJapanese, user({ nationality: 'US' }))).resolves.toBe(true);
    await expect(holds(notJapanese, user({ nationality: 'JP' }))).resolves.toBe(false);
    await expect(holds(notJapanese, user({}))).resolves.toBe(true);
    // Not signed in: nothing is known.
    await expect(holds(notJapanese)).resolves.toBe(true);
    await expect(
      holds({ type: 'user.attribute', attribute: 'nationality', value: 'JP' })
    ).resolves.toBe(false);
  });

  it('never reads an inherited key as an attribute', async () => {
    const plain = {
      type: 'user.attribute',
      attribute: 'constructor',
      operator: 'not_exists',
    } as const;
    await expect(holds(plain, user({}))).resolves.toBe(true);
  });

  it('keeps a condition without an operator as it was', async () => {
    const condition = { type: 'user.attribute', attribute: 'tags', values: ['a', 'c'] } as const;
    await expect(holds(condition, user({ tags: ['b', 'c'] }))).resolves.toBe(true);
    await expect(holds(condition, user({ tags: ['b'] }))).resolves.toBe(false);
  });

  it('judges an age from the birthdate', async () => {
    const minor = { type: 'user.age', operator: 'lt', value: 18 } as const;
    await expect(holds(minor, user({ birthdate: '2008-11-14' }))).resolves.toBe(true);
    await expect(holds(minor, user({ birthdate: '2008-11-13' }))).resolves.toBe(false);
    await expect(holds(minor, user({}))).resolves.toBe(false);
    await expect(
      holds({ type: 'user.age', operator: 'not_exists' }, user({ birthdate: '2001' }))
    ).resolves.toBe(true);
  });

  it('compares the language', async () => {
    await expect(holds({ type: 'locale', values: ['ja', 'en'] }, { locale: 'ja' })).resolves.toBe(
      true
    );
    await expect(
      holds({ type: 'locale', operator: 'ne', value: 'ja' }, { locale: 'de' })
    ).resolves.toBe(true);
  });

  it('holds an all condition only when every one of its conditions does', async () => {
    const all: FlowConditionExpression = {
      type: 'all',
      all: [
        { type: 'user.attribute', attribute: 'nationality', operator: 'ne', value: 'JP' },
        { type: 'user.age', operator: 'lt', value: 18 },
      ],
    };
    await expect(holds(all, user({ nationality: 'US', birthdate: '2010-01-01' }))).resolves.toBe(
      true
    );
    await expect(holds(all, user({ nationality: 'US', birthdate: '2000-01-01' }))).resolves.toBe(
      false
    );
    await expect(holds({ type: 'all', all: [] })).resolves.toBe(false);
    await expect(
      holds({ type: 'all', all: [{ type: 'all', all: [{ type: 'always' }] }] })
    ).resolves.toBe(false);
  });
});

describe('validating the new kinds', () => {
  it('takes conditions that are whole', () => {
    for (const condition of [
      { type: 'user.attribute', attribute: 'nationality', operator: 'ne', value: 'JP' },
      {
        type: 'user.attribute',
        attribute: 'address.country',
        operator: 'in',
        values: ['JP', 'KR'],
      },
      { type: 'user.attribute', attribute: 'birthdate', operator: 'gte', value: '2000-01-01' },
      { type: 'user.age', operator: 'lt', value: 18 },
      { type: 'user.age', value: 20 },
      { type: 'user.age', operator: 'exists' },
      { type: 'locale', operator: 'in', values: ['ja'] },
      { type: 'protocol', operator: 'eq', value: 'oidc' },
      {
        type: 'all',
        all: [
          { type: 'client_id', value: 'app' },
          { type: 'user.age', operator: 'lt', value: 18 },
        ],
      },
    ]) {
      expect(codesFor(condition), JSON.stringify(condition)).toEqual([]);
    }
  });

  it('refuses what cannot be judged', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: 'user.attribute', operator: 'eq', value: 'JP' }, 'invalid_user_attribute_condition'],
      [
        { type: 'user.attribute', attribute: 'Bad Key', value: 'JP' },
        'invalid_user_attribute_condition',
      ],
      [
        { type: 'user.attribute', attribute: 'x', operator: 'like', value: 'JP' },
        'invalid_condition_operator',
      ],
      [{ type: 'authenticated', operator: 'eq', value: true }, 'invalid_condition_operator'],
      [{ type: 'locale', operator: 'lt', value: 'ja' }, 'invalid_condition_value'],
      [
        { type: 'user.attribute', attribute: 'x', operator: 'lt', values: [1] },
        'invalid_condition_value',
      ],
      [{ type: 'user.attribute', attribute: 'x', operator: 'eq' }, 'invalid_condition_value'],
      [{ type: 'user.age', operator: 'lt', value: 17.5 }, 'invalid_condition_value'],
      [{ type: 'user.age', operator: 'lt', value: 151 }, 'invalid_condition_value'],
      [{ type: 'user.age' }, 'invalid_age_condition_value'],
      [
        { type: 'user.attribute', attribute: 'birthdate', operator: 'gte', value: '2026-02-30' },
        'invalid_condition_value',
      ],
      [
        { type: 'user.attribute', attribute: 'x', operator: 'gt', value: 'adult' },
        'invalid_condition_value',
      ],
      [{ type: 'locale', operator: 'eq', value: 'ja', values: 'ja' }, 'invalid_condition_value'],
      [{ type: 'client_id', values: 'app' }, 'invalid_condition_value'],
      [{ type: 'protocol', operator: 'ne', value: 'oidc' }, 'invalid_condition_operator'],
      [{ type: 'all', all: [] }, 'invalid_all_condition'],
      [{ type: 'all', all: [{ type: 'all', all: [{ type: 'always' }] }] }, 'nested_all_condition'],
      [{ type: 'all', all: [{ type: 'nope' }] }, 'invalid_condition_type'],
      [
        { type: 'all', all: [{ type: 'screen.answer', value: 'x' }] },
        'invalid_screen_answer_condition',
      ],
      [
        { type: 'all', all: Array.from({ length: 11 }, () => ({ type: 'always' })) },
        'invalid_all_condition',
      ],
    ];
    for (const [condition, code] of cases) {
      expect(codesFor(condition), JSON.stringify(condition)).toContain(code);
    }
  });
});

describe('the attributes a Flow reads', () => {
  it('lists the attribute keys of its conditions, birthdate for an age', () => {
    const runtime = {
      ui: {
        steps: [
          {
            id: 'a',
            source_node_id: 'a',
            component: 'condition',
            render: false,
            config: {
              conditions: {
                rows: [
                  { condition: { type: 'user.attribute', attribute: 'nationality', value: 'JP' } },
                  {
                    condition: {
                      type: 'all',
                      all: [{ type: 'user.age', operator: 'lt', value: 18 }, { type: 'always' }],
                    },
                  },
                ],
                otherwise: { output_handle: 'no' },
              },
            },
          },
          { id: 'b', source_node_id: 'b', component: 'screen', render: true, config: {} },
        ],
      },
    } as never;
    expect(conditionUserAttributeKeys(runtimeConditionExpressions(runtime))).toEqual([
      'nationality',
      'birthdate',
    ]);
  });
});
